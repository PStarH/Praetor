/**
 * Extracted from UltimateOrchestrator to shrink the god object.
 *
 * Responsible for triggering structured checkpoints during ultimate execution.
 * Runs an independent LLM call outside the main agent's attention to write
 * a checkpoint.md snapshot when token budget thresholds are crossed.
 */
import type { TaskTreeNode, ExecutionError, UltimateOrchestratorConfig } from './types';
import type { AgentRuntimeInterface } from '../runtime';
import { flattenTree } from './taskTreeUtils';
import { getCheckpointWriter } from '../runtime/checkpointWriter';
import { getGlobalLogger } from '../logging';

export interface CheckpointManagerDeps {
  config: UltimateOrchestratorConfig;
  runtime: AgentRuntimeInterface;
  sumTokenUsage: (taskTree: TaskTreeNode) => number;
}

export class CheckpointManager {
  constructor(private readonly deps: CheckpointManagerDeps) {}

  /**
   * Trigger a checkpoint if the token budget threshold has been crossed.
   * Builds a structured checkpoint from the current execution state and
   * writes it via an independent LLM call.
   *
   * This runs OUTSIDE the main agent's attention — the main execution loop
   * does not block on checkpoint completion.
   */
  async maybeCheckpoint(
    execId: string,
    taskTree: TaskTreeNode,
    params: { goal: string; contextData?: Record<string, unknown> },
    errors: ExecutionError[],
    reasoning: string[],
  ): Promise<void> {
    try {
      const hardCap = this.deps.config.defaultBudget.hardCapTokens;
      if (hardCap <= 0) return;

      const tokensUsed = this.deps.sumTokenUsage(taskTree);
      const writer = getCheckpointWriter();

      const trigger = writer.shouldTrigger(execId, tokensUsed, hardCap);
      if (!trigger) return;

      // Build checkpoint data from current execution state
      const completedNodes = flattenTree(taskTree).filter(
        (n) => n.status === 'COMPLETED' && n.result,
      );
      const pendingNodes = flattenTree(taskTree).filter(
        (n) => n.status !== 'COMPLETED' && n.status !== 'FAILED',
      );
      const failedNodes = flattenTree(taskTree).filter((n) => n.status === 'FAILED');

      // Extract key decisions from reasoning
      const decisions = reasoning.filter(
        (r) =>
          r.includes('Topology:') ||
          r.includes('Effort level:') ||
          r.includes('Confidence:') ||
          r.includes('Budget:') ||
          r.includes('Synthesis quality:') ||
          r.includes('Shadow'),
      );

      // Extract file paths from available context data
      const filesRead: string[] = [];
      const filesModified: string[] = [];
      if (params.contextData?.availableTools) {
        filesRead.push(
          ...(Array.isArray(params.contextData.filesRead)
            ? (params.contextData.filesRead as string[])
            : []),
        );
        filesModified.push(
          ...(Array.isArray(params.contextData.filesModified)
            ? (params.contextData.filesModified as string[])
            : []),
        );
      }

      // Collect recent messages from the execution context
      const recentMessages: Array<{ role: string; content: string }> = [];
      for (const node of completedNodes.slice(-3)) {
        if (node.result) {
          recentMessages.push({ role: 'assistant', content: node.result.slice(0, 200) });
        }
      }

      // Resolve a provider (use first available, same as deliberation)
      const provider =
        this.deps.runtime.getFirstAvailableProvider?.() ??
        this.deps.runtime.getProvider('openai') ??
        this.deps.runtime.getProvider('anthropic') ??
        this.deps.runtime.getProvider('openrouter') ??
        this.deps.runtime.getProvider('mimo') ??
        this.deps.runtime.getProvider('deepseek') ??
        this.deps.runtime.getProvider('glm') ??
        this.deps.runtime.getProvider('xiaomi') ??
        this.deps.runtime.getProvider('google');

      const result = await writer.writeCheckpoint(
        {
          runId: execId,
          goal: params.goal,
          phase: pendingNodes.length > 0 ? 'executing' : 'synthesis',
          stepNumber: completedNodes.length,
          completedSubtasks: completedNodes.map((n) => ({
            id: n.id,
            goal: n.goal.slice(0, 200),
            result: n.result?.slice(0, 300) ?? '',
            tokensUsed: n.tokenUsage?.totalTokens ?? 0,
            durationMs: 0,
          })),
          pendingSubtasks: pendingNodes.map((n) => ({
            id: n.id,
            goal: n.goal.slice(0, 200),
            estimatedTokens:
              n.context.estimatedTokens ?? Math.ceil(hardCap / Math.max(1, pendingNodes.length)),
          })),
          failedSubtasks: failedNodes.map((n) => ({
            id: n.id,
            goal: n.goal.slice(0, 200),
            error: n.result?.slice(0, 200) ?? 'Unknown error',
          })),
          keyDecisions: decisions,
          filesRead,
          filesModified,
          errors: errors.map((e) => ({
            nodeId: e.nodeId,
            message: e.message.slice(0, 150),
            recovered: e.recovered,
          })),
          tokensUsed,
          tokensHardCap: hardCap,
          recentMessages,
          trigger,
        },
        provider ?? undefined,
      );

      reasoning.push(
        `Checkpoint v${result.version}: ${trigger.percent}% budget (${result.completedCount} done, ${result.pendingCount} pending, ${result.failedCount} failed)`,
      );
    } catch (e) {
      getGlobalLogger().debug('UltimateOrchestrator', 'Checkpoint trigger failed', {
        error: (e as Error)?.message,
      });
    }
  }
}
