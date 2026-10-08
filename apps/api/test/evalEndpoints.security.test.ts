import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express, { type Request, type Response as ExpressResponse } from 'express';
import { createEvalPlugin, getHookManager } from '@praetor/core';
import { createEvalRouter } from '../src/evalEndpoints';
import { tenantContextMiddleware } from '../src/tenantContextMiddleware';
import type { AuthUser } from '../src/jwtMiddleware';
import '../src/authMiddleware';

const EVAL_PLUGIN_NAME = 'builtin-eval';

type AuthFixture = {
  user?: AuthUser;
  apiKeyId?: string;
  apiScopes?: string[];
  tenantId?: string;
};

function buildApp(auth?: AuthFixture): express.Express {
  const app = express();
  app.use(express.json());
  if (auth) {
    app.use((req: Request, _res: ExpressResponse, next) => {
      req.user = auth.user ?? null;
      req.apiKeyId = auth.apiKeyId;
      req.apiScopes = auth.apiScopes;
      req.tenantId = auth.tenantId ?? auth.user?.tenantId;
      next();
    });
  }
  app.use(tenantContextMiddleware);
  app.use(createEvalRouter());
  return app;
}

async function request(
  path: string,
  options: AuthFixture & { method?: string; body?: unknown } = {},
): Promise<Response> {
  const app = buildApp(options);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    return await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: options.method ?? 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

describe('evaluation endpoint security', () => {
  const hookManager = getHookManager();
  let persistenceDir: string;

  beforeEach(async () => {
    if (hookManager.hasPlugin(EVAL_PLUGIN_NAME)) {
      await hookManager.unregister(EVAL_PLUGIN_NAME);
    }
    persistenceDir = mkdtempSync(path.join(tmpdir(), 'commander-eval-security-'));
    await hookManager.register(createEvalPlugin(), { persistenceDir });
    hookManager.enable(EVAL_PLUGIN_NAME);
  });

  afterEach(async () => {
    if (hookManager.hasPlugin(EVAL_PLUGIN_NAME)) {
      await hookManager.unregister(EVAL_PLUGIN_NAME);
    }
    rmSync(persistenceDir, { recursive: true, force: true });
  });

  it('restricts process-global enable/disable to admin roles or eval scopes', async () => {
    const viewer = { user: { id: 'viewer', username: 'viewer', role: 'viewer' as const } };
    const denied = await request('/api/eval/disable', viewer);
    assert.equal(denied.status, 403);
    assert.equal(hookManager.isEnabled(EVAL_PLUGIN_NAME), true);

    const admin = await request('/api/eval/disable', {
      user: { id: 'admin', username: 'admin', role: 'admin' },
    });
    assert.equal(admin.status, 200);
    assert.equal(hookManager.isEnabled(EVAL_PLUGIN_NAME), false);

    const scoped = await request('/api/eval/enable', {
      apiKeyId: 'eval-operator',
      apiScopes: ['eval:admin'],
    });
    assert.equal(scoped.status, 200);
    assert.equal(hookManager.isEnabled(EVAL_PLUGIN_NAME), true);
  });

  it('isolates dataset creation and listing by the authenticated tenant', async () => {
    const tenantA = {
      tenantId: 'tenant-a',
      user: { id: 'a', username: 'a', role: 'viewer' as const, tenantId: 'tenant-a' },
    };
    const created = await request('/api/eval/datasets', {
      ...tenantA,
      body: { name: 'private-a', cases: [{ input: 'q', output: 'a' }] },
    });
    assert.equal(created.status, 201);

    const listedA = await request('/api/eval/datasets', { ...tenantA, method: 'GET' });
    assert.equal(listedA.status, 200);
    const tenantADatasets = (await listedA.json()).datasets;
    assert.equal(tenantADatasets.length, 1);

    const listedB = await request('/api/eval/datasets', {
      tenantId: 'tenant-b',
      user: { id: 'b', username: 'b', role: 'viewer', tenantId: 'tenant-b' },
      method: 'GET',
    });
    assert.equal(listedB.status, 200);
    assert.equal((await listedB.json()).datasets.length, 0);
  });

  it('rejects dataset access without a tenant-bound identity', async () => {
    const response = await request('/api/eval/datasets', {
      user: { id: 'viewer', username: 'viewer', role: 'viewer' },
      method: 'GET',
    });
    assert.equal(response.status, 403);
  });
});
