import {
  createKernelRepository,
  createCapabilityAuthority,
  type CapabilityAuthority,
  type AdapterOpsCompensationTerminalEvidenceAuthority,
  type AdapterOpsEvidenceContextAuthority,
  type CompensationOutboxPort,
  type CompensationTokenProvider,
  type CompensationTokenContext,
  type OperationsReadiness,
} from '@praetor/kernel';
import {
  EffectBroker,
  canonicalRequestHash,
  createEvidenceSigner,
  isClassAEffectType,
  type AuditSink,
  type CapabilityTokenIssuer,
  type ConfiguredEvidenceSigner,
  type EffectKernelPort,
  type EffectBrokerOptions,
  type EvidenceRecord,
  type PolicyEvaluator,
} from '@praetor/effect-broker';
import {
  ActionAdapterRegistry,
  EnvAdapterCredentialProvider,
  createGitHubPullRequestCreateAdapter,
  createKubernetesDeploymentRollbackAdapter,
  createServiceNowIncidentCreateAdapter,
  type AdapterCompensateInput,
  type AdapterExecuteInput,
} from '@praetor/action-adapters';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cellTier, createEgressGatedFetch, parseEgressAllowlist } from './egress.js';
import {
  ReconciliationDaemon,
  DEFAULT_RECONCILE_QUERY_TIMEOUT_MS,
} from './reconciliationDaemon.js';
import { CompensationDaemon } from './compensationDaemon.js';

const ADAPTER_ROUTING_POLICY_SNAPSHOT_ID = 'adapter-ops-v1';

export type AdapterOpsLogicalRole = 'reconcile' | 'compensation';

/** Demo fallback identities. Production identities are derived from the instance id. */
export const ADAPTER_OPS_RECONCILE_WORKER_ID = 'reconcile:local';

export const ADAPTER_OPS_COMPENSATION_WORKER_ID = 'compensation:local';

/** Runtime DSN / session uses owner or migration LOGIN — refuse before egress. */
export const OWNER_DATABASE_ROLE_REJECTED = 'OWNER_DATABASE_ROLE_REJECTED';

/** Durable replay/revocation stores missing from authority or kernel repository. */
export const CAPABILITY_DURABLE_STORES_REQUIRED = 'CAPABILITY_DURABLE_STORES_REQUIRED';

export const EVIDENCE_SIGNING_PRIVATE_KEY_PEM_ENV = 'COMMANDER_EVIDENCE_SIGNING_PRIVATE_KEY_PEM';

export const EVIDENCE_SIGNING_KEY_ID_ENV = 'COMMANDER_EVIDENCE_SIGNING_KEY_ID';

export function createAdapterOpsEvidenceSigner(
  env: NodeJS.ProcessEnv = process.env,
): ConfiguredEvidenceSigner | null {
  const privateKeyPem = env[EVIDENCE_SIGNING_PRIVATE_KEY_PEM_ENV]?.trim() ?? '';
  const keyId = env[EVIDENCE_SIGNING_KEY_ID_ENV]?.trim() ?? '';
  if (!privateKeyPem || !keyId) {
    // AO-09: the production signal set is `isProductionOrEnterprise()`, not
    // NODE_ENV alone. With NODE_ENV=development but COMMANDER_CELL_TIER=enterprise
    // (or the other enterprise signals) the old check silently produced a null
    // signer, dropping `requireEvidencePersistence` from the compensation broker
    // and only failing on the first tick.
    if (isProductionOrEnterprise(env)) throw new Error('EVIDENCE_SIGNING_KEY_REQUIRED');
    return null;
  }
  return createEvidenceSigner({ privateKeyPem, keyId });
}

/** Owner / migration LOGIN role — never accept for adapter-ops DSN. */
export const OWNER_MIGRATION_DATABASE_ROLES = new Set(['commander_owner']);

/** Scheduler LOGIN bypasses durable worker claim authz — forbidden for adapter-ops. */
export const SCHEDULER_DATABASE_ROLES = new Set(['commander_scheduler']);

export const ADAPTER_OPS_SCHEDULER_MODE_FORBIDDEN = 'ADAPTER_OPS_SCHEDULER_MODE_FORBIDDEN';

/** No silent "local" fallback — COMMANDER_CELL_TENANT_ID must be explicit for every tier. */
export const COMMANDER_CELL_TENANT_ID_REQUIRED = 'COMMANDER_CELL_TENANT_ID_REQUIRED';

export const WORKER_TENANT_SCOPE_REQUIRED = 'WORKER_TENANT_SCOPE_REQUIRED';

export const ADAPTER_OPS_INSTANCE_ID_REQUIRED = 'ADAPTER_OPS_INSTANCE_ID_REQUIRED';

export const CLAIM_SECRET_DIR_REQUIRED = 'CLAIM_SECRET_DIR_REQUIRED';

export const CLAIM_SECRET_FILE_INVALID = 'CLAIM_SECRET_FILE_INVALID';

export const ADAPTER_OPS_WORKER_ID_MISMATCH = 'ADAPTER_OPS_WORKER_ID_MISMATCH';

type AdapterOpsWorkerRegistration = {
  id: string;
  generation: number;
  claimSecret?: string;
};

export interface AdapterOpsWorkerRegistry {
  initialize(): Promise<void>;
  register(
    role: AdapterOpsLogicalRole,
    instanceId: string,
    tenantIds: string[],
    previousClaimSecret?: string,
  ): Promise<AdapterOpsWorkerRegistration>;
  heartbeat(workerId: string, generation: number, claimSecret: string): Promise<void>;
  drain(workerId: string, generation: number, claimSecret: string): Promise<void>;
}

type AdapterOpsRegistryPool = {
  connect(): Promise<{
    query<T = Record<string, unknown>>(
      sql: string,
      values?: readonly unknown[],
    ): Promise<{ rows: T[] }>;
    release(): void;
  }>;
};

export function resolveAdapterOpsTenantScope(env: NodeJS.ProcessEnv = process.env): string[] {
  const tenantIds = (env.COMMANDER_WORKER_TENANTS ?? '')
    .split(',')
    .map((tenantId) => tenantId.trim())
    .filter(Boolean);
  if (tenantIds.length === 0 || tenantIds.includes('*')) {
    throw new Error(
      `${WORKER_TENANT_SCOPE_REQUIRED}: COMMANDER_WORKER_TENANTS must be a non-empty, explicit tenant list`,
    );
  }
  return tenantIds;
}

class PostgresAdapterOpsWorkerRegistry implements AdapterOpsWorkerRegistry {
  constructor(private readonly pool: AdapterOpsRegistryPool) {}

  async initialize(): Promise<void> {}

  async register(
    role: AdapterOpsLogicalRole,
    instanceId: string,
    tenantIds: string[],
    previousClaimSecret?: string,
  ): Promise<AdapterOpsWorkerRegistration> {
    if (tenantIds.length === 0 || tenantIds.includes('*')) {
      throw new Error(
        `${WORKER_TENANT_SCOPE_REQUIRED}: daemon registration requires explicit tenantIds`,
      );
    }
    const client = await this.pool.connect();
    try {
      const result = await client.query<{
        register_adapter_ops_worker: {
          id: string;
          generation: number | string;
          claim_secret?: string;
        } | null;
      }>(
        `SELECT register_adapter_ops_worker(
           $1::text, $2::text, $3::jsonb, $4::text
         ) AS register_adapter_ops_worker`,
        [role, instanceId, JSON.stringify(tenantIds), previousClaimSecret ?? null],
      );
      const registered = result.rows[0]?.register_adapter_ops_worker;
      if (!registered?.claim_secret) {
        throw new Error(`WORKER_CLAIM_SECRET_REGISTER_FAILED: role=${role}`);
      }
      return {
        id: registered.id,
        generation: Number(registered.generation),
        claimSecret: registered.claim_secret,
      };
    } finally {
      client.release();
    }
  }

  async heartbeat(workerId: string, generation: number, claimSecret: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<{ heartbeat_adapter_ops_worker: unknown | null }>(
        `SELECT heartbeat_adapter_ops_worker($1::text, $2::bigint, $3::text)
           AS heartbeat_adapter_ops_worker`,
        [workerId, generation, claimSecret],
      );
      if (result.rows[0]?.heartbeat_adapter_ops_worker == null) {
        throw Object.assign(new Error('adapter-ops heartbeat was rejected'), {
          code: 'ADAPTER_OPS_HEARTBEAT_REJECTED',
        });
      }
    } finally {
      client.release();
    }
  }

  async drain(workerId: string, generation: number, claimSecret: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<{ drain_adapter_ops_worker: boolean }>(
        `SELECT drain_adapter_ops_worker($1::text, $2::bigint, $3::text)
           AS drain_adapter_ops_worker`,
        [workerId, generation, claimSecret],
      );
      if (result.rows[0]?.drain_adapter_ops_worker !== true) {
        throw Object.assign(new Error('adapter-ops drain was rejected'), {
          code: 'ADAPTER_OPS_DRAIN_REJECTED',
        });
      }
    } finally {
      client.release();
    }
  }
}

export function resolveAdapterOpsInstanceId(env: NodeJS.ProcessEnv = process.env): string {
  const instanceId = env.COMMANDER_ADAPTER_OPS_INSTANCE_ID?.trim();
  if (instanceId) {
    if (!/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/.test(instanceId)) {
      throw new Error(`${ADAPTER_OPS_INSTANCE_ID_REQUIRED}: invalid instance id`);
    }
    return instanceId;
  }
  if (
    env.COMMANDER_CELL_TIER === 'demo' ||
    (!env.COMMANDER_CELL_TIER && env.COMMANDER_KERNEL_BACKEND === 'sqlite')
  ) {
    return 'local';
  }
  throw new Error(`${ADAPTER_OPS_INSTANCE_ID_REQUIRED}: set COMMANDER_ADAPTER_OPS_INSTANCE_ID`);
}

function adapterOpsWorkerId(role: AdapterOpsLogicalRole, instanceId: string): string {
  return `${role}:${instanceId}`;
}

function claimSecretPath(directory: string, workerId: string): string {
  return join(directory, `${encodeURIComponent(workerId)}.claim-secret`);
}

async function readPersistedClaimSecret(
  directory: string,
  workerId: string,
): Promise<string | undefined> {
  const path = claimSecretPath(directory, workerId);
  try {
    const metadata = await stat(path);
    if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600) {
      throw new Error(`${CLAIM_SECRET_FILE_INVALID}: ${workerId}`);
    }
    const raw = await readFile(path, 'utf8');
    const secret = raw.trim();
    if (raw !== secret || !/^[A-Za-z0-9_-]{32,256}$/.test(secret)) {
      throw new Error(`${CLAIM_SECRET_FILE_INVALID}: ${workerId}`);
    }
    return secret;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

async function persistClaimSecret(
  directory: string,
  workerId: string,
  claimSecret: string,
): Promise<void> {
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(claimSecret)) {
    throw new Error(`${CLAIM_SECRET_FILE_INVALID}: ${workerId}`);
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = claimSecretPath(directory, workerId);
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, claimSecret, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function isProductionOrEnterprise(env: NodeJS.ProcessEnv = process.env): boolean {
  // AUDIT-F3: COMMANDER_ENV joins the signal set (kernel treats it as
  // authoritative); REQUIRE_WORKLOAD_BINDING=1 is also honored so the
  // hollow-PEP gate cannot be skipped by signal fragmentation. The evidence
  // signer uses this same predicate (AO-09).
  return (
    env.NODE_ENV === 'production' ||
    env.COMMANDER_ENV === 'production' ||
    env.COMMANDER_PROFILE === 'enterprise' ||
    env.COMMANDER_CELL_TIER === 'enterprise' ||
    env.COMMANDER_REQUIRE_WORKLOAD_BINDING === '1'
  );
}

/** Extract LOGIN username from a postgres DSN userinfo (null if not a postgres URL). */
export function databaseUrlLoginRole(dsn: string): string | null {
  const m = dsn.match(/^(?:postgres|postgresql):\/\/([^:/?@]+)(?::[^@]*)?@/i);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}

/**
 * Reject owner/migration credentials in the connection URL userinfo.
 * Task 1 `worker-url` (`commander_worker`) must pass — no false positive.
 */
export function assertNonOwnerDatabaseUrl(dsn: string): void {
  const role = databaseUrlLoginRole(dsn);
  if (role === null) return;
  if (role !== 'commander_adapter_ops') {
    throw new Error(
      `${OWNER_DATABASE_ROLE_REJECTED}: database URL userinfo role '${role}' is forbidden ` +
        '(adapter-ops must use commander_adapter_ops LOGIN).',
    );
  }
}

/** Reject any post-connect role other than the dedicated adapter-ops LOGIN. */
export function assertNonOwnerDatabaseRole(currentUser: string): void {
  const role = currentUser.trim();
  if (role !== 'commander_adapter_ops') {
    throw new Error(
      `${OWNER_DATABASE_ROLE_REJECTED}: session current_user '${role}' is forbidden ` +
        '(adapter-ops must authenticate as commander_adapter_ops).',
    );
  }
}

/**
 * Adapter-ops must never run kernel schedulerMode (BYPASSRLS / skip claim secret).
 * Fail-closed if COMMANDER_KERNEL_SCHEDULER_MODE=1 is present in the process env.
 */
export function assertAdapterOpsSchedulerModeForbidden(env: NodeJS.ProcessEnv = process.env): void {
  if (env.COMMANDER_KERNEL_SCHEDULER_MODE === '1') {
    throw new Error(
      `${ADAPTER_OPS_SCHEDULER_MODE_FORBIDDEN}: COMMANDER_KERNEL_SCHEDULER_MODE=1 is forbidden ` +
        'for adapter-ops (would bypass durable reconcile claim authz).',
    );
  }
}

type CapabilityStoreRepository = {
  consumeCapabilityReplay?: unknown;
  isCapabilityRevoked?: unknown;
  revokeCapability?: unknown;
};

/**
 * Production EffectBroker options require durable replay + revocations from the
 * Task 3 factory (non-optional). Also verifies kernel repository methods exist.
 */
export function assertDurableCapabilityStores(
  capability: Pick<CapabilityAuthority, 'revocations' | 'replayForTenant'>,
  repository: CapabilityStoreRepository,
): void {
  if (!capability.revocations) {
    throw new Error(
      `${CAPABILITY_DURABLE_STORES_REQUIRED}: createCapabilityAuthority did not provide revocations`,
    );
  }
  if (typeof capability.replayForTenant !== 'function') {
    throw new Error(
      `${CAPABILITY_DURABLE_STORES_REQUIRED}: createCapabilityAuthority did not provide replayForTenant`,
    );
  }
  if (
    typeof capability.revocations.isRevoked !== 'function' ||
    typeof capability.revocations.revoke !== 'function'
  ) {
    throw new Error(
      `${CAPABILITY_DURABLE_STORES_REQUIRED}: revocations must expose isRevoked/revoke`,
    );
  }
  const replay = capability.replayForTenant('__assert_durable_probe__');
  if (!replay || typeof replay.consume !== 'function') {
    throw new Error(
      `${CAPABILITY_DURABLE_STORES_REQUIRED}: replayForTenant() must return a store with consume()`,
    );
  }
  if (typeof repository.consumeCapabilityReplay !== 'function') {
    throw new Error(
      `${CAPABILITY_DURABLE_STORES_REQUIRED}: kernel repository missing consumeCapabilityReplay`,
    );
  }
  if (typeof repository.isCapabilityRevoked !== 'function') {
    throw new Error(
      `${CAPABILITY_DURABLE_STORES_REQUIRED}: kernel repository missing isCapabilityRevoked`,
    );
  }
  if (typeof repository.revokeCapability !== 'function') {
    throw new Error(
      `${CAPABILITY_DURABLE_STORES_REQUIRED}: kernel repository missing revokeCapability`,
    );
  }
}

/** Build EffectBroker options with durable replay + revocations (non-optional).
 * Replay is the authority factory (no fixed tenant) — durable consume stays on
 * capability.verifier via grant.tenantId; options only assert wiring presence.
 */
export function productionCapabilityBrokerOptions(
  capability: CapabilityAuthority,
  localWorkerId: string,
  localWorkerGeneration?: number,
  evidenceSigner?: ConfiguredEvidenceSigner,
): EffectBrokerOptions & {
  replay: CapabilityAuthority['replayForTenant'];
  revocations: CapabilityAuthority['revocations'];
  requireDurableCapabilityStores: true;
  requireOperationsReadiness: true;
} {
  return {
    audience: capability.audience,
    requireRequestBinding: true,
    localWorkerId,
    ...(localWorkerGeneration !== undefined ? { localWorkerGeneration } : {}),
    requireDurableCapabilityStores: true,
    requireOperationsReadiness: true,
    replay: (tenantId: string) => capability.replayForTenant(tenantId),
    revocations: capability.revocations,
    evidenceSigner,
  };
}

type GovernedCompensationAuthorization = Parameters<CompensationTokenProvider>[0];
type DurableCompensationTokenContext = Extract<CompensationTokenContext, { authorization: object }>;
type LegacyCompensationTokenContext = Exclude<
  CompensationTokenContext,
  DurableCompensationTokenContext
>;

function isDurableCompensationTokenContext(
  value: CompensationTokenContext,
): value is DurableCompensationTokenContext {
  return 'authorization' in value && 'request' in value && 'forwardResponse' in value;
}

/** Mint a short-lived grant only from a validated persisted compensation authorization. */
export function issueCompensationCapabilityToken(input: {
  issuer: CapabilityTokenIssuer;
  authorization: GovernedCompensationAuthorization;
  workerId: string;
  workerGeneration: number;
  now?: Date;
  ttlMs?: number;
}): string {
  const source = input.authorization;
  const durable = isDurableCompensationTokenContext(source) ? source : null;
  const legacy: LegacyCompensationTokenContext | null = durable
    ? null
    : (source as LegacyCompensationTokenContext);
  const requestPayload = durable
    ? {
        originalEffectId: durable.request.originalEffectId,
        destination: durable.request.destination,
        forwardResponse: durable.forwardResponse,
        compensationPatch: durable.authorization.compensationPatch,
      }
    : legacy!.compensationRequest;
  const requestHash = canonicalRequestHash(requestPayload);
  const compensationEffectType = durable
    ? durable.authorization.compensationEffectType
    : legacy!.compensationEffectType;
  if (!isClassAEffectType(compensationEffectType)) {
    throw new Error('COMPENSATION_EFFECT_TYPE_INVALID');
  }
  if (legacy && requestHash !== legacy.requestHash) {
    throw new Error('COMPENSATION_REQUEST_HASH_MISMATCH');
  }
  const actionDigest = durable ? durable.authorization.actionDigest : legacy!.actionDigest;
  if (!/^[a-f0-9]{64}$/.test(actionDigest)) {
    throw new Error('COMPENSATION_ACTION_DIGEST_INVALID');
  }
  const ttlMs = input.ttlMs ?? 60_000;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new Error('COMPENSATION_CAPABILITY_TTL_INVALID');
  }
  const now = input.now ?? new Date();
  const authorizationExpiry = Date.parse(
    durable ? durable.authorization.expiresAt : legacy!.authorizationExpiresAt,
  );
  if (!Number.isFinite(authorizationExpiry) || authorizationExpiry <= now.getTime()) {
    throw new Error('COMPENSATION_AUTHORIZATION_EXPIRED');
  }
  const grant = {
    jti: randomUUID(),
    tenantId: durable ? durable.authorization.tenantId : legacy!.tenantId,
    runId: durable ? durable.request.compensationRunId : legacy!.compensationRunId,
    stepId: durable ? durable.request.compensationStepId : legacy!.compensationStepId,
    effectTypes: [compensationEffectType],
    expiresAt: new Date(Math.min(authorizationExpiry, now.getTime() + ttlMs)).toISOString(),
    requestHash,
    actionDigest,
    workloadId: input.workerId,
    workerId: input.workerId,
    workerGeneration: input.workerGeneration,
    policySnapshotId: durable ? durable.authorization.policySnapshotId : legacy!.policySnapshotId,
    policyDecisionId: durable ? durable.authorization.policyDecisionId : legacy!.policyDecisionId,
    authorizationId: durable ? durable.authorization.id : legacy!.authorizationId,
    requestId: durable ? durable.request.id : legacy!.requestId,
    adapterVersion: durable ? durable.authorization.adapterVersion : legacy!.adapterVersion,
    decisionEffect: durable ? durable.authorization.decision : legacy!.decisionEffect,
    approvalBinding: durable
      ? (durable.authorization.approvalBinding ?? null)
      : legacy!.approvalBinding,
    nonce: randomUUID(),
  };
  return input.issuer.issue(grant);
}

/**
 * Register reconcile + compensation daemon rows in commander_workers (no DDL).
 * The default adapter is a narrow client of the kernel-owned register_worker
 * SECURITY DEFINER RPC; adapter-ops does not depend on worker-plane runtime.
 */
export async function registerAdapterOpsDaemonWorkers(
  registry: AdapterOpsWorkerRegistry,
  tenantIds: string[],
  opts: {
    instanceId: string;
    claimSecretDir: string;
  },
): Promise<{
  reconcile: { id: string; generation: number; claimSecret: string };
  compensation: { id: string; generation: number; claimSecret: string };
}> {
  const reconcileWorkerId = adapterOpsWorkerId('reconcile', opts.instanceId);
  const compensationWorkerId = adapterOpsWorkerId('compensation', opts.instanceId);
  const reconcilePreviousClaimSecret = await readPersistedClaimSecret(
    opts.claimSecretDir,
    reconcileWorkerId,
  );
  const compensationPreviousClaimSecret = await readPersistedClaimSecret(
    opts.claimSecretDir,
    compensationWorkerId,
  );
  await registry.initialize();
  let reconcile: AdapterOpsWorkerRegistration | undefined;
  let compensation: AdapterOpsWorkerRegistration | undefined;
  try {
    reconcile = await registry.register(
      'reconcile',
      opts.instanceId,
      tenantIds,
      reconcilePreviousClaimSecret,
    );
    if (reconcile.id !== reconcileWorkerId) {
      throw new Error(
        `${ADAPTER_OPS_WORKER_ID_MISMATCH}: expected ${reconcileWorkerId}, received ${reconcile.id}`,
      );
    }
    if (!reconcile.claimSecret) {
      throw new Error('registerAdapterOpsDaemonWorkers: register must return claimSecret');
    }
    await persistClaimSecret(opts.claimSecretDir, reconcileWorkerId, reconcile.claimSecret);
    compensation = await registry.register(
      'compensation',
      opts.instanceId,
      tenantIds,
      compensationPreviousClaimSecret,
    );
    if (compensation.id !== compensationWorkerId) {
      throw new Error(
        `${ADAPTER_OPS_WORKER_ID_MISMATCH}: expected ${compensationWorkerId}, received ${compensation.id}`,
      );
    }
    if (!compensation.claimSecret) {
      throw new Error('registerAdapterOpsDaemonWorkers: register must return claimSecret');
    }
    await persistClaimSecret(opts.claimSecretDir, compensationWorkerId, compensation.claimSecret);
    return {
      reconcile: {
        id: reconcile.id,
        generation: reconcile.generation,
        claimSecret: reconcile.claimSecret,
      },
      compensation: {
        id: compensation.id,
        generation: compensation.generation,
        claimSecret: compensation.claimSecret,
      },
    };
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    for (const registered of [reconcile, compensation]) {
      if (!registered?.claimSecret) continue;
      try {
        await registry.drain(registered.id, registered.generation, registered.claimSecret);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        'adapter-ops registration failed and partial identity cleanup was incomplete',
      );
    }
    throw error;
  }
}

export interface AdapterOpsWiringOptions {
  /**
   * Test seam: inject the narrow worker-registration port. When set (or postgres pool is present),
   * both daemon identities are registered before daemons start.
   */
  workerRegistry?: AdapterOpsWorkerRegistry;
  /** Test/integration seam until KernelRepository exposes the governed Task 3 atomic port. */
  compensationAuthority?: CompensationOutboxPort;
}

export interface AdapterOpsWorkerIdentities {
  reconcile: { id: string; generation: number; claimSecret?: string };
  compensation: { id: string; generation: number; claimSecret?: string };
}

/**
 * Demo-only hollow PEP：仅本地/demo 可设 COMMANDER_ADAPTER_OPS_DEMO_OPEN=1，
 * 切换为 permit-all PolicyEvaluator；生产/enterprise 一律拒绝该 flag。
 */
function assertDemoOpenGate(): boolean {
  const demoOpen = process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN === '1';
  if (demoOpen && isProductionOrEnterprise()) {
    throw new Error(
      'ADAPTER_OPS_DEMO_OPEN_FORBIDDEN_IN_PRODUCTION: unset COMMANDER_ADAPTER_OPS_DEMO_OPEN for enterprise/production',
    );
  }
  return demoOpen;
}

function createAdapterExecutor(registry: ActionAdapterRegistry) {
  return {
    execute: async (input: {
      type: string;
      request: Record<string, unknown>;
      signal: AbortSignal;
      executionContext?: {
        tenantId?: string;
        effectId?: string;
        idempotencyKey?: string;
      };
    }) => {
      const adapter = registry.resolve(input.type);
      if (!adapter) throw new Error('UNREGISTERED_EFFECT_TYPE: ' + input.type);
      const ctx = input.executionContext;
      const idempotencyKey =
        typeof ctx?.idempotencyKey === 'string' && ctx.idempotencyKey.trim().length > 0
          ? ctx.idempotencyKey
          : String(input.request.idempotencyKey ?? '');
      if (!ctx?.tenantId || !ctx.effectId || !idempotencyKey)
        throw new Error('EFFECT_AUTHORIZATION_REQUIRED');
      const destination = String(input.request.destination ?? '');
      if (input.type.startsWith('compensate.')) {
        const compensateInput: AdapterCompensateInput = {
          tenantId: ctx.tenantId,
          effectId: ctx.effectId,
          originalEffectId: String(input.request.originalEffectId ?? ''),
          idempotencyKey,
          destination,
          forwardResponse: (input.request.forwardResponse as Record<string, unknown>) ?? {},
          compensationPatch: (input.request.compensationPatch as Record<string, unknown>) ?? {},
          signal: input.signal,
        };
        return adapter.compensate(compensateInput);
      }
      const executeInput: AdapterExecuteInput = {
        tenantId: ctx.tenantId,
        effectId: ctx.effectId,
        idempotencyKey,
        destination,
        args: (input.request.args as Record<string, unknown>) ?? {},
        signal: input.signal,
      };
      return adapter.execute(executeInput);
    },
  };
}

/** Fail-closed: 仅 ActionAdapterRegistry 已注册的 effect type 可通过。 */
function createRegistryPolicy(registry: ActionAdapterRegistry): PolicyEvaluator {
  return {
    evaluate: async ({ type }) => {
      const adapter = registry.resolve(type);
      if (!adapter) {
        return {
          effect: 'deny' as const,
          decisionId: 'adapter-ops-deny-unregistered',
          policySnapshotId: ADAPTER_ROUTING_POLICY_SNAPSHOT_ID,
          reason: 'unregistered effect type: ' + type,
        };
      }
      return {
        effect: 'allow' as const,
        decisionId: 'adapter-ops-allow:' + type,
        policySnapshotId: ADAPTER_ROUTING_POLICY_SNAPSHOT_ID,
        reason: 'registered adapter ' + adapter.descriptor.adapterId,
      };
    },
  };
}

function createGovernedCompensationPolicy(registry: ActionAdapterRegistry): PolicyEvaluator {
  return {
    evaluate: async ({ type, token }) => {
      const governed = token as typeof token & {
        policyDecisionId?: string;
        decisionEffect?: 'allow' | 'deny' | 'require_approval';
      };
      const adapter = registry.resolve(type);
      if (
        !adapter ||
        typeof governed.policyDecisionId !== 'string' ||
        governed.policyDecisionId.length === 0 ||
        typeof governed.policySnapshotId !== 'string' ||
        governed.policySnapshotId.length === 0 ||
        !['allow', 'deny', 'require_approval'].includes(String(governed.decisionEffect))
      ) {
        return {
          effect: 'deny' as const,
          decisionId: 'governed-compensation-invalid',
          policySnapshotId: governed.policySnapshotId ?? 'governed-compensation-invalid',
          reason: 'signed governed compensation fields are missing or invalid',
        };
      }
      return {
        effect: governed.decisionEffect === 'deny' ? ('deny' as const) : ('allow' as const),
        decisionId: governed.policyDecisionId,
        policySnapshotId: governed.policySnapshotId,
        reason: `persisted compensation authorization ${adapter.descriptor.adapterId}`,
      };
    },
  };
}

/** Demo hollow PEP：permit-all（仅 DEMO_OPEN=1 且非生产）。 */
function createHollowDemoPolicy(): PolicyEvaluator {
  return {
    evaluate: async ({ type }) => ({
      effect: 'allow' as const,
      decisionId: 'adapter-ops-demo-open:' + type,
      policySnapshotId: ADAPTER_ROUTING_POLICY_SNAPSHOT_ID,
      reason: 'COMMANDER_ADAPTER_OPS_DEMO_OPEN hollow PEP',
    }),
  };
}

/** Structured audit sink — never a silent no-op. */
function createStdoutAuditSink(): AuditSink {
  return {
    append: async (event) => {
      console.error(
        JSON.stringify({
          channel: 'adapter-ops-audit',
          ...event,
        }),
      );
    },
  };
}

function emitOpsLoopTelemetry(event: {
  type: 'ops_loop_tick_failed';
  loop: 'reconciliation' | 'compensation';
  errorCode: string;
  at: string;
}): void {
  console.error(JSON.stringify({ channel: 'adapter-ops-telemetry', ...event }));
}

function createProductionRegistry(
  credentials: EnvAdapterCredentialProvider,
  egressAllowlist: readonly string[],
  options: { allowEmptyAllowlist?: boolean } = {},
): ActionAdapterRegistry {
  const fetchImpl = createEgressGatedFetch(egressAllowlist, undefined, options);
  return new ActionAdapterRegistry([
    createGitHubPullRequestCreateAdapter({ credentials, fetch: fetchImpl }),
    createKubernetesDeploymentRollbackAdapter({ credentials, fetch: fetchImpl }),
    createServiceNowIncidentCreateAdapter({ credentials, fetch: fetchImpl }),
  ]);
}

export const COMPENSATION_AUTHORITY_UNAVAILABLE = 'COMPENSATION_AUTHORITY_UNAVAILABLE';

/** AO-08: production/enterprise adapter-ops without a durable worker registry. */
export const ADAPTER_OPS_DURABLE_CLAIM_AUTHORITY_REQUIRED =
  'ADAPTER_OPS_DURABLE_CLAIM_AUTHORITY_REQUIRED';

export const ADAPTER_OPS_EVIDENCE_AUTHORITY_UNAVAILABLE =
  'ADAPTER_OPS_EVIDENCE_AUTHORITY_UNAVAILABLE';

export const ADAPTER_OPS_COMPENSATION_TERMINAL_AUTHORITY_UNAVAILABLE =
  'ADAPTER_OPS_COMPENSATION_TERMINAL_AUTHORITY_UNAVAILABLE';

export function requireAdapterOpsEvidenceAuthority(
  value: unknown,
): AdapterOpsEvidenceContextAuthority {
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof (value as { getAdapterOpsEvidenceContext?: unknown }).getAdapterOpsEvidenceContext !==
      'function'
  ) {
    throw new Error(ADAPTER_OPS_EVIDENCE_AUTHORITY_UNAVAILABLE);
  }
  return value as AdapterOpsEvidenceContextAuthority;
}

export async function requireAdapterOpsEvidenceAuthorityAvailability(
  value: unknown,
): Promise<void> {
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof (value as { checkEvidenceRepositoryAvailability?: unknown })
      .checkEvidenceRepositoryAvailability !== 'function'
  ) {
    throw new Error(ADAPTER_OPS_EVIDENCE_AUTHORITY_UNAVAILABLE);
  }
  try {
    const availability = await (
      value as { checkEvidenceRepositoryAvailability(): Promise<{ ready: boolean }> }
    ).checkEvidenceRepositoryAvailability();
    if (!availability.ready) throw new Error(ADAPTER_OPS_EVIDENCE_AUTHORITY_UNAVAILABLE);
  } catch {
    throw new Error(ADAPTER_OPS_EVIDENCE_AUTHORITY_UNAVAILABLE);
  }
}

export function requireAdapterOpsCompensationTerminalEvidenceAuthority(
  value: unknown,
): AdapterOpsCompensationTerminalEvidenceAuthority {
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof (value as { completeCompensationEffectWithEvidence?: unknown })
      .completeCompensationEffectWithEvidence !== 'function' ||
    typeof (value as { failCompensationEffectWithEvidence?: unknown })
      .failCompensationEffectWithEvidence !== 'function'
  ) {
    throw new Error(ADAPTER_OPS_COMPENSATION_TERMINAL_AUTHORITY_UNAVAILABLE);
  }
  return value as AdapterOpsCompensationTerminalEvidenceAuthority;
}

const COMPENSATION_AUTHORITY_METHODS = [
  'claimCompensationWork',
  'parkCompensationUnknown',
  'finalizeCompensation',
] as const;

export function requireCompensationAuthority(value: unknown): CompensationOutboxPort {
  if (
    typeof value !== 'object' ||
    value === null ||
    COMPENSATION_AUTHORITY_METHODS.some(
      (method) => typeof (value as Record<string, unknown>)[method] !== 'function',
    )
  ) {
    throw new Error(
      `${COMPENSATION_AUTHORITY_UNAVAILABLE}: kernel repository must expose governed compensation claim and atomic disposition methods`,
    );
  }
  return value as CompensationOutboxPort;
}

/**
 * AO-07: parse a positive-integer env knob, failing closed. Previously the
 * daemon intervals, batch sizes and reconcile generation were built with a bare
 * `Number(...)`: `NaN`/`0`/negative slipped through, `setInterval(fn, NaN)`
 * fired every ~1ms, `batchSize<=0` claimed nothing forever, and
 * `pollIntervalMs*3` freshness made the loop permanently not-ready.
 */
export function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export async function createAdapterOpsWiring(options: AdapterOpsWiringOptions = {}): Promise<{
  reconciliation: ReconciliationDaemon;
  compensation: CompensationDaemon;
  ping: () => Promise<boolean>;
  operationsReadiness: () => Promise<OperationsReadiness>;
  safeStop: (reason: string) => Promise<void>;
  close: () => Promise<void>;
  /** 供测试断言：当前 PEP 是否为 demo hollow。 */
  demoOpenHollowPep: boolean;
  /** Registered (or sqlite fallback) daemon worker identities + generations. */
  workers: AdapterOpsWorkerIdentities;
  /**
   * When true, /ready must see claimSecret on both daemons. Set for any
   * non-demo tier (AO-08), so a wiring with no durable worker registry cannot
   * skip the readiness gate.
   */
  requiresDurableClaim: boolean;
  /** Compensation EffectBroker localWorkerId — must equal compensation-daemon. */
  compensationLocalWorkerId: string;
}> {
  const demoOpen = assertDemoOpenGate();
  const egressAllowlist = parseEgressAllowlist();
  const evidenceSigner = createAdapterOpsEvidenceSigner(process.env);

  // Owner/scheduler DSN + schedulerMode gates BEFORE kernel connect.
  assertAdapterOpsSchedulerModeForbidden(process.env);
  const dsn =
    process.env.COMMANDER_KERNEL_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim() || '';
  if (dsn) assertNonOwnerDatabaseUrl(dsn);
  const instanceId = resolveAdapterOpsInstanceId(process.env);

  // Force schedulerMode off even if env was mutated after the assert above.
  const handle = await createKernelRepository({
    env: { ...process.env, COMMANDER_KERNEL_SCHEDULER_MODE: '0' },
    adapterOpsMode: true,
  });
  const repository = handle.repository;
  // AO-10: once worker rows + claim-secret files exist, any later startup failure
  // must revoke them; the outer catch below drains whatever was registered.
  let lifecycleRegistry: AdapterOpsWorkerRegistry | undefined;
  let registeredReconcile: { id: string; generation: number; claimSecret: string } | undefined;
  let registeredCompensation: { id: string; generation: number; claimSecret: string } | undefined;
  try {
    if (handle.postgresPool) await requireAdapterOpsEvidenceAuthorityAvailability(repository);
    // AO-08: never substitute a throwing stub for the governed Task 3 compensation
    // port. A repository that cannot expose it cannot run adapter-ops, so this
    // fails at startup instead of producing a daemon that reports healthy and
    // then throws on every tick.
    const compensationRepository =
      options.compensationAuthority ?? requireCompensationAuthority(repository);

    // Post-connect owner-role gate before capability authority / egress registry.
    if (handle.postgresPool) {
      const client = await handle.postgresPool.connect();
      try {
        const identityRows = await client.query<{ role_name: string }>(
          'SELECT current_user::text AS role_name',
        );
        assertNonOwnerDatabaseRole(identityRows.rows[0]?.role_name ?? '');
      } finally {
        client.release();
      }
    }

    // Task 3 factory — never CapabilityTokenIssuer.generate() for production authority.
    const capability = createCapabilityAuthority(process.env, repository);
    assertDurableCapabilityStores(capability, repository);

    const cellTenantId = process.env.COMMANDER_CELL_TENANT_ID?.trim() ?? '';
    if (!cellTenantId) {
      throw new Error(
        `${COMMANDER_CELL_TENANT_ID_REQUIRED}: set COMMANDER_CELL_TENANT_ID (no silent "local" fallback)`,
      );
    }
    const credentials = EnvAdapterCredentialProvider.fromProcessEnv();
    // AO-05: an unset allowlist must not mean "allow any host". Only the explicitly
    // declared demo tier keeps the documented open behaviour; every other tier denies.
    const registry = createProductionRegistry(credentials, egressAllowlist, {
      allowEmptyAllowlist: cellTier() === 'demo',
    });
    const issuer = capability.issuer;
    const tokens = capability.verifier;
    const policy = demoOpen ? createHollowDemoPolicy() : createRegistryPolicy(registry);
    const audit = createStdoutAuditSink();
    const kernelPort = {
      admitEffect: (input: Parameters<typeof repository.admitEffect>[0]) =>
        repository.admitEffect(input),
      completeEffect: (
        effectId: string,
        tenantId: string,
        lease: Parameters<typeof repository.completeEffect>[2],
        response: Record<string, unknown>,
        actor: string,
      ) => repository.completeEffect(effectId, tenantId, lease, response, actor),
      completeEffectWithEvidence: (
        effectId: string,
        tenantId: string,
        lease: Parameters<typeof repository.completeEffectWithEvidence>[2],
        response: Record<string, unknown>,
        actor: string,
        evidence: EvidenceRecord,
      ) =>
        repository.completeEffectWithEvidence(effectId, tenantId, lease, response, actor, {
          ...evidence,
          body: Object.fromEntries(Object.entries(evidence.body)),
        }),
      failEffectWithEvidence: (
        input: Parameters<NonNullable<EffectKernelPort['failEffectWithEvidence']>>[0],
      ) =>
        repository.failEffectWithEvidence({
          ...input,
          evidence: {
            ...input.evidence,
            body: Object.fromEntries(Object.entries(input.evidence.body)),
          },
        }),
      markEffectCompletionUnknown: (
        input: Parameters<typeof repository.markEffectCompletionUnknown>[0],
      ) => repository.markEffectCompletionUnknown(input),
      failEffect: (input: Parameters<typeof repository.failEffect>[0]) =>
        repository.failEffect(input),
      getEffect: (effectId: string, tenantId: string) => repository.getEffect(effectId, tenantId),
      listEffectsForRun: (runId: string, tenantId: string) =>
        repository.listEffectsForRun(runId, tenantId),
      listEvents: (runId: string, tenantId: string) => repository.listEvents(runId, tenantId),
      reconcileEffect: (input: Parameters<typeof repository.reconcileEffect>[0]) =>
        repository.reconcileEffect(input),
      getOperationsReadiness: (tenantId: string) => repository.getOperationsReadiness(tenantId),
      isActionAllowed: async (_tenantId: string, action: string) =>
        demoOpen || registry.resolve(action) !== null,
    };
    const executor = createAdapterExecutor(registry);

    const reconcileWorkerId = adapterOpsWorkerId('reconcile', instanceId);
    const compensationWorkerId = adapterOpsWorkerId('compensation', instanceId);

    // AO-10: repository-only authority probes run before registration so a
    // missing evidence authority cannot leave ACTIVE worker rows behind.
    const evidenceAuthority = handle.postgresPool
      ? requireAdapterOpsEvidenceAuthority(repository)
      : undefined;
    const compensationTerminalAuthority = handle.postgresPool
      ? requireAdapterOpsCompensationTerminalEvidenceAuthority(repository)
      : undefined;

    // P0: register BOTH daemon identities before claim/admit (postgres or injected registry).
    // Fail-closed tenant scope matches worker-plane (COMMANDER_WORKER_TENANTS).
    let reconcileGeneration = positiveIntegerEnv('COMMANDER_RECONCILE_WORKER_GENERATION', 1);
    let compensationGeneration = 1;
    // AO-08: never fabricate a worker identity. Without a durable registry the
    // claim secrets stay unset (and /ready stays false for non-demo tiers)
    // instead of a randomUUID that matches no worker row but still looks like a
    // registered claim secret.
    let reconcileClaimSecret: string | undefined;
    let compensationClaimSecret: string | undefined;
    const mustRegister = Boolean(handle.postgresPool) || Boolean(options.workerRegistry);
    // AO-08: production/enterprise must run on durable claim authority.
    if (!mustRegister && isProductionOrEnterprise()) {
      throw new Error(
        `${ADAPTER_OPS_DURABLE_CLAIM_AUTHORITY_REQUIRED}: production/enterprise adapter-ops requires ` +
          'a durable worker registry (PostgreSQL pool or injected workerRegistry)',
      );
    }
    if (mustRegister) {
      const tenantIds = resolveAdapterOpsTenantScope(process.env);
      const claimSecretDir = process.env.COMMANDER_ADAPTER_OPS_CLAIM_SECRET_DIR?.trim();
      if (!claimSecretDir) {
        throw new Error(`${CLAIM_SECRET_DIR_REQUIRED}: set COMMANDER_ADAPTER_OPS_CLAIM_SECRET_DIR`);
      }
      lifecycleRegistry =
        options.workerRegistry ?? new PostgresAdapterOpsWorkerRegistry(handle.postgresPool!);
      const registered = await registerAdapterOpsDaemonWorkers(lifecycleRegistry, tenantIds, {
        instanceId,
        claimSecretDir,
      });
      registeredReconcile = registered.reconcile;
      registeredCompensation = registered.compensation;
      reconcileGeneration = registered.reconcile.generation;
      compensationGeneration = registered.compensation.generation;
      reconcileClaimSecret = registered.reconcile.claimSecret;
      compensationClaimSecret = registered.compensation.claimSecret;
    }
    const terminalEvidenceContext = (
      workerId: string,
      workerGeneration: number,
      claimSecret: string,
    ) =>
      evidenceAuthority
        ? {
            getTerminalEvidenceContext: (
              effectId: string,
              runId: string,
              tenantId: string,
              claimToken: string,
            ) =>
              evidenceAuthority.getAdapterOpsEvidenceContext({
                workerId,
                workerGeneration,
                claimSecret,
                tenantId,
                runId,
                effectId,
                claimToken,
              }),
          }
        : undefined;
    const reconcileEvidenceContext = terminalEvidenceContext(
      reconcileWorkerId,
      reconcileGeneration,
      reconcileClaimSecret ?? '',
    );
    const compensationEvidenceContext = terminalEvidenceContext(
      compensationWorkerId,
      compensationGeneration,
      compensationClaimSecret ?? '',
    );

    const compensationKernelPort = {
      ...kernelPort,
      compensationTerminalEvidenceRequired: Boolean(compensationTerminalAuthority),
      ...(compensationEvidenceContext ?? {}),
      admitEffect: (input: Parameters<typeof repository.admitEffect>[0]) =>
        input.compensationBinding
          ? repository.admitCompensationEffect({
              ...input,
              requestId: input.compensationBinding.requestId,
              requestClaimToken:
                input.compensationBinding.requestClaimToken ?? input.compensationBinding.claimToken,
              outboxMessageId: input.compensationBinding.outboxMessageId ?? '',
              outboxClaimToken:
                input.compensationBinding.outboxClaimToken ?? input.compensationBinding.claimToken,
            })
          : repository.admitEffect(input),
      ...(compensationTerminalAuthority
        ? {
            completeEffect: async () => {
              throw new Error(ADAPTER_OPS_COMPENSATION_TERMINAL_AUTHORITY_UNAVAILABLE);
            },
            completeEffectWithEvidence: undefined,
            failEffectWithEvidence: undefined,
            failEffect: undefined,
            listEffectsForRun: undefined,
            listEvents: undefined,
            completeCompensationEffectWithEvidence: (
              input: Parameters<
                NonNullable<EffectKernelPort['completeCompensationEffectWithEvidence']>
              >[0],
            ) =>
              compensationTerminalAuthority.completeCompensationEffectWithEvidence({
                workerId: compensationWorkerId,
                workerGeneration: compensationGeneration,
                claimSecret: compensationClaimSecret ?? '',
                tenantId: input.tenantId,
                runId: input.runId,
                stepId: input.stepId,
                effectId: input.effectId,
                requestId: input.claim.requestId,
                requestClaimToken: input.claim.requestClaimToken,
                outboxMessageId: input.claim.outboxMessageId,
                outboxClaimToken: input.claim.outboxClaimToken,
                lease: input.lease,
                response: input.response,
                actor: input.actor,
                evidence: {
                  ...input.evidence,
                  body: Object.fromEntries(Object.entries(input.evidence.body)),
                },
              }),
            failCompensationEffectWithEvidence: (
              input: Parameters<
                NonNullable<EffectKernelPort['failCompensationEffectWithEvidence']>
              >[0],
            ) =>
              compensationTerminalAuthority.failCompensationEffectWithEvidence({
                workerId: compensationWorkerId,
                workerGeneration: compensationGeneration,
                claimSecret: compensationClaimSecret ?? '',
                tenantId: input.tenantId,
                runId: input.runId,
                stepId: input.stepId,
                effectId: input.effectId,
                requestId: input.claim.requestId,
                requestClaimToken: input.claim.requestClaimToken,
                outboxMessageId: input.claim.outboxMessageId,
                outboxClaimToken: input.claim.outboxClaimToken,
                lease: input.lease,
                error: input.error,
                actor: input.actor,
                evidence: {
                  ...input.evidence,
                  body: Object.fromEntries(Object.entries(input.evidence.body)),
                },
              }),
          }
        : {}),
    };

    // Compensation path: broker affinity MUST match admit lease workerId (not adapter-ops-worker).
    const compensationBroker = new EffectBroker(
      tokens,
      createGovernedCompensationPolicy(registry),
      compensationKernelPort,
      executor,
      audit,
      {
        ...productionCapabilityBrokerOptions(
          capability,
          compensationWorkerId,
          compensationGeneration,
        ),
        ...(evidenceSigner ? { evidenceSigner, requireEvidencePersistence: true as const } : {}),
      },
    );
    // AO-07: validate every daemon knob before constructing the daemons; a
    // malformed interval/batch must be rejected, not silently become NaN/0.
    const reconcilePollIntervalMs = positiveIntegerEnv('COMMANDER_RECONCILE_INTERVAL_MS', 5_000);
    const reconcileBatchSize = positiveIntegerEnv('COMMANDER_RECONCILE_BATCH_SIZE', 50);
    const reconcileQueryTimeoutMs = positiveIntegerEnv(
      'COMMANDER_RECONCILE_QUERY_TIMEOUT_MS',
      DEFAULT_RECONCILE_QUERY_TIMEOUT_MS,
    );
    const compensationPollIntervalMs = positiveIntegerEnv(
      'COMMANDER_COMPENSATION_INTERVAL_MS',
      5_000,
    );
    const compensationBatchSize = positiveIntegerEnv('COMMANDER_COMPENSATION_BATCH_SIZE', 50);
    const reconciliation = new ReconciliationDaemon({
      repository,
      brokerFactory: () =>
        new EffectBroker(
          tokens,
          policy,
          kernelPort,
          {
            execute: async () => {
              throw new Error('reconcile must not execute writes');
            },
          },
          audit,
          productionCapabilityBrokerOptions(capability, reconcileWorkerId, reconcileGeneration),
        ),
      registry,
      pollIntervalMs: reconcilePollIntervalMs,
      batchSize: reconcileBatchSize,
      queryTimeoutMs: reconcileQueryTimeoutMs,
      workerId: reconcileWorkerId,
      workerGeneration: reconcileGeneration,
      claimSecret: reconcileClaimSecret ?? '',
      ...(reconcileEvidenceContext ? { terminalEvidenceContext: reconcileEvidenceContext } : {}),
      ...(evidenceSigner ? { evidenceSigner } : {}),
      heartbeat:
        lifecycleRegistry && reconcileClaimSecret
          ? () =>
              lifecycleRegistry!.heartbeat(
                reconcileWorkerId,
                reconcileGeneration,
                reconcileClaimSecret,
              )
          : undefined,
      drain:
        lifecycleRegistry && reconcileClaimSecret
          ? () =>
              lifecycleRegistry!.drain(reconcileWorkerId, reconcileGeneration, reconcileClaimSecret)
          : undefined,
      telemetry: emitOpsLoopTelemetry,
    });
    const compensation = new CompensationDaemon({
      repository: compensationRepository,
      evidenceRepository: repository,
      ...(compensationEvidenceContext
        ? { terminalEvidenceContext: compensationEvidenceContext }
        : {}),
      broker: compensationBroker,
      registry,
      tokenProvider: async (authorization) =>
        issueCompensationCapabilityToken({
          issuer,
          authorization,
          workerId: compensationWorkerId,
          workerGeneration: compensationGeneration,
        }),
      pollIntervalMs: compensationPollIntervalMs,
      batchSize: compensationBatchSize,
      workerId: compensationWorkerId,
      workerGeneration: compensationGeneration,
      claimSecret: compensationClaimSecret ?? '',
      ...(evidenceSigner ? { evidenceSigner } : {}),
      heartbeat:
        lifecycleRegistry && compensationClaimSecret
          ? () =>
              lifecycleRegistry!.heartbeat(
                compensationWorkerId,
                compensationGeneration,
                compensationClaimSecret,
              )
          : undefined,
      drain:
        lifecycleRegistry && compensationClaimSecret
          ? () =>
              lifecycleRegistry!.drain(
                compensationWorkerId,
                compensationGeneration,
                compensationClaimSecret,
              )
          : undefined,
      onFatalInvariant:
        lifecycleRegistry && reconcileClaimSecret && compensationClaimSecret
          ? async () => {
              const registry = lifecycleRegistry!;
              const reconcileSecret = reconcileClaimSecret!;
              const compensationSecret = compensationClaimSecret!;
              const drained = await Promise.allSettled([
                registry.drain(reconcileWorkerId, reconcileGeneration, reconcileSecret),
                registry.drain(compensationWorkerId, compensationGeneration, compensationSecret),
              ]);
              const failures = drained.flatMap((result) =>
                result.status === 'rejected' ? [result.reason] : [],
              );
              if (failures.length > 0) {
                throw new AggregateError(failures, 'adapter-ops authority drain failed');
              }
            }
          : undefined,
      audit,
      telemetry: emitOpsLoopTelemetry,
    });
    let safeStopPromise: Promise<void> | undefined;
    const safeStop = (reason: string): Promise<void> => {
      safeStopPromise ??= (async () => {
        const errors: unknown[] = [];
        // AO-01: stop the loops BEFORE draining their registrations. `stop()` clears the
        // poll timer and awaits the in-flight tick; draining first released the claim
        // while a tick could still be executing, so a concurrent instance could pick the
        // same effect up. `drain: false` only suppresses the daemon's *own* drain call —
        // the registry drain below is still performed, in the safe order.
        const stopped = await Promise.allSettled([
          reconciliation.stop({ drain: false }),
          compensation.stop({ drain: false }),
        ]);
        for (const result of stopped) {
          if (result.status === 'rejected') errors.push(result.reason);
        }
        if (lifecycleRegistry && reconcileClaimSecret && compensationClaimSecret) {
          const drained = await Promise.allSettled([
            lifecycleRegistry.drain(reconcileWorkerId, reconcileGeneration, reconcileClaimSecret),
            lifecycleRegistry.drain(
              compensationWorkerId,
              compensationGeneration,
              compensationClaimSecret,
            ),
          ]);
          for (const result of drained) {
            if (result.status === 'rejected') errors.push(result.reason);
          }
        }
        if (errors.length > 0) {
          throw new AggregateError(errors, `adapter-ops safe stop failed: ${reason}`);
        }
      })();
      return safeStopPromise;
    };
    return {
      reconciliation,
      compensation,
      ping: async () => {
        if (handle.postgresPool) {
          await handle.postgresPool.query('SELECT 1');
        } else {
          await repository.getOperationsReadiness(cellTenantId);
        }
        return true;
      },
      operationsReadiness: () => repository.getOperationsReadiness(cellTenantId),
      safeStop,
      demoOpenHollowPep: demoOpen,
      // AO-08: a non-demo cell requires durable claim authority even when no
      // registry was injected. Previously this was `mustRegister`, so the
      // no-registry path reported `false` and run.ts's readiness gate was
      // skipped entirely: a wiring with no registered identity (and therefore
      // zero claims) could still report ready. Demo is the only tier allowed to
      // run without durable claims.
      requiresDurableClaim: mustRegister || cellTier() !== 'demo',
      workers: {
        reconcile: {
          id: reconcileWorkerId,
          generation: reconcileGeneration,
          ...(reconcileClaimSecret ? { claimSecret: reconcileClaimSecret } : {}),
        },
        compensation: {
          id: compensationWorkerId,
          generation: compensationGeneration,
          ...(compensationClaimSecret ? { claimSecret: compensationClaimSecret } : {}),
        },
      },
      compensationLocalWorkerId: compensationWorkerId,
      close: async () => {
        await handle.close();
      },
    };
  } catch (error) {
    // AO-10: a startup failure after registration must revoke the identities it
    // created. `registerAdapterOpsDaemonWorkers` only cleans up failures inside
    // its own call; anything that throws afterwards used to leave ACTIVE worker
    // rows with valid claim secrets until heartbeat freshness expired.
    const cleanupErrors: unknown[] = [];
    if (lifecycleRegistry) {
      for (const registered of [registeredReconcile, registeredCompensation]) {
        if (!registered?.claimSecret) continue;
        try {
          await lifecycleRegistry.drain(
            registered.id,
            registered.generation,
            registered.claimSecret,
          );
        } catch (drainError) {
          cleanupErrors.push(drainError);
        }
      }
    }
    try {
      await handle.close();
    } catch (closeError) {
      cleanupErrors.push(closeError);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        'adapter-ops startup failed and cleanup was incomplete',
      );
    }
    throw error;
  }
}
