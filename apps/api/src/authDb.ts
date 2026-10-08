/**
 * Shared PostgreSQL plumbing for the API-layer auth repositories.
 *
 * All five auth authorities (users, API keys, refresh tokens, auth failures,
 * rate limits) are backed by PostgreSQL via `commander_app`. There is no
 * Redis / JSON-file / SQLite / in-memory fallback: production fails closed
 * when `DATABASE_URL` is missing or does not authenticate as `commander_app`.
 */
import { createVerifiedPostgresPool } from '@praetor/postgres-runtime';
import type { SqlClient, SqlPool } from '@praetor/kernel';

export type VerifiedPoolFactory = (
  input: { connectionString: string },
  env?: NodeJS.ProcessEnv,
) => SqlPool;

/** Database role that every auth repository must authenticate as. */
export const AUTH_DATABASE_ROLE = 'commander_app';

export function resolveAuthDatabaseUrl(env: NodeJS.ProcessEnv): string {
  const connectionString = env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error('AUTH_DATABASE_URL_REQUIRED');
  }
  return connectionString;
}

export function validateAuthDatabaseUrl(connectionString: string): void {
  let role: string;
  try {
    role = decodeURIComponent(new URL(connectionString).username);
  } catch {
    throw new Error('AUTH_DATABASE_URL_INVALID');
  }
  if (role !== AUTH_DATABASE_ROLE) {
    throw new Error('AUTH_DATABASE_ROLE_INVALID');
  }
}

export function createAuthPool(
  env: NodeJS.ProcessEnv,
  createPool: VerifiedPoolFactory = createVerifiedPostgresPool,
): SqlPool {
  const connectionString = resolveAuthDatabaseUrl(env);
  validateAuthDatabaseUrl(connectionString);
  return createPool({ connectionString }, env);
}

export async function withClient<T>(
  pool: SqlPool,
  operation: (client: SqlClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    return await operation(client);
  } finally {
    await client.release();
  }
}

/**
 * AUTH-03: run `operation` inside one transaction. Refresh-token rotation must
 * consume the old jti, validate the user's auth version and insert the new jti
 * atomically, so a concurrent reset cannot land between those steps.
 */
export async function withTransaction<T>(
  pool: SqlPool,
  operation: (client: SqlClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const value = await operation(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve the original failure.
    }
    throw error;
  } finally {
    await client.release();
  }
}

/**
 * AUTH-07: the auth authority is unavailable (missing / invalid DSN, wrong role,
 * refused or dropped connection, server shutdown). Callers must map this to 503
 * and never echo the underlying message — a pg connection error can embed the
 * DSN, including its password.
 */
const AUTH_AUTHORITY_FAILURE_RE =
  /\b(AUTH_DATABASE_[A-Z_]+|COMMANDER_DATABASE_[A-Z0-9_]+|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE|57P0[123]|08[0-9]{3}|53300|3D000|28P01|28000|42501)\b/;

export function isAuthAuthorityUnavailable(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && AUTH_AUTHORITY_FAILURE_RE.test(code)) return true;
  const message = error instanceof Error ? error.message : '';
  return AUTH_AUTHORITY_FAILURE_RE.test(message);
}

/**
 * AUTH-07: redact credentials a database driver may embed in an error message
 * before the detail is written to an internal log. The caller supplies the
 * stable code / request id to the client separately.
 */
export function redactAuthErrorDetail(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/postgres(?:ql)?:\/\/[^\s'"]+/gi, 'postgres://<redacted>')
    .replace(/(password|passwd|pwd)=[^\s&'"]+/gi, '$1=<redacted>')
    .slice(0, 500);
}

/**
 * Run `operation` inside a transaction that sets `app.tenant_scope` so RLS
 * policies on tenant-bearing auth tables apply. The global (pre-auth) path
 * uses an explicit empty scope because the RLS policy treats an unset scope
 * as deny-by-default.
 */
export async function withTenantScopedClient<T>(
  pool: SqlPool,
  tenantScope: string,
  operation: (client: SqlClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_scope', $1, true)", [tenantScope]);
    const value = await operation(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve the original failure.
    }
    throw error;
  } finally {
    await client.release();
  }
}
