import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { RUN_STATES } from '@praetor/contracts';
import { createServer } from 'node:http';
import express from 'express';
import { createV1GatewayRouter } from '../src/v1GatewayEndpoints.js';
import type { V1KernelGateway } from '../src/v1GatewayKernel.js';

const ROOT = new URL('../', import.meta.url);

function readApiSrc(rel: string): string {
  return readFileSync(new URL(rel, ROOT), 'utf8');
}

describe('L3-05 §3.1 — /v1 kernel-only (no WarRoom fallback)', () => {
  it('v1GatewayEndpoints.ts does not import WarRoomStore or ./store', () => {
    const src = readApiSrc('src/v1GatewayEndpoints.ts');
    assert.doesNotMatch(src, /from\s+['"]\.\/store/);
    assert.doesNotMatch(src, /WarRoomStore|createWarRoomStore|IWarRoomStore/);
  });

  it('v1GatewayKernel.ts does not import WarRoomStore or ./store', () => {
    const src = readApiSrc('src/v1GatewayKernel.ts');
    const importLines = src.split('\n').filter((line) => /^\s*import\b/.test(line));
    for (const line of importLines) {
      assert.doesNotMatch(line, /\.\/store|WarRoomStore|createWarRoomStore/);
    }
  });

  it('production gateway uses the kernel repository factory for tenant-authority wiring', () => {
    const src = readApiSrc('src/v1GatewayKernel.ts');
    assert.match(src, /createKernelRepository/);
    assert.match(src, /COMMANDER_KERNEL_BACKEND:\s*'postgres'/);
    assert.doesNotMatch(src, /new\s+PostgresKernelRepository\s*\(/);
    assert.doesNotMatch(src, /createVerifiedPostgresPool\s*\(/);
  });

  it('index.ts wires /v1 runs to getV1KernelGateway, not WarRoom store', () => {
    const src = readApiSrc('src/index.ts');
    assert.match(src, /createV1GatewayRouter\(getV1KernelGateway\)/);
    assert.match(src, /\/v1 never falls back to WarRoomStore/);
    assert.doesNotMatch(
      src,
      /createV1GatewayRouter\(\s*store/,
      'v1 router must not receive WarRoom store as kernel resolver',
    );
  });

  it('returns KERNEL_UNAVAILABLE for every /v1 runs sub-resource when kernel is null', async () => {
    const paths: Array<[string, string]> = [
      ['POST', '/v1/runs'],
      ['GET', '/v1/runs/run-missing'],
      ['GET', '/v1/runs/run-missing/events'],
      ['GET', '/v1/runs/run-missing/status'],
      ['POST', '/v1/runs/run-missing/pause'],
      ['POST', '/v1/runs/run-missing/resume'],
      ['POST', '/v1/runs/run-missing/cancel'],
    ];

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as express.Request & { tenantId?: string }).tenantId = 'tenant-a';
      next();
    });
    app.use(
      '/v1',
      createV1GatewayRouter(() => null),
    );

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const base = `http://127.0.0.1:${address.port}`;

      for (const [method, path] of paths) {
        const init: RequestInit = { method, headers: { 'content-type': 'application/json' } };
        if (method === 'POST' && path === '/v1/runs') {
          init.headers = {
            ...init.headers,
            'idempotency-key': 'key-l3-05-fail-closed',
          };
          init.body = JSON.stringify({ goal: 'probe', policySnapshotId: 'policy-42' });
        }
        const res = await fetch(`${base}${path}`, init);
        assert.equal(res.status, 503, `${method} ${path} must fail closed`);
        const body = (await res.json()) as { error: { code: string } };
        assert.equal(body.error.code, 'KERNEL_UNAVAILABLE', `${method} ${path} error code`);
      }
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });
});

describe('L3-05 §3.3 — Gateway never imports ATR RunLedger', () => {
  it('gateway + WarRoom entry files have zero RunLedger imports (full tree: oneRunAuthority.invariants)', () => {
    const files = [
      'src/index.ts',
      'src/v1GatewayEndpoints.ts',
      'src/v1GatewayKernel.ts',
      'src/projectEndpoints.ts',
      'src/store.ts',
    ];
    for (const file of files) {
      const src = readApiSrc(file);
      assert.doesNotMatch(src, /from\s+['"]@commander\/core['"][\s\S]*RunLedger/);
      assert.doesNotMatch(src, /runLedger|RunLedger/);
    }
  });
});

describe('L3-05 §4.1 — SDK and /v1 share kernel run semantics', () => {
  it('SDK client targets POST /v1/runs (enterprise durable path)', () => {
    const src = readFileSync(
      new URL('../../../packages/sdk/src/v1/client.ts', import.meta.url),
      'utf8',
    );
    assert.match(src, /\/v1\/runs/);
    assert.doesNotMatch(src, /WarRoomStore|execution_logs|missions/);
  });

  it('v1GatewayEndpoints uses contracts RunState helpers', () => {
    const src = readApiSrc('src/v1GatewayEndpoints.ts');
    assert.match(src, /from\s+['"]@commander\/contracts['"]/);
    assert.match(src, /isTerminalRunState/);
  });

  it('FakeGateway round-trip uses contracts-compatible run states', async () => {
    class ProbeGateway implements V1KernelGateway {
      async submit(input: Parameters<V1KernelGateway['submit']>[0]) {
        const ts = new Date().toISOString();
        return {
          run: {
            id: 'run-probe',
            tenantId: input.tenantId,
            state: 'PENDING' as const,
            createdAt: ts,
            updatedAt: ts,
            intentHash: 'i',
            workGraphHash: 'g',
            workGraphVersion: input.workGraphVersion,
            policySnapshotId: input.policySnapshotId,
            metadata: {},
          },
          created: true,
        };
      }
      async getRun(runId: string) {
        if (runId !== 'run-probe') return null;
        const ts = new Date().toISOString();
        return {
          id: 'run-probe',
          tenantId: 'tenant-a',
          state: 'RUNNING' as const,
          createdAt: ts,
          updatedAt: ts,
          intentHash: 'i',
          workGraphHash: 'g',
          workGraphVersion: 'v1',
          policySnapshotId: 'p',
          metadata: {},
        };
      }
      async listEvents() {
        return [];
      }
      async pauseRun() {
        return null;
      }
      async resumeRun() {
        return null;
      }
      async cancelRun() {
        return null;
      }
    }

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as express.Request & { tenantId?: string }).tenantId = 'tenant-a';
      next();
    });
    app.use(
      '/v1',
      createV1GatewayRouter(() => new ProbeGateway()),
    );

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const base = `http://127.0.0.1:${address.port}`;

      const submit = await fetch(`${base}/v1/runs`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'key-l3-05-probe-01',
        },
        body: JSON.stringify({ goal: 'probe', policySnapshotId: 'policy-42' }),
      });
      assert.equal(submit.status, 202);
      const submitBody = (await submit.json()) as { run: { state: string } };
      assert.ok(RUN_STATES.includes(submitBody.run.state as (typeof RUN_STATES)[number]));

      const get = await fetch(`${base}/v1/runs/run-probe`);
      assert.equal(get.status, 200);
      const getBody = (await get.json()) as { run: { state: string } };
      assert.equal(getBody.run.state, 'RUNNING');
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });
});

describe('L3-05 §4.2 — CLI history semantics (honest PARTIAL)', () => {
  const CLI_DUAL_SURFACES = [
    'packages/core/src/cli/commands/saga.ts',
    'packages/core/src/cli/commands/debug.ts',
    'packages/core/src/cli/commands/history.ts',
    'packages/core/src/atr/runLedger.ts',
    'packages/core/src/atr/types.ts',
  ] as const;

  it('documents residual non-/v1 CLI/ATR run history surfaces', () => {
    // AUDIT F-A-20: the previous assertion was `src.length > 0` for every path,
    // which is true for any readable file and checked no dual-surface property.
    // Pin the property that actually makes each file a NON-/v1 run-history
    // surface: it must reach durable state through the store/checkpointer/trace
    // modules, and must not route through the enterprise /v1 gateway.
    const DURABLE_MARKERS: Record<string, RegExp> = {
      'packages/core/src/cli/commands/saga.ts': /saga\/index/,
      'packages/core/src/cli/commands/debug.ts': /intentLog|executionTrace/,
      'packages/core/src/cli/commands/history.ts': /StateCheckpointer/,
      'packages/core/src/atr/runLedger.ts': /class |export /,
      'packages/core/src/atr/types.ts': /export (interface|type|const)/,
    };
    for (const rel of CLI_DUAL_SURFACES) {
      const src = readFileSync(new URL(`../../../${rel}`, import.meta.url), 'utf8');
      assert.ok(src.length > 0, `${rel} must exist — dual surface inventory`);
      assert.match(src, DURABLE_MARKERS[rel]!, `${rel} must bind to a durable non-/v1 store`);
      assert.doesNotMatch(
        src,
        /getV1KernelGateway|createV1GatewayRouter/,
        `${rel} must not be routed through the /v1 gateway`,
      );
    }
  });

  it('GET /v1/.../run-context synthesizes non-kernel runId (WarRoom projection, not durable authority)', () => {
    const src = readApiSrc('src/projectEndpoints.ts');
    assert.match(src, /run-context|runContext/i);
    assert.match(
      src,
      /runId\s*\|\|\s*`\$\{req\.params\.projectId\}-\$\{now\}`/,
      'must keep synthetic WarRoom runId explicit for audit',
    );
    assert.doesNotMatch(src, /getV1KernelGateway|createV1GatewayRouter/);
  });

  it('cliEntry declares enterprise durable path as POST /v1/runs, not CLI verbs', () => {
    const src = readFileSync(
      new URL('../../../packages/core/src/cliEntry.ts', import.meta.url),
      'utf8',
    );
    assert.match(src, /POST \/v1\/runs/);
    assert.match(src, /Enterprise Gateway/);
  });

  it('ATR RunState vocabulary differs from contracts RunState (known dual track)', () => {
    const atr = readFileSync(
      new URL('../../../packages/core/src/atr/types.ts', import.meta.url),
      'utf8',
    );
    assert.match(atr, /EXECUTING|COMMITTED|VERIFYING/);
    assert.doesNotMatch(atr, /from\s+['"]@commander\/contracts['"]/);
    for (const kernelState of ['RUNNING', 'SUCCEEDED'] as const) {
      assert.ok(RUN_STATES.includes(kernelState));
    }
  });
});
