import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import express, { type Request, type Response, type Application } from 'express';
import { getCurrentTenantId } from '@praetor/core/runtime/tenantContext';
import { tenantContextMiddleware } from '../src/tenantContextMiddleware';
import type { Server } from 'node:net';

function startServer(app: Application): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object' && 'port' in addr) {
        resolve({ server, port: addr.port });
      } else {
        reject(new Error('Failed to get server address'));
      }
    });
    server.on('error', reject);
  });
}

function buildApp() {
  const app = express();
  app.use(tenantContextMiddleware);
  app.get('/context', (_req: Request, res: Response) => {
    res.json({ tenantId: getCurrentTenantId() });
  });
  return app;
}

test('binds tenant context from X-Tenant-ID header', async () => {
  const app = buildApp();
  const { server, port } = await startServer(app);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/context`, {
      headers: { 'X-Tenant-ID': 'acme-corp' },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { tenantId: string | undefined };
    assert.equal(body.tenantId, 'acme-corp');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('binds tenant context from req.tenantId set by prior middleware', async () => {
  const app = express();
  app.use((req: Request, _res: Response, next) => {
    (req as Request & { tenantId?: string }).tenantId = 'prior-tenant';
    next();
  });
  app.use(tenantContextMiddleware);
  app.get('/context', (_req: Request, res: Response) => {
    res.json({ tenantId: getCurrentTenantId() });
  });

  const { server, port } = await startServer(app);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/context`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { tenantId: string | undefined };
    assert.equal(body.tenantId, 'prior-tenant');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('authenticated tenant binding rejects mismatched X-Tenant-ID with 403', async () => {
  const app = express();
  app.use((req: Request, _res: Response, next) => {
    (req as Request & { tenantId?: string }).tenantId = 'from-req';
    next();
  });
  app.use(tenantContextMiddleware);
  app.get('/context', (_req: Request, res: Response) => {
    res.json({ tenantId: getCurrentTenantId() });
  });

  const { server, port } = await startServer(app);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/context`, {
      headers: { 'X-Tenant-ID': 'from-header' },
    });
    assert.equal(res.status, 403);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, 'TenantIsolationError');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('matching X-Tenant-ID is allowed alongside authenticated binding', async () => {
  const app = express();
  app.use((req: Request, _res: Response, next) => {
    (req as Request & { tenantId?: string }).tenantId = 'tenant-a';
    next();
  });
  app.use(tenantContextMiddleware);
  app.get('/context', (_req: Request, res: Response) => {
    res.json({ tenantId: getCurrentTenantId() });
  });

  const { server, port } = await startServer(app);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/context`, {
      headers: { 'X-Tenant-ID': 'tenant-a' },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { tenantId: string | undefined };
    assert.equal(body.tenantId, 'tenant-a');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('invalid tenant id format returns 400 with TenantIsolationError', async () => {
  const app = buildApp();
  const { server, port } = await startServer(app);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/context`, {
      headers: { 'X-Tenant-ID': 'invalid tenant!' },
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string; message: string };
    assert.equal(body.error, 'TenantIsolationError');
    assert.match(body.message, /Invalid tenant id/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('no tenant header proceeds in single-tenant mode', async () => {
  const app = buildApp();
  const { server, port } = await startServer(app);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/context`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { tenantId: string | undefined };
    assert.equal(body.tenantId, undefined);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('rejects tenant id longer than 128 characters', async () => {
  const app = buildApp();
  const { server, port } = await startServer(app);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/context`, {
      headers: { 'X-Tenant-ID': 'a'.repeat(129) },
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, 'TenantIsolationError');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('enterprise profile rejects ambient X-Tenant-ID even when NODE_ENV is development', async () => {
  const prevProfile = process.env.COMMANDER_PROFILE;
  const prevNode = process.env.NODE_ENV;
  const prevCommanderEnv = process.env.COMMANDER_ENV;
  process.env.COMMANDER_PROFILE = 'enterprise';
  process.env.NODE_ENV = 'development';
  delete process.env.COMMANDER_ENV;
  try {
    const app = buildApp();
    const { server, port } = await startServer(app);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/context`, {
        headers: { 'X-Tenant-ID': 'ambient-spoof' },
      });
      assert.equal(res.status, 403);
      const body = (await res.json()) as { error: string; message: string };
      assert.equal(body.error, 'TenantIsolationError');
      assert.match(body.message, /production or enterprise/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    if (prevProfile === undefined) delete process.env.COMMANDER_PROFILE;
    else process.env.COMMANDER_PROFILE = prevProfile;
    if (prevNode === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNode;
    if (prevCommanderEnv === undefined) delete process.env.COMMANDER_ENV;
    else process.env.COMMANDER_ENV = prevCommanderEnv;
  }
});
