import { reportSilentFailure } from '../silentFailureReporter';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LLMProvider } from '../runtime/types';
import type { AgentRuntimeInterface } from '../runtime';
import type { DriveConfig, DriveStep, DriveState, DriveResult } from './types';
import { DEFAULT_DRIVE_CONFIG } from './types';
import { getMessageBus } from '../runtime/messageBus';
import { getGlobalLogger } from '../logging';
import { validateShape } from '../runtime/structuredOutput';
import { callLLMJSON } from '../runtime/llmJsonExtractor';

const PLAN_PROMPT = `You are a Drive Planner. Break the following goal into a sequence of concrete, actionable steps.

Each step must be:
- Specific: a single unit of work
- Achievable: can be completed in one execution pass
- Verifiable: success/failure is clear

Output ONLY valid JSON with no markdown formatting:

{
  "steps": [
    { "description": "Step 1: what to do" },
    { "description": "Step 2: what to do" }
  ],
  "reasoning": "why this plan"
}`;

const REPLAN_PROMPT = `You are a Drive Replanner. The following steps failed or are blocked. Re-plan the remaining work.

Failed steps show errors. Pending steps haven't been attempted yet.
Output a revised plan for the remaining work.

Output ONLY valid JSON with no markdown formatting:

{
  "steps": [
    { "description": "Revised step 1" },
    { "description": "Revised step 2" }
  ],
  "reasoning": "why this revised plan"
}`;

const WORKER_PROMPT = `You are a Drive Worker Agent. You have access to tools for file system operations, command execution, and web search.

Execute the assigned step thoroughly. Make real changes to the codebase or system as needed.
Provide a clear summary of what was done.`;

interface PlanOutput {
  steps: Array<{ description: string }>;
  reasoning: string;
}

let stepCounter = 0;
function generateStepId(): string {
  return `step_${Date.now()}_${++stepCounter}`;
}

export class DriveOrchestrator {
  private provider: LLMProvider;
  private runtime: AgentRuntimeInterface | null;
  private config: DriveConfig;
  private model: string;
  private state!: DriveState;

  constructor(
    provider: LLMProvider,
    runtime?: AgentRuntimeInterface | null,
    config?: Partial<DriveConfig>,
  ) {
    this.provider = provider;
    this.runtime = runtime ?? null;
    this.config = { ...DEFAULT_DRIVE_CONFIG, ...config };
    this.model =
      this.config.model ??
      (provider as any).defaultModel ??
      (provider as any).config?.defaultModel ??
      'gpt-4o-mini';
    this.config.model = this.model;
    this.resetState('', 0);
    fs.mkdirSync(this.config.checkpointDir, { recursive: true });
  }

  async execute(goal: string): Promise<DriveResult> {
    const bus = getMessageBus();
    const startTime = Date.now();
    let totalTokensUsed = 0;

    bus.publish('drive.started', 'drive-orch', { goal, mode: this.config.mode });

    // Check for existing checkpoint
    const checkpoint = this.loadCheckpoint(goal);
    if (checkpoint) {
      this.state = checkpoint;
      if (this.config.verbose) {
        getGlobalLogger().info(
          'DriveOrchestrator',
          `Resumed from checkpoint: ${this.state.steps.filter((s) => s.status === 'completed').length}/${this.state.steps.length} steps done`,
        );
      }
    } else {
      // Plan: decompose goal into steps
      const plan = await this.planGoal(goal);
      if (!plan) {
        return this.buildResult(goal, 'failed', startTime, totalTokensUsed, []);
      }
      totalTokensUsed += plan.tokens;
      this.resetState(goal, startTime);
      this.state.steps = plan.data.steps.map((s) => ({
        id: generateStepId(),
        description: s.description,
        status: 'pending' as const,
        retryCount: 0,
        maxRetries: 3,
      }));
      this.saveCheckpoint();
    }

    // Execution loop
    let iteration = 0;
    const maxIterations = this.config.maxIterations;

    while (iteration < maxIterations) {
      iteration++;
      this.state.iteration = iteration;

      const allDone = this.state.steps.every((s) => s.status === 'completed');
      if (allDone) break;

      const hasBlocked = this.state.steps.some((s) => s.status === 'blocked');
      if (hasBlocked && iteration > 1) {
        // Re-plan remaining steps
        const replanResult = await this.replan();
        if (replanResult) {
          totalTokensUsed += replanResult.tokens;
          this.saveCheckpoint();
        }
      }

      // Find next step to execute (pending or failed with retries left)
      const step = this.state.steps.find(
        (s) => s.status === 'pending' || (s.status === 'failed' && s.retryCount < s.maxRetries),
      );
      if (!step) {
        // May have all completed, or all blocked
        break;
      }

      // Execute step
      step.status = 'running';
      bus.publish('drive.step_started', 'drive-orch', {
        stepId: step.id,
        description: step.description,
      });

      if (this.runtime) {
        // Execute with real tool access via AgentRuntimeInterface
        const agentResult = await this.executeWithRuntime(step, goal);
        if (agentResult) {
          step.agentResult = agentResult;
          totalTokensUsed += agentResult.totalTokenUsage.totalTokens;
          if (agentResult.status === 'success') {
            step.status = 'completed';
            step.result = agentResult.summary.slice(0, 2000);
          } else {
            step.status = 'failed';
            step.error = agentResult.error ?? 'Execution failed';
            step.retryCount++;
          }
        } else {
          step.status = 'failed';
          step.error = 'Runtime execution returned no result';
          step.retryCount++;
        }
      } else {
        // No runtime — execute with direct LLM call
        const result = await this.executeDirect(step, goal);
        if (result) {
          totalTokensUsed += result.tokens;
          step.status = 'completed';
          step.result = result.output;
        } else {
          step.status = 'failed';
          step.error = 'Direct execution failed';
          step.retryCount++;
        }
      }

      // If failed too many times, mark as blocked
      if (step.status === 'failed' && step.retryCount >= step.maxRetries) {
        step.status = 'blocked';
        bus.publish('drive.step_failed', 'drive-orch', {
          stepId: step.id,
          description: step.description,
        });
      }

      this.state.totalTokensUsed += step.agentResult?.totalTokenUsage.totalTokens ?? 0;
      bus.publish('drive.step_completed', 'drive-orch', {
        stepId: step.id,
        status: step.status,
      });

      this.saveCheckpoint();
    }

    // Determine final status
    const completed = this.state.steps.filter((s) => s.status === 'completed').length;
    const total = this.state.steps.length;
    const status =
      completed === total
        ? ('completed' as const)
        : completed > 0
          ? ('partial' as const)
          : ('failed' as const);

    bus.publish('drive.completed', 'drive-orch', {
      goal,
      status,
      iterations: iteration,
      stepsCompleted: completed,
      stepsTotal: total,
    });

    return this.buildResult(goal, status, startTime, this.state.totalTokensUsed, this.state.steps);
  }

  private async planGoal(goal: string): Promise<{ data: PlanOutput; tokens: number } | null> {
    const result = await callLLMJSON<PlanOutput>(
      this.provider,
      this.model,
      PLAN_PROMPT,
      `Goal: ${goal}`,
    );
    if (result && !validateShape(result.data, { steps: 'array', reasoning: 'string' })) {
      getGlobalLogger().warn('DriveOrchestrator', 'planGoal: LLM response failed shape validation');
      return null;
    }
    return result;
  }

  private async replan(): Promise<{ data: PlanOutput; tokens: number } | null> {
    const failedSteps = this.state.steps.filter(
      (s) => s.status === 'failed' || s.status === 'blocked',
    );
    const pendingSteps = this.state.steps.filter((s) => s.status === 'pending');
    const context = [
      'Goal: ' + this.state.goal,
      '',
      'Failed/blocked steps:',
      ...failedSteps.map((s) => `  - ${s.description}${s.error ? ': ' + s.error : ''}`),
      '',
      'Pending steps:',
      ...pendingSteps.map((s) => `  - ${s.description}`),
    ].join('\n');

    const result = await callLLMJSON<PlanOutput>(this.provider, this.model, REPLAN_PROMPT, context);
    if (result && !validateShape(result.data, { steps: 'array', reasoning: 'string' })) {
      getGlobalLogger().warn('DriveOrchestrator', 'replan: LLM response failed shape validation');
      return null;
    }
    return result;
  }

  private async executeWithRuntime(
    step: DriveStep,
    goal: string,
  ): Promise<Awaited<ReturnType<AgentRuntimeInterface['execute']>>> {
    if (!this.runtime) throw new Error('DriveRuntime not initialized');

    return this.runtime.execute({
      agentId: 'drive-worker',
      projectId: 'drive',
      goal: `[Drive] ${goal}\nStep: ${step.description}`,
      availableTools: [
        'read',
        'write',
        'edit',
        'glob',
        'grep',
        'bash',
        'lsp_diagnostics',
        'websearch',
        'webfetch',
      ],
      maxSteps: 15,
      tokenBudget: 32000,
      contextData: {},
    });
  }

  private async executeDirect(
    step: DriveStep,
    goal: string,
  ): Promise<{ output: string; tokens: number } | null> {
    try {
      const response = await this.provider.call({
        model: this.model,
        messages: [
          { role: 'system', content: WORKER_PROMPT },
          {
            role: 'user',
            content: `Goal: ${goal}\n\nStep: ${step.description}\n\nExecute this step.`,
          },
        ],
        temperature: 0.3,
        maxTokens: 4096,
      });
      return { output: response.content, tokens: response.usage?.totalTokens ?? 0 };
    } catch (err) {
      getGlobalLogger().error('DriveOrchestrator', 'Direct execution failed', err as Error);
      return null;
    }
  }

  // ========================================================================
  // State checkpointing
  // ========================================================================

  private resetState(goal: string, startTime: number): void {
    this.state = {
      goal,
      steps: [],
      currentStepIndex: 0,
      iteration: 0,
      startTime,
      lastCheckpoint: '',
      totalTokensUsed: 0,
    };
  }

  private checkpointPath(goal: string): string {
    const safe = goal.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
    return path.join(this.config.checkpointDir, `${safe}.json`);
  }

  private saveCheckpoint(): void {
    try {
      const cp = this.checkpointPath(this.state.goal);
      this.state.lastCheckpoint = new Date().toISOString();
      const tmp = cp + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf-8');
      fs.renameSync(tmp, cp);
    } catch (err) {
      getGlobalLogger().error('DriveOrchestrator', 'Checkpoint save failed', err as Error);
    }
  }

  private loadCheckpoint(goal: string): DriveState | null {
    try {
      const cp = this.checkpointPath(goal);
      if (!fs.existsSync(cp)) return null;
      const data = JSON.parse(fs.readFileSync(cp, 'utf-8'));
      return data as DriveState;
    } catch (err) {
      reportSilentFailure(err, 'driveOrchestrator:351');
      return null;
    }
  }

  // ========================================================================
  // Result builder
  // ========================================================================

  private buildResult(
    goal: string,
    status: DriveResult['status'],
    startTime: number,
    totalTokensUsed: number,
    steps: DriveStep[],
  ): DriveResult {
    const elapsed = Date.now() - startTime;
    const completed = steps.filter((s) => s.status === 'completed').length;
    const total = steps.length;
    const failed = steps.filter((s) => s.status === 'failed' || s.status === 'blocked');

    const lines = [
      `Goal: ${goal.slice(0, 120)}`,
      `Status: ${status}`,
      `Steps: ${completed}/${total} completed`,
      `Total tokens: ${totalTokensUsed.toLocaleString()}`,
    ];
    if (failed.length > 0) {
      lines.push(`Blocked: ${failed.map((s) => s.description).join(', ')}`);
    }

    return {
      goal,
      status,
      steps,
      totalIterations: this.state.iteration,
      totalDurationMs: elapsed,
      totalTokensUsed,
      summary: lines.join('\n'),
    };
  }
}
