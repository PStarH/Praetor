import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SqlClient, SqlPool, SqlQueryResult } from '@praetor/kernel';
import { PostgresApiKeyStore } from '../src/apiKeyStore.js';

class RecordingClient implements SqlClient {
  readonly calls: Array<{ sql: string; values: readonly unknown[] | undefined }> = [];

  async query<T = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<SqlQueryResult<T>> {
    this.calls.push({ sql, values });
    return { rows: [], rowCount: 0 };
  }

  async release(): Promise<void> {}
}

test('pre-auth API-key lookup uses the explicit global RLS scope', async () => {
  const client = new RecordingClient();
  const store = new PostgresApiKeyStore({ connect: async () => client } satisfies SqlPool);

  await store.findByHash('sha256');

  // F-A-24: assert the whole transaction, not just the preamble — a lookup that
  // ran the SELECT under a different scope, or skipped COMMIT, must fail here.
  assert.equal(client.calls.length, 4);
  assert.deepEqual(client.calls[0], { sql: 'BEGIN', values: undefined });
  assert.deepEqual(client.calls[1], {
    sql: "SELECT set_config('app.tenant_scope', $1, true)",
    values: [''],
  });
  assert.match(client.calls[2]!.sql, /SELECT .* FROM commander_auth_api_keys WHERE key_hash = \$1/);
  assert.deepEqual(client.calls[2]!.values, ['sha256']);
  assert.deepEqual(client.calls[3], { sql: 'COMMIT', values: undefined });
});

test('tenant-bound API-key creation uses that tenant RLS scope', async () => {
  const client = new RecordingClient();
  const store = new PostgresApiKeyStore({ connect: async () => client } satisfies SqlPool);

  await assert.rejects(() => store.create('tenant key', ['read'], 'tenant-a'));

  assert.deepEqual(client.calls.slice(0, 2), [
    { sql: 'BEGIN', values: undefined },
    {
      sql: "SELECT set_config('app.tenant_scope', $1, true)",
      values: ['tenant-a'],
    },
  ]);
  // F-A-24: assert the full transaction — the INSERT must carry the tenant id
  // as its $6 tenant_id parameter, and the unit of work must COMMIT.
  assert.match(client.calls[2]!.sql, /^INSERT INTO commander_auth_api_keys/);
  assert.equal(client.calls[2]!.values![5], 'tenant-a');
  assert.deepEqual(client.calls[3], { sql: 'COMMIT', values: undefined });
  assert.equal(client.calls.length, 4);
});

test('tenant-scoped API-key revocation constrains the mutation to that tenant', async () => {
  const client = new RecordingClient();
  const store = new PostgresApiKeyStore({ connect: async () => client } satisfies SqlPool);

  await store.revoke('api-key-id', 'tenant-a');

  assert.deepEqual(client.calls[2], {
    sql:
      'UPDATE commander_auth_api_keys SET enabled = false, revoked_at = COALESCE(revoked_at, clock_timestamp())\n' +
      '         WHERE id = $1 AND tenant_id = $2 AND enabled = true\n' +
      '         RETURNING id, name, prefix, key_hash, scopes, tenant_id, enabled, created_at, revoked_at',
    values: ['api-key-id', 'tenant-a'],
  });
});
