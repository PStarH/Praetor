import { reportSilentFailure } from '../silentFailureReporter';
import type {
  UltimateExecutionContext,
  UltimateExecutionResult,
  UltimateOrchestratorConfig,
  ExecutionError,
  OrchestrationTopology,
  EffortLevel,
  DeliberationPlan,
  TaskTreeNode,
  ArtifactReference,
  TaskDAG,
  QualityGateConfig,
} from './types';
import { DEFAULT_ULTIMATE_CONFIG } from './types';
import type { ModelTier } from '../runtime/types';
import type { AgentRuntimeInterface } from '../runtime';
import { TELOSOrchestrator } from '../telos/telosOrchestrator';
import { getMessageBus } from '../runtime/messageBus';
import { getTraceRecorder } from '../runtime/executionTrace';
import { getIntentLog } from '../runtime/intentLog';
import { getMetricsCollector } from '../runtime/metricsCollector';
import { getMetaLearner } from '../selfEvolution/metaLearner';
import type { ExecutionExperience } from '../runtime/types';
import type { OptimizationAction } from './topologyOptimizer';
import { getGlobalThreeLayerMemory } from '../threeLayerMemory';
import { deliberate, deliberateWithLLM } from './deliberation';
import { RecursiveAtomizer } from './atomizer';
import { TopologyRouter } from './topologyRouter';
import { SubAgentExecutor } from './subAgentExecutor';
import { TopologyExecutionRunner } from './topologyExecutionLoops';
import { CheckpointManager } from './checkpointManager';
import { EvolutionRunner } from './evolutionRunner';
import { MetricsHelper } from './metricsHelper';
import { AgentFileCollector, writeSynthesisOutput } from './agentFileCollector';
import { QualityGateFixer } from './qualityGateFixer';
import {
  countNodes,
  measureDepth,
  countCompleted,
  countFailed,
  flattenTree,
} from './taskTreeUtils';
import { buildTaskDAGFromTree } from './taskTreeDag';
import { MultiAgentSynthesizer } from './synthesizer';
import { ArtifactSystem, getArtifactSystem } from './artifactSystem';
import { WorkCoordinator, getWorkCoordinator } from './workCoordinator';
import { AgentTeamManager, getTeamManager } from './agentTeamManager';
import { getEffortRules, classifyEffortLevel } from './effortScaler';
import { ReflexionTopologicalOptimizer } from './topologyOptimizer';
import { getEvolutionEngine } from '../runtime/evolutionaryWorkflowEngine';
import { getGlobalLogger } from '../logging';
import { mergeSharedState } from './stateManager';
import { getTokenBudgetManager } from '../runtime/tokenBudgetManager';
import { getCheckpointWriter } from '../runtime/checkpointWriter';
import { getRebuildPrompt } from '../runtime/rebuildPrompt';

function generateExecId(counter: { value: number }): string {
  return `ultimate_${Date.now()}_${++counter.value}`;
}

// ============================================================================

export class UltimateOrchestrator {
  private config: UltimateOrchestratorConfig;
  private telos: TELOSOrchestrator;
  private runtime: AgentRuntimeInterface;
  private atomizer: RecursiveAtomizer;
  private topologyRouter: TopologyRouter;
  private subAgentExecutor: SubAgentExecutor;
  private synthesizer: MultiAgentSynthesizer;
  private artifactSystem: ArtifactSystem;
  private teamManager: AgentTeamManager;
  private topologyOptimizer: ReflexionTopologicalOptimizer;
  private topologyRunner: TopologyExecutionRunner;
  private checkpointManager: CheckpointManager;
  private evolutionRunner: EvolutionRunner;
  private metricsHelper: MetricsHelper;
  private agentFileCollector: AgentFileCollector;
  private qualityGateFixer: QualityGateFixer;
  private evolutionEngine: ReturnType<typeof getEvolutionEngine> | null = null;
  private workCoordinator: WorkCoordinator;
  private activeExecutions: Map<string, UltimateExecutionContext> = new Map();
  private executionCounter = { value: 0 };

  constructor(
    telos: TELOSOrchestrator,
    runtime: AgentRuntimeInterface,
    config?: Partial<UltimateOrchestratorConfig>,
    artifactSystem?: ArtifactSystem,
    teamManager?: AgentTeamManager,
  ) {
    this.config = { ...DEFAULT_ULTIMATE_CONFIG, ...config };
    this.telos = telos;
    this.runtime = runtime;
    this.artifactSystem = artifactSystem ?? getArtifactSystem();
    this.teamManager = teamManager ?? getTeamManager();

    this.atomizer = new RecursiveAtomizer(
      this.config.maxRecursiveDepth,
      this.config.maxParallelSubAgents,
    );
    this.topologyRouter = new TopologyRouter();
    this.topologyOptimizer = new ReflexionTopologicalOptimizer();
    this.evolutionEngine = getEvolutionEngine();
    this.subAgentExecutor = new SubAgentExecutor(
      runtime,
      this.artifactSystem,
      this.config.maxParallelSubAgents,
      this.config,
    );
    this.topologyRunner = new TopologyExecutionRunner(this.subAgentExecutor);
    this.checkpointManager = new CheckpointManager({
      config: this.config,
      runtime,
      sumTokenUsage: (taskTree) => this.metricsHelper.sumTokenUsage(taskTree),
    });
    this.evolutionRunner = new EvolutionRunner({
      config: this.config,
      runtime,
    });
    this.metricsHelper = new MetricsHelper({ config: this.config });
    this.agentFileCollector = new AgentFileCollector({ runtime });
    this.synthesizer = new MultiAgentSynthesizer();
    // #5 Quality gate upgrade: wire up LLM-as-judge when a provider is registered.
    // Prefers providers in this order: openai > anthropic > google > deepseek > glm.
    try {
      const getProvider = (this.runtime as { getProvider?: (name: string) => unknown }).getProvider;
      if (typeof getProvider === 'function') {
        const judgeProvider =
          getProvider.call(this.runtime, 'openai') ??
          getProvider.call(this.runtime, 'anthropic') ??
          getProvider.call(this.runtime, 'google') ??
          getProvider.call(this.runtime, 'deepseek') ??
          getProvider.call(this.runtime, 'glm');
        if (judgeProvider) {
          const judgeModel = process.env.COMMANDER_JUDGE_MODEL ?? 'gpt-4o-mini';
          this.synthesizer.setLLMEvaluator(
            judgeProvider as import('../runtime/types').LLMProvider,
            judgeModel,
          );
        }
      }
    } catch {
      // No provider available — quality gate falls back to rule-based evaluation
    }
    this.qualityGateFixer = new QualityGateFixer({
      runtime,
      synthesizer: this.synthesizer,
      qualityGates: this.config.qualityGates,
    });
    this.workCoordinator = getWorkCoordinator();
  }

  async execute(params: {
    projectId: string;
    agentId: string;
    goal: string;
    contextData?: Record<string, unknown>;
    effortLevel?: EffortLevel;
    topology?: OrchestrationTopology;
    tenantId?: string;
    ownerId?: string;
    onProgress?: (phase: string, detail: string) => void;
  }): Promise<UltimateExecutionResult> {
    const execId = generateExecId(this.executionCounter);
    const startTime = Date.now();
    const bus = getMessageBus();
    void getTraceRecorder();
    const errors: ExecutionError[] = [];
    const reasoning: string[] = [];
    const artifactsCreated: ArtifactReference[] = [];

    const emit = (phase: string, detail: string) => {
      bus.publish('agent.started', `ultimate-orch-${execId}`, { phase, detail, execId });
      params.onProgress?.(phase, detail);
    };

    try {
      getIntentLog(undefined).write({
        schemaVersion: 1,
        runId: execId,
        capturedAt: new Date().toISOString(),
        stage: 'ultimate.execute',
        decision: 'enter',
        reason: 'orchestrator.execute() entered',
        payload: {
          agentId: params.agentId,
          goal: params.goal.slice(0, 200),
          effortLevel: params.effortLevel,
          requestedTopology: params.topology,
        },
      });
    } catch (err) {
      reportSilentFailure(err, 'orchestrator:170');
      /* best-effort */
    }

    emit('INIT', `Starting execution: ${params.goal.slice(0, 100)}...`);

    const ctx = this.metricsHelper.buildContext(execId, params);
    this.activeExecutions.set(execId, ctx);

    // Unified trajectory analysis + evolution cycle (deduplicated: single TrajectoryAnalyzer call)

    let taskTree!: TaskTreeNode;

    try {
      // Phase 1: Deliberation (LLM-powered when a provider is registered)
      emit('DELIBERATION', 'Analyzing task requirements...');
      const firstProvider =
        this.runtime.getFirstAvailableProvider?.() ??
        this.runtime.getProvider('openai') ??
        this.runtime.getProvider('anthropic') ??
        this.runtime.getProvider('openrouter') ??
        this.runtime.getProvider('mimo') ??
        this.runtime.getProvider('deepseek') ??
        this.runtime.getProvider('glm') ??
        this.runtime.getProvider('xiaomi') ??
        this.runtime.getProvider('google');
      const useLLM = this.config.enableDeliberation && firstProvider !== undefined;
      const deliberation = useLLM
        ? await deliberateWithLLM(params.goal, firstProvider, params.contextData)
        : deliberate(params.goal, params.contextData);
      ctx.deliberation = deliberation;
      reasoning.push(...deliberation.reasoning);
      reasoning.push(`Confidence: ${(deliberation.confidence * 100).toFixed(0)}%`);

      // Phase 2: Effort Scaling — reuse from deliberation when available to avoid redundant classification
      emit('EFFORT_SCALING', `Classifying effort level...`);
      const effortLevel =
        params.effortLevel ??
        deliberation.effortLevel ??
        classifyEffortLevel(params.goal, {
          toolCount: (params.contextData?.availableTools as string[] | undefined)?.length,
          riskLevel: (params.contextData?.governanceProfile as Record<string, string> | undefined)
            ?.riskLevel,
        });
      ctx.effortLevel = effortLevel;
      const scalingRules = getEffortRules(effortLevel);
      ctx.scalingRules = scalingRules;
      this.subAgentExecutor.setEffortLevel(effortLevel);
      reasoning.push(
        `Effort level: ${effortLevel} (${scalingRules.minSubAgents}-${scalingRules.maxSubAgents} agents)`,
      );

      // Phase 3: Preliminary topology hint for decomposition (refined after real DAG)
      const decompositionTopology: OrchestrationTopology =
        params.topology ?? deliberation.recommendedTopology;
      reasoning.push(`Preliminary topology for decomposition: ${decompositionTopology}`);

      // Phase 4: Recursive Task Decomposition
      emit('DECOMPOSITION', `Decomposing task into subtasks...`);
      taskTree = this.atomizer.decompose(
        params.goal,
        deliberation,
        null,
        0,
        (params.contextData?.availableTools as string[] | undefined) ?? [],
        decompositionTopology,
      );
      ctx.taskTree = taskTree;

      // If the root task is atomic (simple enough to execute directly),
      // wrap it as the single subtask instead of failing
      if (taskTree.subtasks.length === 0 && taskTree.isAtomic) {
        taskTree.subtasks = [
          {
            ...taskTree,
            id: `${taskTree.id}_sub`,
            parentId: taskTree.id,
            role: 'EXECUTOR',
            subtasks: [],
          },
        ];
      }

      if (taskTree.subtasks.length === 0) {
        return {
          id: execId,
          status: 'FAILED',
          summary: 'Task decomposition produced 0 subtasks',
          synthesis: `Task decomposition produced 0 subtasks. The task may be too vague or malformed. Try rephrasing with more specific details.`,
          reasoning,
          metrics: {
            totalTokens: 0,
            totalCostUsd: 0,
            totalDurationMs: Date.now() - startTime,
            llmCalls: 0,
            toolCalls: 0,
            subAgentsSpawned: 0,
            artifactsCreated: 0,
            qualityScore: 0,
            topologyUsed: decompositionTopology,
            effortLevelUsed: effortLevel,
          },
          errors: [
            {
              nodeId: 'root',
              agentId: 'orchestrator',
              message: 'Task decomposition produced 0 subtasks',
              recovered: false,
            },
          ],
          artifacts: [],
          executionTree: [],
        };
      }

      reasoning.push(`Task tree: ${countNodes(taskTree)} nodes, depth ${measureDepth(taskTree)}`);

      // Phase 3b: Real DAG routing from decomposed task tree (M3)
      emit('TOPOLOGY_ROUTING', 'Selecting orchestration topology from task DAG...');
      const taskDAG = buildTaskDAGFromTree(taskTree, (nodes, edges) =>
        this.topologyRouter.buildDAG(nodes, edges),
      );
      const topologyResult = this.topologyRouter.route(deliberation, taskDAG);
      const topology =
        params.topology ??
        (useLLM && deliberation.recommendedTopology
          ? deliberation.recommendedTopology
          : topologyResult.topology);
      ctx.topology = topology;
      ctx.taskDAG = taskDAG;
      reasoning.push(...topologyResult.reasoning);
      reasoning.push(
        `Topology: ${topology}${useLLM && deliberation.recommendedTopology ? ' (from LLM deliberation)' : ` (from router, expected cost: $${topologyResult.expectedCost.toFixed(4)})`} ` +
          `[DAG nodes=${taskDAG.nodes.length}, width=${taskDAG.metadata?.parallelismWidth ?? 1}, depth=${taskDAG.metadata?.criticalPathDepth ?? 1}]`,
      );
      try {
        getIntentLog(undefined).write({
          schemaVersion: 1,
          runId: execId,
          capturedAt: new Date().toISOString(),
          stage: 'ultimate.routing',
          decision: 'topology_selected',
          reason: 'topology chosen from task DAG',
          payload: {
            topology,
            taskType: deliberation.taskType,
            expectedCost: topologyResult.expectedCost,
            expectedLatency: topologyResult.expectedLatency,
            dagNodeCount: taskDAG.nodes.length,
            parallelismWidth: taskDAG.metadata?.parallelismWidth,
            criticalPathDepth: taskDAG.metadata?.criticalPathDepth,
          },
        });
      } catch (err) {
        reportSilentFailure(err, 'orchestrator:253');
        /* best-effort */
      }
      try {
        getMetricsCollector().recordTopoChoice(topology, deliberation.taskType);
      } catch (err) {
        reportSilentFailure(err, 'orchestrator:259');
        /* best-effort */
      }

      // ── Token Budget Allocation ───────────────────────────────────────────
      // Split the total budget proportionally across sub-agents based on
      // their estimated token needs (from deliberation/atomizer).
      const totalBudget = this.config.defaultBudget.hardCapTokens;
      const budgetManager = getTokenBudgetManager();
      budgetManager.startRun(execId, { hardCap: totalBudget });
      void getCheckpointWriter();
      const subAgentEstimates = taskTree.subtasks.map((s) => ({
        nodeId: s.id,
        estimatedTokens:
          s.context.estimatedTokens || Math.ceil(totalBudget / taskTree.subtasks.length),
      }));
      if (subAgentEstimates.length > 0) {
        const allocations = budgetManager.allocateToSubAgents(execId, subAgentEstimates);
        for (const sub of taskTree.subtasks) {
          const allocated = allocations.get(sub.id);
          if (allocated !== undefined) {
            sub.context.estimatedTokens = allocated;
          }
        }
        reasoning.push(
          `Budget: ${totalBudget.toLocaleString()} tokens across ${subAgentEstimates.length} sub-agents`,
        );
      }

      // ── TELOS Budget Preflight ─────────────────────────────────────────
      // Create a lightweight plan and check whether the budget is feasible
      // before committing sub-agents. This is an advisory gate — if preflight
      // warns, we log it but continue (the token governor enforces hard caps).
      try {
        const telosPlan = this.telos.plan({
          projectId: execId,
          agentId: 'orchestrator',
          goal: params.goal,
          contextData: {
            mode: 'balanced',
            availableTokens: budgetManager.getRemainingBudget(execId),
            constraints: {
              maxSteps: ctx.taskTree.subtasks.length * 3,
              maxTokens: totalBudget,
              timeoutMs: this.config.executionTimeoutMs ?? 300000,
            },
          },
        });
        const preflight = this.telos.preflight(telosPlan.planId);
        if (!preflight.allowed) {
          reasoning.push(`TELOS preflight: ${preflight.reason ?? 'budget advisory'}`);
        } else {
          reasoning.push(`TELOS preflight: budget OK (${telosPlan.mode} mode)`);
        }
      } catch (e) {
        reasoning.push(`TELOS preflight skipped: ${e instanceof Error ? e.message : 'unknown'}`);
      }

      // ── Work Queue Enqueue ──────────────────────────────────────────────
      // Enqueue subtasks for visibility and crash recovery. The
      // subAgentExecutor handles claiming, execution, and completion via
      // the WorkCoordinator's native lifecycle — we only seed the queue.
      try {
        const workItems = this.workCoordinator.enqueue(
          taskTree.subtasks.map((sub) => ({
            runId: execId,
            parentNodeId: sub.id,
            goal: sub.goal,
            tools: sub.context.availableTools ?? [],
            // Intentionally omitted: subAgentExecutor drives dependency
            // ordering via task-tree DAG, not WorkCoordinator-level
            // resolution. Passing node IDs would break dependenciesMet()
            // (expects WorkItem IDs, not node IDs).
            tokenBudget: sub.context.estimatedTokens ?? 50000,
            priority: sub.dependencies?.length === 0 ? 80 : 50,
            tenantId: params.tenantId,
            ownerId: params.ownerId,
          })),
        );
        reasoning.push(
          `Work queue: ${workItems.length} items enqueued (${workItems.filter((w) => w.priority >= 80).length} root)`,
        );
      } catch (e) {
        reasoning.push(`Work queue enqueue skipped: ${e instanceof Error ? e.message : 'unknown'}`);
      }

      // Phase 5: Team Formation (if topology needs it)
      let teamId: string | null = null;
      if (this.config.enableTeams && taskTree.subtasks.length > 2) {
        emit('TEAM_FORMATION', `Forming agent team...`);
        const members = taskTree.subtasks.map((sub, i) => ({
          agentId: sub.id,
          role:
            i === 0
              ? ('LEAD' as const)
              : i % 2 === 0
                ? ('RESEARCHER' as const)
                : ('CODER' as const),
          capabilities: sub.context.availableTools,
          status: 'IDLE' as const,
        }));
        const team = this.teamManager.createTeam(`team-${execId.slice(-8)}`, members, {
          goal: params.goal,
          execId,
        });
        teamId = team.id;
        ctx.team = team;
        reasoning.push(`Team formed: ${team.name} (${members.length} members)`);

        for (const sub of taskTree.subtasks) {
          const task = this.teamManager.addTask(team.id, {
            description: sub.goal.slice(0, 200),
            assignedTo: sub.id,
            dependencies: sub.dependencies,
          });
          if (task) {
            this.teamManager.assignTask(team.id, task.id, sub.id);
          }
        }
      }

      // Phase 6: Parallel Execution with team inbox collaboration
      emit('EXECUTION', `Executing ${taskTree.subtasks.length} subtasks...`);
      this.subAgentExecutor.setRunId(execId);
      if (teamId) {
        this.subAgentExecutor.setTeam(teamId);
      }

      // Topology-specific execution paths. Each topology has a dedicated runner
      // so the execution semantics match the routing decision.
      const handled = await this.topologyRunner.execute({
        topology,
        taskTree,
        errors,
        reasoning,
        projectId: params.projectId,
        contextData: params.contextData,
      });
      if (!handled) {
        await this.subAgentExecutor.executeNode(
          taskTree,
          params.projectId,
          params.contextData ?? {},
          errors,
        );
      }
      this.subAgentExecutor.setTeam(null);

      const completedCount = countCompleted(taskTree);
      const failedCount = countFailed(taskTree);
      reasoning.push(`Execution: ${completedCount} completed, ${failedCount} failed`);

      // ── Checkpoint Trigger (MiMo-style: 20%/45%/70% token budget) ──────
      // Runs an independent LLM call outside the main agent's attention.
      // Writes checkpoint.md for crash recovery and rebuild prompt injection.
      this.checkpointManager
        .maybeCheckpoint(execId, taskTree, params, errors, reasoning)
        .catch(() => {
          // Background task — ignore failures, don't block the main loop
        });

      // Fetch artifacts before merging shared state (allArtifacts needed for merge + synthesis)
      const allArtifacts = await this.artifactSystem.find({ tags: ['completed'] }, 50);

      // Merge sub-agent results into shared state using per-key reducers
      const completedNodes = flattenTree(taskTree).filter(
        (n) => n.status === 'COMPLETED' && n.result,
      );
      const failedNodes = flattenTree(taskTree).filter((n) => n.status === 'FAILED');
      ctx.sharedState = mergeSharedState(ctx.sharedState, {
        findings: completedNodes.map((n) => `[${n.goal.slice(0, 80)}] ${n.result!.slice(0, 500)}`),
        errors: failedNodes.map((n) => `[${n.goal.slice(0, 80)}] ${n.result ?? 'failed'}`),
        artifacts: allArtifacts.map((a) => a.id),
        costAccumulator: this.metricsHelper.estimateTotalCost(taskTree),
      });

      // Phase 7: Multi-Agent Synthesis
      emit('SYNTHESIS', `Synthesizing results from ${completedCount} completed subtasks...`);
      const synthesis = await this.synthesizer.synthesize(
        this.config.defaultSynthesisConfig.strategy,
        this.config.defaultSynthesisConfig,
        taskTree,
        allArtifacts,
      );

      reasoning.push(`Synthesis quality: ${(synthesis.qualityScore * 100).toFixed(0)}%`);

      // Compute execution metrics early for Phase 7.5 optimization
      const totalDurationMs = Date.now() - startTime;
      const allSuccess = errors.every((e) => e.recovered);
      const totalTokens = this.metricsHelper.sumTokenUsage(taskTree);

      // Phase 7.5: Post-Execution Reflexion Topology Optimization
      if (this.config.enableDeliberation) {
        try {
          const optimizationResult = await this.topologyOptimizer.optimize(
            {
              modelUsed: this.config.modelTierMapping[effortLevel] ?? 'standard',
              success: allSuccess,
              durationMs: totalDurationMs,
              tokenCost: totalTokens,
              taskType: topology,
              strategyUsed: `${effortLevel}_${topology}`,
              lessons: reasoning.slice(-5),
              timestamp: new Date().toISOString(),
              id: `exp-${execId}`,
              runId: execId,
              agentId: params.agentId,
            },
            taskTree,
            ctx,
          );
          if (optimizationResult.proposal.actions.length > 0) {
            reasoning.push(
              `Topology optimized: ${optimizationResult.proposal.actions.length} actions`,
            );
            const topologyAction = optimizationResult.proposal.actions.find(
              (a: OptimizationAction) => a.type === 'change_topology',
            );
            if (topologyAction && 'to' in topologyAction) {
              ctx.topology = topologyAction.to as OrchestrationTopology;
            }
          }
        } catch (e) {
          reasoning.push(
            `Topology optimization skipped: ${e instanceof Error ? e.message : 'unknown'}`,
          );
        }
      }

      // ── Checkpoint after synthesis (captures final state before quality gates) ──
      this.checkpointManager
        .maybeCheckpoint(execId, taskTree, params, errors, reasoning)
        .catch(() => {});

      // Phase 8: Quality Gates with Reflexion-inspired auto-fix retry loop
      const fixResult = await this.qualityGateFixer.runAutoFixLoop(
        {
          projectId: params.projectId,
          contextData: params.contextData,
          taskTree,
          initialSynthesis: synthesis.synthesis,
          initialQualityScore: synthesis.qualityScore,
          initialGateResults: synthesis.gateResults,
        },
        reasoning,
      );
      const finalSynthesis = fixResult.finalSynthesis;
      const finalQualityScore = fixResult.finalQualityScore;
      const finalGateResults = fixResult.finalGateResults;

      // Collect artifacts
      for (const artifact of allArtifacts) {
        artifactsCreated.push(artifact);
      }

      // Record experience for self-evolution with real metrics
      const lessons: string[] = [];
      for (const gate of finalGateResults) {
        if (!gate.passed)
          lessons.push(
            `Quality gate "${gate.gate}" scored ${(gate.score * 100).toFixed(0)}% (threshold: ${(this.config.qualityGates.find((g) => g.name === gate.gate)?.threshold ?? 0.7) * 100}%)`,
          );
      }
      if (completedCount > 0 && failedCount > 0) {
        lessons.push(`${failedCount}/${countNodes(taskTree)} subtasks failed - partial completion`);
      }
      const exp: ExecutionExperience = {
        id: `exp-${execId}`,
        runId: execId,
        agentId: params.agentId,
        taskType: topology,
        modelUsed: this.config.modelTierMapping[effortLevel] ?? 'standard',
        strategyUsed: `${effortLevel}_${topology}`,
        success: allSuccess,
        durationMs: totalDurationMs,
        tokenCost: totalTokens,
        lessons,
        timestamp: new Date().toISOString(),
      };
      getMetaLearner().recordExperience(exp);

      // Self-optimize: apply meta-learner suggestions after each execution
      this.evolutionRunner.applyOptimizationSuggestions(exp);

      // Unified trajectory analysis + evolution cycle (deduplicated: single TrajectoryAnalyzer call)
      if (!allSuccess) {
        this.evolutionRunner.analyzeAndEvolve(exp, effortLevel, topology).catch((e) =>
          getGlobalLogger().warn('UltimateOrchestrator', 'Trajectory analysis/evolution failed', {
            error: (e as Error)?.message,
          }),
        );
      }

      // ── Workflow Evolution ──────────────────────────────────────────────
      // Evolve the DAG-based workflow based on execution results to improve
      // future task decomposition and topology selection.
      if (this.evolutionEngine) {
        try {
          const evolutionResult = await this.evolutionEngine.evolve({
            taskType: topology,
            availableTools: (params.contextData?.availableTools as string[]) ?? [],
            existingTree: taskTree,
            generations: 1,
            populationSize: 3,
            maxDurationSeconds: 30,
          });
          if (evolutionResult && evolutionResult.improvements.length > 0) {
            reasoning.push(
              `Workflow evolved: ${evolutionResult.generations} gen(s), ${evolutionResult.improvements.length} improvement(s)`,
            );
          }
        } catch (e) {
          reasoning.push(
            `Workflow evolution skipped: ${e instanceof Error ? e.message : 'unknown'}`,
          );
        }
      }

      try {
        const { MetaLearnerBridge, getSkillSystem } = await import('../skills');
        const bridge = new MetaLearnerBridge(getMetaLearner(), getSkillSystem().manager);
        const newSkills = await bridge.extractSkills();
        if (newSkills.length > 0) {
          bus.publish('skills.created', 'ultimate-orch', {
            skills: newSkills.map((s) => s.name),
            execId,
          });
        }
      } catch (e) {
        getGlobalLogger().warn('UltimateOrchestrator', 'Skill extraction failed', {
          error: (e as Error)?.message,
        });
      }

      // Store execution result in vector memory for future retrieval
      try {
        const memory = getGlobalThreeLayerMemory();
        const qualitySummary = finalGateResults
          .map((g) => `${g.gate}=${(g.score * 100).toFixed(0)}%`)
          .join(', ');
        memory.add(
          `[${allSuccess ? 'SUCCESS' : 'FAIL'}] ${params.goal.slice(0, 200)}`,
          'episodic',
          `topology:${topology}|effort:${effortLevel}|quality:${qualitySummary}`,
          allSuccess ? 0.8 : 0.3,
          [topology, effortLevel, allSuccess ? 'success' : 'failure', 'execution'],
          { execId, goal: params.goal.slice(0, 500) },
        );
      } catch (e) {
        getGlobalLogger().warn('UltimateOrchestrator', 'Memory write failed', {
          error: (e as Error)?.message,
        });
        // Memory is non-critical
      }

      // Cleanup team
      if (teamId) {
        this.teamManager.disbandTeam(teamId);
      }

      const metrics = this.metricsHelper.computeMetrics(
        taskTree,
        startTime,
        topology,
        effortLevel,
        finalQualityScore,
        artifactsCreated.length,
      );

      // Collect actual file content written by agents during execution.
      // Agents may write to workspace files, /tmp/, or per-agent output dirs.
      const finalOutput = await this.agentFileCollector.collectAndEnrich(
        {
          execId,
          goal: params.goal,
          projectId: params.projectId,
          contextData: params.contextData,
          startTime,
          taskTree,
          allArtifacts,
          finalSynthesis,
        },
        reasoning,
      );

      // Write synthesis output to target file if the goal specifies one.
      // Always write to ensure the file has the full synthesized content.
      try {
        const resolvedPath = await writeSynthesisOutput(params.goal, finalOutput);
        if (resolvedPath) {
          reasoning.push(`Wrote synthesis output (${finalOutput.length} bytes) to ${resolvedPath}`);
        }
      } catch (e) {
        reasoning.push(`File write failed: ${e instanceof Error ? e.message : 'unknown'}`);
      }

      emit(
        'COMPLETE',
        `Execution ${allSuccess ? 'succeeded' : 'completed with issues'} (${metrics.totalCostUsd.toFixed(4)} USD)`,
      );

      return {
        id: execId,
        status: allSuccess ? 'SUCCESS' : errors.length > 0 ? 'FAILED' : 'PARTIAL',
        summary: `${completedCount}/${countNodes(taskTree)} subtasks completed. ${errors.length} errors.`,
        synthesis: finalSynthesis,
        artifacts: artifactsCreated,
        executionTree: flattenTree(taskTree),
        metrics,
        errors,
        reasoning,
      };
    } finally {
      // Terminal checkpoint: capture final state for future rebuild
      this.checkpointManager
        .maybeCheckpoint(execId, taskTree, params, errors, reasoning)
        .catch(() => {});
      // Clean up rebuild tracking for this run (prevents unbounded Map growth)
      try {
        getRebuildPrompt().resetRun(execId);
      } catch (err) {
        reportSilentFailure(err, 'orchestrator:1028');
        /* best-effort */
      }
      this.activeExecutions.delete(execId);
    }
  }

  getExecution(id: string): UltimateExecutionContext | undefined {
    return this.activeExecutions.get(id);
  }

  listExecutions(): UltimateExecutionContext[] {
    return Array.from(this.activeExecutions.values());
  }

  getConfig(): UltimateOrchestratorConfig {
    return { ...this.config };
  }

  /**
   * Live update of one (or all) quality gate thresholds. Mutates BOTH the
   * engine-side `config.qualityGates` (consumed by `runQualityGatesStrict`)
   * and the synthesis-side `config.defaultSynthesisConfig.qualityGates`
   * (consumed by `applyOptimizationSuggestions`). Threshold is clamped to
   * [0, 1]. Name "all" applies to every enabled gate.
   * Returns true if any gate was updated.
   */
  setQualityGateThreshold(name: string, threshold: number): boolean {
    const clamped = Math.max(0, Math.min(1, threshold));
    let updated = false;
    const applyTo = (g: QualityGateConfig): boolean => {
      if ((name === 'all' || g.name === name) && g.enabled) {
        if (g.threshold !== clamped) {
          g.threshold = clamped;
          return true;
        }
      }
      return false;
    };
    for (const g of this.config.qualityGates) {
      if (applyTo(g)) updated = true;
    }
    for (const g of this.config.defaultSynthesisConfig.qualityGates) {
      if (applyTo(g)) updated = true;
    }
    return updated;
  }

  /**
   * Live override of effort-level → model-tier mapping. Useful for forcing
   * all sub-agents onto a single tier mid-session (e.g., cost honeymoon).
   * Pass `undefined` for `tier` to reset to default tier for a level.
   */
  setModelTier(effortLevel: EffortLevel, tier: ModelTier | undefined): void {
    // Resolve against the truth-source DEFAULT_ULTIMATE_CONFIG so future
    // changes to types.ts defaults propagate without drift. (Reviewer fix.)
    this.config.modelTierMapping[effortLevel] =
      tier ?? DEFAULT_ULTIMATE_CONFIG.modelTierMapping[effortLevel];
  }

  /**
   * Close the meta-learning feedback loop.
   * Delegates to EvolutionRunner — preserved as public API for external callers.
   */
  applyOptimizationSuggestions(exp?: ExecutionExperience): void {
    this.evolutionRunner.applyOptimizationSuggestions(exp);
  }

  dispose(): void {
    this.activeExecutions.clear();
    this.evolutionEngine = null;
  }
}

// Re-export tree utilities for backward compatibility (tests and consumers that import from orchestrator)
export { countNodes, measureDepth, flattenTree } from './taskTreeUtils';
