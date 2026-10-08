/**
 * PostgreSQL-authoritative authentication-failure / lockout store.
 *
 * Every failure is recorded with a single atomic upsert so concurrent login
 * attempts across API replicas cannot race the lockout decision.
 */
import type { SqlPool } from '@praetor/kernel';
import { createAuthPool, withClient, type VerifiedPoolFactory } from './authDb';

export interface AuthFailureEntry {
  count: number;
  firstFailureAt: number;
  lastFailureAt: number;
  lockedUntil: number;
}

export interface AuthFailureStore {
  get(failureKey: string): Promise<AuthFailureEntry | undefined>;
  /** Atomically increment the failure counter and apply lockout when the threshold is reached. */
  recordFailure(
    failureKey: string,
    now: number,
    maxFailures: number,
    windowMs: number,
    lockoutMs: number,
  ): Promise<AuthFailureEntry>;
  /**
   * Reclaim rows that can no longer affect a decision. AUTH-06: the previous
   * predicate required `locked_until IS NULL`, so a row whose lockout had
   * already expired (`locked_until <= now`) was never reclaimed and the table
   * grew without bound. A still-valid lockout (`locked_until > now`) is kept
   * regardless of how old `last_failure_at` is.
   *
   * Returns the number of reclaimed rows so callers can observe cleanup work.
   */
  cleanup(now: number, windowMs: number): Promise<number>;
}

type FailureRow = {
  count: number;
  firstFailureAt: number;
  lastFailureAt: number;
  lockedUntil: number;
};

const RECORD_FAILURE_SQL = [
  'INSERT INTO commander_auth_failures (failure_key, count, first_failure_at, last_failure_at, locked_until)',
  'VALUES ($1, 1, to_timestamp($2 / 1000.0), to_timestamp($2 / 1000.0),',
  '  CASE WHEN $4 <= 1 THEN to_timestamp(($2 + $5) / 1000.0) ELSE NULL END)',
  'ON CONFLICT (failure_key) DO UPDATE SET',
  'count = CASE WHEN commander_auth_failures.last_failure_at < to_timestamp(($2 - $3) / 1000.0)',
  '         THEN 1 ELSE commander_auth_failures.count + 1 END,',
  'first_failure_at = CASE WHEN commander_auth_failures.last_failure_at < to_timestamp(($2 - $3) / 1000.0)',
  '         THEN to_timestamp($2 / 1000.0) ELSE commander_auth_failures.first_failure_at END,',
  'last_failure_at = to_timestamp($2 / 1000.0),',
  'locked_until = CASE',
  '  WHEN commander_auth_failures.locked_until > to_timestamp($2 / 1000.0) THEN commander_auth_failures.locked_until',
  '  WHEN (CASE WHEN commander_auth_failures.last_failure_at < to_timestamp(($2 - $3) / 1000.0)',
  '         THEN 1 ELSE commander_auth_failures.count + 1 END) >= $4',
  '    THEN to_timestamp(($2 + $5) / 1000.0)',
  '  ELSE NULL END',
  'RETURNING count,',
  '  EXTRACT(EPOCH FROM first_failure_at) * 1000 AS "firstFailureAt",',
  '  EXTRACT(EPOCH FROM last_failure_at) * 1000 AS "lastFailureAt",',
  '  COALESCE(EXTRACT(EPOCH FROM locked_until) * 1000, 0) AS "lockedUntil"',
].join('\n');

function toEntry(row: FailureRow): AuthFailureEntry {
  return {
    count: Number(row.count),
    firstFailureAt: Number(row.firstFailureAt),
    lastFailureAt: Number(row.lastFailureAt),
    lockedUntil: Number(row.lockedUntil),
  };
}

export class PostgresAuthFailureStore implements AuthFailureStore {
  constructor(private readonly pool: SqlPool) {}

  async get(failureKey: string): Promise<AuthFailureEntry | undefined> {
    return withClient(this.pool, async (client) => {
      const result = await client.query<FailureRow>(
        'SELECT count, EXTRACT(EPOCH FROM first_failure_at) * 1000 AS "firstFailureAt", EXTRACT(EPOCH FROM last_failure_at) * 1000 AS "lastFailureAt", COALESCE(EXTRACT(EPOCH FROM locked_until) * 1000, 0) AS "lockedUntil" FROM commander_auth_failures WHERE failure_key = $1',
        [failureKey],
      );
      return result.rows[0] ? toEntry(result.rows[0]) : undefined;
    });
  }

  async recordFailure(
    failureKey: string,
    now: number,
    maxFailures: number,
    windowMs: number,
    lockoutMs: number,
  ): Promise<AuthFailureEntry> {
    return withClient(this.pool, async (client) => {
      const result = await client.query<FailureRow>(RECORD_FAILURE_SQL, [
        failureKey,
        now,
        windowMs,
        maxFailures,
        lockoutMs,
      ]);
      if (!result.rows[0]) throw new Error('AUTH_FAILURE_RECORD_MISSING');
      return toEntry(result.rows[0]);
    });
  }

  async cleanup(now: number, windowMs: number): Promise<number> {
    return withClient(this.pool, async (client) => {
      // The intersection of "the expiry window has passed" and "no lock is
      // still in force". `locked_until > now` rows survive even when their
      // last failure is old, because the lockout still gates requests.
      const result = await client.query(
        `DELETE FROM commander_auth_failures
         WHERE (locked_until IS NULL OR locked_until <= to_timestamp($1 / 1000.0))
           AND last_failure_at < to_timestamp(($1 - $2) / 1000.0)
         RETURNING failure_key`,
        [now, windowMs],
      );
      return result.rowCount ?? 0;
    });
  }
}

export interface CreateAuthFailureStoreOptions {
  environment?: NodeJS.ProcessEnv;
  createPool?: VerifiedPoolFactory;
}

export function createAuthFailureStore(
  options: CreateAuthFailureStoreOptions = {},
): AuthFailureStore {
  const environment = options.environment ?? process.env;
  return new PostgresAuthFailureStore(createAuthPool(environment, options.createPool));
}

let sharedStore: AuthFailureStore | undefined;

export function getAuthFailureStore(): AuthFailureStore {
  sharedStore ??= createAuthFailureStore();
  return sharedStore;
}

/** Construct the PostgreSQL authority during API startup so misconfiguration fails closed. */
export function initAuthFailureStore(): void {
  getAuthFailureStore();
}

export function setAuthFailureStore(store: AuthFailureStore): void {
  sharedStore = store;
}

export function resetAuthFailureStoreForTesting(): void {
  sharedStore = undefined;
}
