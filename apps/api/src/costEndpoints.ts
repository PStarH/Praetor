import { Router } from 'express';
import { getUnifiedCostAuthority } from '@praetor/core';
import { getCurrentTenantId } from '@praetor/core/runtime/tenantContext';
import type { CostSummary, CostRecord, BudgetAlert, CostLedgerEntry } from '@praetor/core';

function ledgerEntryToCostRecord(entry: CostLedgerEntry): CostRecord {
  return {
    runId: entry.runId,
    modelId: entry.modelOrTool,
    provider: 'unknown',
    tier: 'standard',
    inputTokens: entry.promptTokens ?? 0,
    outputTokens: entry.completionTokens ?? 0,
    totalTokens: (entry.promptTokens ?? 0) + (entry.completionTokens ?? 0),
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: Math.round(entry.actualCostUsd * 100000) / 100000,
    cacheSavingsUsd: 0,
    timestamp: entry.timestamp,
    agentId: 'unknown',
  };
}

/**
 * Match a ledger entry to the requesting tenant.
 *
 * Entries without an explicit tenantId belong only to the legacy/default
 * context. This preserves single-tenant compatibility without projecting a
 * legacy row into every authenticated tenant.
 */
export function entryMatchesTenant(entry: CostLedgerEntry, tenantId: string | undefined): boolean {
  // Untagged legacy entries belong only to the single-tenant/default context.
  // Never project them into every authenticated tenant.
  if (!entry.tenantId) {
    return (
      tenantId === undefined || tenantId === (process.env.COMMANDER_DEFAULT_TENANT_ID ?? 'local')
    );
  }
  return entry.tenantId === tenantId;
}

export function createCostRouter(): Router {
  const router = Router();

  // ── Cost summary (total, per-model, per-agent) ─────────────────────────
  router.get('/api/cost/summary', (_req, res) => {
    const tenantId = getCurrentTenantId();
    const uca = getUnifiedCostAuthority();
    const ledger = uca.readLedger().filter((e) => entryMatchesTenant(e, tenantId));
    const summary: CostSummary = {
      totalCostUsd: 0,
      totalTokens: 0,
      totalCalls: ledger.length,
      perModel: {},
      perAgent: {},
    };

    for (const entry of ledger) {
      summary.totalCostUsd += entry.actualCostUsd;
      summary.totalTokens += (entry.promptTokens ?? 0) + (entry.completionTokens ?? 0);

      if (!summary.perModel[entry.modelOrTool]) {
        summary.perModel[entry.modelOrTool] = { calls: 0, tokens: 0, costUsd: 0 };
      }
      summary.perModel[entry.modelOrTool].calls++;
      summary.perModel[entry.modelOrTool].tokens +=
        (entry.promptTokens ?? 0) + (entry.completionTokens ?? 0);
      summary.perModel[entry.modelOrTool].costUsd += entry.actualCostUsd;
    }

    summary.totalCostUsd = Math.round(summary.totalCostUsd * 100) / 100;
    for (const key of Object.keys(summary.perModel)) {
      summary.perModel[key].costUsd = Math.round(summary.perModel[key].costUsd * 100) / 100;
    }

    res.json(summary);
  });

  // ── Cost records (recent LLM calls) ────────────────────────────────────
  router.get('/api/cost/records', (req, res) => {
    const tenantId = getCurrentTenantId();
    const uca = getUnifiedCostAuthority();
    const requestedLimit = req.query.limit;
    const limit =
      typeof requestedLimit === 'string' && /^[1-9][0-9]*$/.test(requestedLimit)
        ? Math.min(Number(requestedLimit), 500)
        : 50;
    const rawRunId = req.query.runId;
    const runId =
      typeof rawRunId === 'string' && /^[a-zA-Z0-9_-]+$/.test(rawRunId) && rawRunId.length < 128
        ? rawRunId
        : undefined;

    let entries = uca.readLedger().filter((e) => entryMatchesTenant(e, tenantId));
    if (runId) {
      entries = entries.filter((e) => e.runId === runId);
    }
    const records: CostRecord[] = entries
      .map(ledgerEntryToCostRecord)
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, limit);

    res.json({ records, total: records.length });
  });

  // ── Budget status (monthly usage + alerts) ─────────────────────────────
  router.get('/api/cost/budget', (_req, res) => {
    const tenantId = getCurrentTenantId();
    const uca = getUnifiedCostAuthority();
    const snapshot = uca.getSnapshot('cost-api', tenantId);
    const monthlyUsed = snapshot.perTenantMonthly.used;
    const monthlyLimit = snapshot.perTenantMonthly.cap;
    const alerts: BudgetAlert[] = [];

    res.json({
      monthlyUsed,
      monthlyLimit,
      usagePercent: monthlyLimit > 0 ? Math.round((monthlyUsed / monthlyLimit) * 100) : 0,
      alertCount: alerts.length,
      alerts,
    });
  });

  return router;
}
