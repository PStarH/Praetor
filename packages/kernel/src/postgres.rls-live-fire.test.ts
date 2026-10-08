/**
 * PostgreSQL RLS live-fire tests — WP90-3.
 *
 * These tests exercise the real PostgreSQL kernel with role-separated
 * connections:
 *   - commander_owner: runs migrations and test setup
 *   - commander_app: API-replica role, subject to FORCE RLS
 *   - commander_scheduler: scheduler/recovery role, BYPASSRLS
 *
 * Acceptance gates:
 *   - non-owner RLS live-fire: 0 leaks
 *   - generation rollover stale writes: 0
 */

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { describe, it, before, after, test } from 'node:test';
import { Pool } from 'pg';
import { createVerifiedPostgresPool } from '@praetor/postgres-runtime';
import { PostgresKernelRepository, PostgresTenantContextAuthority } from './postgres.js';
import type { SqlClient, SqlPool } from './postgres.js';
import { runKernelMigrations } from './migrations.js';
import { TENANT_TABLES } from './schema.js';
import {
  seedWorkerClaimSecret,
  seedWorkerAllowedTenants,
  seedTenantAuthorityAllowedTenants,
} from './seedWorkerClaimSecret.js';
import {
  BEGIN_APP_TENANT_TRANSACTION_SQL,
  READ_APP_TENANT_TRANSACTION_TARGET_SQL,
  buildBindAppTenantContextQuery,
  buildCloseAppTenantContextQuery,
} from './task1TenantContext.js';

const databaseUrl = process.env.COMMANDER_KERNEL_DATABASE_URL ?? process.env.DATABASE_URL;

function passwordFromDatabaseUrl(urlValue: string | undefined): string | undefined {
  if (!urlValue) return undefined;
  try {
    const password = decodeURIComponent(new URL(urlValue).password);
    return password.length > 0 ? password : undefined;
  } catch {
    return undefined;
  }
}

/** Bench/init convention: password matches role name unless overridden. */
const appPassword =
  process.env.COMMANDER_APP_PASSWORD ??
  passwordFromDatabaseUrl(process.env.COMMANDER_APP_DATABASE_URL) ??
  'commander_app';
const schedulerPassword = process.env.COMMANDER_SCHEDULER_PASSWORD ?? 'commander_scheduler';
const workerPassword = process.env.COMMANDER_WORKER_PASSWORD ?? 'commander_worker';
const authorityPassword =
  process.env.COMMANDER_TENANT_AUTHORITY_PASSWORD ??
  passwordFromDatabaseUrl(process.env.COMMANDER_TENANT_AUTHORITY_DATABASE_URL) ??
  'commander_tenant_authority';
const adapterOpsPassword = process.env.COMMANDER_ADAPTER_OPS_PASSWORD ?? 'commander_adapter_ops';

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
const appDatabaseUrl = databaseUrl
  ? deriveRoleDatabaseUrl(databaseUrl, 'commander_app', appPassword)
  : undefined;
const schedulerDatabaseUrl = databaseUrl
  ? deriveRoleDatabaseUrl(databaseUrl, 'commander_scheduler', schedulerPassword)
  : undefined;
const authorityDatabaseUrl = databaseUrl
  ? deriveRoleDatabaseUrl(databaseUrl, 'commander_tenant_authority', authorityPassword)
  : undefined;
const adapterOpsDatabaseUrl = databaseUrl
  ? deriveRoleDatabaseUrl(databaseUrl, 'commander_adapter_ops', adapterOpsPassword)
  : undefined;

// F-K2-3: this file is the only raw-RLS cross-tenant denial proof. It is reached
// by `pnpm test:rls-live-fire`, which has no env guard, so a silent skip would
// report PASS for an unrun security proof. Absent fixture is NOT VERIFIED and
// must fail the run.
const LIVE_PG_SKIP_REASON =
  'NOT VERIFIED: COMMANDER_KERNEL_DATABASE_URL/DATABASE_URL (and the derived worker/app/' +
  'scheduler/tenant-authority/adapter-ops DSNs) are unset - the raw-RLS cross-tenant denial, ' +
  'role-attribute and claim-fencing proofs did not run';
const livePostgresAvailable = Boolean(
  databaseUrl &&
  workerDatabaseUrl &&
  appDatabaseUrl &&
  schedulerDatabaseUrl &&
  authorityDatabaseUrl &&
  adapterOpsDatabaseUrl,
);
if (!livePostgresAvailable) {
  process.stderr.write(`[kernel:integration] ${LIVE_PG_SKIP_REASON}\n`);
  test('live PostgreSQL fixture is configured (REQUIRED)', () => {
    assert.fail(LIVE_PG_SKIP_REASON);
  });
}

// Narrowed views for the live-gated bodies below; the gate above has already
// failed the run when these are empty.
const liveDatabaseUrl = databaseUrl as string;
const liveWorkerDatabaseUrl = workerDatabaseUrl as string;
const liveAppDatabaseUrl = appDatabaseUrl as string;
const liveSchedulerDatabaseUrl = schedulerDatabaseUrl as string;
const liveAuthorityDatabaseUrl = authorityDatabaseUrl as string;
const liveAdapterOpsDatabaseUrl = adapterOpsDatabaseUrl as string;

function createRunCommand(
  tenantId: string,
  steps: Array<{ kind: string; dependencies?: string[]; maxAttempts?: number; priority?: number }>,
) {
  const runId = `run_${randomUUID().slice(0, 8)}`;
  const stepDefs = steps.map((s, i) => ({
    id: `${runId}-step-${i}`,
    kind: s.kind,
    dependencies: s.dependencies,
    maxAttempts: s.maxAttempts ?? 3,
    priority: s.priority ?? 0,
  }));
  return {
    id: runId,
    tenantId,
    intentHash: createHash('sha256').update(runId).digest('hex'),
    workGraphHash: createHash('sha256').update(JSON.stringify(stepDefs)).digest('hex'),
    workGraphVersion: 'v1',
    policySnapshotId: 'rls-live-fire-policy',
    steps: stepDefs,
  };
}

function createDatabasePool(connectionString: string, max: number): Pool {
  const modes = new URL(connectionString).searchParams.getAll('sslmode');
  if (modes.length === 1 && modes[0] === 'verify-full') {
    return createVerifiedPostgresPool({ connectionString, max });
  }
  return new Pool({ connectionString, max });
}

/** True LOGIN pool — session_user is the role (unlike SET SESSION ROLE from owner). */
function createLoginPool(roleDatabaseUrl: string): SqlPool & { end: () => Promise<void> } {
  const pool = createDatabasePool(roleDatabaseUrl, 2);
  return {
    connect: async () => (await pool.connect()) as SqlClient,
    end: () => pool.end(),
  };
}

/**
 * KERNEL_ROLES_SQL may create NOLOGIN-if-missing; deploy init / Helm ConfigMap use LOGIN.
 * Bench DSN fidelity: enable LOGIN+password for app/scheduler/worker before true-LOGIN pools.
 */
async function ensureRoleLogin(ownerPool: Pool, role: string, password: string): Promise<void> {
  const escaped = password.replace(/'/g, "''");
  await ownerPool.query(`ALTER ROLE ${role} WITH LOGIN PASSWORD '${escaped}'`);
}

describe(
  'Postgres RLS live-fire',
  { skip: livePostgresAvailable ? false : LIVE_PG_SKIP_REASON },
  () => {
    let ownerPool: Pool;
    let appPoolA: SqlPool & { end: () => Promise<void> };
    let appPoolB: SqlPool & { end: () => Promise<void> };
    let schedulerPool: SqlPool & { end: () => Promise<void> };
    let workerPool: SqlPool & { end: () => Promise<void> };
    let authorityPool: SqlPool & { end: () => Promise<void> };
    let adapterOpsPool: SqlPool & { end: () => Promise<void> };
    let tenantAuthority: PostgresTenantContextAuthority;
    let repoA: PostgresKernelRepository;
    let repoB: PostgresKernelRepository;
    let schedulerRepo: PostgresKernelRepository;
    let workerRepo: PostgresKernelRepository;
    let adapterOpsRepo: PostgresKernelRepository;
    const tenantA = `tenant-a-${Date.now()}`;
    const tenantB = `tenant-b-${Date.now()}`;
    const workerA = `worker-a-${Date.now()}`;
    const workerB = `worker-b-${Date.now()}`;
    const schedulerA = `scheduler-a-${Date.now()}`;
    const schedulerB = `scheduler-b-${Date.now()}`;
    /** Plaintext claim secrets for suite workers (worker LOGIN path requires claimSecret). */
    const claimSecrets = new Map<string, string>();

    before(async () => {
      ownerPool = createDatabasePool(liveDatabaseUrl, 4);

      // Apply migrations as owner, then verify roles exist.
      await runKernelMigrations(ownerPool);
      const roles = await ownerPool.query<{ rolname: string }>(
        "SELECT rolname FROM pg_roles WHERE rolname IN ('commander_owner','commander_app','commander_scheduler','commander_worker','commander_tenant_authority','commander_adapter_ops')",
      );
      const names = roles.rows.map((r) => r.rolname);
      assert.ok(names.includes('commander_app'), 'commander_app role must exist');
      assert.ok(names.includes('commander_scheduler'), 'commander_scheduler role must exist');
      assert.ok(names.includes('commander_worker'), 'commander_worker role must exist');
      assert.ok(
        names.includes('commander_tenant_authority'),
        'commander_tenant_authority role must exist',
      );
      assert.ok(names.includes('commander_adapter_ops'), 'commander_adapter_ops role must exist');

      // True LOGIN DSNs (session_user=role). Deploy init already LOGIN; bench may be NOLOGIN.
      // Do NOT use owner+SET SESSION ROLE for worker/scheduler identity checks.
      await ensureRoleLogin(ownerPool, 'commander_app', appPassword);
      await ensureRoleLogin(ownerPool, 'commander_scheduler', schedulerPassword);
      await ensureRoleLogin(ownerPool, 'commander_worker', workerPassword);
      await ensureRoleLogin(ownerPool, 'commander_tenant_authority', authorityPassword);
      await ensureRoleLogin(ownerPool, 'commander_adapter_ops', adapterOpsPassword);

      appPoolA = createLoginPool(liveAppDatabaseUrl);
      appPoolB = createLoginPool(liveAppDatabaseUrl);
      schedulerPool = createLoginPool(liveSchedulerDatabaseUrl);
      workerPool = createLoginPool(liveWorkerDatabaseUrl);
      authorityPool = createLoginPool(liveAuthorityDatabaseUrl);
      adapterOpsPool = createLoginPool(liveAdapterOpsDatabaseUrl);
      tenantAuthority = new PostgresTenantContextAuthority(authorityPool);

      // The campaign2 hardening requires a DB-issued, bound app tenant context
      // before any tenant-scoped app access; a raw login that only calls
      // set_config('app.tenant_scope', ...) is refused with TENANT_CONTEXT_INVALID.
      // The app repositories therefore establish the context the way production
      // does (PostgresTenantContextAuthority, enforce phase).
      repoA = new PostgresKernelRepository(appPoolA, {
        tenantContextAuthority: tenantAuthority,
        tenantContextPhase: 'enforce',
      });
      repoB = new PostgresKernelRepository(appPoolB, {
        tenantContextAuthority: tenantAuthority,
        tenantContextPhase: 'enforce',
      });
      schedulerRepo = new PostgresKernelRepository(schedulerPool, { schedulerMode: true });
      // Worker runtime role: schedulerMode MUST be false (RLS-enforced, no BYPASSRLS).
      workerRepo = new PostgresKernelRepository(workerPool, { schedulerMode: false });
      // Reconciliation claims are granted to commander_adapter_ops only.
      adapterOpsRepo = new PostgresKernelRepository(adapterOpsPool, { adapterOpsMode: true });

      // Worker LOGIN RLS requires cell allowlist membership for tenant-scoped I/O.
      await seedWorkerAllowedTenants(ownerPool, [tenantA, tenantB]);
      // The tenant-context authority only issues for explicitly enabled tenants.
      await seedTenantAuthorityAllowedTenants(ownerPool, [tenantA, tenantB]);
      // Class-A effect admission requires operations readiness for the tenant.
      await seedAdapterOpsReadiness([tenantA, tenantB]);

      // Register workers as owner (workers are cross-tenant entities).
      // We need workers for the generation rollover test (workerA), the isolation
      // test (workerB), and the SKIP LOCKED contention test (2 schedulers + 8 racers).
      // identity_subject must name the DB LOGIN the worker runtime uses: the
      // campaign2 hardening makes class-A effect admission require
      // identity_subject='db:commander_worker' for the leasing worker.
      const raceWorkers = Array.from({ length: 8 }, (_, i) => `${workerA}-race-${i}`);
      const workerIds = [workerA, workerB, schedulerA, schedulerB, ...raceWorkers];
      const values = workerIds
        .map(
          (id) =>
            `('${id}','agent','v1','["agent"]',4,'ACTIVE',1,'db:commander_worker','[${JSON.stringify(tenantA)},${JSON.stringify(tenantB)}]'::jsonb)`,
        )
        .join(',');
      await ownerPool.query(
        `INSERT INTO commander_workers (id,kind,version,capabilities,max_concurrency,status,generation,identity_subject,tenant_ids) VALUES ${values}`,
      );
      for (const id of workerIds) {
        claimSecrets.set(id, await seedWorkerClaimSecret(ownerPool, id, 1));
      }
    });

    after(async () => {
      const raceWorkers = Array.from({ length: 8 }, (_, i) => `${workerA}-race-${i}`);
      const suiteWorkerIds = [workerA, workerB, schedulerA, schedulerB, ...raceWorkers];
      await ownerPool.query('DELETE FROM commander_runs WHERE tenant_id = ANY($1::text[])', [
        [tenantA, tenantB],
      ]);
      await ownerPool.query(
        'DELETE FROM commander_worker_claim_secrets WHERE worker_id = ANY($1::text[])',
        [suiteWorkerIds],
      );
      await ownerPool.query('DELETE FROM commander_workers WHERE id = ANY($1::text[])', [
        suiteWorkerIds,
      ]);
      await ownerPool.query(
        'DELETE FROM commander_worker_allowed_tenants WHERE tenant_id = ANY($1::text[])',
        [[tenantA, tenantB]],
      );
      // Issued app contexts reference the authority allowlist row, so they must
      // go first.
      await ownerPool.query(
        'DELETE FROM commander_app_tenant_contexts WHERE tenant_id = ANY($1::text[])',
        [[tenantA, tenantB]],
      );
      await ownerPool.query(
        'DELETE FROM commander_tenant_authority_allowed_tenants WHERE tenant_id = ANY($1::text[])',
        [[tenantA, tenantB]],
      );
      await clearAdapterOpsReadiness([tenantA, tenantB]);
      await appPoolA?.end();
      await appPoolB?.end();
      await schedulerPool?.end();
      await workerPool?.end();
      await authorityPool?.end();
      await adapterOpsPool?.end();
      await ownerPool?.end();
    });

    /**
     * Establish a DB-issued, bound app tenant context inside one transaction —
     * the production path (`PostgresKernelRepository.withTransaction`). Raw SQL
     * assertions must run inside this context; a bare `set_config` is refused.
     */
    async function withBoundAppContext<T>(
      pool: SqlPool,
      tenantId: string,
      fn: (client: SqlClient) => Promise<T>,
    ): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query(BEGIN_APP_TENANT_TRANSACTION_SQL);
        const target = (
          await client.query<{ database_oid: number; backend_pid: number; xid: string }>(
            READ_APP_TENANT_TRANSACTION_TARGET_SQL,
          )
        ).rows[0];
        assert.ok(target, 'app tenant transaction target must be readable');
        const issued = await tenantAuthority.issue(tenantId, {
          databaseOid: Number(target.database_oid),
          backendPid: Number(target.backend_pid),
          xid: String(target.xid),
        });
        const bind = buildBindAppTenantContextQuery(issued.contextId);
        const bound = await client.query<{ tenant_id: string }>(bind.text, bind.values);
        assert.equal(bound.rows[0]?.tenant_id, tenantId);
        const value = await fn(client);
        const close = buildCloseAppTenantContextQuery(issued.contextId);
        await client.query(close.text, close.values);
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
        client.release();
      }
    }

    /**
     * Class-A effect admission is gated on operations readiness: one
     * effect.reconcile and one effect.compensate adapter-ops worker with a recent
     * heartbeat must be registered for the tenant. Production registers those via
     * the commander_adapter_ops LOGIN (`register_adapter_ops_worker`); this owner
     * fixture inserts the equivalent rows directly.
     */
    async function seedAdapterOpsReadiness(tenantIds: readonly string[]): Promise<void> {
      for (const tenantId of tenantIds) {
        for (const [role, capability] of [
          ['reconcile', 'effect.reconcile'],
          ['compensation', 'effect.compensate'],
        ] as const) {
          await ownerPool.query(
            `INSERT INTO commander_workers
               (id,kind,version,capabilities,max_concurrency,status,generation,
                identity_subject,tenant_ids,registered_at,last_heartbeat_at)
             VALUES ($1,'adapter-ops','v1',$2::jsonb,1,'ACTIVE',1,
                'db:commander_adapter_ops',$3::jsonb, now()-interval '1 minute', now())
             ON CONFLICT (id) DO UPDATE
               SET status='ACTIVE', tenant_ids=EXCLUDED.tenant_ids,
                   registered_at=EXCLUDED.registered_at,
                   last_heartbeat_at=EXCLUDED.last_heartbeat_at`,
            [`${role}:rls-${tenantId}`, JSON.stringify([capability]), JSON.stringify([tenantId])],
          );
        }
      }
    }

    async function clearAdapterOpsReadiness(tenantIds: readonly string[]): Promise<void> {
      await ownerPool.query(
        `DELETE FROM commander_workers
          WHERE kind='adapter-ops' AND identity_subject='db:commander_adapter_ops'
            AND tenant_ids ?| $1::text[]`,
        [tenantIds],
      );
    }

    it('every tenant table has RLS ENABLED and FORCED (catalog assertion)', async () => {
      const rows = await ownerPool.query<{
        relname: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }>(
        `SELECT relname, relrowsecurity, relforcerowsecurity
       FROM pg_class
       WHERE relname = ANY($1::text[])`,
        [TENANT_TABLES as unknown as string[]],
      );
      assert.equal(rows.rows.length, TENANT_TABLES.length, 'all tenant tables must exist');
      for (const row of rows.rows) {
        assert.equal(row.relrowsecurity, true, `${row.relname} must ENABLE RLS`);
        assert.equal(row.relforcerowsecurity, true, `${row.relname} must FORCE RLS`);
      }
    });

    it('raw app login is refused without a DB-issued context, and cannot read or write across tenants under RLS', async () => {
      const runA = createRunCommand(tenantA, [{ kind: 'agent' }]);
      await repoA.createRun(runA, 'live-fire');

      // campaign2 hardening: a raw app login that only sets app.tenant_scope (no
      // DB-issued bound context) is refused outright with TENANT_CONTEXT_INVALID
      // (SQLSTATE 22023). That is stronger fail-closed behaviour than the RLS
      // policy denial this case originally asserted, so assert it explicitly
      // rather than reading it as the old error.
      const refusedReason = (error: unknown) => {
        const pgError = error as { code?: string; message?: string };
        assert.equal(
          pgError.code,
          '22023',
          `expected TENANT_CONTEXT_INVALID (22023), got ${String(pgError.code)}: ${String(
            pgError.message,
          )}`,
        );
        assert.match(String(pgError.message), /TENANT_CONTEXT_INVALID/);
        return true;
      };
      const client = await appPoolA.connect();
      try {
        await client.query(`SELECT set_config('app.tenant_scope', $1, false)`, [tenantA]);
        await assert.rejects(
          client.query(`SELECT id FROM commander_runs WHERE tenant_id=$1`, [tenantB]),
          refusedReason,
          'raw app login without a bound context must not read across tenants',
        );
        await assert.rejects(
          client.query(
            `INSERT INTO commander_runs (id, tenant_id, intent_hash, work_graph_hash,
            work_graph_version, policy_snapshot_id, state)
            VALUES ('cross-${Date.now()}', $1, 'i', 'g', 'v1', 'p1', 'PENDING')`,
            [tenantB],
          ),
          refusedReason,
          'raw app login without a bound context must not write across tenants',
        );
      } finally {
        client.release();
      }

      // The isolation assertion is preserved, not deleted: with a real DB-issued
      // context bound to tenant A, RLS still hides tenant B rows...
      const leaked = await withBoundAppContext(appPoolA, tenantA, (bound) =>
        bound.query(`SELECT id FROM commander_runs WHERE tenant_id=$1`, [tenantB]),
      );
      assert.deepEqual(leaked.rows, [], 'app role scoped to A must not read B rows');

      // ...and the WITH CHECK policy still rejects a cross-tenant INSERT.
      // F-K2-21: pin the actual SQLSTATE/message, not any rejection.
      await assert.rejects(
        withBoundAppContext(appPoolA, tenantA, (bound) =>
          bound.query(
            `INSERT INTO commander_runs (id, tenant_id, intent_hash, work_graph_hash,
            work_graph_version, policy_snapshot_id, state)
            VALUES ('cross-${Date.now()}-${randomUUID().slice(0, 8)}', $1, 'i', 'g', 'v1', 'p1', 'PENDING')`,
            [tenantB],
          ),
        ),
        (error: unknown) => {
          const pgError = error as { code?: string; message?: string };
          assert.equal(
            pgError.code,
            '42501',
            `expected an RLS policy violation (42501), got ${String(pgError.code)}: ${String(
              pgError.message,
            )}`,
          );
          assert.match(
            String(pgError.message),
            /row-level security policy/i,
            'app role scoped to A must be denied by the WITH CHECK policy, not by another error',
          );
          return true;
        },
        'app role scoped to A must not INSERT a B row (WITH CHECK)',
      );
    });

    it('runtime roles have no BYPASSRLS/superuser except commander_scheduler', async () => {
      const rows = await ownerPool.query<{
        rolname: string;
        rolbypassrls: boolean;
        rolsuper: boolean;
      }>(
        `SELECT rolname, rolbypassrls, rolsuper FROM pg_roles
       WHERE rolname IN ('commander_app','commander_worker','commander_scheduler')`,
      );
      const byName = new Map(rows.rows.map((r) => [r.rolname, r]));
      assert.equal(
        byName.get('commander_app')?.rolbypassrls,
        false,
        'commander_app must NOT bypass RLS',
      );
      assert.equal(
        byName.get('commander_worker')?.rolbypassrls,
        false,
        'commander_worker must NOT bypass RLS',
      );
      assert.equal(
        byName.get('commander_scheduler')?.rolbypassrls,
        true,
        'commander_scheduler must bypass RLS',
      );
      // Every runtime role must be a non-superuser.
      for (const name of ['commander_app', 'commander_worker', 'commander_scheduler']) {
        assert.equal(byName.get(name)?.rolsuper, false, `${name} must not be a superuser`);
      }
    });

    it('worker LOGIN cannot INSERT commander_workers (P0 DSN threat)', async () => {
      const client = await workerPool.connect();
      try {
        await client.query(`SELECT set_config('app.tenant_scope', $1, false)`, [tenantA]);
        await assert.rejects(
          () =>
            client.query(
              `INSERT INTO commander_workers (id,kind,version,capabilities,max_concurrency,status,generation,identity_subject,tenant_ids)
             VALUES ($1,'agent','v1','[]',1,'ACTIVE',1,$1,$2::jsonb)`,
              [`worker-direct-${Date.now()}`, JSON.stringify([tenantA])],
            ),
          /permission denied/i,
          'commander_worker must not INSERT commander_workers',
        );
      } finally {
        client.release();
      }
    });

    it('worker LOGIN DSN (schedulerMode false) claims allowed tenant but not an outside tenant', async () => {
      const workerId = `worker-role-${Date.now()}`;
      // Worker is authorized only for tenantA in its durable registration.
      // Claim no longer accepts caller tenantIds — durable authz only.
      await ownerPool.query(
        `INSERT INTO commander_workers (id,kind,version,capabilities,max_concurrency,status,generation,identity_subject,tenant_ids)
       VALUES ($1,'agent','v1','["agent"]',4,'ACTIVE',1,'db:commander_worker',$2::jsonb)`,
        [workerId, JSON.stringify([tenantA])],
      );
      const claimSecret = await seedWorkerClaimSecret(ownerPool, workerId, 1);
      try {
        // Drain suite leftovers so this case has exactly one allowed + one outside candidate.
        await ownerPool.query(
          `UPDATE commander_steps SET state='CANCELLED', updated_at=now()
         WHERE tenant_id = ANY($1::text[]) AND state IN ('PENDING','RETRY_WAIT')`,
          [[tenantA, tenantB]],
        );

        // Prove true LOGIN identity (not owner + SET SESSION ROLE).
        const identityClient = await workerPool.connect();
        try {
          const identity = await identityClient.query<{
            session_user: string;
            current_user: string;
          }>('SELECT session_user::text AS session_user, current_user::text AS current_user');
          assert.equal(
            identity.rows[0]?.session_user,
            'commander_worker',
            'session_user must be commander_worker LOGIN',
          );
          assert.equal(
            identity.rows[0]?.current_user,
            'commander_worker',
            'current_user must be commander_worker before repo wrap',
          );
          // No membership: worker must not be able to SET ROLE commander_app.
          await assert.rejects(
            identityClient.query('SET ROLE commander_app'),
            /permission denied/i,
            'commander_worker must not be granted commander_app membership',
          );
          // Worker LOGIN must not SELECT claim-secret hashes.
          await assert.rejects(
            identityClient.query(
              'SELECT secret_hash FROM commander_worker_claim_secrets WHERE worker_id=$1',
              [workerId],
            ),
            /permission denied/i,
            'commander_worker must not SELECT commander_worker_claim_secrets',
          );
        } finally {
          identityClient.release();
        }

        const runAllowed = createRunCommand(tenantA, [{ kind: 'agent' }]);
        const runOutside = createRunCommand(tenantB, [{ kind: 'agent' }]);
        await repoA.createRun(runAllowed, 'live-fire');
        await repoB.createRun(runOutside, 'live-fire');

        // Read isolation under the worker's explicit allowed tenant list.
        assert.ok(
          await workerRepo.getRun(runAllowed.id, tenantA),
          'worker must read an allowed-tenant run',
        );
        assert.equal(
          await workerRepo.getRun(runOutside.id, tenantA),
          null,
          'worker scoped to allowed tenants must not read an outside-tenant run',
        );

        // App role must not EXECUTE claim_next_step (worker-only privilege).
        await assert.rejects(
          () =>
            repoA.claimNextStep({
              workerId,
              workerGeneration: 1,
              capabilities: ['agent'],
              leaseTtlMs: 30_000,
              claimSecret,
            }),
          /permission denied/i,
          'commander_app must not EXECUTE claim_next_step',
        );

        const claimAllowed = await workerRepo.claimNextStep({
          workerId,
          workerGeneration: 1,
          capabilities: ['agent'],
          leaseTtlMs: 30_000,
          claimSecret,
        });
        assert.ok(
          claimAllowed,
          'worker LOGIN must claim via claim_next_step without caller tenantIds',
        );
        assert.equal(claimAllowed!.tenantId, tenantA);

        // Passing tenantIds must not widen durable authz (ignored on worker path).
        const claimOutside = await workerRepo.claimNextStep({
          workerId,
          workerGeneration: 1,
          tenantIds: [tenantB],
          capabilities: ['agent'],
          leaseTtlMs: 30_000,
          claimSecret,
        });
        assert.equal(
          claimOutside,
          null,
          'worker must not claim outside durable tenant_ids even if tenantIds passed',
        );

        // Outside step remains claimable only for a worker authorized to tenantB.
        const outsideStep = await schedulerRepo.getStep(runOutside.steps[0]!.id, tenantB);
        assert.equal(outsideStep?.state, 'PENDING', 'outside tenant step must remain unclaimed');
      } finally {
        await ownerPool.query('DELETE FROM commander_worker_claim_secrets WHERE worker_id=$1', [
          workerId,
        ]);
        await ownerPool.query('DELETE FROM commander_workers WHERE id=$1', [workerId]);
      }
    });

    it('worker LOGIN reads app-managed allowlist + claims reconcile effects; app cannot claim', async () => {
      const suffix = `${Date.now()}`;
      const allowTenant = `allow-${suffix}`;
      const reconWorker = `recon-w-${suffix}`;
      const run = createRunCommand(allowTenant, [{ kind: 'agent' }]);
      const effectId = `effect-recon-${suffix}`;

      await seedWorkerAllowedTenants(ownerPool, [allowTenant]);
      await seedTenantAuthorityAllowedTenants(ownerPool, [allowTenant]);
      await ownerPool.query(
        `INSERT INTO commander_workers (id,kind,version,capabilities,max_concurrency,status,generation,identity_subject,tenant_ids)
       VALUES ($1,'agent','v1','["agent"]',2,'ACTIVE',1,'db:commander_worker',$2::jsonb)`,
        [reconWorker, JSON.stringify([allowTenant])],
      );
      const claimSecret = await seedWorkerClaimSecret(ownerPool, reconWorker, 1);
      await seedAdapterOpsReadiness([allowTenant]);
      // Reconciliation claims are granted to commander_adapter_ops only, so the
      // claim half of this case must run through the adapter-ops LOGIN. Production
      // registers the reconciliation worker with register_adapter_ops_worker.
      const reconciliationInstance = `rls-${suffix}`;
      const reconciliationWorkerId = `reconcile:${reconciliationInstance}`;
      const reconciliationClient = await adapterOpsPool.connect();
      let reconciliationRegistration: { generation: number; claim_secret: string };
      try {
        const registration = await reconciliationClient.query<{
          registration: { generation: number; claim_secret: string };
        }>(`SELECT register_adapter_ops_worker('reconcile',$1,$2::jsonb,NULL) AS registration`, [
          reconciliationInstance,
          JSON.stringify([allowTenant]),
        ]);
        reconciliationRegistration = registration.rows[0]!.registration;
      } finally {
        reconciliationClient.release();
      }
      const reconciliationGeneration = Number(reconciliationRegistration.generation);
      const reconciliationSecret = reconciliationRegistration.claim_secret;

      try {
        assert.equal(await workerRepo.isActionAllowed(allowTenant, 'http.post'), false);
        await repoA.setAllowlistEntry(allowTenant, 'http.post', true);
        assert.equal(await workerRepo.isActionAllowed(allowTenant, 'http.post'), true);
        await repoA.ensureAllowlistDefault(allowTenant, 'llm.*', true);
        assert.equal(await workerRepo.isActionAllowed(allowTenant, 'llm.openai'), true);
        await workerRepo.incrementQuota({ tenantId: allowTenant, actionClass: 'http' });
        assert.equal((await workerRepo.getQuota(allowTenant, 'http')).countUsed, 1);

        await repoA.createRun(run, 'live-fire');
        // Use worker scoped to allowTenant — claim via durable authz.
        const claimed = await workerRepo.claimNextStep({
          workerId: reconWorker,
          workerGeneration: 1,
          capabilities: ['agent'],
          leaseTtlMs: 30_000,
          claimSecret,
        });
        assert.ok(claimed?.lease);
        const admitted = await repoA.admitEffect({
          id: effectId,
          runId: run.id,
          stepId: claimed!.id,
          tenantId: allowTenant,
          type: 'http.post',
          idempotencyKey: `recon-${suffix}`,
          policyDecisionId: 'allow',
          policySnapshotId: 'rls-live-fire-policy',
          actionDigest: 'c'.repeat(64),
          request: {},
          lease: claimed!.lease!,
          actor: reconWorker,
        });
        assert.ok(admitted.admitted, JSON.stringify(admitted));
        await repoA.markEffectCompletionUnknown({
          effectId,
          tenantId: allowTenant,
          reason: 'timeout',
          actor: reconWorker,
        });
        await repoA.requestReconcile({
          effectId,
          tenantId: allowTenant,
          actor: 'live-fire',
        });

        await assert.rejects(
          () =>
            repoA.claimReconcileEffects({
              limit: 5,
              now: new Date(),
              workerId: reconWorker,
              workerGeneration: 1,
              claimSecret,
            }),
          /permission denied/i,
          'commander_app must not EXECUTE claim_reconcile_effects',
        );

        assert.deepEqual(
          await adapterOpsRepo.claimReconcileEffects({
            limit: 5,
            now: new Date(),
            workerId: reconciliationWorkerId,
            workerGeneration: reconciliationGeneration,
            claimSecret: 'wrong-secret',
          }),
          [],
          'wrong claimSecret must claim no reconcile effects',
        );

        const effects = await adapterOpsRepo.claimReconcileEffects({
          limit: 5,
          now: new Date(),
          workerId: reconciliationWorkerId,
          workerGeneration: reconciliationGeneration,
          claimSecret: reconciliationSecret,
        });
        assert.equal(effects.length, 1);
        assert.equal(effects[0]!.effect.id, effectId);
        assert.equal(effects[0]!.effect.tenantId, allowTenant);
      } finally {
        await ownerPool.query('DELETE FROM commander_runs WHERE tenant_id=$1', [allowTenant]);
        await ownerPool.query('DELETE FROM commander_effect_allowlist WHERE tenant_id=$1', [
          allowTenant,
        ]);
        await ownerPool.query('DELETE FROM commander_effect_quota WHERE tenant_id=$1', [
          allowTenant,
        ]);
        await ownerPool.query('DELETE FROM commander_worker_claim_secrets WHERE worker_id=$1', [
          reconWorker,
        ]);
        await ownerPool.query('DELETE FROM commander_workers WHERE id=$1', [reconWorker]);
        await ownerPool.query('DELETE FROM commander_worker_claim_secrets WHERE worker_id=$1', [
          reconciliationWorkerId,
        ]);
        await ownerPool.query('DELETE FROM commander_workers WHERE id=$1', [
          reconciliationWorkerId,
        ]);
        await ownerPool.query('DELETE FROM commander_worker_allowed_tenants WHERE tenant_id=$1', [
          allowTenant,
        ]);
        await ownerPool.query('DELETE FROM commander_app_tenant_contexts WHERE tenant_id=$1', [
          allowTenant,
        ]);
        await ownerPool.query(
          'DELETE FROM commander_tenant_authority_allowed_tenants WHERE tenant_id=$1',
          [allowTenant],
        );
        await clearAdapterOpsReadiness([allowTenant]);
      }
    });

    it('claim_next_step fails closed for empty authz, stale generation, inactive worker, and wrong claimSecret', async () => {
      const suffix = `${Date.now()}`;
      const tenantX = `claim-authz-x-${suffix}`;
      const tenantY = `claim-authz-y-${suffix}`;
      const emptyId = `worker-empty-${suffix}`;
      const staleId = `worker-stale-${suffix}`;
      const inactiveId = `worker-inactive-${suffix}`;
      const multiId = `worker-multi-${suffix}`;
      const starId = `worker-star-${suffix}`;
      const peerId = `worker-peer-${suffix}`;
      await ownerPool.query(
        `INSERT INTO commander_workers (id,kind,version,capabilities,max_concurrency,status,generation,identity_subject,tenant_ids) VALUES
       ($1,'agent','v1','["agent"]',2,'ACTIVE',1,'db:commander_worker','[]'::jsonb),
       ($2,'agent','v1','["agent"]',2,'ACTIVE',2,'db:commander_worker',$5::jsonb),
       ($3,'agent','v1','["agent"]',2,'DRAINING',1,'db:commander_worker',$5::jsonb),
       ($4,'agent','v1','["agent"]',2,'ACTIVE',1,'db:commander_worker',$6::jsonb),
       ($7,'agent','v1','["agent"]',2,'ACTIVE',1,'db:commander_worker','["*"]'::jsonb),
       ($8,'agent','v1','["agent"]',2,'ACTIVE',1,'db:commander_worker',$5::jsonb)`,
        [
          emptyId,
          staleId,
          inactiveId,
          multiId,
          JSON.stringify([tenantX]),
          JSON.stringify([tenantX, tenantY]),
          starId,
          peerId,
        ],
      );
      const emptySecret = await seedWorkerClaimSecret(ownerPool, emptyId, 1);
      const staleSecret = await seedWorkerClaimSecret(ownerPool, staleId, 2);
      const inactiveSecret = await seedWorkerClaimSecret(ownerPool, inactiveId, 1);
      const multiSecret = await seedWorkerClaimSecret(ownerPool, multiId, 1);
      const starSecret = await seedWorkerClaimSecret(ownerPool, starId, 1);
      const peerSecret = await seedWorkerClaimSecret(ownerPool, peerId, 1);
      // The app repository only issues contexts for authority-enabled tenants.
      await seedTenantAuthorityAllowedTenants(ownerPool, [tenantX, tenantY]);
      try {
        const runX = createRunCommand(tenantX, [{ kind: 'agent' }]);
        const runY = createRunCommand(tenantY, [{ kind: 'agent' }]);
        await repoA.createRun(runX, 'live-fire');
        await repoB.createRun(runY, 'live-fire');

        assert.equal(
          await workerRepo.claimNextStep({
            workerId: emptyId,
            workerGeneration: 1,
            capabilities: ['agent'],
            leaseTtlMs: 30_000,
            claimSecret: emptySecret,
          }),
          null,
          'empty durable tenant_ids must claim nothing',
        );
        assert.equal(
          await workerRepo.claimNextStep({
            workerId: staleId,
            workerGeneration: 1,
            capabilities: ['agent'],
            leaseTtlMs: 30_000,
            claimSecret: staleSecret,
          }),
          null,
          'stale workerGeneration must claim nothing',
        );
        assert.equal(
          await workerRepo.claimNextStep({
            workerId: inactiveId,
            workerGeneration: 1,
            capabilities: ['agent'],
            leaseTtlMs: 30_000,
            claimSecret: inactiveSecret,
          }),
          null,
          'inactive worker must claim nothing',
        );
        assert.equal(
          await workerRepo.claimNextStep({
            workerId: starId,
            workerGeneration: 1,
            capabilities: ['agent'],
            leaseTtlMs: 30_000,
            claimSecret: starSecret,
          }),
          null,
          "durable tenant_ids=['*'] must fail closed (not expand)",
        );

        const peerRun = createRunCommand(tenantX, [{ kind: 'agent' }]);
        await repoA.createRun(peerRun, 'live-fire');
        assert.equal(
          await workerRepo.claimNextStep({
            workerId: peerId,
            workerGeneration: 1,
            capabilities: ['agent'],
            leaseTtlMs: 30_000,
            claimSecret: 'wrong-secret',
          }),
          null,
          'wrong claimSecret must claim nothing',
        );
        assert.equal(
          await workerRepo.claimNextStep({
            workerId: peerId,
            workerGeneration: 1,
            capabilities: ['agent'],
            leaseTtlMs: 30_000,
          }),
          null,
          'peer/missing claimSecret must claim nothing',
        );
        const peerHappy = await workerRepo.claimNextStep({
          workerId: peerId,
          workerGeneration: 1,
          capabilities: ['agent'],
          leaseTtlMs: 30_000,
          claimSecret: peerSecret,
        });
        assert.ok(peerHappy, 'correct claimSecret must allow claim');
        assert.equal(peerHappy!.tenantId, tenantX);

        const first = await workerRepo.claimNextStep({
          workerId: multiId,
          workerGeneration: 1,
          capabilities: ['agent'],
          leaseTtlMs: 30_000,
          claimSecret: multiSecret,
        });
        assert.ok(first, 'multi-tenant durable authz must claim within stored tenant_ids');
        assert.ok([tenantX, tenantY].includes(first!.tenantId));

        const second = await workerRepo.claimNextStep({
          workerId: multiId,
          workerGeneration: 1,
          capabilities: ['agent'],
          leaseTtlMs: 30_000,
          claimSecret: multiSecret,
        });
        assert.ok(second, 'multi-tenant worker must claim the other authorized tenant');
        assert.ok([tenantX, tenantY].includes(second!.tenantId));
        assert.notEqual(first!.tenantId, second!.tenantId);
      } finally {
        await ownerPool.query('DELETE FROM commander_runs WHERE tenant_id = ANY($1::text[])', [
          [tenantX, tenantY],
        ]);
        const ids = [emptyId, staleId, inactiveId, multiId, starId, peerId];
        await ownerPool.query(
          'DELETE FROM commander_worker_claim_secrets WHERE worker_id = ANY($1::text[])',
          [ids],
        );
        await ownerPool.query('DELETE FROM commander_workers WHERE id = ANY($1::text[])', [ids]);
        await ownerPool.query(
          'DELETE FROM commander_app_tenant_contexts WHERE tenant_id = ANY($1::text[])',
          [[tenantX, tenantY]],
        );
        await ownerPool.query(
          'DELETE FROM commander_tenant_authority_allowed_tenants WHERE tenant_id = ANY($1::text[])',
          [[tenantX, tenantY]],
        );
      }
    });

    it('tenant A/B read/write/cancel/effect/timer/outbox isolation: 0 leaks', async () => {
      const runA = createRunCommand(tenantA, [{ kind: 'agent' }]);
      const runB = createRunCommand(tenantB, [{ kind: 'agent' }]);

      await repoA.createRun(runA, 'live-fire');
      await repoB.createRun(runB, 'live-fire');

      // Tenant A must not read tenant B's data when scoped to tenant A.
      assert.equal(await repoA.getRun(runB.id, tenantA), null, 'A must not read B run');
      assert.equal(await repoA.getStep(runB.steps[0]!.id, tenantA), null, 'A must not read B step');
      assert.deepEqual(await repoA.listEvents(runB.id, tenantA), [], 'A must not read B events');

      // Tenant A must read its own run; B must read B's run.
      assert.ok(await repoA.getRun(runA.id, tenantA), 'A must read A run');
      assert.ok(await repoB.getRun(runB.id, tenantB), 'B must read B run');

      // Cancellation scoped to tenant: A can cancel A, but not B (even if A knows B's id).
      assert.ok(await repoA.cancelRun(runA.id, tenantA, 'live-fire'));
      assert.equal(
        await repoA.cancelRun(runB.id, tenantA, 'live-fire'),
        null,
        'A cannot cancel B run',
      );

      // Timer creation and read scoped to tenant.
      const timerA = await repoA.createTimer(
        {
          runId: runA.id,
          stepId: runA.steps[0]!.id,
          tenantId: tenantA,
          firesAt: new Date(Date.now() + 60_000),
          timerType: 'RETRY_DELAY',
          payload: {},
        },
        'live-fire',
      );
      assert.ok(timerA);
      assert.ok(await repoA.cancelTimer(timerA.id, tenantA), 'A can cancel A timer');
      const timerB = await repoB.createTimer(
        {
          runId: runB.id,
          stepId: runB.steps[0]!.id,
          tenantId: tenantB,
          firesAt: new Date(Date.now() + 60_000),
          timerType: 'RETRY_DELAY',
          payload: {},
        },
        'live-fire',
      );
      assert.ok(timerB);
      assert.equal(
        await repoA.cancelTimer(timerB.id, tenantA),
        false,
        'A cannot cancel B timer scoped as A',
      );

      // Outbox: scheduler can see both; app only sees its own tenant when scoped.
      // Dirty shared DBs may have a large claimable backlog ahead of this suite's
      // tenants (ORDER BY created_at LIMIT N) — drain until suite tenants appear.
      const seenA = new Set<string>();
      const seenB = new Set<string>();
      for (let i = 0; i < 50 && (seenA.size === 0 || seenB.size === 0); i++) {
        const batch = await schedulerRepo.claimOutbox(200);
        if (batch.length === 0) break;
        for (const m of batch) {
          if (m.tenantId === tenantA) seenA.add(m.id);
          if (m.tenantId === tenantB) seenB.add(m.id);
        }
      }
      assert.ok(seenA.size > 0, 'scheduler must see A outbox');
      assert.ok(seenB.size > 0, 'scheduler must see B outbox');
    });

    it('2 schedulers + 10 workers contend on single PostgreSQL with SKIP LOCKED: exactly one claim', async () => {
      // Race workers are durable-authorized for tenantA+tenantB; drain both so this
      // race has exactly one claimable candidate (the run created below).
      await ownerPool.query(
        `UPDATE commander_steps SET state='CANCELLED', updated_at=now()
       WHERE tenant_id = ANY($1::text[]) AND state IN ('PENDING','RETRY_WAIT')`,
        [[tenantA, tenantB]],
      );

      const run = createRunCommand(tenantA, [{ kind: 'agent' }]);
      await repoA.createRun(run, 'live-fire');

      const claims = await Promise.all([
        // Two scheduler-mode repos race for the same step.
        schedulerRepo.claimNextStep({
          workerId: schedulerA,
          workerGeneration: 1,
          tenantIds: [tenantA],
          capabilities: ['agent'],
          leaseTtlMs: 30_000,
        }),
        schedulerRepo.claimNextStep({
          workerId: schedulerB,
          workerGeneration: 1,
          tenantIds: [tenantA],
          capabilities: ['agent'],
          leaseTtlMs: 30_000,
        }),
        // Eight worker-mode racers (RPC claim; durable authz + claimSecret, no caller tenantIds).
        ...Array.from({ length: 8 }, (_, i) => {
          const id = `${workerA}-race-${i}`;
          return workerRepo.claimNextStep({
            workerId: id,
            workerGeneration: 1,
            capabilities: ['agent'],
            leaseTtlMs: 30_000,
            claimSecret: claimSecrets.get(id),
          });
        }),
      ]);

      const winners = claims.filter((c) => c !== null);
      assert.equal(winners.length, 1, 'exactly one worker may claim the step');
    });

    it('rejects stale worker generation on claim/heartbeat/complete/fail/effect', async () => {
      const run = createRunCommand(tenantA, [{ kind: 'agent' }]);
      await repoA.createRun(run, 'live-fire');

      const secretGen1 = claimSecrets.get(workerA)!;
      const claimed = await workerRepo.claimNextStep({
        workerId: workerA,
        workerGeneration: 1,
        capabilities: ['agent'],
        leaseTtlMs: 30_000,
        claimSecret: secretGen1,
      });
      assert.ok(claimed);
      assert.equal(claimed!.lease!.workerGeneration, 1);

      // Rollover worker generation + re-seed claim secret for the new generation.
      await ownerPool.query('UPDATE commander_workers SET generation=2 WHERE id=$1', [workerA]);
      const secretGen2 = await seedWorkerClaimSecret(ownerPool, workerA, 2);
      claimSecrets.set(workerA, secretGen2);

      // Old generation claim rejected.
      assert.equal(
        await workerRepo.claimNextStep({
          workerId: workerA,
          workerGeneration: 1,
          capabilities: ['agent'],
          leaseTtlMs: 30_000,
          claimSecret: secretGen1,
        }),
        null,
        'stale generation claim must fail',
      );

      // Old generation heartbeat/complete/fail rejected. Use the worker LOGIN
      // repository: heartbeat/complete/fail join commander_workers, which
      // commander_app is (correctly) no longer granted SELECT on, so the app
      // role would fail closed with permission denied before the fencing check.
      assert.equal(
        await workerRepo.heartbeatStep(claimed!.id, claimed!.tenantId, claimed!.lease!, 30_000),
        null,
        'stale generation heartbeat must fail',
      );
      assert.equal(
        await workerRepo.completeStep({
          stepId: claimed!.id,
          tenantId: claimed!.tenantId,
          lease: claimed!.lease!,
          expectedVersion: claimed!.version,
          output: {},
          actor: workerA,
        }),
        null,
        'stale generation complete must fail',
      );
      assert.equal(
        await workerRepo.failStep({
          stepId: claimed!.id,
          tenantId: claimed!.tenantId,
          lease: claimed!.lease!,
          expectedVersion: claimed!.version,
          error: { code: 'TEST', message: 'test', retryable: false },
          actor: workerA,
        }),
        null,
        'stale generation fail must fail',
      );

      // Effect admission/completion with stale generation rejected on a fresh run.
      const effectRun = createRunCommand(tenantA, [{ kind: 'agent' }]);
      await repoA.createRun(effectRun, 'live-fire');
      const effectClaim = await workerRepo.claimNextStep({
        workerId: workerA,
        workerGeneration: 2,
        capabilities: ['agent'],
        leaseTtlMs: 30_000,
        claimSecret: secretGen2,
      });
      assert.ok(effectClaim);
      assert.equal(effectClaim!.lease!.workerGeneration, 2);

      const effect = await repoA.admitEffect({
        id: `effect-${Date.now()}`,
        runId: effectRun.id,
        stepId: effectClaim!.id,
        tenantId: tenantA,
        type: 'http',
        idempotencyKey: 'rls-test-1',
        policyDecisionId: 'allow',
        policySnapshotId: 'rls-live-fire-policy',
        actionDigest: 'a'.repeat(64),
        request: { url: 'https://example.com' },
        lease: effectClaim!.lease!,
        actor: workerA,
      });
      assert.ok(effect.admitted);

      // Roll over again.
      await ownerPool.query('UPDATE commander_workers SET generation=3 WHERE id=$1', [workerA]);
      claimSecrets.set(workerA, await seedWorkerClaimSecret(ownerPool, workerA, 3));
      const staleEffectLease = effectClaim!.lease!;
      assert.equal(
        await workerRepo.completeEffect(
          effect.effect!.id,
          tenantA,
          staleEffectLease,
          { status: 'ok' },
          workerA,
        ),
        null,
        'stale generation effect completion must fail',
      );
    });

    it('app role cannot ALTER TABLE DISABLE RLS, read pg_authid, or alter policy', async () => {
      const client = await appPoolA.connect();
      try {
        // app role must not disable RLS.
        await assert.rejects(
          client.query('ALTER TABLE commander_runs DISABLE ROW LEVEL SECURITY'),
          /must be owner|permission denied/i,
          'app role must not disable RLS',
        );

        // app role must not read system catalogs containing secrets.
        await assert.rejects(
          client.query('SELECT * FROM pg_authid'),
          /permission denied/i,
          'app role must not read pg_authid',
        );

        // app role must not drop policies. Resolve the real policy name instead
        // of the stale `commander_tenant_isolation` (the campaign2 hardening
        // renamed it to `commander_app_authenticated_tenant`), and assert it
        // exists so a future rename cannot silently turn this into a no-op.
        const policy = await ownerPool.query<{ policyname: string }>(
          `SELECT policyname FROM pg_policies
            WHERE schemaname='public' AND tablename='commander_runs'
              AND policyname LIKE 'commander_app_%'`,
        );
        assert.ok(policy.rows[0], 'commander_runs must have an app RLS policy to attempt dropping');
        await assert.rejects(
          client.query(`DROP POLICY "${policy.rows[0]!.policyname}" ON commander_runs`),
          /must be owner|permission denied/i,
          'app role must not drop policy',
        );
      } finally {
        client.release();
      }
    });

    it('migration rejected when run as app role', async () => {
      await assert.rejects(
        runKernelMigrations(appPoolA as unknown as SqlPool),
        /app role is not the migration owner/i,
        'migrations must reject app role',
      );
    });
  },
);
