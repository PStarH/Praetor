/**
 * AUDIT-D1①/D1②: the HTTP MCP transport forwards a static service credential to
 * the Action Gateway.
 *
 *   - D1①: that credential must travel as X-API-Key. Authorization: Bearer is
 *     the JWT channel and is rejected by enterprise /v1 JWT middleware
 *     (401 INVALID_TOKEN) before API-key authentication can inspect it.
 *   - D1②: a caller authenticated in tenant A must not act under a service
 *     credential bound to tenant B (confused deputy).
 *
 * These are composed-boundary tests: the MCP forwarding, the REAL
 * jwt/auth/tenant middleware chain, and an in-memory gateway dependency all
 * run together. Forwarding-only mocks cannot prove this boundary.
 */
import * as assert from 'node:assert/strict';
import { hashSecret } from '@praetor/core/runtime';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import express from 'express';

import { createMCPRouter } from '../src/mcpEndpoints';
import { createJwtMiddleware, jwtMiddleware, signAccessToken } from '../src/jwtMiddleware';
import { authMiddleware } from '../src/authMiddleware';
import { tenantContextMiddleware } from '../src/tenantContextMiddleware';
import {
  resetApiKeyStore,
  setApiKeyStore,
  type ApiKeyCreationResult,
  type ApiKeyRecord,
  type ApiKeyStore,
} from '../src/apiKeyStore';
import {
  resetAuthFailureStoreForTesting,
  setAuthFailureStore,
  type AuthFailureStore,
} from '../src/authFailureStore';

const SERVICE_KEY_A = 'cmdr_service_tenant_a';
const SERVICE_KEY_B = 'cmdr_service_tenant_b';

class TestApiKeyStore implements ApiKeyStore {
  readonly records: ApiKeyRecord[] = [];

  async list(): Promise<Omit<ApiKeyRecord, 'hash'>[]> {
    return this.records.map(({ hash: _hash, ...record }) => record);
  }

  async listByTenant(tenantId: string): Promise<Omit<ApiKeyRecord, 'hash'>[]> {
    return this.records
      .filter((record) => record.tenantId === tenantId)
      .map(({ hash: _hash, ...record }) => record);
  }

  async findByHash(hash: string): Promise<ApiKeyRecord | undefined> {
    return this.records.find((record) => record.enabled && record.hash === hash);
  }

  async create(
    name: string,
    scopes: string[] = ['read', 'write'],
    tenantId?: string,
  ): Promise<ApiKeyCreationResult> {
    const id = `ak_${this.records.length + 1}`;
    const key = `${name}-${id}`;
    const record: ApiKeyRecord = {
      id,
      name,
      prefix: key.slice(0, 8),
      hash: hashSecret(key),
      scopes,
      tenantId,
      enabled: true,
      createdAt: '2026-09-12T00:00:00.000Z',
    };
    this.records.push(record);
    return { record, key };
  }

  async revoke(id: string, tenantScope?: string): Promise<ApiKeyRecord | undefined> {
    const record = this.records.find(
      (candidate) =>
        candidate.id === id &&
        candidate.enabled &&
        (tenantScope === undefined || candidate.tenantId === tenantScope),
    );
    if (!record) return undefined;
    record.enabled = false;
    record.revokedAt = '2026-09-12T00:00:00.000Z';
    return record;
  }

  async delete(id: string, tenantScope?: string): Promise<boolean> {
    const index = this.records.findIndex(
      (candidate) =>
        candidate.id === id && (tenantScope === undefined || candidate.tenantId === tenantScope),
    );
    if (index < 0) return false;
    this.records.splice(index, 1);
    return true;
  }
}

const unlockedFailures: AuthFailureStore = {
  get: async () => undefined,
  recordFailure: async () => ({
    count: 1,
    firstFailureAt: Date.now(),
    lastFailureAt: Date.now(),
    lockedUntil: 0,
  }),
  cleanup: async () => {},
};

interface DispatchedRequest {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
}

let store: TestApiKeyStore;
let gatewayServer: Server;
let gatewayBase: string;
let dispatches: DispatchedRequest[];
const savedProfile = process.env.COMMANDER_PROFILE;

async function listen(app: express.Express): Promise<{ server: Server; base: string }> {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}

/** Builds the real Action Gateway surface behind the production middleware chain. */
function buildGatewayApp(): express.Express {
  const gateway = express();
  gateway.use(jwtMiddleware);
  gateway.use(authMiddleware);
  gateway.use(tenantContextMiddleware);
  const record =
    (method: string) =>
    (req: express.Request, res: express.Response): void => {
      dispatches.push({
        method,
        path: req.path,
        headers: req.headers as Record<string, string | undefined>,
      });
      res.json({ action: { runId: 'run-1', state: 'PROPOSED' } });
    };
  gateway.get('/v1/actions/:id', record('GET'));
  gateway.post('/v1/actions', record('POST'));
  return gateway;
}

/** Builds the MCP transport whose executor forwards with the service credential. */
async function startMcpApp(opts: {
  callerTenant?: string;
  serviceTenant: string | null;
  serviceKey: string;
}): Promise<{ base: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  // Simulate the global chain: an admin caller authenticated in `callerTenant`.
  app.use((req, _res, next) => {
    req.user = { id: 'mcp-caller', username: 'mcp-caller', role: 'admin', authVersion: 1 };
    if (opts.callerTenant) req.tenantId = opts.callerTenant;
    next();
  });
  app.use(tenantContextMiddleware);
  app.use(
    '/mcp',
    createMCPRouter({
      actionGatewayUrl: gatewayBase,
      actionGatewayApiKey: opts.serviceKey,
      resolveServiceCredentialTenant: async () => opts.serviceTenant,
    }),
  );
  const { server, base } = await listen(app);
  return {
    base,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

function rpc(base: string, name: string, args: Record<string, unknown>): Promise<Response> {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: name,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
}

const PROPOSE_ENVELOPE = {
  source: 'mcp',
  package: 'commander.mcp',
  model: 'mcp-default',
  tool: 'ticket.create',
  destination: 'demo://tickets',
  effectType: 'demo.ticket.create',
  args: { title: 'hello' },
  idempotencyKey: 'mcp-cross-tenant-0001',
};

before(async () => {
  process.env.COMMANDER_PROFILE = 'enterprise';
  dispatches = [];
  const { server, base } = await listen(buildGatewayApp());
  gatewayServer = server;
  gatewayBase = base;
});

beforeEach(async () => {
  store = new TestApiKeyStore();
  setApiKeyStore(store);
  setAuthFailureStore(unlockedFailures);
  dispatches = [];
  await store.create('service-tenant-a', ['admin'], 'tenant-a');
  await store.create('service-tenant-b', ['admin'], 'tenant-b');
  // Re-bind the well-known service keys to their tenant records.
  store.records[0]!.hash = hashSecret(SERVICE_KEY_A);
  store.records[1]!.hash = hashSecret(SERVICE_KEY_B);
});

afterEach(() => {
  resetApiKeyStore();
  resetAuthFailureStoreForTesting();
});

after(async () => {
  if (savedProfile === undefined) delete process.env.COMMANDER_PROFILE;
  else process.env.COMMANDER_PROFILE = savedProfile;
  await new Promise<void>((resolve) => gatewayServer.close(() => resolve()));
});

describe('D1①: static credential pairing on the enterprise /v1 chain', () => {
  test('the gateway rejects a static API key sent as a Bearer token', async () => {
    const response = await fetch(`${gatewayBase}/v1/actions/run-1`, {
      headers: { authorization: `Bearer ${SERVICE_KEY_A}` },
    });
    assert.equal(response.status, 401);
    const body = (await response.json()) as { error?: { code?: string } };
    assert.equal(body.error?.code, 'INVALID_TOKEN');
    assert.equal(dispatches.length, 0);
  });

  test('the same static API key authenticates when sent as X-API-Key', async () => {
    const response = await fetch(`${gatewayBase}/v1/actions/run-1`, {
      headers: { 'x-api-key': SERVICE_KEY_A },
    });
    assert.equal(response.status, 200);
    assert.equal(dispatches.length, 1);
  });

  test('a JWT access token still authenticates as Authorization: Bearer', async () => {
    const savedSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'd1-contract-test-secret';
    try {
      const user = {
        id: 'jwt-user',
        username: 'jwt-user',
        role: 'admin' as const,
        authVersion: 1,
        tenantId: 'tenant-a',
      };
      const token = signAccessToken(user);
      const app = express();
      app.use(createJwtMiddleware(async (id) => (id === user.id ? user : undefined)));
      app.use(authMiddleware);
      app.use(tenantContextMiddleware);
      app.get('/v1/actions/:id', (req, res) => {
        dispatches.push({
          method: 'GET',
          path: req.path,
          headers: req.headers as Record<string, string | undefined>,
        });
        res.json({ action: { runId: 'run-1', state: 'PROPOSED' } });
      });
      const { server, base } = await listen(app);
      try {
        const response = await fetch(`${base}/v1/actions/run-1`, {
          headers: { authorization: `Bearer ${token}` },
        });
        assert.equal(response.status, 200);
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((e) => (e ? reject(e) : resolve())),
        );
      }
      assert.equal(dispatches.length, 1);
    } finally {
      if (savedSecret === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = savedSecret;
    }
  });
});

describe('D1②: caller tenant must match the service credential tenant', () => {
  test('tenant-A caller with a tenant-B service key is rejected on read and propose', async () => {
    const mcp = await startMcpApp({
      callerTenant: 'tenant-a',
      serviceTenant: 'tenant-b',
      serviceKey: SERVICE_KEY_B,
    });
    try {
      const read = await rpc(mcp.base, 'commander_action_get', { runId: 'run-1' });
      assert.equal(read.status, 403);
      const readBody = (await read.json()) as { error?: { message?: string } };
      assert.match(readBody.error?.message ?? '', /tenant/i);

      const propose = await rpc(mcp.base, 'commander_action_propose', PROPOSE_ENVELOPE);
      assert.equal(propose.status, 403);
    } finally {
      await mcp.close();
    }
    // Nothing was dispatched under the service credential.
    assert.equal(dispatches.length, 0);
  });

  test('tenant-A caller with a tenant-A service key reaches the gateway', async () => {
    const mcp = await startMcpApp({
      callerTenant: 'tenant-a',
      serviceTenant: 'tenant-a',
      serviceKey: SERVICE_KEY_A,
    });
    try {
      const read = await rpc(mcp.base, 'commander_action_get', { runId: 'run-1' });
      assert.equal(read.status, 200);
      const propose = await rpc(mcp.base, 'commander_action_propose', PROPOSE_ENVELOPE);
      assert.equal(propose.status, 200);
    } finally {
      await mcp.close();
    }
    assert.equal(dispatches.length, 2);
    // The forwarded request authenticated with X-API-Key, never a Bearer token.
    for (const dispatched of dispatches) {
      assert.equal(dispatched.headers['x-api-key'], SERVICE_KEY_A);
      assert.equal(dispatched.headers['authorization'], undefined);
      assert.equal(dispatched.headers['x-tenant-id'], 'tenant-a');
    }
  });

  test('an unresolvable service tenant fails closed for a tenant-bound caller', async () => {
    const mcp = await startMcpApp({
      callerTenant: 'tenant-a',
      serviceTenant: null,
      serviceKey: SERVICE_KEY_A,
    });
    try {
      const read = await rpc(mcp.base, 'commander_action_get', { runId: 'run-1' });
      assert.equal(read.status, 403);
    } finally {
      await mcp.close();
    }
    assert.equal(dispatches.length, 0);
  });

  test('a caller without an authenticated tenant is not blocked by the tenant check', async () => {
    const mcp = await startMcpApp({
      serviceTenant: 'tenant-a',
      serviceKey: SERVICE_KEY_A,
    });
    try {
      const read = await rpc(mcp.base, 'commander_action_get', { runId: 'run-1' });
      assert.equal(read.status, 200);
    } finally {
      await mcp.close();
    }
    assert.equal(dispatches.length, 1);
  });
});

describe('D1②: the gateway tenant guard backs up the MCP check', () => {
  test('a forwarded caller tenant that disagrees with the service principal is rejected', async () => {
    const response = await fetch(`${gatewayBase}/v1/actions/run-1`, {
      headers: { 'x-api-key': SERVICE_KEY_A, 'x-tenant-id': 'tenant-b' },
    });
    assert.equal(response.status, 403);
    assert.equal(dispatches.length, 0);
  });

  test('a forwarded caller tenant that matches the service principal passes', async () => {
    const response = await fetch(`${gatewayBase}/v1/actions/run-1`, {
      headers: { 'x-api-key': SERVICE_KEY_A, 'x-tenant-id': 'tenant-a' },
    });
    assert.equal(response.status, 200);
    assert.equal(dispatches.length, 1);
  });
});
