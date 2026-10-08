/**
 * PostgreSQL-authoritative refresh-token jti store.
 *
 * Consumption is a single atomic `UPDATE ... RETURNING` so a jti can be
 * consumed by exactly one replica/request — concurrent refreshes of the same
 * token cannot both succeed (single-use rotation).
 */
import type { SqlPool } from '@praetor/kernel';
import { createVerifiedPostgresPool } from '@praetor/postgres-runtime';
import { createAuthPool, withClient, withTransaction, type VerifiedPoolFactory } from './authDb';

export interface RefreshTokenRecord {
  jti: string;
  userId: string;
  /** Unix expiry (seconds), matching JWT `exp`. */
  exp: number;
}

export interface RefreshTokenRepository {
  insert(record: RefreshTokenRecord): Promise<void>;
  /** Atomic single-use consumption; true only for the first successful consumer. */
  consume(jti: string): Promise<boolean>;
  /**
   * AUTH-03: single-use rotation fenced by the user's `auth_version`. Locks the
   * user row, validates the version, consumes `currentJti` and registers
   * `nextJti` in one transaction. `rejected` means no token may be issued.
   */
  rotate(input: RotateRefreshTokenInput): Promise<RotateRefreshTokenResult>;
  revoke(jti: string): Promise<void>;
  isActive(jti: string): Promise<boolean>;
  revokeAllForUser(userId: string): Promise<void>;
}

export interface RotateRefreshTokenInput {
  userId: string;
  currentJti: string;
  nextJti: string;
  /** Unix expiry (seconds) of the new refresh token. */
  nextExp: number;
  /** The `auth_version` carried by the presented refresh token. */
  expectedAuthVersion: number;
}

export type RotateRefreshTokenResult =
  | { status: 'rotated' }
  | { status: 'rejected'; reason: 'user_missing' | 'auth_version_mismatch' | 'jti_consumed' };

export class PostgresRefreshTokenRepository implements RefreshTokenRepository {
  constructor(private readonly pool: SqlPool) {}

  async insert(record: RefreshTokenRecord): Promise<void> {
    await withClient(this.pool, async (client) => {
      await client.query(
        'INSERT INTO commander_auth_refresh_tokens (jti, user_id, expires_at, revoked_at) VALUES ($1, $2, to_timestamp($3), $4)',
        [record.jti, record.userId, record.exp, null],
      );
    });
  }

  async consume(jti: string): Promise<boolean> {
    return withClient(this.pool, async (client) => {
      const result = await client.query<{ jti: string }>(
        `UPDATE commander_auth_refresh_tokens SET revoked_at = clock_timestamp()
         WHERE jti = $1 AND revoked_at IS NULL AND expires_at > clock_timestamp()
         RETURNING jti`,
        [jti],
      );
      return (result.rowCount ?? 0) === 1;
    });
  }

  /**
   * AUTH-03: rotate in one transaction, fenced by the user's auth_version.
   *
   * Lock order is always user row → refresh-token rows, matching
   * `resetUserPassword` and `deleteUser`, so a concurrent reset either commits
   * first (we then reject on the stale version) or waits for us and revokes the
   * jti we registered — it can never leave a valid new refresh behind.
   */
  async rotate(input: RotateRefreshTokenInput): Promise<RotateRefreshTokenResult> {
    return withTransaction(this.pool, async (client) => {
      const user = await client.query<{ auth_version: string | number }>(
        'SELECT auth_version FROM commander_auth_users WHERE id = $1 FOR UPDATE',
        [input.userId],
      );
      if (!user.rows[0]) return { status: 'rejected', reason: 'user_missing' } as const;
      if (Number(user.rows[0].auth_version) !== input.expectedAuthVersion) {
        return { status: 'rejected', reason: 'auth_version_mismatch' } as const;
      }
      const consumed = await client.query<{ jti: string }>(
        `UPDATE commander_auth_refresh_tokens SET revoked_at = clock_timestamp()
         WHERE jti = $1 AND user_id = $2 AND revoked_at IS NULL AND expires_at > clock_timestamp()
         RETURNING jti`,
        [input.currentJti, input.userId],
      );
      if ((consumed.rowCount ?? 0) !== 1) {
        return { status: 'rejected', reason: 'jti_consumed' } as const;
      }
      await client.query(
        'INSERT INTO commander_auth_refresh_tokens (jti, user_id, expires_at, revoked_at) VALUES ($1, $2, to_timestamp($3), $4)',
        [input.nextJti, input.userId, input.nextExp, null],
      );
      return { status: 'rotated' } as const;
    });
  }

  async revoke(jti: string): Promise<void> {
    await withClient(this.pool, async (client) => {
      await client.query(
        'UPDATE commander_auth_refresh_tokens SET revoked_at = COALESCE(revoked_at, clock_timestamp()) WHERE jti = $1',
        [jti],
      );
    });
  }

  async isActive(jti: string): Promise<boolean> {
    return withClient(this.pool, async (client) => {
      const result = await client.query<{ jti: string }>(
        `SELECT jti FROM commander_auth_refresh_tokens
         WHERE jti = $1 AND revoked_at IS NULL AND expires_at > clock_timestamp()`,
        [jti],
      );
      return (result.rowCount ?? 0) === 1;
    });
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await withClient(this.pool, async (client) => {
      await client.query(
        'UPDATE commander_auth_refresh_tokens SET revoked_at = COALESCE(revoked_at, clock_timestamp()) WHERE user_id = $1',
        [userId],
      );
    });
  }
}

let defaultRepository: RefreshTokenRepository | undefined;

export function createRefreshTokenRepository(
  env: NodeJS.ProcessEnv = process.env,
  createPool: VerifiedPoolFactory = createVerifiedPostgresPool,
): RefreshTokenRepository {
  return new PostgresRefreshTokenRepository(createAuthPool(env, createPool));
}

export function getRefreshTokenRepository(): RefreshTokenRepository {
  defaultRepository ??= createRefreshTokenRepository();
  return defaultRepository;
}

export function setRefreshTokenRepository(repository: RefreshTokenRepository): void {
  defaultRepository = repository;
}

export function _resetRefreshTokenStoreForTests(): void {
  defaultRepository = undefined;
}

// ── Async facade preserving the historical function surface ─────────────────

/** Persist a newly issued refresh jti. */
export async function persist(jti: string, userId: string, exp: number): Promise<void> {
  await getRefreshTokenRepository().insert({ jti, userId, exp });
}

/**
 * Atomically check that jti is active and revoke it.
 * Returns true only for the first successful consumer.
 */
export async function consume(jti: string): Promise<boolean> {
  return getRefreshTokenRepository().consume(jti);
}

/**
 * AUTH-03: version-fenced single-use rotation (see
 * `RefreshTokenRepository.rotate`). Returns a rejection instead of throwing so
 * the caller fails closed without leaking whether the user, the version or the
 * jti was the reason.
 */
export async function rotate(input: RotateRefreshTokenInput): Promise<RotateRefreshTokenResult> {
  return getRefreshTokenRepository().rotate(input);
}

/** Mark a jti as revoked (logout / explicit revoke). */
export async function revoke(jti: string): Promise<void> {
  await getRefreshTokenRepository().revoke(jti);
}

/** True when jti exists, is not revoked, and has not expired. */
export async function isActive(jti: string): Promise<boolean> {
  return getRefreshTokenRepository().isActive(jti);
}

/** Revoke every active refresh token for a user (e.g. password reset). */
export async function revokeAllForUser(userId: string): Promise<void> {
  await getRefreshTokenRepository().revokeAllForUser(userId);
}
