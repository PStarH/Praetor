/**
 * PostgresDriver — pg.Pool-backed PersistentDriver implementation.
 *
 * Constraints:
 *   - pg is an optional peer dependency; the driver is lazily required so the
 *     module compiles and loads even when pg is not installed.
 *   - Table methods are asynchronous because pg is promise-based. The returned
 *     PersistentTable is cast to the synchronous interface; callers that use
 *     PostgresDriver must await table methods.
 *   - Transactions use AsyncLocalStorage so every table operation inside the
 *     transaction body runs on the same PoolClient and can be rolled back.
 *   - Schemas are created lazily on first getTable() and awaited by each method.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { createVerifiedPostgresPool } from '@praetor/postgres-runtime';
import { reportSilentFailure } from '../silentFailureReporter';
import type {
  DriverDescription,
  DriverConfig,
  PersistentDriver,
  PersistentTable,
  QueryOptions,
  TableSchema,
  ColumnSpec,
} from './types';
import { coerceColumn, isCompatibleWithSpec, cloneRow, matchesFilter } from './utils';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

interface PgQueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
}

interface PgClient {
  query<T>(sql: string, values?: unknown[]): Promise<PgQueryResult<T>>;
  release(err?: Error): void;
}

interface PgPool {
  query<T>(sql: string, values?: unknown[]): Promise<PgQueryResult<T>>;
  connect(): Promise<PgClient>;
  end(): Promise<void>;
}

interface PostgresTableState<T extends { id: string }> {
  name: string;
  schema: TableSchema<T>;
  ready: Promise<void>;
  closed: boolean;
}

function qid(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Map a driver column type to its PostgreSQL SQL type.
 *
 * Numbers use DOUBLE PRECISION, not REAL: PostgreSQL REAL is single precision,
 * so a JavaScript number such as 16777217 or an epoch-millisecond timestamp
 * silently rounded on write — breaking equality/CAS predicates even though the
 * insert validator accepted the original finite number.
 */
export function sqlTypeForColumn(type: import('./types').ColumnType): string {
  if (type === 'string') return 'TEXT';
  if (type === 'number') return 'DOUBLE PRECISION';
  return 'BOOLEAN';
}

function normalizeRow(
  row: Record<string, unknown>,
  columns: ReadonlyArray<{ name: string; type: import('./types').ColumnType }>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row };
  for (const col of columns) {
    const v = out[col.name];
    if (v === null || v === undefined) continue;
    out[col.name] = coerceColumn(v, col.type);
  }
  return out;
}

class PostgresTable<T extends { id: string }> {
  constructor(
    private readonly tableName: string,
    private readonly schema: TableSchema<T>,
    private readonly runQuery: <R = Record<string, unknown>>(
      sql: string,
      values?: unknown[],
    ) => Promise<PgQueryResult<R>>,
    private readonly state: PostgresTableState<T>,
  ) {}

  private assertOpen(): void {
    if (this.state.closed) {
      throw new Error(`PostgresTable(${this.tableName}): already closed`);
    }
  }

  private colNames(): string[] {
    return this.schema.columns.map((c) => c.name);
  }

  private bindValue(value: unknown, col: ColumnSpec): unknown {
    if (value === undefined) return null;
    if (col.type === 'boolean' && typeof value === 'boolean') return value;
    return value;
  }

  private validateRow(row: T): void {
    for (const col of this.schema.columns) {
      const v = (row as unknown as Record<string, unknown>)[col.name];
      if (v === undefined) continue;
      if (!isCompatibleWithSpec(v, col)) {
        throw new Error(
          `PostgresTable(${this.tableName}).insert: column ${col.name} value ${String(
            v,
          )} is incompatible with declared type ${col.type}`,
        );
      }
    }
  }

  async insert(row: T): Promise<T> {
    this.assertOpen();
    if (!row.id || typeof row.id !== 'string') {
      throw new Error(`PostgresTable(${this.tableName}).insert: row.id required`);
    }
    this.validateRow(row);
    await this.state.ready;

    const cols = this.colNames();
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    const sql =
      `INSERT INTO ${qid(this.tableName)} ` +
      `(${cols.map((n) => qid(n)).join(', ')}) VALUES (${placeholders})`;
    // Iterate `this.schema.columns` (NOT `cols`) so each entry is a `ColumnSpec`
    // and `bindValue`'s spec-typing is preserved. `cols.map` would yield `c: string`,
    // silently bypassing the spec-typed binding contract. Both lists share the same
    // order since `this.colNames()` is just `this.schema.columns.map(c => c.name)`.
    const values = this.schema.columns.map((c) =>
      this.bindValue((row as unknown as Record<string, unknown>)[c.name], c),
    );

    try {
      await this.runQuery(sql, values);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new Error(
          `PostgresTable(${this.tableName}).insert: row with id ${row.id} already exists`,
        );
      }
      throw err;
    }
    return cloneRow(row);
  }

  async insertOrReplace(row: T): Promise<T> {
    this.assertOpen();
    if (!row.id || typeof row.id !== 'string') {
      throw new Error(`PostgresTable(${this.tableName}).insertOrReplace: row.id required`);
    }
    this.validateRow(row);
    await this.state.ready;

    const cols = this.colNames();
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    const nonIdCols = cols.filter((c) => c !== 'id');
    const setClauses = nonIdCols.map((c) => `${qid(c)} = EXCLUDED.${qid(c)}`).join(', ');
    const conflictSet = setClauses ? ` DO UPDATE SET ${setClauses}` : ' DO NOTHING';
    const sql =
      `INSERT INTO ${qid(this.tableName)} ` +
      `(${cols.map((n) => qid(n)).join(', ')}) VALUES (${placeholders})` +
      ` ON CONFLICT (${qid('id')})${conflictSet}`;
    // See `insert()` above for the ColumnSpec-vs-string binding concern.
    const values = this.schema.columns.map((c) =>
      this.bindValue((row as unknown as Record<string, unknown>)[c.name], c),
    );

    await this.runQuery(sql, values);
    return cloneRow(row);
  }

  async get(id: string): Promise<T | null> {
    this.assertOpen();
    await this.state.ready;
    const res = await this.runQuery<T>(
      `SELECT * FROM ${qid(this.tableName)} WHERE id = $1 LIMIT 1`,
      [id],
    );
    if (!res.rows[0]) return null;
    return cloneRow(
      normalizeRow(
        res.rows[0] as unknown as Record<string, unknown>,
        this.schema.columns,
      ) as unknown as T,
    );
  }

  async update(id: string, patch: Partial<T>): Promise<boolean> {
    this.assertOpen();
    await this.state.ready;

    const setKeys = Object.keys(patch).filter((k) => k !== 'id') as Array<keyof T>;
    if (setKeys.length === 0) {
      const res = await this.runQuery(
        `SELECT 1 FROM ${qid(this.tableName)} WHERE id = $1 LIMIT 1`,
        [id],
      );
      return (res.rowCount ?? 0) > 0;
    }

    const setClauses: string[] = [];
    const values: unknown[] = [];
    for (const k of setKeys) {
      const name = String(k);
      const col = this.schema.columns.find((c) => c.name === name)!;
      values.push(this.bindValue((patch as unknown as Record<string, unknown>)[name], col));
      setClauses.push(`${qid(name)} = $${values.length}`);
    }
    values.push(id);
    const sql =
      `UPDATE ${qid(this.tableName)} SET ${setClauses.join(', ')} ` +
      `WHERE id = $${values.length} RETURNING id`;
    const res = await this.runQuery(sql, values);
    return (res.rowCount ?? 0) > 0;
  }

  async updateIf(id: string, where: Partial<T>, patch: Partial<T>): Promise<T | null> {
    this.assertOpen();
    await this.state.ready;

    const setKeys = Object.keys(patch).filter((k) => k !== 'id') as Array<keyof T>;
    const setClauses: string[] = [];
    const values: unknown[] = [];
    for (const k of setKeys) {
      const name = String(k);
      const col = this.schema.columns.find((c) => c.name === name)!;
      values.push(this.bindValue((patch as unknown as Record<string, unknown>)[name], col));
      setClauses.push(`${qid(name)} = $${values.length}`);
    }

    const whereClauses: string[] = [];
    for (const k of Object.keys(where) as Array<keyof T>) {
      const v = where[k];
      if (v === undefined) continue;
      const name = String(k);
      const col = this.schema.columns.find((c) => c.name === name)!;
      const bound = this.bindValue(v, col);
      if (bound === null) {
        whereClauses.push(`${qid(name)} IS NULL`);
      } else {
        values.push(bound);
        whereClauses.push(`${qid(name)} = $${values.length}`);
      }
    }

    values.push(id);
    const idPlaceholder = `$${values.length}`;
    const predicate = [`id = ${idPlaceholder}`, ...whereClauses].join(' AND ');

    if (setClauses.length === 0) {
      const sql = `SELECT 1 FROM ${qid(this.tableName)} WHERE ${predicate} LIMIT 1`;
      const res = await this.runQuery(sql, values);
      return res.rowCount > 0 ? await this.get(id) : null;
    }

    const sql =
      `UPDATE ${qid(this.tableName)} SET ${setClauses.join(', ')} ` +
      `WHERE ${predicate} RETURNING *`;
    const res = await this.runQuery<T>(sql, values);
    if ((res.rowCount ?? 0) === 0) return null;
    return cloneRow(
      normalizeRow(
        res.rows[0] as unknown as Record<string, unknown>,
        this.schema.columns,
      ) as unknown as T,
    );
  }

  async delete(id: string): Promise<boolean> {
    this.assertOpen();
    await this.state.ready;
    const res = await this.runQuery(`DELETE FROM ${qid(this.tableName)} WHERE id = $1`, [id]);
    return (res.rowCount ?? 0) > 0;
  }

  async query(filter?: Partial<T>, opts?: QueryOptions<T>): Promise<T[]> {
    this.assertOpen();
    await this.state.ready;
    const res = await this.runQuery<T>(`SELECT * FROM ${qid(this.tableName)}`);
    const filterKeys = filter ? (Object.keys(filter) as Array<keyof T>) : [];
    const sortSpecs = opts?.sort ?? [];

    let out: T[] = res.rows.map(
      (r) =>
        normalizeRow(r as unknown as Record<string, unknown>, this.schema.columns) as unknown as T,
    );

    if (filterKeys.length > 0) {
      out = out.filter((r) => {
        const rec = r as unknown as Record<string, unknown>;
        for (const k of filterKeys) {
          const want = (filter as unknown as Record<string, unknown>)[String(k)];
          if (want === undefined) continue;
          if (rec[String(k)] !== want) return false;
        }
        return true;
      });
    }

    if (sortSpecs.length > 0) {
      out = out.slice().sort((a, b) => {
        const ar = a as unknown as Record<string, unknown>;
        const br = b as unknown as Record<string, unknown>;
        for (const s of sortSpecs) {
          const av = ar[String(s.column)];
          const bv = br[String(s.column)];
          const dir = s.direction === 'desc' ? -1 : 1;
          if (av === bv) continue;
          if (av === undefined) return dir;
          if (bv === undefined) return -dir;
          if (av === null) return dir;
          if (bv === null) return -dir;
          if ((av as number | string) < (bv as number | string)) return -1 * dir;
          if ((av as number | string) > (bv as number | string)) return 1 * dir;
        }
        return 0;
      });
    }

    if (opts?.offset && opts.offset > 0) out = out.slice(opts.offset);
    if (opts?.limit !== undefined && opts.limit >= 0) out = out.slice(0, opts.limit);
    return out.map(cloneRow);
  }

  async count(filter?: Partial<T>): Promise<number> {
    this.assertOpen();
    await this.state.ready;
    const res = await this.runQuery<T>(`SELECT * FROM ${qid(this.tableName)}`);
    let n = 0;
    for (const raw of res.rows) {
      const row = normalizeRow(
        raw as unknown as Record<string, unknown>,
        this.schema.columns,
      ) as Record<string, unknown>;
      if (matchesFilter(row, filter)) n++;
    }
    return n;
  }
}

export interface PostgresAvailability {
  available: boolean;
  reason?: string;
}

export function probePostgres(): PostgresAvailability {
  try {
    const pg = nodeRequire('pg');
    if (typeof pg.Pool !== 'function') {
      return { available: false, reason: 'pg module did not export a Pool constructor' };
    }
    return { available: true };
  } catch (err) {
    return {
      available: false,
      reason: `pg require failed: ${String((err as Error)?.message ?? err)}`,
    };
  }
}

export class PostgresDriver implements PersistentDriver {
  readonly backend = 'postgres' as const;
  private readonly pool: PgPool;
  private readonly connectionString: string;
  private readonly namespace?: string;
  private tables = new Map<string, PostgresTableState<{ id: string }>>();
  private closed = false;
  private readonly poolStore = new AsyncLocalStorage<PgClient>();

  constructor(config: DriverConfig) {
    if (!config.path) {
      throw new Error('PostgresDriver: `path` is required in DriverConfig (use connection string)');
    }
    const availability = probePostgres();
    if (!availability.available) {
      throw new Error(`PostgresDriver unavailable: ${availability.reason}`);
    }
    this.connectionString = config.path;
    this.namespace = config.namespace;
    this.pool = createVerifiedPostgresPool({ connectionString: this.connectionString });
  }

  getTable<T extends { id: string }>(name: string, schema: TableSchema<T>): PersistentTable<T> {
    if (this.closed) throw new Error('PostgresDriver: already closed');
    const existing = this.tables.get(name) as PostgresTableState<T> | undefined;
    if (existing) {
      return new PostgresTable<T>(
        name,
        schema,
        this.runQuery.bind(this),
        existing,
      ) as unknown as PersistentTable<T>;
    }
    const state: PostgresTableState<T> = {
      name,
      schema,
      ready: this.ensureTable(name, schema),
      closed: false,
    };
    this.tables.set(name, state as PostgresTableState<{ id: string }>);
    return new PostgresTable<T>(
      name,
      schema,
      this.runQuery.bind(this),
      state,
    ) as unknown as PersistentTable<T>;
  }

  async transaction<T>(fn: () => T | Promise<T>): Promise<T> {
    if (this.closed) throw new Error('PostgresDriver: already closed');
    const activeClient = this.poolStore.getStore();
    if (activeClient) {
      // Nested transaction: run on the existing client (no savepoint logic for now).
      return fn();
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await this.poolStore.run(client, fn);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        reportSilentFailure(rollbackErr, 'postgresDriver:rollback');
      }
      throw err;
    } finally {
      client.release();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const state of this.tables.values()) state.closed = true;
    this.pool.end().catch((err) => reportSilentFailure(err, 'postgresDriver:close'));
  }

  describe(): DriverDescription {
    return {
      backend: this.backend,
      path: this.connectionString,
      namespace: this.namespace,
      tables: Array.from(this.tables.keys()),
      fellBack: false,
    };
  }

  private async runQuery<T = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<PgQueryResult<T>> {
    const client = this.poolStore.getStore();
    if (client) {
      return client.query<T>(sql, values);
    }
    return this.pool.query<T>(sql, values);
  }

  private async ensureTable<T extends { id: string }>(
    name: string,
    schema: TableSchema<T>,
  ): Promise<void> {
    const cols = schema.columns
      .map((c) => {
        const sqlType = sqlTypeForColumn(c.type);
        const pk = c.name === 'id' ? ' PRIMARY KEY' : '';
        return `${qid(c.name)} ${sqlType}${pk}`;
      })
      .join(', ');
    await this.runQuery(`CREATE TABLE IF NOT EXISTS ${qid(name)} (${cols})`);
    for (const c of schema.columns) {
      if (c.index) {
        await this.runQuery(
          `CREATE INDEX IF NOT EXISTS ${qid(`idx_${name}_${c.name}`)} ON ${qid(name)}(${qid(c.name)})`,
        );
      }
    }
  }
}
