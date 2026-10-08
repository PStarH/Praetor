/**
 * Public types for the Commander Agent SDK.
 *
 * Defines the stable, versioned API surface. All types here are part of
 * the SDK contract — breaking changes require a major version bump.
 */

// ============================================================================
// Client Configuration
// ============================================================================

/** Configuration for creating a CommanderClient. */
export interface CommanderClientConfig {
  /** API key for the LLM provider. Defaults to env vars (OPENAI_API_KEY, etc.). */
  apiKey?: string;
  /** LLM provider type ('openai', 'anthropic', 'google', etc.). Auto-detected from env if omitted. */
  provider?: string;
  /** Model identifier. Auto-selected if omitted. */
  model?: string;
  /** Max token budget for execution. Default: 64000. */
  tokenBudget?: number;
  /** Base URL for the provider API (for self-hosted/compatible APIs). */
  baseUrl?: string;
  /** Default topology to use for all executions. Default: SINGLE. */
  defaultTopology?: Topology;
  /** Whether to persist session history. Default: true. */
  persistSessions?: boolean;
}

// ============================================================================
// Execution Results
// ============================================================================

/** Final status of a Commander execution. */
export type ExecutionStatus = 'SUCCESS' | 'FAILED' | 'PARTIAL' | 'CANCELLED' | 'INTERRUPTED';

/** Result of a Commander execution. */
export interface ExecutionResult {
  /** Final status. */
  status: ExecutionStatus;
  /** Human-readable summary. */
  summary: string;
  /** Individual execution steps. */
  steps: ExecutionStepSummary[];
  /** Total tokens consumed. */
  totalTokenUsage: number;
  /** Total execution time in milliseconds. */
  totalDurationMs: number;
  /** Error message if failed. */
  error?: string;
  /** Run ID for tracing and resumption. */
  runId?: string;
}

/** Summary of a single execution step. */
export interface ExecutionStepSummary {
  stepNumber: number;
  action: string;
  status: string;
  tokenUsage: number;
  durationMs: number;
}

// ============================================================================
// Streaming Events
// ============================================================================

/** Types of execution events emitted during streaming. */
export type ExecutionEventType =
  | 'agent.started'
  | 'agent.completed'
  | 'agent.failed'
  | 'agent.message'
  | 'agent.interrupted'
  | 'tool.started'
  | 'tool.executed'
  | 'tool.completed'
  | 'tool.blocked'
  | 'system.alert'
  | 'output.delta'
  | 'output.completed'
  | 'reasoning.delta'
  | 'mission.updated';

/** Event emitted during streaming execution. */
export interface ExecutionEvent {
  type: ExecutionEventType;
  timestamp: string;
  data: Record<string, unknown>;
}

// ============================================================================
// Topology
// ============================================================================

/**
 * Execution topologies for Commander's multi-agent orchestration.
 *
 * - SINGLE: One agent, direct execution (fastest, lowest cost)
 * - SEQUENTIAL: Multiple agents in dependency chain
 * - PARALLEL: Multiple agents running concurrently
 * - HIERARCHICAL: Manager → Worker delegation
 * - HYBRID: Mix of parallel + sequential
 * - DEBATE: Multiple agents debate + converge on answer
 * - ENSEMBLE: Multiple agents vote on answer
 * - EVALUATOR_OPTIMIZER: Generator → Evaluator feedback loop
 */
export enum Topology {
  SINGLE = 'SINGLE',
  SEQUENTIAL = 'SEQUENTIAL',
  PARALLEL = 'PARALLEL',
  HIERARCHICAL = 'HIERARCHICAL',
  HYBRID = 'HYBRID',
  DEBATE = 'DEBATE',
  ENSEMBLE = 'ENSEMBLE',
  EVALUATOR_OPTIMIZER = 'EVALUATOR_OPTIMIZER',
}

// ============================================================================
// Agent Definition
// ============================================================================

/** Configuration for creating an Agent. */
export interface AgentConfig {
  /** Unique identifier for this agent. Default: auto-generated. */
  id?: string;
  /** Human-readable name. */
  name: string;
  /** Role/persona description for the system prompt. */
  role: string;
  /** Tools this agent can access. Default: all built-in read tools. */
  tools?: string[];
  /** Topology to use when this agent executes tasks. Default: SINGLE. */
  topology?: Topology;
  /** Effort level for scaling. Default: standard. */
  effort?: 'minimal' | 'low' | 'standard' | 'high' | 'maximum';
  /** Max tokens for this agent's executions. */
  tokenBudget?: number;
  /** Max steps per execution. Default: 10. */
  maxSteps?: number;
}

/** Stored agent state (for persistence and recovery). */
export interface AgentSnapshot {
  id: string;
  name: string;
  role: string;
  tools: string[];
  topology: Topology;
  runCount: number;
  totalTokensUsed: number;
  createdAt: string;
  lastRunAt?: string;
}

// ============================================================================
// Task Definition
// ============================================================================

/** A task to be executed by one or more agents. */
export interface Task {
  /** Task description / goal. */
  goal: string;
  /** Optional structured output schema. */
  outputSchema?: Record<string, unknown>;
  /** Optional context data to inject. */
  context?: Record<string, unknown>;
  /** Priority for scheduling. */
  priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  /** Deadline in ms from now. 0 = no deadline. */
  deadlineMs?: number;
  /** Whether this task can be executed as a batch (50% cost savings, 24h turnaround). */
  batchEligible?: boolean;
}

/** Task with execution metadata (after submission). */
export interface TaskHandle {
  id: string;
  task: Task;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  agentId: string;
  submittedAt: string;
  completedAt?: string;
  result?: ExecutionResult;
}

// ============================================================================
// Memory
// ============================================================================

/** Options for writing to memory. */
export interface MemoryWriteOptions {
  /** Importance score (0-1). Higher = more likely to be recalled. Default: 0.5. */
  importance?: number;
  /** Tags for categorical recall. */
  tags?: string[];
  /** Which memory layer to write to. Default: 'episodic'. */
  layer?: 'working' | 'episodic' | 'longterm';
}

/** Options for querying memory. */
export interface MemoryQueryOptions {
  /** Keywords for semantic search. */
  keywords?: string[];
  /** Minimum importance threshold. Default: 0.3. */
  importanceThreshold?: number;
  /** Maximum results. Default: 10. */
  limit?: number;
  /** Specific memory layer to query. Default: all layers. */
  layer?: 'working' | 'episodic' | 'longterm';
  /** Tags to filter by (AND logic). */
  tags?: string[];
}

/** A single memory item. */
export interface MemoryItem {
  id: string;
  content: string;
  layer: 'working' | 'episodic' | 'longterm';
  importance: number;
  tags: string[];
  createdAt: string;
  metadata?: Record<string, unknown>;
}

/** Memory statistics. */
export interface MemoryStats {
  workingCount: number;
  episodicCount: number;
  longTermCount: number;
  totalCount: number;
  oldestEntry: string;
  newestEntry: string;
}

// ============================================================================
// Sessions & System
// ============================================================================

/** Summary of an execution session (past or in-progress). */
export interface SessionSummary {
  runId: string;
  task: string;
  status: string;
  agentId: string;
  topology: Topology;
  tokenUsage: number;
  durationMs: number;
  timestamp: string;
  error?: string;
}

/** System status snapshot. */
export interface SystemStatus {
  provider: string;
  model: string;
  uptime: string;
  totalRuns: number;
  activeSessions: number;
  memoryUsage: number;
  topologyDefaults: Topology;
  agentCount: number;
}

// ============================================================================
// Reliability
// ============================================================================

/** Reliability engine statistics. */
export interface SDKReliabilityStats {
  circuitState: string;
  circuitFailures: number;
  dlqTotalEntries: number;
  pendingCompensations: number;
  checkpointCount: number;
}

// ============================================================================
// Tool Error Rows
// ============================================================================

/**
 * `SentryRow` mirrors `@praetor/core`'s canonical `SyntheticErrorRow`
 * so downstream SDK users can type their hook responses, gate results,
 * and recovery recorders against the runtime's exact contract — without
 * taking on a direct runtime dependency on `@praetor/core`.
 *
 * The alias is type-only (`import('@praetor/core').SyntheticErrorRow`);
 * the import is erased at compile time and ships zero runtime code from
 * `core` through the SDK.
 *
 * Field contract (closed schema — do not add optional fields):
 *   - `toolCallId`  — verbatim from originating ToolCall.id
 *   - `name`        — verbatim from originating ToolCall.name
 *   - `output`      — always `''` for error rows
 *   - `error`       — canonical error message
 *   - `durationMs`  — always `0` for synthetic rows; real measured rows
 *                     use the actual elapsed ms
 *
 * @see packages/core/src/runtime/toolResultShape.ts
 */
export type SentryRow = import('@praetor/core').SyntheticErrorRow;
