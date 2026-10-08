import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import express, { type Request, type Response as ExpressResponse } from 'express';
import { getHookManager, type CommanderPlugin } from '@praetor/core';
import { resetConsistencyMonitorManager } from '../src/consistencyMonitor';
import { createQualityRouter } from '../src/qualityEndpoints';
import { createReportingRouter } from '../src/reportingEndpoints';
import type { AuthUser } from '../src/jwtMiddleware';
import '../src/authMiddleware';

const REPORTING_PLUGIN_NAME = 'builtin-reporting';

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
  app.use(createQualityRouter());
  app.use(createReportingRouter());
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
      method: options.method ?? 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

describe('quality consistency tenant isolation', () => {
  beforeEach(() => resetConsistencyMonitorManager());
  afterEach(() => resetConsistencyMonitorManager());

  it('rejects unauthenticated reads and unauthorized writes', async () => {
    const unauthenticatedRead = await request('/api/consistency/status');
    assert.equal(unauthenticatedRead.status, 401);

    const unauthenticatedWrite = await request('/api/consistency/record', {
      method: 'POST',
      body: { missionId: 'mission-1', agentId: 'agent-1', content: 'answer' },
    });
    assert.equal(unauthenticatedWrite.status, 401);

    const viewerWrite = await request('/api/consistency/record', {
      method: 'POST',
      tenantId: 'tenant-a',
      user: { id: 'viewer-a', username: 'viewer-a', role: 'viewer', tenantId: 'tenant-a' },
      body: { missionId: 'mission-1', agentId: 'agent-1', content: 'answer' },
    });
    assert.equal(viewerWrite.status, 403);
  });

  it('keeps mission consistency data tenant-scoped while allowing operators', async () => {
    const tenantA = {
      tenantId: 'tenant-a',
      user: {
        id: 'operator-a',
        username: 'operator-a',
        role: 'operator' as const,
        tenantId: 'tenant-a',
      },
    };
    const recorded = await request('/api/consistency/record', {
      ...tenantA,
      method: 'POST',
      body: { missionId: 'shared-mission', agentId: 'agent-a', content: 'tenant-a answer' },
    });
    assert.equal(recorded.status, 200);

    const tenantACheck = await request('/api/consistency/check/shared-mission', tenantA);
    assert.equal(tenantACheck.status, 200);
    assert.equal((await tenantACheck.json()).agentCount, 1);

    const tenantB = {
      tenantId: 'tenant-b',
      user: { id: 'viewer-b', username: 'viewer-b', role: 'viewer' as const, tenantId: 'tenant-b' },
    };
    const tenantBCheck = await request('/api/consistency/check/shared-mission', tenantB);
    assert.equal(tenantBCheck.status, 200);
    assert.equal((await tenantBCheck.json()).agentCount, 0);

    const tenantBStatus = await request('/api/consistency/status', tenantB);
    assert.equal(tenantBStatus.status, 200);
    assert.equal((await tenantBStatus.json())['shared-mission'].agentCount, 0);
  });
});

describe('reporting control authorization', () => {
  const hookManager = getHookManager();
  const plugin: CommanderPlugin = {
    name: REPORTING_PLUGIN_NAME,
    version: 'test',
    description: 'Reporting control security fixture',
  };

  beforeEach(async () => {
    if (hookManager.hasPlugin(REPORTING_PLUGIN_NAME)) {
      await hookManager.unregister(REPORTING_PLUGIN_NAME);
    }
    await hookManager.register(plugin);
    hookManager.enable(REPORTING_PLUGIN_NAME);
  });

  afterEach(async () => {
    if (hookManager.hasPlugin(REPORTING_PLUGIN_NAME)) {
      await hookManager.unregister(REPORTING_PLUGIN_NAME);
    }
  });

  it('rejects unauthenticated and low-privilege plugin mutations', async () => {
    const unauthenticated = await request('/api/reporting/disable', { method: 'POST' });
    assert.equal(unauthenticated.status, 401);
    assert.equal(hookManager.isEnabled(REPORTING_PLUGIN_NAME), true);

    const viewer = await request('/api/reporting/disable', {
      method: 'POST',
      user: { id: 'viewer', username: 'viewer', role: 'viewer' },
    });
    assert.equal(viewer.status, 403);
    assert.equal(hookManager.isEnabled(REPORTING_PLUGIN_NAME), true);
  });

  it('allows admin roles and explicitly scoped reporting operators', async () => {
    const disabled = await request('/api/reporting/disable', {
      method: 'POST',
      user: { id: 'admin', username: 'admin', role: 'admin' },
    });
    assert.equal(disabled.status, 200);
    assert.equal(hookManager.isEnabled(REPORTING_PLUGIN_NAME), false);

    const enabled = await request('/api/reporting/enable', {
      method: 'POST',
      apiKeyId: 'reporting-operator',
      apiScopes: ['reporting:admin'],
    });
    assert.equal(enabled.status, 200);
    assert.equal(hookManager.isEnabled(REPORTING_PLUGIN_NAME), true);
  });
});
