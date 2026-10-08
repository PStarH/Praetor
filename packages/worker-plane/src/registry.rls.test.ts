/**
 * PostgresWorkerRegistry RLS / DEFINER-RPC tests.
 *
 * Unit: mock SqlPool asserts register_worker / heartbeat_worker / drain_worker
 * RPCs (no direct INSERT/UPDATE on commander_workers) and that initialize()
 * never runs CREATE TABLE.
 *
 * Live-fire (optional): commander_worker LOGIN register+heartbeat succeeds
 * without DDL when COMMANDER_KERNEL_DATABASE_URL (or DATABASE_URL) is set.
 */

import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { Pool } from 'pg';
import {
  PostgresWorkerRegistry,
  InMemoryWorkerRegistry,
  WORKER_PLANE_SCHEMA_SQL,
  WORKER_OPEN_ENDED_TENANTS_FORBIDDEN,
  WORKER_TENANT_NOT_ALLOWED,
  type SqlClient,
  type SqlPool,
} from './registry.js';

// ── Mock pool ───────────────────────────────────────────────────────────────

type QueryCall = { sql: string; values?: readonly unknown[] };

function createMockPool(handlers?: {
  onQuery?: (
    sql: string,
    values?: readonly unknown[],
  ) => Promise<{ rows: unknown[]; rowCount: number | null }>;
}): { pool: SqlPool; calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  const pool: SqlPool = {
    connect: async () => {
      const client: SqlClient = {
        query: async <T = Record<string, unknown>>(sql: string, values?: readonly unknown[]) => {
          calls.push({ sql, values });
          if (handlers?.onQuery) {
            return (await handlers.onQuery(sql, values)) as { rows: T[]; rowCount: number | null };
          }
          if (/to_regclass/i.test(sql)) {
            return { rows: [{ ok: 'commander_workers' }] as T[], rowCount: 1 };
          }
          if (/set_config/i.test(sql)) {
            return { rows: [{ set_config: values?.[0] }] as T[], rowCount: 1 };
          }
          if (/^BEGIN|^COMMIT|^ROLLBACK/i.test(sql.trim())) {
            return { rows: [] as T[], rowCount: null };
          }
          if (/register_worker\s*\(/i.test(sql)) {
            const now = new Date().toISOString();
            return {
              rows: [
                {
                  register_worker: {
                    id: values?.[0],
                    kind: values?.[1],
                    version: values?.[2],
                    capabilities: JSON.parse(String(values?.[3] ?? '[]')),
                    labels: JSON.parse(String(values?.[4] ?? '{}')),
                    max_concurrency: values?.[5],
                    status: 'ACTIVE',
                    generation: 1,
                    active_steps: 0,
                    identity_subject: values?.[6],
                    tenant_ids: JSON.parse(String(values?.[7] ?? '[]')),
                    registered_at: now,
                    last_heartbeat_at: now,
                    claim_secret: 'test-claim-secret',
                  },
                },
              ] as T[],
              rowCount: 1,
            };
          }
          if (/heartbeat_worker\s*\(/i.test(sql)) {
            const now = new Date().toISOString();
            return {
              rows: [
                {
                  heartbeat_worker: {
                    id: values?.[0],
                    kind: 'agent',
                    version: 'v1',
                    capabilities: ['agent'],
                    labels: {},
                    max_concurrency: 2,
                    status: 'ACTIVE',
                    generation: values?.[1],
                    active_steps: values?.[2],
                    identity_subject: 'sub',
                    tenant_ids: ['tenant-a'],
                    registered_at: now,
                    last_heartbeat_at: now,
                  },
                },
              ] as T[],
              rowCount: 1,
            };
          }
          if (/drain_worker\s*\(/i.test(sql)) {
            return { rows: [{ drain_worker: true }] as T[], rowCount: 1 };
          }
          if (/SELECT \* FROM commander_workers/i.test(sql)) {
            const now = new Date().toISOString();
            return {
              rows: [
                {
                  id: values?.[0],
                  kind: 'agent',
                  version: 'v1',
                  capabilities: ['agent'],
                  labels: {},
                  max_concurrency: 2,
                  status: 'ACTIVE',
                  generation: 1,
                  active_steps: 0,
                  identity_subject: 'sub',
                  tenant_ids: ['tenant-a'],
                  registered_at: now,
                  last_heartbeat_at: now,
                },
              ] as T[],
              rowCount: 1,
            };
          }
          return { rows: [] as T[], rowCount: 0 };
        },
        release: () => undefined,
      };
      return client;
    },
  };
  return { pool, calls };
}

describe('PostgresWorkerRegistry DEFINER RPCs (unit)', () => {
  it('initialize verifies table via to_regclass and never runs CREATE', async () => {
    const { pool, calls } = createMockPool();
    const registry = new PostgresWorkerRegistry(pool);
    await registry.initialize();
    assert.ok(calls.some((c) => /to_regclass/i.test(c.sql)));
    assert.ok(
      !calls.some((c) => /CREATE\s+TABLE/i.test(c.sql) || /CREATE\s+INDEX/i.test(c.sql)),
      'initialize must not execute DDL',
    );
    assert.match(WORKER_PLANE_SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS commander_workers/);
  });

  it('register calls register_worker RPC (no direct INSERT)', async () => {
    const { pool, calls } = createMockPool();
    const registry = new PostgresWorkerRegistry(pool);
    const record = await registry.register(
      {
        id: 'w1',
        kind: 'agent',
        version: 'v1',
        capabilities: ['agent'],
        maxConcurrency: 2,
      },
      'subject:w1',
      ['tenant-a', 'tenant-b'],
    );
    assert.equal(record.claimSecret, 'test-claim-secret');
    assert.ok(calls.some((c) => /register_worker\s*\(/i.test(c.sql)));
    assert.equal(
      calls.filter((c) => /INSERT INTO commander_workers/i.test(c.sql)).length,
      0,
      'register must not INSERT commander_workers directly',
    );
  });

  it("register rejects open-ended '*' before any RPC", async () => {
    const { pool, calls } = createMockPool();
    const registry = new PostgresWorkerRegistry(pool);
    await assert.rejects(
      () =>
        registry.register(
          {
            id: 'w-star',
            kind: 'agent',
            version: 'v1',
            capabilities: ['agent'],
            maxConcurrency: 1,
          },
          'subject:w-star',
          ['*'],
        ),
      (err: unknown) =>
        err instanceof Error && err.message.startsWith(WORKER_OPEN_ENDED_TENANTS_FORBIDDEN),
    );
    assert.equal(
      calls.filter((c) => /register_worker\s*\(/i.test(c.sql)).length,
      0,
      'rejected register must not call register_worker',
    );
  });

  it("InMemory register rejects open-ended '*'", async () => {
    const registry = new InMemoryWorkerRegistry();
    await assert.rejects(
      () =>
        registry.register(
          {
            id: 'w-star',
            kind: 'agent',
            version: 'v1',
            capabilities: ['agent'],
            maxConcurrency: 1,
          },
          'subject:w-star',
          ['*'],
        ),
      (err: unknown) =>
        err instanceof Error && err.message.startsWith(WORKER_OPEN_ENDED_TENANTS_FORBIDDEN),
    );
  });

  it('heartbeat/drain use DEFINER RPCs; get reuses tenant scope via set_config', async () => {
    const { pool, calls } = createMockPool();
    const registry = new PostgresWorkerRegistry(pool);
    await registry.register(
      {
        id: 'w1',
        kind: 'agent',
        version: 'v1',
        capabilities: ['agent'],
        maxConcurrency: 2,
      },
      'subject:w1',
      ['tenant-a'],
    );
    calls.length = 0;
    await registry.heartbeat('w1', 1, 1, 'test-claim-secret');
    await registry.drain('w1', 1, 'test-claim-secret');
    await registry.get('w1');
    assert.ok(calls.some((c) => /heartbeat_worker\s*\(/i.test(c.sql)));
    assert.ok(calls.some((c) => /drain_worker\s*\(/i.test(c.sql)));
    assert.equal(
      calls.filter((c) => /UPDATE commander_workers/i.test(c.sql)).length,
      0,
      'heartbeat/drain must not UPDATE commander_workers directly',
    );
    const scopes = calls
      .filter((c) => /set_config\('app\.tenant_scope'/i.test(c.sql))
      .map((c) => c.values?.[0]);
    assert.deepEqual(scopes, ['tenant-a']);
  });

  it('heartbeat before register fails closed', async () => {
    const { pool } = createMockPool();
    const registry = new PostgresWorkerRegistry(pool);
    await assert.rejects(() => registry.heartbeat('w1', 1, 0, 'x'), /requires tenant scope/i);
  });

  it('register maps WORKER_TENANT_NOT_ALLOWED from RPC', async () => {
    const { pool } = createMockPool({
      onQuery: async (sql) => {
        if (/register_worker\s*\(/i.test(sql)) {
          throw new Error('WORKER_TENANT_NOT_ALLOWED: victim');
        }
        return { rows: [], rowCount: 0 };
      },
    });
    const registry = new PostgresWorkerRegistry(pool);
    await assert.rejects(
      () =>
        registry.register(
          {
            id: 'w-deny',
            kind: 'agent',
            version: 'v1',
            capabilities: ['agent'],
            maxConcurrency: 1,
          },
          'subject:w',
          ['victim'],
        ),
      (err: unknown) => err instanceof Error && err.message.startsWith(WORKER_TENANT_NOT_ALLOWED),
    );
  });
});

// ── Live-fire under commander_worker LOGIN ───────────────────────────────────

const databaseUrl = process.env.COMMANDER_KERNEL_DATABASE_URL ?? process.env.DATABASE_URL;
const workerPassword = process.env.COMMANDER_WORKER_PASSWORD ?? 'commander_worker';

function deriveRoleDatabaseUrl(baseUrl: string, role: string, password: string): string {
  const url = new URL(baseUrl);
  url.username = role;
  url.password = password;
  return url.toString();
}

const workerDatabaseUrl =
  process.env.COMMANDER_WORKER_DATABASE_URL ??
  (databaseUrl
    ? deriveRoleDatabaseUrl(databaseUrl, 'commander_worker', workerPassword)
    : undefined);

describe(
  'PostgresWorkerRegistry commander_worker LOGIN',
  { skip: !databaseUrl || !workerDatabaseUrl },
  () => {
    let ownerPool: Pool;
    let workerPool: Pool;
    const tenantId = `reg-rls-tenant-${Date.now()}`;
    const workerId = `reg-rls-worker-${Date.now()}`;

    before(async () => {
      if (!databaseUrl || !workerDatabaseUrl) return;
      const { runKernelMigrations, seedWorkerAllowedTenants } = await import('@praetor/kernel');
      ownerPool = new Pool({ connectionString: databaseUrl, max: 2 });
      await runKernelMigrations(ownerPool);
      await seedWorkerAllowedTenants(ownerPool, [
        tenantId,
        `${tenantId}-stale`,
        `${tenantId}-overlap`,
      ]);
      const escaped = workerPassword.replace(/'/g, "''");
      await ownerPool.query(`ALTER ROLE commander_worker WITH LOGIN PASSWORD '${escaped}'`);
      workerPool = new Pool({ connectionString: workerDatabaseUrl, max: 2 });
    });

    after(async () => {
      if (!databaseUrl) return;
      try {
        await ownerPool?.query('DELETE FROM commander_workers WHERE id=$1 OR id LIKE $2', [
          workerId,
          `${workerId}%`,
        ]);
        await ownerPool?.query(
          'DELETE FROM commander_worker_allowed_tenants WHERE tenant_id LIKE $1',
          [`reg-rls-tenant-%`],
        );
      } catch {
        /* best-effort cleanup */
      }
      await workerPool?.end();
      await ownerPool?.end();
    });

    it('worker LOGIN cannot INSERT commander_workers directly', async () => {
      const client = await workerPool.connect();
      try {
        await client.query(`SELECT set_config('app.tenant_scope', $1, false)`, [tenantId]);
        await assert.rejects(
          () =>
            client.query(
              `INSERT INTO commander_workers (id,kind,version,capabilities,max_concurrency,status,generation,identity_subject,tenant_ids)
             VALUES ($1,'agent','v1','[]',1,'ACTIVE',1,$1,$2::jsonb)`,
              [`${workerId}-direct`, JSON.stringify([tenantId])],
            ),
          /permission denied/i,
        );
      } finally {
        client.release();
      }
    });

    it('register+heartbeat succeeds via DEFINER RPCs under FORCE RLS', async () => {
      const sqlPool: SqlPool = {
        connect: async () => (await workerPool.connect()) as unknown as SqlClient,
      };
      const registry = new PostgresWorkerRegistry(sqlPool);

      await registry.initialize();
      await assert.rejects(async () => {
        const client = await workerPool.connect();
        try {
          await client.query('CREATE TABLE IF NOT EXISTS __worker_ddl_probe (id int)');
        } finally {
          client.release();
        }
      }, /permission denied|must be owner/i);

      const record = await registry.register(
        {
          id: workerId,
          kind: 'agent',
          version: 'rls-test',
          capabilities: ['agent'],
          maxConcurrency: 1,
        },
        `subject:${workerId}`,
        [tenantId],
      );
      assert.equal(record.id, workerId);
      assert.equal(record.status, 'ACTIVE');
      assert.deepEqual(record.tenantIds, [tenantId]);
      assert.ok(record.claimSecret && record.claimSecret.length > 0);

      const beat = await registry.heartbeat(workerId, record.generation, 0, record.claimSecret!);
      assert.ok(beat, 'heartbeat via DEFINER must succeed');
      assert.equal(beat!.generation, record.generation);

      const drained = await registry.drain(workerId, record.generation, record.claimSecret!);
      assert.equal(drained, true);
    });

    it('register rejects tenant not in allowlist', async () => {
      const sqlPool: SqlPool = {
        connect: async () => (await workerPool.connect()) as unknown as SqlClient,
      };
      const registry = new PostgresWorkerRegistry(sqlPool);
      await assert.rejects(
        () =>
          registry.register(
            {
              id: `${workerId}-victim`,
              kind: 'agent',
              version: 'v1',
              capabilities: ['agent'],
              maxConcurrency: 1,
            },
            'subject:victim',
            ['not-allowed-victim-tenant'],
          ),
        (err: unknown) =>
          err instanceof Error &&
          (err.message.includes(WORKER_TENANT_NOT_ALLOWED) ||
            /WORKER_TENANT_NOT_ALLOWED/i.test(err.message)),
      );
    });

    it('markStale under worker LOGIN fails closed (no UPDATE privilege)', async () => {
      const staleWorkerId = `${workerId}-stale`;
      const staleTenant = `${tenantId}-stale`;
      await ownerPool.query(
        `INSERT INTO commander_workers (id,kind,version,capabilities,labels,max_concurrency,status,generation,active_steps,identity_subject,tenant_ids,registered_at,last_heartbeat_at)
       VALUES ($1,'agent','v1','["agent"]'::jsonb,'{}'::jsonb,1,'ACTIVE',1,0,$2,$3::jsonb,now(),now() - interval '2 hours')
       ON CONFLICT (id) DO UPDATE SET status='ACTIVE', last_heartbeat_at=now() - interval '2 hours', tenant_ids=EXCLUDED.tenant_ids`,
        [staleWorkerId, `subject:${staleWorkerId}`, JSON.stringify([staleTenant])],
      );
      try {
        const sqlPool: SqlPool = {
          connect: async () => (await workerPool.connect()) as unknown as SqlClient,
        };
        const registry = new PostgresWorkerRegistry(sqlPool);
        // Either 0 rows (RLS) or permission denied — both fail-closed.
        try {
          const n = await registry.markStale(new Date());
          assert.equal(n, 0, 'worker LOGIN markStale must not sweep rows');
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          assert.match(msg, /permission denied/i);
        }
        const status = await ownerPool.query<{ status: string }>(
          'SELECT status FROM commander_workers WHERE id=$1',
          [staleWorkerId],
        );
        assert.equal(status.rows[0]?.status, 'ACTIVE');
      } finally {
        await ownerPool.query('DELETE FROM commander_workers WHERE id=$1', [staleWorkerId]);
      }
    });
  },
);
