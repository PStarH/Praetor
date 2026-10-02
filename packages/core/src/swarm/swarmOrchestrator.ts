import type { LLMProvider } from '../runtime/types';
import type { CritiqueResult } from '../goal/types';
import type {
  SwarmConfig,
  SwarmNode,
  SwarmManager,
  SwarmTopology,
  SwarmResult,
  SwarmStatus,
  FusionReport,
} from './types';
import { DEFAULT_SWARM_CONFIG } from './types';
import { FusionEngine } from './fusionEngine';
import { getMessageBus } from '../runtime/messageBus';
import {
  generateNodeId,
  sharedManagerDecompose,
  sharedManagerReview,
  sharedWorkerExecute,
  sharedCriticEvaluate,
  buildTree,
  applyReview,
  computeFindingsFingerprint,
  computeImprovementRate,
  makeBaseDecision,
  buildBaseSummary,
  SHARED_MANAGER_REVIEW_PROMPT,
  SHARED_CRITIC_PROMPT,
} from '../ultimate/baseOrchestrator';
import type { DecompositionSubGoal } from '../ultimate/baseOrchestrator';

// ============================================================================
// Swarm-specific prompts
// ============================================================================

const SWARM_MANAGER_DECOMPOSE_PROMPT = `You are a Manager Agent in a Swarm system. Your job is to break down a complex goal into smaller sub-goals that can be worked on in parallel or recursively decomposed.

For each sub-goal, specify:
- goal: a concrete, actionable description
- dependencies: array of sibling sub-goal indices (0-based) that must be completed first
- notes: optional guidance for the worker agent
- complexity: integer 1-10 estimating how complex this sub-goal is (1=trivial, 10=extremely complex)

Complex sub-goals (7+) may be recursively delegated to child managers for further decomposition.
Simple sub-goals (1-3) can be executed directly by a worker.
Medium sub-goals (4-6) may go either way.

Rules:
- Each sub-goal should be achievable by a single agent in one pass
- Maximize parallelism (minimize dependencies between sub-goals)
- Output ONLY valid JSON with no markdown formatting
- Do NOT wrap the JSON in \`\`\`json or any other markers

Return:
{
  "subGoals": [
    { "goal": "description", "dependencies": [], "notes": "", "complexity": 5 }
  ],
  "reasoning": "brief explanation of your decomposition and fission decisions"
}`;

const SWARM_WORKER_PROMPT = `You are a Worker Agent in a Swarm system. Execute the assigned task thoroughly. Provide complete, production-quality output. Include code, explanations, and any relevant details.`;

// ============================================================================
// Swarm-specific tree helpers (traverse children → child.result?.rootNodes)
// ============================================================================

function swarmFindNodeById(nodes: SwarmNode[], id: string): SwarmNode | undefined {
  for (const n of nodes) {
    if (n.id === id) return n;
    for (const child of n.children) {
      if (child.id === id) return swarmFindNodeById(child.result?.rootNodes ?? [], id);
    }
    const found = swarmFindNodeById(n.subNodes, id);
    if (found) return found;
  }
  return undefined;
}

function swarmCollectAllNodes(nodes: SwarmNode[]): SwarmNode[] {
  const result: SwarmNode[] = [];
  for (const n of nodes) {
    result.push(n);
    result.push(...swarmCollectAllNodes(n.subNodes));
    for (const child of n.children) {
      result.push(...swarmCollectAllNodes(child.result?.rootNodes ?? []));
    }
  }
  return result;
}

function swarmCountActiveNodes(nodes: SwarmNode[]): number {
  let count = 0;
  for (const n of nodes) {
    if (n.status === 'pending' || n.status === 'in_progress' || n.status === 're_opened') count++;
    count += swarmCountActiveNodes(n.subNodes);
    for (const child of n.children) {
      count += swarmCountActiveNodes(child.result?.rootNodes ?? []);
    }
  }
  return count;
}

function computeTopology(nodes: SwarmNode[], depth = 0): SwarmTopology {
  let managerCount = 1;
  let totalNodes = nodes.length;
  const levelBreaths: number[] = [];

  levelBreaths[depth] = (levelBreaths[depth] ?? 0) + nodes.length;

  for (const n of nodes) {
    for (const child of n.children) {
      managerCount++;
      if (child.result) {
        const childTopo = child.result.topology;
        totalNodes += childTopo.totalNodes;
        managerCount += childTopo.managerCount - 1;
        for (let i = 0; i < childTopo.levelBreaths.length; i++) {
          const targetDepth = depth + 1 + i;
          levelBreaths[targetDepth] = (levelBreaths[targetDepth] ?? 0) + childTopo.levelBreaths[i];
        }
      }
    }
    const subTopo = computeTopology(n.subNodes, depth);
    if (subTopo.levelBreaths.length > 0) {
      for (let i = 0; i < subTopo.levelBreaths.length; i++) {
        levelBreaths[i] = (levelBreaths[i] ?? 0) + subTopo.levelBreaths[i];
      }
    }
  }

  let effectiveDepth = 0;
  for (let i = 0; i < levelBreaths.length; i++) {
    if (levelBreaths[i] > 0) effectiveDepth = i;
  }

  return {
    managerCount,
    totalNodes,
    depth: effectiveDepth,
    levelBreaths: levelBreaths.filter((b) => b > 0),
  };
}

// ============================================================================
// SwarmOrchestrator
// ============================================================================

export class SwarmOrchestrator {
  private provider: LLMProvider;
  private config: SwarmConfig;
  private model: string;
  private fusionEngine: FusionEngine;
  private rootNodes: SwarmNode[] = [];
  private depth: number;
  private fusionReports: FusionReport[] = [];

  constructor(provider: LLMProvider, config?: Partial<SwarmConfig>, depth = 0) {
    this.provider = provider;
    this.config = { ...DEFAULT_SWARM_CONFIG, ...config };
    this.model =
      this.config.model ??
      (provider as any).defaultModel ??
      (provider as any).config?.defaultModel ??
      'gpt-4o-mini';
    this.config.model = this.model;
    this.fusionEngine = new FusionEngine();
    this.depth = depth;
  }

  async execute(goal: string): Promise<SwarmResult> {
    this.rootNodes = [];
    this.fusionReports = [];

    const bus = getMessageBus();
    const startTime = Date.now();
    let totalTokensUsed = 0;

    bus.publish('swarm.started', 'swarm-orch', {
      goal,
      depth: this.depth,
      mode: this.config.goalConfig.mode ?? 'balanced',
    });

    const decomposition = await sharedManagerDecompose(
      this.provider,
      this.model,
      SWARM_MANAGER_DECOMPOSE_PROMPT,
      goal,
      'SwarmOrchestrator',
    );
    if (!decomposition) {
      return {
        goal,
        status: 'failed',
        totalRounds: 0,
        totalTokensUsed,
        totalDurationMs: Date.now() - startTime,
        topology: { managerCount: 1, totalNodes: 0, depth: this.depth, levelBreaths: [] },
        rootNodes: [],
        fusionReports: [],
        summary: 'Failed to decompose goal.',
      };
    }
    totalTokensUsed += decomposition.tokens;

    const goalTree = buildTree<SwarmNode>({
      subGoals: decomposition.data.subGoals as DecompositionSubGoal[],
      parentId: null,
      createNode: (id, sg, parentId) => ({
        id,
        goal: sg.goal,
        parentId,
        status: 'pending',
        subNodes: [],
        children: [],
        dependencies: [],
        metadata: {
          notes: sg.notes ?? '',
          complexity: sg.complexity ?? 3,
        },
      }),
    });
    this.rootNodes = goalTree;

    bus.publish('swarm.fission', 'swarm-orch', {
      subGoalCount: goalTree.length,
      decomposition: decomposition.data,
      depth: this.depth,
    });

    let round = 0;
    let prevFindingsSet: Set<string> | null = null;
    let plateauRounds = 0;
    const maxRounds = this.config.goalConfig.maxRounds ?? 10;

    while (round < maxRounds) {
      round++;
      let roundTokens = 0;

      bus.publish('swarm.fusion_conflict', 'swarm-orch', {
        round,
        depth: this.depth,
        activeGoals: swarmCountActiveNodes(goalTree),
      });

      // === FISSION: check each sub-goal for recursive decomposition ===
      await this.processFission(goalTree);

      // === WORKER execution (for non-fissioned nodes) ===
      const pending = this.getPendingNodes(goalTree);
      for (const node of [...pending]) {
        node.status = 'in_progress';

        const deps = Array.isArray(node.dependencies) ? node.dependencies : [];
        const depsBlocked = deps.some((depId) => {
          const dep = swarmFindNodeById(goalTree, depId);
          if (!dep) return true;
          return dep.status !== 'completed';
        });
        if (depsBlocked) continue;

        // Skip nodes that were fissioned (they have children)
        if (node.children.length > 0) continue;

        const depContext = deps
          .map((depId) => {
            const dep = swarmFindNodeById(this.rootNodes, depId);
            return dep
              ? `Dependency "${dep.goal}" output:\n${dep.workerOutput?.slice(0, 500) ?? '(no output)'}`
              : '';
          })
          .filter(Boolean)
          .join('\n\n');

        const workerResult = await sharedWorkerExecute({
          provider: this.provider,
          model: this.model,
          systemPrompt: SWARM_WORKER_PROMPT,
          parentGoal: goal,
          nodeGoal: node.goal,
          dependencyContext: depContext,
        });

        if (workerResult) {
          node.workerOutput = workerResult.output;
          node.status = 'completed';
          roundTokens += workerResult.tokens;
        } else {
          node.status = 'failed';
          continue;
        }

        const criticResult = await sharedCriticEvaluate({
          provider: this.provider,
          model: this.model,
          criticPrompt: SHARED_CRITIC_PROMPT,
          parentGoal: goal,
          nodeGoal: node.goal,
          workerOutput: node.workerOutput,
          logLabel: 'SwarmOrchestrator',
        });

        if (criticResult) {
          const findings = Array.isArray(criticResult.data?.findings)
            ? criticResult.data.findings
            : [];
          node.critique = {
            passed: criticResult.data?.passed ?? true,
            findings: findings.map((f) => ({
              severity: f?.severity ?? 'medium',
              category: (f?.category as CritiqueResult['findings'][0]['category']) ?? 'correctness',
              description: f?.description ?? '',
              location: f?.location,
              suggestion: f?.suggestion,
            })),
            summary: criticResult.data?.summary ?? '',
          };
          roundTokens += criticResult.tokens;
        } else {
          node.critique = {
            passed: false,
            findings: [
              {
                severity: 'medium' as const,
                category: 'correctness' as const,
                description: 'Critic evaluation failed',
                suggestion: 'Manual review needed',
              },
            ],
            summary: 'Critic evaluation failed.',
          };
        }
      }

      // === FUSION: detect cross-worker conflicts ===
      const allNodes = swarmCollectAllNodes(goalTree);
      const activeNodes = allNodes.filter(
        (n) => n.status === 'completed' || n.status === 'in_progress',
      );
      const fusionReport = this.fusionEngine.analyze(activeNodes, round);
      if (this.fusionReports.length > 200) this.fusionReports.shift();
      this.fusionReports.push(fusionReport);

      if (fusionReport.conflicts.length > 0) {
        bus.publish('system.alert', 'swarm-orch', {
          type: 'fusion_conflicts',
          round,
          conflictCount: fusionReport.conflicts.length,
        });
      }

      // === MANAGER REVIEW ===
      bus.publish('swarm.round_completed', 'swarm-orch', { round, depth: this.depth });
      const completed = allNodes.filter(
        (n) => n.status === 'completed' || n.status === 'in_progress',
      );
      const reviewResult = await sharedManagerReview(
        this.provider,
        this.model,
        SHARED_MANAGER_REVIEW_PROMPT,
        goal,
        round,
        completed.map((n) => ({
          id: n.id,
          goal: n.goal,
          status: n.status,
          output: n.workerOutput?.slice(0, 1000) ?? '(no output)',
          critique: n.critique ?? { passed: true, findings: [], summary: 'No critique' },
          childManagers:
            n.children.length > 0
              ? n.children.map((c) => ({
                  id: c.id,
                  goal: c.goal,
                  status: c.result?.status ?? 'unknown',
                  summary: c.result?.summary?.slice(0, 500) ?? '',
                }))
              : undefined,
        })),
        fusionReport,
        'SwarmOrchestrator',
      );

      if (reviewResult) {
        roundTokens += reviewResult.tokens;
        applyReview(goalTree, reviewResult.data);
        const newSubGoals = Array.isArray(reviewResult.data?.newSubGoals)
          ? reviewResult.data.newSubGoals
          : [];
        for (const newSub of newSubGoals) {
          const newNode: SwarmNode = {
            id: generateNodeId('swarm'),
            goal: newSub.goal,
            parentId: null,
            status: 'pending',
            subNodes: [],
            children: [],
            dependencies: Array.isArray(newSub.dependencies) ? newSub.dependencies : [],
          };
          goalTree.push(newNode);
        }
      }

      totalTokensUsed += roundTokens;

      // === CONTINUATION DECISION ===
      const totalFindings = allNodes.reduce(
        (sum, n) => sum + (n.critique?.findings?.length ?? 0),
        0,
      );

      const currentFindingsSet = computeFindingsFingerprint(allNodes);
      const improvementRate = computeImprovementRate(prevFindingsSet, currentFindingsSet);

      if (improvementRate < 0.02) plateauRounds++;
      else plateauRounds = 0;
      prevFindingsSet = currentFindingsSet;

      const baseDecision = makeBaseDecision(
        round,
        totalTokensUsed,
        totalFindings,
        plateauRounds,
        allNodes,
        {
          budgetTokens: this.config.goalConfig.budgetTokens ?? 500_000,
          maxRounds: this.config.goalConfig.maxRounds ?? 10,
          mode: this.config.goalConfig.mode ?? 'balanced',
        },
      );

      bus.publish('swarm.completed', 'swarm-orch', {
        round,
        depth: this.depth,
        decision: baseDecision.decision,
      });

      if (baseDecision.decision.startsWith('stop_')) break;
    }

    const elapsed = Date.now() - startTime;
    const finalAll = swarmCollectAllNodes(goalTree);
    const completedCount = finalAll.filter((n) => n.status === 'completed').length;
    const resultStatus: SwarmStatus =
      completedCount === finalAll.length && finalAll.length > 0
        ? 'completed'
        : completedCount > 0
          ? 'partial'
          : 'failed';

    return {
      goal,
      status: resultStatus,
      totalRounds: round,
      totalTokensUsed,
      totalDurationMs: elapsed,
      topology: computeTopology(goalTree, this.depth),
      rootNodes: goalTree,
      fusionReports: this.fusionReports,
      summary: this.buildSummary(goal, resultStatus, round, completedCount, finalAll.length),
    };
  }

  /**
   * FISSION: recursively decompose complex sub-goals into child SwarmOrchestrators.
   */
  private async processFission(nodes: SwarmNode[]): Promise<void> {
    for (const node of nodes) {
      if (node.children.length > 0 || node.status !== 'pending') continue;

      const complexity = (node.metadata?.complexity as number) ?? 3;
      const shouldFission =
        complexity >= this.config.fissionThreshold && this.depth < this.config.maxDepth;

      if (shouldFission) {
        const childOrch = new SwarmOrchestrator(
          this.provider,
          {
            ...this.config,
            goalConfig: { ...this.config.goalConfig },
          },
          this.depth + 1,
        );

        const childResult = await childOrch.execute(node.goal);

        const childManager: SwarmManager = {
          id: generateNodeId('swarm'),
          goal: node.goal,
          depth: this.depth + 1,
          topology: childResult.topology,
          result: childResult,
        };

        node.children.push(childManager);
        node.status = 'completed';
        node.workerOutput = childResult.summary;

        // Propagate findings from child tree
        const childAllNodes = swarmCollectAllNodes(childResult.rootNodes ?? []);
        const childFindings = childAllNodes
          .filter((n) => n.critique?.findings)
          .flatMap((n) => n.critique!.findings ?? []);
        if (childFindings.length > 0) {
          node.critique = {
            passed: !childFindings.some((f) => f && (f.severity === 'critical' || f.severity === 'high')),
            findings: childFindings.slice(0, 20),
            summary: `${childFindings.length} finding(s) from child manager`,
          };
        }
      }

      await this.processFission(node.subNodes);
    }
  }

  private getPendingNodes(nodes: SwarmNode[]): SwarmNode[] {
    const result: SwarmNode[] = [];
    for (const n of nodes) {
      if ((n.status === 'pending' || n.status === 're_opened') && n.children.length === 0) {
        result.push(n);
      }
      result.push(...this.getPendingNodes(n.subNodes));
    }
    return result;
  }

  private buildSummary(
    goal: string,
    status: SwarmStatus,
    rounds: number,
    completed: number,
    total: number,
  ): string {
    return buildBaseSummary({
      goal,
      status,
      rounds,
      completed,
      total,
      extraLines: [
        `Fusion conflicts detected: ${this.fusionReports.reduce((s, r) => s + r.conflicts.length, 0)}`,
        `Tree depth: ${this.depth}`,
      ],
    });
  }
}
