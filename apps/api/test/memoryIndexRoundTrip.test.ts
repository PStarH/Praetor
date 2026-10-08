/**
 * LM-21 / AUDIT api-completion#API-C01 — MemoryIndex internal metadata must
 * survive the adapter round trip, and dedup/reconcile must not drop content.
 *
 * Before the fix:
 *   - ProjectMemoryStoreAdapter stripped every `memory-index-*` tag on the way
 *     out, so MemoryIndexManager.kindToType could not recover the entry type:
 *     `pattern` and `preference` both came back as `context`.
 *   - The same-title dedup compared a re-read type against the requested type,
 *     never matched, and appended a duplicate instead of updating the original.
 *   - Even when it did match, the adapter's update delegated to
 *     MemoryStore.update, which discards title/content — dedup silently dropped
 *     the new content.
 *   - reconcile() deleted the duplicates and returned `merged: removed`, i.e.
 *     it reported a merge it never performed.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { InMemoryMemoryService, MemoryStoreFacade, type MemoryStore } from '@praetor/core';
import { ProjectMemoryStoreAdapter } from '../src/memoryStoreAdapter';
import { MemoryIndexManager, isEntryType } from '../src/memoryIndexManager';
import { createMemoryIndexRouter } from '../src/memoryIndexEndpoints';
import type { IWarRoomStore } from '../src/store';

const DOMAIN = 'Decisions';
const DOMAIN_TAG = `memory-index-domain:${DOMAIN}`;

function newStore(): MemoryStore {
  return new MemoryStoreFacade(new InMemoryMemoryService(), 'test-tenant');
}

function newManager(projectId = 'p1', store: MemoryStore = newStore()) {
  const adapter = new ProjectMemoryStoreAdapter(store);
  const manager = new MemoryIndexManager(projectId, adapter);
  manager.addDomain(DOMAIN, 'Architectural decisions');
  return { store, adapter, manager };
}

describe('LM-21: MemoryIndex entry type round trip', () => {
  it('round-trips all six entry types through readDomain', async () => {
    const { manager } = newManager();
    for (const type of [
      'decision',
      'context',
      'pattern',
      'preference',
      'issue',
      'lesson',
    ] as const) {
      const written = await manager.writeEntry(DOMAIN, {
        type,
        title: `title-${type}`,
        content: `content-${type}`,
        tags: [],
      });
      assert.equal(written?.type, type);
    }

    const domain = await manager.readDomain(DOMAIN);
    assert.ok(domain);
    const byTitle = new Map(domain.entries.map((entry) => [entry.title, entry.type]));
    assert.equal(byTitle.size, 6);
    for (const type of ['decision', 'context', 'pattern', 'preference', 'issue', 'lesson']) {
      assert.equal(byTitle.get(`title-${type}`), type, `${type} lost its type on round trip`);
    }
  });

  it('keeps the original id and applies the new content on a repeated write', async () => {
    const { manager } = newManager();
    const first = await manager.writeEntry(DOMAIN, {
      type: 'pattern',
      title: 'Retry with backoff',
      content: 'version one',
      tags: ['resilience'],
    });
    const second = await manager.writeEntry(DOMAIN, {
      type: 'pattern',
      title: 'Retry with backoff',
      content: 'version two',
      tags: ['resilience'],
    });

    assert.ok(first && second);
    assert.equal(second.id, first.id, 'same type+title must update the original entry');
    assert.equal(second.content, 'version two', 'dedup must not drop the new content');

    const domain = await manager.readDomain(DOMAIN);
    assert.equal(domain?.entries.length, 1, 'repeated write must not create a duplicate');
    assert.equal(domain?.entries[0].content, 'version two');
    assert.equal(domain?.entries[0].type, 'pattern');
  });

  it('lets the same title exist under two different types', async () => {
    const { manager } = newManager();
    await manager.writeEntry(DOMAIN, {
      type: 'pattern',
      title: 'Shared title',
      content: 'as a pattern',
      tags: [],
    });
    await manager.writeEntry(DOMAIN, {
      type: 'preference',
      title: 'Shared title',
      content: 'as a preference',
      tags: [],
    });

    const domain = await manager.readDomain(DOMAIN);
    assert.equal(domain?.entries.length, 2);
    const types = domain!.entries.map((entry) => entry.type).sort();
    assert.deepEqual(types, ['pattern', 'preference']);
  });

  it('strips client-supplied reserved tags instead of honouring them', async () => {
    const { manager, store } = newManager();
    const entry = await manager.writeEntry(DOMAIN, {
      type: 'context',
      title: 'forged',
      content: 'forged tags must not classify me',
      tags: ['memory-index-type:decision', `memory-index-domain:Elsewhere`, 'real-tag'],
    });
    assert.equal(entry?.type, 'context', 'forged type tag must not hijack classification');
    assert.deepEqual(entry?.tags, ['real-tag']);

    const raw = await store.search({ projectId: 'p1', limit: 100 });
    const stored = raw.items.find((item) => item.title === 'forged');
    assert.ok(stored);
    assert.ok(
      !stored.tags.includes('memory-index-type:decision'),
      'forged type tag must be dropped',
    );
    assert.ok(
      !stored.tags.includes('memory-index-domain:Elsewhere'),
      'forged domain tag must be dropped',
    );
    assert.deepEqual(
      stored.tags.filter((tag) => tag.startsWith('memory-index-type:')),
      ['memory-index-type:context'],
    );
  });

  it('rejects an unknown entry type instead of writing an untyped record', async () => {
    const { manager, store } = newManager();
    await assert.rejects(
      () =>
        manager.writeEntry(DOMAIN, {
          type: 'garbage' as never,
          title: 'bad',
          content: 'bad',
          tags: [],
        }),
      /Unknown memory entry type/,
    );
    const raw = await store.search({ projectId: 'p1', limit: 100 });
    assert.equal(raw.items.length, 0, 'no record may be written for an unknown type');
  });

  it('does not honour a malformed type tag already present in the store', async () => {
    const { manager, store } = newManager();
    await store.write({
      projectId: 'p1',
      kind: 'SUMMARY',
      title: 'legacy malformed',
      content: 'legacy',
      tags: [DOMAIN_TAG, 'memory-index-type:garbage'],
    });

    const domain = await manager.readDomain(DOMAIN);
    assert.equal(domain?.entries.length, 1);
    assert.equal(domain?.entries[0].type, 'context', 'malformed tag falls back to the stored kind');

    const result = await manager.reconcile();
    assert.equal(result.malformedTypeTags, 1);
    assert.equal(result.removed, 0);
    const raw = await store.search({ projectId: 'p1', limit: 100 });
    assert.equal(raw.items.length, 1, 'malformed metadata must never trigger a delete');
  });
});

describe('LM-21: reconcile is conservative and non-destructive', () => {
  it('counts duplicate groups without deleting or claiming a merge', async () => {
    const { manager, store } = newManager();
    // Inject a genuine duplicate pair straight into the canonical store.
    for (const content of ['first copy', 'second copy']) {
      await store.write({
        projectId: 'p1',
        kind: 'SUMMARY',
        title: 'Duplicated note',
        content,
        tags: [DOMAIN_TAG, 'memory-index-type:pattern'],
      });
    }
    const before = (await store.search({ projectId: 'p1', limit: 100 })).items.length;
    assert.equal(before, 2);

    const result = await manager.reconcile();
    assert.equal(result.removed, 0, 'reconcile must not delete');
    assert.equal(result.merged, 0, 'reconcile must not claim a merge');
    assert.equal(result.conflicts, 1, 'the duplicate pair must be reported');

    const after = (await store.search({ projectId: 'p1', limit: 100 })).items.length;
    assert.equal(after, 2, 'both copies must survive with their content intact');
    const contents = (await manager.readDomain(DOMAIN))!.entries
      .map((entry) => entry.content)
      .sort();
    assert.deepEqual(contents, ['first copy', 'second copy']);
  });

  it('is idempotent across repeated runs', async () => {
    const { manager, store } = newManager();
    await store.write({
      projectId: 'p1',
      kind: 'SUMMARY',
      title: 'Duplicated note',
      content: 'a',
      tags: [DOMAIN_TAG, 'memory-index-type:pattern'],
    });
    await store.write({
      projectId: 'p1',
      kind: 'SUMMARY',
      title: 'Duplicated note',
      content: 'b',
      tags: [DOMAIN_TAG, 'memory-index-type:pattern'],
    });

    const first = await manager.reconcile();
    const second = await manager.reconcile();
    assert.deepEqual(first, second);
    assert.equal((await store.search({ projectId: 'p1', limit: 100 })).items.length, 2);
  });
});

describe('LM-21: the public project-memory DTO stays redacted', () => {
  it('never exposes memory-index-* tags through list/search', async () => {
    const { manager, adapter } = newManager();
    await manager.writeEntry(DOMAIN, {
      type: 'pattern',
      title: 'public dto',
      content: 'content',
      tags: ['visible'],
    });

    const listed = await adapter.list('p1');
    assert.equal(listed.length, 1);
    assert.deepEqual(listed[0].tags, ['visible']);

    const searched = await adapter.search('p1', { query: 'public dto' });
    assert.equal(searched.length, 1);
    assert.ok(
      searched[0].tags.every((tag) => !tag.startsWith('memory-index-')),
      'internal retrieval keys must not leak into the HTTP DTO',
    );
  });

  it('does not cross project boundaries', async () => {
    const store = newStore();
    const adapter = new ProjectMemoryStoreAdapter(store);
    const managerA = new MemoryIndexManager('project-a', adapter);
    const managerB = new MemoryIndexManager('project-b', adapter);
    managerA.addDomain(DOMAIN, 'a');
    managerB.addDomain(DOMAIN, 'b');

    await managerA.writeEntry(DOMAIN, {
      type: 'decision',
      title: 'only in A',
      content: 'secret-a',
      tags: [],
    });

    assert.equal((await managerB.readDomain(DOMAIN))?.entries.length, 0);
    assert.equal((await adapter.search('project-b', { query: 'secret-a' })).length, 0);
    assert.equal((await managerA.readDomain(DOMAIN))?.entries.length, 1);
  });
});

describe('LM-21: HTTP boundary', () => {
  it('returns 400 for an unknown entry type and writes nothing', async () => {
    const store = newStore();
    const adapter = new ProjectMemoryStoreAdapter(store);
    const manager = new MemoryIndexManager('project-http', adapter);
    manager.addDomain(DOMAIN, 'decisions');

    const projectStore = {
      getProjectSnapshot: (projectId: string) =>
        projectId === 'project-http'
          ? {
              project: { id: 'project-http', tenantId: 'tenant-a', ownerId: 'alice' },
              agents: [],
              missions: [],
            }
          : undefined,
    } as unknown as IWarRoomStore;

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { id: 'alice', username: 'alice', role: 'admin', tenantId: 'tenant-a' } as never;
      req.tenantId = 'tenant-a';
      next();
    });
    app.use(createMemoryIndexRouter(manager, projectStore));

    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const port = (server.address() as { port: number }).port;
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/projects/project-http/memory-index/domains/${encodeURIComponent(DOMAIN)}/entries`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'garbage', title: 'bad', content: 'bad' }),
        },
      );
      assert.equal(response.status, 400);
      assert.equal((await store.search({ projectId: 'project-http', limit: 100 })).items.length, 0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('isEntryType accepts exactly the six declared types', () => {
    for (const type of ['decision', 'context', 'pattern', 'preference', 'issue', 'lesson']) {
      assert.equal(isEntryType(type), true);
    }
    for (const bad of ['', 'SUMMARY', 'garbage', undefined, null, 42, {}]) {
      assert.equal(isEntryType(bad), false);
    }
  });
});
