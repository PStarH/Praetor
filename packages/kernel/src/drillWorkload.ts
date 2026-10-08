/**
 * Minimal workload generator for PostgreSQL disaster-recovery drills.
 *
 * Creates a single kernel run and prints its id/tenantId as JSON so that
 * shell scripts can capture and verify it after PITR or failover.
 */

import { createHash, randomUUID } from 'node:crypto';
import { createVerifiedPostgresPool } from '@praetor/postgres-runtime';
import { PostgresKernelRepository, PostgresTenantContextAuthority } from './postgres.js';
import { runKernelMigrations, runTask1ClosureMigrations } from './migrations.js';
import { seedTenantAuthorityAllowedTenants } from './seedWorkerClaimSecret.js';

export interface CreatedRun {
  id: string;
  tenantId: string;
}

export interface DrillTenantContextConfig {
  authorityDatabaseUrl?: string;
  runtimeDatabaseUrl?: string;
  /**
   * KB-05: `enforce` runs with the six-role tenant-authority DSN;
   * `without-tenant-context-authority` is an explicit, auditable opt-out. The
   * caller (drill script) must treat that phase as NOT VERIFIED, never PASS.
   */
  phase?: 'enforce' | 'without-tenant-context-authority';
}

export function resolveDrillTenantContextConfig(
  env: NodeJS.ProcessEnv = process.env,
): DrillTenantContextConfig {
  const raw = env.COMMANDER_TENANT_AUTHORITY_DATABASE_URL?.trim();
  if (!raw) {
    // KB-05: a missing authority DSN used to degrade silently to a repository
    // with no tenant-context authority, so a PITR/failover drill could print
    // PASS while never exercising the enforced tenant path. Fail closed unless
    // the operator explicitly declares the reduced scope.
    if (env.COMMANDER_DRILL_WITHOUT_TENANT_AUTHORITY === '1') {
      return { phase: 'without-tenant-context-authority' };
    }
    throw new Error('DRILL_TENANT_AUTHORITY_DATABASE_URL_REQUIRED');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('DRILL_TENANT_AUTHORITY_DATABASE_URL_INVALID');
  }
  if (
    (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') ||
    decodeURIComponent(url.username) !== 'commander_tenant_authority'
  ) {
    throw new Error('DRILL_TENANT_AUTHORITY_DATABASE_ROLE_INVALID');
  }
  const runtimeDatabaseUrl = env.COMMANDER_APP_DATABASE_URL?.trim();
  if (!runtimeDatabaseUrl) throw new Error('DRILL_APP_DATABASE_URL_REQUIRED');
  let runtimeUrl: URL;
  try {
    runtimeUrl = new URL(runtimeDatabaseUrl);
  } catch {
    throw new Error('DRILL_APP_DATABASE_URL_INVALID');
  }
  if (
    (runtimeUrl.protocol !== 'postgres:' && runtimeUrl.protocol !== 'postgresql:') ||
    decodeURIComponent(runtimeUrl.username) !== 'commander_app'
  ) {
    throw new Error('DRILL_APP_DATABASE_ROLE_INVALID');
  }
  return { authorityDatabaseUrl: raw, runtimeDatabaseUrl, phase: 'enforce' };
}

export async function createDrillRun(
  databaseUrl: string,
  tenantContext: DrillTenantContextConfig = resolveDrillTenantContextConfig(),
): Promise<CreatedRun> {
  const pool = createVerifiedPostgresPool({ connectionString: databaseUrl });
  const runtimePool = tenantContext.runtimeDatabaseUrl
    ? createVerifiedPostgresPool({ connectionString: tenantContext.runtimeDatabaseUrl })
    : pool;
  const authorityPool = tenantContext.authorityDatabaseUrl
    ? createVerifiedPostgresPool({ connectionString: tenantContext.authorityDatabaseUrl })
    : undefined;
  try {
    await runKernelMigrations(pool);
    if (tenantContext.phase === 'enforce') {
      await runTask1ClosureMigrations(pool, 'enforce');
      await runKernelMigrations(pool);
    }
    const tenantId = `tenant-drill-${Date.now()}`;
    const id = `run_${randomUUID().slice(0, 8)}`;
    if (authorityPool) {
      await seedTenantAuthorityAllowedTenants(pool, [tenantId]);
    }
    const repo = new PostgresKernelRepository(
      runtimePool,
      authorityPool
        ? {
            tenantContextAuthority: new PostgresTenantContextAuthority(authorityPool),
            // An authority pool only exists for the `enforce` phase.
            tenantContextPhase: 'enforce' as const,
          }
        : undefined,
    );
    const run = await repo.createRun(
      {
        id,
        tenantId,
        intentHash: createHash('sha256').update(id).digest('hex'),
        workGraphHash: createHash('sha256').update('[]').digest('hex'),
        workGraphVersion: 'v1',
        policySnapshotId: 'drill-policy',
        steps: [{ id: `${id}-step-0`, kind: 'agent', maxAttempts: 3, priority: 0 }],
      },
      'drill',
    );
    return { id: run.id, tenantId: run.tenantId };
  } finally {
    await authorityPool?.end();
    if (runtimePool !== pool) await runtimePool.end();
    await pool.end();
  }
}

async function main() {
  const databaseUrl = process.argv[2];
  if (!databaseUrl) {
    console.error('Usage: tsx packages/kernel/src/drillWorkload.ts <databaseUrl>');
    process.exit(1);
  }
  const run = await createDrillRun(databaseUrl);
  console.log(JSON.stringify(run));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
