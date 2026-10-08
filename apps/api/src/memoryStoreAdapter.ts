import {
  writeProductMemory,
  type MemoryStore,
  type MemorySearchQuery,
  type ProjectMemoryItem,
  type ProjectMemoryOverview,
  type ProjectMemorySearchOptions,
} from '@praetor/core';

/**
 * Adapter that exposes project-level memory operations on top of the canonical
 * MemoryStore interface from @praetor/core.
 *
 * This is the convergence layer recommended by the memory mechanism research:
 * API-layer semantics (list/overview/search/append) are implemented as a thin
 * translation over the core MemoryStore, eliminating the duplicated JSON-file
 * persistence paths in apps/api while keeping the HTTP/project DTO contract
 * stable during migration.
 *
 * Product writes go through writeProductMemory (L3-10a) → MEMORY-001.
 *
 * ── Public vs. index-internal reads (LM-21 / AUDIT api-completion#API-C01) ──
 * The `memory-index-*` tags are MemoryIndexManager retrieval keys. They must
 * never appear in the HTTP project-memory DTO, so the public methods strip
 * them. But the manager *depends* on the `memory-index-type:` tag to round-trip
 * the entry type: `SUMMARY` is the storage kind for three distinct entry types
 * (context / pattern / preference), and the kind alone cannot tell them apart.
 * Stripping the tag on the manager's own read path silently degraded every
 * pattern and preference to `context`, which broke same-title dedup (a second
 * write appended a duplicate instead of updating the original id).
 *
 * The `*IndexEntry` methods below are the manager's private read/write path and
 * preserve the internal tags. They are deliberately separate method names, not
 * a boolean flag, so no HTTP handler can reach the unredacted shape by
 * forwarding a query/body field.
 */
export class ProjectMemoryStoreAdapter {
  constructor(private readonly store: MemoryStore) {}

  async list(projectId: string, limit?: number): Promise<ProjectMemoryItem[]> {
    const result = await this.store.search({ projectId, limit });
    return result.items.map((item) => this.toProjectMemoryItem(item));
  }

  async overview(projectId: string): Promise<ProjectMemoryOverview> {
    const stats = await this.store.getStats(projectId);
    return {
      totalItems: stats.totalItems,
      kindCounts: stats.byKind,
      topTags: stats.topTags.slice(0, 8),
      missionLinkedCount: 0, // store stats don't expose this; can be derived later
      agentLinkedCount: 0,
      latestCreatedAt: stats.newestItem,
    };
  }

  async search(
    projectId: string,
    options: ProjectMemorySearchOptions = {},
  ): Promise<ProjectMemoryItem[]> {
    const query: MemorySearchQuery = {
      projectId,
      kind: options.kind,
      tags: options.tags,
      query: options.query,
      limit: options.limit,
      minPriority: options.minPriority,
      minConfidence: options.minConfidence,
    };
    const result = await this.store.search(query);
    return result.items.map((item) => this.toProjectMemoryItem(item));
  }

  async append(
    input: Omit<
      ProjectMemoryItem,
      'id' | 'priority' | 'confidence' | 'lastAccessedAt' | 'createdAt'
    >,
  ): Promise<ProjectMemoryItem> {
    const item = await this.writeItem(input);
    return this.toProjectMemoryItem(item);
  }

  async update(
    projectId: string,
    id: string,
    updates: Pick<
      ProjectMemoryItem,
      'title' | 'content' | 'tags' | 'priority' | 'confidence' | 'expiresAt'
    >,
  ): Promise<ProjectMemoryItem | null> {
    const item = await this.updateItem(projectId, id, updates);
    return item ? this.toProjectMemoryItem(item) : null;
  }

  async delete(projectId: string, id: string): Promise<boolean> {
    return this.store.delete(id, projectId);
  }

  async close(): Promise<void> {
    await this.store.close();
  }

  // ── MemoryIndexManager internal path (metadata-preserving) ────────────────

  /** Manager-only read path: keeps `memory-index-*` tags intact. */
  async searchIndexEntries(
    projectId: string,
    options: ProjectMemorySearchOptions = {},
  ): Promise<ProjectMemoryItem[]> {
    const result = await this.store.search({
      projectId,
      kind: options.kind,
      tags: options.tags,
      query: options.query,
      limit: options.limit,
      minPriority: options.minPriority,
      minConfidence: options.minConfidence,
    });
    return result.items.map((item) => this.toProjectMemoryItem(item, true));
  }

  /** Manager-only write path: returns the item with internal tags intact. */
  async appendIndexEntry(
    input: Omit<
      ProjectMemoryItem,
      'id' | 'priority' | 'confidence' | 'lastAccessedAt' | 'createdAt'
    >,
  ): Promise<ProjectMemoryItem> {
    return this.toProjectMemoryItem(await this.writeItem(input), true);
  }

  /** Manager-only update path: keeps the id stable and preserves metadata. */
  async updateIndexEntry(
    projectId: string,
    id: string,
    updates: Pick<
      ProjectMemoryItem,
      'title' | 'content' | 'tags' | 'priority' | 'confidence' | 'expiresAt'
    >,
  ): Promise<ProjectMemoryItem | null> {
    const item = await this.updateItem(projectId, id, updates);
    return item ? this.toProjectMemoryItem(item, true) : null;
  }

  private async writeItem(
    input: Omit<
      ProjectMemoryItem,
      'id' | 'priority' | 'confidence' | 'lastAccessedAt' | 'createdAt'
    >,
  ) {
    return writeProductMemory(this.store, {
      projectId: input.projectId,
      missionId: input.missionId,
      agentId: input.agentId,
      kind: input.kind,
      title: input.title,
      content: input.content,
      tags: input.tags,
      duration: input.duration,
      evidenceRefs: input.evidenceRefs,
    });
  }

  /**
   * Real upsert-by-id update.
   *
   * `MemoryStore.update` only accepts `priority | tags | confidence | expiresAt |
   * lastAccessedAt` — title/content edits are silently discarded by the facade.
   * Rewriting through `writeProductMemory` with the existing id keeps the id and
   * createdAt stable (the service upserts on id) while actually persisting the
   * caller's title/content. Without this, MemoryIndexManager's "update the
   * existing entry" branch changed nothing but the tags, i.e. dedup dropped the
   * new content.
   */
  private async updateItem(
    projectId: string,
    id: string,
    updates: Pick<
      ProjectMemoryItem,
      'title' | 'content' | 'tags' | 'priority' | 'confidence' | 'expiresAt'
    >,
  ) {
    const current = await this.store.read(id, projectId);
    if (!current) return null;
    const written = await writeProductMemory(this.store, {
      id,
      projectId,
      missionId: current.missionId,
      agentId: current.agentId,
      kind: current.kind,
      duration: current.duration,
      title: updates.title ?? current.title,
      content: updates.content ?? current.content,
      tags: updates.tags ?? current.tags,
      priority: updates.priority ?? current.priority,
      confidence: updates.confidence ?? current.confidence,
      evidenceRefs: current.evidenceRefs,
    });
    // `expiresAt` is not part of the write contract, so it is applied through
    // the manage path when the caller asked for a different value. (Clearing an
    // existing expiry back to `undefined` is not expressible through
    // MemoryStore.update either; that is pre-existing behaviour, not a
    // regression introduced here.)
    const desiredExpiresAt = updates.expiresAt ?? current.expiresAt;
    if (written.expiresAt !== desiredExpiresAt) {
      const adjusted = await this.store.update({
        id,
        projectId,
        updates: { expiresAt: desiredExpiresAt },
      });
      if (adjusted) return adjusted;
    }
    return written;
  }

  private toProjectMemoryItem(
    item: NonNullable<Awaited<ReturnType<MemoryStore['read']>>>,
    includeIndexMetadata = false,
  ): ProjectMemoryItem {
    return {
      id: item.id,
      projectId: item.projectId,
      missionId: item.missionId,
      agentId: item.agentId,
      kind: item.kind,
      duration: item.duration,
      title: item.title,
      content: item.content,
      // memory-index-* tags are the MemoryIndexManager's internal retrieval
      // keys (mirror lookups filter on them) — implementation detail, not
      // part of the user-facing project-memory surface.
      tags: includeIndexMetadata
        ? [...item.tags]
        : item.tags.filter((tag) => !tag.startsWith('memory-index-')),
      priority: item.priority,
      confidence: item.confidence,
      createdAt: item.createdAt,
      lastAccessedAt: item.lastAccessedAt,
      expiresAt: item.expiresAt,
      evidenceRefs: item.evidenceRefs,
    };
  }
}
