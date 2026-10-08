/**
 * CommanderClient — Lightweight SDK wrapper for Commander.
 *
 * This is a thin proxy that delegates all infrastructure wiring to the
 * core Commander class. Use this when embedding Commander into your app
 * programmatically.
 *
 * For zero-config CLI usage, use `Commander.create()` directly from core.
 *
 * @example
 * ```typescript
 * import { CommanderClient, Topology } from '@praetor/sdk';
 *
 * // Auto-detect environment (tier, provider, model)
 * const client = new CommanderClient();
 * await client.connect();
 * const result = await client.run('analyze this repository');
 *
 * // With explicit config
 * const client = new CommanderClient({ provider: 'openai' });
 * await client.connect();
 * await client.disconnect();
 * ```
 */

import { createRequire } from 'node:module';

import { reportSilentFailure } from '@praetor/core';
import type { CommanderOptions } from '@praetor/core';

/**
 * ESM-safe `require`. This package is `"type": "module"`, so the global
 * `require` binding does not exist — calling it raises
 * `ReferenceError: require is not defined`, which the surrounding `try`/`catch`
 * in `queryMemory()` would mistake for "core not available" and swallow.
 */
const nodeRequire = createRequire(import.meta.url);

import type {
  CommanderClientConfig,
  ExecutionResult,
  ExecutionEvent,
  SessionSummary,
  SystemStatus,
  AgentConfig,
  AgentSnapshot,
  Task,
  TaskHandle,
  MemoryWriteOptions,
  MemoryQueryOptions,
  MemoryItem,
  MemoryStats,
  SDKReliabilityStats,
  ExecutionStepSummary,
} from './types';
import type { Topology } from './types';

// ============================================================================
// Agent
// ============================================================================

let agentIdCounter = 0;

/**
 * Agent — a configured persona within Commander.
 */
export class Agent {
  readonly id: string;
  readonly config: AgentConfig;
  readonly createdAt: string;
  runCount = 0;
  totalTokensUsed = 0;
  lastRunAt?: string;

  constructor(config: AgentConfig) {
    this.id = config.id ?? `agent_${++agentIdCounter}`;
    this.config = { ...config };
    this.createdAt = new Date().toISOString();
    if (!config.name || !config.role) {
      throw new Error('Agent requires both `name` and `role`.');
    }
  }

  snapshot(): AgentSnapshot {
    return {
      id: this.id,
      name: this.config.name,
      role: this.config.role,
      tools: this.config.tools ?? [],
      topology: this.config.topology ?? ('SINGLE' as Topology),
      runCount: this.runCount,
      totalTokensUsed: this.totalTokensUsed,
      createdAt: this.createdAt,
      lastRunAt: this.lastRunAt,
    };
  }

  static fromSnapshot(snapshot: AgentSnapshot): Agent {
    const agent = new Agent({
      id: snapshot.id,
      name: snapshot.name,
      role: snapshot.role,
      tools: snapshot.tools,
      topology: snapshot.topology,
    });
    agent.runCount = snapshot.runCount;
    agent.totalTokensUsed = snapshot.totalTokensUsed;
    agent.lastRunAt = snapshot.lastRunAt;
    return agent;
  }
}

// ============================================================================
// CommanderClient (thin wrapper)
// ============================================================================

export class CommanderClient {
  private config: CommanderClientConfig;
  private commander: Awaited<ReturnType<typeof import('@praetor/core').Commander.create>> | null =
    null;
  private connected = false;
  private startTime: number = 0;
  private runCount = 0;
  private activeSessions = 0;
  private eventHandlers: Set<(event: ExecutionEvent) => void> = new Set();
  private sessions: SessionSummary[] = [];
  private agents: Map<string, Agent> = new Map();
  private tasks: Map<string, TaskHandle> = new Map();
  private taskCounter = 0;

  constructor(config: CommanderClientConfig = {}) {
    this.config = {
      tokenBudget: 64000,
      defaultTopology: 'SINGLE' as Topology,
      persistSessions: true,
      ...config,
    };
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  async connect(): Promise<void> {
    if (this.connected) return;
    this.startTime = Date.now();

    // Delegate all environment probing + tier selection + wiring to core Commander
    const { Commander } = await import('@praetor/core');
    const options: CommanderOptions = {};

    if (this.config.provider) options.provider = this.config.provider;
    if (this.config.apiKey) options.apiKey = this.config.apiKey;
    if (this.config.model) options.model = this.config.model;
    if (this.config.baseUrl) options.baseUrl = this.config.baseUrl;
    if (this.config.tokenBudget) options.tokenBudget = this.config.tokenBudget;

    this.commander = await Commander.create(options);

    // Wire SSE events
    const { getMessageBus } = await import('@praetor/core');
    const bus = getMessageBus();
    bus.subscribe('agent.started', (msg) => {
      this.activeSessions++;
      this.dispatchEvent({
        type: 'agent.started',
        timestamp: msg.timestamp,
        data: (msg.payload as Record<string, unknown>) ?? {},
      });
    });
    bus.subscribe('agent.completed', (msg) => {
      this.runCount++;
      this.activeSessions = Math.max(0, this.activeSessions - 1);
      this.dispatchEvent({
        type: 'agent.completed',
        timestamp: msg.timestamp,
        data: (msg.payload as Record<string, unknown>) ?? {},
      });
    });
    bus.subscribe('agent.failed', (msg) => {
      this.runCount++;
      this.activeSessions = Math.max(0, this.activeSessions - 1);
      this.dispatchEvent({
        type: 'agent.failed',
        timestamp: msg.timestamp,
        data: (msg.payload as Record<string, unknown>) ?? {},
      });
    });

    this.connected = true;
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;
    await this.commander?.dispose();
    this.eventHandlers.clear();
    this.commander = null;
    this.connected = false;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  // ==========================================================================
  // Agent Management
  // ==========================================================================

  createAgent(config: AgentConfig): Agent {
    const agent = new Agent(config);
    this.agents.set(agent.id, agent);
    return agent;
  }

  getAgent(id: string): Agent | undefined {
    return this.agents.get(id);
  }
  listAgents(): Agent[] {
    return Array.from(this.agents.values());
  }

  removeAgent(id: string): boolean {
    return this.agents.delete(id);
  }

  getAgentSnapshots(): AgentSnapshot[] {
    return this.listAgents().map((a) => a.snapshot());
  }

  // ==========================================================================
  // Task Submission
  // ==========================================================================

  submitTask(agent: Agent, task: Task): TaskHandle {
    const id = `task_${++this.taskCounter}`;
    const handle: TaskHandle = {
      id,
      task,
      status: 'pending',
      agentId: agent.id,
      submittedAt: new Date().toISOString(),
    };
    this.tasks.set(id, handle);

    this.executeTask(agent, handle).catch((err) => {
      handle.status = 'failed';
      handle.completedAt = new Date().toISOString();
      handle.result = {
        status: 'FAILED',
        summary: err instanceof Error ? err.message : String(err),
        steps: [],
        totalTokenUsage: 0,
        totalDurationMs: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    });
    return handle;
  }

  async awaitTask(taskId: string, timeoutMs = 120_000): Promise<ExecutionResult | null> {
    const handle = this.tasks.get(taskId);
    if (!handle) return null;
    if (handle.result) return handle.result;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 200));
      const h = this.tasks.get(taskId);
      if (h?.result) return h.result;
    }
    return null;
  }

  getTaskHandle(id: string): TaskHandle | undefined {
    return this.tasks.get(id);
  }

  cancelTask(id: string): boolean {
    const handle = this.tasks.get(id);
    if (!handle || handle.status === 'completed' || handle.status === 'failed') return false;
    handle.status = 'cancelled';
    handle.completedAt = new Date().toISOString();
    return true;
  }

  private async executeTask(agent: Agent, handle: TaskHandle): Promise<void> {
    handle.status = 'running';
    agent.lastRunAt = new Date().toISOString();
    try {
      const result = await this.runInternal(handle.task.goal, agent);
      handle.status = 'completed';
      handle.completedAt = new Date().toISOString();
      handle.result = result;
      agent.runCount++;
      agent.totalTokensUsed += result.totalTokenUsage;
    } catch (err) {
      handle.status = 'failed';
      handle.completedAt = new Date().toISOString();
      handle.result = {
        status: 'FAILED',
        summary: err instanceof Error ? err.message : String(err),
        steps: [],
        totalTokenUsage: 0,
        totalDurationMs: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // ==========================================================================
  // Execution
  // ==========================================================================

  async plan(task: string): Promise<unknown> {
    this.ensureConnected();
    return this.commander!.plan(task);
  }

  async run(task: string): Promise<ExecutionResult> {
    this.ensureConnected();
    return this.runInternal(task);
  }

  private async runInternal(task: string, agent?: Agent): Promise<ExecutionResult> {
    const startTime = Date.now();
    const result = await this.commander!.run(
      task,
      agent?.id ?? 'commander-sdk',
      agent?.config.tools,
    );

    if (this.config.persistSessions !== false) {
      if (this.sessions.length >= 1000) {
        this.sessions.splice(0, this.sessions.length - 999);
      }
      this.sessions.push({
        runId: result.runId,
        task: task.slice(0, 80),
        status: result.status.toUpperCase(),
        agentId: agent?.id ?? 'commander-sdk',
        topology: agent?.config.topology ?? this.config.defaultTopology ?? ('SINGLE' as Topology),
        tokenUsage: result.tokenUsage.totalTokens,
        durationMs: result.durationMs,
        timestamp: new Date().toISOString(),
      });
    }

    const status: ExecutionResult['status'] =
      result.status === 'success' ? 'SUCCESS' : result.status === 'failed' ? 'FAILED' : 'PARTIAL';

    return {
      status,
      summary: result.summary,
      steps: result.steps as unknown as ExecutionStepSummary[],
      totalTokenUsage: result.tokenUsage.totalTokens,
      totalDurationMs: result.durationMs,
      error: result.error,
      runId: result.runId,
    };
  }

  // ==========================================================================
  // Memory
  // ==========================================================================

  async writeMemory(content: string, options: MemoryWriteOptions = {}): Promise<string | null> {
    try {
      const { getGlobalThreeLayerMemory } = await import('@praetor/core');
      const memory = getGlobalThreeLayerMemory();
      const id = `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      memory.add(
        content,
        options.layer ?? 'episodic',
        `id:${id}`,
        options.importance ?? 0.5,
        options.tags ?? [],
      );
      return id;
    } catch (err) {
      reportSilentFailure(err, 'commanderClient:353');
      return null;
    }
  }

  /**
   * Query memory entries from the Three-Layer Memory system.
   * Best-effort — returns empty on failure.
   */
  queryMemory(options: MemoryQueryOptions = {}): MemoryItem[] {
    try {
      // Synchronous access to global ThreeLayerMemory (already initialized by core)
      const { getGlobalThreeLayerMemory } = nodeRequire('@praetor/core');
      const memory = getGlobalThreeLayerMemory();
      const entries = memory.querySync({
        keywords: options.keywords,
        importanceThreshold: options.importanceThreshold,
        limit: options.limit,
        layer: options.layer,
      });

      let results = entries
        .filter(
          (e: { layer: string }) =>
            e.layer === 'working' || e.layer === 'episodic' || e.layer === 'longterm',
        )
        .map((e: Record<string, unknown>) => ({
          id: e.id as string,
          content: e.content as string,
          layer: e.layer as 'working' | 'episodic' | 'longterm',
          importance: e.importance as number,
          tags: (e.tags as string[]) ?? [],
          createdAt: e.createdAt as string,
          metadata: (e.metadata as Record<string, unknown>) ?? {},
        }));

      if (options.tags && options.tags.length > 0) {
        results = results.filter((item: MemoryItem) =>
          options.tags!.every((tag) => item.tags.includes(tag)),
        );
      }

      return results;
    } catch (err) {
      reportSilentFailure(err, 'commanderClient:queryMemory');
      return [];
    }
  }

  /**
   * Get memory statistics from the Three-Layer Memory system.
   * Best-effort — returns zeros on failure.
   */
  async getMemoryStats(): Promise<MemoryStats> {
    try {
      const { getGlobalThreeLayerMemory } = await import('@praetor/core');
      const memory = getGlobalThreeLayerMemory();
      const stats = memory.getStats();
      const entries = memory.getAll() as Array<{
        layer: string;
        createdAt: string;
      }>;

      const sdkEntries = entries.filter(
        (e) => e.layer === 'working' || e.layer === 'episodic' || e.layer === 'longterm',
      );

      let oldestEntry = '';
      let newestEntry = '';
      for (const e of sdkEntries) {
        if (!oldestEntry || e.createdAt < oldestEntry) oldestEntry = e.createdAt;
        if (!newestEntry || e.createdAt > newestEntry) newestEntry = e.createdAt;
      }

      return {
        workingCount: stats.byLayer.working ?? 0,
        episodicCount: stats.byLayer.episodic ?? 0,
        longTermCount: stats.byLayer.longterm ?? 0,
        totalCount: stats.totalEntries,
        oldestEntry,
        newestEntry,
      };
    } catch (err) {
      reportSilentFailure(err, 'commanderClient:getMemoryStats');
      return {
        workingCount: 0,
        episodicCount: 0,
        longTermCount: 0,
        totalCount: 0,
        oldestEntry: '',
        newestEntry: '',
      };
    }
  }

  // ==========================================================================
  // Events
  // ==========================================================================

  /**
   * Dispatch an execution event to all registered handlers (best-effort).
   * Errors thrown by individual handlers are swallowed so one failing handler
   * cannot disrupt event delivery to the others.
   */
  private dispatchEvent(event: ExecutionEvent): void {
    this.eventHandlers.forEach((h) => {
      try {
        h(event);
      } catch {
        /* best-effort: swallow handler errors */
      }
    });
  }

  onEvent(handler: (event: ExecutionEvent) => void): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  // ==========================================================================
  // Session History
  // ==========================================================================

  listSessions(): SessionSummary[] {
    return [...this.sessions].sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );
  }

  // ==========================================================================
  // System Status
  // ==========================================================================

  /**
   * Alias for `getMemoryStats()` — returns live statistics from the Three-Layer
   * Memory system. Previously returned hard-coded zeros; now backed by real
   * `getGlobalThreeLayerMemory()` lookups.
   */
  getStats(): Promise<MemoryStats> {
    return this.getMemoryStats();
  }

  async getStatus(): Promise<SystemStatus> {
    this.ensureConnected();
    const coreStatus = this.commander!.getStatus();
    return {
      provider: this.config.provider ?? (coreStatus.provider as string) ?? 'auto',
      model: this.config.model ?? (coreStatus.model as string) ?? 'auto',
      uptime: coreStatus.uptime as string,
      totalRuns: this.runCount,
      activeSessions: this.activeSessions,
      memoryUsage: process.memoryUsage().heapUsed,
      topologyDefaults: this.config.defaultTopology ?? ('SINGLE' as Topology),
      agentCount: this.agents.size,
    };
  }

  /**
   * Get reliability statistics from the runtime's ReliabilityEngine.
   * Covers circuit breaker state, dead-letter queue, compensations, and checkpoints.
   * Best-effort — returns zeros when not connected or on failure.
   */
  async getReliabilityStats(): Promise<SDKReliabilityStats> {
    try {
      if (!this.commander) {
        return {
          circuitState: 'CLOSED',
          circuitFailures: 0,
          dlqTotalEntries: 0,
          pendingCompensations: 0,
          checkpointCount: 0,
        };
      }
      const engine = this.commander.getRuntime().getReliabilityEngine();
      const stats = await engine.getStats();
      return {
        circuitState: stats.circuit.state,
        circuitFailures: stats.circuit.failureCount,
        dlqTotalEntries: stats.dlq.reduce((sum, c) => sum + c.count, 0),
        pendingCompensations: stats.compensation.pending,
        checkpointCount: stats.checkpointCount,
      };
    } catch (err) {
      reportSilentFailure(err, 'commanderClient:getReliabilityStats');
      return {
        circuitState: 'CLOSED',
        circuitFailures: 0,
        dlqTotalEntries: 0,
        pendingCompensations: 0,
        checkpointCount: 0,
      };
    }
  }

  // ==========================================================================
  // Private helpers
  // ==========================================================================

  private ensureConnected(): void {
    if (!this.connected || !this.commander) {
      throw new Error('CommanderClient not connected. Call client.connect() first.');
    }
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Quick-start: create and connect a CommanderClient in one call.
 */
export async function createClient(config?: CommanderClientConfig): Promise<CommanderClient> {
  const client = new CommanderClient(config);
  await client.connect();
  return client;
}

export const PraetorClient = CommanderClient;

