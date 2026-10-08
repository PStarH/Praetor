import { before, after, beforeEach, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';

import { getMetricsCollector } from '@praetor/core';
import {
  runWithTenant,
  getTokenGovernor,
  getTenantFairnessMonitor,
  getTenantManager,
  resetTokenGovernor,
  resetTenantFairnessMonitor,
  resetTenantManager,
} from '@praetor/core/runtime';
import { recordTenantMetricUsage, resetTenantMetricsStore } from '../src/tenantMetricsStore';
import { exportTenantMetrics } from '../src/tenantMetricsExporter';

describe('/metrics tenant label control', () => {
  let app: express.Express;
  let server: ReturnType<typeof app.listen>;
  let baseUrl: string;
  // F-A-14: COMMANDER_LEGACY_EXECUTION was set in beforeEach with no restore.
  let savedLegacyExecution: string | undefined;

  before(async () => {
    app = express();
    app.get('/metrics', (_req, res) => {
      const tenantMetrics = exportTenantMetrics(process.env.METRICS_TENANT_LABELS === 'true');
      res
        .type('text/plain; version=0.0.4')
        .send(getMetricsCollector().exportOpenMetrics() + tenantMetrics);
    });
    server = app.listen(0);
    await new Promise<void>((resolve) => server.on('listening', resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    // Force-close any lingering keep-alive connections so server.close() can resolve.
    if (
      'closeAllConnections' in server &&
      typeof (server as any).closeAllConnections === 'function'
    ) {
      (server as any).closeAllConnections();
    }
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  beforeEach(() => {
    // F-A-14: save/restore the legacy-execution flag so this suite does not
    // leak global env into later tests in the same process.
    if (savedLegacyExecution === undefined)
      savedLegacyExecution = process.env.COMMANDER_LEGACY_EXECUTION;
    process.env.COMMANDER_LEGACY_EXECUTION = '1';
    delete process.env.METRICS_TENANT_LABELS;
    getMetricsCollector().reset();
    resetTenantMetricsStore();
    resetTokenGovernor();
    resetTenantFairnessMonitor();
    resetTenantManager();
  });

  afterEach(() => {
    if (savedLegacyExecution === undefined) delete process.env.COMMANDER_LEGACY_EXECUTION;
    else process.env.COMMANDER_LEGACY_EXECUTION = savedLegacyExecution;
    savedLegacyExecution = undefined;
  });

  function seedTenant(tenantId: string, runs: number, tokens: number, durationMs: number) {
    recordTenantMetricUsage(tenantId, { totalRuns: runs, durationMs });
    runWithTenant(tenantId, () => {
      getTokenGovernor().reportUsage(tokens);
    });
    for (let i = 0; i < runs; i++) {
      getTenantFairnessMonitor().recordCompletion(tenantId);
    }
  }

  it('includes tenant labels when METRICS_TENANT_LABELS=true', async () => {
    process.env.METRICS_TENANT_LABELS = 'true';
    seedTenant('tenant-a', 2, 400, 1500);
    seedTenant('tenant-b', 1, 200, 800);

    const res = await fetch(`${baseUrl}/metrics`);
    assert.equal(res.status, 200);
    const body = await res.text();

    assert.match(body, /commander_tenant_runs_total\{tenant="tenant-a"\} 2/);
    assert.match(body, /commander_tenant_runs_total\{tenant="tenant-b"\} 1/);
    assert.match(body, /commander_tenant_tokens_total\{tenant="tenant-a"\} 400/);
    assert.match(body, /commander_tenant_tokens_total\{tenant="tenant-b"\} 200/);
    assert.match(body, /commander_tenant_latency_seconds_bucket\{tenant="tenant-a"/);
    assert.match(body, /commander_tenant_storage_bytes\{tenant="tenant-a"\} 0/);
    assert.match(body, /commander_tenant_jain_fairness_index [\d.]+/);
  });

  it('omits tenant labels by default', async () => {
    seedTenant('tenant-a', 2, 400, 1500);
    seedTenant('tenant-b', 1, 200, 800);

    const res = await fetch(`${baseUrl}/metrics`);
    assert.equal(res.status, 200);
    const body = await res.text();

    assert.match(body, /commander_tenant_runs_total [\d.]+/);
    assert.match(body, /commander_tenant_tokens_total [\d.]+/);
    assert.doesNotMatch(body, /tenant="tenant-a"/);
    assert.doesNotMatch(body, /tenant="tenant-b"/);
  });

  it('aggregates values when tenant labels are disabled', async () => {
    seedTenant('tenant-a', 2, 400, 1500);
    seedTenant('tenant-b', 1, 200, 800);

    const res = await fetch(`${baseUrl}/metrics`);
    const body = await res.text();

    assert.match(body, /commander_tenant_runs_total 3/);
    assert.match(body, /commander_tenant_tokens_total 600/);
    assert.match(body, /commander_tenant_latency_seconds_count 2/);
  });
});
