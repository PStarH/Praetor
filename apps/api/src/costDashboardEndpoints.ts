/**
 * costDashboardEndpoints — cost analytics dashboard router.
 *
 * Addresses "cost anxiety" — the #1 pain point for enterprise users who worry
 * about runaway LLM API costs. Provides LangSmith-style granular cost reporting
 * aggregated by model, tool, user, and time period.
 *
 * Endpoint:
 *   GET /api/cost/dashboard?timeRange=today|7d|30d|all
 *
 * Data source: the configured trace directory (see
 * `@praetor/core/runtime/traceStore#resolveConfiguredTraceBase`) —
 * `<base>/tenant_<tenantId>/*.ndjson` when a tenant context is present,
 * `<base>/*.ndjson` otherwise. Each trace event of type
 * `llm_call` carries `data.modelInfo` (provider, model, tier) and
 * `data.tokenUsage` (promptTokens, completionTokens, totalTokens). Cost is
 * calculated from token usage using a built-in pricing table. If no cost data
 * is found in traces, an empty structure is returned.
 */
import { reportSilentFailure } from '@praetor/core';
import { getCurrentTenantId } from '@praetor/core/runtime/tenantContext';
import { resolveConfiguredTraceBase, resolveTraceDir } from '@praetor/core/runtime/traceStore';
import { Router, type Request, type Response } from 'express';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { toErrorMessage } from './routeHelpers';

// ── Types ─────────────────────────────────────────────────────────────────

export type CostTimeRange = 'today' | '7d' | '30d' | 'all';

export interface ModelPricing {
  inputPer1k: number;
  outputPer1k: number;
  cachedInputPer1k?: number;
}

interface ModelCostEntry {
  model: string;
  provider: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  costUsd: number;
  percentage: number;
}

interface ToolCostEntry {
  tool: string;
  calls: number;
  tokens: number;
  costUsd: number;
  percentage: number;
}

interface UserCostEntry {
  userId: string;
  calls: number;
  costUsd: number;
  percentage: number;
}

interface TrendPoint {
  timestamp: string;
  cost: number;
  tokens: number;
}

interface CostDashboardSummary {
  totalCostUsd: number;
  todayCostUsd: number;
  averageCostPerTask: number;
  cacheSavingsUsd: number;
  totalTasks: number;
  totalTokens: number;
  totalCalls: number;
  peakCostHour: string | null;
}

interface CostDashboardResponse {
  timeRange: CostTimeRange;
  summary: CostDashboardSummary;
  byModel: ModelCostEntry[];
  byTool: ToolCostEntry[];
  byUser: UserCostEntry[];
  trend: TrendPoint[];
}

// ── Pricing table (mirrors @praetor/core costModel defaults) ───

const PRICING_TABLE: Record<string, ModelPricing> = {
  'openai:gpt-4o': { inputPer1k: 0.0025, outputPer1k: 0.01, cachedInputPer1k: 0.00125 },
  'openai:gpt-4o-mini': { inputPer1k: 0.00015, outputPer1k: 0.0006, cachedInputPer1k: 0.000075 },
  'openai:gpt-4-turbo': { inputPer1k: 0.01, outputPer1k: 0.03 },
  'openai:gpt-3.5-turbo': { inputPer1k: 0.0005, outputPer1k: 0.0015 },
  'openai:o1': { inputPer1k: 0.015, outputPer1k: 0.06 },
  'openai:o1-mini': { inputPer1k: 0.003, outputPer1k: 0.012 },
  'openai:o3-mini': { inputPer1k: 0.0011, outputPer1k: 0.0044 },
  'anthropic:claude-3-5-sonnet': {
    inputPer1k: 0.003,
    outputPer1k: 0.015,
    cachedInputPer1k: 0.0003,
  },
  'anthropic:claude-3-5-haiku': {
    inputPer1k: 0.0008,
    outputPer1k: 0.004,
    cachedInputPer1k: 0.00008,
  },
  'anthropic:claude-3-opus': { inputPer1k: 0.015, outputPer1k: 0.075 },
  'google:gemini-1.5-pro': { inputPer1k: 0.00125, outputPer1k: 0.005, cachedInputPer1k: 0.00031 },
  'google:gemini-1.5-flash': {
    inputPer1k: 0.000075,
    outputPer1k: 0.0003,
    cachedInputPer1k: 0.00001875,
  },
  'google:gemini-2.0-flash': { inputPer1k: 0.0001, outputPer1k: 0.0004 },
  'deepseek:deepseek-chat': {
    inputPer1k: 0.00014,
    outputPer1k: 0.00028,
    cachedInputPer1k: 0.000014,
  },
  'deepseek:deepseek-reasoner': { inputPer1k: 0.00014, outputPer1k: 0.00219 },
};

const FALLBACK_PRICING: ModelPricing = { inputPer1k: 0.001, outputPer1k: 0.002 };

export function getPricing(provider: string, model: string): ModelPricing {
  const normalizedProvider = provider.toLowerCase();
  const normalizedModel = model.toLowerCase();
  const key = `${normalizedProvider}:${normalizedModel}`;
  const exact = PRICING_TABLE[key];
  if (exact) return exact;

  // Prefer the most-specific model prefix. Iterating object insertion order
  // made `gpt-4o-mini-2024...` match `gpt-4o` before `gpt-4o-mini`, and did the
  // same for `o1-mini` vs `o1`; dated model ids were therefore silently billed
  // at the wrong rate.
  const candidates = Object.entries(PRICING_TABLE)
    .map(([entry, pricing]) => {
      const [p, m] = entry.split(':');
      return { provider: p, modelPrefix: m, pricing };
    })
    .filter(
      (candidate) =>
        candidate.provider === normalizedProvider &&
        normalizedModel.startsWith(candidate.modelPrefix),
    )
    .sort((a, b) => b.modelPrefix.length - a.modelPrefix.length);
  return candidates[0]?.pricing ?? FALLBACK_PRICING;
}

function calculateCost(
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheTokens: number,
): { costUsd: number; savingsUsd: number } {
  const pricing = getPricing(provider, model);
  const cached = Math.min(cacheTokens, inputTokens);
  const billableInput = Math.max(0, inputTokens - cached);
  const inputCost = (billableInput / 1000) * pricing.inputPer1k;
  const outputCost = (outputTokens / 1000) * pricing.outputPer1k;
  const cachedCost = pricing.cachedInputPer1k ? (cached / 1000) * pricing.cachedInputPer1k : 0;
  const totalCost = inputCost + outputCost + cachedCost;

  // Savings = what the cached tokens would have cost at full input price
  const savings = pricing.cachedInputPer1k
    ? (cached / 1000) * (pricing.inputPer1k - pricing.cachedInputPer1k)
    : 0;

  return { costUsd: totalCost, savingsUsd: savings };
}

// ── Trace event shape ─────────────────────────────────────────────────────

interface TraceEvent {
  id: string;
  spanId: string;
  traceId: string;
  runId: string;
  tenantId?: string;
  agentId: string;
  type: string;
  timestamp: string;
  durationMs: number;
  data: Record<string, unknown>;
  parentSpanId?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Resolve the trace directory for the requesting scope.
 *
 * Uses the same single-owner rule as the trace writer: the configured base
 * (honouring COMMANDER_TRACE_DIR / the legacy COMMANDER_TRACES_DIR alias) plus
 * the canonical `tenant_<id>` segment. Reading the hard-coded cwd path while
 * the writer honoured the configured base made every tenant's dashboard report
 * zero cost in any deployment that configured a trace directory.
 */
function findTracesDir(tenantId?: string): string {
  return resolveTraceDir(resolveConfiguredTraceBase(), tenantId);
}

/**
 * Read a trace NDJSON file.
 *
 * Fail-closed: only a genuinely absent file yields an empty list. Any other
 * read failure (EACCES/EIO/…) propagates so the dashboard answers non-2xx — a
 * permission error must never be rendered as "$0 spent".
 */
async function readNdjsonFile(filePath: string): Promise<TraceEvent[]> {
  // AUDIT-API11: line cap mirrors auditLogEndpoints — every dashboard hit
  // re-reads every trace file; unbounded files were an I/O+heap DoS lever.
  const MAX_LINES_PER_FILE = 200_000;
  let raw: string;
  try {
    raw = await fsp.readFile(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const events: TraceEvent[] = [];
  const lines = trimmed.split('\n');
  for (const line of lines.length > MAX_LINES_PER_FILE ? lines.slice(-MAX_LINES_PER_FILE) : lines) {
    try {
      events.push(JSON.parse(line) as TraceEvent);
    } catch (err) {
      reportSilentFailure(err, 'costDashboardEndpoints:readNdjson');
      throw new Error(`TRACE_DATA_INVALID: malformed NDJSON in ${filePath}`);
    }
  }
  return events;
}

function toNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return 0;
}

/**
 * Returns true when a trace event may be counted for the requesting scope.
 *
 * The *directory* is the authoritative scope: a `tenant_<id>` directory is
 * written only by that tenant's runs, so events inside it that carry no
 * explicit tenantId still belong to that tenant. Events that explicitly carry
 * a different tenant are rejected as defence in depth.
 *
 * When no tenant context exists the shared base is read and only unattributed
 * legacy events are visible — the single-tenant mode this endpoint documents.
 */
function eventMatchesScope(
  event: TraceEvent,
  tenantId: string | undefined,
  tenantScoped: boolean,
): boolean {
  if (event.tenantId) return event.tenantId === tenantId;
  if (tenantScoped) return true;
  return (
    tenantId === undefined || tenantId === (process.env.COMMANDER_DEFAULT_TENANT_ID ?? 'local')
  );
}

function toString(value: unknown, fallback = 'unknown'): string {
  return typeof value === 'string' ? value : fallback;
}

/** Strip @tier suffix from model id (e.g. "claude-3-5-sonnet@eco" → "claude-3-5-sonnet"). */
function stripTierSuffix(model: string): string {
  const idx = model.indexOf('@');
  return idx > 0 ? model.slice(0, idx) : model;
}

function getTimeRangeStart(timeRange: CostTimeRange): number | null {
  const now = Date.now();
  switch (timeRange) {
    case 'today': {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    }
    case '7d':
      return now - 7 * 24 * 60 * 60 * 1000;
    case '30d':
      return now - 30 * 24 * 60 * 60 * 1000;
    case 'all':
      return null;
    default:
      return null;
  }
}

// ── Aggregation ───────────────────────────────────────────────────────────

interface AggregatedLLMCall {
  runId: string;
  agentId: string;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  totalTokens: number;
  costUsd: number;
  savingsUsd: number;
  timestamp: string;
  toolNames: string[];
}

function extractLLMCall(event: TraceEvent): AggregatedLLMCall | null {
  if (event.type !== 'llm_call') return null;

  const data = event.data ?? {};
  const modelInfo = (data.modelInfo ?? {}) as Record<string, unknown>;
  const tokenUsage = (data.tokenUsage ?? (data as Record<string, unknown>).usage ?? {}) as Record<
    string,
    unknown
  >;

  const rawModel = toString(
    modelInfo.model ?? (data.input as Record<string, unknown>)?.model,
    'unknown',
  );
  const model = stripTierSuffix(rawModel);
  const provider = toString(modelInfo.provider, 'unknown');

  const inputTokens = toNumber(tokenUsage.promptTokens ?? tokenUsage.inputTokens);
  const outputTokens = toNumber(tokenUsage.completionTokens ?? tokenUsage.outputTokens);
  const cacheTokens = toNumber(tokenUsage.cacheReadTokens ?? tokenUsage.cachedTokens);
  const totalTokens = toNumber(tokenUsage.totalTokens) || inputTokens + outputTokens;

  const { costUsd, savingsUsd } = calculateCost(
    provider,
    model,
    inputTokens,
    outputTokens,
    cacheTokens,
  );

  // Extract tool calls from the LLM output
  const output = data.output as Record<string, unknown> | undefined;
  const toolCalls = Array.isArray(output?.toolCalls) ? output!.toolCalls : [];
  const toolNames = toolCalls
    .map((tc) => toString((tc as Record<string, unknown>)?.name, 'unknown'))
    .filter((n) => n !== 'unknown');

  return {
    runId: event.runId,
    agentId: event.agentId,
    model,
    provider,
    inputTokens,
    outputTokens,
    cacheTokens,
    totalTokens,
    costUsd,
    savingsUsd,
    timestamp: event.timestamp,
    toolNames,
  };
}

function buildDashboard(
  calls: AggregatedLLMCall[],
  timeRange: CostTimeRange,
): CostDashboardResponse {
  // ── Summary ───────────────────────────────────────────────────────────
  const totalCostUsd = calls.reduce((sum, c) => sum + c.costUsd, 0);
  const cacheSavingsUsd = calls.reduce((sum, c) => sum + c.savingsUsd, 0);
  const totalTokens = calls.reduce((sum, c) => sum + c.totalTokens, 0);
  const totalCalls = calls.length;

  // Unique tasks (runIds)
  const runIds = new Set(calls.map((c) => c.runId));
  const totalTasks = runIds.size;
  const averageCostPerTask = totalTasks > 0 ? totalCostUsd / totalTasks : 0;

  // Today's cost
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();
  const todayCostUsd = calls
    .filter((c) => new Date(c.timestamp).getTime() >= todayMs)
    .reduce((sum, c) => sum + c.costUsd, 0);

  // Peak cost hour
  const hourlyCost = new Map<string, number>();
  for (const call of calls) {
    const ts = new Date(call.timestamp);
    if (isNaN(ts.getTime())) continue;
    const hourKey = ts.toISOString().slice(0, 13); // YYYY-MM-DDTHH
    hourlyCost.set(hourKey, (hourlyCost.get(hourKey) ?? 0) + call.costUsd);
  }
  let peakCostHour: string | null = null;
  let peakCost = 0;
  for (const [hour, cost] of hourlyCost) {
    if (cost > peakCost) {
      peakCost = cost;
      peakCostHour = hour;
    }
  }

  // ── By model ──────────────────────────────────────────────────────────
  const modelMap = new Map<
    string,
    {
      model: string;
      provider: string;
      calls: number;
      inputTokens: number;
      outputTokens: number;
      cacheTokens: number;
      costUsd: number;
    }
  >();
  for (const call of calls) {
    const key = `${call.provider}:${call.model}`;
    const existing = modelMap.get(key) ?? {
      model: call.model,
      provider: call.provider,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheTokens: 0,
      costUsd: 0,
    };
    existing.calls++;
    existing.inputTokens += call.inputTokens;
    existing.outputTokens += call.outputTokens;
    existing.cacheTokens += call.cacheTokens;
    existing.costUsd += call.costUsd;
    modelMap.set(key, existing);
  }
  const byModel: ModelCostEntry[] = Array.from(modelMap.values())
    .sort((a, b) => b.costUsd - a.costUsd)
    .map((m) => ({
      ...m,
      percentage: totalCostUsd > 0 ? (m.costUsd / totalCostUsd) * 100 : 0,
    }));

  // ── By tool ───────────────────────────────────────────────────────────
  const toolMap = new Map<string, { calls: number; tokens: number; costUsd: number }>();
  for (const call of calls) {
    if (call.toolNames.length === 0) {
      // LLM call without tool usage — skip
      continue;
    }
    // Distribute cost evenly among tools called in this LLM turn
    const costPerTool = call.costUsd / call.toolNames.length;
    const tokensPerTool = call.totalTokens / call.toolNames.length;
    for (const toolName of call.toolNames) {
      const existing = toolMap.get(toolName) ?? { calls: 0, tokens: 0, costUsd: 0 };
      existing.calls++;
      existing.tokens += tokensPerTool;
      existing.costUsd += costPerTool;
      toolMap.set(toolName, existing);
    }
  }
  const byTool: ToolCostEntry[] = Array.from(toolMap.entries())
    .map(([tool, data]) => ({
      tool,
      calls: data.calls,
      tokens: Math.round(data.tokens),
      costUsd: data.costUsd,
      percentage: totalCostUsd > 0 ? (data.costUsd / totalCostUsd) * 100 : 0,
    }))
    .sort((a, b) => b.costUsd - a.costUsd);

  // ── By user (agentId used as user proxy) ──────────────────────────────
  const userMap = new Map<string, { calls: number; costUsd: number }>();
  for (const call of calls) {
    const existing = userMap.get(call.agentId) ?? { calls: 0, costUsd: 0 };
    existing.calls++;
    existing.costUsd += call.costUsd;
    userMap.set(call.agentId, existing);
  }
  const byUser: UserCostEntry[] = Array.from(userMap.entries())
    .map(([userId, data]) => ({
      userId,
      calls: data.calls,
      costUsd: data.costUsd,
      percentage: totalCostUsd > 0 ? (data.costUsd / totalCostUsd) * 100 : 0,
    }))
    .sort((a, b) => b.costUsd - a.costUsd);

  // ── Trend (time series) ───────────────────────────────────────────────
  // Bucket by hour for "today", by day for longer ranges
  const bucketByDay = timeRange !== 'today';
  const trendMap = new Map<string, { cost: number; tokens: number }>();
  for (const call of calls) {
    const ts = new Date(call.timestamp);
    if (isNaN(ts.getTime())) continue;
    const bucketKey = bucketByDay
      ? ts.toISOString().slice(0, 10) // YYYY-MM-DD
      : ts.toISOString().slice(0, 13); // YYYY-MM-DDTHH
    const existing = trendMap.get(bucketKey) ?? { cost: 0, tokens: 0 };
    existing.cost += call.costUsd;
    existing.tokens += call.totalTokens;
    trendMap.set(bucketKey, existing);
  }
  const trend: TrendPoint[] = Array.from(trendMap.entries())
    .map(([timestamp, data]) => ({
      timestamp: bucketByDay ? `${timestamp}T00:00:00.000Z` : `${timestamp}:00:00.000Z`,
      cost: data.cost,
      tokens: data.tokens,
    }))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  return {
    timeRange,
    summary: {
      totalCostUsd,
      todayCostUsd,
      averageCostPerTask,
      cacheSavingsUsd,
      totalTasks,
      totalTokens,
      totalCalls,
      peakCostHour,
    },
    byModel,
    byTool,
    byUser,
    trend,
  };
}

// ── Empty response ────────────────────────────────────────────────────────

function emptyDashboard(timeRange: CostTimeRange): CostDashboardResponse {
  return {
    timeRange,
    summary: {
      totalCostUsd: 0,
      todayCostUsd: 0,
      averageCostPerTask: 0,
      cacheSavingsUsd: 0,
      totalTasks: 0,
      totalTokens: 0,
      totalCalls: 0,
      peakCostHour: null,
    },
    byModel: [],
    byTool: [],
    byUser: [],
    trend: [],
  };
}

// ── Router ────────────────────────────────────────────────────────────────

export function createCostDashboardRouter(): Router {
  const router = Router();

  // ── GET /api/cost/dashboard — comprehensive cost analytics ────────────
  router.get('/api/cost/dashboard', async (req: Request, res: Response) => {
    try {
      const tenantId = getCurrentTenantId();
      const rawRange = typeof req.query.timeRange === 'string' ? req.query.timeRange : '7d';
      const timeRange: CostTimeRange =
        rawRange === 'today' || rawRange === '7d' || rawRange === '30d' || rawRange === 'all'
          ? rawRange
          : '7d';

      const tracesDir = findTracesDir(tenantId);
      const tenantScoped = typeof tenantId === 'string' && tenantId.length > 0;
      let files: string[] = [];
      try {
        files = (await fsp.readdir(tracesDir)).filter((f) => f.endsWith('.ndjson'));
      } catch (err) {
        // A missing directory is a legitimate "no data yet" state. Any other
        // failure (EACCES/EIO/ENOTDIR) is propagated so it cannot be reported
        // as a successful zero-cost dashboard.
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }

      if (files.length === 0) {
        return res.json(emptyDashboard(timeRange));
      }

      // Read all trace files in parallel (limit concurrency to avoid FD exhaustion)
      const BATCH_SIZE = 20;
      const allCalls: AggregatedLLMCall[] = [];
      const rangeStart = getTimeRangeStart(timeRange);

      for (let i = 0; i < files.length; i += BATCH_SIZE) {
        const batch = files.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(
          batch.map((file) => readNdjsonFile(path.join(tracesDir, file))),
        );
        for (const events of results) {
          for (const event of events) {
            if (!eventMatchesScope(event, tenantId, tenantScoped)) continue;

            // Filter by time range
            if (rangeStart !== null) {
              const ts = new Date(event.timestamp).getTime();
              if (isNaN(ts) || ts < rangeStart) continue;
            }

            const call = extractLLMCall(event);
            if (call) allCalls.push(call);
          }
        }
      }

      if (allCalls.length === 0) {
        return res.json(emptyDashboard(timeRange));
      }

      const dashboard = buildDashboard(allCalls, timeRange);
      res.json(dashboard);
    } catch (error) {
      reportSilentFailure(error, 'costDashboardEndpoints:dashboard');
      res.status(500).json({ error: toErrorMessage(error) });
    }
  });

  return router;
}
