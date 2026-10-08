/**
 * @praetor/plugin-sdk
 *
 * Build tools, skills, and hooks for the Commander agent platform.
 *
 * @example
 * ```typescript
 * import { createPlugin, defineTool, createHookSubscriptions } from '@praetor/plugin-sdk';
 *
 * export default createPlugin({
 *   id: 'my-plugin',
 *   name: 'My Plugin',
 *   version: '1.0.0',
 *   description: 'A cool plugin',
 *
 *   async register(api) {
 *     // Register a tool
 *     api.registerTool(defineTool({
 *       name: 'hello',
 *       description: 'Say hello',
 *       inputSchema: {
 *         type: 'object',
 *         properties: { name: { type: 'string' } },
 *         required: ['name'],
 *       },
 *       async execute(args) {
 *         return `Hello, ${args.name}!`;
 *       },
 *     }));
 *
 *     // Subscribe to hooks (type-safe!)
 *     createHookSubscriptions()
 *       .onBeforeToolCall((ctx) => {
 *         console.log(`Tool: ${ctx.toolName}`);
 *       })
 *       .onAgentComplete((ctx) => {
 *         console.log(`Agent done: ${ctx.result.status}`);
 *       })
 *       .subscribeTo(api);
 *   },
 * });
 * ```
 */

export type {
  // Plugin definition
  CommanderPluginDef,
  CommanderPluginManifest,

  // Plugin API
  CommanderPluginAPI,
  PluginLogger,

  // Tool types
  PluginTool,
  PluginToolDefinition,
  JsonSchema,

  // Hook types
  HookPoint,
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

  // Command types
  CommandOpts,
} from './types';

// ── Type-safe hook handlers ──
export { HookSubscriptions, createHookSubscriptions } from './hooks';

export type {
  BeforeToolCallHandler,
  AfterToolCallHandler,
  BeforeLLMCallHandler,
  AfterLLMCallHandler,
  AgentStartHandler,
  AgentCompleteHandler,
  ErrorHandler,
  BeforeToolResolveHandler,
  AfterToolResolveHandler,
  ToolTimeoutHandler,
  ToolRetryHandler,
  BeforeContextCompactionHandler,
  AfterContextCompactionHandler,
  SessionForkHandler,
  SessionArchiveHandler,
  StepStartHandler,
  StepCompleteHandler,
  BeforeBackendSelectHandler,
  AfterBackendSelectHandler,
  HookHandlerMap,
} from './hooks';

import type { CommanderPluginDef, PluginTool, JsonSchema } from './types';

/**
 * Create a Commander plugin with validation.
 * This is the recommended way to define a plugin.
 */
export function createPlugin(def: CommanderPluginDef): CommanderPluginDef {
  if (!def.id || typeof def.id !== 'string') {
    throw new Error('Plugin must have a valid `id` string');
  }
  if (!def.name || typeof def.name !== 'string') {
    throw new Error('Plugin must have a valid `name` string');
  }
  if (!def.version || typeof def.version !== 'string') {
    throw new Error('Plugin must have a valid `version` string');
  }
  if (typeof def.register !== 'function') {
    throw new Error('Plugin must have a `register` function');
  }
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(def.id)) {
    throw new Error(
      `Plugin id "${def.id}" must start with a letter/number and contain only alphanumeric, hyphens, and underscores`,
    );
  }
  return def;
}

/**
 * Helper to define a tool with type checking.
 */
export function defineTool(tool: PluginTool): PluginTool {
  if (!tool.definition?.name) {
    throw new Error('Tool must have a definition.name');
  }
  if (!tool.definition?.description) {
    throw new Error(`Tool "${tool.definition?.name}" must have a definition.description`);
  }
  if (!tool.definition?.inputSchema) {
    throw new Error(`Tool "${tool.definition.name}" must have a definition.inputSchema`);
  }
  if (typeof tool.execute !== 'function') {
    throw new Error(`Tool "${tool.definition.name}" must have an execute function`);
  }
  return tool;
}

/**
 * Helper to create a JSON Schema object with type inference.
 */
export function schema(properties: Record<string, JsonSchema>, required?: string[]): JsonSchema {
  return { type: 'object', properties, required, additionalProperties: false };
}

/** Helper to define a string property in a JSON Schema. */
export function stringProperty(
  description?: string,
  opts?: { enum?: string[]; default?: string },
): JsonSchema {
  return { type: 'string', description, ...opts };
}

/** Helper to define a number property in a JSON Schema. */
export function numberProperty(
  description?: string,
  opts?: { minimum?: number; maximum?: number },
): JsonSchema {
  return { type: 'number', description, ...opts };
}

/** Helper to define a boolean property in a JSON Schema. */
export function booleanProperty(description?: string, defaultVal?: boolean): JsonSchema {
  return { type: 'boolean', description, default: defaultVal };
}
