/**
 * LM-26 — trace directory / read-status consistency.
 *
 * The trace *writer* (PersistentTraceStore) and every trace *reader* exposed by
 * the API (lineage, hallucination, cost dashboard) must resolve the same base
 * directory and the same per-tenant segment. Before the fix the writer ignored
 * COMMANDER_TRACE_DIR entirely, the observability reader honoured only the
 * singular spelling, and the tenant storage accountant honoured only the plural
 * spelling — so a deployment that configured a trace directory silently wrote
 * traces to one path and read them from another.
 *
 * These tests drive the real writer and the real HTTP readers; they never touch
 * a real deployment directory (only owned temp dirs) and never start index.ts.
 */
import { after, before, beforeEach, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { tenantContextMiddleware } from '../src/tenantContextMiddleware';
import { createLineageRouter } from '../src/lineageEndpoints';
import { createHallucinationRouter } from '../src/hallucinationEndpoints';
import { createCostDashboardRouter } from '../src/costDashboardEndpoints';
import {
  PersistentTraceStore,
  resolveConfiguredTraceBase,
  resolveTraceDir,
  TraceConfigError,
} from '@praetor/core/runtime/traceStore';

interface TraceEventShape {
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
}

const TS = '2026-01-01T00:00:00.000Z';

function spawnEvent(runId: string, tenantId?: string, instanceSuffix = ''): TraceEventShape {
  const instanceId = `root-${runId}${instanceSuffix}`;
  return {
    id: `spawn-${runId}${instanceSuffix}`,
    spanId: `span-${runId}${instanceSuffix}`,
    traceId: `trace-${runId}`,
    runId,
    tenantId,
    agentId: instanceId,
    type: 'agent.spawn',
    timestamp: TS,
    durationMs: 0,
    data: { instanceId, agentId: instanceId },
  };
}

function hallucinationEvent(runId: string, tenantId?: string): TraceEventShape {
  return {
    id: `hal-${runId}`,
    spanId: `span-hal-${runId}`,
    traceId: `trace-${runId}`,
    runId,
    tenantId,
    agentId: `root-${runId}`,
    type: 'verification',
    timestamp: TS,
    durationMs: 0,
    data: { evaluationScore: 0.9, evaluationPassed: false },
  };
}

function llmCallEvent(runId: string, model: string, tenantId?: string): TraceEventShape {
  return {
    id: `llm-${runId}`,
    spanId: `span-llm-${runId}`,
    traceId: `trace-${runId}`,
    runId,
    tenantId,
    agentId: 'agent-1',
    type: 'llm_call',
    timestamp: TS,
    durationMs: 10,
    data: {
      modelInfo: { provider: 'openai', model },
      tokenUsage: { promptTokens: 1000, completionTokens: 0, totalTokens: 1000 },
      output: { toolCalls: [] },
    },
  };
}

function writeNdjson(filePath: string, events: TraceEventShape[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

// ── Suite 1 — the pure resolver contract ────────────────────────────────────

describe('resolveConfiguredTraceBase', () => {
  it('falls back to <cwd>/.commander_traces when nothing is configured', () => {
    assert.equal(resolveConfiguredTraceBase({}, '/app'), '/app/.commander_traces');
  });

  it('treats blank and whitespace-only values as unset', () => {
    assert.equal(
      resolveConfiguredTraceBase({ COMMANDER_TRACE_DIR: '', COMMANDER_TRACES_DIR: '   ' }, '/app'),
      '/app/.commander_traces',
    );
  });

  it('honours the singular spelling used by the helm chart', () => {
    assert.equal(
      resolveConfiguredTraceBase({ COMMANDER_TRACE_DIR: '/var/traces' }, '/app'),
      '/var/traces',
    );
  });

  it('honours the plural legacy alias', () => {
    assert.equal(
      resolveConfiguredTraceBase({ COMMANDER_TRACES_DIR: '/var/traces' }, '/app'),
      '/var/traces',
    );
  });

  it('accepts both aliases when they agree', () => {
    assert.equal(
      resolveConfiguredTraceBase(
        { COMMANDER_TRACE_DIR: '/var/traces', COMMANDER_TRACES_DIR: '/var/traces/' },
        '/app',
      ),
      '/var/traces',
    );
  });

  it('fails closed when the aliases disagree instead of picking one', () => {
    assert.throws(
      () =>
        resolveConfiguredTraceBase(
          { COMMANDER_TRACE_DIR: '/var/traces', COMMANDER_TRACES_DIR: '/other/traces' },
          '/app',
        ),
      (err: unknown) => err instanceof TraceConfigError && err.code === 'TRACE_CONFIG_CONFLICT',
    );
  });

  it('composes the canonical tenant segment used by the writer', () => {
    assert.equal(resolveTraceDir('/var/traces', 'tenant-a'), '/var/traces/tenant_tenant-a');
    assert.equal(resolveTraceDir('/var/traces', undefined), '/var/traces');
  });
});

// ── Suite 2 — writer and readers agree, end to end over HTTP ────────────────

describe('trace reader/writer directory agreement', () => {
  const originalCwd = process.cwd();
  const originalEnv = {
    trace: process.env.COMMANDER_TRACE_DIR,
    traces: process.env.COMMANDER_TRACES_DIR,
  };
  let tmpRoot: string;
  let workDir: string;
  let tracesBase: string;
  let server: ReturnType<express.Express['listen']>;
  let baseUrl: string;

  before(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cmdr-trace-consistency-'));
    workDir = path.join(tmpRoot, 'cwd');
    tracesBase = path.join(tmpRoot, 'configured-traces');
    fs.mkdirSync(workDir, { recursive: true });
    fs.mkdirSync(tracesBase, { recursive: true });

    const app = express();
    app.use(tenantContextMiddleware);
    app.use(createLineageRouter());
    app.use(createHallucinationRouter());
    app.use(createCostDashboardRouter());
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.on('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (originalEnv.trace === undefined) delete process.env.COMMANDER_TRACE_DIR;
    else process.env.COMMANDER_TRACE_DIR = originalEnv.trace;
    if (originalEnv.traces === undefined) delete process.env.COMMANDER_TRACES_DIR;
    else process.env.COMMANDER_TRACES_DIR = originalEnv.traces;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    process.chdir(workDir);
    fs.rmSync(tracesBase, { recursive: true, force: true });
    fs.mkdirSync(tracesBase, { recursive: true });
    fs.rmSync(path.join(workDir, '.commander_traces'), { recursive: true, force: true });
    // Only the configured directory is set: the writer must honour it.
    process.env.COMMANDER_TRACE_DIR = tracesBase;
    delete process.env.COMMANDER_TRACES_DIR;
  });

  afterEach(() => {
    process.chdir(originalCwd);
  });

  it('writes traces into the configured directory, not the process cwd', () => {
    const store = new PersistentTraceStore();
    store.append(spawnEvent('run-cfg') as never);
    store.flush('run-cfg');

    assert.ok(
      fs.existsSync(path.join(tracesBase, 'run-cfg.ndjson')),
      'writer must honour COMMANDER_TRACE_DIR',
    );
    assert.equal(
      fs.existsSync(path.join(workDir, '.commander_traces', 'run-cfg.ndjson')),
      false,
      'writer must not silently fall back to <cwd>/.commander_traces',
    );
  });

  it('lets lineage, hallucination and cost readers see what the writer wrote', async () => {
    const store = new PersistentTraceStore(undefined, 'tenant-a');
    store.append(spawnEvent('run-a', 'tenant-a') as never);
    store.append(hallucinationEvent('run-a', 'tenant-a') as never);
    store.append(llmCallEvent('run-a', 'gpt-4o-mini', 'tenant-a') as never);
    store.flush('run-a');

    const headers = { 'X-Tenant-ID': 'tenant-a' };

    const lineage = await fetch(`${baseUrl}/api/lineage/runs/run-a`, { headers });
    assert.equal(lineage.status, 200);
    assert.equal(((await lineage.json()) as { totalNodes: number }).totalNodes, 1);

    const hallucination = await fetch(`${baseUrl}/api/hallucination/runs/run-a`, { headers });
    assert.equal(hallucination.status, 200);
    assert.equal(((await hallucination.json()) as { total: number }).total, 1);

    const cost = await fetch(`${baseUrl}/api/cost/dashboard?timeRange=all`, { headers });
    assert.equal(cost.status, 200);
    assert.equal(
      ((await cost.json()) as { summary: { totalCalls: number } }).summary.totalCalls,
      1,
    );
  });

  it('isolates tenants by directory and never merges the shared base', async () => {
    // Same runId under two tenants, plus an unattributed legacy record in the
    // shared base that no tenant-scoped reader may see.
    writeNdjson(path.join(tracesBase, 'tenant_tenant-a', 'shared-run.ndjson'), [
      spawnEvent('shared-run', 'tenant-a'),
    ]);
    writeNdjson(path.join(tracesBase, 'tenant_tenant-b', 'shared-run.ndjson'), [
      spawnEvent('shared-run', 'tenant-b'),
      spawnEvent('shared-run', 'tenant-b', '-child'),
    ]);
    writeNdjson(path.join(tracesBase, 'legacy-run.ndjson'), [spawnEvent('legacy-run')]);

    const a = await fetch(`${baseUrl}/api/lineage/runs/shared-run`, {
      headers: { 'X-Tenant-ID': 'tenant-a' },
    });
    assert.equal(a.status, 200);
    assert.equal(((await a.json()) as { totalNodes: number }).totalNodes, 1);

    const b = await fetch(`${baseUrl}/api/lineage/runs/shared-run`, {
      headers: { 'X-Tenant-ID': 'tenant-b' },
    });
    assert.equal(b.status, 200);
    assert.equal(((await b.json()) as { totalNodes: number }).totalNodes, 2);

    // A tenant-scoped reader must not fall back to the shared base.
    const legacyFromTenant = await fetch(`${baseUrl}/api/lineage/runs/legacy-run`, {
      headers: { 'X-Tenant-ID': 'tenant-a' },
    });
    assert.equal(legacyFromTenant.status, 200);
    assert.equal(((await legacyFromTenant.json()) as { totalNodes: number }).totalNodes, 0);

    // Single-tenant (no tenant context) reads the shared base.
    const legacyUnscoped = await fetch(`${baseUrl}/api/lineage/runs/legacy-run`);
    assert.equal(legacyUnscoped.status, 200);
    assert.equal(((await legacyUnscoped.json()) as { totalNodes: number }).totalNodes, 1);
  });

  it('reports a read failure as an error, never as an empty/zero result', async () => {
    const file = path.join(tracesBase, 'tenant_tenant-a', 'denied.ndjson');
    writeNdjson(file, [spawnEvent('denied', 'tenant-a')]);
    const deniedDir = path.join(tracesBase, 'tenant_tenant-b');
    const costFile = path.join(deniedDir, 'x.ndjson');
    writeNdjson(costFile, [spawnEvent('x', 'tenant-b')]);
    fs.chmodSync(file, 0o000);
    fs.chmodSync(costFile, 0o000);

    try {
      const lineage = await fetch(`${baseUrl}/api/lineage/runs/denied`, {
        headers: { 'X-Tenant-ID': 'tenant-a' },
      });
      assert.equal(lineage.status, 500);

      const hallucination = await fetch(`${baseUrl}/api/hallucination/runs/denied`, {
        headers: { 'X-Tenant-ID': 'tenant-a' },
      });
      assert.equal(hallucination.status, 500);

      // A trace whose bytes cannot be read must not be rendered as "$0 spent".
      const cost = await fetch(`${baseUrl}/api/cost/dashboard?timeRange=all`, {
        headers: { 'X-Tenant-ID': 'tenant-b' },
      });
      assert.equal(cost.status, 500);
    } finally {
      for (const f of [file, costFile]) {
        if (fs.existsSync(f)) fs.chmodSync(f, 0o600);
      }
    }
  });

  it('keeps a missing directory as a legitimate empty result', async () => {
    const lineage = await fetch(`${baseUrl}/api/lineage/runs/absent`, {
      headers: { 'X-Tenant-ID': 'tenant-none' },
    });
    assert.equal(lineage.status, 200);
    assert.equal(((await lineage.json()) as { totalNodes: number }).totalNodes, 0);

    const cost = await fetch(`${baseUrl}/api/cost/dashboard?timeRange=all`, {
      headers: { 'X-Tenant-ID': 'tenant-none' },
    });
    assert.equal(cost.status, 200);
    assert.equal(
      ((await cost.json()) as { summary: { totalCalls: number } }).summary.totalCalls,
      0,
    );
  });
});

// ── Suite 3 — cost pricing prefix selection ─────────────────────────────────

describe('cost dashboard model pricing selection', () => {
  const originalCwd = process.cwd();
  const originalEnv = process.env.COMMANDER_TRACE_DIR;
  let tmpRoot: string;
  let server: ReturnType<express.Express['listen']>;
  let baseUrl: string;

  before(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cmdr-trace-pricing-'));
    const app = express();
    app.use(tenantContextMiddleware);
    app.use(createCostDashboardRouter());
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.on('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.chdir(originalCwd);
    if (originalEnv === undefined) delete process.env.COMMANDER_TRACE_DIR;
    else process.env.COMMANDER_TRACE_DIR = originalEnv;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  /** Total cost reported for a single 1000-input-token llm_call of `model`. */
  async function costFor(model: string): Promise<number> {
    const dir = path.join(tmpRoot, 'tenant_tenant-a');
    fs.rmSync(dir, { recursive: true, force: true });
    writeNdjson(path.join(dir, 'pricing.ndjson'), [llmCallEvent('pricing', model, 'tenant-a')]);
    process.env.COMMANDER_TRACE_DIR = tmpRoot;
    process.chdir(tmpRoot);
    const res = await fetch(`${baseUrl}/api/cost/dashboard?timeRange=all`, {
      headers: { 'X-Tenant-ID': 'tenant-a' },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { summary: { totalCostUsd: number; totalCalls: number } };
    assert.equal(body.summary.totalCalls, 1);
    return body.summary.totalCostUsd;
  }

  it('bills a dated mini model at the mini rate, not the parent family rate', async () => {
    // gpt-4o-mini is 0.00015/1k input; gpt-4o is 0.0025/1k input. A first-match
    // prefix scan hit "gpt-4o" first and over-billed by ~17x.
    const cost = await costFor('gpt-4o-mini-2024-07-18');
    assert.ok(Math.abs(cost - 0.00015) < 1e-9, `expected 0.00015, got ${cost}`);
  });

  it('bills a dated o1-mini at the o1-mini rate, not the o1 rate', async () => {
    const cost = await costFor('o1-mini-2024-09-12');
    assert.ok(Math.abs(cost - 0.003) < 1e-9, `expected 0.003, got ${cost}`);
  });

  it('still prices the exact model ids and the base family prefix', async () => {
    assert.ok(Math.abs((await costFor('gpt-4o-mini')) - 0.00015) < 1e-9);
    assert.ok(Math.abs((await costFor('gpt-4o-2024-08-06')) - 0.0025) < 1e-9);
  });

  it('falls back to the documented default rate for an unknown model', async () => {
    // Records the matching limit: unknown families are not guessed.
    const cost = await costFor('totally-unknown-model');
    assert.ok(Math.abs(cost - 0.001) < 1e-9, `expected fallback 0.001, got ${cost}`);
  });
});
