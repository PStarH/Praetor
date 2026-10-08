import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SqlClient, SqlPool, SqlQueryResult } from '@praetor/kernel';
import { withTenantScopedClient } from '../src/authDb.js';

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

test('global auth access explicitly sets the empty RLS tenant scope', async () => {
  const client = new RecordingClient();
  const pool: SqlPool = { connect: async () => client };

  await withTenantScopedClient(pool, '', async (scopedClient) => {
    await scopedClient.query('SELECT 1');
  });

  assert.deepEqual(client.calls, [
    { sql: 'BEGIN', values: undefined },
    {
      sql: "SELECT set_config('app.tenant_scope', $1, true)",
      values: [''],
    },
    { sql: 'SELECT 1', values: undefined },
    { sql: 'COMMIT', values: undefined },
  ]);
});
