/**
 * Real-credential fixture for the live-server integration suite.
 *
 * Why this exists
 * ---------------
 * `apps/api/tests/*.test.ts` used to send no credentials at all. Once the
 * auth middleware became default-deny (apps/api/src/authMiddleware.ts:272-287)
 * and `/projects` gained its own principal requirement
 * (apps/api/src/projectEndpoints.ts:37-42), most of the suite turned into 401s.
 *
 * The routes in this suite need more than "some credential": `GET /projects`
 * and every `/projects/:id/...` route bind a project to a principal
 * (`canAccessProject`, apps/api/src/projectEndpoints.ts:74-87), which requires
 * `req.user` with an admin-or-higher role. An API key alone can never satisfy
 * that — only the JWT path populates `req.user`. So the fixture provisions the
 * real documented principal: a `super_admin` user row in PostgreSQL and a
 * signed access token minted from the server's own `JWT_SECRET`.
 *
 * The credential is real: the token is verified against the same authority the
 * product uses (`authenticateAccessToken` re-reads the user row and compares
 * `auth_version` + `role`), every write goes through the same tenant-scoped
 * client (and therefore the same row-level-security policies) the product
 * uses, and every route still enforces its own authorization. Nothing here
 * weakens the routes.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { hashSecret } from '@praetor/core/runtime';
import { createVerifiedPostgresPool } from '@praetor/postgres-runtime';
import type { SqlClient, SqlPool } from '@praetor/kernel';
import { withTenantScopedClient } from '../../src/authDb.js';
import { signAccessToken } from '../../src/jwtMiddleware.js';
import { requireLiveServer } from './requireLiveServer.mjs';

export const TEST_PRINCIPAL_NAME = 'integration-suite-super-admin';
const TEST_PRINCIPAL_EMAIL = 'integration-suite@commander.local';

export interface LiveServerCredential {
  /** `Authorization: Bearer <token>` — populates req.user (role + tenant). */
  bearerToken: string;
  /** `X-API-Key: <key>` — populates req.apiKeyId. */
  apiKey: string;
  /** Every header a request should carry to be authenticated. */
  headers: Record<string, string>;
  principal: { id: string; username: string; role: 'super_admin'; authVersion: number };
}

export const TEST_TENANT_ID = process.env.COMMANDER_DEFAULT_TENANT_ID ?? 'local';

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set: the live-server integration suite authenticates against the ' +
        'PostgreSQL auth authority, which apps/api proves at startup via AUTH_DATABASE_URL_REQUIRED.',
    );
  }
  return url;
}

function authPool(): SqlPool {
  // Same verified-TLS pool factory the API's auth repositories use, so the
  // fixture cannot succeed against a database the server would refuse.
  return createVerifiedPostgresPool({ connectionString: requireDatabaseUrl() }, process.env);
}

/**
 * The API-key table is protected by row-level security keyed on
 * `app.tenant_scope`; the pre-auth rows use the same empty scope the product's
 * `ApiKeyStore` uses for its global path (apps/api/src/apiKeyStore.ts:94-111).
 */
function withAuthClient<T>(
  pool: SqlPool,
  operation: (client: SqlClient) => Promise<T>,
): Promise<T> {
  return withTenantScopedClient(pool, '', operation);
}

/** Delete earlier runs' fixture rows so the fixture is idempotent. */
async function clearPreviousFixture(pool: SqlPool): Promise<void> {
  await withAuthClient(pool, (client) =>
    client.query('DELETE FROM commander_auth_api_keys WHERE name = $1', [TEST_PRINCIPAL_NAME]),
  );
  await withAuthClient(pool, (client) =>
    client.query('DELETE FROM commander_auth_users WHERE username = $1 OR email = $2', [
      TEST_PRINCIPAL_NAME,
      TEST_PRINCIPAL_EMAIL,
    ]),
  );
}

/**
 * Provision the suite's principal and return real credentials for it.
 *
 * `requireLiveServer()` runs first so an unconfigured run still fails fast with
 * the documented `TEST_API_URL` message instead of a database error.
 */
export async function provisionLiveServerCredential(): Promise<LiveServerCredential> {
  requireLiveServer();
  const pool = authPool();
  try {
    await clearPreviousFixture(pool);

    const userId = randomUUID();
    const authVersion = 1;
    const username = TEST_PRINCIPAL_NAME;
    await withAuthClient(pool, (client) =>
      client.query(
        `INSERT INTO commander_auth_users
           (id, username, email, password_hash, role, oidc_issuer, oidc_subject, auth_version)
         VALUES ($1, $2, $3, $4, 'super_admin', NULL, NULL, $5)`,
        [
          userId,
          username,
          TEST_PRINCIPAL_EMAIL,
          `integration-suite-${randomBytes(8).toString('hex')}`,
          authVersion,
        ],
      ),
    );

    const apiKey = `cmdr_${randomBytes(32).toString('base64url')}`;
    await withAuthClient(pool, (client) =>
      client.query(
        `INSERT INTO commander_auth_api_keys (id, user_id, name, prefix, key_hash, scopes, tenant_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          `ak_${randomUUID()}`,
          userId,
          TEST_PRINCIPAL_NAME,
          apiKey.slice(0, 8),
          hashSecret(apiKey),
          ['read', 'write', 'admin'],
          TEST_TENANT_ID,
        ],
      ),
    );

    const principal = { id: userId, username, role: 'super_admin' as const, authVersion };
    const bearerToken = signAccessToken({ ...principal, tenantId: TEST_TENANT_ID });
    return {
      bearerToken,
      apiKey,
      headers: { Authorization: `Bearer ${bearerToken}`, 'X-API-Key': apiKey },
      principal,
    };
  } finally {
    await pool.end();
  }
}

/** Remove the fixture rows once the file has finished. */
export async function revokeLiveServerCredential(): Promise<void> {
  const pool = authPool();
  try {
    await clearPreviousFixture(pool);
  } finally {
    await pool.end();
  }
}

/**
 * Clear the synthesized lockout rows a test file owns.
 *
 * The auth-failure lockout is real and must stay: `authMiddleware` records a
 * failure per client address (apps/api/src/authMiddleware.ts:84-121) and
 * returns 429 while the lockout is live. That makes a shared address
 * order-dependent — the invalid-key case would lock out the cases after it.
 * Test files therefore use documentation-range addresses (RFC 5737 TEST-NET-2)
 * and clear exactly those rows before each case.
 */
export async function clearAuthFailureRowsFor(ips: readonly string[]): Promise<void> {
  const pool = authPool();
  try {
    await withAuthClient(pool, (client) =>
      client.query('DELETE FROM commander_auth_failures WHERE failure_key = ANY($1)', [ips]),
    );
  } finally {
    await pool.end();
  }
}

/**
 * Remove every registered API key, for the one case that asserts the
 * "no keys configured" branch. `authMiddleware` checks the store, not the env
 * (apps/api/src/authMiddleware.ts:272-278), so an environment-only fixture
 * cannot reach that branch — the caller must re-provision afterwards.
 */
export async function clearAllAuthApiKeys(): Promise<void> {
  const pool = authPool();
  try {
    await withAuthClient(pool, (client) => client.query('DELETE FROM commander_auth_api_keys'));
  } finally {
    await pool.end();
  }
}
