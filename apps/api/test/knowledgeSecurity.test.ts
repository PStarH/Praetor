import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express, { type Application } from 'express';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { getHookManager, resetHookManager, setSharedKnowledgeBaseStore } from '@praetor/core';

import { createKnowledgeBaseRouter } from '../src/knowledgeBaseEndpoints';
import { _resetKnowledgeStoreSingletonForTests } from '../src/knowledgeStore';

interface TestServer {
  baseUrl: string;
  close: () => Promise<void>;
}

type Principal = {
  role?: 'admin' | 'developer' | 'viewer';
  apiKeyId?: string;
  apiScopes?: string[];
};

async function startServer(principal: Principal = {}): Promise<TestServer> {
  const app: Application = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const tenantId = req.header('x-tenant-id');
    if (tenantId) req.tenantId = tenantId;
    if (principal.role) {
      req.user = {
        id: 'test-user',
        username: 'test-user',
        role: principal.role,
        authVersion: 1,
        tenantId,
      };
    }
    req.apiKeyId = principal.apiKeyId;
    req.apiScopes = principal.apiScopes;
    next();
  });
  app.use(createKnowledgeBaseRouter());

  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.on('listening', resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

describe('knowledge security boundaries', () => {
  let originalCwd: string;
  let tempDir: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tempDir = path.join(
      os.tmpdir(),
      `commander-knowledge-${crypto.randomBytes(6).toString('hex')}`,
    );
    fs.mkdirSync(tempDir, { recursive: true });
    process.chdir(tempDir);
    _resetKnowledgeStoreSingletonForTests();
    setSharedKnowledgeBaseStore(null);
  });

  afterEach(() => {
    _resetKnowledgeStoreSingletonForTests();
    setSharedKnowledgeBaseStore(null);
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('isolates upload, list, search, read, and delete by authenticated tenant', async () => {
    const server = await startServer({ role: 'developer' });
    try {
      const upload = await fetch(`${server.baseUrl}/api/knowledge/documents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-tenant-id': 'tenant-a' },
        body: JSON.stringify({
          name: 'a-secret.txt',
          type: 'text/plain',
          content: 'tenant-a secret retrieval material',
        }),
      });
      assert.equal(upload.status, 201);
      const documentId = ((await upload.json()) as { document: { id: string } }).document.id;

      const listB = await fetch(`${server.baseUrl}/api/knowledge/documents`, {
        headers: { 'x-tenant-id': 'tenant-b' },
      });
      assert.equal(listB.status, 200);
      assert.deepEqual((await listB.json()) as { documents: unknown[]; total: number }, {
        documents: [],
        total: 0,
        page: 1,
        limit: 20,
      });

      const readB = await fetch(`${server.baseUrl}/api/knowledge/documents/${documentId}`, {
        headers: { 'x-tenant-id': 'tenant-b' },
      });
      assert.equal(readB.status, 404);

      const searchB = await fetch(`${server.baseUrl}/api/knowledge/search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-tenant-id': 'tenant-b' },
        body: JSON.stringify({ query: 'secret retrieval' }),
      });
      assert.equal(searchB.status, 200);
      assert.equal(((await searchB.json()) as { count: number }).count, 0);

      const deleteB = await fetch(`${server.baseUrl}/api/knowledge/documents/${documentId}`, {
        method: 'DELETE',
        headers: { 'x-tenant-id': 'tenant-b' },
      });
      assert.equal(deleteB.status, 404);

      const readA = await fetch(`${server.baseUrl}/api/knowledge/documents/${documentId}`, {
        headers: { 'x-tenant-id': 'tenant-a' },
      });
      assert.equal(readA.status, 200);
      assert.equal(((await readA.json()) as { document: { id: string } }).document.id, documentId);

      const deleteA = await fetch(`${server.baseUrl}/api/knowledge/documents/${documentId}`, {
        method: 'DELETE',
        headers: { 'x-tenant-id': 'tenant-a' },
      });
      assert.equal(deleteA.status, 200);
    } finally {
      await server.close();
    }
  });

  it('fails closed without a tenant binding', async () => {
    const server = await startServer();
    try {
      const response = await fetch(`${server.baseUrl}/api/knowledge/documents`);
      assert.equal(response.status, 403);
    } finally {
      await server.close();
    }
  });

  it('isolates the core-backed status, upload, list, search, and delete routes', async () => {
    const server = await startServer({ role: 'developer' });
    try {
      const upload = await fetch(`${server.baseUrl}/api/knowledge-base/upload`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-tenant-id': 'tenant-a' },
        body: JSON.stringify({
          filename: 'core-secret.txt',
          content: 'tenant-a core rag material',
        }),
      });
      assert.equal(upload.status, 201);
      const documentId = ((await upload.json()) as { documentId: string }).documentId;

      const statusB = await fetch(`${server.baseUrl}/api/knowledge-base/status`, {
        headers: { 'x-tenant-id': 'tenant-b' },
      });
      assert.equal(statusB.status, 200);
      assert.equal(((await statusB.json()) as { documentCount: number }).documentCount, 0);

      const listB = await fetch(`${server.baseUrl}/api/knowledge-base/documents`, {
        headers: { 'x-tenant-id': 'tenant-b' },
      });
      assert.equal(listB.status, 200);
      assert.deepEqual(await listB.json(), { documents: [], count: 0 });

      const searchB = await fetch(`${server.baseUrl}/api/knowledge-base/search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-tenant-id': 'tenant-b' },
        body: JSON.stringify({ query: 'core rag material' }),
      });
      assert.equal(searchB.status, 200);
      assert.equal(((await searchB.json()) as { count: number }).count, 0);

      const deleteB = await fetch(`${server.baseUrl}/api/knowledge-base/documents/${documentId}`, {
        method: 'DELETE',
        headers: { 'x-tenant-id': 'tenant-b' },
      });
      assert.equal(deleteB.status, 404);

      const listA = await fetch(`${server.baseUrl}/api/knowledge-base/documents`, {
        headers: { 'x-tenant-id': 'tenant-a' },
      });
      assert.equal(listA.status, 200);
      const listedA = (await listA.json()) as { documents: Array<{ id: string }>; count: number };
      assert.equal(listedA.count, 1);
      assert.equal(listedA.documents[0]?.id, documentId);

      const searchA = await fetch(`${server.baseUrl}/api/knowledge-base/search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-tenant-id': 'tenant-a' },
        body: JSON.stringify({ query: 'core rag material' }),
      });
      assert.equal(searchA.status, 200);
      const searchedA = (await searchA.json()) as {
        count: number;
        results: Array<{ docId: string }>;
      };
      assert.equal(searchedA.count, 1);
      assert.equal(searchedA.results[0]?.docId, documentId);

      assert.equal(
        fs.existsSync(
          path.join(
            tempDir,
            '.commander',
            'knowledge-base',
            'tenant_tenant-a',
            'kb-documents.json',
          ),
        ),
        true,
      );

      const deleteA = await fetch(`${server.baseUrl}/api/knowledge-base/documents/${documentId}`, {
        method: 'DELETE',
        headers: { 'x-tenant-id': 'tenant-a' },
      });
      assert.equal(deleteA.status, 200);
    } finally {
      await server.close();
    }
  });

  it('requires API-key write authority for all knowledge mutations', async () => {
    const readServer = await startServer({ apiKeyId: 'read-key', apiScopes: ['read'] });
    const writeServer = await startServer({ apiKeyId: 'write-key', apiScopes: ['write'] });
    const adminServer = await startServer({ apiKeyId: 'admin-key', apiScopes: ['admin'] });
    const tenantHeaders = {
      'content-type': 'application/json',
      'x-tenant-id': 'tenant-a',
    };
    const postJson = (server: TestServer, route: string, body: unknown) =>
      fetch(`${server.baseUrl}${route}`, {
        method: 'POST',
        headers: tenantHeaders,
        body: JSON.stringify(body),
      });
    const deleteRoute = (server: TestServer, route: string) =>
      fetch(`${server.baseUrl}${route}`, {
        method: 'DELETE',
        headers: { 'x-tenant-id': 'tenant-a' },
      });
    try {
      const canonicalUpload = await postJson(writeServer, '/api/knowledge/documents', {
        name: 'canonical-scope-protected.txt',
        type: 'text/plain',
        content: 'canonical document must survive a read-scoped delete attempt',
      });
      assert.equal(canonicalUpload.status, 201);
      const canonicalId = ((await canonicalUpload.json()) as { document: { id: string } }).document
        .id;

      const coreUpload = await postJson(writeServer, '/api/knowledge-base/upload', {
        filename: 'core-scope-protected.txt',
        content: 'core document must survive a read-scoped delete attempt',
      });
      assert.equal(coreUpload.status, 201);
      const coreId = ((await coreUpload.json()) as { documentId: string }).documentId;

      const deniedCanonicalDelete = await deleteRoute(
        readServer,
        `/api/knowledge/documents/${canonicalId}`,
      );
      assert.equal(deniedCanonicalDelete.status, 403);
      const canonicalAfterDeniedDelete = await fetch(
        `${readServer.baseUrl}/api/knowledge/documents/${canonicalId}`,
        { headers: { 'x-tenant-id': 'tenant-a' } },
      );
      assert.equal(canonicalAfterDeniedDelete.status, 200);

      const deniedCoreDelete = await deleteRoute(
        readServer,
        `/api/knowledge-base/documents/${coreId}`,
      );
      assert.equal(deniedCoreDelete.status, 403);
      const coreAfterDeniedDelete = await fetch(
        `${readServer.baseUrl}/api/knowledge-base/documents`,
        { headers: { 'x-tenant-id': 'tenant-a' } },
      );
      assert.equal(coreAfterDeniedDelete.status, 200);
      assert.equal(
        ((await coreAfterDeniedDelete.json()) as { documents: Array<{ id: string }> }).documents[0]
          ?.id,
        coreId,
      );

      const deniedCanonicalUpload = await postJson(readServer, '/api/knowledge/documents', {
        name: 'read-only-canonical-upload.txt',
        type: 'text/plain',
        content: 'read-only keys must not add canonical documents',
      });
      assert.equal(deniedCanonicalUpload.status, 403);
      const deniedCoreUpload = await postJson(readServer, '/api/knowledge-base/upload', {
        filename: 'read-only-core-upload.txt',
        content: 'read-only keys must not ingest core documents',
      });
      assert.equal(deniedCoreUpload.status, 403);

      assert.equal(
        (await deleteRoute(writeServer, `/api/knowledge/documents/${canonicalId}`)).status,
        200,
      );
      assert.equal(
        (await deleteRoute(writeServer, `/api/knowledge-base/documents/${coreId}`)).status,
        200,
      );

      const adminCanonicalUpload = await postJson(adminServer, '/api/knowledge/documents', {
        name: 'admin-canonical.txt',
        type: 'text/plain',
        content: 'admin scope canonical mutation control',
      });
      assert.equal(adminCanonicalUpload.status, 201);
      const adminCanonicalId = ((await adminCanonicalUpload.json()) as { document: { id: string } })
        .document.id;
      assert.equal(
        (await deleteRoute(adminServer, `/api/knowledge/documents/${adminCanonicalId}`)).status,
        200,
      );

      const adminCoreUpload = await postJson(adminServer, '/api/knowledge-base/upload', {
        filename: 'scope-protected.txt',
        content: 'admin scope core mutation control',
      });
      assert.equal(adminCoreUpload.status, 201);
      const adminCoreId = ((await adminCoreUpload.json()) as { documentId: string }).documentId;
      assert.equal(
        (await deleteRoute(adminServer, `/api/knowledge-base/documents/${adminCoreId}`)).status,
        200,
      );
    } finally {
      await Promise.all([readServer.close(), writeServer.close(), adminServer.close()]);
    }
  });

  it('allows an admin control principal while rejecting a non-admin principal', async () => {
    resetHookManager();
    const hooks = getHookManager();
    await hooks.register({
      name: 'builtin-rag',
      version: 'test',
      description: 'Focused authorization fixture',
    });
    hooks.disable('builtin-rag');

    const developerServer = await startServer({ role: 'developer' });
    const adminServer = await startServer({ role: 'admin' });
    try {
      const denied = await fetch(`${developerServer.baseUrl}/api/knowledge-base/enable`, {
        method: 'POST',
        headers: { 'x-tenant-id': 'tenant-a' },
      });
      assert.equal(denied.status, 403);
      assert.equal(hooks.isEnabled('builtin-rag'), false);

      const allowed = await fetch(`${adminServer.baseUrl}/api/knowledge-base/enable`, {
        method: 'POST',
        headers: { 'x-tenant-id': 'tenant-a' },
      });
      assert.equal(allowed.status, 200);
      assert.equal(hooks.isEnabled('builtin-rag'), true);

      const deniedDisable = await fetch(`${developerServer.baseUrl}/api/knowledge-base/disable`, {
        method: 'POST',
        headers: { 'x-tenant-id': 'tenant-a' },
      });
      assert.equal(deniedDisable.status, 403);
      assert.equal(hooks.isEnabled('builtin-rag'), true);

      const allowedDisable = await fetch(`${adminServer.baseUrl}/api/knowledge-base/disable`, {
        method: 'POST',
        headers: { 'x-tenant-id': 'tenant-a' },
      });
      assert.equal(allowedDisable.status, 200);
      assert.equal(hooks.isEnabled('builtin-rag'), false);
    } finally {
      await Promise.all([developerServer.close(), adminServer.close()]);
      resetHookManager();
    }
  });
});
