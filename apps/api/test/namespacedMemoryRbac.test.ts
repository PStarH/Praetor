/**
 * Namespace RBAC / audit semantics (WS6 Local-First rollback + review fixes).
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import express from 'express';
import { InMemoryMemoryService, MemoryStoreFacade } from '@praetor/core';
import { createNamespacedMemoryRouter } from '../src/namespacedMemoryEndpoints.js';
import type { AuthUser } from '../src/jwtMiddleware.js';
import type { UserRole } from '../src/userStore.js';

type AuthOpts =
  { kind: 'scopes'; scopes: string[] } | { kind: 'jwt'; role: UserRole } | { kind: 'anon' };

async function withApp(auth: AuthOpts, action: (base: string) => Promise<void>): Promise<void> {
  const store = new MemoryStoreFacade(new InMemoryMemoryService(), 'tenant-ns-rbac');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const r = req as express.Request & {
      apiKeyId?: string;
      apiScopes?: string[];
      user?: AuthUser | null;
    };
    if (auth.kind === 'scopes') {
      r.apiKeyId = 'test-key';
      r.apiScopes = auth.scopes;
      r.user = null;
    } else if (auth.kind === 'jwt') {
      r.user = {
        id: 'u1',
        username: 'tester',
        role: auth.role,
      };
    } else {
      r.user = null;
    }
    next();
  });
  app.use(createNamespacedMemoryRouter(store));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    await action(base);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}

describe('namespaced memory RBAC', () => {
  it('maps API-key write scope to writer and allows shared write', async () => {
    await withApp({ kind: 'scopes', scopes: ['write'] }, async (base) => {
      const ok = await fetch(`${base}/api/namespaced-memory/shared/write`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'scope-k', value: 'scope-v' }),
      });
      assert.equal(ok.status, 200);
    });
  });

  it('does not escalate bare agent role names in API scopes', async () => {
    await withApp({ kind: 'scopes', scopes: ['orchestrator', 'system'] }, async (base) => {
      // Authenticated but no mappable scopes → deny (not silent reader).
      const deniedWrite = await fetch(`${base}/api/namespaced-memory/shared/write`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'escalation', value: 'nope' }),
      });
      assert.equal(deniedWrite.status, 403);
      const deniedRead = await fetch(`${base}/api/namespaced-memory/shared/search?q=x`);
      assert.equal(deniedRead.status, 403);
    });
  });

  it('bridges JWT admin/developer to write-capable ACL roles', async () => {
    await withApp({ kind: 'jwt', role: 'admin' }, async (base) => {
      const ok = await fetch(`${base}/api/namespaced-memory/shared/write`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'jwt-admin', value: 'v' }),
      });
      assert.equal(ok.status, 200);
    });
    await withApp({ kind: 'jwt', role: 'developer' }, async (base) => {
      const ok = await fetch(`${base}/api/namespaced-memory/shared/write`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'jwt-dev', value: 'v' }),
      });
      assert.equal(ok.status, 200);
    });
    await withApp({ kind: 'jwt', role: 'viewer' }, async (base) => {
      const denied = await fetch(`${base}/api/namespaced-memory/shared/write`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'jwt-viewer', value: 'v' }),
      });
      assert.equal(denied.status, 403);
    });
  });

  it('rejects anonymous access (no reader-by-default for unauthenticated)', async () => {
    await withApp({ kind: 'anon' }, async (base) => {
      const read = await fetch(`${base}/api/namespaced-memory/shared/search?q=x`);
      assert.equal(read.status, 403);
      const acl = await fetch(`${base}/api/namespaced-memory/acl`);
      assert.equal(acl.status, 403);
    });
  });

  it('/acl: admin sees full HTTP ACL; writer sees only own rule', async () => {
    await withApp({ kind: 'scopes', scopes: ['admin'] }, async (base) => {
      const res = await fetch(`${base}/api/namespaced-memory/acl`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        rules: Array<{ role: string; namespaces: string[] }>;
      };
      assert.deepEqual(body.rules.map((r) => r.role).sort(), ['admin', 'reader', 'writer']);
    });
    await withApp({ kind: 'scopes', scopes: ['write'] }, async (base) => {
      const res = await fetch(`${base}/api/namespaced-memory/acl`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        rules: Array<{ role: string; namespaces: string[] }>;
      };
      assert.equal(body.rules.length, 1);
      assert.equal(body.rules[0]?.role, 'writer');
    });
  });

  it('audit endpoint returns durable store entries for the namespace', async () => {
    await withApp({ kind: 'scopes', scopes: ['write'] }, async (base) => {
      const write = await fetch(`${base}/api/namespaced-memory/shared/write`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'audit-k', value: 'audit-v' }),
      });
      assert.equal(write.status, 200);

      const audit = await fetch(`${base}/api/namespaced-memory/shared/audit`);
      assert.equal(audit.status, 200);
      const body = (await audit.json()) as {
        namespace: string;
        entries: Array<{ action: string; success?: boolean }>;
        count: number;
        source: string;
      };
      assert.equal(body.namespace, 'shared');
      assert.equal(body.source, 'store');
      assert.ok(body.count >= 1);
      assert.ok(body.entries.some((e) => e.action === 'store' && e.success === true));
    });
  });
});
