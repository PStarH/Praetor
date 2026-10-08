/**
 * KernelStepExecutor — the concrete bridge between the shared execution kernel
 * and the AgentRuntime execution engine.
 *
 * Architecture V2 strangler migration: the worker-plane package defines a pure
 * `StepExecutor` interface with zero core imports. This class implements that
 * interface structurally (TypeScript structural typing) and maps kernel steps
 * to AgentRuntime.execute() calls.
 *
 * Lifecycle:
 *   1. WorkerService polls kernel.claimNextStep() → receives ClaimedStep
 *   2. WorkerService calls executor.execute(step, { signal, worker })
 *   3. KernelStepExecutor maps step.input → AgentExecutionContext
 *   4. AgentRuntime.execute() runs the full agent turn
 *   5. AgentExecutionResult is mapped back to step output
 *   6. WorkerService calls kernel.completeStep() or kernel.failStep()
 *
 * The executor is stateless and thread-safe; one instance can serve multiple
 * concurrent step executions. The runtime factory allows per-tenant runtime
 * isolation.
 */

import type { AgentRuntimeInterface } from './agentRuntimeInterface';
import type { AgentExecutionContext, AgentExecutionResult } from './types/execution';

/**
 * The input shape stored in a kernel step. This mirrors what the V1 Gateway
 * writes when submitting a run — the step.input field contains the agent
 * execution parameters.
 */
export interface KernelStepInput {
  /** The goal/task description for the agent. */
  goal: string;
  /** Agent identifier (e.g., 'coder', 'researcher', 'reviewer'). */
  agentId: string;
  /** Project context identifier. */
  projectId?: string;
  /** Optional provider override (e.g., 'openai', 'anthropic'). */
  provider?: string;
  /** Optional max steps for this execution. */
  maxSteps?: number;
  /** Optional token budget cap. */
  tokenBudget?: number;
  /** Additional tools to make available. */
  tools?: string[];
  /** Optional output schema for structured output validation. */
  outputSchema?: Record<string, unknown>;
  /** Agent definition version required for canonical agent steps. */
  definitionVersion: string;
  /** Provider snapshot (provider + model) required for reproducibility. */
  providerSnapshot: { provider: string; model: string };
}

/**
 * The output shape written back to the kernel step on completion.
 */
export interface KernelStepOutput {
  status: AgentExecutionResult['status'];
  summary: string;
  steps: AgentExecutionResult['steps'];
  totalTokenUsage: AgentExecutionResult['totalTokenUsage'];
  totalDurationMs: number;
  runId: string;
}

/**
 * ClaimedStep shape — structurally compatible with worker-plane's ClaimedStep.
 * Defined locally to avoid adding a worker-plane dependency to core.
 */
interface ClaimedStep {
  id: string;
  runId: string;
  tenantId: string;
  kind: string;
  version: number;
  attempt: number;
  input: Record<string, unknown>;
  lease: {
    workerId: string;
    token: string;
    fencingEpoch: number;
    expiresAt: string;
  };
}

/**
 * Execution context passed by WorkerService.
 */
interface ExecutorContext {
  signal: AbortSignal;
  worker: {
    id: string;
    kind: string;
    capabilities: string[];
  };
}

/**
 * Error class structurally compatible with worker-plane's WorkerExecutionError.
 */
export class KernelStepExecutorError extends Error {
  readonly options: {
    code?: string;
    retryable?: boolean;
    retryDelayMs?: number;
    details?: Record<string, unknown>;
  };

  constructor(
    message: string,
    options: {
      code?: string;
      retryable?: boolean;
      retryDelayMs?: number;
      details?: Record<string, unknown>;
    } = {},
  ) {
    super(message);
    this.name = 'KernelStepExecutorError';
    this.options = options;
  }
}

/**
 * Factory function that returns an AgentRuntime for a given tenant.
 * Allows per-tenant runtime isolation.
 */
export type RuntimeFactory = (tenantId: string) => AgentRuntimeInterface;

/**
 * Configuration for the executor.
 */
export interface KernelStepExecutorConfig {
  /** Default max steps if not specified in step input. */
  defaultMaxSteps?: number;
  /** Default token budget if not specified in step input. */
  defaultTokenBudget?: number;
  /** Default project ID if not specified in step input. */
  defaultProjectId?: string;
}

/**
 * Concrete StepExecutor that bridges kernel steps to AgentRuntime executions.
 *
 * Implements the worker-plane `StepExecutor` interface via structural typing.
 * No import from @praetor/worker-plane is needed — TypeScript accepts any
 * object with a compatible `execute` method.
 */
export class KernelStepExecutor {
  private readonly config: Required<KernelStepExecutorConfig>;

  constructor(
    private readonly runtimeFactory: RuntimeFactory,
    config: KernelStepExecutorConfig = {},
  ) {
    this.config = {
      defaultMaxSteps: config.defaultMaxSteps ?? 50,
      defaultTokenBudget: config.defaultTokenBudget ?? 100_000,
      defaultProjectId: config.defaultProjectId ?? 'default',
    };
  }

  /**
   * Execute a kernel step by mapping it to an AgentRuntime.execute() call.
   *
   * Returns the step output on success, or throws KernelStepExecutorError on
   * failure. The WorkerService catches the error and calls kernel.failStep().
   */
  async execute(
    step: ClaimedStep,
    context: ExecutorContext,
  ): Promise<Record<string, unknown> | undefined> {
    // Fail closed: an already-cancelled step is a decision, not a race — never
    // dispatch a run for it.
    if (context.signal.aborted) {
      throw this.abortError('Step aborted before execution');
    }

    const input = this.parseStepInput(step);
    const runtime = this.runtimeFactory(step.tenantId);

    // Build the execution context for AgentRuntime. The cancellation signal is
    // handed to the run lifecycle so an in-flight run cancels itself (and only
    // itself). The validated reproducibility metadata travels with the run.
    const ctx: AgentExecutionContext = {
      runId: step.runId,
      agentId: input.agentId,
      projectId: input.projectId ?? this.config.defaultProjectId,
      goal: input.goal,
      tenantId: step.tenantId,
      maxSteps: input.maxSteps ?? this.config.defaultMaxSteps,
      tokenBudget: input.tokenBudget ?? this.config.defaultTokenBudget,
      contextData: {
        agentState: {
          definitionVersion: input.definitionVersion,
          providerSnapshot: input.providerSnapshot,
        },
      },
      availableTools: input.tools ?? [],
      abortSignal: context.signal,
      ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}),
    };

    // Await the run itself — no Promise.race — so cancellation only surfaces
    // ABORTED once the underlying execution has actually exited and a retry
    // cannot overlap it.
    let abortedDuringRun = false;
    const onAbort = () => {
      abortedDuringRun = true;
    };
    context.signal.addEventListener('abort', onAbort, { once: true });

    try {
      const result = await runtime.execute(ctx);

      if (abortedDuringRun) throw this.abortError('Step aborted during execution');

      return this.mapResult(result);
    } catch (error) {
      if (error instanceof KernelStepExecutorError) throw error;
      if (abortedDuringRun) throw this.abortError('Step aborted during execution');

      const message = error instanceof Error ? error.message : String(error);
      const isRetryable = this.isRetryableError(error);
      throw new KernelStepExecutorError(message, {
        code: 'EXECUTOR_FAILED',
        retryable: isRetryable,
        retryDelayMs: isRetryable ? 5_000 : undefined,
        details: { stepId: step.id, runId: step.runId, attempt: step.attempt },
      });
    } finally {
      context.signal.removeEventListener('abort', onAbort);
    }
  }

  private abortError(message: string): KernelStepExecutorError {
    return new KernelStepExecutorError(message, {
      code: 'ABORTED',
      retryable: true,
      retryDelayMs: 1000,
    });
  }

  /**
   * Parse and validate the kernel step input.
   */
  private parseStepInput(step: ClaimedStep): KernelStepInput {
    const input = step.input as Partial<KernelStepInput>;

    if (!input.goal || typeof input.goal !== 'string') {
      throw new KernelStepExecutorError(`Step ${step.id} missing required field: goal`, {
        code: 'INVALID_INPUT',
        retryable: false,
      });
    }

    if (!input.agentId || typeof input.agentId !== 'string') {
      throw new KernelStepExecutorError(`Step ${step.id} missing required field: agentId`, {
        code: 'INVALID_INPUT',
        retryable: false,
      });
    }

    if (!input.definitionVersion || typeof input.definitionVersion !== 'string') {
      throw new KernelStepExecutorError(
        `Step ${step.id} missing required field: definitionVersion`,
        { code: 'INVALID_INPUT', retryable: false },
      );
    }

    const snapshot = input.providerSnapshot as unknown;
    if (
      !snapshot ||
      typeof snapshot !== 'object' ||
      Array.isArray(snapshot) ||
      typeof (snapshot as { provider?: unknown }).provider !== 'string' ||
      typeof (snapshot as { model?: unknown }).model !== 'string'
    ) {
      throw new KernelStepExecutorError(
        `Step ${step.id} missing required field: providerSnapshot`,
        { code: 'INVALID_INPUT', retryable: false },
      );
    }

    return input as KernelStepInput;
  }

  /**
   * Map AgentExecutionResult to kernel step output.
   */
  private mapResult(result: AgentExecutionResult): Record<string, unknown> {
    const output: KernelStepOutput = {
      status: result.status,
      summary: result.summary,
      steps: result.steps,
      totalTokenUsage: result.totalTokenUsage,
      totalDurationMs: result.totalDurationMs,
      runId: result.runId,
    };
    return output as unknown as Record<string, unknown>;
  }

  /**
   * Determine if an error is retryable (transient failures).
   */
  private isRetryableError(error: unknown): boolean {
    if (error instanceof Error) {
      const message = error.message.toLowerCase();
      // Network/timeout errors are retryable
      if (
        message.includes('timeout') ||
        message.includes('etimedout') ||
        message.includes('econnreset')
      )
        return true;
      if (message.includes('rate limit') || message.includes('429') || message.includes('503'))
        return true;
      // Provider errors that might succeed on retry
      if (message.includes('overloaded') || message.includes('temporary')) return true;
    }
    return false;
  }
}
