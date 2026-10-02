import { reportSilentFailure } from '../silentFailureReporter';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LLMProvider } from '../runtime/types';
import type {
  GoalNode,
  GoalConfig,
  GoalResult,
  RoundLedger,
  RoundDecision,
  CritiqueResult,
} from './types';
import { DEFAULT_GOAL_CONFIG } from './types';
import { getMessageBus } from '../runtime/messageBus';
import { getGlobalLogger } from '../logging';
import { getGoalJudge } from '../runtime/goalJudge';
import {
  generateNodeId,
  findNodeById,
  collectAllNodes,
  countActiveNodes,
  cloneTree,
  getPendingNodes,
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
  SHARED_MANAGER_DECOMPOSE_PROMPT,
  SHARED_MANAGER_REVIEW_PROMPT,
  SHARED_CRITIC_PROMPT,
} from '../ultimate/baseOrchestrator';

export class GoalOrchestrator {
  private provider: LLMProvider;
  private config: GoalConfig;
  private model: string;
  private rootNodes: GoalNode[] = [];
  private currentRound = 0;
  private checkpointPath: string | null = null;

  constructor(provider: LLMProvider, config?: Partial<GoalConfig>) {
    this.provider = provider;
    this.config = { ...DEFAULT_GOAL_CONFIG, ...config };
    this.model =
      config?.model ??
      (provider as any).defaultModel ??
      (provider as any).config?.defaultModel ??
      this.config.model ??
      DEFAULT_GOAL_CONFIG.model!;
    this.config.model = this.model;
  }

  // --------------------------------------------------------------------------
  // Persistence: Checkpoint to disk
  // --------------------------------------------------------------------------

  setCheckpointPath(filePath: string): void {
    this.checkpointPath = filePath;
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  private checkpoint(goal: string, ledger: RoundLedger[], plateauRounds: number): void {
    if (!this.checkpointPath) return;

    const state = {
      version: 1,
      timestamp: new Date().toISOString(),
      goal,
      rootNodes: this.rootNodes,
      currentRound: this.currentRound,
      ledger,
      plateauRounds,
      config: this.config,
    };

    const tmpPath = this.checkpointPath + '.tmp';
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
      fs.renameSync(tmpPath, this.checkpointPath);
      getGlobalLogger().debug('GoalOrchestrator', `Checkpoint saved: round ${this.currentRound}`);
    } catch (err) {
      getGlobalLogger().warn('GoalOrchestrator', `Checkpoint failed: ${(err as Error).message}`);
    }
  }

  resumeFromCheckpoint(): {
    goal: string;
    rootNodes: GoalNode[];
    currentRound: number;
    ledger: RoundLedger[];
    plateauRounds: number;
  } | null {
    if (!this.checkpointPath || !fs.existsSync(this.checkpointPath)) {
      return null;
    }

    try {
      const data = JSON.parse(fs.readFileSync(this.checkpointPath, 'utf-8'));
      if (data.version !== 1) {
        getGlobalLogger().warn('GoalOrchestrator', 'Incompatible checkpoint version, ignoring');
        return null;
      }

      this.rootNodes = data.rootNodes;
      this.currentRound = data.currentRound;

      getGlobalLogger().info(
        'GoalOrchestrator',
        `Resumed from checkpoint: round ${this.currentRound}`,
      );
      return {
        goal: data.goal,
        rootNodes: data.rootNodes,
        currentRound: data.currentRound,
        ledger: data.ledger,
        plateauRounds: data.plateauRounds,
      };
    } catch (err) {
      getGlobalLogger().warn('GoalOrchestrator', `Failed to resume: ${(err as Error).message}`);
      return null;
    }
  }

  clearCheckpoint(): void {
    if (this.checkpointPath && fs.existsSync(this.checkpointPath)) {
      try {
        fs.unlinkSync(this.checkpointPath);
      } catch (err) {
        reportSilentFailure(err, 'goalOrchestrator:134');
        /* ignore */
      }
    }
  }

  getGoalTree(): GoalNode[] {
    return this.rootNodes;
  }

  getCurrentRound(): number {
    return this.currentRound;
  }

  async execute(goal: string): Promise<GoalResult> {
    this.rootNodes = [];
    this.currentRound = 0;

    const bus = getMessageBus();
    const startTime = Date.now();
    let totalTokensUsed = 0;

    bus.publish('goal.started', 'goal-orch', { goal, mode: this.config.mode });

    const decomposition = await sharedManagerDecompose(
      this.provider,
      this.model,
      SHARED_MANAGER_DECOMPOSE_PROMPT,
      goal,
      'GoalOrchestrator',
    );
    if (!decomposition) {
      return {
        goal,
        status: 'failed',
        totalRounds: 0,
        totalTokensUsed,
        totalDurationMs: Date.now() - startTime,
        ledger: [],
        finalGoalTree: [],
        summary: 'Failed to decompose goal.',
      };
    }
    totalTokensUsed += decomposition.tokens;

    let goalTree = buildTree<GoalNode>({
      subGoals: decomposition.data.subGoals,
      parentId: null,
      createNode: (id, sg, parentId) => ({
        id,
        goal: sg.goal,
        parentId,
        status: 'pending',
        subGoals: [],
        dependencies: [],
        metadata: sg.notes ? { notes: sg.notes } : undefined,
      }),
    });
    this.rootNodes = goalTree;

    bus.publish('goal.decomposed', 'goal-orch', {
      subGoalCount: goalTree.length,
      decomposition: decomposition.data,
    });

    const ledger: RoundLedger[] = [];
    let round = 0;
    let prevFindingsSet: Set<string> | null = null;
    let plateauRounds = 0;
    let consecutiveFailedRounds = 0;
    const MAX_CONSECUTIVE_FAILURES = 3;

    while (round < this.config.maxRounds) {
      round++;
      this.currentRound = round;
      let roundTokens = 0;
      let roundFailures = 0;

      bus.publish('goal.round_started', 'goal-orch', {
        round,
        activeGoals: countActiveNodes(goalTree),
      });

      const pending = getPendingNodes(goalTree);
      for (const node of [...pending]) {
        node.status = 'in_progress';
        node.roundAssigned = node.roundAssigned ?? round;

        const deps = Array.isArray(node.dependencies) ? node.dependencies : [];
        const depsBlocked = deps.some((depId) => {
          const dep = findNodeById(goalTree, depId);
          return dep && dep.status !== 'completed';
        });
        if (depsBlocked) continue;

        bus.publish('goal.worker_started', 'goal-orch', { goalId: node.id, goal: node.goal });

        const depContext = deps
          .map((depId) => {
            const dep = findNodeById(this.rootNodes, depId);
            return dep
              ? `Dependency "${dep.goal}" output:\n${dep.workerOutput?.slice(0, 500) ?? '(no output)'}`
              : '';
          })
          .filter(Boolean)
          .join('\n\n');

        const workerResult = await sharedWorkerExecute({
          provider: this.provider,
          model: this.model,
          systemPrompt: `You are a Worker Agent. Execute the assigned task thoroughly. Provide complete, production-quality output. Include code, explanations, and any relevant details.`,
          parentGoal: goal,
          nodeGoal: node.goal,
          dependencyContext: depContext,
        });

        if (workerResult) {
          node.workerOutput = workerResult.output;
          node.status = 'completed';
          node.roundCompleted = this.currentRound;
          roundTokens += workerResult.tokens;
          bus.publish('goal.worker_completed', 'goal-orch', { goalId: node.id });
        } else {
          node.status = 'failed';
          roundFailures++;
          continue;
        }

        bus.publish('goal.critic_started', 'goal-orch', { goalId: node.id });
        const criticResult = await sharedCriticEvaluate({
          provider: this.provider,
          model: this.model,
          criticPrompt: SHARED_CRITIC_PROMPT,
          parentGoal: goal,
          nodeGoal: node.goal,
          workerOutput: node.workerOutput,
          logLabel: 'GoalOrchestrator',
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
                severity: 'medium',
                category: 'correctness',
                description: 'Critic evaluation failed',
                suggestion: 'Manual review needed',
              },
            ],
            summary: 'Critic evaluation failed.',
          };
        }
        bus.publish('goal.critic_completed', 'goal-orch', { goalId: node.id });
      }

      bus.publish('goal.manager_review', 'goal-orch', { round });
      const completed = collectAllNodes(goalTree).filter(
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
        })),
        null,
        'GoalOrchestrator',
      );

      if (reviewResult) {
        roundTokens += reviewResult.tokens;
        goalTree = applyReview(goalTree, reviewResult.data);
        const newSubGoals = Array.isArray(reviewResult.data?.newSubGoals)
          ? reviewResult.data.newSubGoals
          : [];
        for (const newSub of newSubGoals) {
          const newNode: GoalNode = {
            id: generateNodeId('goal'),
            goal: newSub.goal,
            parentId: null,
            status: 'pending',
            subGoals: [],
            dependencies: Array.isArray(newSub.dependencies) ? newSub.dependencies : [],
          };
          goalTree.push(newNode);
        }
      }

      totalTokensUsed += roundTokens;

      if (roundFailures > 0 && roundTokens === 0) {
        consecutiveFailedRounds++;
      } else {
        consecutiveFailedRounds = 0;
      }

      if (consecutiveFailedRounds >= MAX_CONSECUTIVE_FAILURES) {
        getGlobalLogger().error(
          'GoalOrchestrator',
          `Stopping after ${consecutiveFailedRounds} consecutive failed rounds (LLM calls failing)`,
        );
        break;
      }

      const allNodes = collectAllNodes(goalTree);
      const currentFindings = allNodes.reduce(
        (sum, n) => sum + (n.critique?.findings.length ?? 0),
        0,
      );

      const currentFindingsSet = computeFindingsFingerprint(allNodes);
      const resolvedFindings =
        prevFindingsSet !== null
          ? [...prevFindingsSet].filter((d) => !currentFindingsSet.has(d)).length
          : 0;
      const findingsNew =
        prevFindingsSet !== null
          ? [...currentFindingsSet].filter((d) => prevFindingsSet && !prevFindingsSet.has(d)).length
          : 0;

      const improvementRate = computeImprovementRate(prevFindingsSet, currentFindingsSet);

      if (improvementRate < 0.02) plateauRounds++;
      else plateauRounds = 0;

      const baseDecision = makeBaseDecision(
        round,
        totalTokensUsed,
        currentFindings,
        plateauRounds,
        allNodes,
        {
          budgetTokens: this.config.budgetTokens,
          maxRounds: this.config.maxRounds,
          mode: this.config.mode,
        },
      );

      // GoalOrchestrator-specific: judge check on stop_achieved
      let decision: { decision: RoundDecision; reason: string } = {
        decision: baseDecision.decision as RoundDecision,
        reason: baseDecision.reason,
      };

      if (baseDecision.decision === 'stop_achieved') {
        if (goal) {
          const output = allNodes
            .filter((n) => n.workerOutput)
            .map((n) => `[${n.goal.slice(0, 60)}]: ${n.workerOutput?.slice(0, 300) ?? ''}`)
            .join('\n');
          try {
            const goalJudge = getGoalJudge();
            if (this.provider) {
              goalJudge.setProvider(this.provider);
            }
            const verdict = await goalJudge.judge({
              runId: `goal-orch-${Date.now()}`,
              goal: goal,
              output: output || 'All sub-goals completed',
              evidenceCount: allNodes.filter((n) => n.status === 'completed').length,
            });

            if (!verdict.passed) {
              getGlobalLogger().warn('GoalOrchestrator', 'Judge rejected completion, continuing', {
                confidence: verdict.confidence,
                reasoning: verdict.reasoning.slice(0, 200),
              });
              decision = {
                decision: 'continue',
                reason: `Judge rejected completion (confidence ${(verdict.confidence * 100).toFixed(0)}%): ${verdict.reasoning.slice(0, 150)}`,
              };
            }
          } catch (err) {
            getGlobalLogger().debug(
              'GoalOrchestrator',
              'Judge check failed, allowing completion (best-effort)',
              { error: (err as Error).message },
            );
          }
        } else {
          getGlobalLogger().warn(
            'GoalOrchestrator',
            'makeDecision called without goal — judge protection skipped',
          );
        }
      }

      prevFindingsSet = currentFindingsSet;

      ledger.push({
        round,
        goalSnapshot: cloneTree(goalTree),
        findingsTotal: currentFindings,
        findingsResolved: resolvedFindings,
        findingsNew,
        improvementRate,
        tokensUsed: roundTokens,
        totalTokensUsed,
        decision: decision.decision,
        decisionReason: decision.reason,
        summary: `Round ${round}: ${decision.reason}`,
        timestamp: new Date().toISOString(),
      });

      bus.publish('goal.round_completed', 'goal-orch', { round, decision: decision.decision });

      this.checkpoint(goal, ledger, plateauRounds);

      if (decision.decision.startsWith('stop_')) break;
    }

    const elapsed = Date.now() - startTime;
    const finalAll = collectAllNodes(goalTree);
    const completedCount = finalAll.filter((n) => n.status === 'completed').length;
    const resultStatus =
      completedCount === finalAll.length && finalAll.length > 0
        ? 'completed'
        : completedCount > 0
          ? 'partial'
          : 'failed';

    if (resultStatus === 'completed') {
      this.clearCheckpoint();
    }

    return {
      goal,
      status: resultStatus,
      totalRounds: round,
      totalTokensUsed,
      totalDurationMs: elapsed,
      ledger,
      finalGoalTree: goalTree,
      summary: this.buildSummary(
        goal,
        resultStatus,
        round,
        completedCount,
        finalAll.length,
        ledger,
      ),
    };
  }

  private buildSummary(
    goal: string,
    status: GoalResult['status'],
    rounds: number,
    completed: number,
    total: number,
    ledger: RoundLedger[],
  ): string {
    const lastDecision = ledger.length > 0 ? ledger[ledger.length - 1].decision : 'none';
    const totalFindings = ledger.reduce((s, r) => s + r.findingsTotal, 0);
    return buildBaseSummary({
      goal,
      status,
      rounds,
      completed,
      total,
      extraLines: [
        `Total findings across all rounds: ${totalFindings}`,
        `Stop reason: ${lastDecision}`,
      ],
    });
  }
}
