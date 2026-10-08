/**
 * @praetor/plugin-sdk — Type-safe Hook Handlers
 *
 * Provides strongly-typed handler functions for all 19 Commander hook points.
 * Plugin authors get full IntelliSense without needing to know internal types.
 */

import type {
  BeforeToolCallContext,
  AfterToolCallContext,
  BeforeLLMCallContext,
  AfterLLMCallContext,
  AgentStartContext,
  AgentCompleteContext,
  ErrorContext,
  ToolResolveContext,
  ToolTimeoutContext,
  ToolRetryContext,
  ContextCompactionContext,
  SessionForkContext,
  SessionArchiveContext,
  StepLifecycleContext,
  BackendSelectContext,
  HookPoint,
} from './types';

// ============================================================================
// Typed Hook Handler Signatures
// ============================================================================

/**
 * Called before a tool is executed.
 * Return a ToolResult to block/override the tool call.
 * Return null/void to allow normal execution.
 */
export type BeforeToolCallHandler = (ctx: BeforeToolCallContext) =>
  | Promise<{
      toolCallId: string;
      name: string;
      output: string;
      error?: string;
      durationMs: number;
    } | null | void>
  | { toolCallId: string; name: string; output: string; error?: string; durationMs: number }
  | null
  | void;

/** Called after a tool completes. Can modify the result. */
export type AfterToolCallHandler = (
  ctx: AfterToolCallContext,
) => Promise<AfterToolCallContext | void> | AfterToolCallContext | void;

/** Called before an LLM call. Can modify the request. */
export type BeforeLLMCallHandler = (
  ctx: BeforeLLMCallContext,
) => Promise<BeforeLLMCallContext | void> | BeforeLLMCallContext | void;

/** Called after an LLM call. Can inspect/modify the response. */
export type AfterLLMCallHandler = (
  ctx: AfterLLMCallContext,
) => Promise<AfterLLMCallContext | void> | AfterLLMCallContext | void;

/** Called when an agent starts execution. */
export type AgentStartHandler = (ctx: AgentStartContext) => Promise<void> | void;

/** Called when an agent completes execution. */
export type AgentCompleteHandler = (ctx: AgentCompleteContext) => Promise<void> | void;

/** Called when an error occurs in the pipeline. */
export type ErrorHandler = (ctx: ErrorContext) => Promise<void> | void;

/** Called before resolving a tool from the registry. Return non-null to block. */
export type BeforeToolResolveHandler = (ctx: ToolResolveContext) =>
  | Promise<{
      toolCallId: string;
      name: string;
      output: string;
      error?: string;
      durationMs: number;
    } | null | void>
  | { toolCallId: string; name: string; output: string; error?: string; durationMs: number }
  | null
  | void;

/** Called after tool resolution. Tool may be not found. */
export type AfterToolResolveHandler = (ctx: ToolResolveContext) => Promise<void> | void;

/** Called when a tool execution times out. */
export type ToolTimeoutHandler = (ctx: ToolTimeoutContext) => Promise<void> | void;

/** Called before retrying a failed tool call. */
export type ToolRetryHandler = (ctx: ToolRetryContext) => Promise<void> | void;

/** Called before context compaction. */
export type BeforeContextCompactionHandler = (
  ctx: ContextCompactionContext,
) => Promise<void> | void;

/** Called after context compaction. */
export type AfterContextCompactionHandler = (ctx: ContextCompactionContext) => Promise<void> | void;

/** Called when a sub-agent session is forked. */
export type SessionForkHandler = (ctx: SessionForkContext) => Promise<void> | void;

/** Called when a session state is checkpointed. */
export type SessionArchiveHandler = (ctx: SessionArchiveContext) => Promise<void> | void;

/** Called when a single execution step starts. */
export type StepStartHandler = (ctx: StepLifecycleContext) => Promise<void> | void;

/** Called when a single execution step completes. */
export type StepCompleteHandler = (ctx: StepLifecycleContext) => Promise<void> | void;

/** Called before execution backend is selected. Return a string to override. */
export type BeforeBackendSelectHandler = (
  ctx: BackendSelectContext,
) => Promise<string | null | void> | string | null | void;

/** Called after execution backend is selected. */
export type AfterBackendSelectHandler = (ctx: BackendSelectContext) => Promise<void> | void;

// ============================================================================
// Discriminated Hook Map — maps HookPoint to its handler type
// ============================================================================

/**
 * Maps a HookPoint string to its corresponding handler function type.
 * Use this for type-safe hook subscription:
 *
 * ```typescript
 * const handlers: HookHandlerMap = {
 *   beforeToolCall: (ctx) => { ... },  // ctx is BeforeToolCallContext
 *   onAgentStart: (ctx) => { ... },    // ctx is AgentStartContext
 * };
 * ```
 */
export interface HookHandlerMap {
  beforeToolCall: BeforeToolCallHandler;
  afterToolCall: AfterToolCallHandler;
  beforeLLMCall: BeforeLLMCallHandler;
  afterLLMCall: AfterLLMCallHandler;
  onAgentStart: AgentStartHandler;
  onAgentComplete: AgentCompleteHandler;
  onError: ErrorHandler;
  beforeToolResolve: BeforeToolResolveHandler;
  afterToolResolve: AfterToolResolveHandler;
  onToolTimeout: ToolTimeoutHandler;
  onToolRetry: ToolRetryHandler;
  beforeContextCompaction: BeforeContextCompactionHandler;
  afterContextCompaction: AfterContextCompactionHandler;
  onSessionFork: SessionForkHandler;
  onSessionArchive: SessionArchiveHandler;
  onStepStart: StepStartHandler;
  onStepComplete: StepCompleteHandler;
  beforeBackendSelect: BeforeBackendSelectHandler;
  afterBackendSelect: AfterBackendSelectHandler;
}

// ============================================================================
// Hook Subscription Builder — fluent API for binding handlers
// ============================================================================

/**
 * Type-safe hook subscription builder.
 *
 * @example
 * ```typescript
 * const hooks = createHookSubscriptions()
 *   .on('beforeToolCall', (ctx) => {
 *     console.log(`About to call: ${ctx.toolName}`);
 *   })
 *   .on('onAgentComplete', (ctx) => {
 *     console.log(`Agent done: ${ctx.result.status}`);
 *   });
 *
 * // Later, subscribe all at once:
 * hooks.subscribeTo(api);
 * ```
 */
export class HookSubscriptions {
  private handlers = new Map<HookPoint, Array<(...args: unknown[]) => Promise<void> | void>>();

  /** Register a handler for a specific hook point. Type-safe! */
  on<K extends HookPoint>(event: K, handler: HookHandlerMap[K]): this {
    const existing = this.handlers.get(event) ?? [];
    existing.push(handler as (...args: unknown[]) => Promise<void> | void);
    this.handlers.set(event, existing);
    return this;
  }

  /** Register handler for beforeToolCall */
  onBeforeToolCall(handler: BeforeToolCallHandler): this {
    return this.on('beforeToolCall', handler);
  }
  /** Register handler for afterToolCall */
  onAfterToolCall(handler: AfterToolCallHandler): this {
    return this.on('afterToolCall', handler);
  }
  /** Register handler for beforeLLMCall */
  onBeforeLLMCall(handler: BeforeLLMCallHandler): this {
    return this.on('beforeLLMCall', handler);
  }
  /** Register handler for afterLLMCall */
  onAfterLLMCall(handler: AfterLLMCallHandler): this {
    return this.on('afterLLMCall', handler);
  }
  /** Register handler for onAgentStart */
  onAgentStart(handler: AgentStartHandler): this {
    return this.on('onAgentStart', handler);
  }
  /** Register handler for onAgentComplete */
  onAgentComplete(handler: AgentCompleteHandler): this {
    return this.on('onAgentComplete', handler);
  }
  /** Register handler for onError */
  onError(handler: ErrorHandler): this {
    return this.on('onError', handler);
  }

  /**
   * Subscribe all registered handlers to the CommanderPluginAPI.
   * Call this inside your plugin's register() function.
   */
  subscribeTo(api: {
    on(event: HookPoint, handler: (...args: unknown[]) => Promise<void> | void): void;
  }): void {
    for (const [event, handlers] of this.handlers) {
      for (const handler of handlers) {
        api.on(event, handler);
      }
    }
  }

  /** Get all registered handlers for inspection/testing */
  getHandlers(): Map<HookPoint, Array<(...args: unknown[]) => Promise<void> | void>> {
    return new Map(this.handlers);
  }

  /** Clear all registered handlers */
  clear(): void {
    this.handlers.clear();
  }
}

/**
 * Create a new HookSubscriptions builder.
 * Recommended entry point for plugin authors.
 */
export function createHookSubscriptions(): HookSubscriptions {
  return new HookSubscriptions();
}
