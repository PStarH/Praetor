/**
 * @praetor/plugin-sdk — Type definitions for Commander plugins
 *
 * Plugins extend Commander with tools, hooks, skills, and CLI commands.
 * A plugin exports a default object implementing CommanderPluginDef.
 */

// ============================================================================
// Tool Types
// ============================================================================

/** JSON Schema for tool input validation */
export interface JsonSchema {
  type: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  description?: string;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  additionalProperties?: boolean | JsonSchema;
}

/** Definition of a tool that the LLM can invoke */
export interface PluginToolDefinition {
  /** Unique tool name (will be prefixed with plugin id in registry) */
  name: string;
  /** Description shown to the LLM — be specific about when and how to use it */
  description: string;
  /** JSON Schema for the tool's input arguments */
  inputSchema: JsonSchema;
  /** Few-shot examples for the LLM */
  examples?: Array<{ name: string; arguments: Record<string, unknown> }>;
  /** Category hint for tool selection (web, filesystem, code, memory, etc.) */
  category?: string;
  /** If true, hidden from general-purpose models (specialized tools) */
  hidden?: boolean;
}

/** A fully defined tool ready for registration */
export interface PluginTool {
  /** Tool definition sent to the LLM */
  definition: PluginToolDefinition;
  /** Execute the tool with validated arguments. Return a string result. */
  execute: (args: Record<string, unknown>) => Promise<string>;
  /** If true, can run in parallel with other concurrent-safe tools. Default: false */
  isConcurrencySafe?: boolean;
  /** If true, tool only reads state (no side effects). Default: false */
  isReadOnly?: boolean;
  /** Max execution time in ms. 0 = no limit. Default: 0 */
  timeout?: number;
  /** Max output size in chars. Default: 10000 */
  maxOutputSize?: number;
}

// ============================================================================
// Hook Types
// ============================================================================

/** All available hook points in Commander's execution pipeline */
export type HookPoint =
  | 'beforeToolCall'
  | 'afterToolCall'
  | 'beforeLLMCall'
  | 'afterLLMCall'
  | 'onAgentStart'
  | 'onAgentComplete'
  | 'onError'
  | 'beforeToolResolve'
  | 'afterToolResolve'
  | 'onToolTimeout'
  | 'onToolRetry'
  | 'beforeContextCompaction'
  | 'afterContextCompaction'
  | 'onSessionFork'
  | 'onSessionArchive'
  | 'onStepStart'
  | 'onStepComplete'
  | 'beforeBackendSelect'
  | 'afterBackendSelect';

/** Context passed to beforeToolCall hooks */
export interface BeforeToolCallContext {
  toolName: string;
  args: Record<string, unknown>;
  agentId: string;
  runId: string;
}

/** Context passed to afterToolCall hooks */
export interface AfterToolCallContext {
  toolName: string;
  args: Record<string, unknown>;
  result: {
    toolCallId: string;
    name: string;
    output: string;
    error?: string;
    durationMs: number;
  };
  agentId: string;
  runId: string;
}

/** Context passed to beforeLLMCall hooks */
export interface BeforeLLMCallContext {
  request: Record<string, unknown>;
  agentId: string;
  runId: string;
}

/** Context passed to afterLLMCall hooks */
export interface AfterLLMCallContext {
  request: Record<string, unknown>;
  response: Record<string, unknown> | null;
  agentId: string;
  runId: string;
}

/** Context passed to onAgentStart hooks */
export interface AgentStartContext {
  ctx: {
    agentId: string;
    goal: string;
    runId: string;
    [key: string]: unknown;
  };
  runId: string;
}

/** Context passed to onAgentComplete hooks */
export interface AgentCompleteContext {
  result: {
    status: string;
    [key: string]: unknown;
  };
  runId: string;
}

/** Context passed to onError hooks */
export interface ErrorContext {
  error: string;
  runId: string;
  agentId: string;
}

/** Context passed to beforeToolResolve / afterToolResolve hooks */
export interface ToolResolveContext {
  toolName: string;
  args: Record<string, unknown>;
  tool?: { name: string; category?: string };
  notFound: boolean;
  agentId: string;
  runId: string;
}

/** Context passed to onToolTimeout hooks */
export interface ToolTimeoutContext {
  toolName: string;
  args: Record<string, unknown>;
  timeoutMs: number;
  durationMs: number;
  agentId: string;
  runId: string;
}

/** Context passed to onToolRetry hooks */
export interface ToolRetryContext {
  toolName: string;
  args: Record<string, unknown>;
  attempt: number;
  maxRetries: number;
  lastError: string;
  agentId: string;
  runId: string;
}

/** Context passed to context compaction hooks */
export interface ContextCompactionContext {
  messageCount: number;
  totalTokens: number;
  budgetTokens: number;
  agentId: string;
  runId: string;
}

/** Context passed to onSessionFork hooks */
export interface SessionForkContext {
  parentRunId: string;
  childRunId: string;
  agentId: string;
  goal: string;
}

/** Context passed to onSessionArchive hooks */
export interface SessionArchiveContext {
  runId: string;
  phase: string;
  stepNumber: number;
  tokenUsage: { totalTokens: number };
}

/** Context passed to step lifecycle hooks */
export interface StepLifecycleContext {
  runId: string;
  agentId: string;
  stepNumber: number;
  type: 'thought' | 'tool_call' | 'tool_result' | 'response';
  content?: string;
}

/** Context passed to backend select hooks */
export interface BackendSelectContext {
  toolName: string;
  args: Record<string, unknown>;
  selectedBackend?: string;
  agentId: string;
  runId: string;
}

// ============================================================================
// Command Types
// ============================================================================

/** Options for registering a CLI command */
export interface CommandOpts {
  /** Command description shown in help */
  description: string;
  /** Arguments spec (e.g., '<url>', '<topic>', '[file...]') */
  arguments?: string;
  /** Options spec (e.g., [['--verbose', 'Enable verbose output']]) */
  options?: Array<[string, string]>;
  /** Command handler */
  action: (...args: unknown[]) => Promise<void> | void;
}

// ============================================================================
// Logger
// ============================================================================

/** Structured logger provided to plugins */
export interface PluginLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}

// ============================================================================
// Plugin API — what register(api) receives
// ============================================================================

/**
 * The API object passed to a plugin's register() function.
 * This is the plugin's interface to Commander's internals.
 */
export interface CommanderPluginAPI {
  /** Register a tool that the LLM can invoke */
  registerTool(tool: PluginTool): void;

  /** Unregister a previously registered tool by name */
  unregisterTool(name: string): void;

  /** Subscribe to a lifecycle hook event */
  on(event: HookPoint, handler: (...args: unknown[]) => Promise<void> | void): void;

  /** Unsubscribe from a lifecycle hook event */
  off(event: HookPoint, handler: (...args: unknown[]) => Promise<void> | void): void;

  /** Register a CLI subcommand */
  registerCommand(name: string, opts: CommandOpts): void;

  /** Plugin configuration (from commander.plugin.json configSchema + user overrides) */
  config: Record<string, unknown>;

  /** Structured logger scoped to this plugin */
  logger: PluginLogger;

  /** Access to Commander internals (advanced usage) */
  runtime: {
    /** Commander version */
    commanderVersion: string;
    /** Current workspace path */
    workspace: string;
  };
}

// ============================================================================
// Plugin Definition — what the plugin author exports
// ============================================================================

/**
 * A Commander plugin definition.
 * Export a default object implementing this interface from your plugin entry point.
 */
export interface CommanderPluginDef {
  /** Unique plugin identifier (must be unique across all installed plugins) */
  id: string;
  /** Human-readable plugin name */
  name: string;
  /** Plugin version (semver) */
  version: string;
  /** Short description of what the plugin does */
  description?: string;
  /** Plugin author */
  author?: string;
  /** License identifier (e.g., "MIT") */
  license?: string;
  /** Keywords for discovery */
  keywords?: string[];
  /** Minimum Commander version required */
  minCommanderVersion?: string;
  /** Other plugins this plugin depends on */
  dependsOn?: string[];

  /**
   * Called when the plugin is loaded.
   * Register tools, hooks, and commands here.
   */
  register: (api: CommanderPluginAPI) => Promise<void> | void;

  /**
   * Called when the plugin is unloaded.
   * Clean up resources here.
   */
  unregister?: () => Promise<void> | void;
}

// ============================================================================
// Plugin Manifest — commander.plugin.json
// ============================================================================

/**
 * The manifest file that declares a plugin's metadata.
 * Located at the root of the plugin package.
 */
export interface CommanderPluginManifest {
  /** Unique plugin identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Plugin version (semver) */
  version: string;
  /** Short description */
  description?: string;
  /** Plugin author */
  author?: string;
  /** License identifier */
  license?: string;
  /** Entry point (relative to manifest). Default: "dist/index.js" */
  main?: string;
  /** Keywords for npm discovery */
  keywords?: string[];
  /** Minimum Commander version */
  minCommanderVersion?: string;
  /** Dependencies on other plugins */
  dependsOn?: string[];
  /** JSON Schema for plugin configuration */
  configSchema?: JsonSchema;
}
