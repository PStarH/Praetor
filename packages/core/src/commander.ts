/**
 * Commander — Core Control Center
 *
 * The single entry point for Commander's multi-agent orchestration.
 * Handles environment probing, tier auto-detection, infrastructure wiring,
 * and execution lifecycle management.
 *
 * This is the recommended way to use Commander programmatically:
 *
 * @example
 * ```typescript
 * // Zero-config: auto-detects everything
 * const commander = await Commander.create();
 * const result = await commander.run('analyze this codebase');
 *
 * // With explicit config:
 * const commander = await Commander.create({
 *   provider: 'openai',
 *   apiKey: process.env.OPENAI_API_KEY,
 *   tier: 'team',
 * });
 * ```
 *
 * For remote/HTTP access, use @praetor/sdk's CommanderClient instead.
 */

import { probeEnvironment } from './commander/probe';
import { determineTier, resolveConfig } from './commander/tier';
import { createWiredRuntime } from './commander/factory';
import type { ProbeResult } from './commander/probe';
import type { CommanderOptions, DeploymentTier, ResolvedConfig } from './commander/tier';
import type { WiredRuntime } from './commander/factory';
import type { AgentRuntimeInterface, AgentExecutionResult } from './runtime';
import { getGlobalLogger } from './logging';
import { assessGovernanceRiskLevel } from './ultimate/riskAssessor';

// Re-export types for consumers
export type { ProbeResult } from './commander/probe';
export type { CommanderOptions, DeploymentTier, ResolvedConfig } from './commander/tier';

/**
 * Result of running a task through Commander.
 */
export interface CommanderResult {
  status: 'success' | 'failed' | 'partial' | 'cancelled' | 'interrupted' | 'waiting_for_human';
  summary: string;
  steps: Array<{
    stepNumber: number;
    type: string;
    content: string;
    durationMs: number;
  }>;
  tokenUsage: { promptTokens: number; completionTokens: number; totalTokens: number };
  durationMs: number;
  runId: string;
  error?: string;
}

/** Status snapshot returned by Commander.getStatus(). */
export interface CommanderStatus {
  tier: string;
  provider: string;
  model: string;
  uptime: string;
  features: string[];
  providerCount: number;
  ollamaAvailable: boolean;
  vllmAvailable: boolean;
  inKubernetes: boolean;
  redisAvailable: boolean;
}

export class Commander {
  private runtime: AgentRuntimeInterface;
  private config: ResolvedConfig;
  private probe: ProbeResult;
  private startTime: number;
  private disposed = false;

  private constructor(wired: WiredRuntime, config: ResolvedConfig, probe: ProbeResult) {
    this.runtime = wired.runtime;
    this.config = config;
    this.probe = probe;
    this.startTime = Date.now();
  }

  // ==========================================================================
  // Factory
  // ==========================================================================

  /**
   * Get a human-readable status summary. */
  getStatus(): CommanderStatus {
    return {
      tier: this.config.tier,
      provider: this.config.provider?.type ?? 'none',
      model: this.config.provider?.defaultModel ?? 'auto',
      uptime: `${Math.floor(this.uptimeMs / 1000)}s`,
      features: Object.entries(this.config.features)
        .filter(([, v]) => v)
        .map(([k]) => k),
      providerCount: this.probe.apiProviderCount,
      ollamaAvailable: this.probe.ollamaAvailable,
      vllmAvailable: this.probe.vllmAvailable,
      inKubernetes: this.probe.inKubernetes,
      redisAvailable: !!this.probe.redisUrl,
    };
  }

  // ==========================================================================
  // Factory
  // ==========================================================================

  /**
   * Create a Commander instance with full auto-detection.
   *
   * Probes the environment → determines the deployment tier → resolves
   * configuration → wires up the runtime → returns a ready-to-use instance.
   *
   * This is the primary entry point. Passing `options` overrides
   * auto-detected values.
   *
   * @example
   * ```typescript
   * // Hobbyist (local Ollama, no API keys needed)
   * const c = await Commander.create();
   *
   * // Team (OpenAI, file persistence)
   * const c = await Commander.create({ provider: 'openai' });
   *
   * // Enterprise (Redis, multi-tenant, K8s)
   * const c = await Commander.create({ tier: 'enterprise' });
   * ```
   */
  static async create(options?: CommanderOptions): Promise<Commander> {
    const logger = getGlobalLogger();

    // 1. Probe: detect what's available on the host
    const probe = await probeEnvironment();
    logger.info('Commander', 'Environment probed', {
      providers: probe.availableProviders.length,
      ollama: probe.ollamaAvailable,
      vllm: probe.vllmAvailable,
      redis: !!probe.redisUrl,
      docker: probe.dockerAvailable,
      k8s: probe.inKubernetes,
    });

    // 2. Determine: what tier does this deployment run in?
    const tier = determineTier(probe, options);
    logger.info('Commander', `Tier determined: ${tier}`);

    // 3. Resolve: compute the full configuration for this tier
    const config = resolveConfig(tier, probe, options);

    // Validate: ensure we have a usable provider
    if (!config.provider) {
      throw new Error(
        'No LLM provider available. ' +
          'Set an API key (OPENAI_API_KEY, ANTHROPIC_API_KEY, etc.) ' +
          'or start a local model (Ollama, vLLM).',
      );
    }

    // 4. Wire: create and configure the runtime
    const wired = await createWiredRuntime(config);

    return new Commander(wired, config, probe);
  }

  // ==========================================================================
  // Execution
  // ==========================================================================

  /**
   * Run a task through the full Commander pipeline.
   *
   * @param task - The task/goal to execute (e.g., "Fix all TypeScript errors")
   * @param agentId - Optional agent identifier (default: 'commander')
   * @param availableTools - Optional list of tool names to enable (default: all)
   */
  async run(
    task: string,
    agentId: string = 'commander',
    availableTools?: string[],
  ): Promise<CommanderResult> {
    this.ensureActive();

    const result: AgentExecutionResult = await this.runtime.execute({
      projectId: 'commander',
      agentId,
      goal: task,
      contextData: {
        // Risk is measured from the goal, never asserted. This used to be a
        // hardcoded `'LOW'`, which made telosOrchestrator compute
        // `requiresApproval: false` for every goal — see assessGovernanceRiskLevel.
        governanceProfile: { riskLevel: assessGovernanceRiskLevel(task, availableTools ?? []) },
      },
      availableTools: availableTools ?? [],
      maxSteps: this.config.runtime.maxStepsPerRun ?? 20,
      tokenBudget: this.config.runtime.budgetHardCapTokens ?? 64000,
    });

    return this.formatResult(result);
  }

  /**
   * Plan a task without executing (deliberation + task decomposition only).
   */
  async plan(task: string): Promise<unknown> {
    const { deliberate } = await import('./ultimate/index');
    return deliberate(task);
  }

  // ==========================================================================
  // Introspection
  // ==========================================================================

  /** Get the detected deployment tier. */
  get tier(): DeploymentTier {
    return this.config.tier;
  }

  /** Get the resolved configuration. */
  get resolvedConfig(): Readonly<ResolvedConfig> {
    return this.config;
  }

  /** Get the environment probe results. */
  get probeResult(): Readonly<ProbeResult> {
    return this.probe;
  }

  /** Get the underlying AgentRuntime (for advanced usage). */
  getRuntime(): AgentRuntimeInterface {
    return this.runtime;
  }

  /** Get uptime in milliseconds. */
  get uptimeMs(): number {
    return Date.now() - this.startTime;
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /**
   * Gracefully shut down the Commander instance.
   * Cancels in-flight steps, flushes buffers, and releases resources.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.runtime.cancelAllSteps();
    this.disposed = true;
  }

  private ensureActive(): void {
    if (this.disposed) {
      throw new Error(
        'Commander instance has been disposed. Create a new one with Commander.create().',
      );
    }
  }

  // ==========================================================================
  // Internal
  // ==========================================================================

  private formatResult(result: AgentExecutionResult): CommanderResult {
    return {
      status: result.status,
      summary: result.summary ?? `Execution ${result.status}`,
      steps: (result.steps ?? []).map((s: AgentExecutionResult['steps'][number]) => ({
        stepNumber: s.stepNumber,
        type: s.type,
        content: s.content?.slice(0, 500) ?? '',
        durationMs: s.durationMs,
      })),
      tokenUsage: result.totalTokenUsage ?? {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      },
      durationMs: result.totalDurationMs,
      runId: result.runId,
      error: result.error,
    };
  }
}
