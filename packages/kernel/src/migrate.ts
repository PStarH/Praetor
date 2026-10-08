import {
  createVerifiedPostgresPool,
  type VerifiedPostgresPoolInput,
} from '@praetor/postgres-runtime';
import type { Pool } from 'pg';
import { pathToFileURL } from 'node:url';
import {
  runKernelMigrations,
  runTask1ClosureMigrations,
  applyTask1ClosureDescriptorSet,
  type Task1ClosurePhase,
} from './migrations.js';
import {
  seedDemoTicketAllowlist,
  seedTenantAuthorityAllowedTenants,
  seedWorkerAllowedTenants,
  type ClaimSecretSeedClient,
} from './seedWorkerClaimSecret.js';
import {
  runTask1OwnerCommand,
  parseTask1OwnerCommandInput,
  type Task1OwnerCommandMode,
  type Task1OwnerPreparedRequest,
  type Task1HelmRestoreEvidence,
} from './task1LifecycleOwnerCommand.js';
import { initializeTask1LifecycleBoundary } from './task1LifecycleInitialize.js';
import {
  TASK1_CATALOG_COLLECTION_STEPS,
  TASK1_CATALOG_ORIGIN_CLASSIFICATION_STEPS,
  TASK1_CATALOG_SNAPSHOT_VALIDATIONS,
} from './task1Catalog.js';
import type { SqlClient, SqlPool } from './postgres.js';
import {
  PostgresTask1LifecycleOwnerTransactions,
  Task1LifecycleLedger,
  type Task1LifecycleOperation,
} from './task1LifecycleLedger.js';
import type { TenantCutoverCommand } from './tenantCutoverStateMachine.js';
import {
  isTask1RolloutProofForOperation,
  Task1RolloutProofRuntime,
  type Task1RecoveryPredecessorChallenge,
  type Task1RolloutProofReceipt,
} from './task1RolloutProof.js';
import { PostgresTask1RolloutProofTransactions } from './task1RolloutProofPostgres.js';
import {
  createTask1ComposePlatformObserver,
  createTask1ComposeRelayClientFromEnvironment,
  readTask1ProofCa,
} from './task1ComposeProofRuntime.js';
import { requestTask1ReadinessChallenge } from './task1ReadinessChallengeClient.js';
import { createTask1KubernetesProofObserver } from './task1KubernetesProofObserver.js';
import {
  createTask1KubernetesProofApi,
  parseTask1ProjectedTokenIdentity,
} from './task1KubernetesProofRuntime.js';
import { readFile } from 'node:fs/promises';
import { canonicalBootstrapJson, canonicalBootstrapSha256 } from './canonicalBootstrap.js';
import { buildAdapterOpsLoginSql } from './sqlSafety.js';
import { randomUUID, scryptSync } from 'node:crypto';

/** Parse comma-separated tenant list; reject empty and '*'. */
export function parseAllowedTenantsEnv(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && t !== '*');
}

/** Same parameters as `hashSecret` in packages/core/src/runtime/httpTenantGate.ts. */
export function hashCellApiKey(secret: string): string {
  const salt = Buffer.from(`commander.api-credential.v1:${secret.slice(0, 8)}`);
  return scryptSync(secret, salt, 32, { N: 16384, r: 8, p: 1 }).toString('hex');
}

/** Seed the explicitly injected cell API key into the PostgreSQL auth authority. */
export async function seedDemoApiKey(
  client: Pick<SqlClient, 'query'>,
  apiKey: string | undefined,
  tenantId: string | undefined,
): Promise<void> {
  const key = apiKey?.trim();
  if (!key) return;
  if (!tenantId?.trim() || tenantId.trim() === '*') throw new Error('CELL_API_KEY_TENANT_REQUIRED');
  const table = await client.query<{ relation: string | null }>(
    `SELECT to_regclass('public.commander_auth_api_keys')::text AS relation`,
  );
  if (!table.rows[0]?.relation) throw new Error('CELL_API_KEY_AUTH_SCHEMA_REQUIRED');
  const hash = hashCellApiKey(key);
  await client.query(
    `INSERT INTO commander_auth_api_keys
       (id, name, prefix, key_hash, scopes, tenant_id)
     VALUES ($1, 'cell-e2e', $2, $3, ARRAY['read','write','actions:approve']::text[], $4)
     ON CONFLICT (key_hash) DO NOTHING`,
    [`ak_cell_${randomUUID()}`, key.slice(0, 8), hash, tenantId.trim()],
  );
}

const TASK1_READINESS_TENANT = 'commander/readiness/v1';

/** Authorize the readiness probe and explicitly configured business tenants together. */
export async function seedTask1AllowedTenants(
  client: ClaimSecretSeedClient,
  tenantIds: readonly string[] = [],
): Promise<void> {
  await seedTenantAuthorityAllowedTenants(client, [TASK1_READINESS_TENANT, ...tenantIds]);
}

/** Populated-volume upgrade gate: role init scripts only run on first database creation. */
export async function ensureAdapterOpsLogin(pool: Pool, password: string): Promise<void> {
  // AUDIT-K6: SQL body built by the shared helper — a password containing the
  // dollar-quote tag would otherwise terminate the DO block and inject SQL.
  await pool.query(buildAdapterOpsLoginSql(password));
}

/** Resolve the adapter-ops LOGIN password without requiring a sixth raw-password Secret key. */
export function resolveAdapterOpsPassword(env: NodeJS.ProcessEnv): string | undefined {
  const explicit = env.COMMANDER_ADAPTER_OPS_PASSWORD;
  if (explicit !== undefined) {
    if (!explicit) throw new Error('COMMANDER_ADAPTER_OPS_PASSWORD must be non-empty');
    return explicit;
  }
  const rawUrl = env.COMMANDER_ADAPTER_OPS_DATABASE_URL?.trim();
  if (!rawUrl) return undefined;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('COMMANDER_ADAPTER_OPS_DATABASE_URL must be a valid PostgreSQL URL');
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    url.username !== 'commander_adapter_ops' ||
    !url.password
  ) {
    throw new Error(
      'COMMANDER_ADAPTER_OPS_DATABASE_URL must contain commander_adapter_ops credentials',
    );
  }
  return decodeURIComponent(url.password);
}

export function resolveMigrationDatabaseUrl(env: NodeJS.ProcessEnv): string | undefined {
  return env.COMMANDER_OWNER_DATABASE_URL ?? env.COMMANDER_KERNEL_DATABASE_URL ?? env.DATABASE_URL;
}

/** Keep lifecycle owner Jobs bounded when database connection or query waits stop progressing. */
export function ownerMigrationPoolConfig(connectionString: string): VerifiedPostgresPoolInput {
  return {
    connectionString,
    connectionTimeoutMillis: 5_000,
    query_timeout: 30_000,
    lock_timeout: 30_000,
  };
}

/** Keep every lifecycle migration path bounded independently of the Kubernetes Job deadline. */
export function migrationPoolConfig(
  action: string | undefined,
  connectionString: string,
): VerifiedPostgresPoolInput {
  return isTask1OwnerCommandMode(action) || action === 'tenant-cutover-migrate'
    ? ownerMigrationPoolConfig(connectionString)
    : { connectionString };
}

const MIGRATION_ID = /^[0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9]+\.[a-z0-9_]+$/;
const POSTGRES_SQLSTATE = /^[0-9A-Z]{5}$/;
export const OWNER_MIGRATION_FAILURE_STAGES = [
  'input',
  'proof_runtime',
  'bootstrap_kernel',
  'bootstrap_closure',
  'bootstrap_kernel_post_closure',
  'owner_pool_configuration',
  'owner_pool_connect',
  'bootstrap_context',
  'bootstrap_context_authority_url',
  'bootstrap_context_pool_configuration',
  'bootstrap_context_pool_connect',
  'bootstrap_context_catalog_query',
  'bootstrap_context_pool_close',
  'lifecycle_initialize',
  'lifecycle_pinned_manifest_validation',
  'lifecycle_prepared_request_validation',
  'lifecycle_table_discovery',
  'lifecycle_candidate_peer_observation',
  'lifecycle_candidate_peer_validation',
  'lifecycle_prebootstrap_snapshot',
  'lifecycle_prebootstrap_snapshot_comparison',
  'lifecycle_initialization_planning',
  'lifecycle_descriptor_transaction',
  'lifecycle_peer_reobservation',
  'lifecycle_peer_reobservation_input_consistency',
  'lifecycle_peer_reobservation_candidate_binding_validation',
  'lifecycle_peer_reobservation_observed_binding_validation',
  'lifecycle_peer_reobservation_binding_consistency',
  'lifecycle_transaction',
  'current_read',
  'rollout_proof',
] as const;
export type OwnerMigrationFailureStage = (typeof OWNER_MIGRATION_FAILURE_STAGES)[number];

function isOwnerMigrationFailureStage(value: unknown): value is OwnerMigrationFailureStage {
  return (
    typeof value === 'string' &&
    (OWNER_MIGRATION_FAILURE_STAGES as readonly string[]).includes(value)
  );
}

/** Emit a fixed progress marker that the Helm owner can retain without exposing migration output. */
export function ownerMigrationProgressRecord(ownerStage: OwnerMigrationFailureStage): string {
  return 'COMMANDER_MIGRATION_PROGRESS;owner_stage=' + ownerStage;
}

let ownerMigrationProgressReporter: ((ownerStage: OwnerMigrationFailureStage) => void) | undefined;

function isTask1CatalogCollectionStep(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    (TASK1_CATALOG_COLLECTION_STEPS as readonly string[]).includes(value)
  );
}

function isSnapshotTransaction(value: unknown): value is 'begin' | 'commit' {
  return value === 'begin' || value === 'commit';
}

function isSnapshotValidation(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    (TASK1_CATALOG_SNAPSHOT_VALIDATIONS as readonly string[]).includes(value)
  );
}

function isOriginClassificationStep(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    (TASK1_CATALOG_ORIGIN_CLASSIFICATION_STEPS as readonly string[]).includes(value)
  );
}

function withOwnerMigrationFailureStage(
  error: unknown,
  ownerStage: OwnerMigrationFailureStage,
): unknown {
  if (!error || typeof error !== 'object') {
    return Object.assign(new Error('COMMANDER_MIGRATION_FAILED'), { ownerStage });
  }
  const failure = error as { ownerStage?: unknown };
  if (isOwnerMigrationFailureStage(failure.ownerStage)) return error;
  try {
    Object.defineProperty(error, 'ownerStage', {
      configurable: true,
      enumerable: true,
      value: ownerStage,
      writable: true,
    });
    return error;
  } catch {
    return Object.assign(new Error('COMMANDER_MIGRATION_FAILED'), { ownerStage });
  }
}

async function atOwnerMigrationFailureStage<T>(
  ownerStage: OwnerMigrationFailureStage,
  operation: () => Promise<T>,
): Promise<T> {
  ownerMigrationProgressReporter?.(ownerStage);
  try {
    return await operation();
  } catch (error) {
    throw withOwnerMigrationFailureStage(error, ownerStage);
  }
}

/** Return the owner Job's fixed, non-sensitive migration failure record. */
export function migrationFailureDiagnostic(error: unknown): string {
  if (!error || typeof error !== 'object') return 'COMMANDER_MIGRATION_FAILED';
  const failure = error as {
    migrationId?: unknown;
    ownerStage?: unknown;
    snapshot?: unknown;
    catalogStep?: unknown;
    snapshotTransaction?: unknown;
    snapshotValidation?: unknown;
    originClassificationStep?: unknown;
    phase?: unknown;
    sqlstate?: unknown;
    code?: unknown;
    diagnostic?: unknown;
  };
  if (!isOwnerMigrationFailureStage(failure.ownerStage)) return 'COMMANDER_MIGRATION_FAILED';
  let diagnostic = 'COMMANDER_MIGRATION_FAILED;owner_stage=' + failure.ownerStage;
  if (
    failure.ownerStage === 'lifecycle_prebootstrap_snapshot' &&
    (failure.snapshot === 's0' || failure.snapshot === 's1')
  ) {
    const hasCatalogStep = isTask1CatalogCollectionStep(failure.catalogStep);
    const hasSnapshotTransaction = isSnapshotTransaction(failure.snapshotTransaction);
    const hasSnapshotValidation = isSnapshotValidation(failure.snapshotValidation);
    if (
      Number(hasCatalogStep) + Number(hasSnapshotTransaction) + Number(hasSnapshotValidation) ===
      1
    ) {
      diagnostic += ';snapshot=' + failure.snapshot;
      diagnostic += hasCatalogStep
        ? ';catalog_step=' + failure.catalogStep
        : hasSnapshotTransaction
          ? ';snapshot_transaction=' + failure.snapshotTransaction
          : ';snapshot_validation=' + failure.snapshotValidation;
      if (
        failure.snapshotValidation === 'origin_classification' &&
        isOriginClassificationStep(failure.originClassificationStep)
      ) {
        diagnostic += ';origin_classification_step=' + failure.originClassificationStep;
      }
    }
  }
  if (
    failure.ownerStage === 'rollout_proof' &&
    failure.code === 'TENANT_CUTOVER_KUBERNETES_PROOF_INVALID' &&
    typeof failure.diagnostic === 'string' &&
    /^task1KubernetesProofObserver\.(?:ts|js):[1-9][0-9]*:[1-9][0-9]*$/.test(failure.diagnostic)
  ) {
    diagnostic += ';proof_code=' + failure.code + ';proof_invariant=' + failure.diagnostic;
  }
  if (
    typeof failure.migrationId !== 'string' ||
    !MIGRATION_ID.test(failure.migrationId) ||
    typeof failure.phase !== 'string' ||
    !['baseline', 'lifecycle', 'expand', 'enforce'].includes(failure.phase) ||
    typeof failure.sqlstate !== 'string' ||
    !POSTGRES_SQLSTATE.test(failure.sqlstate)
  ) {
    return diagnostic;
  }
  return (
    diagnostic +
    ';migration=' +
    failure.migrationId +
    ';phase=' +
    failure.phase +
    ';sqlstate=' +
    failure.sqlstate
  );
}

export function parseTask1ClosureMigrationPhase(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Task1ClosurePhase | undefined {
  const action = args[0];
  if (action === undefined) return undefined;
  if (action !== 'tenant-cutover-migrate') {
    throw new Error('TASK1_LIFECYCLE_ACTION_UNSUPPORTED');
  }
  const phase = env.COMMANDER_TENANT_AUTHORITY_CUTOVER_PHASE;
  if (phase !== 'expand' && phase !== 'enforce') {
    throw new Error('TASK1_CLOSURE_PHASE_REQUIRED');
  }
  return phase;
}

const TASK1_OWNER_COMMAND_MODES = new Set<Task1OwnerCommandMode>([
  'tenant-cutover-plan',
  'tenant-cutover-append',
  'tenant-cutover-recover',
  'tenant-cutover-prove',
  'tenant-cutover-restore',
]);

export function isTask1OwnerCommandMode(value: string | undefined): value is Task1OwnerCommandMode {
  return value !== undefined && TASK1_OWNER_COMMAND_MODES.has(value as Task1OwnerCommandMode);
}

/** Apply the historical and phase-gated migration descriptors for an explicit migration action. */
export async function bootstrapTask1OwnerAppendMigrations(
  pool: SqlPool,
  command: TenantCutoverCommand,
): Promise<void> {
  await atOwnerMigrationFailureStage('bootstrap_kernel', () =>
    runKernelMigrations(pool, { requiredRole: 'owner' }),
  );
  await atOwnerMigrationFailureStage('bootstrap_closure', () =>
    runTask1ClosureMigrations(pool, command === 'expand' ? 'expand' : 'enforce'),
  );
  // Mirror the CLI: once the enforce closure exists, the forward list gains
  // post-closure descriptors (auth-persistence schema included). Re-run so a
  // single bootstrap leaves the database complete for the API.
  await atOwnerMigrationFailureStage('bootstrap_kernel_post_closure', () =>
    runKernelMigrations(pool, { requiredRole: 'owner' }),
  );
}

export async function runTask1OwnerAppendBootstrap(
  pool: SqlPool,
  prepared: Task1OwnerPreparedRequest,
  dependencies: {
    initialize?: (client: SqlClient, request: Task1OwnerPreparedRequest) => Promise<void>;
    applyClosure?: (pool: SqlPool, phase: Task1ClosurePhase) => Promise<void>;
  } = {},
): Promise<void> {
  const initialize =
    dependencies.initialize ??
    ((client, request) => initializeTask1LifecycleBoundary({ client, prepared: request }));
  const applyClosure = dependencies.applyClosure ?? runTask1ClosureMigrations;
  const client = await atOwnerMigrationFailureStage('owner_pool_connect', () => pool.connect());
  try {
    await atOwnerMigrationFailureStage('lifecycle_initialize', () => initialize(client, prepared));
  } finally {
    client.release();
  }
  await atOwnerMigrationFailureStage('bootstrap_closure', () =>
    applyClosure(pool, prepared.command === 'expand' ? 'expand' : 'enforce'),
  );
}

function operationFromDatabaseRow(row: Record<string, unknown>): Task1LifecycleOperation {
  const text = (name: string): string => {
    const value = row[name];
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new Error('TENANT_CUTOVER_OWNER_CURRENT_INVALID');
    }
    return String(value);
  };
  const nullableText = (name: string): string | null => {
    const value = row[name];
    if (value === null || value === undefined) return null;
    return text(name);
  };
  const descriptorSet = row.descriptor_set;
  if (!Array.isArray(descriptorSet) || !descriptorSet.every((value) => typeof value === 'string')) {
    throw new Error('TENANT_CUTOVER_OWNER_CURRENT_INVALID');
  }
  const operationKind = text('operation_kind');
  const runtimePhase = text('runtime_phase');
  const platformKind = text('platform_kind');
  const predecessorState = text('predecessor_state');
  const resultingState = text('resulting_state');
  if (
    ![
      'legacy_expand',
      'fresh_enforce',
      'enforce',
      'recover_runtime_after_enforce_failure',
      'rollback_to_recorded_expand',
    ].includes(operationKind) ||
    !['expand', 'enforce'].includes(runtimePhase) ||
    !['helm', 'compose'].includes(platformKind) ||
    !['fresh_pending', 'legacy_pending', 'expanded', 'enforced'].includes(predecessorState) ||
    !['fresh_pending', 'legacy_pending', 'expanded', 'enforced'].includes(resultingState)
  )
    throw new Error('TENANT_CUTOVER_OWNER_CURRENT_INVALID');
  return {
    installationUuid: text('installation_uuid'),
    operationVersion: text('operation_version'),
    predecessorStateVersion: text('predecessor_state_version'),
    resultingStateVersion: text('resulting_state_version'),
    predecessorState: predecessorState as Task1LifecycleOperation['predecessorState'],
    resultingState: resultingState as Task1LifecycleOperation['resultingState'],
    operationKind: operationKind as Task1LifecycleOperation['operationKind'],
    runtimePhase: runtimePhase as Task1LifecycleOperation['runtimePhase'],
    platformKind: platformKind as Task1LifecycleOperation['platformKind'],
    previousBindingJcs: nullableText('previous_binding_jcs'),
    previousBindingSha256: nullableText('previous_binding_sha256'),
    requestedBindingJcs: text('requested_binding_jcs'),
    requestedBindingSha256: text('requested_binding_sha256'),
    previousConfigurationJcs: nullableText('previous_configuration_jcs'),
    previousConfigurationSha256: nullableText('previous_configuration_sha256'),
    requestedConfigurationJcs: text('requested_configuration_jcs'),
    requestedConfigurationSha256: text('requested_configuration_sha256'),
    previousBusinessConfigurationSha256: nullableText('previous_business_configuration_sha256'),
    requestedBusinessConfigurationSha256: text('requested_business_configuration_sha256'),
    originBindingSha256: text('origin_binding_sha256'),
    databasePeerBindingSha256: text('database_peer_binding_sha256'),
    proofKeySha256: text('proof_key_sha256'),
    descriptorSet,
    predecessorEvidenceJcs: text('predecessor_evidence_jcs'),
    predecessorEvidenceSha256: text('predecessor_evidence_sha256'),
    predecessorProof: text('predecessor_evidence_sha256'),
    result: 'committed',
  };
}

function restoreEvidenceFromProof(
  operation: Task1LifecycleOperation,
  proof: { jcs: string; sha256: string; sequence?: string | number },
): Task1HelmRestoreEvidence | undefined {
  if (operation.platformKind !== 'helm') return undefined;
  if (!isTask1RolloutProofForOperation(operation, proof.jcs, proof.sha256)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(proof.jcs);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  if ((parsed as Record<string, unknown>).proofSequence !== String(proof.sequence ?? '')) {
    return undefined;
  }
  const platformArtifact = (parsed as Record<string, unknown>).platformArtifact;
  if (
    !platformArtifact ||
    typeof platformArtifact !== 'object' ||
    Array.isArray(platformArtifact)
  ) {
    return undefined;
  }
  const artifact = platformArtifact as Record<string, unknown>;
  const binding = JSON.parse(operation.requestedBindingJcs) as Record<string, unknown>;
  const objects = Array.isArray(artifact.objects) ? artifact.objects : [];
  const secretFreeObjects = objects.every((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const object = value as Record<string, unknown>;
    const identity = object.identity;
    const comparator = object.comparator;
    if (
      !identity ||
      typeof identity !== 'object' ||
      Array.isArray(identity) ||
      !comparator ||
      typeof comparator !== 'object' ||
      Array.isArray(comparator)
    )
      return false;
    const identityRecord = identity as Record<string, unknown>;
    const comparatorRecord = comparator as Record<string, unknown>;
    if (comparatorRecord.format !== 'kubernetes-field-comparator/v1') return false;
    if (identityRecord.kind !== 'Secret') return true;
    const comparatorKeys = Object.keys(comparatorRecord).sort();
    const expectedKeys = ['dataKeys', 'format', 'immutable', 'metadata', 'type'];
    const dataKeys = comparatorRecord.dataKeys;
    return (
      comparatorKeys.length === expectedKeys.length &&
      comparatorKeys.every((key, index) => key === expectedKeys[index]) &&
      Array.isArray(dataKeys) &&
      dataKeys.every((key) => typeof key === 'string') &&
      new Set(dataKeys).size === dataKeys.length &&
      [...dataKeys].sort().every((key, index) => key === dataKeys[index])
    );
  });
  const hooks = Array.isArray(artifact.hooks) ? artifact.hooks : [];
  const secretFreeHooks = hooks.every((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const hook = value as Record<string, unknown>;
    const keys = Object.keys(hook).sort();
    return (
      keys.length === 2 &&
      keys[0] === 'deletePolicies' &&
      keys[1] === 'identity' &&
      Array.isArray(hook.deletePolicies) &&
      hook.deletePolicies.every((policy) => typeof policy === 'string')
    );
  });
  const rendererInput = artifact.rendererInput;
  const rendererKeys =
    rendererInput && typeof rendererInput === 'object' && !Array.isArray(rendererInput)
      ? Object.keys(rendererInput).sort()
      : [];
  const rendererRecord =
    rendererInput && typeof rendererInput === 'object' && !Array.isArray(rendererInput)
      ? (rendererInput as Record<string, unknown>)
      : {};
  const rendererValues = rendererRecord.values;
  const rendererSecretReferences = Array.isArray(rendererRecord.secretReferences)
    ? rendererRecord.secretReferences
    : [];
  const secretReferenceKeys = rendererSecretReferences.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const reference = value as Record<string, unknown>;
    const keys = Object.keys(reference).sort();
    if (
      keys.length !== 4 ||
      keys[0] !== 'apiVersion' ||
      keys[1] !== 'kind' ||
      keys[2] !== 'name' ||
      keys[3] !== 'namespace' ||
      reference.apiVersion !== 'v1' ||
      reference.kind !== 'Secret' ||
      typeof reference.namespace !== 'string' ||
      reference.namespace.length === 0 ||
      typeof reference.name !== 'string' ||
      reference.name.length === 0
    ) {
      return undefined;
    }
    return JSON.stringify(reference);
  });
  const typedRendererInput =
    rendererKeys.length === 3 &&
    rendererKeys[0] === 'format' &&
    rendererKeys[1] === 'secretReferences' &&
    rendererKeys[2] === 'values' &&
    rendererRecord.format === 'helm-renderer-input-projection/v1' &&
    rendererValues !== null &&
    typeof rendererValues === 'object' &&
    !Array.isArray(rendererValues) &&
    Array.isArray(rendererRecord.secretReferences) &&
    secretReferenceKeys.every((key) => key !== undefined) &&
    new Set(secretReferenceKeys).size === secretReferenceKeys.length &&
    [...secretReferenceKeys].sort().every((key, index) => key === secretReferenceKeys[index]);
  if (
    artifact.format !== 'helm-release-projection/v1' ||
    artifact.namespace !== binding.namespace ||
    artifact.releaseName !== binding.releaseName ||
    artifact.chartContentSha256 !== binding.chartContentSha256 ||
    typeof artifact.revision !== 'string' ||
    !/^[1-9][0-9]*$/.test(artifact.revision) ||
    !Array.isArray(artifact.objects) ||
    !secretFreeObjects ||
    !Array.isArray(artifact.hooks) ||
    !secretFreeHooks ||
    !typedRendererInput ||
    typeof (parsed as Record<string, unknown>).platformArtifactSha256 !== 'string' ||
    canonicalBootstrapSha256(artifact) !==
      (parsed as Record<string, unknown>).platformArtifactSha256
  ) {
    return undefined;
  }
  return {
    revision: artifact.revision,
    releaseProjection: artifact,
    releaseProjectionSha256: (parsed as Record<string, unknown>).platformArtifactSha256 as string,
  };
}

export async function currentTask1Operation(pool: Pool): Promise<{
  operation: Task1LifecycleOperation | undefined;
  predecessor?: Task1LifecycleOperation;
  proven: boolean;
  restoreEvidence?: Task1HelmRestoreEvidence;
}> {
  const tables = await pool.query<{ state_table: string | null; operation_table: string | null }>(`
    SELECT pg_catalog.to_regclass('public.commander_tenant_cutover_state')::text AS state_table,
           pg_catalog.to_regclass('public.commander_tenant_cutover_operations')::text AS operation_table
  `);
  const tableState = tables.rows[0];
  if (!tableState?.state_table && !tableState?.operation_table) {
    return { operation: undefined, proven: false };
  }
  if (!tableState?.state_table || !tableState.operation_table) {
    throw new Error('TENANT_CUTOVER_OWNER_CURRENT_INVALID');
  }
  const result = await pool.query<{
    operation: Record<string, unknown> | null;
    predecessor: Record<string, unknown> | null;
    proofs: Array<{ jcs: string; sha256: string; sequence?: string | number }>;
  }>(`
    SELECT pg_catalog.to_jsonb(operation) AS operation,
           pg_catalog.to_jsonb(predecessor) AS predecessor,
           COALESCE((
             SELECT pg_catalog.jsonb_agg(
                      pg_catalog.jsonb_build_object(
                        'jcs', proof.rollout_proof_jcs,
                        'sha256', proof.rollout_proof_sha256,
                        'sequence', proof.proof_sequence
                      )
                      ORDER BY proof.proof_sequence
                    )
               FROM public.commander_tenant_cutover_rollout_proofs AS proof
              WHERE proof.installation_uuid = operation.installation_uuid
                AND proof.operation_version = operation.operation_version
           ), '[]'::jsonb) AS proofs
      FROM public.commander_tenant_cutover_state AS state
      LEFT JOIN public.commander_tenant_cutover_operations AS operation
        ON operation.installation_uuid = state.installation_uuid
       AND operation.operation_version = state.current_runtime_operation_version
      LEFT JOIN public.commander_tenant_cutover_operations AS predecessor
        ON predecessor.installation_uuid = operation.installation_uuid
       AND predecessor.operation_version = operation.predecessor_state_version
     WHERE state.singleton = true
  `);
  if ((result.rowCount ?? result.rows.length) > 1) {
    throw new Error('TENANT_CUTOVER_OWNER_CURRENT_INVALID');
  }
  const row = result.rows[0];
  if (!row?.operation) return { operation: undefined, proven: false };
  if (!Array.isArray(row.proofs)) throw new Error('TENANT_CUTOVER_OWNER_CURRENT_INVALID');
  const operation = operationFromDatabaseRow(row.operation);
  const predecessor = row.predecessor ? operationFromDatabaseRow(row.predecessor) : undefined;
  const validProofs = row.proofs.filter(
    (proof) =>
      proof &&
      typeof proof.jcs === 'string' &&
      typeof proof.sha256 === 'string' &&
      isTask1RolloutProofForOperation(operation, proof.jcs, proof.sha256),
  );
  const proven = validProofs.length > 0;
  const latestValidProof = [...validProofs]
    .filter((proof) => /^[1-9][0-9]*$/.test(String(proof.sequence ?? '')))
    .sort((left, right) =>
      BigInt(String(left.sequence)) < BigInt(String(right.sequence)) ? 1 : -1,
    )[0];
  const restoreEvidence = latestValidProof
    ? restoreEvidenceFromProof(operation, latestValidProof)
    : undefined;
  return { operation, predecessor, proven, restoreEvidence };
}

/** Testable owner-mode dispatcher. Only this adapter turns a command mode into durable ledger work. */
export async function runTask1OwnerMode(
  mode: Task1OwnerCommandMode,
  stdin: string,
  pool: Pool,
  proof: {
    proveCurrent?(operation: Task1LifecycleOperation): Promise<Task1RolloutProofReceipt>;
    challengeCurrent?(
      operation: Task1LifecycleOperation,
    ): Promise<Task1RecoveryPredecessorChallenge | { status: 'absent' }>;
    verifyRecoveryPredecessor?(
      operation: Task1LifecycleOperation,
    ): Promise<Task1RecoveryPredecessorChallenge | { status: 'absent' }>;
  } = {},
): Promise<Record<string, unknown>> {
  const prepared =
    mode === 'tenant-cutover-append'
      ? await atOwnerMigrationFailureStage('input', async () => parseTask1OwnerCommandInput(stdin))
      : undefined;
  if (prepared) await runTask1OwnerAppendBootstrap(pool, prepared);
  const ledger = new Task1LifecycleLedger(
    new PostgresTask1LifecycleOwnerTransactions(pool, {
      initialize: prepared
        ? (client) =>
            atOwnerMigrationFailureStage('lifecycle_initialize', () =>
              initializeTask1LifecycleBoundary({ client, prepared }),
            )
        : undefined,
      applyTransition: ({ client, operation }) =>
        atOwnerMigrationFailureStage('lifecycle_transaction', () =>
          applyTask1ClosureDescriptorSet(client, operation.descriptorSet),
        ),
    }),
  );
  return atOwnerMigrationFailureStage('input', () =>
    runTask1OwnerCommand(mode, stdin, {
      execute: (request) =>
        atOwnerMigrationFailureStage('lifecycle_transaction', () =>
          ledger.execute({
            ...request,
            verifyCurrent: proof.challengeCurrent
              ? (operation) =>
                  atOwnerMigrationFailureStage('rollout_proof', () =>
                    proof.challengeCurrent!(operation),
                  )
              : undefined,
          }),
        ),
      current: () =>
        atOwnerMigrationFailureStage('current_read', () => currentTask1Operation(pool)),
      proveCurrent: proof.proveCurrent
        ? (operation) =>
            atOwnerMigrationFailureStage('rollout_proof', () => proof.proveCurrent!(operation))
        : undefined,
      verifyRecoveryPredecessor: proof.verifyRecoveryPredecessor
        ? (operation) =>
            atOwnerMigrationFailureStage('rollout_proof', () =>
              proof.verifyRecoveryPredecessor!(operation),
            )
        : undefined,
    }),
  );
}

export function createTask1ComposeProofRuntime(
  pool: Pool,
  env: NodeJS.ProcessEnv = process.env,
): Task1RolloutProofRuntime | undefined {
  const relayValues = [
    env.COMMANDER_COMPOSE_TOPOLOGY_RELAY_SOCKET,
    env.COMMANDER_COMPOSE_TOPOLOGY_RELAY_ATTEMPT,
    env.COMMANDER_COMPOSE_TOPOLOGY_RELAY_TOKEN,
  ];
  if (relayValues.every((value) => value === undefined)) return undefined;
  if (relayValues.some((value) => !value)) throw new Error('TENANT_CUTOVER_PROOF_RELAY_REQUIRED');
  const observer = createTask1ComposePlatformObserver(
    createTask1ComposeRelayClientFromEnvironment(env),
  );
  const caFile = env.COMMANDER_TENANT_AUTHORITY_PROOF_CA_FILE ?? '/run/commander/api-proof/ca.crt';
  return new Task1RolloutProofRuntime({
    transactions: new PostgresTask1RolloutProofTransactions(pool),
    observePlatform: observer,
    challengeApi: async (input) =>
      requestTask1ReadinessChallenge({
        ...input,
        ca: await readTask1ProofCa(caFile),
      }),
  });
}

const KUBERNETES_PROOF_IDENTITY_TOKEN_FILE =
  '/var/run/secrets/commander.io/proof-api/identity-token';
const KUBERNETES_API_TOKEN_FILE = '/var/run/secrets/commander.io/proof-api/api-token';
const KUBERNETES_PROOF_CA_FILE = '/var/run/secrets/commander.io/proof-api/ca.crt';
const KUBERNETES_API_PROOF_CA_FILE = '/run/commander/api-proof-public/ca.crt';
const KUBERNETES_RELEASE_PROJECTION_FILE = '/run/commander/release-projection/projection.json';

export function createTask1KubernetesProofRuntime(
  pool: Pool,
  env: NodeJS.ProcessEnv = process.env,
): Task1RolloutProofRuntime | undefined {
  const enabled = env.COMMANDER_KUBERNETES_PROOF_RUNTIME;
  if (enabled === undefined) return undefined;
  const host = env.KUBERNETES_SERVICE_HOST;
  const rawPort = env.KUBERNETES_SERVICE_PORT_HTTPS;
  if (enabled !== '1' || !host || !rawPort || !/^[1-9][0-9]{0,4}$/.test(rawPort)) {
    throw new Error('TENANT_CUTOVER_KUBERNETES_CONFIGURATION_INVALID');
  }
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port > 65535) {
    throw new Error('TENANT_CUTOVER_KUBERNETES_CONFIGURATION_INVALID');
  }
  const readIdentityToken = async (): Promise<string> =>
    (await readFile(KUBERNETES_PROOF_IDENTITY_TOKEN_FILE, 'utf8')).trim();
  const readApiToken = async (): Promise<string> =>
    (await readFile(KUBERNETES_API_TOKEN_FILE, 'utf8')).trim();
  const api = createTask1KubernetesProofApi({
    hostname: host,
    port,
    readToken: readApiToken,
    readCa: () => readTask1ProofCa(KUBERNETES_PROOF_CA_FILE),
  });
  const observer = createTask1KubernetesProofObserver({
    api,
    readProjectedTokenIdentity: async () =>
      parseTask1ProjectedTokenIdentity(await readIdentityToken()),
    readReleaseProjection: async () => {
      const bytes = await readFile(KUBERNETES_RELEASE_PROJECTION_FILE, 'utf8');
      if (Buffer.byteLength(bytes, 'utf8') > 16 * 1024 * 1024 || !bytes.endsWith('\n')) {
        throw new Error('TENANT_CUTOVER_KUBERNETES_PROOF_INVALID');
      }
      const jcs = bytes.slice(0, -1);
      const parsed = JSON.parse(jcs) as unknown;
      if (canonicalBootstrapJson(parsed) !== jcs) {
        throw new Error('TENANT_CUTOVER_KUBERNETES_PROOF_INVALID');
      }
      return parsed;
    },
  });
  return new Task1RolloutProofRuntime({
    transactions: new PostgresTask1RolloutProofTransactions(pool),
    observePlatform: observer,
    challengeApi: async (input) =>
      requestTask1ReadinessChallenge({
        ...input,
        ca: await readTask1ProofCa(KUBERNETES_API_PROOF_CA_FILE),
      }),
  });
}

export function createTask1ProofRuntime(
  pool: Pool,
  env: NodeJS.ProcessEnv = process.env,
): Task1RolloutProofRuntime | undefined {
  const compose = createTask1ComposeProofRuntime(pool, env);
  const kubernetes = createTask1KubernetesProofRuntime(pool, env);
  if (compose && kubernetes) throw new Error('TENANT_CUTOVER_PROOF_PLATFORM_AMBIGUOUS');
  return compose ?? kubernetes;
}

function readStandardInput(): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      value += chunk;
    });
    process.stdin.once('end', () => resolve(value));
    process.stdin.once('error', reject);
  });
}

const TASK1_OWNER_INPUT_FILE = '/run/commander/tenant-cutover/request.json';
const TASK1_OWNER_INPUT_MAX_BYTES = 128 * 1024;

export async function readTask1OwnerInput(
  env: NodeJS.ProcessEnv = process.env,
  readStdin: () => Promise<string> = readStandardInput,
  readInputFile: (path: string, encoding: BufferEncoding) => Promise<string> = readFile,
): Promise<string> {
  const inputFile = env.COMMANDER_TENANT_CUTOVER_INPUT_FILE;
  const input =
    inputFile === undefined
      ? await readStdin()
      : inputFile === TASK1_OWNER_INPUT_FILE
        ? await readInputFile(inputFile, 'utf8')
        : (() => {
            throw new Error('TENANT_CUTOVER_INPUT_FILE_INVALID');
          })();
  if (Buffer.byteLength(input, 'utf8') > TASK1_OWNER_INPUT_MAX_BYTES) {
    throw new Error('TENANT_CUTOVER_INPUT_TOO_LARGE');
  }
  return input;
}

async function main() {
  let pool: Pool | undefined;
  const action = process.argv[2];
  const previousOwnerMigrationProgressReporter = ownerMigrationProgressReporter;
  ownerMigrationProgressReporter = (ownerStage) => {
    process.stderr.write(ownerMigrationProgressRecord(ownerStage) + '\n');
  };
  try {
    const activePool = await atOwnerMigrationFailureStage('owner_pool_configuration', async () => {
      const databaseUrl = resolveMigrationDatabaseUrl(process.env);
      if (!databaseUrl) throw new Error('COMMANDER_MIGRATION_FAILED');
      return createVerifiedPostgresPool(migrationPoolConfig(action, databaseUrl));
    });
    pool = activePool;
    if (isTask1OwnerCommandMode(action)) {
      const stdin = await atOwnerMigrationFailureStage('input', () => readTask1OwnerInput());
      const proofRuntime = await atOwnerMigrationFailureStage('proof_runtime', async () =>
        createTask1ProofRuntime(activePool, process.env),
      );
      const response = await runTask1OwnerMode(action, stdin, activePool, {
        proveCurrent: proofRuntime
          ? (operation) => proofRuntime.proveCurrent(operation)
          : undefined,
        challengeCurrent: proofRuntime
          ? (operation) => proofRuntime.challengeCurrent(operation)
          : undefined,
        verifyRecoveryPredecessor: proofRuntime
          ? (operation) => proofRuntime.challengeRecoveryPredecessor(operation)
          : undefined,
      });
      process.stdout.write(`${JSON.stringify(response)}\n`);
      return;
    }
    const closurePhase = parseTask1ClosureMigrationPhase(process.argv.slice(2), process.env);
    const adapterOpsPassword = resolveAdapterOpsPassword(process.env);
    if (adapterOpsPassword) {
      await ensureAdapterOpsLogin(activePool, adapterOpsPassword);
    }
    await runKernelMigrations(activePool, { requiredRole: 'owner' });
    if (closurePhase) {
      await runTask1ClosureMigrations(activePool, closurePhase);
      // The forward-migration list is gated on the canonical enforce closure
      // (a fresh install has not recorded it until the line above). Re-run the
      // pass so post-closure descriptors — notably the auth-persistence schema
      // the API requires at first boot — apply in the same job instead of
      // waiting for a second migration run.
      await runKernelMigrations(activePool, { requiredRole: 'owner' });
    }
    // Seed cell tenants so register_worker can admit worker LOGIN registrations.
    // Prefer COMMANDER_WORKER_ALLOWED_TENANTS; fall back to COMMANDER_WORKER_TENANTS.
    const tenants = parseAllowedTenantsEnv(
      process.env.COMMANDER_WORKER_ALLOWED_TENANTS ?? process.env.COMMANDER_WORKER_TENANTS,
    );
    if (closurePhase) await seedTask1AllowedTenants(activePool, tenants);
    if (tenants.length > 0) {
      await seedWorkerAllowedTenants(activePool, tenants);
      console.log(`Seeded commander_worker_allowed_tenants: ${tenants.join(',')}`);
      if (process.env.COMMANDER_ENABLE_DEMO_TICKET === '1') {
        await seedDemoTicketAllowlist(activePool, tenants);
        console.log(`Seeded demo ticket effect policy: ${tenants.join(',')}`);
      }
    }
    if (process.env.COMMANDER_ENABLE_DEMO_TICKET === '1') {
      await seedDemoApiKey(
        activePool,
        process.env.COMMANDER_API_KEY,
        process.env.COMMANDER_CELL_TENANT_ID,
      );
    }
    console.log(
      closurePhase
        ? `Task 1 ${closurePhase} migrations applied successfully`
        : 'Kernel migrations applied successfully',
    );
  } catch (error) {
    // Database errors can echo DSNs, bind values, or generated SQL. The lifecycle evidence uses
    // owner-side error codes; this general entrypoint never reflects exception text to its logs.
    console.error('Migration failed: ' + migrationFailureDiagnostic(error));
    process.exit(1);
  } finally {
    ownerMigrationProgressReporter = previousOwnerMigrationProgressReporter;
    await pool?.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  void main();
}
