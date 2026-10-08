import * as assert from 'node:assert/strict';
import { hashSecret } from '@praetor/core/runtime';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import express, { type Request, type Response } from 'express';
import { authMiddleware } from '../src/authMiddleware';
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
    const key = `cmdr_test_${id}`;
    const record: ApiKeyRecord = {
      id,
      name,
      prefix: key.slice(0, 8),
      hash: hashSecret(key),
      scopes,
      tenantId,
      enabled: true,
      createdAt: '2026-08-27T00:00:00.000Z',
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
    record.revokedAt = '2026-08-27T00:00:00.000Z';
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
  cleanup: async () => 0,
};

let app: express.Express;
let server: ReturnType<typeof app.listen>;
let port: number;
let store: TestApiKeyStore;

function request(path: string, init?: RequestInit) {
  return fetch(`http://127.0.0.1:${port}${path}`, init);
}

before(async () => {
  app = express();
  app.use(authMiddleware);
  app.get('/context', (req: Request, res: Response) => {
    res.json({
      apiKeyId: req.apiKeyId,
      apiScopes: req.apiScopes,
      tenantId: req.tenantId,
    });
  });
  app.get('/ready', (_req: Request, res: Response) => {
    res.json({ status: 'ready' });
  });

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      port = typeof address === 'object' && address ? address.port : 0;
      resolve();
    });
  });
});

beforeEach(() => {
  store = new TestApiKeyStore();
  setApiKeyStore(store);
  setAuthFailureStore(unlockedFailures);
});

afterEach(() => {
  resetApiKeyStore();
  resetAuthFailureStoreForTesting();
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('PostgreSQL tenant API key sets req.tenantId', async () => {
  const { key } = await store.create('acme-key', ['read', 'write'], 'acme-corp');

  const response = await request('/context', { headers: { 'X-API-Key': key } });

  assert.equal(response.status, 200);
  const body = (await response.json()) as { apiKeyId: string; tenantId: string };
  assert.equal(body.apiKeyId, 'acme-key');
  assert.equal(body.tenantId, 'acme-corp');
});

test('PostgreSQL tenant API key preserves explicit scopes', async () => {
  const { key } = await store.create('scoped-key', ['admin', 'actions:approve'], 'cell-tenant');

  const response = await request('/context', { headers: { 'X-API-Key': key } });

  assert.equal(response.status, 200);
  const body = (await response.json()) as { apiScopes: string[]; tenantId: string };
  assert.equal(body.tenantId, 'cell-tenant');
  assert.deepEqual(body.apiScopes, ['admin', 'actions:approve']);
});

test('Bearer token resolves its PostgreSQL API-key tenant', async () => {
  const { key } = await store.create('bearer-key', ['read'], 'stark');

  const response = await request('/context', { headers: { Authorization: `Bearer ${key}` } });

  assert.equal(response.status, 200);
  const body = (await response.json()) as { tenantId: string };
  assert.equal(body.tenantId, 'stark');
});

test('invalid API key is rejected', async () => {
  await store.create('valid-key', ['read'], 'acme-corp');

  const response = await request('/context', { headers: { 'X-API-Key': 'invalid-key' } });

  assert.equal(response.status, 401);
});

test('/ready stays public when PostgreSQL contains API keys', async () => {
  await store.create('configured-key');

  const response = await request('/ready');

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ready' });
});

test('tenant-scoped keys do not leak their tenant bindings', async () => {
  const { key: keyA } = await store.create('key-a', ['read'], 'tenant-a');
  const { key: keyB } = await store.create('key-b', ['read'], 'tenant-b');

  const responseA = await request('/context', { headers: { 'X-API-Key': keyA } });
  const bodyA = (await responseA.json()) as { tenantId: string };
  assert.equal(bodyA.tenantId, 'tenant-a');

  const responseB = await request('/context', { headers: { 'X-API-Key': keyB } });
  const bodyB = (await responseB.json()) as { tenantId: string };
  assert.equal(bodyB.tenantId, 'tenant-b');
});

test('an unscoped PostgreSQL API key leaves req.tenantId unset', async () => {
  const { key } = await store.create('platform-key', ['admin']);

  const response = await request('/context', { headers: { 'X-API-Key': key } });

  assert.equal(response.status, 200);
  const body = (await response.json()) as { apiKeyId: string; tenantId?: string };
  assert.equal(body.apiKeyId, 'platform-key');
  assert.equal(body.tenantId, undefined);
});
