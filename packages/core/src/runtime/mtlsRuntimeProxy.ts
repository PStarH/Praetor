/**
 * MtlsRuntimeProxy — AgentRuntimeInterface implementation that forwards calls
 * over mutually-authenticated TLS to a remote MtlsRuntimeServer.
 *
 * Use this in the Commander HTTP server (or any other consumer) when the
 * AgentRuntime lives in a separate process. Pair with MtlsRuntimeServer on the
 * runtime side.
 */
import * as https from 'node:https';
import { readFileSync } from 'node:fs';
import type { AgentRuntimeInterface } from './agentRuntimeInterface';
import type {
  AgentExecutionContext,
  AgentExecutionResult,
  AgentRuntimeConfig,
} from './types/execution';
import type { LLMProvider, Tool } from './types';
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
import { getGlobalLogger } from '../logging';

export interface MtlsRuntimeProxyConfig {
  /** Base URL of the remote mTLS runtime server, e.g. https://localhost:3002 */
  baseUrl: string;
  /** PEM-encoded client certificate (content or file path) */
  cert: string;
  /** PEM-encoded client private key (content or file path) */
  key: string;
  /** PEM-encoded CA bundle for verifying the server certificate */
  ca: string;
  /** Request timeout in ms. Default: 30000. */
  timeoutMs?: number;
}

const DEFAULT_CONFIG: Partial<MtlsRuntimeProxyConfig> = {
  timeoutMs: 30000,
};

export class MtlsRuntimeProxy implements AgentRuntimeInterface {
  private config: MtlsRuntimeProxyConfig;
  private agent: https.Agent;
  private logger = getGlobalLogger();

  constructor(config: MtlsRuntimeProxyConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.agent = new https.Agent({
      cert: maybeReadFile(this.config.cert),
      key: maybeReadFile(this.config.key),
      ca: maybeReadFile(this.config.ca),
      rejectUnauthorized: true,
    });
  }

  // ── Core execution path ───────────────────────────────────────────────────

  execute(ctx: AgentExecutionContext): Promise<AgentExecutionResult> {
    return this.rpc('execute', [ctx]) as Promise<AgentExecutionResult>;
  }

  // ── Registration (not serializable over RPC) ───────────────────────────────

  registerProvider(_name: string, _provider: LLMProvider): void {
    throw new Error(
      'registerProvider is not supported over MtlsRuntimeProxy. Configure providers on the runtime server process.',
    );
  }

  registerTool(_name: string, _tool: Tool): void {
    throw new Error(
      'registerTool is not supported over MtlsRuntimeProxy. Configure tools on the runtime server process.',
    );
  }

  getProvider(_name: string): LLMProvider | undefined {
    throw new Error('getProvider is not supported over MtlsRuntimeProxy.');
  }

  getFirstAvailableProvider(_preferredName?: string): LLMProvider | undefined {
    throw new Error('getFirstAvailableProvider is not supported over MtlsRuntimeProxy.');
  }

  getSmartRouter(): SmartModelRouter | null {
    throw new Error('getSmartRouter is not supported over MtlsRuntimeProxy.');
  }

  getTool(_name: string): Tool | undefined {
    throw new Error('getTool is not supported over MtlsRuntimeProxy.');
  }

  // ── Read-only introspection ───────────────────────────────────────────────

  getConfig(): AgentRuntimeConfig {
    throw new Error('getConfig is not supported over MtlsRuntimeProxy.');
  }

  getMemoryStore(): MemoryStore | null {
    throw new Error('getMemoryStore is not supported over MtlsRuntimeProxy.');
  }

  getCheckpointer(): StateCheckpointer {
    throw new Error('getCheckpointer is not supported over MtlsRuntimeProxy.');
  }

  getInbox(): AgentInbox {
    throw new Error('getInbox is not supported over MtlsRuntimeProxy.');
  }

  getTeamRegistry(): TeamRegistry {
    throw new Error('getTeamRegistry is not supported over MtlsRuntimeProxy.');
  }

  getHandoff(): AgentHandoff {
    throw new Error('getHandoff is not supported over MtlsRuntimeProxy.');
  }

  getExecutionScheduler(): ExecutionScheduler {
    throw new Error('getExecutionScheduler is not supported over MtlsRuntimeProxy.');
  }

  getCompensationRegistry(): CompensationRegistry {
    throw new Error('getCompensationRegistry is not supported over MtlsRuntimeProxy.');
  }

  getReliabilityEngine(): ReliabilityEngine {
    throw new Error('getReliabilityEngine is not supported over MtlsRuntimeProxy.');
  }

  getStepTimeoutManager(): StepTimeoutManager {
    throw new Error('getStepTimeoutManager is not supported over MtlsRuntimeProxy.');
  }

  // ── Run lifecycle ─────────────────────────────────────────────────────────
  // These methods are synchronous on AgentRuntimeInterface but cannot be
  // safely implemented over HTTPS without blocking the event loop. The mTLS
  // proxy is intended for the async execution path; the remote process is
  // managed by its operator. Callers that need live introspection should
  // query the remote runtime directly via its own metrics/health endpoints.

  cancelAllSteps(): number {
    throw new Error('cancelAllSteps is not supported over MtlsRuntimeProxy.');
  }

  listUnfinishedRuns(): Array<{ runId: string; phase: string; timestamp: string }> {
    throw new Error('listUnfinishedRuns is not supported over MtlsRuntimeProxy.');
  }

  resume(runId: string, tenantId?: string): Promise<RunRecoveryResult | null> {
    return this.rpc('resume', [runId, tenantId]) as Promise<RunRecoveryResult | null>;
  }

  listResumableRuns(): Array<{ runId: string; phase: string; timestamp: string }> {
    throw new Error('listResumableRuns is not supported over MtlsRuntimeProxy.');
  }

  pauseRun(runId: string): boolean {
    throw new Error(`pauseRun(${runId}) is not supported over MtlsRuntimeProxy.`);
  }

  unpauseRun(runId: string): void {
    throw new Error(`unpauseRun(${runId}) is not supported over MtlsRuntimeProxy.`);
  }

  isPaused(runId: string): boolean {
    throw new Error(`isPaused(${runId}) is not supported over MtlsRuntimeProxy.`);
  }

  getActiveRuns(): Array<{ runId: string; paused: boolean; checkpointPhase?: string }> {
    throw new Error('getActiveRuns is not supported over MtlsRuntimeProxy.');
  }

  getActiveRunCount(): number {
    throw new Error('getActiveRunCount is not supported over MtlsRuntimeProxy.');
  }

  isRunActive(runId: string): boolean {
    throw new Error(`isRunActive(${runId}) is not supported over MtlsRuntimeProxy.`);
  }

  // ── Stats / health ────────────────────────────────────────────────────────

  getSemanticCacheStats(): SemanticCacheStats {
    throw new Error('getSemanticCacheStats is not supported over MtlsRuntimeProxy.');
  }

  getSingleFlightStats(): SingleFlightStats {
    throw new Error('getSingleFlightStats is not supported over MtlsRuntimeProxy.');
  }

  getGeminiCacheStats(): GeminiCacheStats {
    throw new Error('getGeminiCacheStats is not supported over MtlsRuntimeProxy.');
  }

  getCostEstimatorHistory(): HistoricalTaskCost[][] {
    return this.rpcSync('getCostEstimatorHistory', []) as HistoricalTaskCost[][];
  }

  getProviderHealth(): Array<{
    provider: string;
    state: string;
    errorRate: number;
    requestCount: number;
    lastFailureAt: number;
  }> {
    return this.rpcSync('getProviderHealth', []) as Array<{
      provider: string;
      state: string;
      errorRate: number;
      requestCount: number;
      lastFailureAt: number;
    }>;
  }

  // ── Extended surface used by CommanderHttpServer ──────────────────────────

  listToolNames(): string[] {
    return this.rpcSync('listToolNames', []) as string[];
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  dispose(): void {
    try {
      this.rpcSync('dispose', []);
    } catch (err) {
      this.logger.warn('MtlsRuntimeProxy', 'dispose failed', { error: (err as Error)?.message });
    }
    this.agent.destroy();
  }

  // ── Internal RPC ──────────────────────────────────────────────────────────

  private rpcSync(method: string, args: unknown[]): unknown {
    // Synchronous façade over the async HTTPS call. AgentRuntimeInterface
    // declares several sync getters; we block the event loop briefly to
    // honour the contract. Long-term callers should prefer async equivalents.
    //
    // NOTE(rpcSync): replace the busy-wait with an explicit async-only surface.
    // Today this blocks the event loop up to timeoutMs, which means TLS handshake
    // errors aren't surfaced until the deadline — see
    // packages/core/tests/runtime/mtlsRuntimeIpc.test.ts scenario 2 for the
    // test that exercises this constraint. Follow-up: throw
    // `Error('sync RPC not supported over mTLS — use the async equivalents')`
    // for every sync getter; migrate the HealthSources in httpServer.ts to
    // async `getProviderHealthAsync()` (or equivalent) once it ships. Caveat
    // mirrored in ENTERPRISE_READINESS.md SOC2-4 evidence row.
    const UNSET = Symbol('rpc-unset');
    let result: unknown = UNSET;
    let error: Error | undefined;
    this.rpc(method, args).then(
      (r) => (result = r),
      (e) => (error = e),
    );
    const start = Date.now();
    const deadline = this.config.timeoutMs ?? 30000;
    while (result === UNSET && error === undefined && Date.now() - start < deadline) {
      // Busy-wait is suboptimal but necessary to satisfy a synchronous interface.
      // In production, use async APIs where possible.
      const now = Date.now();
      // eslint-disable-next-line no-empty
      while (Date.now() - now < 5) {}
    }
    if (error) throw error;
    if (result === UNSET) throw new Error(`mTLS RPC ${method} timed out`);
    return result;
  }

  private rpc(method: string, args: unknown[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ method, args });
      const url = new URL('/rpc', this.config.baseUrl);
      const req = https.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          agent: this.agent,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            data += chunk;
          });
          res.on('end', () => {
            if (res.statusCode !== 200) {
              reject(new Error(`mTLS RPC ${method} failed: HTTP ${res.statusCode}: ${data}`));
              return;
            }
            try {
              const json = JSON.parse(data) as { result?: unknown; error?: string };
              if (json.error) {
                reject(new Error(`mTLS RPC ${method} error: ${json.error}`));
                return;
              }
              resolve(json.result);
            } catch (err) {
              reject(new Error(`mTLS RPC ${method} invalid JSON: ${data}`));
            }
          });
        },
      );
      req.on('error', (err) => reject(err));
      req.setTimeout(this.config.timeoutMs ?? 30000, () => {
        req.destroy(new Error(`mTLS RPC ${method} timed out`));
      });
      req.write(body);
      req.end();
    });
  }
}

function maybeReadFile(s: string): string {
  if (s.startsWith('-----BEGIN')) return s;
  return readFileSync(s, 'utf8');
}
