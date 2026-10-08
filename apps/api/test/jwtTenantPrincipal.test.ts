/**
 * AUTH-2 — JWT tenant_id must always become req.tenantId, overwriting any
 * stale/default binding so tenantContextMiddleware binds the correct ALS scope.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express, { type Request, type Response } from 'express';
import { getCurrentTenantId } from '@praetor/core/runtime/tenantContext';
import { authMiddleware } from '../src/authMiddleware';
import { tenantContextMiddleware } from '../src/tenantContextMiddleware';

function listen(app: express.Express): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        port,
        close: () =>
          new Promise((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}

describe('JWT tenant_id principal binding (AUTH-2)', () => {
  const envSnap = {
    AUTH_DISABLED: process.env.AUTH_DISABLED,
    COMMANDER_ALLOW_ANON: process.env.COMMANDER_ALLOW_ANON,
    NODE_ENV: process.env.NODE_ENV,
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(envSnap)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('overwrites a stale req.tenantId with JWT tenant_id before tenantContext binds ALS', async () => {
    delete process.env.AUTH_DISABLED;
    delete process.env.COMMANDER_ALLOW_ANON;
    process.env.NODE_ENV = 'test';

    const app = express();
    app.use((req: Request, _res: Response, next) => {
      (req as Request & { tenantId?: string }).tenantId = 'stale-local';
      req.user = {
        id: 'user-1',
        username: 'alice',
        role: 'admin',
        tenantId: 'tenant-jwt',
      };
      next();
    });
    app.use(authMiddleware);
    app.use(tenantContextMiddleware);
    app.get('/probe', (_req, res) => {
      res.json({
        reqTenantId: (_req as Request & { tenantId?: string }).tenantId,
        alsTenantId: getCurrentTenantId(),
      });
    });

    const { port, close } = await listen(app);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/probe`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { reqTenantId: string; alsTenantId: string };
      assert.equal(body.reqTenantId, 'tenant-jwt');
      assert.equal(body.alsTenantId, 'tenant-jwt');
    } finally {
      await close();
    }
  });

  it('AUTH_DISABLED still honors JWT tenant_id over anon default', async () => {
    process.env.AUTH_DISABLED = 'true';
    process.env.COMMANDER_ALLOW_ANON = '1';
    process.env.NODE_ENV = 'test';

    const app = express();
    app.use((req: Request, _res: Response, next) => {
      req.user = {
        id: 'user-1',
        username: 'alice',
        role: 'admin',
        tenantId: 'tenant-jwt',
      };
      next();
    });
    app.use(authMiddleware);
    app.use(tenantContextMiddleware);
    app.get('/probe', (_req, res) => {
      res.json({
        reqTenantId: (_req as Request & { tenantId?: string }).tenantId,
        alsTenantId: getCurrentTenantId(),
      });
    });

    const { port, close } = await listen(app);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/probe`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { reqTenantId: string; alsTenantId: string };
      assert.equal(body.reqTenantId, 'tenant-jwt');
      assert.equal(body.alsTenantId, 'tenant-jwt');
    } finally {
      await close();
    }
  });
});
