/**
 * Tenant-level Prometheus metrics exporter.
 *
 * Collects per-tenant operational telemetry from the API-layer runtime registry,
 * the core TokenGovernor, TenantManager, and TenantFairnessMonitor. Tenant
 * labels are opt-in via `METRICS_TENANT_LABELS=true` to protect Prometheus from
 * unbounded cardinality.
 *
 * Only tenants with activity in the last 24 hours are emitted, capped at 100.
 */
import {
  getGlobalTenantProvider,
  getTokenGovernor,
  getTenantManager,
  getTenantFairnessMonitor,
  runWithTenant,
  type TenantConfig,
} from '@praetor/core/runtime';
import { getTenantMetricStats, getTenantRunDurations } from './tenantMetricsStore';

const ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_TENANTS = 100;

/** Histogram buckets for tenant run latency in seconds. */
const LATENCY_BUCKETS_SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

interface TenantMetricData {
  tenantId: string;
  totalRuns: number;
  usedTokens: number;
  durationsMs: number[];
  storageBytes: number;
  lastUsedAt: number;
}

function toOpenMetricsLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return '';
  return (
    '{' +
    entries
      .map(([k, v]) => `${k}="${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
      .join(',') +
    '}'
  );
}

function formatLine(name: string, value: number, labels: Record<string, string>): string {
  return `${name}${toOpenMetricsLabels(labels)} ${Number.isFinite(value) ? value : 0}`;
}

function buildHistogramLines(
  name: string,
  durationsSeconds: number[],
  labels: Record<string, string>,
): string[] {
  const sorted = durationsSeconds.filter((d) => Number.isFinite(d) && d >= 0).sort((a, b) => a - b);
  const lines: string[] = [];
  let cumulative = 0;
  let index = 0;
  for (const bucket of LATENCY_BUCKETS_SECONDS) {
    while (index < sorted.length && sorted[index] <= bucket) {
      cumulative++;
      index++;
    }
    lines.push(formatLine(`${name}_bucket`, cumulative, { ...labels, le: String(bucket) }));
  }
  lines.push(formatLine(`${name}_bucket`, sorted.length, { ...labels, le: '+Inf' }));
  const sum = sorted.reduce((a, b) => a + b, 0);
  lines.push(formatLine(`${name}_sum`, sum, labels));
  lines.push(formatLine(`${name}_count`, sorted.length, labels));
  return lines;
}

function collectTenantData(): TenantMetricData[] {
  const now = Date.now();
  const provider = getGlobalTenantProvider();
  const fairness = getTenantFairnessMonitor();
  const tenantManager = getTenantManager();
  const runtimeStats = getTenantMetricStats();

  const activeSet = new Map<string, number>();
  for (const stat of runtimeStats) {
    if (stat.tenantId === 'global') continue;
    const age = now - stat.lastUsedAt;
    if (age <= ACTIVE_WINDOW_MS) {
      activeSet.set(stat.tenantId, Math.max(activeSet.get(stat.tenantId) ?? 0, stat.lastUsedAt));
    }
  }
  for (const tenantId of fairness.getActiveTenantIds()) {
    activeSet.set(tenantId, Math.max(activeSet.get(tenantId) ?? 0, now));
  }

  let tenants = Array.from(activeSet.entries())
    .map(([tenantId, lastUsedAt]) => ({ tenantId, lastUsedAt }))
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    .slice(0, MAX_TENANTS);

  return tenants.map(({ tenantId }) => {
    const stat = runtimeStats.find((s) => s.tenantId === tenantId);
    const cfg: TenantConfig | undefined = provider.getTenantConfig(tenantId);
    const usedTokens = runWithTenant(tenantId, () => getTokenGovernor().getState().usedTokens);
    return {
      tenantId,
      totalRuns: stat?.totalRuns ?? 0,
      usedTokens,
      durationsMs: getTenantRunDurations(tenantId),
      storageBytes: tenantManager.getTenantStorageBytes(tenantId, cfg),
      lastUsedAt: stat?.lastUsedAt ?? now,
    };
  });
}

function emitMetric(
  lines: string[],
  name: string,
  help: string,
  type: 'counter' | 'gauge' | 'histogram',
): void {
  lines.push(`# HELP ${name} ${help}`);
  lines.push(`# TYPE ${name} ${type}`);
}

/**
 * Export tenant-level OpenMetrics text.
 *
 * When `includeTenantLabels` is false, the metrics are aggregated across active
 * tenants and emitted without the `tenant` label. When true, each active tenant
 * gets its own labelled series.
 */
export function exportTenantMetrics(includeTenantLabels = false): string {
  const tenants = collectTenantData();
  const lines: string[] = [];

  emitMetric(lines, 'commander_tenant_runs_total', 'Total runs per tenant', 'counter');
  if (includeTenantLabels) {
    for (const t of tenants) {
      lines.push(formatLine('commander_tenant_runs_total', t.totalRuns, { tenant: t.tenantId }));
    }
  } else {
    const total = tenants.reduce((sum, t) => sum + t.totalRuns, 0);
    lines.push(formatLine('commander_tenant_runs_total', total, {}));
  }

  emitMetric(lines, 'commander_tenant_tokens_total', 'Total tokens consumed per tenant', 'counter');
  if (includeTenantLabels) {
    for (const t of tenants) {
      lines.push(formatLine('commander_tenant_tokens_total', t.usedTokens, { tenant: t.tenantId }));
    }
  } else {
    const total = tenants.reduce((sum, t) => sum + t.usedTokens, 0);
    lines.push(formatLine('commander_tenant_tokens_total', total, {}));
  }

  emitMetric(
    lines,
    'commander_tenant_latency_seconds',
    'Run latency distribution per tenant',
    'histogram',
  );
  if (includeTenantLabels) {
    for (const t of tenants) {
      lines.push(
        ...buildHistogramLines(
          'commander_tenant_latency_seconds',
          t.durationsMs.map((d) => d / 1000),
          { tenant: t.tenantId },
        ),
      );
    }
  } else {
    const allDurations = tenants.flatMap((t) => t.durationsMs.map((d) => d / 1000));
    lines.push(...buildHistogramLines('commander_tenant_latency_seconds', allDurations, {}));
  }

  emitMetric(lines, 'commander_tenant_storage_bytes', 'On-disk storage bytes per tenant', 'gauge');
  if (includeTenantLabels) {
    for (const t of tenants) {
      lines.push(
        formatLine('commander_tenant_storage_bytes', t.storageBytes, { tenant: t.tenantId }),
      );
    }
  } else {
    const total = tenants.reduce((sum, t) => sum + t.storageBytes, 0);
    lines.push(formatLine('commander_tenant_storage_bytes', total, {}));
  }

  emitMetric(
    lines,
    'commander_tenant_jain_fairness_index',
    "Jain's fairness index across tenant run shares",
    'gauge',
  );
  const jain = getTenantFairnessMonitor().getJainIndex();
  lines.push(formatLine('commander_tenant_jain_fairness_index', jain, {}));

  if (lines.length === 0) return '';
  return lines.join('\n') + '\n';
}
