import { pathToFileURL } from 'node:url';
import {
  createVerifiedPostgresPool,
  type VerifiedPostgresPoolInput,
} from '@praetor/postgres-runtime';

export type MigrationGateMode = 'preflight' | 'await';
export type MigrationGateTarget = {
  name: string;
  connectionString: string;
  /** Only the post-migration `await` gate compares the applied descriptor state. */
  verifyDescriptors: boolean;
};
export type MigrationGateDescriptors = Record<string, string>;
export type MigrationGateProbe = (
  target: MigrationGateTarget,
  descriptors: MigrationGateDescriptors,
) => Promise<void>;

const PREFLIGHT_ROLES = ['OWNER', 'APP', 'TENANT_AUTHORITY', 'SCHEDULER', 'WORKER', 'ADAPTER_OPS'];
const CHECKSUM = /^[a-f0-9]{64}$/;
const DESCRIPTOR = /^[A-Za-z0-9._-]+$/;

/** Owner-owned SECURITY DEFINER reader installed by the kernel migration descriptors. */
export const MIGRATION_GATE_DESCRIPTOR_READINESS_FUNCTION =
  'public.commander_applied_migration_descriptors()';
export const MIGRATION_GATE_DESCRIPTOR_STATE_MISSING = 'MIGRATION_GATE_DESCRIPTOR_STATE_MISSING';
export const MIGRATION_GATE_DESCRIPTORS_MISMATCH = 'MIGRATION_GATE_DESCRIPTORS_MISMATCH';
const DESCRIPTOR_READINESS_QUERY =
  'SELECT id::text AS id, checksum::text AS checksum FROM ' +
  MIGRATION_GATE_DESCRIPTOR_READINESS_FUNCTION;

export function parseMigrationGateMode(args: readonly string[]): MigrationGateMode {
  if (args.length !== 1 || (args[0] !== 'preflight' && args[0] !== 'await')) {
    throw new Error('MIGRATION_GATE_MODE_INVALID');
  }
  return args[0];
}

export function migrationGateTargets(
  mode: MigrationGateMode,
  env: NodeJS.ProcessEnv = process.env,
): MigrationGateTarget[] {
  if (mode === 'await') {
    const connectionString = env.COMMANDER_KERNEL_DATABASE_URL;
    if (!connectionString) throw new Error('MIGRATION_GATE_DATABASE_URL_MISSING');
    return [{ name: 'RUNTIME', connectionString, verifyDescriptors: true }];
  }
  return PREFLIGHT_ROLES.map((role) => {
    const connectionString = env['COMMANDER_PREFLIGHT_' + role + '_DATABASE_URL'];
    if (!connectionString) throw new Error('MIGRATION_GATE_DATABASE_URL_MISSING');
    // Preflight runs before the migration container, so it can only prove the
    // sealed role credentials connect; the `await` gate owns descriptor agreement.
    return { name: role, connectionString, verifyDescriptors: false };
  });
}

export function parseExpectedMigrationDescriptors(
  raw: string | undefined,
): MigrationGateDescriptors {
  const source = raw ?? '{}';
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error('MIGRATION_GATE_DESCRIPTORS_INVALID');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('MIGRATION_GATE_DESCRIPTORS_INVALID');
  }
  const result: MigrationGateDescriptors = {};
  for (const [id, checksum] of Object.entries(parsed)) {
    if (!DESCRIPTOR.test(id) || typeof checksum !== 'string' || !CHECKSUM.test(checksum)) {
      throw new Error('MIGRATION_GATE_DESCRIPTORS_INVALID');
    }
    result[id] = checksum;
  }
  return result;
}

/** Bound one probe so the migration wait loop, rather than the Job deadline, owns retries. */
export function migrationGatePoolConfig(connectionString: string): VerifiedPostgresPoolInput {
  return {
    connectionString,
    max: 1,
    connectionTimeoutMillis: 5_000,
    query_timeout: 5_000,
    statement_timeout: 4_500,
  };
}

export type MigrationGatePool = {
  query<T = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<{
    rows: T[];
  }>;
  end(): Promise<void>;
};

export type MigrationGatePoolFactory = (input: VerifiedPostgresPoolInput) => MigrationGatePool;

async function appliedDescriptors(
  pool: MigrationGatePool,
): Promise<Array<{ id: string; checksum: string }>> {
  try {
    const result = await pool.query<{ id: string; checksum: string }>(DESCRIPTOR_READINESS_QUERY);
    return result.rows.map(({ id, checksum }) => ({ id: String(id), checksum: String(checksum) }));
  } catch {
    // Fail closed: a runtime role that cannot read applied-descriptor state is not
    // evidence that this release's migrations were applied.
    throw new Error(MIGRATION_GATE_DESCRIPTOR_STATE_MISSING);
  }
}

/**
 * Compare the release's expected descriptors with the database's applied-migration
 * ledger. Every expected descriptor must be present with the exact published
 * checksum; the migration set is additive, so extra applied rows are allowed.
 */
export async function verifyMigrationGateDescriptors(
  pool: MigrationGatePool,
  descriptors: MigrationGateDescriptors,
): Promise<void> {
  const expected = Object.entries(descriptors).sort(([left], [right]) => left.localeCompare(right));
  // An empty expected set is only produced by the Helm transport-bootstrap deploy,
  // which runs no migration job and can therefore promise no descriptor.
  if (expected.length === 0) return;
  const applied = new Map(
    (await appliedDescriptors(pool)).map(({ id, checksum }) => [id, checksum] as const),
  );
  for (const [id, checksum] of expected) {
    if (applied.get(id) !== checksum) throw new Error(MIGRATION_GATE_DESCRIPTORS_MISMATCH);
  }
}

export async function probeMigrationGateTarget(
  target: MigrationGateTarget,
  descriptors: MigrationGateDescriptors,
  createPool: MigrationGatePoolFactory = createVerifiedPostgresPool,
): Promise<void> {
  const pool = createPool(migrationGatePoolConfig(target.connectionString));
  try {
    await pool.query('SELECT 1');
    if (target.verifyDescriptors) {
      await verifyMigrationGateDescriptors(pool, descriptors);
    }
  } finally {
    await pool.end();
  }
}

const probeDatabase: MigrationGateProbe = (target, descriptors) =>
  probeMigrationGateTarget(target, descriptors);

export async function runMigrationGateAttempt(
  mode: MigrationGateMode,
  env: NodeJS.ProcessEnv = process.env,
  probe: MigrationGateProbe = probeDatabase,
): Promise<void> {
  const descriptors = parseExpectedMigrationDescriptors(
    env.COMMANDER_MIGRATION_EXPECTED_DESCRIPTORS,
  );
  await Promise.all(migrationGateTargets(mode, env).map((target) => probe(target, descriptors)));
}

function timeoutSeconds(mode: MigrationGateMode, env: NodeJS.ProcessEnv): number {
  const raw = env.COMMANDER_DATABASE_WAIT_TIMEOUT_SECONDS;
  if (raw === undefined && mode === 'await') return 120;
  const seconds = Number(raw ?? 120);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 900) {
    throw new Error('MIGRATION_GATE_TIMEOUT_INVALID');
  }
  return seconds;
}

function diagnostic(mode: MigrationGateMode, error: unknown): string {
  const code =
    error instanceof Error && /^[A-Z0-9_]{2,80}$/.test(error.message)
      ? error.message
      : 'MIGRATION_GATE_DATABASE_UNAVAILABLE';
  return 'COMMANDER_MIGRATION_FAILED stage=' + mode + ' code=' + code;
}

async function main(): Promise<void> {
  const mode = parseMigrationGateMode(process.argv.slice(2));
  const deadline = Date.now() + timeoutSeconds(mode, process.env) * 1000;
  let lastError: unknown;
  do {
    try {
      await runMigrationGateAttempt(mode);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } while (Date.now() < deadline);
  throw new Error(diagnostic(mode, lastError));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  void main().catch((error) => {
    process.stderr.write(
      (error instanceof Error ? error.message : 'COMMANDER_MIGRATION_FAILED') + '\n',
    );
    process.exitCode = 1;
  });
}
