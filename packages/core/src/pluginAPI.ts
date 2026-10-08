/**
 * Plugin API Bridge
 *
 * Implements the CommanderPluginAPI interface from @praetor/plugin-sdk,
 * bridging plugin calls to Commander's internal ToolRegistry, HookManager, and CLI.
 */
import type {
  CommanderPluginAPI,
  CommanderPluginDef,
  PluginTool,
  PluginLogger,
  HookPoint,
  CommandOpts,
} from '@praetor/plugin-sdk';
import { getGlobalLogger } from './logging';
import type { Tool, ToolDefinition } from './runtime';

// ============================================================================
// Plugin Tool Adapter — wraps PluginTool as internal Tool
// ============================================================================

/**
 * Adapts a PluginTool (from the SDK) to Commander's internal Tool interface.
 * The ToolRegistry expects Tool objects; plugins provide PluginTool objects.
 */
export function adaptPluginTool(pluginId: string, pluginTool: PluginTool): Tool {
  // Prefix tool name with plugin id to avoid collisions
  const prefixedName = `${pluginId}__${pluginTool.definition.name}`;

  const definition: ToolDefinition = {
    name: prefixedName,
    description: pluginTool.definition.description,
    inputSchema: pluginTool.definition.inputSchema as unknown as Record<string, unknown>,
    examples: pluginTool.definition.examples,
    category: pluginTool.definition.category,
    hidden: pluginTool.definition.hidden,
  };

  return {
    definition,
    execute: pluginTool.execute,
    isConcurrencySafe: pluginTool.isConcurrencySafe ?? false,
    isReadOnly: pluginTool.isReadOnly ?? false,
    timeout: pluginTool.timeout ?? 0,
    maxOutputSize: pluginTool.maxOutputSize ?? 10000,
  };
}

// ============================================================================
// Plugin Logger
// ============================================================================

function createPluginLogger(pluginId: string): PluginLogger {
  const logger = getGlobalLogger();
  const prefix = `Plugin:${pluginId}`;
  return {
    info: (message: string) => logger.info(prefix, message),
    warn: (message: string) => logger.warn(prefix, message),
    error: (message: string) => logger.error(prefix, message),
    debug: (message: string) => logger.debug(prefix, message),
  };
}

// ============================================================================
// Plugin API Implementation
// ============================================================================

interface RegisteredToolInfo {
  pluginId: string;
  toolName: string;
  prefixedName: string;
}

interface RegisteredCommandInfo {
  pluginId: string;
  commandName: string;
  opts: CommandOpts;
}

/**
 * Creates a CommanderPluginAPI instance for a specific plugin.
 *
 * @param plugin The plugin definition
 * @param options Additional options (workspace path, etc.)
 * @returns The API instance and a cleanup function
 */
export function createPluginAPI(
  plugin: CommanderPluginDef,
  options: { workspace?: string } = {},
): {
  api: CommanderPluginAPI;
  registeredTools: RegisteredToolInfo[];
  pluginToolMap: Map<string, PluginTool>;
  registeredCommands: RegisteredCommandInfo[];
  hookHandlers: Map<HookPoint, Set<Function>>;
  cleanup: () => void;
} {
  const pluginId = plugin.id;
  const logger = createPluginLogger(pluginId);
  const registeredTools: RegisteredToolInfo[] = [];
  const pluginToolMap = new Map<string, PluginTool>();
  const registeredCommands: RegisteredCommandInfo[] = [];
  const hookHandlers = new Map<HookPoint, Set<Function>>();

  const api: CommanderPluginAPI = {
    // ── Tool Registration ──

    registerTool(tool: PluginTool): void {
      const prefixedName = `${pluginId}__${tool.definition.name}`;

      // Track the tool info
      registeredTools.push({
        pluginId,
        toolName: tool.definition.name,
        prefixedName,
      });

      // Store the original PluginTool for later wiring into ToolRegistry
      pluginToolMap.set(tool.definition.name, tool);

      logger.debug(`Registered tool: ${tool.definition.name} → ${prefixedName}`);
    },

    unregisterTool(name: string): void {
      const prefixedName = `${pluginId}__${name}`;
      const idx = registeredTools.findIndex((t) => t.prefixedName === prefixedName);
      if (idx >= 0) {
        registeredTools.splice(idx, 1);
        logger.debug(`Unregistered tool: ${name}`);
      }
    },

    // ── Hook Subscription ──

    on(event: HookPoint, handler: (...args: unknown[]) => Promise<void> | void): void {
      if (!hookHandlers.has(event)) {
        hookHandlers.set(event, new Set());
      }
      hookHandlers.get(event)!.add(handler);
      logger.debug(`Subscribed to hook: ${event}`);
    },

    off(event: HookPoint, handler: (...args: unknown[]) => Promise<void> | void): void {
      const handlers = hookHandlers.get(event);
      if (handlers) {
        handlers.delete(handler);
        logger.debug(`Unsubscribed from hook: ${event}`);
      }
    },

    // ── Command Registration ──

    registerCommand(name: string, opts: CommandOpts): void {
      registeredCommands.push({ pluginId, commandName: name, opts });
      logger.debug(`Registered command: ${name}`);
    },

    // ── Configuration ──

    config: {},

    // ── Logger ──

    logger,

    // ── Runtime Access ──

    runtime: {
      commanderVersion: '1.0.0',
      workspace: options.workspace ?? process.cwd(),
    },
  };

  // Cleanup function
  const cleanup = (): void => {
    hookHandlers.clear();
    registeredTools.length = 0;
    pluginToolMap.clear();
    registeredCommands.length = 0;
  };

  return { api, registeredTools, pluginToolMap, registeredCommands, hookHandlers, cleanup };
}

// ============================================================================
// Plugin Hook Bridge — wires plugin hooks into HookManager
// ============================================================================

/**
 * Creates a CommanderPlugin that bridges a plugin's hook subscriptions
 * into the HookManager's hook firing system.
 */
export function createHookBridge(
  pluginId: string,
  hookHandlers: Map<HookPoint, Set<Function>>,
): {
  fireHook: (event: HookPoint, ctx: unknown) => Promise<unknown>;
} {
  return {
    async fireHook(event: HookPoint, ctx: unknown): Promise<unknown> {
      const handlers = hookHandlers.get(event);
      if (!handlers || handlers.size === 0) return null;

      for (const handler of handlers) {
        try {
          const result = await handler(ctx);
          // For "before" hooks, returning non-null means "block/override"
          if (event.startsWith('before') && result !== null && result !== undefined) {
            return result;
          }
        } catch (err) {
          getGlobalLogger().warn(
            'PluginAPI',
            `Plugin "${pluginId}" hook "${event}" failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      return null;
    },
  };
}
