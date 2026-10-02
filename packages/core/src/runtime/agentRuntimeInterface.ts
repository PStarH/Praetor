/**
 * AgentRuntimeInterface — stable public surface of the runtime execution engine.
 *
 * This interface decouples consumers (orchestration, tools, CLI, drive, actors,
 * showcase, telos, MCP) from the concrete 3,300-line AgentRuntime class.  Only
 * the places that actually construct an AgentRuntime should import the class;
 * everyone else should depend on this interface.
 */
import type {
  AgentExecutionContext,
  AgentExecutionResult,
  AgentRuntimeConfig,
  LLMProvider,
  Tool,
} from './types';
import type { MemoryStore } from '../episodicMemory';
import type { StateCheckpointer } from './stateCheckpointer';
import type { AgentInbox } from './agentInbox';
import type { TeamRegistry } from './teamRegistry';
import type { AgentHandoff } from './agentHandoff';
import type { CompensationRegistry } from './compensationRegistry';
import type { ReliabilityEngine } from './reliabilityEngine';
import type { StepTimeoutManager } from './stepTimeoutManager';
import type { RunRecoveryResult } from './runRecovery';
import type { SingleFlightStats } from './singleFlightRequestCache';
import type { GeminiCacheStats } from './geminiCacheManager';
import type { SemanticCacheStats } from './semanticCache';
import type { HistoricalTaskCost } from './costEstimator';
import type { SmartModelRouter } from './smartModelRouter';
import type { ExecutionScheduler } from '../atr/scheduler';

export interface AgentRuntimeInterface {
  /** Execute one full agent turn: model routing → tool selection → LLM call → tool execution → verification → retry. */
  execute(ctx: AgentExecutionContext): Promise<AgentExecutionResult>;

  /** Register an LLM provider by name. */
  registerProvider(name: string, provider: LLMProvider): void;

  /** Register a tool by name. */
  registerTool(name: string, tool: Tool): void;

  /** Retrieve a registered provider. */
  getProvider(name: string): LLMProvider | undefined;

  /** Retrieve the first available provider or preferred one if registered. */
  getFirstAvailableProvider(preferredName?: string): LLMProvider | undefined;

  /** Retrieve the smart model router if enabled. */
  getSmartRouter(): SmartModelRouter | null;

  /** Retrieve a registered tool. */
  getTool(name: string): Tool | undefined;

  /** Return a snapshot of the runtime configuration. */
  getConfig(): AgentRuntimeConfig;

  /** Access the persistent memory store or null if using default in-memory storage. */
  getMemoryStore(): MemoryStore | null;

  /** Access the state checkpointer for crash recovery and run inspection. */
  getCheckpointer(): StateCheckpointer;

  /** Access the agent inbox. */
  getInbox(): AgentInbox;

  /** Access the team registry. */
  getTeamRegistry(): TeamRegistry;

  /** Access the agent handoff subsystem. */
  getHandoff(): AgentHandoff;

  /** Access the global execution scheduler. */
  getExecutionScheduler(): ExecutionScheduler;

  /** Access the compensation registry for rollback planning. */
  getCompensationRegistry(): CompensationRegistry;

  /** Access the unified reliability engine (circuit breaker, DLQ, compensation, checkpointer). */
  getReliabilityEngine(): ReliabilityEngine;

  /** Cancel all in-flight steps managed by the StepTimeoutManager. */
  cancelAllSteps(): number;

  /** Access the step timeout manager for shutdown coordination. */
  getStepTimeoutManager(): StepTimeoutManager;

  /** List runs with non-terminal checkpoints. */
  listUnfinishedRuns(): Array<{ runId: string; phase: string; timestamp: string }>;

  /** Resume a crashed run using the full RunRecovery pipeline. */
  resume(runId: string, tenantId?: string): Promise<RunRecoveryResult | null>;

  /** List all runs that have recoverable checkpoints. */
  listResumableRuns(): Array<{ runId: string; phase: string; timestamp: string }>;

  /** Signal a running execution to pause at the next checkpoint boundary. */
  pauseRun(runId: string): boolean;

  /** Clear the pause flag for a run. */
  unpauseRun(runId: string): void;

  /** Check whether a run is currently paused. */
  isPaused(runId: string): boolean;

  /** List all active runs with their pause state and checkpoint phase. */
  getActiveRuns(): Array<{ runId: string; paused: boolean; checkpointPhase?: string }>;

  /** Return the number of currently active runs. */
  getActiveRunCount(): number;

  /** Check whether a given runId is active. */
  isRunActive(runId: string): boolean;

  /** Return semantic cache statistics. */
  getSemanticCacheStats(): SemanticCacheStats;

  /** Return single-flight request cache statistics. */
  getSingleFlightStats(): SingleFlightStats;

  /** Return Gemini cachedContent statistics. */
  getGeminiCacheStats(): GeminiCacheStats;

  /** Return cost estimator history. */
  getCostEstimatorHistory(): HistoricalTaskCost[][];

  /** Return per-provider health snapshot for the dashboard. */
  getProviderHealth(): Array<{
    provider: string;
    state: string;
    errorRate: number;
    requestCount: number;
    lastFailureAt: number;
  }>;

  /** Return the names of all registered tools (used by HTTP server capability probe). */
  listToolNames(): string[];

  /** Dispose sub-resources (timers, file handles) when this runtime is discarded. */
  dispose(): void;
}
