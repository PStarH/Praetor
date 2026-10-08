import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SqlClient, SqlPool, SqlQueryResult } from '@praetor/kernel';
import { PostgresUserRepository } from '../src/userStore.js';

class RecordingClient implements SqlClient {
  readonly calls: Array<{ sql: string; values: readonly unknown[] | undefined }> = [];

  /** Optional scripted outcome per statement, keyed by a SQL substring. */
  script: Array<{ match: RegExp; rows?: unknown[]; rowCount?: number }> = [];

  async query<T = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<SqlQueryResult<T>> {
    this.calls.push({ sql, values });
    const entry = this.script.find((candidate) => candidate.match.test(sql));
    return {
      rows: (entry?.rows ?? []) as T[],
      rowCount: entry?.rowCount ?? entry?.rows?.length ?? 0,
    };
  }

  async release(): Promise<void> {}

  indexOf(pattern: RegExp): number {
    return this.calls.findIndex((call) => pattern.test(call.sql));
  }
}

function repository(client: RecordingClient): PostgresUserRepository {
  return new PostgresUserRepository({ connect: async () => client } satisfies SqlPool);
}

const MEMBERSHIP_LOCK = /pg_advisory_xact_lock\(hashtext\('commander_auth_users\.membership'\)\)/;

test('password reset atomically advances the access-token authority version', async () => {
  const client = new RecordingClient();
  client.script = [
    {
      match: /UPDATE commander_auth_users/,
      rows: [
        {
          id: 'user-1',
          username: 'u',
          email: 'u@example.test',
          password_hash: 'hash',
          role: 'viewer',
          oidc_issuer: null,
          oidc_subject: null,
          auth_version: 2,
          created_at: new Date(),
          last_login_at: null,
        },
      ],
      rowCount: 1,
    },
  ];

  await repository(client).resetUserPassword('user-1', 'replacement-password');

  // AUDIT F-B-26: pin the atomic version bump, not just a substring — a single
  // UPDATE ... RETURNING (no read-modify-write) is the property that makes the
  // version bump race-free.
  const bump = client.calls.find((call) => /UPDATE commander_auth_users/.test(call.sql));
  assert.ok(bump, 'the reset must issue the version-bump UPDATE');
  assert.match(
    bump!.sql,
    /UPDATE commander_auth_users\s+SET password_hash = \$2, auth_version = auth_version \+ 1\s+WHERE id = \$1 RETURNING/,
  );
  assert.equal(bump!.values?.[0], 'user-1');
  assert.notEqual(bump!.values?.[1], 'replacement-password');
  assert.match(String(bump!.values?.[1]), /^\$2[aby]\$/, 'a bcrypt hash must be bound');
  assert.equal(
    client.calls.some((call) => /SELECT/i.test(call.sql) && !MEMBERSHIP_LOCK.test(call.sql)),
    false,
    'the bump must not be a read-modify-write',
  );

  // AUTH-03: the version bump and the refresh-token revocation share one
  // transaction, so a concurrent rotation cannot insert a new jti between them.
  assert.equal(client.calls[0]!.sql, 'BEGIN');
  assert.equal(client.calls.at(-1)!.sql, 'COMMIT');
  const revoke = client.calls.find((call) => /UPDATE commander_auth_refresh_tokens/.test(call.sql));
  assert.ok(revoke, 'the reset must revoke outstanding refresh tokens in the same transaction');
  assert.equal(revoke!.values?.[0], 'user-1');
});

test('role mutation atomically advances the access-token authority version', async () => {
  const client = new RecordingClient();
  client.script = [
    {
      match: /UPDATE commander_auth_users/,
      rows: [
        {
          id: 'user-1',
          username: 'u',
          email: 'u@example.test',
          password_hash: 'hash',
          role: 'viewer',
          oidc_issuer: null,
          oidc_subject: null,
          auth_version: 2,
          created_at: new Date(),
          last_login_at: null,
        },
      ],
      rowCount: 1,
    },
  ];

  const outcome = await repository(client).updateUserRole('user-1', 'viewer');

  assert.equal(outcome.outcome, 'updated');
  // AUTH-04: one membership lock precedes the read-modify-write, so concurrent
  // demotions/deletions cannot each observe "more than one admin".
  const lock = client.indexOf(MEMBERSHIP_LOCK);
  const update = client.indexOf(/UPDATE commander_auth_users/);
  assert.ok(lock >= 0, 'the membership advisory lock must be taken');
  assert.ok(update > lock, 'the lock must precede the guarded UPDATE');
  assert.equal(client.calls[0]!.sql, 'BEGIN');
  assert.equal(client.calls.at(-1)!.sql, 'COMMIT');
  assert.match(
    client.calls[update]!.sql,
    /SET role = \$2, auth_version = auth_version \+ 1/,
    'the version bump must stay atomic',
  );
  assert.deepEqual(client.calls[update]!.values, ['user-1', 'viewer']);
});

test('AUTH-04: the last-admin guard covers super_admin as well as admin', async () => {
  const client = new RecordingClient();
  await repository(client).updateUserRole('user-1', 'viewer');

  const update = client.calls.find((call) => /UPDATE commander_auth_users/.test(call.sql));
  assert.ok(update);
  // Both admin roles must appear in the guard's protected set; the old endpoint
  // check only matched the literal 'admin', so a sole super_admin was demotable.
  assert.match(update!.sql, /NOT IN \('admin', 'super_admin'\)/);
  assert.match(update!.sql, /role IN \('admin', 'super_admin'\)/);
});

test('AUTH-04: delete takes the membership lock before counting admins', async () => {
  const client = new RecordingClient();
  client.script = [
    {
      match: /FROM commander_auth_users WHERE id = \$1 FOR UPDATE/,
      rows: [
        {
          id: 'user-1',
          username: 'u',
          email: 'u@example.test',
          password_hash: 'hash',
          role: 'viewer',
          oidc_issuer: null,
          oidc_subject: null,
          auth_version: 1,
          created_at: new Date(),
          last_login_at: null,
        },
      ],
      rowCount: 1,
    },
  ];

  const result = await repository(client).deleteUser('user-1');

  assert.deepEqual(result, { success: true });
  const lock = client.indexOf(MEMBERSHIP_LOCK);
  const count = client.indexOf(/SELECT COUNT\(\*\)::text AS count FROM commander_auth_users/);
  assert.ok(lock >= 0, 'delete must take the membership advisory lock');
  assert.ok(count > lock, 'the admin count must be read under the lock');
  assert.equal(client.calls[0]!.sql, 'BEGIN');
  assert.equal(client.calls.at(-1)!.sql, 'COMMIT');
});
