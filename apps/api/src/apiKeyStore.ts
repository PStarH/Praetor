/**
 * PostgreSQL-authoritative API key store.
 *
 * Keys are generated as `cmdr_` prefixed random tokens. Only the scrypt digest
 * is persisted; the plaintext is returned exactly once at creation time and is
 * never recoverable. Unique `key_hash` constraint makes collision impossible
 * across replicas.
 */
import * as crypto from 'node:crypto';
import { hashSecret } from '@praetor/core/runtime';
import { createVerifiedPostgresPool } from '@praetor/postgres-runtime';
import type { SqlClient, SqlPool } from '@praetor/kernel';
import { createAuthPool, withTenantScopedClient, type VerifiedPoolFactory } from './authDb';

export interface ApiKeyRecord {
  id: string;
  name: string;
  /** First 8 characters of the original key, shown in the UI for identification. */
  prefix: string;
  /** SHA-256 hex hash of the full key. */
  hash: string;
  scopes: string[];
  /** Optional tenant this key belongs to. */
  tenantId?: string;
  enabled: boolean;
  createdAt: string;
  revokedAt?: string;
}

export interface ApiKeyCreationResult {
  record: ApiKeyRecord;
  /** Plaintext key — returned only once. */
  key: string;
}

type ApiKeyRow = {
  id: string;
  name: string;
  prefix: string;
  key_hash: string;
  scopes: string[];
  tenant_id: string | null;
  enabled: boolean;
  created_at: Date | string;
  revoked_at: Date | string | null;
};

const KEY_PREFIX = 'cmdr_';
const KEY_BYTES = 32;
const API_KEY_COLUMNS =
  'id, name, prefix, key_hash, scopes, tenant_id, enabled, created_at, revoked_at';

function generateKey(): string {
  return KEY_PREFIX + crypto.randomBytes(KEY_BYTES).toString('base64url');
}

function generateId(): string {
  return `ak_${crypto.randomUUID()}`;
}

function timestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function fromRow(row: ApiKeyRow): ApiKeyRecord {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    hash: row.key_hash,
    scopes: row.scopes,
    tenantId: row.tenant_id ?? undefined,
    enabled: row.enabled,
    createdAt: timestamp(row.created_at),
    revokedAt: row.revoked_at === null ? undefined : timestamp(row.revoked_at),
  };
}

export interface ApiKeyStore {
  list(): Promise<Omit<ApiKeyRecord, 'hash'>[]>;
  listByTenant(tenantId: string): Promise<Omit<ApiKeyRecord, 'hash'>[]>;
  findByHash(hash: string): Promise<ApiKeyRecord | undefined>;
  create(name: string, scopes?: string[], tenantId?: string): Promise<ApiKeyCreationResult>;
  revoke(id: string, tenantScope?: string): Promise<ApiKeyRecord | undefined>;
  delete(id: string, tenantScope?: string): Promise<boolean>;
}

export class PostgresApiKeyStore implements ApiKeyStore {
  constructor(private readonly pool: SqlPool) {}

  async list(): Promise<Omit<ApiKeyRecord, 'hash'>[]> {
    return withTenantScopedClient(this.pool, '', async (client) => {
      const result = await client.query<ApiKeyRow>(
        `SELECT ${API_KEY_COLUMNS} FROM commander_auth_api_keys ORDER BY created_at DESC`,
      );
      return result.rows.map(fromRow).map(({ hash: _hash, ...record }) => record);
    });
  }

  async findByHash(hash: string): Promise<ApiKeyRecord | undefined> {
    return withTenantScopedClient(this.pool, '', async (client) => {
      const result = await client.query<ApiKeyRow>(
        `SELECT ${API_KEY_COLUMNS} FROM commander_auth_api_keys WHERE key_hash = $1 AND enabled = true`,
        [hash],
      );
      return result.rows[0] ? fromRow(result.rows[0]) : undefined;
    });
  }

  async create(
    name: string,
    scopes: string[] = ['read', 'write'],
    tenantId?: string,
  ): Promise<ApiKeyCreationResult> {
    const key = generateKey();
    const result = await withTenantScopedClient(this.pool, tenantId ?? '', async (client) => {
      return client.query<ApiKeyRow>(
        `INSERT INTO commander_auth_api_keys (id, name, prefix, key_hash, scopes, tenant_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING ${API_KEY_COLUMNS}`,
        [
          generateId(),
          name.trim() || 'API Key',
          key.slice(0, 8),
          hashSecret(key),
          scopes.length > 0 ? scopes : ['read', 'write'],
          tenantId ?? null,
        ],
      );
    });
    return { record: fromRow(result.rows[0]!), key };
  }

  async revoke(id: string, tenantScope?: string): Promise<ApiKeyRecord | undefined> {
    const result = await withTenantScopedClient(this.pool, tenantScope ?? '', async (client) => {
      if (tenantScope === undefined) {
        return client.query<ApiKeyRow>(
          `UPDATE commander_auth_api_keys SET enabled = false, revoked_at = COALESCE(revoked_at, clock_timestamp())
           WHERE id = $1 AND enabled = true
           RETURNING ${API_KEY_COLUMNS}`,
          [id],
        );
      }
      return client.query<ApiKeyRow>(
        `UPDATE commander_auth_api_keys SET enabled = false, revoked_at = COALESCE(revoked_at, clock_timestamp())
         WHERE id = $1 AND tenant_id = $2 AND enabled = true
         RETURNING ${API_KEY_COLUMNS}`,
        [id, tenantScope],
      );
    });
    return result.rows[0] ? fromRow(result.rows[0]) : undefined;
  }

  async delete(id: string, tenantScope?: string): Promise<boolean> {
    const result = await withTenantScopedClient(this.pool, tenantScope ?? '', async (client) => {
      if (tenantScope === undefined) {
        return client.query('DELETE FROM commander_auth_api_keys WHERE id = $1', [id]);
      }
      return client.query('DELETE FROM commander_auth_api_keys WHERE id = $1 AND tenant_id = $2', [
        id,
        tenantScope,
      ]);
    });
    return (result.rowCount ?? 0) > 0;
  }

  /** Tenant-scoped listing used by multi-tenant admin surfaces. */
  async listByTenant(tenantId: string): Promise<Omit<ApiKeyRecord, 'hash'>[]> {
    return withTenantScopedClient(this.pool, tenantId, async (client) => {
      const result = await client.query<ApiKeyRow>(
        `SELECT ${API_KEY_COLUMNS} FROM commander_auth_api_keys WHERE tenant_id = $1 ORDER BY created_at DESC`,
        [tenantId],
      );
      return result.rows.map(fromRow).map(({ hash: _hash, ...record }) => record);
    });
  }
}

let storeSingleton: ApiKeyStore | undefined;

export function createApiKeyStore(
  env: NodeJS.ProcessEnv = process.env,
  createPool: VerifiedPoolFactory = createVerifiedPostgresPool,
): ApiKeyStore {
  return new PostgresApiKeyStore(createAuthPool(env, createPool));
}

export function getApiKeyStore(): ApiKeyStore {
  storeSingleton ??= createApiKeyStore();
  return storeSingleton;
}

export function setApiKeyStore(store: ApiKeyStore): void {
  storeSingleton = store;
}

export function resetApiKeyStore(): void {
  storeSingleton = undefined;
}
