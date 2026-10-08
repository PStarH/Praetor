/**
 * L3-06 — Residual gateway gaps vs WS3 ACCEPTED baseline.
 *
 * WS3 already enforced /v1 freeze, JWT fail-closed, and OpenAPI authenticity.
 * This file closes the honest remaining holes:
 *   - legacy execution must not run under enterprise profile (defense in depth)
 *   - /api/openapi.json mounted before enterpriseRouteFreeze must 410 in enterprise
 *     and still carry x-legacy in standard (legacyHeader never reaches this route)
 *   - /api/runs early Gone middleware must carry freeze headers
 *   - pipeline/orchestrator legacy routers stay disabled when enterprise + legacy opt-in
 *   - JWT tenant_id must become AUTH-2 principal; enterprise rejects ambient X-Tenant-ID
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import express from 'express';
import { getCurrentTenantId } from '@praetor/core/runtime/tenantContext';
import { enterpriseRouteFreeze } from '../src/enterpriseGateway.js';
import { createPipelineRouter } from '../src/pipelineEndpoints.js';
import { createOrchestratorRouter } from '../src/orchestratorEndpoints.js';
import { generateOpenApiSpec } from '../src/openApiGenerator.js';
import { isEnterpriseProfile } from '../src/profileSignal.js';
import { isLegacyExecutionAllowed } from '../src/legacyExecutionGuard.js';
import { authMiddleware } from '../src/authMiddleware.js';
import { tenantContextMiddleware } from '../src/tenantContextMiddleware.js';
import { createJwtMiddleware, signAccessToken } from '../src/jwtMiddleware.js';

function request(base: string, path: string, init: RequestInit = {}) {
  return fetch(`${base}${path}`, { ...init, redirect: 'manual' });
}

async function withApp(
  build: (app: express.Express) => void,
  action: (base: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  build(app);
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

/** Mirrors index.ts mount order: openapi handler before enterpriseRouteFreeze. */
function mountApiOpenApiAlias(app: express.Express): void {
  app.get('/api/openapi.json', (_req, res) => {
    res.set('x-legacy', 'true');
    res.set('Deprecation', 'true');
    if (isEnterpriseProfile()) {
      res.status(410).json({
        error: {
          code: 'GONE',
          message: 'This route is frozen in the enterprise profile. Use GET /v1/openapi.json.',
        },
      });
      return;
    }
    res.json(generateOpenApiSpec({ title: 'Commander Enterprise API', version: 'test' }));
  });
}

/** Mirrors index.ts /api/runs Gone middleware (before freeze/legacyHeader). */
function mountApiRunsGone(app: express.Express): void {
  app.use('/api/runs', (_req, res, next) => {
    if (isLegacyExecutionAllowed()) {
      next();
      return;
    }
    res.set('x-legacy', 'true');
    res.set('Deprecation', 'true');
    res.status(410).json({
      error: {
        code: 'LEGACY_EXECUTION_GONE',
        message: 'Legacy /api/runs is not available; use /v1/runs.',
      },
    });
  });
}

/** F-A-16: save/restore COMMANDER_PROFILE in finally (the sibling tests already do this). */
async function withProfile<T>(profile: string, body: () => Promise<T>): Promise<T> {
  const previous = process.env.COMMANDER_PROFILE;
  process.env.COMMANDER_PROFILE = profile;
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env.COMMANDER_PROFILE;
    else process.env.COMMANDER_PROFILE = previous;
  }
}

describe('L3-06 residual gateway enforcement', () => {
  describe('/api/openapi.json pre-freeze mount hole', () => {
    it('returns 410 + x-legacy in enterprise profile', async () => {
      await withProfile('enterprise', async () => {
        await withApp(
          (app) => {
            mountApiOpenApiAlias(app);
            app.use(enterpriseRouteFreeze());
          },
          async (base) => {
            const res = await request(base, '/api/openapi.json');
            assert.equal(res.status, 410);
            assert.equal(res.headers.get('x-legacy'), 'true');
            assert.equal(res.headers.get('deprecation'), 'true');
            const body = (await res.json()) as { error: { code: string } };
            assert.equal(body.error.code, 'GONE');
          },
        );
      });
    });

    it('serves spec with x-legacy in standard profile', async () => {
      await withProfile('standard', async () => {
        await withApp(
          (app) => {
            mountApiOpenApiAlias(app);
            app.use(enterpriseRouteFreeze());
          },
          async (base) => {
            const res = await request(base, '/api/openapi.json');
            assert.equal(res.status, 200);
            assert.equal(res.headers.get('x-legacy'), 'true');
            assert.equal(res.headers.get('deprecation'), 'true');
            const body = (await res.json()) as { openapi: string };
            assert.equal(body.openapi, '3.1.0');
          },
        );
      });
    });
  });

  describe('/api/runs pre-freeze Gone middleware', () => {
    const envKeys = [
      'COMMANDER_PROFILE',
      'NODE_ENV',
      'COMMANDER_V2_MODE',
      'COMMANDER_LEGACY_EXECUTION',
    ] as const;
    const snap: Record<string, string | undefined> = {};

    function saveEnv(): void {
      for (const k of envKeys) snap[k] = process.env[k];
    }

    function restoreEnv(): void {
      for (const k of envKeys) {
        if (snap[k] === undefined) delete process.env[k];
        else process.env[k] = snap[k];
      }
    }

    it('returns 410 + x-legacy under enterprise even with legacy opt-in', async () => {
      saveEnv();
      try {
        process.env.COMMANDER_PROFILE = 'enterprise';
        process.env.NODE_ENV = 'development';
        process.env.COMMANDER_V2_MODE = '0';
        process.env.COMMANDER_LEGACY_EXECUTION = '1';
        await withApp(
          (app) => {
            mountApiRunsGone(app);
            app.use(enterpriseRouteFreeze());
          },
          async (base) => {
            const res = await request(base, '/api/runs');
            assert.equal(res.status, 410);
            assert.equal(res.headers.get('x-legacy'), 'true');
            assert.equal(res.headers.get('deprecation'), 'true');
            const body = (await res.json()) as { error: { code: string } };
            assert.equal(body.error.code, 'LEGACY_EXECUTION_GONE');
          },
        );
      } finally {
        restoreEnv();
      }
    });
  });

  describe('legacy execution routers under enterprise + COMMANDER_LEGACY_EXECUTION=1', () => {
    const envKeys = [
      'COMMANDER_PROFILE',
      'NODE_ENV',
      'COMMANDER_V2_MODE',
      'COMMANDER_LEGACY_EXECUTION',
    ] as const;
    const snap: Record<string, string | undefined> = {};

    function saveEnv(): void {
      for (const k of envKeys) snap[k] = process.env[k];
      process.env.COMMANDER_PROFILE = 'enterprise';
      process.env.NODE_ENV = 'development';
      process.env.COMMANDER_V2_MODE = '0';
      process.env.COMMANDER_LEGACY_EXECUTION = '1';
    }

    function restoreEnv(): void {
      for (const k of envKeys) {
        if (snap[k] === undefined) delete process.env[k];
        else process.env[k] = snap[k];
      }
    }

    it('pipeline router returns 410 (legacy guard) even before route freeze', async () => {
      saveEnv();
      try {
        assert.equal(isLegacyExecutionAllowed(), false);
        await withApp(
          (app) => {
            app.use('/', createPipelineRouter());
          },
          async (base) => {
            const res = await request(base, '/api/state-machine/create', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ pattern: 'pipeline' }),
            });
            assert.equal(res.status, 410);
            const body = (await res.json()) as { error: { code: string } };
            assert.equal(body.error.code, 'LEGACY_EXECUTION_DISABLED');
          },
        );
      } finally {
        restoreEnv();
      }
    });

    it('orchestrator router returns 410 (legacy guard) if incorrectly mounted', async () => {
      saveEnv();
      try {
        assert.equal(isLegacyExecutionAllowed(), false);
        await withApp(
          (app) => {
            // Defense in depth: even if index.ts registration gate were skipped,
            // the router middleware must still refuse enterprise + legacy opt-in.
            app.use('/api', createOrchestratorRouter());
          },
          async (base) => {
            const res = await request(base, '/api/orchestrator/execute', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ goal: 'test' }),
            });
            assert.equal(res.status, 410);
            const body = (await res.json()) as { error: { code: string } };
            assert.equal(body.error.code, 'LEGACY_EXECUTION_DISABLED');
          },
        );
      } finally {
        restoreEnv();
      }
    });
  });

  describe('JWT tenant binding / ambient X-Tenant-ID (AUTH-2)', () => {
    const envKeys = ['COMMANDER_PROFILE', 'NODE_ENV', 'COMMANDER_ENV', 'JWT_SECRET'] as const;
    const snap: Record<string, string | undefined> = {};

    function saveEnv(): void {
      for (const k of envKeys) snap[k] = process.env[k];
    }

    function restoreEnv(): void {
      for (const k of envKeys) {
        if (snap[k] === undefined) delete process.env[k];
        else process.env[k] = snap[k];
      }
    }

    it('enterprise + development rejects ambient X-Tenant-ID without principal', async () => {
      saveEnv();
      process.env.COMMANDER_PROFILE = 'enterprise';
      process.env.NODE_ENV = 'development';
      process.env.JWT_SECRET = 'l3-residual-test-jwt-secret-at-least-32-characters';
      delete process.env.COMMANDER_ENV;
      try {
        await withApp(
          (app) => {
            app.use(tenantContextMiddleware);
            app.get('/probe', (_req, res) => {
              res.json({ tenantId: getCurrentTenantId() ?? null });
            });
          },
          async (base) => {
            const res = await request(base, '/probe', {
              headers: { 'X-Tenant-ID': 'spoofed-tenant' },
            });
            assert.equal(res.status, 403);
            const body = (await res.json()) as { error: string };
            assert.equal(body.error, 'TenantIsolationError');
          },
        );
      } finally {
        restoreEnv();
      }
    });

    it('JWT tenant_id is principal — matching X-Tenant-ID binds ALS to JWT tenant', async () => {
      saveEnv();
      process.env.COMMANDER_PROFILE = 'enterprise';
      process.env.NODE_ENV = 'development';
      process.env.JWT_SECRET = 'l3-residual-test-jwt-secret-at-least-32-characters';
      delete process.env.COMMANDER_ENV;
      try {
        const token = signAccessToken({
          id: 'u1',
          username: 'alice',
          role: 'admin',
          authVersion: 1,
          tenantId: 'tenant-jwt',
        });
        const jwtMiddleware = createJwtMiddleware(async (id) =>
          id === 'u1'
            ? {
                id,
                username: 'alice',
                email: 'alice@example.test',
                passwordHash: 'unused',
                role: 'admin',
                authVersion: 1,
                createdAt: '2026-01-01T00:00:00.000Z',
                lastLoginAt: null,
              }
            : undefined,
        );
        await withApp(
          (app) => {
            app.use(jwtMiddleware);
            app.use(authMiddleware);
            app.use(tenantContextMiddleware);
            app.get('/probe', (req, res) => {
              res.json({
                reqTenantId: (req as express.Request & { tenantId?: string }).tenantId ?? null,
                alsTenantId: getCurrentTenantId() ?? null,
              });
            });
          },
          async (base) => {
            const res = await request(base, '/probe', {
              headers: {
                authorization: `Bearer ${token}`,
                'X-Tenant-ID': 'tenant-jwt',
              },
            });
            assert.equal(res.status, 200);
            const body = (await res.json()) as {
              reqTenantId: string;
              alsTenantId: string;
            };
            assert.equal(body.reqTenantId, 'tenant-jwt');
            assert.equal(body.alsTenantId, 'tenant-jwt');
          },
        );
      } finally {
        restoreEnv();
      }
    });

    it('JWT tenant_id principal rejects forged X-Tenant-ID under enterprise', async () => {
      saveEnv();
      process.env.COMMANDER_PROFILE = 'enterprise';
      process.env.NODE_ENV = 'development';
      process.env.JWT_SECRET = 'l3-residual-test-jwt-secret-at-least-32-characters';
      delete process.env.COMMANDER_ENV;
      try {
        const token = signAccessToken({
          id: 'u1',
          username: 'alice',
          role: 'admin',
          authVersion: 1,
          tenantId: 'tenant-jwt',
        });
        const jwtMiddleware = createJwtMiddleware(async (id) =>
          id === 'u1'
            ? {
                id,
                username: 'alice',
                email: 'alice@example.test',
                passwordHash: 'unused',
                role: 'admin',
                authVersion: 1,
                createdAt: '2026-01-01T00:00:00.000Z',
                lastLoginAt: null,
              }
            : undefined,
        );
        await withApp(
          (app) => {
            app.use(jwtMiddleware);
            app.use(authMiddleware);
            app.use(tenantContextMiddleware);
            app.get('/probe', (_req, res) => {
              res.json({ ok: true });
            });
          },
          async (base) => {
            const res = await request(base, '/probe', {
              headers: {
                authorization: `Bearer ${token}`,
                'X-Tenant-ID': 'forged-tenant',
              },
            });
            assert.equal(res.status, 403);
            const body = (await res.json()) as { error: string };
            assert.equal(body.error, 'TenantIsolationError');
          },
        );
      } finally {
        restoreEnv();
      }
    });
  });
});
