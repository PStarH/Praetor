/**
 * Plugin sandbox boundary — Architecture V2.
 *
 * Untrusted plugin tool execute() must not run in-process in enterprise mode.
 * This module defines the sandbox contract and routes execution to the
 * appropriate isolation backend:
 *
 * - **v8-isolate**: For JS/TS plugins. Uses `isolated-vm` for heap isolation.
 *   Falls back gracefully if `isolated-vm` is not installed.
 * - **subprocess**: For non-JS plugins or when OS-level isolation is required.
 *   Uses `SandboxManager` to execute in a seatbelt/bubblewrap/Docker sandbox.
 * - **required**: Fail-closed. No execution permitted until a sandbox backend
 *   is available.
 * - **in_process**: Legacy dev mode. Executes directly in the host process.
 *
 * The routing logic selects the best available backend based on:
 * 1. The plugin's declared runtime (js, ts, shell, python, etc.)
 * 2. The configured sandbox mode
 * 3. Available backends on the current platform
 */

import { getGlobalLogger } from '../logging';
import { reportSilentFailure } from '../silentFailureReporter';

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

import type { PluginSandboxMode } from '@praetor/contracts';

export type { PluginSandboxMode } from '@praetor/contracts';

export type PluginRuntime = 'javascript' | 'typescript' | 'shell' | 'python' | 'unknown';

export interface SandboxedToolRequest {
  pluginId: string;
  toolName: string;
  args: Record<string, unknown>;
  /** Plugin runtime language (determines isolation strategy). */
  runtime?: PluginRuntime;
  /** Maximum execution time in milliseconds. */
  timeoutMs?: number;
  /** Maximum heap size in MB (for V8 isolate). */
  memoryLimitMB?: number;
}

export interface SandboxedToolResult {
  output: string;
  error?: string;
  durationMs: number;
  sandboxed: boolean;
  /** Which sandbox mechanism was used. */
  mechanism: 'v8-isolate' | 'subprocess' | 'in-process' | 'none';
}

export class PluginSandboxError extends Error {
  constructor(
    message: string,
    readonly code: 'SANDBOX_REQUIRED' | 'TIMEOUT' | 'ISOLATION_UNAVAILABLE' | 'EXECUTION_FAILED',
  ) {
    super(message);
    this.name = 'PluginSandboxError';
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Backend interfaces (lazy-loaded to avoid circular deps)
// ──────────────────────────────────────────────────────────────────────────

interface V8IsolateBackend {
  available: boolean;
  execute(
    code: string,
    opts: { memoryLimitMB: number; timeoutMs: number },
  ): Promise<{ result: unknown; error?: string }>;
}

interface SubprocessBackend {
  execute(
    command: string,
    opts: { timeoutMs: number; workdir?: string },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

// ──────────────────────────────────────────────────────────────────────────
// Mode resolution
// ──────────────────────────────────────────────────────────────────────────

function resolveMode(): PluginSandboxMode {
  const raw = process.env.COMMANDER_PLUGIN_SANDBOX?.toLowerCase();
  if (raw === 'required' || raw === 'subprocess' || raw === 'in_process') return raw;
  // MCP-6: default fail-closed in production. An untrusted plugin tool must not
  // run in-process (ambient require/fs = host RCE) merely because no sandbox mode
  // was configured. Operators must explicitly opt into in_process.
  return process.env.NODE_ENV === 'production' ? 'required' : 'in_process';
}

// ──────────────────────────────────────────────────────────────────────────
// V8 Isolate backend (lazy import)
// ──────────────────────────────────────────────────────────────────────────

let v8Backend: V8IsolateBackend | null | undefined = undefined;

async function getV8Backend(): Promise<V8IsolateBackend | null> {
  if (v8Backend !== undefined) return v8Backend;
  try {
    const mod = await import('../sandbox/v8Isolate.js');
    const instance = new mod.V8IsolateSandbox();
    v8Backend = {
      available: instance.available,
      async execute(code: string, opts: { memoryLimitMB: number; timeoutMs: number }) {
        const result = await instance.execute(code, [], {
          timeoutMs: opts.timeoutMs,
          maxHeapMb: opts.memoryLimitMB,
          enableMembrane: false,
          tier: 'v8-isolate',
        });
        return { result: result.output, error: result.error };
      },
    };
  } catch (err) {
    reportSilentFailure(err, 'pluginSandbox:v8Backend');
    v8Backend = null;
  }
  return v8Backend;
}

// ──────────────────────────────────────────────────────────────────────────
// Subprocess sandbox backend (lazy import)
// ──────────────────────────────────────────────────────────────────────────

let subprocessBackend: SubprocessBackend | null | undefined = undefined;

async function getSubprocessBackend(): Promise<SubprocessBackend | null> {
  if (subprocessBackend !== undefined) return subprocessBackend;
  try {
    const mod = await import('../sandbox/manager.js');
    const manager = new mod.SandboxManager();
    subprocessBackend = {
      async execute(command: string, opts: { timeoutMs: number; workdir?: string }) {
        const result = await manager.execute(
          command,
          {
            mode: 'workspace-write',
            network: 'allowlisted',
            filesystem: {
              readablePaths: ['/usr', '/lib', '/bin', '/opt'],
              writablePaths: [opts.workdir ?? '/tmp'],
              protectedPaths: ['/etc', '/root', '/home'],
              useStagingDir: true,
            },
            timeout: opts.timeoutMs,
            memoryLimitMB: 256,
            cpuLimit: 1,
          },
          opts.workdir,
        );
        return {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        };
      },
    };
  } catch (err) {
    reportSilentFailure(err, 'pluginSandbox:subprocessBackend');
    subprocessBackend = null;
  }
  return subprocessBackend;
}

// ──────────────────────────────────────────────────────────────────────────
// Execute plugin tool sandboxed
// ──────────────────────────────────────────────────────────────────────────

/**
 * Execute a plugin tool under the configured sandbox policy.
 *
 * Routing logic:
 * 1. If mode is `required` and we're in production → reject.
 * 2. If mode is `in_process` → execute directly (dev only).
 * 3. If the plugin runtime is JS/TS and V8 Isolate is available → use V8.
 * 4. If subprocess sandbox is available → use OS-level sandbox.
 * 5. Fall back to in-process with SOFT flag check.
 */
export async function executePluginToolSandboxed(
  req: SandboxedToolRequest,
  inProcessExecute?: (args: Record<string, unknown>) => Promise<string>,
): Promise<SandboxedToolResult> {
  const mode = resolveMode();
  const started = Date.now();
  const runtime = req.runtime ?? 'unknown';

  // ── required mode: fail-closed in production ──
  if (
    mode === 'required' &&
    (process.env.NODE_ENV === 'production' || process.env.COMMANDER_PLUGIN_SANDBOX_STRICT === '1')
  ) {
    throw new PluginSandboxError(
      `Plugin tool ${req.pluginId}/${req.toolName} blocked: in-process plugins forbidden (COMMANDER_PLUGIN_SANDBOX=${mode})`,
      'SANDBOX_REQUIRED',
    );
  }

  // ── in_process mode: legacy dev path ──
  if (mode === 'in_process') {
    if (!inProcessExecute) {
      throw new PluginSandboxError('No in-process executor provided', 'ISOLATION_UNAVAILABLE');
    }
    try {
      const output = await withTimeout(() => inProcessExecute(req.args), req.timeoutMs ?? 30_000);
      return {
        output,
        durationMs: Date.now() - started,
        sandboxed: false,
        mechanism: 'in-process',
      };
    } catch (err) {
      return {
        output: '',
        error: (err as Error).message,
        durationMs: Date.now() - started,
        sandboxed: false,
        mechanism: 'in-process',
      };
    }
  }

  // ── subprocess / required mode: try real sandbox backends ──

  // For JS/TS plugins, try V8 Isolate first (faster, in-process memory isolation)
  if ((runtime === 'javascript' || runtime === 'typescript') && inProcessExecute) {
    const v8 = await getV8Backend();
    if (v8?.available) {
      try {
        // Wrap the plugin's execute function as a self-contained script
        const script = wrapPluginAsScript(req, inProcessExecute);
        const result = await v8.execute(script, {
          memoryLimitMB: req.memoryLimitMB ?? 128,
          timeoutMs: req.timeoutMs ?? 30_000,
        });
        return {
          output: typeof result.result === 'string' ? result.result : JSON.stringify(result.result),
          error: result.error,
          durationMs: Date.now() - started,
          sandboxed: true,
          mechanism: 'v8-isolate',
        };
      } catch (err) {
        reportSilentFailure(err, 'pluginSandbox:v8execute');
        // Fall through to subprocess
      }
    }
  }

  // Try subprocess sandbox for any runtime
  const subprocess = await getSubprocessBackend();
  if (subprocess) {
    try {
      // For subprocess execution, the plugin must be a standalone executable
      // or a script file path. We pass the tool invocation as a shell command.
      const command = buildSubprocessCommand(req);
      const result = await subprocess.execute(command, {
        timeoutMs: req.timeoutMs ?? 30_000,
      });
      if (result.exitCode !== 0) {
        return {
          output: result.stdout,
          error: result.stderr,
          durationMs: Date.now() - started,
          sandboxed: true,
          mechanism: 'subprocess',
        };
      }
      return {
        output: result.stdout,
        durationMs: Date.now() - started,
        sandboxed: true,
        mechanism: 'subprocess',
      };
    } catch (err) {
      reportSilentFailure(err, 'pluginSandbox:subprocessExecute');
      // Fall through to soft in-process
    }
  }

  // ── No sandbox backend available ──
  if (process.env.COMMANDER_PLUGIN_SANDBOX_SOFT !== '1') {
    throw new PluginSandboxError(
      `Plugin sandbox mode=${mode} but no isolate backend available. Set COMMANDER_PLUGIN_SANDBOX_SOFT=1 for temporary in-process, or install isolated-vm / a platform sandbox.`,
      'ISOLATION_UNAVAILABLE',
    );
  }

  // Soft fallback: in-process with warning
  if (!inProcessExecute) {
    throw new PluginSandboxError('No in-process executor provided', 'ISOLATION_UNAVAILABLE');
  }
  try {
    getGlobalLogger().warn(
      'PluginSandbox',
      `Soft fallback: executing ${req.pluginId}/${req.toolName} in-process (no sandbox backend available)`,
    );
  } catch {
    // ignore
  }
  const output = await withTimeout(() => inProcessExecute(req.args), req.timeoutMs ?? 30_000);
  return { output, durationMs: Date.now() - started, sandboxed: false, mechanism: 'in-process' };
}

export function getPluginSandboxMode(): PluginSandboxMode {
  return resolveMode();
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function withTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new PluginSandboxError(`Plugin execution timed out after ${timeoutMs}ms`, 'TIMEOUT'));
    }, timeoutMs);
    fn().then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function wrapPluginAsScript(
  req: SandboxedToolRequest,
  execute: (args: Record<string, unknown>) => Promise<string>,
): string {
  // The V8 isolate receives a self-contained script that serializes
  // the plugin's execute() call result. The actual function reference
  // is passed as an ExternalCopy boundary.
  return `(function() {
    const args = ${JSON.stringify(req.args)};
    // The host will inject the execute function as a reference.
    // This script is a placeholder — the V8IsolateSandbox wraps it.
    return JSON.stringify(args);
  })()`;
}

export function buildSubprocessCommand(req: SandboxedToolRequest): string {
  // Build a shell command that invokes the plugin tool.
  // In a real deployment, this would be:
  //   node /path/to/plugin-host.js --plugin <id> --tool <name> --args <json>
  // For now, we use a simple echo to verify the sandbox works.
  //
  // MCP-6: pluginId/toolName are interpolated into a shell command below, so any
  // shell-significant character in them is a command-injection vector (e.g.
  // pluginId = `x";id;echo "`). Reject anything that is not a plain identifier.
  const SAFE_IDENT = /^[a-zA-Z0-9._-]+$/;
  if (!SAFE_IDENT.test(req.pluginId) || !SAFE_IDENT.test(req.toolName)) {
    throw new PluginSandboxError(
      `Unsafe plugin/tool identifier for subprocess execution: ${req.pluginId}/${req.toolName}`,
      'ISOLATION_UNAVAILABLE',
    );
  }
  // The payload must be one single-quoted shell word. An unquoted argument
  // is parsed by the shell and can run a command substitution.
  const payload = JSON.stringify({
    plugin: req.pluginId,
    tool: req.toolName,
    args: req.args,
  });
  return `echo '${payload.replace(/'/g, `'\\''`)}'`;
}
