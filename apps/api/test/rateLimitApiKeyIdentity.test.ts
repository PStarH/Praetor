/**
 * AUTH-02: API-key callers had no key/tenant rate-limit identity, because
 * verification happens in `authMiddleware`, which is mounted *after*
 * `rateLimitMiddleware`. At limiting time `req.apiKeyId` / `req.tenantId` were
 * undefined, so every API-key request fell back to a per-IP bucket. This pins
 * the pre-limiter canonical lookup (`apiKeyIdentityMiddleware`) and the
 * tenant/principal buckets it must produce.
 */
import { hashSecret } from '@praetor/core/runtime';

// Pin tiny limits BEFORE importing securityMiddleware (parsed at module load).
process.env.API_RATE_LIMIT = '10';
process.env.API_RATE_LIMIT_USER = '1';
process.env.API_RATE_LIMIT_TENANT = '1';

import { after, before, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import express from 'express';
import type { Request, Response } from 'express';
import { setApiKeyStore, type ApiKeyStore, type ApiKeyRecord } from '../src/apiKeyStore';
import { setAuthFailureStore, type AuthFailureStore } from '../src/authFailureStore';
import { apiKeyIdentityMiddleware, authMiddleware } from '../src/authMiddleware';
import type { RateLimitBucket, RateLimitEntry, RateLimitStore } from '../src/securityMiddleware';

// The limiter parses its quotas at module load, and ESM hoists static imports
// above the env assignments at the top of this file — so it must be imported
// dynamically, after the limits are pinned.
const { rateLimitMiddleware, setRateLimitStoreForTesting } =
  await import('../src/securityMiddleware');

const VALID_KEY = 'cmdr_test_key_alpha';
const SECOND_KEY = 'cmdr_test_key_beta';
const GLOBAL_KEY = 'cmdr_test_key_global';
const REVOKED_KEY = 'cmdr_test_key_revoked';

function record(overrides: Partial<ApiKeyRecord>): ApiKeyRecord {
  return {
    id: 'ak_1',
    name: 'alpha',
    prefix: 'cmdr_tes',
    hash: hashSecret(VALID_KEY),
    scopes: ['read', 'write'],
    enabled: true,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

class FakeApiKeyStore implements ApiKeyStore {
  records = new Map<string, ApiKeyRecord>();
  throwOnLookup: Error | null = null;

  async list(): Promise<Omit<ApiKeyRecord, 'hash'>[]> {
    return [];
  }

  async listByTenant(): Promise<Omit<ApiKeyRecord, 'hash'>[]> {
    return [];
  }

  async findByHash(hash: string): Promise<ApiKeyRecord | undefined> {
    if (this.throwOnLookup) throw this.throwOnLookup;
    return this.records.get(hash);
  }

  async create(): Promise<never> {
    throw new Error('not used');
  }

  async revoke(): Promise<undefined> {
    return undefined;
  }

  async delete(): Promise<boolean> {
    return false;
  }
}

class FakeRateLimitStore implements RateLimitStore {
  readonly buckets = new Map<string, RateLimitEntry>();
  throwOnConsume: Error | null = null;

  async consume(buckets: readonly RateLimitBucket[]): Promise<RateLimitEntry[]> {
    if (this.throwOnConsume) throw this.throwOnConsume;
    const now = Date.now();
    return buckets.map((bucket) => {
      const existing = this.buckets.get(bucket.key);
      const entry: RateLimitEntry =
        !existing || existing.resetAt <= now
          ? { count: 1, resetAt: now + bucket.windowMs }
          : { count: existing.count + 1, resetAt: existing.resetAt };
      this.buckets.set(bucket.key, entry);
      return { ...entry };
    });
  }

  async cleanup(): Promise<number> {
    return 0;
  }

  keys(): string[] {
    return [...this.buckets.keys()].sort();
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

let keyStore: FakeApiKeyStore;
let limitStore: FakeRateLimitStore;

function makeReq(overrides: Partial<Request> & { rateLimitApiKey?: unknown } = {}): Request {
  const url = (overrides.url as string | undefined) ?? '/probe';
  return {
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' } as never,
    url,
    path: (overrides.path as string | undefined) ?? url.split('?')[0],
    method: 'GET',
    headers: {},
    ...overrides,
  } as unknown as Request;
}

function makeRes(): Response & {
  _status: number;
  _json: unknown;
  _headers: Record<string, unknown>;
} {
  return {
    _status: 200,
    _json: undefined,
    _headers: {},
    status(code: number) {
      this._status = code;
      return this;
    },
    json(body: unknown) {
      this._json = body;
      return this;
    },
    setHeader(name: string, value: string | number) {
      this._headers[name] = value;
      return this;
    },
  } as never;
}

async function runIdentityAndLimit(req: Request): Promise<{
  res: ReturnType<typeof makeRes>;
  nextCalled: boolean;
}> {
  const res = makeRes();
  let identityNext = false;
  await apiKeyIdentityMiddleware(req, res, () => {
    identityNext = true;
  });
  assert.equal(identityNext, true, 'identity middleware must never block');
  let nextCalled = false;
  await rateLimitMiddleware(req, res, () => {
    nextCalled = true;
  });
  return { res, nextCalled };
}

describe('AUTH-02: API-key rate-limit identity', () => {
  beforeEach(() => {
    keyStore = new FakeApiKeyStore();
    keyStore.records.set(hashSecret(VALID_KEY), record({ id: 'ak_1', tenantId: 'tenant-a' }));
    keyStore.records.set(
      hashSecret(SECOND_KEY),
      record({ id: 'ak_2', name: 'beta', tenantId: 'tenant-a' }),
    );
    // No tenant: isolates the per-key principal bucket in the cross-IP test.
    keyStore.records.set(
      hashSecret(GLOBAL_KEY),
      record({ id: 'ak_global', name: 'global', tenantId: undefined }),
    );
    limitStore = new FakeRateLimitStore();
    setApiKeyStore(keyStore);
    setRateLimitStoreForTesting(limitStore);
    setAuthFailureStore(unlockedFailures);
  });

  test('resolves the key id and tenant from the canonical lookup, not the key name', async () => {
    const req = makeReq({ headers: { 'x-api-key': VALID_KEY } });
    await apiKeyIdentityMiddleware(req, makeRes(), () => {});
    assert.deepEqual(req.rateLimitApiKey, { id: 'ak_1', tenantId: 'tenant-a' });
    // Authorization identity must stay unset until authMiddleware validates.
    assert.equal(req.apiKeyId, undefined);
    assert.equal(req.tenantId, undefined);
  });

  test('same key across many IPs shares one principal bucket', async () => {
    // The cross-IP assertion uses a tenant-less key so only the per-key bucket
    // can block; a tenant-bound key would trip the tenant bucket first.
    const first = await runIdentityAndLimit(
      makeReq({ ip: '10.0.0.1', headers: { 'x-api-key': GLOBAL_KEY } }),
    );
    assert.equal(first.res._status, 200);

    // Different IP, same key: before the fix this minted a fresh per-IP bucket
    // and the second request was allowed.
    const second = await runIdentityAndLimit(
      makeReq({ ip: '10.0.0.2', headers: { 'x-api-key': GLOBAL_KEY } }),
    );
    assert.equal(second.nextCalled, false, 'the second request must be blocked');
    assert.equal(second.res._status, 429);
    assert.equal(second.res._headers['X-RateLimit-Reason'], 'per-user-tier-read');
    assert.deepEqual(limitStore.keys(), ['user:ak_global']);
  });

  test('same tenant across many keys shares one tenant bucket', async () => {
    const first = await runIdentityAndLimit(
      makeReq({ ip: '10.0.0.1', headers: { 'x-api-key': VALID_KEY } }),
    );
    assert.equal(first.res._status, 200);

    const second = await runIdentityAndLimit(
      makeReq({ ip: '10.0.0.9', headers: { 'x-api-key': SECOND_KEY } }),
    );
    assert.equal(second.res._status, 429);
    assert.equal(second.res._headers['X-RateLimit-Reason'], 'per-tenant-tier-read');
    assert.deepEqual(limitStore.keys(), ['tenant:tenant-a', 'user:ak_1', 'user:ak_2']);
  });

  test('a revoked key gets no identity and only consumes the anonymous IP bucket', async () => {
    keyStore.records.delete(hashSecret(REVOKED_KEY));
    const req = makeReq({ headers: { 'x-api-key': REVOKED_KEY } });
    const { res } = await runIdentityAndLimit(req);
    assert.equal(req.rateLimitApiKey, undefined);
    assert.deepEqual(limitStore.keys(), ['ip:127.0.0.1']);
    assert.equal(res._headers['X-RateLimit-Reason'], undefined);
  });

  test('an invalid key gets no identity', async () => {
    const req = makeReq({ headers: { 'x-api-key': 'cmdr_not_a_real_key' } });
    await runIdentityAndLimit(req);
    assert.equal(req.rateLimitApiKey, undefined);
    assert.deepEqual(limitStore.keys(), ['ip:127.0.0.1']);
  });

  test('a JWT-authenticated request is not charged an API-key identity', async () => {
    const req = makeReq({
      headers: { authorization: 'Bearer some.jwt.value' },
      user: { id: 'user-jwt', username: 'jwt', role: 'viewer', authVersion: 1 },
    } as Partial<Request>);
    await apiKeyIdentityMiddleware(req, makeRes(), () => {});
    assert.equal(req.rateLimitApiKey, undefined, 'the key lookup must be skipped for a JWT user');
    await runIdentityAndLimit(req);
    assert.deepEqual(limitStore.keys(), ['user:user-jwt']);
  });

  test('a database failure grants no identity instead of trusting the key', async () => {
    keyStore.throwOnLookup = new Error('AUTH_DATABASE_URL_REQUIRED');
    const req = makeReq({ headers: { 'x-api-key': VALID_KEY } });
    await apiKeyIdentityMiddleware(req, makeRes(), () => {});
    assert.equal(req.rateLimitApiKey, undefined);
  });

  test('the limiter fails closed with 503 when the authority is down', async () => {
    limitStore.throwOnConsume = new Error('ECONNREFUSED');
    const req = makeReq({ headers: { 'x-api-key': VALID_KEY } });
    const { res, nextCalled } = await runIdentityAndLimit(req);
    assert.equal(nextCalled, false);
    assert.equal(res._status, 503);
  });
});

describe('AUTH-02: API-key requests are not IP-limited', () => {
  let server: ReturnType<express.Express['listen']>;
  let port: number;

  before(async () => {
    const app = express();
    app.use(express.json());
    // Mirror index.ts ordering: JWT parse → API-key identity → limiter → auth.
    app.use(apiKeyIdentityMiddleware);
    app.use(rateLimitMiddleware);
    app.use(authMiddleware);
    app.get('/probe', (_req, res) => {
      res.json({ ok: true });
    });
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const address = server.address();
        port = typeof address === 'object' && address ? address.port : 0;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  test('a valid key authenticates and is charged to its tenant bucket', async () => {
    limitStore = new FakeRateLimitStore();
    setRateLimitStoreForTesting(limitStore);
    const response = await fetch(`http://127.0.0.1:${port}/probe`, {
      headers: { 'x-api-key': VALID_KEY },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(limitStore.keys(), ['tenant:tenant-a', 'user:ak_1']);
  });

  test('an invalid key is rejected by authMiddleware after the IP bucket is consumed', async () => {
    limitStore = new FakeRateLimitStore();
    setRateLimitStoreForTesting(limitStore);
    const response = await fetch(`http://127.0.0.1:${port}/probe`, {
      headers: { 'x-api-key': 'cmdr_invalid' },
    });
    assert.equal(response.status, 401);
    assert.deepEqual(limitStore.keys(), ['ip:127.0.0.1']);
  });

  test('control: without the identity middleware the same key is IP-bucketed', async () => {
    // Reproduces the pre-fix composition (jwtMiddleware → limiter → auth): the
    // identity middleware is absent, so one key used from N IPs mints N buckets
    // and an attacker rotating IPs is never blocked on the key — the defect
    // AUTH-02 describes and why the identity middleware must be mounted first.
    limitStore = new FakeRateLimitStore();
    setRateLimitStoreForTesting(limitStore);
    const first = makeReq({ ip: '10.1.1.1', headers: { 'x-api-key': GLOBAL_KEY } });
    const second = makeReq({ ip: '10.1.1.2', headers: { 'x-api-key': GLOBAL_KEY } });
    const firstRes = makeRes();
    const secondRes = makeRes();
    let secondNext = false;
    await rateLimitMiddleware(first, firstRes, () => {});
    await rateLimitMiddleware(second, secondRes, () => {
      secondNext = true;
    });

    assert.equal(firstRes._status, 200);
    assert.equal(secondNext, true, 'the second IP is not blocked: only IP buckets exist');
    assert.deepEqual(limitStore.keys(), ['ip:10.1.1.1', 'ip:10.1.1.2']);
    assert.equal(
      limitStore.keys().some((key) => key.startsWith('user:')),
      false,
      'without the identity middleware no principal bucket exists',
    );
  });
});
