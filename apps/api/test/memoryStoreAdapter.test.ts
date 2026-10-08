import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import {
  createSeedWarRoomData,
  getProjectWarRoomSnapshot,
  InMemoryMemoryService,
  MemoryStoreFacade,
} from '@praetor/core';
import { ProjectMemoryStoreAdapter } from '../src/memoryStoreAdapter';
import type { IWarRoomStore } from '../src/store';

// Set memory index dir BEFORE requiring MemoryIndexManager. Its top-level
// constant captures the env var at module-load time, so the import must happen
// after this assignment.
const MEMORY_DIR = path.join(
  os.tmpdir(),
  `commander-memory-index-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
);
fs.mkdirSync(MEMORY_DIR, { recursive: true });
process.env['COMMANDER_MEMORY_DIR'] = MEMORY_DIR;

const createStore = () => new MemoryStoreFacade(new InMemoryMemoryService(), 'test-tenant');

after(async () => {
  fs.rmSync(MEMORY_DIR, { recursive: true, force: true });
});

describe('ProjectMemoryStoreAdapter', () => {
  it('appends and retrieves a memory', async () => {
    const store = createStore();
    const adapter = new ProjectMemoryStoreAdapter(store);

    const item = await adapter.append({
      projectId: 'p1',
      kind: 'LESSON',
      title: 'test memory',
      content: 'test content',
      tags: ['t1'],
      duration: 'EPISODIC',
    });

    assert.ok(item.id);
    assert.equal(item.title, 'test memory');

    const listed = await adapter.list('p1');
    assert.equal(listed.length, 1);
    assert.equal(listed[0].title, 'test memory');
  });

  it('returns an overview', async () => {
    const store = createStore();
    const adapter = new ProjectMemoryStoreAdapter(store);

    await adapter.append({
      projectId: 'p1',
      kind: 'LESSON',
      title: 'overview test',
      content: 'content',
      tags: ['tag-a'],
      duration: 'EPISODIC',
    });

    const overview = await adapter.overview('p1');
    assert.equal(overview.totalItems, 1);
    assert.equal(overview.kindCounts.LESSON, 1);
    assert.equal(overview.topTags.length, 1);
    assert.equal(overview.topTags[0].tag, 'tag-a');
  });

  it('searches by query', async () => {
    const store = createStore();
    const adapter = new ProjectMemoryStoreAdapter(store);

    await adapter.append({
      projectId: 'p1',
      kind: 'LESSON',
      title: 'auth flow',
      content: 'Use OAuth2 PKCE for mobile auth',
      tags: ['auth'],
      duration: 'LONG_TERM',
    });

    await adapter.append({
      projectId: 'p1',
      kind: 'DECISION',
      title: 'db config',
      content: 'Enable WAL mode for SQLite',
      tags: ['db'],
      duration: 'LONG_TERM',
    });

    const results = await adapter.search('p1', { query: 'OAuth' });
    assert.equal(results.length, 1);
    assert.equal(results[0].title, 'auth flow');
  });
});

describe('MemoryIndexManager + ProjectMemoryStoreAdapter integration', () => {
  let MemoryIndexManager: typeof import('../src/memoryIndexManager').MemoryIndexManager;

  before(async () => {
    ({ MemoryIndexManager } = await import('../src/memoryIndexManager'));
  });

  it('mirrors domain entries into the adapter-backed project memory store', async () => {
    const store = createStore();
    const adapter = new ProjectMemoryStoreAdapter(store);
    const manager = new MemoryIndexManager('project-mirror', adapter);
    manager.addDomain('Decisions', 'Architectural decisions');

    const entry = await manager.writeEntry('Decisions', {
      type: 'decision',
      title: 'Use SQLite for memory',
      content: 'We decided to use SQLite for long-term project memory.',
      tags: ['db', 'sqlite'],
    });

    assert.ok(entry);
    assert.equal(entry.title, 'Use SQLite for memory');

    const items = await adapter.search('project-mirror', { query: 'SQLite' });
    assert.equal(items.length, 1);
    assert.equal(items[0].title, 'Use SQLite for memory');
    assert.equal(items[0].kind, 'DECISION');
    assert.equal(items[0].duration, 'LONG_TERM');
    assert.deepEqual(items[0].tags, ['db', 'sqlite']);
  });

  it('maps all memory-index entry types to ProjectMemoryItem kinds', async () => {
    const store = createStore();
    const adapter = new ProjectMemoryStoreAdapter(store);
    const manager = new MemoryIndexManager('project-kinds', adapter);
    manager.addDomain('AllTypes', 'Kind mapping coverage');

    await manager.writeEntry('AllTypes', {
      type: 'issue',
      title: 'Issue entry',
      content: 'Issue content',
      tags: ['issue'],
    });
    await manager.writeEntry('AllTypes', {
      type: 'lesson',
      title: 'Lesson entry',
      content: 'Lesson content',
      tags: ['lesson'],
    });
    await manager.writeEntry('AllTypes', {
      type: 'context',
      title: 'Context entry',
      content: 'Context content',
      tags: ['context'],
    });
    await manager.writeEntry('AllTypes', {
      type: 'pattern',
      title: 'Pattern entry',
      content: 'Pattern content',
      tags: ['pattern'],
    });
    await manager.writeEntry('AllTypes', {
      type: 'preference',
      title: 'Preference entry',
      content: 'Preference content',
      tags: ['preference'],
    });

    const all = await adapter.list('project-kinds');
    assert.equal(all.length, 5);
    assert.equal(all.filter((i) => i.kind === 'ISSUE').length, 1);
    assert.equal(all.filter((i) => i.kind === 'LESSON').length, 1);
    assert.equal(all.filter((i) => i.kind === 'SUMMARY').length, 3);
  });
});

describe('memoryIndexEndpoints with ProjectMemoryStoreAdapter', () => {
  let createMemoryIndexRouter: typeof import('../src/memoryIndexEndpoints').createMemoryIndexRouter;
  let MemoryIndexManager: typeof import('../src/memoryIndexManager').MemoryIndexManager;
  let server: http.Server;
  let baseUrl: string;
  let adapter: ProjectMemoryStoreAdapter;

  before(async () => {
    [{ createMemoryIndexRouter }, { MemoryIndexManager }] = await Promise.all([
      import('../src/memoryIndexEndpoints'),
      import('../src/memoryIndexManager'),
    ]);

    const store = createStore();
    adapter = new ProjectMemoryStoreAdapter(store);
    const manager = new MemoryIndexManager('project-endpoints', adapter, [
      { domain: 'Decisions', description: 'Architectural decisions' },
    ]);
    const data = createSeedWarRoomData();
    Object.assign(data.projects[0], {
      id: 'project-endpoints',
      tenantId: 'tenant-a',
      ownerId: 'alice',
    });
    data.projects.push({
      ...data.projects[0],
      id: 'project-other',
      name: 'Other Project',
      ownerId: 'bob',
    });
    const projectStore = {
      getProjectSnapshot: (projectId: string) => getProjectWarRoomSnapshot(data, projectId),
    } as IWarRoomStore;
    const router = createMemoryIndexRouter(manager, projectStore);

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const principal = req.header('x-test-principal');
      if (principal) {
        req.user = {
          id: principal,
          username: principal,
          role: req.header('x-test-role') === 'admin' ? 'admin' : 'developer',
          tenantId: req.header('x-test-tenant') ?? undefined,
        };
        req.tenantId = req.user.tenantId;
      }
      next();
    });
    app.use(router);

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('POST /projects/:projectId/memory-index/domains/:domain/entries writes through adapter', async () => {
    const response = await fetch(
      `${baseUrl}/projects/project-endpoints/memory-index/domains/Decisions/entries`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-test-principal': 'alice',
          'x-test-tenant': 'tenant-a',
        },
        body: JSON.stringify({
          type: 'decision',
          title: 'Endpoint decision',
          content: 'Adapter-backed endpoint works.',
          tags: ['api'],
        }),
      },
    );
    assert.equal(response.status, 201);

    const body = await response.json();
    assert.equal(body.title, 'Endpoint decision');

    const items = await adapter.search('project-endpoints', { query: 'Adapter-backed' });
    assert.equal(items.length, 1);
    assert.equal(items[0].title, 'Endpoint decision');
    assert.equal(items[0].kind, 'DECISION');
  });

  it('rejects wrong same-tenant project reads and mutations without touching the fixed project', async () => {
    const request = (pathname: string, init?: RequestInit) =>
      fetch(`${baseUrl}${pathname}`, {
        ...init,
        headers: {
          'content-type': 'application/json',
          'x-test-principal': 'alice',
          'x-test-tenant': 'tenant-a',
          ...(init?.headers ?? {}),
        },
      });

    const responses = await Promise.all([
      request('/projects/project-other/memory-index/domains'),
      request('/projects/project-other/memory-index/domains/Decisions'),
      request('/projects/project-other/memory-index/domains', {
        method: 'POST',
        body: JSON.stringify({ domain: 'Forged', description: 'forged' }),
      }),
      request('/projects/project-other/memory-index/domains/Decisions/entries', {
        method: 'POST',
        body: JSON.stringify({ type: 'decision', title: 'Forged', content: 'forged' }),
      }),
      request('/projects/project-other/memory-index/reconcile', { method: 'POST' }),
    ]);
    assert.deepEqual(
      responses.map((response) => response.status),
      [404, 404, 404, 404, 404],
    );
    assert.equal((await adapter.search('project-endpoints', { query: 'Forged' })).length, 0);
  });

  it('does not expose project A domain metadata when project B is first accessed later', async () => {
    const projectAHeaders = {
      'content-type': 'application/json',
      'x-test-principal': 'alice',
      'x-test-tenant': 'tenant-a',
    };
    const secretDomain = 'Alice Private Decisions';
    const secretDescription = 'Only Alice may see this domain';
    const secretContent = 'project A confidential content';
    const createdDomainResponse = await fetch(
      `${baseUrl}/projects/project-endpoints/memory-index/domains`,
      {
        method: 'POST',
        headers: projectAHeaders,
        body: JSON.stringify({ domain: secretDomain, description: secretDescription }),
      },
    );
    assert.equal(createdDomainResponse.status, 201);
    const createdDomain = (await createdDomainResponse.json()) as { lastUpdated: string };

    const createdEntryResponse = await fetch(
      `${baseUrl}/projects/project-endpoints/memory-index/domains/${encodeURIComponent(secretDomain)}/entries`,
      {
        method: 'POST',
        headers: projectAHeaders,
        body: JSON.stringify({
          type: 'decision',
          title: 'Alice private entry',
          content: secretContent,
        }),
      },
    );
    assert.equal(createdEntryResponse.status, 201);

    const projectBHeaders = {
      'x-test-principal': 'bob',
      'x-test-tenant': 'tenant-a',
    };
    const listResponse = await fetch(`${baseUrl}/projects/project-other/memory-index/domains`, {
      headers: projectBHeaders,
    });
    assert.equal(listResponse.status, 200);
    const serializedList = JSON.stringify(await listResponse.json());
    for (const secret of [
      secretDomain,
      secretDescription,
      createdDomain.lastUpdated,
      secretContent,
    ]) {
      assert.equal(serializedList.includes(secret), false);
    }

    const readResponse = await fetch(
      `${baseUrl}/projects/project-other/memory-index/domains/${encodeURIComponent(secretDomain)}`,
      { headers: projectBHeaders },
    );
    assert.equal(readResponse.status, 404);
    const serializedRead = JSON.stringify(await readResponse.json());
    for (const secret of [
      secretDomain,
      secretDescription,
      createdDomain.lastUpdated,
      secretContent,
    ]) {
      assert.equal(serializedRead.includes(secret), false);
    }
    assert.equal((await adapter.search('project-other', { query: secretContent })).length, 0);
  });

  it('uses project-scoped storage for the project owner and preserves tenant-admin access', async () => {
    const ownerHeaders = {
      'content-type': 'application/json',
      'x-test-principal': 'bob',
      'x-test-tenant': 'tenant-a',
    };
    assert.equal(
      (
        await fetch(`${baseUrl}/projects/project-other/memory-index/domains`, {
          method: 'POST',
          headers: ownerHeaders,
          body: JSON.stringify({ domain: 'Owner Domain', description: 'project B only' }),
        })
      ).status,
      201,
    );
    assert.equal(
      (
        await fetch(
          `${baseUrl}/projects/project-other/memory-index/domains/Owner%20Domain/entries`,
          {
            method: 'POST',
            headers: ownerHeaders,
            body: JSON.stringify({
              type: 'decision',
              title: 'Project B decision',
              content: 'belongs only to project B',
            }),
          },
        )
      ).status,
      201,
    );
    assert.equal(
      (
        await fetch(`${baseUrl}/projects/project-other/memory-index/domains/Owner%20Domain`, {
          headers: ownerHeaders,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await fetch(`${baseUrl}/projects/project-other/memory-index/reconcile`, {
          method: 'POST',
          headers: ownerHeaders,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await fetch(`${baseUrl}/projects/project-other/memory-index/domains`, {
          headers: {
            ...ownerHeaders,
            'x-test-principal': 'tenant-admin',
            'x-test-role': 'admin',
          },
        })
      ).status,
      200,
    );

    assert.equal((await adapter.search('project-other', { query: 'project B' })).length, 1);
    assert.equal((await adapter.search('project-endpoints', { query: 'project B' })).length, 0);
  });
});
