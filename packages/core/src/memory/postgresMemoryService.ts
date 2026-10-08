import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createVerifiedPostgresPool } from '@praetor/postgres-runtime';
import { reportSilentFailure } from '../silentFailureReporter';
import type {
  ForgetMemoryInput,
  ListMemoryInput,
  MemoryAuditPage,
  MemoryPage,
  MemoryRecord,
  MemoryRetentionPolicy,
  MemoryScope,
  MemorySearchResult,
  MemoryService,
  MemoryServiceAudit,
  MemoryServiceMaintenance,
  QueryMemoryAuditInput,
  RetrieveMemoryInput,
  SearchMemoryInput,
  StoreMemoryInput,
} from './memoryService';
import { assertForgetTarget, assertLimit, assertMemoryScope } from './memoryService';
import { assertNamespacedStoreInput } from './namespaceGuard';
import { memorySchemaStatements, vectorSchemaStatements } from './postgresMemorySchema';

interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
}

interface PostgresClient {
  query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<QueryResult<T>>;
  release(error?: Error): void;
}

interface PostgresPool {
  query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<QueryResult<T>>;
  connect(): Promise<PostgresClient>;
  end(): Promise<void>;
}

export interface PostgresMemoryServiceOptions {
  connectionString?: string;
  pool?: PostgresPool;
  /** Whether this instance owns schema setup. Runtime roles should defer to migrations. */
  manageSchema?: boolean;
  retention?: MemoryRetentionPolicy;
  embeddingDimension?: number;
  now?: () => Date;
}

type MemoryRow = Record<string, unknown>;

const BASE_LIMIT = 50;
const MAX_LIMIT = 500;

function jsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function jsonArray(value: unknown): string[] {
  const parsed = jsonValue(value);
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === 'string')
    : [];
}

function isoDate(value: unknown, fallback: string): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value.length > 0) return new Date(value).toISOString();
  return fallback;
}

function vectorLiteral(values: number[]): string {
  if (values.some((value) => !Number.isFinite(value))) {
    throw new Error('embedding values must be finite numbers');
  }
  return `[${values.join(',')}]`;
}

function cloneRecord(record: MemoryRecord): MemoryRecord {
  return {
    ...record,
    tags: [...record.tags],
    evidenceRefs: record.evidenceRefs ? [...record.evidenceRefs] : undefined,
    meta: record.meta ? { ...record.meta } : undefined,
    embedding: record.embedding ? [...record.embedding] : undefined,
  };
}

export class PostgresMemoryService
  implements MemoryService, MemoryServiceMaintenance, MemoryServiceAudit
{
  private readonly pool: PostgresPool;
  private readonly ownsPool: boolean;
  private readonly manageSchema: boolean;
  private readonly retention: MemoryRetentionPolicy;
  private readonly embeddingDimension?: number;
  private readonly now: () => Date;
  private readonly clientStore = new AsyncLocalStorage<PostgresClient>();
  private initializePromise: Promise<void> | undefined;
  private vectorEnabled = false;
  private vectorError: Error | undefined;

  constructor(options: PostgresMemoryServiceOptions) {
    this.retention = options.retention ?? {};
    this.manageSchema = options.manageSchema ?? true;
    this.embeddingDimension = options.embeddingDimension;
    this.now = options.now ?? (() => new Date());
    if (options.pool) {
      this.pool = options.pool;
      this.ownsPool = false;
      return;
    }
    if (!options.connectionString) {
      throw new Error('PostgresMemoryService requires connectionString or pool');
    }
    this.pool = createVerifiedPostgresPool({ connectionString: options.connectionString });
    this.ownsPool = true;
  }

  async initialize(): Promise<void> {
    if (!this.initializePromise) {
      this.initializePromise = this.bootstrap().catch((error) => {
        this.initializePromise = undefined;
        throw error;
      });
    }
    await this.initializePromise;
  }

  async store(input: StoreMemoryInput): Promise<MemoryRecord> {
    assertMemoryScope(input.scope);
    await this.initialize();
    if (!input.title.trim() || !input.content.trim()) {
      throw new Error('title and content must be non-empty');
    }
    if (input.embedding && !this.vectorEnabled) {
      throw this.vectorError ?? new Error('vector search is not available');
    }

    const now = this.now();
    const id = input.id ?? randomUUID();
    const agentId = input.agentId ?? input.scope.agentId;
    assertNamespacedStoreInput({
      agentId,
      id,
      meta: input.meta,
      namespaceAcl: input.namespaceAcl,
    });
    const createdAt = now.toISOString();
    const expiresAt =
      input.expiresAt ??
      (this.retention.defaultTtlMs != null
        ? new Date(now.getTime() + this.retention.defaultTtlMs).toISOString()
        : null);
    return this.withTransaction(input.scope, async (client) => {
      const columns = [
        'id',
        'tenant_id',
        'project_id',
        'mission_id',
        'agent_id',
        'kind',
        'duration',
        'title',
        'content',
        'tags',
        'priority',
        'confidence',
        'evidence_refs',
        'meta',
        'created_at',
        'last_accessed_at',
        'expires_at',
      ];
      const values: unknown[] = [
        id,
        input.scope.tenantId,
        input.scope.projectId,
        input.missionId ?? null,
        agentId ?? null,
        input.kind,
        input.duration ?? 'EPISODIC',
        input.title,
        input.content,
        JSON.stringify([...new Set(input.tags ?? [])]),
        input.priority ?? 50,
        input.confidence ?? 0.8,
        input.evidenceRefs ? JSON.stringify(input.evidenceRefs) : null,
        input.meta ? JSON.stringify(input.meta) : null,
        createdAt,
        input.lastAccessedAt ?? createdAt,
        expiresAt,
      ];
      if (this.vectorEnabled) {
        columns.push('embedding');
        values.push(input.embedding ? vectorLiteral(input.embedding) : null);
      }

      const placeholders = values.map((_, index) => `$${index + 1}`).join(', ');
      const updateColumns = columns
        .filter((column) => !['id', 'tenant_id', 'project_id', 'created_at'].includes(column))
        .map((column) => `${column} = EXCLUDED.${column}`)
        .join(', ');
      const result = await client.query<MemoryRow>(
        `INSERT INTO memory_items (${columns.join(', ')}) VALUES (${placeholders})
         ON CONFLICT (tenant_id, project_id, id) DO UPDATE SET ${updateColumns}
         RETURNING *`,
        values,
      );
      const record = result.rows[0]
        ? this.rowToRecord(result.rows[0], input, now)
        : this.inputToRecord(input, id, createdAt, expiresAt);
      await this.deleteExpiredInTransaction(client, input.scope, now);
      await this.enforceMaximumInTransaction(client, input.scope);
      await this.audit(client, input.scope, 'store', id, agentId, true, record.tags);
      return cloneRecord(record);
    });
  }

  async retrieve(input: RetrieveMemoryInput): Promise<MemoryRecord | null> {
    assertMemoryScope(input.scope);
    await this.initialize();
    return this.withTransaction(input.scope, async (client) => {
      const result = await client.query<MemoryRow>(
        `UPDATE memory_items
         SET last_accessed_at = NOW()
         WHERE tenant_id = $1 AND project_id = $2 AND id = $3
           AND (expires_at IS NULL OR expires_at > NOW())
         RETURNING *`,
        [input.scope.tenantId, input.scope.projectId, input.id],
      );
      const record = result.rows[0] ? this.rowToRecord(result.rows[0], input, this.now()) : null;
      await this.audit(client, input.scope, 'retrieve', input.id, undefined, true, record?.tags);
      return record ? cloneRecord(record) : null;
    });
  }

  async search(input: SearchMemoryInput): Promise<MemorySearchResult> {
    assertMemoryScope(input.scope);
    await this.initialize();
    const limit = assertLimit(input.limit, BASE_LIMIT, MAX_LIMIT);
    if (input.mode === 'semantic' && !this.vectorEnabled && !input.query) {
      throw this.vectorError ?? new Error('vector search is not available');
    }
    return this.withTransaction(input.scope, async (client) => {
      const filters = this.buildFilters(input.scope, input);
      const values = [...filters.values];
      let orderBy = 'priority DESC, created_at DESC, id ASC';
      if (input.mode === 'semantic' && this.vectorEnabled) {
        if (!input.embedding) throw new Error('semantic search requires embedding');
        this.assertEmbeddingDimension(input.embedding);
        values.push(vectorLiteral(input.embedding));
        orderBy = `embedding <=> $${values.length}::vector ASC, ${orderBy}`;
      }
      const count = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM memory_items WHERE ${filters.where}`,
        filters.values,
      );
      values.push(limit);
      const result = await client.query<MemoryRow>(
        `SELECT * FROM memory_items WHERE ${filters.where} ORDER BY ${orderBy} LIMIT $${values.length}`,
        values,
      );
      const items = result.rows.map((row) => this.rowToRecord(row, input, this.now()));
      await this.audit(
        client,
        input.scope,
        'search',
        undefined,
        input.scope.agentId,
        true,
        input.tags,
      );
      return { items: items.map(cloneRecord), total: Number(count.rows[0]?.count ?? 0) };
    });
  }

  async forget(input: ForgetMemoryInput): Promise<boolean> {
    assertForgetTarget(input);
    await this.initialize();
    return this.withTransaction(input.scope, async (client) => {
      const values: unknown[] = [input.scope.tenantId, input.scope.projectId];
      const clauses = ['tenant_id = $1', 'project_id = $2'];
      if (input.id) {
        values.push(input.id);
        clauses.push(`id = $${values.length}`);
      } else {
        values.push(input.missionId);
        clauses.push(`mission_id = $${values.length}`);
      }
      // Snapshot tags before delete so namespace-scoped audit queries see forget events.
      const prior = await client.query<{ tags: unknown }>(
        `SELECT tags FROM memory_items WHERE ${clauses.join(' AND ')}`,
        values,
      );
      const tagsSnapshot = prior.rows.flatMap((row) => {
        if (Array.isArray(row.tags)) return row.tags.map(String);
        if (typeof row.tags === 'string') {
          try {
            const parsed = JSON.parse(row.tags) as unknown;
            return Array.isArray(parsed) ? parsed.map(String) : [];
          } catch {
            return [];
          }
        }
        return [];
      });
      const result = await client.query(
        `DELETE FROM memory_items WHERE ${clauses.join(' AND ')}`,
        values,
      );
      await this.audit(
        client,
        input.scope,
        'forget',
        input.id,
        input.scope.agentId,
        true,
        tagsSnapshot.length > 0 ? [...new Set(tagsSnapshot)] : undefined,
      );
      return result.rowCount > 0;
    });
  }

  async list(input: ListMemoryInput): Promise<MemoryPage> {
    assertMemoryScope(input.scope);
    await this.initialize();
    const limit = assertLimit(input.limit, BASE_LIMIT, MAX_LIMIT);
    const offset = this.parseCursor(input.cursor);
    return this.withTransaction(input.scope, async (client) => {
      const filters = this.buildFilters(input.scope, input);
      const count = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM memory_items WHERE ${filters.where}`,
        filters.values,
      );
      const values = [...filters.values, limit, offset];
      const result = await client.query<MemoryRow>(
        `SELECT * FROM memory_items WHERE ${filters.where}
         ORDER BY priority DESC, created_at DESC, id ASC
         LIMIT $${values.length - 1} OFFSET $${values.length}`,
        values,
      );
      const items = result.rows.map((row) => this.rowToRecord(row, input, this.now()));
      await this.audit(client, input.scope, 'list', undefined, input.scope.agentId, true);
      const total = Number(count.rows[0]?.count ?? 0);
      return {
        items: items.map(cloneRecord),
        total,
        nextCursor: offset + limit < total ? String(offset + limit) : undefined,
      };
    });
  }

  async purgeExpired(scope: MemoryScope): Promise<number> {
    assertMemoryScope(scope);
    await this.initialize();
    return this.withTransaction(scope, async (client) => {
      const deleted = await this.deleteExpiredInTransaction(client, scope, this.now());
      await this.audit(client, scope, 'retention', undefined, undefined, true);
      return deleted;
    });
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }

  private async bootstrap(): Promise<void> {
    if (!this.manageSchema) return;
    for (const statement of memorySchemaStatements()) await this.pool.query(statement);
    if (this.embeddingDimension === undefined) return;
    try {
      for (const statement of vectorSchemaStatements(this.embeddingDimension)) {
        await this.pool.query(statement);
      }
      this.vectorEnabled = true;
    } catch (error) {
      this.vectorEnabled = false;
      this.vectorError = error instanceof Error ? error : new Error(String(error));
    }
  }

  private async withTransaction<T>(
    scope: MemoryScope,
    fn: (client: PostgresClient) => Promise<T>,
  ): Promise<T> {
    assertMemoryScope(scope);
    const active = this.clientStore.getStore();
    if (active) return fn(active);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_scope', $1, true)", [scope.tenantId]);
      const result = await this.clientStore.run(client, () => fn(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        reportSilentFailure(rollbackError, 'postgresMemoryService:rollback');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private buildFilters(
    scope: MemoryScope,
    input: SearchMemoryInput | ListMemoryInput,
  ): { where: string; values: unknown[] } {
    const values: unknown[] = [scope.tenantId, scope.projectId];
    const clauses = [
      'tenant_id = $1',
      'project_id = $2',
      '(expires_at IS NULL OR expires_at > NOW())',
    ];
    if (input.kind) {
      values.push(input.kind);
      clauses.push(`kind = $${values.length}`);
    }
    if (input.missionId) {
      values.push(input.missionId);
      clauses.push(`mission_id = $${values.length}`);
    }
    if (input.agentId) {
      values.push(input.agentId);
      clauses.push(`agent_id = $${values.length}`);
    }
    if (input.tags?.length) {
      values.push(JSON.stringify(input.tags));
      clauses.push(`tags @> $${values.length}::jsonb`);
    }
    if ('minPriority' in input && input.minPriority !== undefined) {
      values.push(input.minPriority);
      clauses.push(`priority >= $${values.length}`);
    }
    if ('minConfidence' in input && input.minConfidence !== undefined) {
      values.push(input.minConfidence);
      clauses.push(`confidence >= $${values.length}`);
    }
    if ('query' in input && input.query) {
      values.push(input.query);
      clauses.push(
        `to_tsvector('simple', title || ' ' || content || ' ' || tags::text) @@ plainto_tsquery('simple', $${values.length})`,
      );
    }
    return { where: clauses.join(' AND '), values };
  }

  private async deleteExpiredInTransaction(
    client: PostgresClient,
    scope: MemoryScope,
    now: Date,
  ): Promise<number> {
    const result = await client.query(
      `DELETE FROM memory_items
       WHERE tenant_id = $1 AND project_id = $2
         AND expires_at IS NOT NULL AND expires_at <= $3`,
      [scope.tenantId, scope.projectId, now.toISOString()],
    );
    return result.rowCount;
  }

  private async enforceMaximumInTransaction(
    client: PostgresClient,
    scope: MemoryScope,
  ): Promise<void> {
    const maximum = this.retention.maxEntriesPerTenantProject;
    if (maximum == null) return;
    if (!Number.isInteger(maximum) || maximum < 1) {
      throw new Error('maxEntriesPerTenantProject must be a positive integer');
    }
    await client.query(
      `WITH victims AS (
         SELECT id FROM memory_items
         WHERE tenant_id = $1 AND project_id = $2
           AND (expires_at IS NULL OR expires_at > NOW())
         ORDER BY priority ASC, created_at ASC, id ASC
         OFFSET $3
       )
       DELETE FROM memory_items AS memory
       USING victims
       WHERE memory.tenant_id = $1 AND memory.project_id = $2 AND memory.id = victims.id`,
      [scope.tenantId, scope.projectId, maximum],
    );
  }

  private async audit(
    client: PostgresClient,
    scope: MemoryScope,
    action: string,
    memoryId: string | undefined,
    actorId: string | undefined,
    success: boolean,
    tags?: string[],
  ): Promise<void> {
    await client.query(
      `INSERT INTO memory_audit_events
       (id, tenant_id, project_id, memory_id, action, actor_id, success, created_at, tags)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8::jsonb)`,
      [
        randomUUID(),
        scope.tenantId,
        scope.projectId,
        memoryId ?? null,
        action,
        actorId ?? null,
        success,
        JSON.stringify(tags ?? []),
      ],
    );
  }

  async queryAudit(input: QueryMemoryAuditInput): Promise<MemoryAuditPage> {
    assertMemoryScope(input.scope);
    const limit = assertLimit(input.limit, 50, 500);
    await this.initialize();
    return this.withTransaction(input.scope, async (client) => {
      const nsTag = input.namespace ? `namespace:${input.namespace}` : null;
      const result = await client.query(
        `SELECT id, tenant_id, project_id, memory_id, action, actor_id, success, created_at, tags
         FROM memory_audit_events
         WHERE tenant_id = $1 AND project_id = $2
           AND ($3::text IS NULL OR tags @> jsonb_build_array($3::text))
         ORDER BY created_at DESC
         LIMIT $4`,
        [input.scope.tenantId, input.scope.projectId, nsTag, limit],
      );
      const entries = result.rows.map((row) => ({
        id: String(row.id),
        tenantId: String(row.tenant_id),
        projectId: String(row.project_id),
        memoryId: row.memory_id == null ? undefined : String(row.memory_id),
        action: String(row.action),
        actorId: row.actor_id == null ? undefined : String(row.actor_id),
        success: Boolean(row.success),
        createdAt:
          row.created_at instanceof Date
            ? row.created_at.toISOString()
            : String(row.created_at ?? ''),
        // Use jsonArray (safe parse) — malformed legacy tags must not 400 the audit API.
        tags: row.tags == null ? undefined : jsonArray(row.tags),
      }));
      return { entries, count: entries.length };
    });
  }

  private rowToRecord(
    row: MemoryRow,
    input: { scope: MemoryScope; agentId?: string },
    now: Date,
  ): MemoryRecord {
    return {
      id: String(row.id),
      tenantId: String(row.tenant_id ?? input.scope.tenantId),
      projectId: String(row.project_id ?? input.scope.projectId),
      missionId: row.mission_id == null ? undefined : String(row.mission_id),
      agentId: row.agent_id == null ? input.agentId : String(row.agent_id),
      kind: String(row.kind) as MemoryRecord['kind'],
      duration: String(row.duration) as MemoryRecord['duration'],
      title: String(row.title ?? ''),
      content: String(row.content ?? ''),
      tags: jsonArray(row.tags),
      priority: Number(row.priority ?? 50),
      confidence: Number(row.confidence ?? 0.8),
      createdAt: isoDate(row.created_at, now.toISOString()),
      lastAccessedAt: isoDate(row.last_accessed_at, now.toISOString()),
      expiresAt: row.expires_at == null ? undefined : isoDate(row.expires_at, now.toISOString()),
      evidenceRefs: jsonArray(row.evidence_refs),
      meta: (jsonValue(row.meta) as Record<string, unknown> | null) ?? undefined,
      embedding: Array.isArray(row.embedding) ? row.embedding.map(Number) : undefined,
    };
  }

  private inputToRecord(
    input: StoreMemoryInput,
    id: string,
    createdAt: string,
    expiresAt: string | null,
  ): MemoryRecord {
    return {
      id,
      tenantId: input.scope.tenantId,
      projectId: input.scope.projectId,
      missionId: input.missionId,
      agentId: input.agentId ?? input.scope.agentId,
      kind: input.kind,
      duration: input.duration ?? 'EPISODIC',
      title: input.title,
      content: input.content,
      tags: [...new Set(input.tags ?? [])],
      priority: input.priority ?? 50,
      confidence: input.confidence ?? 0.8,
      createdAt,
      lastAccessedAt: input.lastAccessedAt ?? createdAt,
      expiresAt: expiresAt ?? undefined,
      evidenceRefs: input.evidenceRefs ? [...input.evidenceRefs] : undefined,
      meta: input.meta ? { ...input.meta } : undefined,
      embedding: input.embedding ? [...input.embedding] : undefined,
    };
  }

  private assertEmbeddingDimension(embedding: number[]): void {
    if (this.embeddingDimension !== undefined && embedding.length !== this.embeddingDimension) {
      throw new Error(`embedding must contain exactly ${this.embeddingDimension} values`);
    }
  }

  private parseCursor(cursor: string | undefined): number {
    if (cursor === undefined) return 0;
    const offset = Number.parseInt(cursor, 10);
    if (!Number.isInteger(offset) || offset < 0)
      throw new Error('cursor must be a non-negative integer');
    return offset;
  }
}
