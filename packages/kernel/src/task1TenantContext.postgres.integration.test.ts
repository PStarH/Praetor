import assert from 'node:assert/strict';
import { after, before, describe, it, test } from 'node:test';
import { createVerifiedPostgresPool } from '@praetor/postgres-runtime';
import { seedTenantAuthorityAllowedTenants } from './seedWorkerClaimSecret.js';

const appUrl = process.env.COMMANDER_TASK1_APP_DATABASE_URL;
const authorityUrl = process.env.COMMANDER_TASK1_AUTHORITY_DATABASE_URL;
// The authority only issues a context for an allowlisted tenant, and only
// commander_owner can write that allowlist, so this proof needs an owner DSN to
// provision its own precondition. Accept the deploy-gate CI name too.
const ownerUrl =
  process.env.COMMANDER_TASK1_OWNER_DATABASE_URL ?? process.env.COMMANDER_OWNER_DATABASE_URL;

// F-K1-12: this suite is the live proof of Task 1 tenant-context binding over
// the real PostgreSQL protocol. Without the fixtures it cannot run — report the
// missing prerequisites by name and FAIL the run (a silent skip would report
// PASS for an unrun security proof).
const missingUrls = [
  !appUrl ? 'COMMANDER_TASK1_APP_DATABASE_URL' : null,
  !authorityUrl ? 'COMMANDER_TASK1_AUTHORITY_DATABASE_URL' : null,
  !ownerUrl ? 'COMMANDER_TASK1_OWNER_DATABASE_URL (or COMMANDER_OWNER_DATABASE_URL)' : null,
].filter((v): v is string => v !== null);
const livePostgresAvailable = missingUrls.length === 0;
const LIVE_PG_SKIP_REASON =
  `NOT VERIFIED: ${missingUrls.join(', ')} unset — Task 1 tenant context real ` +
  'PostgreSQL protocol proof did not run';
if (!livePostgresAvailable) {
  process.stderr.write(`[kernel:live-postgres] ${LIVE_PG_SKIP_REASON}\n`);
  test('live PostgreSQL fixture is configured (REQUIRED)', () => {
    assert.fail(LIVE_PG_SKIP_REASON);
  });
}

describe(
  'Task 1 tenant context real PostgreSQL protocol',
  {
    skip: livePostgresAvailable ? false : LIVE_PG_SKIP_REASON,
  },
  () => {
    const tenantId = 'tenant-a';
    const otherTenantId = 'tenant-b';
    let ownerPool: ReturnType<typeof createVerifiedPostgresPool>;

    // Provision the fixture's own precondition: enable tenant-a (and only
    // tenant-a) in the authority allowlist, so the positive case proves the
    // allowlist semantics rather than the operator's hand-seeded state. The row
    // is idempotent on a clean database and is left in place on a shared one.
    before(async () => {
      ownerPool = createVerifiedPostgresPool({ connectionString: ownerUrl!, max: 1 });
      await seedTenantAuthorityAllowedTenants(ownerPool, [tenantId]);
    });

    after(async () => {
      await ownerPool?.end();
    });

    it('binds exactly one tenant to the target app xid and closes it', async () => {
      const appPool = createVerifiedPostgresPool({ connectionString: appUrl!, max: 1 });
      const authorityPool = createVerifiedPostgresPool({ connectionString: authorityUrl!, max: 1 });
      const app = await appPool.connect();
      try {
        await app.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        const target = await app.query<{
          database_oid: number;
          backend_pid: number;
          xid: string;
        }>(`
        SELECT database.oid AS database_oid,
               pg_catalog.pg_backend_pid() AS backend_pid,
               pg_catalog.pg_current_xact_id()::text AS xid
          FROM pg_catalog.pg_database AS database
         WHERE database.datname = pg_catalog.current_database()
      `);
        const { database_oid, backend_pid, xid } = target.rows[0]!;
        const issued = await authorityPool.query<{ context_id: string }>(
          `SELECT context_id::text
           FROM public.issue_app_tenant_context($1::text, $2::oid, $3::integer, $4::xid8)`,
          [tenantId, database_oid, backend_pid, xid],
        );
        const contextId = issued.rows[0]!.context_id;

        await assert.rejects(
          () =>
            authorityPool.query(
              `SELECT context_id::text
             FROM public.issue_app_tenant_context($1::text, $2::oid, $3::integer, $4::xid8)`,
              [otherTenantId, database_oid, backend_pid, xid],
            ),
          /TENANT_CONTEXT_INVALID/,
        );

        const first = await app.query<{ tenant_id: string; replayed: boolean }>(
          'SELECT tenant_id, replayed FROM public.bind_app_tenant_context($1::uuid)',
          [contextId],
        );
        assert.deepEqual(first.rows, [{ tenant_id: tenantId, replayed: false }]);
        const replay = await app.query<{ tenant_id: string; replayed: boolean }>(
          'SELECT tenant_id, replayed FROM public.bind_app_tenant_context($1::uuid)',
          [contextId],
        );
        assert.deepEqual(replay.rows, [{ tenant_id: tenantId, replayed: true }]);
        assert.equal(
          (
            await app.query<{ tenant_id: string }>(
              'SELECT public.commander_authenticated_app_tenant() AS tenant_id',
            )
          ).rows[0]!.tenant_id,
          tenantId,
        );

        await app.query('SELECT public.close_app_tenant_context($1::uuid)', [contextId]);
        await assert.rejects(
          () => app.query('SELECT public.commander_authenticated_app_tenant()'),
          /TENANT_CONTEXT_INVALID/,
        );
        await app.query('COMMIT');
      } catch (error) {
        await app.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        app.release();
        await Promise.all([appPool.end(), authorityPool.end()]);
      }
    });
  },
);
