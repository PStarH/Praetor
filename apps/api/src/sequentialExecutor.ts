/**
 * @deprecated Architecture V2 — createRealAgentExecutor() is disabled. Migrate
 * to POST /v1/runs for durable, worker-isolated execution.
 * The SequentialExecutor class itself is still used by the V2 evaluation
 * pipeline but should be backed by the kernel, not a process-level runtime.
 * Will be removed in v0.3.0.
 *
 * Sequential Pipeline Executor
 *
 * Implements the Sequential Orchestration Pattern from Microsoft's AI Agent Design Patterns.
 * Each step executes in order, with the output of one step becoming input to the next.
 */

import type {
  SequentialPipeline,
  SequentialPipelineRun,
  SequentialPipelineStatus,
  SequentialStep,
  SequentialStepResult,
  SequentialContext,
  SequentialEvent,
  SequentialEventHandler,
  TokenUsage,
  CommanderRunContextV2,
} from '@praetor/core';

/**
 * Agent executor function type.
 * Implementations provide the actual agent invocation logic.
 */
export type AgentExecutor = (input: {
  agentId: string;
  input: unknown;
  context: CommanderRunContextV2;
  timeoutMs?: number;
}) => Promise<{
  output: unknown;
  tokenUsage?: TokenUsage;
}>;

/**
 * Context provider for fetching Commander run context.
 */
export type RunContextProvider = (input: {
  projectId: string;
  agentId: string;
  missionId?: string;
}) => Promise<CommanderRunContextV2>;

/**
 * Configuration for the sequential executor.
 */
export interface SequentialExecutorConfig {
  /** Agent executor implementation */
  agentExecutor: AgentExecutor;
  /** Run context provider */
  runContextProvider: RunContextProvider;
  /** Event handlers */
  eventHandlers?: SequentialEventHandler[];
  /** Default timeout per step in milliseconds (default: 300000 = 5 min) */
  defaultStepTimeoutMs?: number;
  /** Default max retries per step (default: 0) */
  defaultMaxRetries?: number;
}

/**
 * State store for pipeline runs.
 */
export interface PipelineRunStore {
  get(runId: string): SequentialPipelineRun | undefined;
  set(run: SequentialPipelineRun): void;
  list(projectId: string): SequentialPipelineRun[];
}

/**
 * In-memory pipeline run store.
 */
export class InMemoryPipelineRunStore implements PipelineRunStore {
  private runs = new Map<string, SequentialPipelineRun>();

  get(runId: string): SequentialPipelineRun | undefined {
    return this.runs.get(runId);
  }

  set(run: SequentialPipelineRun): void {
    this.runs.set(run.id, run);
  }

  list(projectId: string): SequentialPipelineRun[] {
    return Array.from(this.runs.values()).filter((r) => r.projectId === projectId);
  }
}

/**
 * Sequential Pipeline Executor Engine
 */
export class SequentialExecutor {
  private agentExecutor: AgentExecutor;
  private runContextProvider: RunContextProvider;
  private eventHandlers: SequentialEventHandler[];
  private defaultStepTimeoutMs: number;
  private defaultMaxRetries: number;
  private runStore: PipelineRunStore;

  constructor(config: SequentialExecutorConfig, runStore?: PipelineRunStore) {
    this.agentExecutor = config.agentExecutor;
    this.runContextProvider = config.runContextProvider;
    this.eventHandlers = config.eventHandlers ?? [];
    this.defaultStepTimeoutMs = config.defaultStepTimeoutMs ?? 300000;
    this.defaultMaxRetries = config.defaultMaxRetries ?? 0;
    this.runStore = runStore ?? new InMemoryPipelineRunStore();
  }

  /**
   * Execute a sequential pipeline.
   */
  async execute<TInput = unknown, TOutput = unknown>(
    pipeline: SequentialPipeline<TInput, TOutput>,
    options?: {
      input?: TInput;
      metadata?: Record<string, unknown>;
    },
  ): Promise<SequentialPipelineRun> {
    const runId = `${pipeline.id}-run-${Date.now()}`;
    const startedAt = new Date().toISOString();

    // Initialize context
    const context: SequentialContext = {
      pipelineId: pipeline.id,
      projectId: pipeline.projectId,
      startedAt,
      currentStepIndex: 0,
      totalSteps: pipeline.steps.length,
      stepResults: new Map(),
      metadata: options?.metadata,
    };

    // Initialize run
    const run: SequentialPipelineRun = {
      id: runId,
      pipelineId: pipeline.id,
      projectId: pipeline.projectId,
      status: 'PENDING',
      context,
      results: [],
      startedAt,
    };

    this.runStore.set(run);

    // Emit pipeline started event
    await this.emitEvent({
      type: 'PIPELINE_STARTED',
      pipelineId: pipeline.id,
      runId,
      projectId: pipeline.projectId,
    });

    try {
      // Update status to running
      run.status = 'RUNNING';
      this.runStore.set(run);

      // Get initial input
      let currentInput: unknown = options?.input ?? pipeline.initialInput;

      // Execute steps sequentially
      for (let i = 0; i < pipeline.steps.length; i++) {
        // Re-fetch run status from store (may have been cancelled externally)
        const currentRun = this.runStore.get(runId);
        if (currentRun?.status === 'CANCELLED') {
          break;
        }

        const step = pipeline.steps[i];
        context.currentStepIndex = i;

        // Execute step
        const result = await this.executeStep(
          step,
          currentInput,
          context,
          runId,
          pipeline.projectId,
        );

        run.results.push(result);
        context.stepResults.set(step.id, result);
        this.runStore.set(run);

        // Handle failure
        if (result.status === 'FAILED') {
          if (pipeline.stopOnError ?? true) {
            run.status = 'FAILED';
            run.error = result.error;
            break;
          }
        }

        // Update input for next step
        if (result.status === 'SUCCESS' && result.output !== undefined) {
          currentInput = result.output;
        }

        // Check global timeout
        if (pipeline.globalTimeoutMs) {
          const elapsed = Date.now() - new Date(startedAt).getTime();
          if (elapsed > pipeline.globalTimeoutMs) {
            run.status = 'FAILED';
            run.error = 'Global timeout exceeded';
            break;
          }
        }
      }

      // Mark completed if all steps succeeded
      if (run.status === 'RUNNING') {
        run.status = 'COMPLETED';
      }

      run.completedAt = new Date().toISOString();
      this.runStore.set(run);

      // Emit final event
      if (run.status === 'COMPLETED') {
        await this.emitEvent({
          type: 'PIPELINE_COMPLETED',
          pipelineId: pipeline.id,
          runId,
          results: run.results,
        });
      } else if (run.status === 'FAILED') {
        await this.emitEvent({
          type: 'PIPELINE_FAILED',
          pipelineId: pipeline.id,
          runId,
          error: run.error ?? 'Unknown error',
        });
      }

      return run;
    } catch (error) {
      run.status = 'FAILED';
      run.error = error instanceof Error ? error.message : 'Unknown error';
      run.completedAt = new Date().toISOString();
      this.runStore.set(run);

      await this.emitEvent({
        type: 'PIPELINE_FAILED',
        pipelineId: pipeline.id,
        runId,
        error: run.error,
      });

      return run;
    }
  }

  /**
   * Execute a single step.
   */
  private async executeStep<TInput, TOutput>(
    step: SequentialStep<TInput, TOutput>,
    input: unknown,
    context: SequentialContext,
    runId: string,
    projectId: string,
  ): Promise<SequentialStepResult> {
    const stepStartedAt = new Date().toISOString();
    const maxRetries = step.maxRetries ?? this.defaultMaxRetries;
    const timeoutMs = step.timeoutMs ?? this.defaultStepTimeoutMs;

    const result: SequentialStepResult = {
      stepId: step.id,
      status: 'RUNNING',
      startedAt: stepStartedAt,
      retryCount: 0,
    };

    // Emit step started event
    await this.emitEvent({
      type: 'STEP_STARTED',
      pipelineId: context.pipelineId,
      runId,
      stepId: step.id,
      stepIndex: context.currentStepIndex,
    });

    let lastError: string | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        result.retryCount = attempt;

        // Get run context for agent
        const runContext = await this.runContextProvider({
          projectId,
          agentId: step.agentId,
        });

        // Apply input transformation if provided
        let stepInput = input as TInput;
        if (step.inputTransform) {
          stepInput = step.inputTransform(stepInput, context);
        }

        // Execute agent with timeout
        const agentResult = await this.executeWithTimeout(
          this.agentExecutor({
            agentId: step.agentId,
            input: stepInput,
            context: runContext,
            timeoutMs,
          }),
          timeoutMs,
        );

        // Apply output transformation if provided
        let output = agentResult.output as TOutput;
        if (step.outputTransform) {
          output = step.outputTransform(output, context);
        }

        // Success
        result.status = 'SUCCESS';
        result.output = output;
        result.completedAt = new Date().toISOString();
        result.tokenUsage = agentResult.tokenUsage;

        await this.emitEvent({
          type: 'STEP_COMPLETED',
          pipelineId: context.pipelineId,
          runId,
          stepId: step.id,
          result,
        });

        return result;
      } catch (error) {
        lastError = error instanceof Error ? error.message : 'Unknown error';
        result.error = lastError;

        // Retry if allowed
        if (attempt < maxRetries) {
          // Wait before retry (exponential backoff)
          await this.sleep(Math.pow(2, attempt) * 1000);
        }
      }
    }

    // All retries exhausted
    result.status = 'FAILED';
    result.completedAt = new Date().toISOString();
    result.error = lastError;

    await this.emitEvent({
      type: 'STEP_FAILED',
      pipelineId: context.pipelineId,
      runId,
      stepId: step.id,
      error: result.error ?? 'Unknown error',
    });

    // Return result based on continueOnError
    if (step.continueOnError) {
      result.status = 'SKIPPED';
    }

    return result;
  }

  /**
   * Execute with timeout.
   */
  private async executeWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    return Promise.race([
      promise.finally(() => clearTimeout(timer)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Step timeout exceeded')), timeoutMs);
      }),
    ]);
  }

  /**
   * Sleep utility.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Emit event to all handlers.
   */
  private async emitEvent(event: SequentialEvent): Promise<void> {
    for (const handler of this.eventHandlers) {
      try {
        await handler(event);
      } catch (e) {
        process.stderr.write(`[SequentialExecutor] Error: ${(e as Error)?.message ?? String(e)}\n`);
      }
    }
  }

  /**
   * Cancel a running pipeline.
   */
  cancel(runId: string, reason: string): SequentialPipelineRun | undefined {
    const run = this.runStore.get(runId);
    if (!run) return undefined;

    if (run.status === 'RUNNING') {
      run.status = 'CANCELLED';
      run.error = reason;
      run.completedAt = new Date().toISOString();
      this.runStore.set(run);

      this.emitEvent({
        type: 'PIPELINE_CANCELLED',
        pipelineId: run.pipelineId,
        runId,
        reason,
      });
    }

    return run;
  }

  /**
   * Get run status.
   */
  getRun(runId: string): SequentialPipelineRun | undefined {
    return this.runStore.get(runId);
  }

  /**
   * List runs for a project.
   */
  listRuns(projectId: string): SequentialPipelineRun[] {
    return this.runStore.list(projectId);
  }
}

/**
 * Compatibility shim retained for pipeline construction. Execution fails
 * closed because an API process cannot be a worker authority.
 */
export function createRealAgentExecutor(): AgentExecutor {
  return async () => {
    throw new Error(
      'LEGACY_EXECUTION_DISABLED: API pipeline execution was removed; use POST /v1/runs.',
    );
  };
}

/**
 * Create a default agent executor that logs and returns mock output.
 * Real implementations should integrate with actual agent systems.
 */
export function createMockAgentExecutor(): AgentExecutor {
  return async ({ agentId, input }) => {
    process.stdout.write(
      `[SequentialExecutor] MockAgentExecutor agent ${agentId} called with: ${JSON.stringify(input)}\n`,
    );

    // Simulate processing time
    await new Promise((resolve) => setTimeout(resolve, 100));

    return {
      output: {
        processed: true,
        agentId,
        timestamp: new Date().toISOString(),
        input,
      },
      tokenUsage: {
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
      },
    };
  };
}
