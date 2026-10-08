import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express, { type Request, type Response as ExpressResponse } from 'express';
import { getHookManager, getTopologyStateMachine, type CommanderPlugin } from '@praetor/core';
import { createConsensusRouter } from '../src/consensusEndpoints';
import { tenantContextMiddleware } from '../src/tenantContextMiddleware';
import { createConsensusPlugin } from '@praetor/core';
import type { AuthUser } from '../src/jwtMiddleware';
import '../src/authMiddleware';

const CONSENSUS_PLUGIN_NAME = 'builtin-consensus';

type AuthFixture = {
  user?: AuthUser;
  apiKeyId?: string;
  apiScopes?: string[];
  tenantId?: string;
};

const testPlugin: CommanderPlugin = {
  name: CONSENSUS_PLUGIN_NAME,
  version: 'test',
  description: 'Consensus endpoint security fixture',
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
  app.use(createConsensusRouter());
  return app;
}

async function requestDisable(auth?: AuthFixture): Promise<Response> {
  const app = buildApp(auth);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    return await fetch(`http://127.0.0.1:${address.port}/api/consensus/disable`, {
      method: 'POST',
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function requestConsensus(
  path: string,
  options: AuthFixture & { body?: unknown; method?: string } = {},
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

describe('consensus disable authorization', () => {
  const hookManager = getHookManager();

  beforeEach(async () => {
    if (hookManager.hasPlugin(CONSENSUS_PLUGIN_NAME)) {
      await hookManager.unregister(CONSENSUS_PLUGIN_NAME);
    }
    await hookManager.register(testPlugin);
    hookManager.enable(CONSENSUS_PLUGIN_NAME);
  });

  afterEach(async () => {
    if (hookManager.hasPlugin(CONSENSUS_PLUGIN_NAME)) {
      await hookManager.unregister(CONSENSUS_PLUGIN_NAME);
    }
  });

  it('rejects unauthenticated callers before changing plugin state', async () => {
    const response = await requestDisable();
    assert.equal(response.status, 401);
    assert.equal(hookManager.isEnabled(CONSENSUS_PLUGIN_NAME), true);
  });

  it('rejects authenticated non-admin callers before changing plugin state', async () => {
    const response = await requestDisable({
      user: { id: 'viewer-1', username: 'viewer', role: 'viewer' },
    });
    assert.equal(response.status, 403);
    assert.equal(hookManager.isEnabled(CONSENSUS_PLUGIN_NAME), true);
  });

  it('rejects API keys without a consensus administration scope', async () => {
    const response = await requestDisable({
      apiKeyId: 'ordinary-writer',
      apiScopes: ['write'],
    });
    assert.equal(response.status, 403);
    assert.equal(hookManager.isEnabled(CONSENSUS_PLUGIN_NAME), true);
  });

  it('allows an admin JWT role to disable the process-global plugin', async () => {
    const response = await requestDisable({
      user: { id: 'admin-1', username: 'admin', role: 'admin' },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      plugin: CONSENSUS_PLUGIN_NAME,
      enabled: false,
      ok: true,
    });
    assert.equal(hookManager.isEnabled(CONSENSUS_PLUGIN_NAME), false);
  });

  it('allows an explicitly scoped API-key operator to disable the plugin', async () => {
    const response = await requestDisable({
      apiKeyId: 'consensus-operator',
      apiScopes: ['consensus:admin'],
    });
    assert.equal(response.status, 200);
    assert.equal(hookManager.isEnabled(CONSENSUS_PLUGIN_NAME), false);
  });

  it('rejects non-admin enable and topology-force mutations', async () => {
    hookManager.disable(CONSENSUS_PLUGIN_NAME);
    const enable = await requestConsensus('/api/consensus/enable', {
      user: { id: 'viewer-1', username: 'viewer', role: 'viewer' },
    });
    assert.equal(enable.status, 403);
    assert.equal(hookManager.isEnabled(CONSENSUS_PLUGIN_NAME), false);

    const topology = getTopologyStateMachine();
    const stateBefore = topology.getState();
    const force = await requestConsensus('/api/consensus/topology/force', {
      user: { id: 'viewer-1', username: 'viewer', role: 'viewer' },
      body: { state: 'LOCKDOWN', reason: 'unauthorized' },
    });
    assert.equal(force.status, 403);
    assert.equal(topology.getState(), stateBefore);
  });

  it('preserves explicitly scoped operator control of enable and topology force', async () => {
    hookManager.disable(CONSENSUS_PLUGIN_NAME);
    const auth = { apiKeyId: 'consensus-operator', apiScopes: ['consensus:admin'] };
    const enable = await requestConsensus('/api/consensus/enable', auth);
    assert.equal(enable.status, 200);
    assert.equal(hookManager.isEnabled(CONSENSUS_PLUGIN_NAME), true);

    const force = await requestConsensus('/api/consensus/topology/force', {
      ...auth,
      body: { state: 'NORMAL', reason: 'operator reset' },
    });
    assert.equal(force.status, 200);
    assert.equal(getTopologyStateMachine().getState(), 'NORMAL');
  });
});

describe('consensus tenant-scoped stopping state', () => {
  const hookManager = getHookManager();

  beforeEach(async () => {
    if (hookManager.hasPlugin(CONSENSUS_PLUGIN_NAME)) {
      await hookManager.unregister(CONSENSUS_PLUGIN_NAME);
    }
    await hookManager.register(createConsensusPlugin());
  });

  afterEach(async () => {
    if (hookManager.hasPlugin(CONSENSUS_PLUGIN_NAME)) {
      await hookManager.unregister(CONSENSUS_PLUGIN_NAME);
    }
  });

  it('keeps adaptive-stopping summaries isolated between tenant contexts', async () => {
    const round = { roundNumber: 1, answers: ['answer-a'], tokenCost: 10 };
    const record = await requestConsensus('/api/consensus/stopping/record', {
      tenantId: 'tenant-a',
      user: { id: 'a', username: 'a', role: 'viewer', tenantId: 'tenant-a' },
      body: { round },
    });
    assert.equal(record.status, 200);

    const tenantASummary = await requestConsensus('/api/consensus/stopping/summary', {
      tenantId: 'tenant-a',
      user: { id: 'a', username: 'a', role: 'viewer', tenantId: 'tenant-a' },
      method: 'GET',
    });
    assert.equal(tenantASummary.status, 200);
    assert.equal((await tenantASummary.json()).totalRounds, 1);

    const tenantBSummary = await requestConsensus('/api/consensus/stopping/summary', {
      tenantId: 'tenant-b',
      user: { id: 'b', username: 'b', role: 'viewer', tenantId: 'tenant-b' },
      method: 'GET',
    });
    assert.equal(tenantBSummary.status, 200);
    assert.equal((await tenantBSummary.json()).totalRounds, 0);
  });

  it('requires a tenant-bound identity for stopping mutations and reads', async () => {
    const response = await requestConsensus('/api/consensus/stopping/record', {
      user: { id: 'viewer', username: 'viewer', role: 'viewer' },
      body: { round: { roundNumber: 1, answers: ['answer'], tokenCost: 1 } },
    });
    assert.equal(response.status, 403);
  });
});
