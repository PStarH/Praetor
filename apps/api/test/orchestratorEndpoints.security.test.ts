/**
 * P0.1 — legacy orchestrator / pipeline execute admin gate.
 *
 * Full router import pulls @praetor/core (ESM type-reexport friction under tsx).
 * Cover the security contract via source assertions + isomorphic middleware behavior
 * against the real legacyExecutionGuard.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { Express, Request, Response, NextFunction } from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  isLegacyExecutionAllowed,
  legacyExecutionDisabledReason,
} from '../src/legacyExecutionGuard';
import { hasRole, type UserRole } from '../src/userStore';

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  next();
}

function requireRole(requiredRole: UserRole = 'admin') {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user || !hasRole(req.user.role, requiredRole)) {
      res.status(403).json({ error: 'Insufficient privileges' });
      return;
    }
    next();
  };
}

function injectUser(user: { id: string; username: string; role: UserRole } | null) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    req.user = user;
    next();
  };
}

/** Mirrors orchestratorEndpoints wiring: legacy gate → auth → admin → handler */
function createLegacyExecuteApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    if (!isLegacyExecutionAllowed()) {
      res.status(410).json({
        error: {
          code: 'LEGACY_EXECUTION_DISABLED',
          message: legacyExecutionDisabledReason(),
        },
      });
      return;
    }
    next();
  });
  app.post('/orchestrator/execute', requireAuth, requireRole('admin'), (_req, res) => {
    res.status(400).json({ error: 'goal is required' });
  });
  app.post('/api/pipeline/execute', requireAuth, requireRole('admin'), (_req, res) => {
    res.status(400).json({ error: 'id and steps[] are required' });
  });
  return app;
}

async function listen(app: Express): Promise<{ server: http.Server; base: string }> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, base: `http://127.0.0.1:${port}` };
}

describe('orchestrator/pipeline execute source contract (P0.1)', () => {
  it('wires requireAuth + requireRole(admin) on orchestrator execute', () => {
    const src = fs.readFileSync(path.join(srcDir, 'orchestratorEndpoints.ts'), 'utf-8');
    assert.match(
      src,
      /router\.post\(\s*['"]\/orchestrator\/execute['"]\s*,\s*requireAuth\s*,\s*requireRole\(['"]admin['"]\)/,
    );
    assert.match(src, /function requireAuth/);
    assert.match(src, /function requireRole/);
    assert.match(src, /isLegacyExecutionAllowed/);
  });

  it('wires requireAuth + requireRole(admin) on pipeline execute', () => {
    const src = fs.readFileSync(path.join(srcDir, 'pipelineEndpoints.ts'), 'utf-8');
    assert.match(
      src,
      /router\.post\(\s*['"]\/api\/pipeline\/execute['"]\s*,\s*requireAuth\s*,\s*requireRole\(['"]admin['"]\)/,
    );
  });
});

describe('legacy execute auth behavior (P0.1)', () => {
  const envSnapshot = {
    node: process.env.NODE_ENV,
    v2: process.env.COMMANDER_V2_MODE,
    legacy: process.env.COMMANDER_LEGACY_EXECUTION,
  };

  afterEach(() => {
    if (envSnapshot.node === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = envSnapshot.node;
    if (envSnapshot.v2 === undefined) delete process.env.COMMANDER_V2_MODE;
    else process.env.COMMANDER_V2_MODE = envSnapshot.v2;
    if (envSnapshot.legacy === undefined) delete process.env.COMMANDER_LEGACY_EXECUTION;
    else process.env.COMMANDER_LEGACY_EXECUTION = envSnapshot.legacy;
  });

  it('returns 410 when legacy execution is disabled', async () => {
    process.env.NODE_ENV = 'development';
    process.env.COMMANDER_V2_MODE = '0';
    delete process.env.COMMANDER_LEGACY_EXECUTION;

    const { server, base } = await listen(createLegacyExecuteApp());
    try {
      const res = await fetch(`${base}/orchestrator/execute`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ goal: 'x' }),
      });
      assert.equal(res.status, 410);
      const body = (await res.json()) as { error: { code: string } };
      assert.equal(body.error.code, 'LEGACY_EXECUTION_DISABLED');
    } finally {
      server.close();
    }
  });

  it('returns 401 when legacy is on but unauthenticated', async () => {
    process.env.NODE_ENV = 'development';
    process.env.COMMANDER_V2_MODE = '0';
    process.env.COMMANDER_LEGACY_EXECUTION = '1';

    const app = createLegacyExecuteApp();
    // Re-mount with null user after creating base — inject before routes via new app
    const wired = express();
    wired.use(express.json());
    wired.use(injectUser(null));
    wired.use((_req, res, next) => {
      if (!isLegacyExecutionAllowed()) {
        res.status(410).json({ error: { code: 'LEGACY_EXECUTION_DISABLED' } });
        return;
      }
      next();
    });
    wired.post('/orchestrator/execute', requireAuth, requireRole('admin'), (_req, res) => {
      res.json({ ok: true });
    });

    const { server, base } = await listen(wired);
    try {
      const res = await fetch(`${base}/orchestrator/execute`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ goal: 'x' }),
      });
      assert.equal(res.status, 401);
    } finally {
      server.close();
    }
  });

  it('returns 403 when legacy is on but caller is non-admin', async () => {
    process.env.NODE_ENV = 'development';
    process.env.COMMANDER_V2_MODE = '0';
    process.env.COMMANDER_LEGACY_EXECUTION = '1';

    const app = express();
    app.use(express.json());
    app.use(injectUser({ id: 'u1', username: 'viewer1', role: 'viewer' }));
    app.use((_req, res, next) => {
      if (!isLegacyExecutionAllowed()) {
        res.status(410).json({ error: { code: 'LEGACY_EXECUTION_DISABLED' } });
        return;
      }
      next();
    });
    app.post('/orchestrator/execute', requireAuth, requireRole('admin'), (_req, res) => {
      res.json({ ok: true });
    });

    const { server, base } = await listen(app);
    try {
      const res = await fetch(`${base}/orchestrator/execute`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ goal: 'x' }),
      });
      assert.equal(res.status, 403);
    } finally {
      server.close();
    }
  });

  it('allows admin past auth when legacy is on', async () => {
    process.env.NODE_ENV = 'development';
    process.env.COMMANDER_V2_MODE = '0';
    process.env.COMMANDER_LEGACY_EXECUTION = '1';

    const app = express();
    app.use(express.json());
    app.use(injectUser({ id: 'a1', username: 'admin', role: 'admin' }));
    app.use((_req, res, next) => {
      if (!isLegacyExecutionAllowed()) {
        res.status(410).json({ error: { code: 'LEGACY_EXECUTION_DISABLED' } });
        return;
      }
      next();
    });
    app.post('/orchestrator/execute', requireAuth, requireRole('admin'), (_req, res) => {
      res.status(400).json({ error: 'goal is required' });
    });

    const { server, base } = await listen(app);
    try {
      const res = await fetch(`${base}/orchestrator/execute`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 400);
    } finally {
      server.close();
    }
  });

  it('returns 403 for non-admin on pipeline execute when legacy is on', async () => {
    process.env.NODE_ENV = 'development';
    process.env.COMMANDER_V2_MODE = '0';
    process.env.COMMANDER_LEGACY_EXECUTION = '1';

    const app = express();
    app.use(express.json());
    app.use(injectUser({ id: 'u1', username: 'op', role: 'operator' }));
    app.use((_req, res, next) => {
      if (!isLegacyExecutionAllowed()) {
        res.status(410).json({ error: { code: 'LEGACY_EXECUTION_DISABLED' } });
        return;
      }
      next();
    });
    app.post('/api/pipeline/execute', requireAuth, requireRole('admin'), (_req, res) => {
      res.json({ ok: true });
    });

    const { server, base } = await listen(app);
    try {
      const res = await fetch(`${base}/api/pipeline/execute`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'p1', steps: [{ agentId: 'a' }] }),
      });
      assert.equal(res.status, 403);
    } finally {
      server.close();
    }
  });
});
