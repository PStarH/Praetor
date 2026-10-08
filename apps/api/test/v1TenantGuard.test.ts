import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import express from 'express';
import jwt from 'jsonwebtoken';
import {
  setGlobalTenantProvider,
  getGlobalTenantProvider,
  SimpleTenantProvider,
  NullTenantProvider,
  type TenantProvider,
  type TenantConfig,
} from '@praetor/core/runtime';
import { createJwtMiddleware, signAccessToken, type AuthUser } from '../src/jwtMiddleware.js';
import type { User } from '../src/userStore.js';
import {
  _resetRefreshTokenStoreForTests,
  setRefreshTokenRepository,
} from '../src/refreshTokenStore.js';
import { TestRefreshTokenRepository } from './authRepositories.js';
import { v1TenantGuard } from '../src/v1TenantGuard.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

const KNOWN_TENANT = 'tenant-alpha';
const OTHER_TENANT = 'tenant-beta'; // exists in provider but owns no runs here
const UNKNOWN_TENANT = 'tenant-ghost'; // not in provider

function tenantConfig(tenantId: string): TenantConfig {
  return {
    tenantId,
    tokenBudget: 0,
    maxConcurrency: 0,
    maxRunsPerMinute: 0,
    enabled: true,
  };
}

function makeUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 'user-1',
    username: 'alice',
    role: 'admin',
    authVersion: 1,
    ...overrides,
  };
}

const authoritativeUser: User = {
  id: 'user-1',
  username: 'alice',
  email: 'alice@example.test',
  passwordHash: 'unused',
  role: 'admin',
  authVersion: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastLoginAt: null,
};

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

/**
 * Mount the guard with the same relative ordering as production:
 *   jwtMiddleware → (stub apiKey simulation) → v1TenantGuard → handler
 * authMiddleware is stubbed: when `simulateApiKey` is set it pre-populates
 * req.apiKeyId + req.tenantId as if a tenant-bound API key had validated.
 */
async function withGuard(
  opts: {
    simulateApiKey?: { apiKeyId: string; tenantId: string };
    handler?: express.RequestHandler;
  } = {},
  action: (base: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use(
    createJwtMiddleware(async (id) =>
      id === authoritativeUser.id ? authoritativeUser : undefined,
    ),
  );
  if (opts.simulateApiKey) {
    const { apiKeyId, tenantId } = opts.simulateApiKey;
    app.use((req, _res, next) => {
      (req as express.Request & { apiKeyId?: string; tenantId?: string }).apiKeyId = apiKeyId;
      (req as express.Request & { tenantId?: string }).tenantId = tenantId;
      next();
    });
  }
  app.use(v1TenantGuard());
  // Default handler: echo the resolved tenant. For cross-tenant tests, the
  // handler simulates a kernel lookup that returns null for wrong tenant.
  app.use(
    '/v1/runs/:runId',
    opts.handler ??
      ((req, res) => {
        res.json({ ok: true, tenantId: (req as express.Request & { tenantId?: string }).tenantId });
      }),
  );
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    await action(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}

async function getRun(
  base: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/v1/runs/run-xyz`, { headers });
  const body = (await res.json()) as any;
  return { status: res.status, body };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('v1TenantGuard — spec §3.2 fail-closed table (enterprise profile)', () => {
  let originalProvider: TenantProvider;
  const envSnap: Record<string, string | undefined> = {};

  before(() => {
    originalProvider = getGlobalTenantProvider();
    envSnap.COMMANDER_PROFILE = process.env.COMMANDER_PROFILE;
    envSnap.COMMANDER_DEFAULT_TENANT_ID = process.env.COMMANDER_DEFAULT_TENANT_ID;
    envSnap.JWT_SECRET = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'test-secret-for-v1-guard';
  });

  beforeEach(() => {
    process.env.COMMANDER_PROFILE = 'enterprise';
    delete process.env.COMMANDER_DEFAULT_TENANT_ID;
    setGlobalTenantProvider(
      new SimpleTenantProvider([tenantConfig(KNOWN_TENANT), tenantConfig(OTHER_TENANT)]),
    );
    setRefreshTokenRepository(new TestRefreshTokenRepository());
  });

  afterEach(() => {
    setGlobalTenantProvider(originalProvider);
  });

  after(() => {
    _resetRefreshTokenStoreForTests();
    for (const [key, value] of Object.entries(envSnap)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('row 1: no Authorization + no X-API-Key → 401 AUTHENTICATION_REQUIRED', async () => {
    await withGuard({}, async (base) => {
      const { status, body } = await getRun(base);
      assert.equal(status, 401);
      assert.equal(body.error.code, 'AUTHENTICATION_REQUIRED');
    });
  });

  it('row 2: invalid Bearer JWT → 401 INVALID_TOKEN (fail-open reversed on /v1 enterprise)', async () => {
    await withGuard({}, async (base) => {
      const { status, body } = await getRun(base, bearer('not.a.real.jwt'));
      assert.equal(status, 401);
      assert.equal(body.error.code, 'INVALID_TOKEN');
    });
  });

  it('row 2: expired JWT → 401 INVALID_TOKEN', async () => {
    // Sign a token that is already expired. jwt.sign with expiresIn in the past
    // produces an expired token that verifyToken rejects.
    const expiredToken = jwt.sign(
      { id: 'user-1', username: 'alice', role: 'admin', type: 'access', tenant_id: KNOWN_TENANT },
      process.env.JWT_SECRET!,
      { algorithm: 'HS256', expiresIn: '-1s' },
    );
    await withGuard({}, async (base) => {
      const { status, body } = await getRun(base, bearer(expiredToken));
      assert.equal(status, 401);
      assert.equal(body.error.code, 'INVALID_TOKEN');
    });
  });

  it('row 2: refresh token used in place of access token → 401 INVALID_TOKEN', async () => {
    // Sign a refresh token (type: 'refresh') — guard must reject as non-access.
    const { signRefreshToken } = await import('../src/jwtMiddleware.js');
    const refresh = await signRefreshToken(makeUser({ tenantId: KNOWN_TENANT }));
    await withGuard({}, async (base) => {
      const { status, body } = await getRun(base, bearer(refresh));
      assert.equal(status, 401);
      assert.equal(body.error.code, 'INVALID_TOKEN');
    });
  });

  it('row 3: valid JWT but no tenant_id claim → 401 TENANT_CLAIM_REQUIRED', async () => {
    const token = signAccessToken(makeUser()); // no tenantId
    await withGuard({}, async (base) => {
      const { status, body } = await getRun(base, bearer(token));
      assert.equal(status, 401);
      assert.equal(body.error.code, 'TENANT_CLAIM_REQUIRED');
    });
  });

  it('row 3: JWT with malformed tenant_id (path-traversal "..") → 401 TENANT_CLAIM_REQUIRED', async () => {
    const token = signAccessToken(makeUser({ tenantId: '../etc' }));
    await withGuard({}, async (base) => {
      const { status, body } = await getRun(base, bearer(token));
      assert.equal(status, 401);
      assert.equal(body.error.code, 'TENANT_CLAIM_REQUIRED');
    });
  });

  it('row 4: JWT tenant_id not provisioned in TenantProvider → 403 TENANT_NOT_FOUND', async () => {
    const token = signAccessToken(makeUser({ tenantId: UNKNOWN_TENANT }));
    await withGuard({}, async (base) => {
      const { status, body } = await getRun(base, bearer(token));
      assert.equal(status, 403);
      assert.equal(body.error.code, 'TENANT_NOT_FOUND');
    });
  });

  it('row 5: X-Tenant-ID header differs from JWT tenant_id → 403 TENANT_MISMATCH', async () => {
    const token = signAccessToken(makeUser({ tenantId: KNOWN_TENANT }));
    await withGuard({}, async (base) => {
      const { status, body } = await getRun(base, {
        ...bearer(token),
        'x-tenant-id': OTHER_TENANT,
      });
      assert.equal(status, 403);
      assert.equal(body.error.code, 'TENANT_MISMATCH');
    });
  });

  it('happy path: valid JWT with known tenant → 200, req.tenantId set authoritatively', async () => {
    const token = signAccessToken(makeUser({ tenantId: KNOWN_TENANT, scopes: ['runs:read'] }));
    await withGuard({}, async (base) => {
      const { status, body } = await getRun(base, bearer(token));
      assert.equal(status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.tenantId, KNOWN_TENANT);
    });
  });

  it('happy path: X-Tenant-ID matching JWT tenant_id is allowed (no mismatch)', async () => {
    const token = signAccessToken(makeUser({ tenantId: KNOWN_TENANT }));
    await withGuard({}, async (base) => {
      const { status } = await getRun(base, { ...bearer(token), 'x-tenant-id': KNOWN_TENANT });
      assert.equal(status, 200);
    });
  });

  it('row 6: cross-tenant run access → 404 RUN_NOT_FOUND (no existence leak)', async () => {
    // JWT is for KNOWN_TENANT, but the run belongs to OTHER_TENANT. The handler
    // simulates a kernel lookup scoped to req.tenantId: returns 404 (not 403)
    // so the caller cannot learn the run exists under another tenant.
    const token = signAccessToken(makeUser({ tenantId: KNOWN_TENANT }));
    const runOwner = OTHER_TENANT;
    const crossTenantHandler: express.RequestHandler = (req, res) => {
      const tenantId = (req as express.Request & { tenantId?: string }).tenantId;
      if (tenantId !== runOwner) {
        res.status(404).json({ error: { code: 'RUN_NOT_FOUND', message: 'Run was not found.' } });
        return;
      }
      res.json({ ok: true });
    };
    await withGuard({ handler: crossTenantHandler }, async (base) => {
      const { status, body } = await getRun(base, bearer(token));
      assert.equal(status, 404);
      assert.equal(body.error.code, 'RUN_NOT_FOUND');
    });
  });

  it('API key path: tenant-bound key with known tenant → 200', async () => {
    await withGuard(
      { simulateApiKey: { apiKeyId: 'key-1', tenantId: KNOWN_TENANT } },
      async (base) => {
        const { status, body } = await getRun(base, {
          'x-api-key': 'irrelevant-stub-pre-sets-state',
        });
        assert.equal(status, 200);
        assert.equal(body.tenantId, KNOWN_TENANT);
      },
    );
  });

  it('API key path: key bound to unknown tenant → 403 TENANT_NOT_FOUND', async () => {
    await withGuard(
      { simulateApiKey: { apiKeyId: 'key-1', tenantId: UNKNOWN_TENANT } },
      async (base) => {
        const { status, body } = await getRun(base, {
          'x-api-key': 'irrelevant-stub-pre-sets-state',
        });
        assert.equal(status, 403);
        assert.equal(body.error.code, 'TENANT_NOT_FOUND');
      },
    );
  });

  it('API key path: X-Tenant-ID mismatch → 403 TENANT_MISMATCH', async () => {
    await withGuard(
      { simulateApiKey: { apiKeyId: 'key-1', tenantId: KNOWN_TENANT } },
      async (base) => {
        const { status, body } = await getRun(base, {
          'x-api-key': 'irrelevant-stub-pre-sets-state',
          'x-tenant-id': OTHER_TENANT,
        });
        assert.equal(status, 403);
        assert.equal(body.error.code, 'TENANT_MISMATCH');
      },
    );
  });

  it('single-tenant escape hatch: COMMANDER_DEFAULT_TENANT_ID matches JWT tenant_id → 200', async () => {
    // Operator runs enterprise in single-tenant mode: NullTenantProvider knows
    // no tenants, but COMMANDER_DEFAULT_TENANT_ID permits the one allowed tenant.
    setGlobalTenantProvider(new NullTenantProvider());
    process.env.COMMANDER_DEFAULT_TENANT_ID = 'tenant-solo';
    const token = signAccessToken(makeUser({ tenantId: 'tenant-solo' }));
    await withGuard({}, async (base) => {
      const { status, body } = await getRun(base, bearer(token));
      assert.equal(status, 200);
      assert.equal(body.tenantId, 'tenant-solo');
    });
  });
});

describe('v1TenantGuard — standard profile is a no-op', () => {
  const envSnap: Record<string, string | undefined> = {};
  let originalProvider: TenantProvider;

  before(() => {
    originalProvider = getGlobalTenantProvider();
    envSnap.COMMANDER_PROFILE = process.env.COMMANDER_PROFILE;
    envSnap.JWT_SECRET = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'test-secret-for-v1-guard';
  });

  after(() => {
    setGlobalTenantProvider(originalProvider);
    for (const [key, value] of Object.entries(envSnap)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('standard profile: invalid Bearer is NOT rejected by the guard (fail-open preserved)', async () => {
    process.env.COMMANDER_PROFILE = 'standard';
    setGlobalTenantProvider(new NullTenantProvider());
    // In standard profile the guard passes through; an invalid JWT simply
    // leaves req.user null and the handler responds (no 401 from the guard).
    await withGuard({}, async (base) => {
      const { status } = await getRun(base, bearer('not.a.real.jwt'));
      assert.equal(status, 200); // guard no-op; handler reached
    });
  });

  it('standard profile: request with no auth still reaches handler (guard no-op)', async () => {
    process.env.COMMANDER_PROFILE = 'standard';
    setGlobalTenantProvider(new NullTenantProvider());
    await withGuard({}, async (base) => {
      const { status } = await getRun(base);
      assert.equal(status, 200);
    });
  });
});
