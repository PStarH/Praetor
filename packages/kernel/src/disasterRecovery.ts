/**
 * Lightweight disaster-recovery verification helpers for PostgreSQL drills.
 *
 * Used by `scripts/pitr-drill.sh` and `scripts/failover-drill.sh` to assert that
 * kernel data is present or absent after PITR/failover.
 */

import { createVerifiedPostgresPool } from '@praetor/postgres-runtime';
import { PostgresKernelRepository } from './postgres.js';

export interface DrilledRun {
  id: string;
  tenantId: string;
}

export function buildDrillVerificationRepositoryOptions(): { schedulerMode: true } {
  return { schedulerMode: true };
}

export async function verifyRunExists(databaseUrl: string, run: DrilledRun): Promise<boolean> {
  const pool = createVerifiedPostgresPool({ connectionString: databaseUrl });
  try {
    const repo = new PostgresKernelRepository(pool, buildDrillVerificationRepositoryOptions());
    const found = await repo.getRun(run.id, run.tenantId);
    return found !== null;
  } finally {
    await pool.end();
  }
}

export async function verifyRunMissing(databaseUrl: string, run: DrilledRun): Promise<boolean> {
  const exists = await verifyRunExists(databaseUrl, run);
  return !exists;
}

async function main() {
  const [action, databaseUrl, runId, tenantId] = process.argv.slice(2);
  if (!action || !databaseUrl || !runId || !tenantId) {
    console.error(
      'Usage: tsx packages/kernel/src/disasterRecovery.ts <exists|missing> <databaseUrl> <runId> <tenantId>',
    );
    process.exit(1);
  }
  const run: DrilledRun = { id: runId, tenantId };
  if (action === 'exists') {
    const ok = await verifyRunExists(databaseUrl, run);
    console.log(ok ? 'PASS: run exists' : 'FAIL: run does not exist');
    process.exit(ok ? 0 : 1);
  } else if (action === 'missing') {
    const ok = await verifyRunMissing(databaseUrl, run);
    console.log(ok ? 'PASS: run is absent' : 'FAIL: run still exists');
    process.exit(ok ? 0 : 1);
  } else {
    console.error(`Unknown action: ${action}`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
