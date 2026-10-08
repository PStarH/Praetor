import { createHash, randomUUID } from 'node:crypto';
import type { KernelRepository } from './repository.js';
import { mustRefuseMissingAppRole } from './productionSignal.js';
import {
  assertEvidenceRecordBoundToEffect,
  type AdapterOpsCompensationTerminalEvidenceBinding,
  type AdapterOpsEvidenceContext,
  type AdapterOpsEvidenceContextRequest,
  type KernelEvidenceRecord,
  type KernelEvidenceSignature,
} from './evidenceRepository.js';
import type {
  AdmitEffectRequest,
  AdmitEffectResult,
  AnswerInteractionRequest,
  ClaimStepRequest,
  CompleteStepRequest,
  CreateInteractionRequest,
  CreateKernelRun,
  CreateTimerRequest,
  FailStepRequest,
  KernelDlqEntry,
  KernelEffect,
  KernelEvent,
  KernelInteraction,
  KernelLease,
  KernelOutboxMessage,
  KernelRun,
  KernelRunState,
  KernelStep,
  KernelStepState,
  KernelTimer,
  MarkEffectCompletionUnknownRequest,
  ParkEffectCompletionUnknownInput,
  ParkEffectCompletionUnknownResult,
  ReconcileEffectRequest,
  RequestReconcileInput,
  RequestReconcileResult,
  ClaimReconcileEffectsInput,
  ClaimedReconcileEffect,
  RescheduleReconcileInput,
  EscalateReconcileInput,
  ReconcileClaimAuth,
  ReconcileMutationResult,
  ReconcileQueryError,
  FailEffectRequest,
  RequestCompensationInput,
  RequestCompensationResult,
  CompensationAuthorizationRecord,
  KernelCompensationRequest,
  ClaimCompensationRequestInput,
  ClaimedCompensationRequest,
  FinalizeCompensationInput,
  ParkCompensationUnknownInput as ParkCompensationRequestUnknownInput,
  CompensationMutationResult,
  TenantExecutionControl,
  KillSwitch,
  KillSwitchMatchDims,
  PutKillSwitchInput,
  RemoveKillSwitchInput,
  OperationsReadiness,
} from './types.js';
import { KernelInvariantError, OPERATIONS_HEARTBEAT_TTL_MS } from './types.js';
import { isClassAEffectType } from '@praetor/contracts';
import {
  KERNEL_COMPENSATION_TOPIC,
  LEGACY_COMPENSATION_TOPIC,
  type ClaimedCompensationWork,
  type CompensationClaimAuth,
} from './ops/compensationConsumer.js';
import { findMatchingKillSwitchWithLookup } from './killSwitchMatching.js';
import { createReconcilePolicy } from './reconcilePolicy.js';
import { assertRunTransition, assertStepTransition } from './transitionValidation.js';
import {
  BEGIN_APP_TENANT_TRANSACTION_SQL,
  READ_APP_TENANT_TRANSACTION_TARGET_SQL,
  buildBindAppTenantContextQuery,
  buildCloseAppTenantContextQuery,
  buildIssueAppTenantContextQuery,
  buildSetLegacyTenantScopeQuery,
  type AppTenantTransactionTarget,
} from './task1TenantContext.js';

/** Minimal pg-compatible interfaces; callers can inject pg.Pool without a hard runtime coupling. */
export interface SqlQueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number | null;
}
export interface SqlClient {
  query<T = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<SqlQueryResult<T>>;
  release(error?: Error | boolean): void | Promise<void>;
}
export interface SqlPool {
  connect(): Promise<SqlClient>;
}

export interface TenantContextAuthority {
  issue(
    tenantId: string,
    target: AppTenantTransactionTarget,
  ): Promise<{ contextId: string; expiresAt: Date | string }>;
}

function unknownConnectionStateError(error: unknown): Error {
  return error instanceof Error ? error : new Error('POSTGRES_CONNECTION_STATE_UNKNOWN');
}

export class PostgresTenantContextAuthority implements TenantContextAuthority {
  constructor(private readonly pool: SqlPool) {}

  usesPool(pool: SqlPool): boolean {
    return this.pool === pool;
  }

  async issue(
    tenantId: string,
    target: AppTenantTransactionTarget,
  ): Promise<{
    contextId: string;
    expiresAt: Date | string;
  }> {
    const client = await this.pool.connect();
    let issued: { contextId: string; expiresAt: Date | string };
    try {
      const query = buildIssueAppTenantContextQuery(tenantId, target);
      const result = await client.query<{ context_id: string; expires_at: Date | string }>(
        query.text,
        query.values,
      );
      const row = result.rows[0];
      if (
        result.rowCount !== 1 ||
        !row ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          row.context_id,
        ) ||
        Number.isNaN(new Date(row.expires_at).getTime())
      ) {
        throw new Error('TENANT_CONTEXT_INVALID');
      }
      issued = { contextId: row.context_id, expiresAt: row.expires_at };
    } catch (error) {
      await client.release(unknownConnectionStateError(error));
      throw error;
    }
    await client.release();
    return issued;
  }
}

/**
 * Wrap a pool so privileged connections (migration owner / superuser) are
 * downgraded to the least-privilege `commander_app` role. This guarantees that
 * application queries are evaluated against the tenant isolation policies even
 * when the connection string still authenticates as the migration owner.
 *
 * When the connection is already a least-privilege runtime LOGIN
 * (`commander_app` or `commander_worker`), keep that identity — do NOT
 * `SET ROLE commander_app`. Workers authenticate as `commander_worker` and are
 * not members of `commander_app`; forcing SET ROLE would fail in real deploys.
 *
 * If the `commander_app` role does not exist (legacy / test environments) the
 * wrapper logs a warning once and continues without downgrading (privileged
 * connections only).
 */
function enforceAppRole(pool: SqlPool): SqlPool {
  let state: 'unchecked' | 'exists' | 'missing' = 'unchecked';
  let warned = false;

  /** Runtime roles that must keep their LOGIN identity (NOBYPASSRLS). */
  const KEEP_IDENTITY = new Set(['commander_app', 'commander_worker', 'commander_adapter_ops']);

  return {
    connect: async () => {
      const client = await pool.connect();
      // KC-02: every failure after a successful connect() must return the slot to
      // the pool exactly once. Identity lookup / SET ROLE failures used to leak
      // the client, and repeated failures could exhaust the pool while the
      // caller's withTransaction never saw the underlying handle.
      try {
        // Prefer session_user (LOGIN identity). Alias as login_role — never AS current_user /
        // AS session_user: node-pg row field names can collide with SQL keyword accessors.
        const identity = await client.query<{ login_role: string }>(
          'SELECT session_user::text AS login_role',
        );
        const loginRole = identity.rows[0]?.login_role;
        if (loginRole && KEEP_IDENTITY.has(loginRole)) {
          // Already least-privilege LOGIN (worker/app) — do not SET ROLE.
          return {
            query: client.query.bind(client),
            release: async (error?: Error | boolean) => {
              await client.release(error);
            },
          };
        }

        if (state === 'unchecked') {
          try {
            const result = await client.query<{ exists: boolean }>(
              "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commander_app') AS exists",
            );
            state = result.rows[0]?.exists ? 'exists' : 'missing';
          } catch {
            state = 'missing';
          }
        }

        if (state === 'exists') {
          try {
            await client.query('SET ROLE commander_app');
          } catch (err) {
            throw new Error(
              `PostgresKernelRepository failed to SET ROLE commander_app: ${(err as Error).message}`,
            );
          }
        } else if (state === 'missing') {
          // AUTH-7: without the commander_app downgrade, application queries run as
          // the (BYPASSRLS) migration owner and tenant isolation is silently off.
          // Fail closed in production rather than degrade to a cross-tenant read.
          // COMMANDER_ALLOW_RLS_BYPASS=1 is an explicit, documented escape hatch
          // for single-tenant/legacy deployments that intentionally lack the role.
          // AUDIT-K1: production is detected by the shared multi-signal check —
          // losing NODE_ENV alone must not silently re-enable the bypass.
          if (mustRefuseMissingAppRole(process.env)) {
            throw new Error(
              '[PostgresKernelRepository] commander_app role not found in production. ' +
                'Refusing to run application queries as the migration owner (RLS would be bypassed). ' +
                'Create the commander_app role, or set COMMANDER_ALLOW_RLS_BYPASS=1 to explicitly accept the risk.',
            );
          }
          if (!warned) {
            warned = true;
            console.warn(
              '[PostgresKernelRepository] commander_app role not found; continuing without role downgrade. ' +
                'Application queries may bypass RLS if connected as the migration owner.',
            );
          }
        }

        return {
          query: client.query.bind(client),
          release: async (error?: Error | boolean) => {
            if (error) {
              await client.release(error);
              return;
            }
            if (state === 'exists') {
              try {
                await client.query('SET ROLE NONE');
              } catch (resetError) {
                await client.release(unknownConnectionStateError(resetError));
                return;
              }
            }
            await client.release();
          },
        };
      } catch (error) {
        await client.release(error instanceof Error ? error : undefined);
        throw error;
      }
    },
  };
}

type DbRun = Omit<KernelRun, 'createdAt' | 'updatedAt' | 'pausedAt' | 'terminalAt'> & {
  created_at: string | Date;
  updated_at: string | Date;
  paused_at: string | Date | null;
  terminal_at: string | Date | null;
  tenant_id: string;
  intent_hash: string;
  work_graph_hash: string;
  work_graph_version: string;
  policy_snapshot_id: string;
};
type DbStep = Omit<
  KernelStep,
  'createdAt' | 'updatedAt' | 'scheduledAt' | 'runId' | 'tenantId' | 'maxAttempts'
> & {
  run_id: string;
  tenant_id: string;
  max_attempts: number;
  scheduled_at: string | Date;
  created_at: string | Date;
  updated_at: string | Date;
  lease_worker_id: string | null;
  lease_worker_generation: number;
  lease_token: string | null;
  fencing_epoch: number;
  lease_expires_at: string | Date | null;
};
type DbEffect = Omit<
  KernelEffect,
  | 'runId'
  | 'stepId'
  | 'tenantId'
  | 'idempotencyKey'
  | 'policyDecisionId'
  | 'policySnapshotId'
  | 'actionDigest'
  | 'leaseWorkerId'
  | 'leaseWorkerGeneration'
  | 'leaseFencingEpoch'
  | 'createdAt'
  | 'completedAt'
  | 'reconcileAfter'
  | 'governedActionDeadlineAt'
  | 'reconcilePolicy'
  | 'reconcileDisposition'
  | 'reconcileObservedAt'
  | 'reconcileClaimToken'
  | 'reconcileClaimExpiresAt'
  | 'reconcileClaimedAt'
  | 'reconcileClaimWorkerId'
  | 'reconcileClaimWorkerGeneration'
  | 'reconcileLastError'
  | 'reconcileEscalatedAt'
  | 'reconcileEscalationCode'
> & {
  run_id: string;
  step_id: string;
  tenant_id: string;
  idempotency_key: string;
  request_hash: string;
  policy_decision_id: string;
  policy_snapshot_id: string;
  action_digest: string;
  lease_worker_id: string;
  lease_worker_generation: number | string;
  lease_fencing_epoch: number | string;
  created_at: string | Date;
  completed_at: string | Date | null;
  reconcile_attempts: number | string;
  governed_action_deadline_at: string | Date | null;
  reconcile_max_attempts: number | string | null;
  reconcile_initial_delay_ms: number | string | null;
  reconcile_max_delay_ms: number | string | null;
  reconcile_deadline_at: string | Date | null;
  reconcile_disposition: KernelEffect['reconcileDisposition'];
  reconcile_after: string | Date | null;
  reconcile_observed_at: string | Date | null;
  reconcile_claim_token: string | null;
  reconcile_claim_expires_at: string | Date | null;
  reconcile_claimed_at: string | Date | null;
  reconcile_claim_worker_id: string | null;
  reconcile_claim_worker_generation: number | string | null;
  reconcile_last_error: KernelEffect['reconcileLastError'];
  reconcile_escalated_at: string | Date | null;
  reconcile_escalation_code: KernelEffect['reconcileEscalationCode'];
};
type DbTenantExecutionControl = {
  tenant_id: string;
  paused: boolean;
  generation: number | string;
  actor: string;
  reason: string | null;
  paused_at: string | Date | null;
  resumed_at: string | Date | null;
};
type DbEvidence = {
  tenant_id: string;
  run_id: string;
  bundle_id: string;
  action_digest: string;
  body: Record<string, unknown>;
  content_hash: string;
  signature: KernelEvidenceSignature;
  created_at: string | Date;
  anchored_at: string | Date | null;
  retention_until: string | Date;
};

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
function json(value: unknown): string {
  return JSON.stringify(value ?? {});
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
    .join(',')}}`;
}
function requestHash(value: Record<string, unknown>): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
function fromEvidence(row: DbEvidence): KernelEvidenceRecord {
  return {
    tenantId: row.tenant_id,
    runId: row.run_id,
    bundleId: row.bundle_id,
    actionDigest: row.action_digest,
    body: row.body,
    contentHash: row.content_hash,
    signature: row.signature,
    createdAt: iso(row.created_at),
    anchoredAt: row.anchored_at ? iso(row.anchored_at) : null,
    retentionUntil: iso(row.retention_until),
  };
}
function fromTenantExecutionControl(row: DbTenantExecutionControl): TenantExecutionControl {
  return {
    tenantId: row.tenant_id,
    paused: row.paused,
    generation: Number(row.generation),
    actor: row.actor,
    reason: row.reason ?? undefined,
    pausedAt: row.paused_at ? iso(row.paused_at) : undefined,
    resumedAt: row.resumed_at ? iso(row.resumed_at) : undefined,
  };
}
function fromRun(row: DbRun): KernelRun {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    intentHash: row.intent_hash,
    workGraphHash: row.work_graph_hash,
    workGraphVersion: row.work_graph_version,
    state: row.state,
    version: Number(row.version),
    policySnapshotId: row.policy_snapshot_id,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    pausedAt: row.paused_at ? iso(row.paused_at) : undefined,
    terminalAt: row.terminal_at ? iso(row.terminal_at) : undefined,
    metadata: row.metadata ?? {},
  };
}
function fromStep(row: DbStep): KernelStep {
  const lease =
    row.lease_token && row.lease_worker_id && row.lease_expires_at
      ? {
          workerId: row.lease_worker_id,
          workerGeneration: Number(row.lease_worker_generation ?? 0),
          token: row.lease_token,
          fencingEpoch: Number(row.fencing_epoch),
          expiresAt: iso(row.lease_expires_at),
        }
      : undefined;
  return {
    id: row.id,
    runId: row.run_id,
    tenantId: row.tenant_id,
    kind: row.kind,
    state: row.state,
    version: Number(row.version),
    attempt: Number(row.attempt),
    maxAttempts: Number(row.max_attempts),
    priority: Number(row.priority),
    dependencies: row.dependencies ?? [],
    input: row.input ?? {},
    output: row.output ?? undefined,
    error: row.error ?? undefined,
    scheduledAt: iso(row.scheduled_at),
    lease,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}
function fromEffect(row: DbEffect): KernelEffect {
  return {
    id: row.id,
    runId: row.run_id,
    stepId: row.step_id,
    tenantId: row.tenant_id,
    type: row.type,
    idempotencyKey: row.idempotency_key,
    policyDecisionId: row.policy_decision_id,
    policySnapshotId: row.policy_snapshot_id || 'legacy-unbound',
    actionDigest: row.action_digest || row.request_hash,
    leaseWorkerId: row.lease_worker_id || 'legacy-unbound',
    leaseWorkerGeneration: Number(row.lease_worker_generation ?? 0),
    leaseFencingEpoch: Number(row.lease_fencing_epoch ?? 0),
    state: row.state,
    requestHash: row.request_hash,
    request: row.request ?? {},
    response: row.response ?? undefined,
    createdAt: iso(row.created_at),
    completedAt: row.completed_at ? iso(row.completed_at) : undefined,
    reconcileAttempts: Number(row.reconcile_attempts ?? 0),
    governedActionDeadlineAt: row.governed_action_deadline_at
      ? iso(row.governed_action_deadline_at)
      : null,
    reconcilePolicy:
      row.reconcile_max_attempts == null ||
      row.reconcile_initial_delay_ms == null ||
      row.reconcile_max_delay_ms == null ||
      row.reconcile_deadline_at == null
        ? null
        : {
            maxAttempts: Number(row.reconcile_max_attempts) as 8,
            initialDelayMs: Number(row.reconcile_initial_delay_ms) as 30_000,
            maxDelayMs: Number(row.reconcile_max_delay_ms) as 900_000,
            deadlineAt: iso(row.reconcile_deadline_at),
          },
    reconcileDisposition: row.reconcile_disposition ?? null,
    reconcileAfter: row.reconcile_after ? iso(row.reconcile_after) : null,
    reconcileObservedAt: row.reconcile_observed_at ? iso(row.reconcile_observed_at) : null,
    reconcileClaimToken: row.reconcile_claim_token ?? null,
    reconcileClaimExpiresAt: row.reconcile_claim_expires_at
      ? iso(row.reconcile_claim_expires_at)
      : null,
    reconcileClaimedAt: row.reconcile_claimed_at ? iso(row.reconcile_claimed_at) : null,
    reconcileClaimWorkerId: row.reconcile_claim_worker_id ?? null,
    reconcileClaimWorkerGeneration:
      row.reconcile_claim_worker_generation == null
        ? null
        : Number(row.reconcile_claim_worker_generation),
    reconcileLastError: row.reconcile_last_error ?? null,
    reconcileEscalatedAt: row.reconcile_escalated_at ? iso(row.reconcile_escalated_at) : null,
    reconcileEscalationCode: row.reconcile_escalation_code ?? null,
  };
}

function fromCompensationRequest(row: Record<string, unknown>): KernelCompensationRequest {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    originalRunId: String(row.original_run_id),
    originalEffectId: String(row.original_effect_id),
    compensationRunId: String(row.compensation_run_id),
    compensationStepId: String(row.compensation_step_id),
    adapterVersion: String(row.adapter_version),
    compensationEffectType: String(row.compensation_effect_type),
    destination: typeof row.destination === 'string' ? row.destination : '',
    compensationPatch: row.compensation_patch as Record<string, unknown>,
    forwardReceiptHash: String(row.forward_receipt_hash),
    authorizationId: String(row.authorization_id),
    reconcilePolicy: row.reconcile_policy as KernelCompensationRequest['reconcilePolicy'],
    state: row.state as KernelCompensationRequest['state'],
    ...(row.claim_worker_id ? { claimWorkerId: String(row.claim_worker_id) } : {}),
    ...(row.claim_worker_generation != null
      ? { claimWorkerGeneration: Number(row.claim_worker_generation) }
      : {}),
    ...(row.claim_token ? { claimToken: String(row.claim_token) } : {}),
    ...(row.claim_expires_at ? { claimExpiresAt: iso(row.claim_expires_at as Date | string) } : {}),
    ...(row.compensation_effect_id
      ? { compensationEffectId: String(row.compensation_effect_id) }
      : {}),
  };
}

export interface PostgresKernelRepositoryOptions {
  /**
   * When true, the repository may perform cross-tenant operations such as
   * reclaiming expired leases, sweeping the outbox DLQ, and claiming timers.
   * The backing connection must be authenticated as the commander_scheduler
   * role, which has BYPASSRLS. API replicas must leave this false.
   */
  schedulerMode?: boolean;
  /** Dedicated adapter-ops LOGIN: use owner-owned aggregate readiness RPC. */
  adapterOpsMode?: boolean;
  /** Separate commander_tenant_authority pool/port used only by app transactions. */
  tenantContextAuthority?: TenantContextAuthority;
  /** Expand sets the legacy scope after database-authenticated binding; enforce never does. */
  tenantContextPhase?: 'expand' | 'enforce';
}

/** Shared PostgreSQL implementation. No fallback exists: inability to connect is an operational failure. */
export class PostgresKernelRepository implements KernelRepository {
  protected readonly pool: SqlPool;

  protected enforceAtomicOperationsReadiness(): boolean {
    return true;
  }

  constructor(
    pool: SqlPool,
    protected readonly options: PostgresKernelRepositoryOptions = {},
  ) {
    if (
      options.tenantContextAuthority instanceof PostgresTenantContextAuthority &&
      options.tenantContextAuthority.usesPool(pool)
    ) {
      throw new Error('TENANT_CONTEXT_AUTHORITY_POOL_MUST_BE_SEPARATE');
    }
    if (options.tenantContextAuthority && !options.tenantContextPhase) {
      throw new Error('TENANT_CONTEXT_PHASE_REQUIRED');
    }
    // Scheduler/recovery pools are assumed to authenticate as commander_scheduler
    // (BYPASSRLS). Non-scheduler pools: privileged LOGINs are downgraded to
    // commander_app; connections already logged in as commander_app/worker keep
    // that identity (workers are not members of commander_app).
    this.pool = options.schedulerMode ? pool : enforceAppRole(pool);
  }

  async initialize(): Promise<void> {
    // Migrations are applied by the dedicated migration job (packages/kernel/src/migrate.ts)
    // or by test harnesses that explicitly call runKernelMigrations(). API replicas must not
    // bootstrap the schema, so this method is intentionally a no-op.
  }

  private async admitCompensationEffectViaRpc(
    client: SqlClient,
    request: AdmitEffectRequest,
  ): Promise<AdmitEffectResult> {
    const result = await client.query<{
      result:
        | {
            admitted: boolean;
            replayed?: boolean;
            reason?: Extract<AdmitEffectResult, { admitted: false }>['reason'];
            effect?: DbEffect;
          }
        | string;
    }>('SELECT admit_compensation_effect_v1($1::jsonb) AS result', [json(request)]);
    const raw = result.rows[0]?.result;
    const value = (typeof raw === 'string' ? JSON.parse(raw) : raw) ?? {};
    if (!value.admitted || !value.effect) {
      return {
        admitted: false,
        reason: value.reason ?? 'COMPENSATION_ADMISSION_UNAVAILABLE',
      };
    }
    return {
      admitted: true,
      replayed: value.replayed === true,
      effect: fromEffect(value.effect),
    };
  }

  /**
   * Resolve the governed compensation authorization from durable evidence — the
   * `commander_compensation_requests` row the producer wrote, its
   * `commander_compensation_authorizations` row and the completed forward effect —
   * exactly like the SQLite / in-memory repositories. The legacy
   * `admit_compensation_effect_v1` RPC instead reads a sealed authorization from run
   * metadata and the outbox payload, which the active `request_compensation`
   * producer never writes.
   */
  private async admitCompensationEffectViaDurableEvidence(
    client: SqlClient,
    input: AdmitEffectRequest & {
      requestId: string;
      requestClaimToken: string;
      outboxMessageId: string;
      outboxClaimToken: string;
    },
  ): Promise<AdmitEffectResult> {
    const result = await client.query<{
      result:
        | {
            admitted: boolean;
            replayed?: boolean;
            reason?: Extract<AdmitEffectResult, { admitted: false }>['reason'];
            effect?: DbEffect;
          }
        | string;
    }>('SELECT admit_compensation_effect($1::jsonb) AS result', [json(input)]);
    const raw = result.rows[0]?.result;
    const value = (typeof raw === 'string' ? JSON.parse(raw) : raw) ?? {};
    if (!value.admitted || !value.effect) {
      return {
        admitted: false,
        reason: value.reason ?? 'COMPENSATION_ADMISSION_UNAVAILABLE',
      };
    }
    return {
      admitted: true,
      replayed: value.replayed === true,
      effect: fromEffect(value.effect),
    };
  }

  async createRun(command: CreateKernelRun, actor: string): Promise<KernelRun> {
    this.assertGraph(command);
    return this.withTransaction(
      async (client) => {
        let created: SqlQueryResult<DbRun>;
        try {
          created = await client.query<DbRun>(
            `INSERT INTO commander_runs (id, tenant_id, intent_hash, work_graph_hash, work_graph_version, policy_snapshot_id, state, metadata)
           VALUES ($1,$2,$3,$4,$5,$6,'PENDING',$7::jsonb) RETURNING *`,
            [
              command.id,
              command.tenantId,
              command.intentHash,
              command.workGraphHash,
              command.workGraphVersion,
              command.policySnapshotId,
              json(command.metadata),
            ],
          );
        } catch (error) {
          if ((error as { code?: string; constraint?: string }).code === '23505') {
            throw new KernelInvariantError('DUPLICATE_RUN', `Run ${command.id} already exists`);
          }
          throw error;
        }
        const run = fromRun(created.rows[0]!);
        await client.query(
          `INSERT INTO commander_tenant_execution_usage (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING`,
          [command.tenantId],
        );
        await client.query(
          `INSERT INTO commander_tenant_execution_control (tenant_id, actor)
         VALUES ($1, 'kernel') ON CONFLICT DO NOTHING`,
          [command.tenantId],
        );
        try {
          for (const step of command.steps) {
            await client.query(
              `INSERT INTO commander_steps (id, run_id, tenant_id, kind, state, max_attempts, priority, dependencies, input, scheduled_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10)`,
              [
                step.id,
                command.id,
                command.tenantId,
                step.kind,
                step.initialState ?? 'PENDING',
                step.maxAttempts ?? 1,
                step.priority ?? 0,
                json(step.dependencies ?? []),
                json(step.input),
                step.scheduledAt ?? new Date(Date.now() - 1_000).toISOString(),
              ],
            );
            if (step.interaction) {
              await client.query(
                `INSERT INTO commander_interactions (id,run_id,step_id,tenant_id,prompt,expires_at)
               VALUES ($1,$2,$3,$4,$5,$6)`,
                [
                  step.interaction.id,
                  command.id,
                  step.id,
                  command.tenantId,
                  step.interaction.prompt,
                  step.interaction.expiresAt ?? null,
                ],
              );
              await this.appendEvent(client, {
                aggregateType: 'interaction',
                aggregateId: step.interaction.id,
                sequence: 0,
                type: 'interaction.created',
                tenantId: command.tenantId,
                runId: command.id,
                stepId: step.id,
                actor,
                payload: {
                  interactionId: step.interaction.id,
                  prompt: step.interaction.prompt,
                  expiresAt: step.interaction.expiresAt ?? null,
                },
              });
            }
          }
        } catch (error) {
          const uniqueViolation = error as { code?: string; constraint?: string };
          if (
            uniqueViolation.code === '23505' &&
            uniqueViolation.constraint?.startsWith('commander_interactions_')
          ) {
            throw new KernelInvariantError(
              'DUPLICATE_INTERACTION',
              `An interaction in run ${command.id} already exists`,
            );
          }
          if (
            uniqueViolation.code === '23505' &&
            uniqueViolation.constraint?.startsWith('commander_steps_')
          ) {
            throw new KernelInvariantError(
              'DUPLICATE_STEP',
              `A step in run ${command.id} already exists`,
            );
          }
          throw error;
        }
        await this.appendEvent(client, {
          aggregateType: 'run',
          aggregateId: command.id,
          sequence: 1,
          type: 'run.created',
          tenantId: command.tenantId,
          runId: command.id,
          actor,
          payload: { workGraphHash: command.workGraphHash, stepCount: command.steps.length },
        });
        return run;
      },
      [command.tenantId],
    );
  }

  async setTenantConcurrencyLimit(tenantId: string, maxConcurrentSteps: number): Promise<void> {
    if (!Number.isInteger(maxConcurrentSteps) || maxConcurrentSteps <= 0) {
      throw new Error('maxConcurrentSteps must be a positive integer');
    }
    await this.withTransaction(
      async (client) => {
        await client.query(
          `INSERT INTO commander_tenant_execution_usage (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING`,
          [tenantId],
        );
        await client.query(
          `INSERT INTO commander_tenant_execution_limits (tenant_id,max_concurrent_steps) VALUES ($1,$2)
         ON CONFLICT (tenant_id) DO UPDATE SET max_concurrent_steps=EXCLUDED.max_concurrent_steps, updated_at=now()`,
          [tenantId, maxConcurrentSteps],
        );
      },
      [tenantId],
    );
  }

  async getRun(runId: string, tenantId: string): Promise<KernelRun | null> {
    return this.withTransaction(
      async (client) => {
        const result = await client.query<DbRun>(
          'SELECT * FROM commander_runs WHERE id=$1 AND tenant_id=$2',
          [runId, tenantId],
        );
        return result.rows[0] ? fromRun(result.rows[0]) : null;
      },
      [tenantId],
    );
  }

  async listRuns(tenantId: string, options?: { limit?: number }): Promise<KernelRun[]> {
    const requested = options?.limit ?? 50;
    const limit = Math.min(
      200,
      Math.max(1, Number.isFinite(requested) ? Math.trunc(requested) : 50),
    );
    return this.withTransaction(
      async (client) => {
        const result = await client.query<DbRun>(
          'SELECT * FROM commander_runs WHERE tenant_id=$1 ORDER BY updated_at DESC, id DESC LIMIT $2',
          [tenantId, limit],
        );
        return result.rows.map((row) => fromRun(row));
      },
      [tenantId],
    );
  }

  async getStep(stepId: string, tenantId: string): Promise<KernelStep | null> {
    return this.withTransaction(
      async (client) => {
        const result = await client.query<DbStep>(
          'SELECT * FROM commander_steps WHERE id=$1 AND tenant_id=$2',
          [stepId, tenantId],
        );
        return result.rows[0] ? fromStep(result.rows[0]) : null;
      },
      [tenantId],
    );
  }

  async claimNextStep(request: ClaimStepRequest): Promise<KernelStep | null> {
    // Worker / least-privilege path: DB-atomic SECURITY DEFINER RPC. Caller
    // tenantIds/tenantId are ignored — durable commander_workers.tenant_ids only.
    if (!this.options.schedulerMode) {
      return this.claimNextStepViaRpc(request);
    }

    const now = request.now ?? new Date();
    const expiry = new Date(now.getTime() + request.leaseTtlMs);
    const token = randomUUID();
    const workerGeneration = request.workerGeneration ?? -1;
    const tenantIds = request.tenantIds ?? (request.tenantId ? [request.tenantId] : []);
    return this.withTransaction(async (client) => {
      const result = await client.query<DbStep & { previous_state: KernelStepState }>(
        `WITH candidate AS (
           SELECT s.id, s.state AS previous_state FROM commander_steps s JOIN commander_runs r ON r.id=s.run_id AND r.tenant_id=s.tenant_id
           JOIN commander_workers w ON w.id=$4 AND w.generation=$5 AND w.status='ACTIVE'
           JOIN commander_tenant_execution_usage u ON u.tenant_id=s.tenant_id
           JOIN commander_tenant_execution_control c ON c.tenant_id=s.tenant_id
           LEFT JOIN commander_tenant_execution_limits l ON l.tenant_id=s.tenant_id
             WHERE s.state IN ('PENDING','RETRY_WAIT') AND s.scheduled_at <= $1
             AND r.state IN ('PENDING','RUNNING')
             AND r.metadata->>'compensationRequestId' IS NULL
             AND (cardinality($2::text[]) = 0 OR s.tenant_id = ANY($2::text[]))
             AND c.paused=false
             AND (cardinality($3::text[]) = 0 OR s.kind = ANY($3::text[]))
             AND u.running_steps < COALESCE(l.max_concurrent_steps, 2147483647)
             AND NOT EXISTS (
               SELECT 1 FROM jsonb_array_elements_text(s.dependencies) d
               JOIN commander_steps prerequisite ON prerequisite.id=d.value AND prerequisite.tenant_id=s.tenant_id
               WHERE prerequisite.state NOT IN ('SUCCEEDED','SKIPPED')
             )
           ORDER BY u.running_steps ASC,
                    -- Aging: boost priority by +1 per minute of waiting, capped at 1000.
                    -- This prevents starvation: even a priority=-1000 step will eventually
                    -- outrank new steps after enough time.
                    LEAST(s.priority + FLOOR(EXTRACT(EPOCH FROM ($1::timestamptz - s.scheduled_at)) / 60), 1000) DESC,
                    s.scheduled_at ASC, s.created_at ASC FOR UPDATE OF s, u, c SKIP LOCKED LIMIT 1
         ), claimed AS (
           UPDATE commander_steps s SET state='RUNNING', attempt=s.attempt+1, version=s.version+1,
             lease_worker_id=$4, lease_worker_generation=$5, lease_token=$6, fencing_epoch=s.fencing_epoch+1, lease_expires_at=$7, updated_at=$1
           FROM candidate WHERE s.id=candidate.id RETURNING s.*, candidate.previous_state
         ) SELECT * FROM claimed`,
        [
          now.toISOString(),
          tenantIds,
          request.capabilities ?? [],
          request.workerId,
          workerGeneration,
          token,
          expiry.toISOString(),
        ],
      );
      const row = result.rows[0];
      if (!row) return null;
      const step = fromStep(row);
      assertStepTransition(row.previous_state, step.state);
      await client.query(
        `UPDATE commander_tenant_execution_usage SET running_steps=running_steps+1, updated_at=$1 WHERE tenant_id=$2`,
        [now.toISOString(), step.tenantId],
      );
      assertRunTransition('PENDING', 'RUNNING');
      await client.query(
        `UPDATE commander_runs SET state='RUNNING', version=version+1, updated_at=$1 WHERE id=$2 AND tenant_id=$3 AND state='PENDING'`,
        [now.toISOString(), step.runId, step.tenantId],
      );
      await this.appendEvent(client, {
        aggregateType: 'step',
        aggregateId: step.id,
        sequence: step.version,
        type: 'step.claimed',
        tenantId: step.tenantId,
        runId: step.runId,
        stepId: step.id,
        actor: request.workerId,
        payload: { attempt: step.attempt, fencingEpoch: step.lease!.fencingEpoch },
      });
      return step;
    }, tenantIds);
  }

  /**
   * Worker claim via SECURITY DEFINER claim_next_step. Does not set
   * app.tenant_scope='*' and does not accept caller tenant scope.
   */
  private async claimNextStepViaRpc(request: ClaimStepRequest): Promise<KernelStep | null> {
    if (
      typeof request.workerGeneration !== 'number' ||
      !Number.isFinite(request.workerGeneration)
    ) {
      return null;
    }
    const workerGeneration = request.workerGeneration;
    const claimSecret = request.claimSecret ?? '';
    if (!claimSecret) return null;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<{ claim_next_step: DbStep | null }>(
        'SELECT claim_next_step($1::text, $2::bigint, $3::integer, $4::text, $5::jsonb) AS claim_next_step',
        [
          request.workerId,
          workerGeneration,
          request.leaseTtlMs,
          claimSecret,
          JSON.stringify(request.capabilities ?? []),
        ],
      );
      await client.query('COMMIT');
      const row = result.rows[0]?.claim_next_step;
      if (row == null) return null;
      return fromStep(row);
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* preserve claim error */
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async heartbeatStep(
    stepId: string,
    tenantId: string,
    lease: Pick<KernelLease, 'workerId' | 'workerGeneration' | 'token' | 'fencingEpoch'>,
    leaseTtlMs: number,
  ): Promise<KernelStep | null> {
    const expiresAt = new Date(Date.now() + leaseTtlMs).toISOString();
    return this.withTransaction(
      async (client) => {
        const result = await client.query<DbStep>(
          `UPDATE commander_steps SET lease_expires_at=$1, updated_at=now()
         WHERE id=$2 AND tenant_id=$3 AND state='RUNNING' AND lease_worker_id=$4 AND lease_worker_generation=$5 AND lease_token=$6 AND fencing_epoch=$7 AND lease_expires_at > now()
           AND EXISTS (SELECT 1 FROM commander_workers w WHERE w.id=$4 AND w.generation=$5)
         RETURNING *`,
          [
            expiresAt,
            stepId,
            tenantId,
            lease.workerId,
            lease.workerGeneration ?? -1,
            lease.token,
            lease.fencingEpoch,
          ],
        );
        return result.rows[0] ? fromStep(result.rows[0]) : null;
      },
      [tenantId],
    );
  }

  async reclaimExpiredLeases(now = new Date(), limit = 100): Promise<KernelStep[]> {
    return this.withTransaction(async (client) => {
      const result = await client.query<DbStep>(
        `WITH expired AS (
           SELECT s.id,
                  EXISTS (
                    SELECT 1 FROM commander_effects e
                     WHERE e.step_id=s.id AND e.tenant_id=s.tenant_id AND e.state='ADMITTED'
                  ) AS has_admitted_effect
             FROM commander_steps s
            WHERE s.state='RUNNING' AND s.lease_expires_at <= $1
            ORDER BY s.lease_expires_at ASC FOR UPDATE OF s SKIP LOCKED LIMIT $2
         )
         UPDATE commander_steps s SET
           state=CASE
             WHEN expired.has_admitted_effect THEN 'WAITING_FOR_RECONCILIATION'
             WHEN s.attempt < s.max_attempts THEN 'RETRY_WAIT'
             ELSE 'FAILED'
           END,
           scheduled_at=CASE
             WHEN NOT expired.has_admitted_effect AND s.attempt < s.max_attempts THEN $1
             ELSE s.scheduled_at
           END,
           error=jsonb_build_object(
             'code','LEASE_EXPIRED',
             'message','Worker lease expired before terminal transition',
             'retryable', NOT expired.has_admitted_effect AND s.attempt < s.max_attempts
           ),
           version=s.version+1, updated_at=$1, lease_worker_id=NULL, lease_worker_generation=0, lease_token=NULL, lease_expires_at=NULL
         FROM expired WHERE s.id=expired.id RETURNING s.*`,
        [now.toISOString(), limit],
      );
      const reclaimed = result.rows.map(fromStep);
      for (const step of reclaimed) {
        assertStepTransition('RUNNING', step.state);
        const awaitingReconciliation = step.state === 'WAITING_FOR_RECONCILIATION';
        await this.releaseTenantSlot(client, step.tenantId);
        const retryable = step.state === 'RETRY_WAIT';
        await this.appendEvent(client, {
          aggregateType: 'step',
          aggregateId: step.id,
          sequence: step.version,
          type: retryable ? 'step.lease_expired_requeued' : 'step.lease_expired_failed',
          tenantId: step.tenantId,
          runId: step.runId,
          stepId: step.id,
          actor: 'kernel.recovery',
          payload: { attempt: step.attempt },
        });
        await this.parkOrphanAdmittedEffects(client, step, 'lease_expired', 'kernel.recovery');
        if (!retryable && !awaitingReconciliation) {
          const source = result.rows.find((row) => row.id === step.id);
          const compensated = await this.requestCompensationIfNeeded(
            client,
            step,
            Number(source?.fencing_epoch ?? 0),
            'kernel.recovery',
            now,
          );
          if (!compensated) {
            await this.finishRunIfTerminal(client, step.runId, step.tenantId, 'kernel.recovery');
          }
        }
      }
      return reclaimed;
    });
  }

  async completeStep(request: CompleteStepRequest): Promise<KernelStep | null> {
    return this.withTransaction(
      async (client) => {
        const result = await client.query<DbStep>(
          `UPDATE commander_steps SET state='SUCCEEDED', output=$1::jsonb, version=version+1, updated_at=now(), lease_worker_id=NULL, lease_token=NULL, lease_expires_at=NULL
         WHERE id=$2 AND tenant_id=$3 AND state='RUNNING' AND version=$4 AND lease_worker_id=$5 AND lease_worker_generation=$6 AND lease_token=$7 AND fencing_epoch=$8 AND lease_expires_at > now()
           AND EXISTS (SELECT 1 FROM commander_workers w WHERE w.id=$5 AND w.generation=$6)
         RETURNING *`,
          [
            json(request.output),
            request.stepId,
            request.tenantId,
            request.expectedVersion,
            request.lease.workerId,
            request.lease.workerGeneration ?? -1,
            request.lease.token,
            request.lease.fencingEpoch,
          ],
        );
        if (!result.rows[0]) return null;
        const step = fromStep(result.rows[0]);
        assertStepTransition('RUNNING', step.state);
        await this.releaseTenantSlot(client, step.tenantId);
        await this.appendEvent(client, {
          aggregateType: 'step',
          aggregateId: step.id,
          sequence: step.version,
          type: 'step.succeeded',
          tenantId: step.tenantId,
          runId: step.runId,
          stepId: step.id,
          actor: request.actor,
          payload: { attempt: step.attempt },
        });
        await this.parkOrphanAdmittedEffects(client, step, 'step_succeeded', request.actor);
        await this.finishRunIfTerminal(client, step.runId, step.tenantId, request.actor);
        return step;
      },
      [request.tenantId],
    );
  }

  async failStep(request: FailStepRequest): Promise<KernelStep | null> {
    return this.withTransaction(
      async (client) => {
        const result = await client.query<DbStep>(
          `UPDATE commander_steps SET
           attempt=CASE WHEN $11::boolean THEN GREATEST(0, attempt - 1) ELSE attempt END,
           state=CASE WHEN $1::boolean AND (CASE WHEN $11::boolean THEN GREATEST(0, attempt - 1) ELSE attempt END) < max_attempts THEN 'RETRY_WAIT' ELSE 'FAILED' END,
           error=$2::jsonb,
           scheduled_at=CASE WHEN $1::boolean AND (CASE WHEN $11::boolean THEN GREATEST(0, attempt - 1) ELSE attempt END) < max_attempts THEN $3 ELSE scheduled_at END,
           version=version+1, updated_at=now(), lease_worker_id=NULL, lease_token=NULL, lease_expires_at=NULL
         WHERE id=$4 AND tenant_id=$5 AND state='RUNNING' AND version=$6 AND lease_worker_id=$7 AND lease_worker_generation=$8 AND lease_token=$9 AND fencing_epoch=$10 AND lease_expires_at > now()
           AND EXISTS (SELECT 1 FROM commander_workers w WHERE w.id=$7 AND w.generation=$8)
         RETURNING *`,
          [
            request.error.retryable && Boolean(request.retryAt),
            json(request.error),
            request.retryAt?.toISOString() ?? null,
            request.stepId,
            request.tenantId,
            request.expectedVersion,
            request.lease.workerId,
            request.lease.workerGeneration ?? -1,
            request.lease.token,
            request.lease.fencingEpoch,
            Boolean(request.refundAttempt),
          ],
        );
        if (!result.rows[0]) return null;
        const step = fromStep(result.rows[0]);
        assertStepTransition('RUNNING', step.state);
        await this.releaseTenantSlot(client, step.tenantId);
        await this.appendEvent(client, {
          aggregateType: 'step',
          aggregateId: step.id,
          sequence: step.version,
          type: step.state === 'RETRY_WAIT' ? 'step.retry_scheduled' : 'step.failed',
          tenantId: step.tenantId,
          runId: step.runId,
          stepId: step.id,
          actor: request.actor,
          payload: { error: request.error, refundAttempt: Boolean(request.refundAttempt) },
        });
        // Broker-external fail must park ADMITTED effects (same as lease reclaim).
        await this.parkOrphanAdmittedEffects(client, step, 'step_failed', request.actor);
        if (step.state === 'FAILED') {
          const compensated = await this.requestCompensationIfNeeded(
            client,
            step,
            Number(result.rows[0]?.fencing_epoch ?? 0),
            request.actor,
          );
          if (!compensated) {
            await this.finishRunIfTerminal(client, step.runId, step.tenantId, request.actor);
          }
        }
        return step;
      },
      [request.tenantId],
    );
  }

  async wakeRetryStep(stepId: string, tenantId: string, actor: string): Promise<KernelStep | null> {
    return this.withTransaction(
      async (client) => {
        const result = await client.query<DbStep>(
          `UPDATE commander_steps SET scheduled_at=now(), version=version+1, updated_at=now(), lease_worker_id=NULL, lease_token=NULL, lease_expires_at=NULL
         WHERE id=$1 AND tenant_id=$2 AND state='RETRY_WAIT' RETURNING *`,
          [stepId, tenantId],
        );
        if (!result.rows[0]) return null;
        const step = fromStep(result.rows[0]);
        await this.appendEvent(client, {
          aggregateType: 'step',
          aggregateId: step.id,
          sequence: step.version,
          type: 'step.retry_woken',
          tenantId: step.tenantId,
          runId: step.runId,
          stepId: step.id,
          actor,
          payload: {},
        });
        return step;
      },
      [tenantId],
    );
  }

  async failStepByTimer(
    stepId: string,
    tenantId: string,
    error: { code: string; message: string; retryable: boolean; details?: Record<string, unknown> },
    actor: string,
  ): Promise<KernelStep | null> {
    return this.withTransaction(
      async (client) => {
        const previous = await client.query<{ state: KernelStepState }>(
          `SELECT state FROM commander_steps
         WHERE id=$1 AND tenant_id=$2 AND state NOT IN ('SUCCEEDED','FAILED','CANCELLED','SKIPPED')
         FOR UPDATE`,
          [stepId, tenantId],
        );
        const previousState = previous.rows[0]?.state;
        if (!previousState) return null;
        assertStepTransition(previousState, 'FAILED');
        const result = await client.query<DbStep>(
          `UPDATE commander_steps SET state='FAILED', error=$1::jsonb, version=version+1, updated_at=now(),
           lease_worker_id=NULL, lease_token=NULL, lease_expires_at=NULL
         WHERE id=$2 AND tenant_id=$3 AND state NOT IN ('SUCCEEDED','FAILED','CANCELLED','SKIPPED') RETURNING *`,
          [json(error), stepId, tenantId],
        );
        if (!result.rows[0]) return null;
        const step = fromStep(result.rows[0]);
        if (previousState === 'RUNNING') await this.releaseTenantSlot(client, step.tenantId);
        await this.appendEvent(client, {
          aggregateType: 'step',
          aggregateId: step.id,
          sequence: step.version,
          type: 'step.failed',
          tenantId: step.tenantId,
          runId: step.runId,
          stepId: step.id,
          actor,
          payload: { error },
        });
        if (previousState === 'RUNNING')
          await this.parkOrphanAdmittedEffects(client, step, 'step_failed', actor);
        const compensated = await this.requestCompensationIfNeeded(
          client,
          step,
          Number(result.rows[0]?.fencing_epoch ?? 0),
          actor,
        );
        if (!compensated) {
          await this.finishRunIfTerminal(client, step.runId, step.tenantId, actor);
        }
        return step;
      },
      [tenantId],
    );
  }

  async pauseRun(runId: string, tenantId: string, actor: string): Promise<KernelRun | null> {
    return this.withTransaction(
      async (client) => {
        const previousRunState = await this.lockRunState(client, runId, tenantId);
        if (!previousRunState || !['PENDING', 'RUNNING'].includes(previousRunState)) return null;
        assertRunTransition(previousRunState, 'PAUSED');
        const runResult = await client.query<DbRun>(
          `UPDATE commander_runs SET state='PAUSED', version=version+1, updated_at=now(), paused_at=now()
         WHERE id=$1 AND tenant_id=$2 AND state IN ('PENDING','RUNNING') RETURNING *`,
          [runId, tenantId],
        );
        if (!runResult.rows[0]) return null;
        const run = fromRun(runResult.rows[0]);
        assertStepTransition('RUNNING', 'RETRY_WAIT');
        const pausedSteps = await client.query<DbStep>(
          `UPDATE commander_steps SET state='RETRY_WAIT', version=version+1, updated_at=now(),
           lease_worker_id=NULL, lease_token=NULL, lease_expires_at=NULL
         WHERE run_id=$1 AND tenant_id=$2 AND state='RUNNING' RETURNING *`,
          [runId, tenantId],
        );
        for (const row of pausedSteps.rows) {
          const step = fromStep(row);
          await this.releaseTenantSlot(client, step.tenantId);
          await this.parkOrphanAdmittedEffects(client, step, 'run_paused', actor);
          await this.appendEvent(client, {
            aggregateType: 'step',
            aggregateId: step.id,
            sequence: step.version,
            type: 'step.paused',
            tenantId: step.tenantId,
            runId: step.runId,
            stepId: step.id,
            actor,
            payload: { previousState: 'RUNNING' },
          });
        }
        await this.appendEvent(client, {
          aggregateType: 'run',
          aggregateId: run.id,
          sequence: run.version,
          type: 'run.paused',
          tenantId,
          runId,
          actor,
          payload: {},
        });
        return run;
      },
      [tenantId],
    );
  }

  async resumeRun(runId: string, tenantId: string, actor: string): Promise<KernelRun | null> {
    return this.withTransaction(
      async (client) => {
        const previousRunState = await this.lockRunState(client, runId, tenantId);
        if (previousRunState !== 'PAUSED') return null;
        assertRunTransition(previousRunState, 'RUNNING');
        const runResult = await client.query<DbRun>(
          `UPDATE commander_runs SET state='RUNNING', version=version+1, updated_at=now(), paused_at=NULL
         WHERE id=$1 AND tenant_id=$2 AND state='PAUSED' RETURNING *`,
          [runId, tenantId],
        );
        if (!runResult.rows[0]) return null;
        const run = fromRun(runResult.rows[0]);
        await this.appendEvent(client, {
          aggregateType: 'run',
          aggregateId: run.id,
          sequence: run.version,
          type: 'run.resumed',
          tenantId,
          runId,
          actor,
          payload: {},
        });
        return run;
      },
      [tenantId],
    );
  }

  async cancelRun(runId: string, tenantId: string, actor: string): Promise<KernelRun | null> {
    return this.withTransaction(
      async (client) => {
        const previousRunState = await this.lockRunState(client, runId, tenantId);
        if (!previousRunState || !['PENDING', 'RUNNING', 'PAUSED'].includes(previousRunState))
          return null;
        assertRunTransition(previousRunState, 'CANCELLED');
        const previousSteps = await this.lockStepStates(client, runId, tenantId);
        for (const step of previousSteps) {
          if (!['SUCCEEDED', 'FAILED', 'CANCELLED', 'SKIPPED'].includes(step.state)) {
            assertStepTransition(step.state, 'CANCELLED');
          }
        }
        const previousStepStates = new Map(previousSteps.map((step) => [step.id, step.state]));
        const runResult = await client.query<DbRun>(
          `UPDATE commander_runs SET state='CANCELLED', version=version+1, updated_at=now(), terminal_at=now()
         WHERE id=$1 AND tenant_id=$2 AND state IN ('PENDING','RUNNING','PAUSED') RETURNING *`,
          [runId, tenantId],
        );
        if (!runResult.rows[0]) return null;
        const run = fromRun(runResult.rows[0]);
        const cancelledSteps = await client.query<DbStep>(
          `UPDATE commander_steps SET state='CANCELLED', version=version+1, updated_at=now(),
           lease_worker_id=NULL, lease_token=NULL, lease_expires_at=NULL
         WHERE run_id=$1 AND tenant_id=$2 AND state NOT IN ('SUCCEEDED','FAILED','CANCELLED','SKIPPED') RETURNING *`,
          [runId, tenantId],
        );
        for (const row of cancelledSteps.rows) {
          const step = fromStep(row);
          const previousState = previousStepStates.get(step.id);
          // Only a step that was actually occupying a tenant slot may release one.
          // Cancelling PENDING/RETRY_WAIT/WAITING_* steps must not decrement the
          // shared running_steps counter (it would let the tenant exceed its limit).
          if (previousState === 'RUNNING') await this.releaseTenantSlot(client, step.tenantId);
          await this.parkOrphanAdmittedEffects(client, step, 'run_cancelled', actor);
          await this.appendEvent(client, {
            aggregateType: 'step',
            aggregateId: step.id,
            sequence: step.version,
            type: 'step.cancelled',
            tenantId: step.tenantId,
            runId: step.runId,
            stepId: step.id,
            actor,
            payload: { previousState },
          });
        }
        await this.appendEvent(client, {
          aggregateType: 'run',
          aggregateId: run.id,
          sequence: run.version,
          type: 'run.cancelled',
          tenantId,
          runId,
          actor,
          payload: {},
        });
        return run;
      },
      [tenantId],
    );
  }

  async pauseTenant(
    tenantId: string,
    actor: string,
    reason?: string,
  ): Promise<TenantExecutionControl> {
    return this.withTransaction(
      async (client) => {
        const controlResult = await client.query<DbTenantExecutionControl>(
          `INSERT INTO commander_tenant_execution_control
           (tenant_id, paused, generation, actor, reason, paused_at, resumed_at, updated_at)
         VALUES ($1, true, 1, $2, $3, now(), NULL, now())
         ON CONFLICT (tenant_id) DO UPDATE SET
           paused=true,
           generation=commander_tenant_execution_control.generation+1,
           actor=EXCLUDED.actor,
           reason=EXCLUDED.reason,
           paused_at=now(),
           resumed_at=NULL,
           updated_at=now()
         RETURNING *`,
          [tenantId, actor, reason ?? null],
        );
        assertStepTransition('RUNNING', 'RETRY_WAIT');
        const affected = await client.query<DbStep>(
          `UPDATE commander_steps SET
           state='RETRY_WAIT', scheduled_at=now(), version=version+1, updated_at=now(),
           lease_worker_id=NULL, lease_worker_generation=0, lease_token=NULL, lease_expires_at=NULL
         WHERE tenant_id=$1 AND state='RUNNING'
         RETURNING *`,
          [tenantId],
        );
        if (affected.rows.length > 0) {
          await client.query(
            `UPDATE commander_tenant_execution_usage SET
             running_steps=GREATEST(0, running_steps-$1), updated_at=now()
           WHERE tenant_id=$2`,
            [affected.rows.length, tenantId],
          );
        }
        for (const row of affected.rows) {
          const step = fromStep(row);
          await this.parkOrphanAdmittedEffects(client, step, 'tenant_paused', actor);
          await this.appendEvent(client, {
            aggregateType: 'step',
            aggregateId: step.id,
            sequence: step.version,
            type: 'step.tenant_paused',
            tenantId,
            runId: step.runId,
            stepId: step.id,
            actor,
            payload: { reason },
          });
        }
        const control = fromTenantExecutionControl(controlResult.rows[0]!);
        await this.appendEvent(client, {
          aggregateType: 'tenant',
          aggregateId: tenantId,
          sequence: control.generation,
          type: 'tenant.paused',
          tenantId,
          runId: `tenant:${tenantId}`,
          actor,
          payload: { reason },
        });
        return control;
      },
      [tenantId],
    );
  }

  async resumeTenant(tenantId: string, actor: string): Promise<TenantExecutionControl> {
    return this.withTransaction(
      async (client) => {
        const result = await client.query<DbTenantExecutionControl>(
          `INSERT INTO commander_tenant_execution_control
           (tenant_id, paused, generation, actor, reason, paused_at, resumed_at, updated_at)
         VALUES ($1, false, 1, $2, NULL, NULL, now(), now())
         ON CONFLICT (tenant_id) DO UPDATE SET
           paused=false,
           generation=commander_tenant_execution_control.generation+1,
           actor=EXCLUDED.actor,
           reason=NULL,
           resumed_at=now(),
           updated_at=now()
         RETURNING *`,
          [tenantId, actor],
        );
        const control = fromTenantExecutionControl(result.rows[0]!);
        await this.appendEvent(client, {
          aggregateType: 'tenant',
          aggregateId: tenantId,
          sequence: control.generation,
          type: 'tenant.resumed',
          tenantId,
          runId: `tenant:${tenantId}`,
          actor,
          payload: {},
        });
        return control;
      },
      [tenantId],
    );
  }

  async getTenantExecutionControl(tenantId: string): Promise<TenantExecutionControl> {
    return this.withTransaction(
      async (client) => {
        const result = await client.query<DbTenantExecutionControl>(
          'SELECT * FROM commander_tenant_execution_control WHERE tenant_id=$1',
          [tenantId],
        );
        return result.rows[0]
          ? fromTenantExecutionControl(result.rows[0])
          : { tenantId, paused: false, generation: 0, actor: 'kernel' };
      },
      [tenantId],
    );
  }

  async getOperationsReadiness(tenantId: string, at = new Date()): Promise<OperationsReadiness> {
    if (this.options.adapterOpsMode) {
      return this.withTransaction(
        async (client) => {
          const result = await client.query<{
            reconciliation_workers: string | number;
            compensation_workers: string | number;
            checked_at: string | Date;
          }>('SELECT * FROM get_operations_readiness($1)', [tenantId]);
          const row = result.rows[0];
          const reconciliationWorkers = Number(row?.reconciliation_workers ?? 0);
          const compensationWorkers = Number(row?.compensation_workers ?? 0);
          return {
            ready: reconciliationWorkers > 0 && compensationWorkers > 0,
            ...(reconciliationWorkers === 0
              ? { reason: 'RECONCILIATION_DRAIN_UNAVAILABLE' as const }
              : compensationWorkers === 0
                ? { reason: 'COMPENSATION_DRAIN_UNAVAILABLE' as const }
                : {}),
            reconciliationWorkers,
            compensationWorkers,
            checkedAt: iso(row?.checked_at ?? at),
          };
        },
        [tenantId],
      );
    }
    if (this.options.tenantContextAuthority) {
      return this.withTransaction(
        async (client) => {
          const result = await client.query<{
            reconciliation_workers: string | number;
            compensation_workers: string | number;
            checked_at: string | Date;
          }>('SELECT * FROM get_api_operations_readiness($1)', [tenantId]);
          const row = result.rows[0];
          const reconciliationWorkers = Number(row?.reconciliation_workers ?? 0);
          const compensationWorkers = Number(row?.compensation_workers ?? 0);
          return {
            ready: reconciliationWorkers > 0 && compensationWorkers > 0,
            ...(reconciliationWorkers === 0
              ? { reason: 'RECONCILIATION_DRAIN_UNAVAILABLE' as const }
              : compensationWorkers === 0
                ? { reason: 'COMPENSATION_DRAIN_UNAVAILABLE' as const }
                : {}),
            reconciliationWorkers,
            compensationWorkers,
            checkedAt: iso(row?.checked_at ?? at),
          };
        },
        [tenantId],
      );
    }
    return this.withTransaction(
      async (client) => this.readOperationsReadiness(client, tenantId, at, false),
      [tenantId],
    );
  }

  private async readOperationsReadiness(
    client: SqlClient,
    tenantId: string,
    at: Date,
    lockRows: boolean,
  ): Promise<OperationsReadiness> {
    const threshold = new Date(at.getTime() - OPERATIONS_HEARTBEAT_TTL_MS);
    const result = lockRows
      ? await client.query<{ capability: string; count: string | number }>(
          `SELECT w.capabilities->>0 AS capability, 1 AS count
         FROM commander_workers w
         WHERE w.status='ACTIVE'
           AND w.identity_subject='db:commander_adapter_ops'
           AND w.tenant_ids ? $1
           AND jsonb_array_length(w.capabilities)=1
           AND w.capabilities IN ('["effect.reconcile"]'::jsonb, '["effect.compensate"]'::jsonb)
           AND w.last_heartbeat_at > w.registered_at
           AND w.last_heartbeat_at >= $2
         FOR UPDATE`,
          [tenantId, threshold.toISOString()],
        )
      : await client.query<{ capability: string; count: string | number }>(
          `SELECT w.capabilities->>0 AS capability, COUNT(*) AS count
       FROM commander_workers w
       WHERE w.status='ACTIVE'
         AND w.identity_subject='db:commander_adapter_ops'
         AND w.tenant_ids ? $1
         AND jsonb_array_length(w.capabilities)=1
         AND w.capabilities IN ('["effect.reconcile"]'::jsonb, '["effect.compensate"]'::jsonb)
         AND w.last_heartbeat_at > w.registered_at
         AND w.last_heartbeat_at >= $2
       GROUP BY w.capabilities`,
          [tenantId, threshold.toISOString()],
        );
    const count = (capability: string) =>
      result.rows
        .filter((row) => row.capability === capability)
        .reduce((total, row) => total + Number(row.count), 0);
    const reconciliationWorkers = count('effect.reconcile');
    const compensationWorkers = count('effect.compensate');
    return {
      ready: reconciliationWorkers > 0 && compensationWorkers > 0,
      ...(reconciliationWorkers === 0
        ? { reason: 'RECONCILIATION_DRAIN_UNAVAILABLE' as const }
        : compensationWorkers === 0
          ? { reason: 'COMPENSATION_DRAIN_UNAVAILABLE' as const }
          : {}),
      reconciliationWorkers,
      compensationWorkers,
      checkedAt: at.toISOString(),
    };
  }

  async admitEffect(request: AdmitEffectRequest): Promise<AdmitEffectResult> {
    // Fail-closed: never let a blank policySnapshotId / lease.workerId slip
    // through to storage where it would otherwise coerce to 'legacy-unbound'.
    if (!request.policySnapshotId || !request.policySnapshotId.trim()) {
      return { admitted: false, reason: 'POLICY_SNAPSHOT_ID_REQUIRED' };
    }
    if (!request.lease.workerId || !request.lease.workerId.trim()) {
      return { admitted: false, reason: 'LEASE_WORKER_ID_REQUIRED' };
    }
    try {
      return await this.withTransaction(
        async (client) => {
          const isCompensation = request.type.toLowerCase().startsWith('compensate.');
          if (!this.options.schedulerMode) {
            if (isCompensation && this.options.adapterOpsMode) {
              // Route to the durable-evidence RPC whenever the binding carries the
              // request/outbox identifiers it resolves from. The legacy RPC stays
              // reachable for callers that still supply the sealed authorization in
              // run metadata and the outbox payload.
              const binding = request.compensationBinding;
              const requestClaimToken = binding?.requestClaimToken ?? binding?.claimToken;
              const outboxClaimToken = binding?.outboxClaimToken ?? binding?.claimToken;
              if (
                binding?.requestId &&
                binding.outboxMessageId &&
                requestClaimToken &&
                outboxClaimToken
              ) {
                return this.admitCompensationEffectViaDurableEvidence(client, {
                  ...request,
                  requestId: binding.requestId,
                  requestClaimToken,
                  outboxMessageId: binding.outboxMessageId,
                  outboxClaimToken,
                });
              }
              return this.admitCompensationEffectViaRpc(client, request);
            }
            const fingerprint = requestHash(request.request);
            const admissionSql = isClassAEffectType(request.type)
              ? `SELECT * FROM admit_class_a_effect(
               $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb
             )`
              : `SELECT * FROM admit_non_class_a_effect(
               $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb
             )`;
            const admitted = await client.query<{
              admitted: boolean;
              reason: string | null;
              replayed: boolean;
              effect: DbEffect | null;
            }>(admissionSql, [
              request.id,
              request.runId,
              request.stepId,
              request.tenantId,
              request.type,
              request.idempotencyKey,
              fingerprint,
              request.policyDecisionId,
              request.policySnapshotId,
              request.actionDigest,
              request.lease.workerId,
              request.lease.workerGeneration ?? -1,
              request.lease.token,
              request.lease.fencingEpoch,
              json(request.request),
            ]);
            const outcome = admitted.rows[0];
            if (!outcome?.admitted || !outcome.effect) {
              return {
                admitted: false,
                reason:
                  outcome?.reason === 'OPERATIONS_NOT_READY'
                    ? 'OPERATIONS_NOT_READY'
                    : outcome?.reason === 'IDEMPOTENCY_CONFLICT'
                      ? 'IDEMPOTENCY_CONFLICT'
                      : 'LEASE_LOST',
              };
            }
            const effect = fromEffect(outcome.effect);
            if (!outcome.replayed) {
              await this.appendEvent(client, {
                aggregateType: 'effect',
                aggregateId: effect.id,
                sequence: 1,
                type: 'effect.admitted',
                tenantId: effect.tenantId,
                runId: effect.runId,
                stepId: effect.stepId,
                actor: request.actor,
                payload: {
                  type: effect.type,
                  policyDecisionId: effect.policyDecisionId,
                  policySnapshotId: effect.policySnapshotId,
                  actionDigest: effect.actionDigest,
                },
              });
            }
            return { admitted: true, replayed: outcome.replayed, effect };
          }

          let step = await client.query<DbStep>(
            `SELECT * FROM commander_steps WHERE id=$1 AND run_id=$2 AND tenant_id=$3 AND state='RUNNING' AND lease_worker_id=$4 AND lease_worker_generation=$5 AND lease_token=$6 AND fencing_epoch=$7 AND lease_expires_at > now()
           AND EXISTS (SELECT 1 FROM commander_workers w WHERE w.id=$4 AND w.generation=$5)
         FOR UPDATE`,
            [
              request.stepId,
              request.runId,
              request.tenantId,
              request.lease.workerId,
              request.lease.workerGeneration ?? -1,
              request.lease.token,
              request.lease.fencingEpoch,
            ],
          );
          if (!step.rows[0] && request.type.startsWith('compensate.')) {
            // Compensation effects run after the forward step lease is gone; require COMPENSATING run.
            const run = await client.query<{ state: string }>(
              `SELECT state FROM commander_runs WHERE id=$1 AND tenant_id=$2 FOR UPDATE`,
              [request.runId, request.tenantId],
            );
            if (run.rows[0]?.state === 'COMPENSATING') {
              step = await client.query<DbStep>(
                `SELECT * FROM commander_steps WHERE id=$1 AND run_id=$2 AND tenant_id=$3 FOR UPDATE`,
                [request.stepId, request.runId, request.tenantId],
              );
            }
          }
          if (!step.rows[0]) return { admitted: false, reason: 'LEASE_LOST' };
          const fingerprint = requestHash(request.request);
          const existing = await client.query<DbEffect>(
            'SELECT * FROM commander_effects WHERE tenant_id=$1 AND idempotency_key=$2',
            [request.tenantId, request.idempotencyKey],
          );
          if (existing.rows[0]) {
            const prior = existing.rows[0];
            if (
              prior.run_id !== request.runId ||
              prior.step_id !== request.stepId ||
              prior.type !== request.type ||
              prior.request_hash !== fingerprint ||
              prior.policy_decision_id !== request.policyDecisionId ||
              prior.policy_snapshot_id !== request.policySnapshotId ||
              prior.action_digest !== request.actionDigest
            ) {
              return { admitted: false, reason: 'IDEMPOTENCY_CONFLICT' };
            }
            if (
              isClassAEffectType(request.type) &&
              !isCompensation &&
              prior.state !== 'COMPLETED'
            ) {
              if (this.enforceAtomicOperationsReadiness()) {
                return { admitted: false, reason: 'OPERATIONS_NOT_READY' };
              }
              if (!(await this.getOperationsReadiness(request.tenantId)).ready) {
                return { admitted: false, reason: 'OPERATIONS_NOT_READY' };
              }
            }
            return { admitted: true, replayed: true, effect: fromEffect(prior) };
          }
          if (isClassAEffectType(request.type) && !isCompensation) {
            if (this.enforceAtomicOperationsReadiness()) {
              // Scheduler/recovery repositories are not an effect-admission authority.
              return { admitted: false, reason: 'OPERATIONS_NOT_READY' };
            }
            if (!(await this.getOperationsReadiness(request.tenantId)).ready) {
              return { admitted: false, reason: 'OPERATIONS_NOT_READY' };
            }
          }
          const leaseWorkerGeneration = request.lease.workerGeneration ?? -1;
          const inserted = await client.query<DbEffect>(
            `INSERT INTO commander_effects (
           id, run_id, step_id, tenant_id, type, idempotency_key, request_hash,
           policy_decision_id, policy_snapshot_id, action_digest,
           lease_worker_id, lease_worker_generation, lease_fencing_epoch,
           state, request
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'ADMITTED',$14::jsonb
         ) RETURNING *`,
            [
              request.id,
              request.runId,
              request.stepId,
              request.tenantId,
              request.type,
              request.idempotencyKey,
              fingerprint,
              request.policyDecisionId,
              request.policySnapshotId,
              request.actionDigest,
              request.lease.workerId,
              leaseWorkerGeneration,
              request.lease.fencingEpoch,
              json(request.request),
            ],
          );
          const effect = fromEffect(inserted.rows[0]!);
          await this.appendEvent(client, {
            aggregateType: 'effect',
            aggregateId: effect.id,
            sequence: 1,
            type: 'effect.admitted',
            tenantId: effect.tenantId,
            runId: effect.runId,
            stepId: effect.stepId,
            actor: request.actor,
            payload: {
              type: effect.type,
              policyDecisionId: effect.policyDecisionId,
              policySnapshotId: effect.policySnapshotId,
              actionDigest: effect.actionDigest,
            },
          });
          return { admitted: true, replayed: false, effect };
        },
        [request.tenantId],
      );
    } catch (error) {
      // Generic app/worker repositories use the class-bound admission RPCs;
      // compensation is reserved for the adapter-ops lifecycle RPC. Preserve
      // the repository result contract when the database wrapper rejects it.
      if (error instanceof Error && error.message.includes('COMPENSATION_ADMISSION_UNAVAILABLE')) {
        return { admitted: false, reason: 'COMPENSATION_ADMISSION_UNAVAILABLE' };
      }
      throw error;
    }
  }

  private async completeEffectInTransaction(
    client: SqlClient,
    effectId: string,
    tenantId: string,
    lease: Pick<KernelLease, 'workerId' | 'workerGeneration' | 'token' | 'fencingEpoch'>,
    response: Record<string, unknown>,
    actor: string,
  ): Promise<KernelEffect | null> {
    let result = await client.query<DbEffect>(
      `UPDATE commander_effects e SET state='COMPLETED', response=$1::jsonb, completed_at=now()
       WHERE e.id=$2 AND e.tenant_id=$3 AND e.state='ADMITTED'
         AND EXISTS (SELECT 1 FROM commander_steps s WHERE s.id=e.step_id AND s.run_id=e.run_id AND s.tenant_id=e.tenant_id AND s.state='RUNNING' AND s.lease_worker_id=$4 AND s.lease_worker_generation=$5 AND s.lease_token=$6 AND s.fencing_epoch=$7 AND s.lease_expires_at > now())
         AND EXISTS (SELECT 1 FROM commander_workers w WHERE w.id=$4 AND w.generation=$5)
       RETURNING e.*`,
      [
        json(response),
        effectId,
        tenantId,
        lease.workerId,
        lease.workerGeneration ?? -1,
        lease.token,
        lease.fencingEpoch,
      ],
    );
    if (!result.rows[0]) {
      // compensate.* may complete while the run is COMPENSATING and the step lease is gone.
      result = await client.query<DbEffect>(
        `UPDATE commander_effects e SET state='COMPLETED', response=$1::jsonb, completed_at=now()
         WHERE e.id=$2 AND e.tenant_id=$3 AND e.state='ADMITTED' AND e.type LIKE 'compensate.%'
           AND EXISTS (SELECT 1 FROM commander_runs r WHERE r.id=e.run_id AND r.tenant_id=e.tenant_id AND r.state='COMPENSATING')
           AND e.lease_worker_id=$4 AND e.lease_worker_generation=$5 AND e.lease_fencing_epoch=$6
           AND EXISTS (SELECT 1 FROM commander_workers w WHERE w.id=$4 AND w.generation=$5)
         RETURNING e.*`,
        [
          json(response),
          effectId,
          tenantId,
          lease.workerId,
          lease.workerGeneration ?? -1,
          lease.fencingEpoch,
        ],
      );
    }
    if (!result.rows[0]) return null;
    const effect = fromEffect(result.rows[0]);
    await this.appendEvent(client, {
      aggregateType: 'effect',
      aggregateId: effect.id,
      sequence: 2,
      type: 'effect.completed',
      tenantId,
      runId: effect.runId,
      stepId: effect.stepId,
      actor,
      payload: {},
    });
    return effect;
  }

  async completeEffect(
    effectId: string,
    tenantId: string,
    lease: Pick<KernelLease, 'workerId' | 'workerGeneration' | 'token' | 'fencingEpoch'>,
    response: Record<string, unknown>,
    actor: string,
  ): Promise<KernelEffect | null> {
    return this.withTransaction(
      (client) =>
        this.completeEffectInTransaction(client, effectId, tenantId, lease, response, actor),
      [tenantId],
    );
  }

  async completeEffectWithEvidence(
    effectId: string,
    tenantId: string,
    lease: Pick<KernelLease, 'workerId' | 'workerGeneration' | 'token' | 'fencingEpoch'>,
    response: Record<string, unknown>,
    actor: string,
    evidence: KernelEvidenceRecord,
  ): Promise<KernelEffect | null> {
    return this.withTransaction(
      async (client) => {
        const effect = await this.completeEffectInTransaction(
          client,
          effectId,
          tenantId,
          lease,
          response,
          actor,
        );
        if (!effect) return null;
        assertEvidenceRecordBoundToEffect(evidence, effect);
        await this.appendEvidenceInTransaction(client, evidence);
        return effect;
      },
      [tenantId],
    );
  }

  async markEffectCompletionUnknown(
    request: MarkEffectCompletionUnknownRequest,
  ): Promise<KernelEffect | null> {
    return this.withTransaction(
      async (client) => {
        const unknownAt = new Date().toISOString();
        const policy = createReconcilePolicy({
          unknownAt,
          governedActionDeadlineAt: request.governedActionDeadlineAt,
        });
        const leasePredicate = request.lease
          ? `
           AND EXISTS (
             SELECT 1 FROM commander_runs r
              WHERE r.id=commander_effects.run_id
                AND r.tenant_id=commander_effects.tenant_id
                AND r.state='RUNNING'
           )
           AND EXISTS (
             SELECT 1 FROM commander_steps s
              WHERE s.id=commander_effects.step_id
                AND s.run_id=commander_effects.run_id
                AND s.tenant_id=commander_effects.tenant_id
                AND s.state='RUNNING'
                AND s.lease_worker_id=$10
                AND s.lease_worker_generation=$11
                AND s.lease_token=$12
                AND s.fencing_epoch=$13
                AND s.lease_expires_at > now()
           )
           AND EXISTS (SELECT 1 FROM commander_workers w WHERE w.id=$10 AND w.generation=$11)`
          : '';
        const result = await client.query<DbEffect>(
          `UPDATE commander_effects
         SET state='COMPLETION_UNKNOWN',
             response=jsonb_build_object('completionUnknownReason',$1::text),
             governed_action_deadline_at=$4::timestamptz,
             reconcile_max_attempts=$5,
             reconcile_initial_delay_ms=$6,
             reconcile_max_delay_ms=$7,
             reconcile_deadline_at=$8::timestamptz,
             reconcile_disposition='PENDING',
             reconcile_after=$9::timestamptz,
             reconcile_observed_at=NULL,
             reconcile_attempts=0,
             reconcile_last_error=NULL,
             reconcile_escalated_at=NULL,
             reconcile_escalation_code=NULL,
             reconcile_claim_token=NULL,
             reconcile_claim_expires_at=NULL,
             reconcile_claimed_at=NULL,
             reconcile_claim_worker_id=NULL,
             reconcile_claim_worker_generation=NULL
         WHERE id=$2 AND tenant_id=$3 AND state='ADMITTED'${leasePredicate} RETURNING *`,
          request.lease
            ? [
                request.reason,
                request.effectId,
                request.tenantId,
                request.governedActionDeadlineAt ?? null,
                policy.maxAttempts,
                policy.initialDelayMs,
                policy.maxDelayMs,
                policy.deadlineAt,
                unknownAt,
                request.lease.workerId,
                request.lease.workerGeneration ?? -1,
                request.lease.token,
                request.lease.fencingEpoch,
              ]
            : [
                request.reason,
                request.effectId,
                request.tenantId,
                request.governedActionDeadlineAt ?? null,
                policy.maxAttempts,
                policy.initialDelayMs,
                policy.maxDelayMs,
                policy.deadlineAt,
                unknownAt,
              ],
        );
        if (!result.rows[0]) return null;
        const effect = fromEffect(result.rows[0]);
        const releasedStep = await client.query(
          `UPDATE commander_steps
              SET state='WAITING_FOR_RECONCILIATION',
                  version=version+1,
                  lease_worker_id=NULL,
                  lease_worker_generation=0,
                  lease_token=NULL,
                  lease_expires_at=NULL,
                  updated_at=$1::timestamptz
            WHERE id=$2 AND run_id=$3 AND tenant_id=$4 AND state='RUNNING'`,
          [unknownAt, effect.stepId, effect.runId, request.tenantId],
        );
        if ((releasedStep.rowCount ?? 0) === 1) {
          await client.query(
            `UPDATE commander_tenant_execution_usage
                SET running_steps=GREATEST(0,running_steps-1), updated_at=$1::timestamptz
              WHERE tenant_id=$2`,
            [unknownAt, request.tenantId],
          );
        }
        await this.appendEvent(client, {
          aggregateType: 'effect',
          aggregateId: effect.id,
          sequence: 2,
          type: 'effect.completion_unknown',
          tenantId: effect.tenantId,
          runId: effect.runId,
          stepId: effect.stepId,
          actor: request.actor,
          payload: { reason: request.reason },
        });
        return effect;
      },
      [request.tenantId],
    );
  }

  async parkEffectCompletionUnknown(
    input: ParkEffectCompletionUnknownInput,
  ): Promise<ParkEffectCompletionUnknownResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<{ result: unknown }>(
        `SELECT park_effect_completion_unknown_v1(
           $1::text,$2::text,$3::jsonb,$4::text,$5::bigint,$6::text,$7::text,$8::bigint,$9::timestamptz
         ) AS result`,
        [
          input.tenantId,
          input.effectId,
          json(input.error),
          input.workerId,
          input.workerGeneration,
          input.claimSecret,
          input.leaseToken,
          input.fencingEpoch,
          input.governedActionDeadlineAt ?? null,
        ],
      );
      const raw = result.rows[0]?.result;
      if (raw == null) {
        await client.query('COMMIT');
        return { parked: false, reason: 'NOT_FOUND' };
      }
      const value = (typeof raw === 'string' ? JSON.parse(raw) : raw) as {
        parked?: boolean;
        replayed?: boolean;
        reason?: ParkEffectCompletionUnknownResult extends { parked: false; reason: infer R }
          ? R
          : never;
        effect?: DbEffect;
      };
      if (value.parked && value.effect && value.replayed !== true) {
        await client.query("SELECT set_config('app.tenant_scope',$1,true)", [input.tenantId]);
        await client.query(
          `UPDATE commander_tenant_execution_usage
              SET running_steps=GREATEST(0,running_steps-1), updated_at=now()
            WHERE tenant_id=$1`,
          [input.tenantId],
        );
      }
      await client.query('COMMIT');
      if (!value.parked || !value.effect) {
        return {
          parked: false,
          reason: value.reason ?? 'NOT_ADMITTED_OR_UNKNOWN',
        };
      }
      return {
        parked: true,
        replayed: value.replayed === true,
        effect: fromEffect(value.effect),
      };
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* preserve authority failure */
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async getEffect(effectId: string, tenantId: string): Promise<KernelEffect | null> {
    return this.withTransaction(
      async (client) => {
        const result = await client.query<DbEffect>(
          'SELECT * FROM commander_effects WHERE id=$1 AND tenant_id=$2',
          [effectId, tenantId],
        );
        return result.rows[0] ? fromEffect(result.rows[0]) : null;
      },
      [tenantId],
    );
  }

  async reconcileEffect(request: ReconcileEffectRequest): Promise<KernelEffect | null> {
    return this.withTransaction(
      async (client) => {
        const result = await client.query<DbEffect>(
          `UPDATE commander_effects SET state=$1, response=$2::jsonb, completed_at=now()
         WHERE id=$3 AND tenant_id=$4 AND state='COMPLETION_UNKNOWN'
         RETURNING *`,
          [request.state, json(request.response), request.effectId, request.tenantId],
        );
        if (!result.rows[0]) return null;
        const effect = fromEffect(result.rows[0]);
        await this.appendEvent(client, {
          aggregateType: 'effect',
          aggregateId: effect.id,
          sequence: 3,
          type:
            request.state === 'COMPLETED'
              ? 'effect.reconciled_completed'
              : 'effect.reconciled_failed',
          tenantId: effect.tenantId,
          runId: effect.runId,
          stepId: effect.stepId,
          actor: request.actor,
          payload: {},
        });
        return effect;
      },
      [request.tenantId],
    );
  }

  async requestReconcile(input: RequestReconcileInput): Promise<RequestReconcileResult> {
    return this.withTransaction(
      async (client) => {
        const result = await client.query<{ result: RequestReconcileResult | string | null }>(
          'SELECT request_reconcile_effect($1::text, $2::text, $3::text) AS result',
          [input.tenantId, input.effectId, input.actor],
        );
        const raw = result.rows[0]?.result;
        if (raw == null) return { scheduled: false, reason: 'NOT_FOUND' };
        return typeof raw === 'string' ? (JSON.parse(raw) as RequestReconcileResult) : raw;
      },
      [input.tenantId],
    );
  }

  async claimReconcileEffects(
    input: ClaimReconcileEffectsInput,
  ): Promise<ClaimedReconcileEffect[]> {
    // Worker / least-privilege path: DB-atomic SECURITY DEFINER RPC. Caller
    // cannot pass tenant scope — durable commander_workers.tenant_ids only.
    if (!this.options.schedulerMode) {
      return this.claimReconcileEffectsViaRpc(input);
    }

    const at = input.now ?? new Date();
    const claimTtlMs = input.claimTtlMs ?? 60_000;
    return this.withTransaction(async (client) => {
      const claimToken = randomUUID();
      const claimExpiresAt = new Date(at.getTime() + claimTtlMs).toISOString();
      const result = await client.query<DbEffect>(
        `WITH candidate AS (
           SELECT id FROM commander_effects
           WHERE state='COMPLETION_UNKNOWN'
             AND reconcile_escalated_at IS NULL
             AND reconcile_after IS NOT NULL
             AND reconcile_after <= $1::timestamptz
             AND (reconcile_claim_expires_at IS NULL OR reconcile_claim_expires_at < $1::timestamptz)
           ORDER BY reconcile_after ASC
           FOR UPDATE SKIP LOCKED
           LIMIT $2
         )
         UPDATE commander_effects e
         SET reconcile_claim_token=$3,
             reconcile_claim_expires_at=$4::timestamptz,
             reconcile_claimed_at=$1::timestamptz,
             reconcile_claim_worker_id='scheduler',
             reconcile_claim_worker_generation=1
         FROM candidate
         WHERE e.id=candidate.id
         RETURNING e.*`,
        [at.toISOString(), input.limit, claimToken, claimExpiresAt],
      );
      return result.rows.map((row) => ({
        effect: fromEffect(row),
        claimToken,
      }));
    });
  }

  /**
   * Worker reconcile claim via SECURITY DEFINER claim_reconcile_effects.
   * Does not set app.tenant_scope='*' and does not accept caller tenant scope.
   */
  private async claimReconcileEffectsViaRpc(
    input: ClaimReconcileEffectsInput,
  ): Promise<ClaimedReconcileEffect[]> {
    const workerId = input.workerId?.trim();
    if (!workerId) {
      throw new Error('claimReconcileEffects requires workerId on the worker LOGIN path');
    }
    const workerGeneration = input.workerGeneration;
    if (typeof workerGeneration !== 'number' || !Number.isFinite(workerGeneration)) {
      throw new Error(
        'claimReconcileEffects requires finite workerGeneration on the worker LOGIN path',
      );
    }
    const claimSecret = input.claimSecret ?? '';
    if (!claimSecret) {
      throw new Error('claimReconcileEffects requires claimSecret on the worker LOGIN path');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<{ claim_reconcile_effects: unknown }>(
        'SELECT claim_reconcile_effects($1::text, $2::bigint, $3::integer, $4::text) AS claim_reconcile_effects',
        [workerId, workerGeneration, input.limit, claimSecret],
      );
      await client.query('COMMIT');
      const raw = result.rows[0]?.claim_reconcile_effects;
      if (raw == null) return [];
      const rows = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Array<{
        effect: DbEffect;
        claimToken: string;
      }>;
      if (!Array.isArray(rows)) return [];
      return rows.map((entry) => ({
        effect: fromEffect(entry.effect),
        claimToken: entry.claimToken,
      }));
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* preserve claim error */
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async completeReconcileEffect(
    input: ReconcileClaimAuth & { response: Record<string, unknown> },
  ): Promise<ReconcileMutationResult> {
    return this.callReconcileMutationRpc('complete_reconcile_effect', input, input.response);
  }

  async confirmEffectNotApplied(
    input: ReconcileClaimAuth & { response: Record<string, unknown> },
  ): Promise<ReconcileMutationResult> {
    return this.callReconcileMutationRpc('confirm_effect_not_applied', input, input.response);
  }

  async rescheduleReconcileEffect(
    input: ReconcileClaimAuth & { lastError: ReconcileQueryError },
  ): Promise<ReconcileMutationResult> {
    return this.callReconcileMutationRpc('reschedule_reconcile_effect', input, input.lastError);
  }

  async escalateReconcileEffect(
    input: ReconcileClaimAuth & {
      reason:
        | 'RECONCILE_ADAPTER_NOT_FOUND'
        | 'RECONCILE_QUERY_UNSUPPORTED'
        | 'COMPENSATION_QUERY_UNSUPPORTED'
        | 'RECONCILE_POLICY_BACKFILL_REVIEW_REQUIRED';
    },
  ): Promise<ReconcileMutationResult> {
    return this.callReconcileMutationRpc('escalate_reconcile_effect', input, input.reason);
  }

  private async callReconcileMutationRpc(
    functionName:
      | 'complete_reconcile_effect'
      | 'confirm_effect_not_applied'
      | 'reschedule_reconcile_effect'
      | 'escalate_reconcile_effect',
    input: ReconcileClaimAuth,
    payload: Record<string, unknown> | ReconcileQueryError | string,
  ): Promise<ReconcileMutationResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<{ result: ReconcileMutationResult | string }>(
        `SELECT ${functionName}(
           $1::text,$2::text,$3::text,$4::bigint,$5::text,$6::text,$7::jsonb,$8::jsonb
         ) AS result`,
        [
          input.tenantId,
          input.effectId,
          input.workerId,
          input.workerGeneration,
          input.claimSecret,
          input.claimToken,
          json(payload),
          input.evidence ? json(input.evidence) : null,
        ],
      );
      await client.query('COMMIT');
      const raw = result.rows[0]?.result;
      if (raw == null) return { applied: false, reason: 'NOT_FOUND' };
      return typeof raw === 'string' ? (JSON.parse(raw) as ReconcileMutationResult) : raw;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* preserve mutation error */
      }
      if (error instanceof Error && error.message.includes('TERMINAL_EVIDENCE_REQUIRED')) {
        return { applied: false, reason: 'TERMINAL_EVIDENCE_REQUIRED' };
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async rescheduleReconcile(input: RescheduleReconcileInput): Promise<boolean> {
    return this.withTransaction(
      async (client) => {
        const result = await client.query(
          `UPDATE commander_effects
         SET reconcile_attempts=reconcile_attempts+1,
             reconcile_after=$1::timestamptz,
             reconcile_claim_token=NULL,
             reconcile_claim_expires_at=NULL,
             reconcile_last_error=COALESCE($2::jsonb, reconcile_last_error)
         WHERE id=$3 AND tenant_id=$4 AND state='COMPLETION_UNKNOWN'
           AND reconcile_claim_token=$5`,
          [
            input.reconcileAfter,
            input.lastError ? json(input.lastError) : null,
            input.effectId,
            input.tenantId,
            input.claimToken,
          ],
        );
        return (result.rowCount ?? 0) === 1;
      },
      [input.tenantId],
    );
  }

  async escalateReconcile(input: EscalateReconcileInput): Promise<boolean> {
    return this.withTransaction(
      async (client) => {
        const result = await client.query<DbEffect>(
          `UPDATE commander_effects
         SET reconcile_escalated_at=now(),
             reconcile_claim_token=NULL,
             reconcile_claim_expires_at=NULL,
             reconcile_last_error=jsonb_build_object('code','RECONCILE_ESCALATED','message',$1::text)
         WHERE id=$2 AND tenant_id=$3 AND state='COMPLETION_UNKNOWN'
           AND reconcile_claim_token=$4
         RETURNING *`,
          [input.reason, input.effectId, input.tenantId, input.claimToken],
        );
        if (!result.rows[0]) return false;
        const effect = fromEffect(result.rows[0]);
        await this.appendEvent(client, {
          aggregateType: 'effect',
          aggregateId: effect.id,
          sequence: 100 + effect.reconcileAttempts,
          type: 'effect.reconcile_escalated',
          tenantId: effect.tenantId,
          runId: effect.runId,
          stepId: effect.stepId,
          actor: 'reconciliation-daemon',
          payload: { reason: input.reason },
        });
        return true;
      },
      [input.tenantId],
    );
  }

  async releaseReconcileClaim(
    effectId: string,
    tenantId: string,
    claimToken: string,
  ): Promise<boolean> {
    return this.withTransaction(
      async (client) => {
        const result = await client.query(
          `UPDATE commander_effects
         SET reconcile_claim_token=NULL, reconcile_claim_expires_at=NULL
         WHERE id=$1 AND tenant_id=$2 AND reconcile_claim_token=$3`,
          [effectId, tenantId, claimToken],
        );
        return (result.rowCount ?? 0) === 1;
      },
      [tenantId],
    );
  }

  async failEffect(request: FailEffectRequest): Promise<KernelEffect | null> {
    return this.withTransaction(
      async (client) => {
        const result = await client.query<DbEffect>(
          `UPDATE commander_effects e
         SET state='FAILED', response=$1::jsonb, completed_at=now()
         WHERE e.id=$2 AND e.tenant_id=$3 AND e.state='ADMITTED'
           AND EXISTS (
             SELECT 1 FROM commander_steps s
             WHERE s.id=e.step_id AND s.run_id=e.run_id AND s.tenant_id=e.tenant_id
               AND s.state='RUNNING' AND s.lease_worker_id=$4
               AND s.lease_worker_generation=$5 AND s.lease_token=$6
               AND s.fencing_epoch=$7 AND s.lease_expires_at > now()
           )
           AND EXISTS (SELECT 1 FROM commander_workers w WHERE w.id=$4 AND w.generation=$5)
         RETURNING e.*`,
          [
            json(request.error),
            request.effectId,
            request.tenantId,
            request.lease.workerId,
            request.lease.workerGeneration ?? -1,
            request.lease.token,
            request.lease.fencingEpoch,
          ],
        );
        if (!result.rows[0]) return null;
        const effect = fromEffect(result.rows[0]);
        await this.appendEvent(client, {
          aggregateType: 'effect',
          aggregateId: effect.id,
          sequence: 2,
          type: 'effect.failed',
          tenantId: request.tenantId,
          runId: effect.runId,
          stepId: effect.stepId,
          actor: request.actor,
          payload: { error: request.error },
        });
        return effect;
      },
      [request.tenantId],
    );
  }

  async failEffectWithEvidence(
    request: FailEffectRequest & { evidence: KernelEvidenceRecord },
  ): Promise<KernelEffect | null> {
    return this.withTransaction(
      async (client) => {
        const result = await client.query<DbEffect>(
          `UPDATE commander_effects e
         SET state='FAILED', response=$1::jsonb, completed_at=now()
         WHERE e.id=$2 AND e.tenant_id=$3 AND e.state='ADMITTED'
           AND EXISTS (
             SELECT 1 FROM commander_steps s
             WHERE s.id=e.step_id AND s.run_id=e.run_id AND s.tenant_id=e.tenant_id
               AND s.state='RUNNING' AND s.lease_worker_id=$4
               AND s.lease_worker_generation=$5 AND s.lease_token=$6
               AND s.fencing_epoch=$7 AND s.lease_expires_at > now()
           )
           AND EXISTS (SELECT 1 FROM commander_workers w WHERE w.id=$4 AND w.generation=$5)
         RETURNING e.*`,
          [
            json(request.error),
            request.effectId,
            request.tenantId,
            request.lease.workerId,
            request.lease.workerGeneration ?? -1,
            request.lease.token,
            request.lease.fencingEpoch,
          ],
        );
        if (!result.rows[0]) return null;
        const effect = fromEffect(result.rows[0]);
        assertEvidenceRecordBoundToEffect(request.evidence, effect);
        await this.appendEvidenceInTransaction(client, request.evidence);
        await this.appendEvent(client, {
          aggregateType: 'effect',
          aggregateId: effect.id,
          sequence: 2,
          type: 'effect.failed',
          tenantId: request.tenantId,
          runId: effect.runId,
          stepId: effect.stepId,
          actor: request.actor,
          payload: { error: request.error },
        });
        return effect;
      },
      [request.tenantId],
    );
  }

  async createCompensationAuthorization(
    authorization: CompensationAuthorizationRecord,
  ): Promise<{ authorization: CompensationAuthorizationRecord; replayed: boolean }> {
    return this.withTransaction(
      async (client) => {
        const result = await client.query<{
          result: { authorization: CompensationAuthorizationRecord; replayed: boolean } | string;
        }>('SELECT create_compensation_authorization($1::jsonb) AS result', [json(authorization)]);
        const raw = result.rows[0]?.result;
        if (!raw) throw new Error('COMPENSATION_AUTHORIZATION_PERSISTENCE_FAILED');
        return typeof raw === 'string' ? JSON.parse(raw) : raw;
      },
      [authorization.tenantId],
    );
  }

  async getCompensationAuthorization(
    authorizationId: string,
    tenantId: string,
  ): Promise<CompensationAuthorizationRecord | null> {
    return this.withTransaction(
      async (client) => {
        const result = await client.query<{
          authorization: CompensationAuthorizationRecord | string | null;
        }>('SELECT get_compensation_authorization($1::text,$2::text) AS authorization', [
          authorizationId,
          tenantId,
        ]);
        const raw = result.rows[0]?.authorization;
        if (!raw) return null;
        const authorization =
          typeof raw === 'string' ? (JSON.parse(raw) as CompensationAuthorizationRecord) : raw;
        return {
          ...authorization,
          expiresAt: iso(authorization.expiresAt),
        };
      },
      [tenantId],
    );
  }

  async requestCompensation(input: RequestCompensationInput): Promise<RequestCompensationResult> {
    return this.withTransaction(
      async (client) => {
        const result = await client.query<{ result: RequestCompensationResult | string }>(
          'SELECT request_compensation($1::text,$2::text,$3::text) AS result',
          [input.tenantId, input.authorizationId, input.actor],
        );
        const raw = result.rows[0]?.result;
        if (!raw) throw new Error('COMPENSATION_REQUEST_PERSISTENCE_FAILED');
        const value = (
          typeof raw === 'string' ? JSON.parse(raw) : raw
        ) as RequestCompensationResult;
        if (!value.accepted) return value;
        return {
          ...value,
          request: fromCompensationRequest(value.request as unknown as Record<string, unknown>),
        };
      },
      [input.tenantId],
    );
  }

  async claimCompensationRequest(
    input: ClaimCompensationRequestInput,
  ): Promise<ClaimedCompensationRequest | null> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<{ result: ClaimedCompensationRequest | string | null }>(
        `SELECT claim_compensation_request_v2($1::text,$2::text,$3::text,$4::bigint,$5::text) AS result`,
        [
          input.requestId,
          input.outboxMessageId,
          input.workerId,
          input.workerGeneration,
          input.claimSecret,
        ],
      );
      const raw = result.rows[0]?.result;
      return raw == null ? null : typeof raw === 'string' ? JSON.parse(raw) : raw;
    } finally {
      client.release();
    }
  }

  async admitCompensationEffect(
    input: AdmitEffectRequest & {
      requestId: string;
      requestClaimToken: string;
      outboxMessageId: string;
      outboxClaimToken: string;
    },
  ): Promise<AdmitEffectResult> {
    const client = await this.pool.connect();
    try {
      return await this.admitCompensationEffectViaDurableEvidence(client, input);
    } finally {
      client.release();
    }
  }

  async parkCompensationUnknown(
    input: ParkCompensationRequestUnknownInput,
  ): Promise<CompensationMutationResult> {
    return this.callTask3CompensationMutation('park_compensation_unknown', input);
  }

  async finalizeCompensation(
    input: FinalizeCompensationInput,
  ): Promise<CompensationMutationResult> {
    return this.callTask3CompensationMutation('finalize_compensation', input);
  }

  private async callTask3CompensationMutation(
    functionName: 'park_compensation_unknown' | 'finalize_compensation',
    input: ParkCompensationRequestUnknownInput | FinalizeCompensationInput,
  ): Promise<CompensationMutationResult> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<{ result: CompensationMutationResult | string }>(
        `SELECT ${functionName}($1::jsonb) AS result`,
        [json(input)],
      );
      const raw = result.rows[0]?.result;
      return raw
        ? typeof raw === 'string'
          ? JSON.parse(raw)
          : raw
        : { applied: false, reason: 'NOT_FOUND' };
    } catch (error) {
      if (error instanceof Error && error.message.includes('TERMINAL_EVIDENCE_REQUIRED')) {
        return { applied: false, reason: 'TERMINAL_EVIDENCE_REQUIRED' };
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async claimOutbox(limit: number, now = new Date()): Promise<KernelOutboxMessage[]> {
    if (!this.options.schedulerMode) {
      throw new Error(
        'claimOutbox requires schedulerMode repository; worker LOGIN must use claimOutboxByTopic with claim authz',
      );
    }
    return this.withTransaction(async (client) => {
      const token = randomUUID();
      const result = await client.query<{
        id: string;
        event_id: string;
        tenant_id: string;
        topic: string;
        key: string;
        payload: Record<string, unknown>;
        attempts: number;
        available_at: Date | string;
        published_at: Date | string | null;
        created_at: Date | string;
      }>(
        `WITH candidate AS (SELECT id FROM commander_outbox WHERE published_at IS NULL AND moved_to_dlq_at IS NULL AND attempts < max_attempts AND available_at <= $1 AND (claimed_at IS NULL OR claimed_at < $2) AND topic NOT IN ($5, $6) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $3)
         UPDATE commander_outbox o SET claimed_at=$1, claim_token=$4, attempts=o.attempts+1 FROM candidate WHERE o.id=candidate.id RETURNING o.*`,
        [
          now.toISOString(),
          new Date(now.getTime() - 60_000).toISOString(),
          limit,
          token,
          KERNEL_COMPENSATION_TOPIC,
          LEGACY_COMPENSATION_TOPIC,
        ],
      );
      return result.rows.map((row) => ({
        id: row.id,
        eventId: row.event_id,
        tenantId: row.tenant_id,
        topic: row.topic,
        key: row.key,
        payload: row.payload ?? {},
        attempts: Number(row.attempts),
        availableAt: iso(row.available_at),
        publishedAt: row.published_at ? iso(row.published_at) : undefined,
        claimToken: token,
        createdAt: iso(row.created_at),
      }));
    });
  }
  async markOutboxPublished(
    messageId: string,
    claimToken: string,
    tenantId?: string,
  ): Promise<boolean> {
    const scope = this.resolveOutboxMutationScope(tenantId);
    return this.withTransaction(async (client) => {
      const result = await client.query(
        `UPDATE commander_outbox SET published_at=now(), claim_token=NULL, claimed_at=NULL WHERE id=$1 AND claim_token=$2 AND published_at IS NULL`,
        [messageId, claimToken],
      );
      return (result.rowCount ?? 0) === 1;
    }, scope);
  }

  async retryOutbox(
    messageId: string,
    claimToken: string,
    error: { code: string; message: string },
    now = new Date(),
    tenantId?: string,
  ): Promise<boolean> {
    const scope = this.resolveOutboxMutationScope(tenantId);
    return this.withTransaction(async (client) => {
      const result = await client.query(
        `UPDATE commander_outbox SET
           available_at=$1::timestamptz + (POWER(2, GREATEST(0, attempts-1)) * interval '1 second'),
           last_error=$2::jsonb, claim_token=NULL, claimed_at=NULL
         WHERE id=$3 AND claim_token=$4 AND published_at IS NULL`,
        [now.toISOString(), json(error), messageId, claimToken],
      );
      return (result.rowCount ?? 0) === 1;
    }, scope);
  }

  // ── WS2 EffectBroker monopoly ─────────────────────────────────────────────

  async claimOutboxByTopic(
    topic: string,
    limit: number,
    now = new Date(),
    authz?: { workerId: string; workerGeneration: number; claimSecret: string },
  ): Promise<KernelOutboxMessage[]> {
    if (!this.options.schedulerMode) {
      return this.claimOutboxByTopicViaRpc(topic, limit, now, authz);
    }
    return this.withTransaction(async (client) => {
      const token = randomUUID();
      const result = await client.query<{
        id: string;
        event_id: string;
        tenant_id: string;
        topic: string;
        key: string;
        payload: Record<string, unknown>;
        attempts: number;
        available_at: Date | string;
        published_at: Date | string | null;
        created_at: Date | string;
      }>(
        `WITH candidate AS (SELECT id FROM commander_outbox WHERE topic=$1 AND published_at IS NULL AND moved_to_dlq_at IS NULL AND attempts < max_attempts AND available_at <= $2 AND (claimed_at IS NULL OR claimed_at < $3) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $4)
         UPDATE commander_outbox o SET claimed_at=$2, claim_token=$5, attempts=o.attempts+1 FROM candidate WHERE o.id=candidate.id RETURNING o.*`,
        [topic, now.toISOString(), new Date(now.getTime() - 60_000).toISOString(), limit, token],
      );
      return result.rows.map((row) => ({
        id: row.id,
        eventId: row.event_id,
        tenantId: row.tenant_id,
        topic: row.topic,
        key: row.key,
        payload: row.payload ?? {},
        attempts: Number(row.attempts),
        availableAt: iso(row.available_at),
        publishedAt: row.published_at ? iso(row.published_at) : undefined,
        claimToken: token,
        createdAt: iso(row.created_at),
      }));
    });
  }

  async claimCompensationWork(
    input: CompensationClaimAuth & { topic: typeof KERNEL_COMPENSATION_TOPIC; limit: number },
  ): Promise<ClaimedCompensationWork[]> {
    if (input.topic !== KERNEL_COMPENSATION_TOPIC) return [];
    const claimed: ClaimedCompensationWork[] = [];
    // A concurrent publisher/consumer can transiently hold the next eligible
    // outbox/request row. Do not treat one SKIP LOCKED miss as exhaustion: it
    // caused the race test to consume only the first batch and strand the rest.
    let misses = 0;
    const maxMisses = Math.max(3, input.limit);
    let attempts = 0;
    while (
      claimed.length < input.limit &&
      misses < maxMisses &&
      attempts < input.limit + maxMisses
    ) {
      attempts += 1;
      const result = await this.claimCompensationRequest({
        requestId: '',
        outboxMessageId: '',
        workerId: input.workerId,
        workerGeneration: input.workerGeneration,
        claimSecret: input.claimSecret,
      });
      if (!result) {
        misses += 1;
        continue;
      }
      misses = 0;
      claimed.push(result);
    }
    return claimed;
  }

  /** Worker LOGIN outbox claim via SECURITY DEFINER claim_outbox_by_topic. */
  private async claimOutboxByTopicViaRpc(
    topic: string,
    limit: number,
    now: Date,
    authz?: { workerId: string; workerGeneration: number; claimSecret: string },
  ): Promise<KernelOutboxMessage[]> {
    const workerId = authz?.workerId?.trim();
    const claimSecret = authz?.claimSecret ?? '';
    const workerGeneration = authz?.workerGeneration;
    if (!workerId) {
      throw new Error('claimOutboxByTopic requires workerId on the worker LOGIN path');
    }
    if (typeof workerGeneration !== 'number' || !Number.isFinite(workerGeneration)) {
      throw new Error(
        'claimOutboxByTopic requires finite workerGeneration on the worker LOGIN path',
      );
    }
    if (!claimSecret) {
      throw new Error('claimOutboxByTopic requires claimSecret on the worker LOGIN path');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<{ claim_outbox_by_topic: unknown }>(
        'SELECT claim_outbox_by_topic($1::text, $2::bigint, $3::text, $4::integer, $5::timestamptz, $6::text) AS claim_outbox_by_topic',
        [workerId, workerGeneration, topic, limit, now.toISOString(), claimSecret],
      );
      await client.query('COMMIT');
      const raw = result.rows[0]?.claim_outbox_by_topic;
      if (raw == null) return [];
      const payload = (typeof raw === 'string' ? JSON.parse(raw) : raw) as {
        claimToken?: string;
        rows?: Array<Record<string, unknown>>;
      };
      const token = typeof payload.claimToken === 'string' ? payload.claimToken : '';
      const rows = Array.isArray(payload.rows) ? payload.rows : [];
      return rows.map((row) => ({
        id: String(row.id),
        eventId: String(row.event_id),
        tenantId: String(row.tenant_id),
        topic: String(row.topic),
        key: String(row.key),
        payload: (row.payload as Record<string, unknown>) ?? {},
        attempts: Number(row.attempts),
        availableAt: iso(row.available_at as Date | string),
        publishedAt: row.published_at ? iso(row.published_at as Date | string) : undefined,
        claimToken: token,
        createdAt: iso(row.created_at as Date | string),
      }));
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* preserve claim error */
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /** Worker mutations need an explicit tenant; scheduler may use empty → '*'. */
  private resolveOutboxMutationScope(tenantId?: string): string[] {
    if (this.options.schedulerMode) {
      return tenantId?.trim() ? [tenantId.trim()] : [];
    }
    const tid = tenantId?.trim();
    if (!tid) {
      throw new Error(
        'Outbox mark/retry requires tenantId on the worker LOGIN path (message.tenantId)',
      );
    }
    return [tid];
  }

  async isCapabilityRevoked(jti: string, tenantId: string): Promise<boolean> {
    return this.withTransaction(
      async (client) => {
        if (this.options.adapterOpsMode) {
          const result = await client.query<{ read_capability_revocation_v1: boolean }>(
            `SELECT public.read_capability_revocation_v1($1::text, $2::text)
               AS read_capability_revocation_v1`,
            [tenantId, jti],
          );
          return result.rows[0]?.read_capability_revocation_v1 === true;
        }
        const result = await client.query(
          `SELECT 1 FROM commander_capability_revocations WHERE jti=$1 AND tenant_id=$2 AND expires_at > now()`,
          [jti, tenantId],
        );
        return (result.rowCount ?? 0) > 0;
      },
      [tenantId],
    );
  }

  async revokeCapability(input: {
    jti: string;
    tenantId: string;
    expiresAt: string;
    reason?: string;
  }): Promise<void> {
    await this.withTransaction(
      async (client) => {
        await client.query(
          `INSERT INTO commander_capability_revocations (jti, tenant_id, expires_at, reason) VALUES ($1, $2, $3, $4)
           ON CONFLICT (tenant_id, jti) DO UPDATE SET expires_at = EXCLUDED.expires_at, reason = EXCLUDED.reason`,
          [input.jti, input.tenantId, input.expiresAt, input.reason ?? null],
        );
      },
      [input.tenantId],
    );
  }

  async consumeCapabilityReplay(input: {
    tenantId: string;
    jti: string;
    nonce: string;
    expiresAt: string;
  }): Promise<boolean> {
    return this.withTransaction(
      async (client) => {
        if (this.options.adapterOpsMode) {
          const result = await client.query<{ consume_capability_replay_v1: boolean }>(
            `SELECT public.consume_capability_replay_v1(
               $1::text, $2::text, $3::text, $4::timestamptz
             ) AS consume_capability_replay_v1`,
            [input.tenantId, input.jti, input.nonce, input.expiresAt],
          );
          return result.rows[0]?.consume_capability_replay_v1 === true;
        }
        const result = await client.query<{ jti: string }>(
          `INSERT INTO commander_capability_replays (tenant_id, jti, nonce, expires_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING
         RETURNING jti`,
          [input.tenantId, input.jti, input.nonce, input.expiresAt],
        );
        // Empty RETURNING ⇒ conflict ⇒ already consumed (replay).
        return (result.rowCount ?? 0) === 0;
      },
      [input.tenantId],
    );
  }

  async isActionAllowed(tenantId: string, action: string): Promise<boolean> {
    return this.withTransaction(
      async (client) => {
        // Match exact + wildcard patterns. A row is considered a match if
        // action = action_pattern OR action_pattern ends with '.*' and action
        // starts with the prefix. Fail-closed: no matching row ⇒ deny.
        const result = await client.query<{ allowed: boolean }>(
          `SELECT allowed FROM commander_effect_allowlist
         WHERE tenant_id=$1 AND ($2 = action_pattern OR (action_pattern LIKE '%.*' AND $2 LIKE replace(action_pattern, '*', '%')))
         ORDER BY (action_pattern = $2) DESC, length(action_pattern) DESC LIMIT 1`,
          [tenantId, action],
        );
        if (!result.rows[0]) return false;
        return result.rows[0].allowed;
      },
      [tenantId],
    );
  }

  async setAllowlistEntry(
    tenantId: string,
    actionPattern: string,
    allowed: boolean,
  ): Promise<void> {
    await this.withTransaction(
      async (client) => {
        await client.query(
          `INSERT INTO commander_effect_allowlist (tenant_id, action_pattern, allowed) VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, action_pattern) DO UPDATE SET allowed = EXCLUDED.allowed`,
          [tenantId, actionPattern, allowed],
        );
      },
      [tenantId],
    );
  }

  async ensureAllowlistDefault(
    tenantId: string,
    actionPattern: string,
    allowed: boolean,
  ): Promise<void> {
    await this.withTransaction(
      async (client) => {
        await client.query(
          `INSERT INTO commander_effect_allowlist (tenant_id, action_pattern, allowed) VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, action_pattern) DO NOTHING`,
          [tenantId, actionPattern, allowed],
        );
      },
      [tenantId],
    );
  }

  async incrementQuota(input: {
    tenantId: string;
    actionClass: string;
    tokensUsed?: number;
    now?: Date;
  }): Promise<{ countUsed: number; tokensUsed: number }> {
    const day = (input.now ?? new Date()).toISOString().slice(0, 10);
    const tokens = input.tokensUsed ?? 0;
    return this.withTransaction(
      async (client) => {
        const result = await client.query<{ count_used: number; tokens_used: string }>(
          `INSERT INTO commander_effect_quota (tenant_id, action_class, day, count_used, tokens_used) VALUES ($1, $2, $3::date, 1, $4)
         ON CONFLICT (tenant_id, action_class, day) DO UPDATE SET count_used = commander_effect_quota.count_used + 1, tokens_used = commander_effect_quota.tokens_used + $4
         RETURNING count_used, tokens_used`,
          [input.tenantId, input.actionClass, day, tokens],
        );
        return {
          countUsed: result.rows[0]!.count_used,
          tokensUsed: Number(result.rows[0]!.tokens_used),
        };
      },
      [input.tenantId],
    );
  }

  async getQuota(
    tenantId: string,
    actionClass: string,
    now?: Date,
  ): Promise<{ countUsed: number; tokensUsed: number }> {
    const day = (now ?? new Date()).toISOString().slice(0, 10);
    return this.withTransaction(
      async (client) => {
        const result = await client.query<{ count_used: number; tokens_used: string }>(
          `SELECT count_used, tokens_used FROM commander_effect_quota WHERE tenant_id=$1 AND action_class=$2 AND day=$3::date`,
          [tenantId, actionClass, day],
        );
        if (!result.rows[0]) return { countUsed: 0, tokensUsed: 0 };
        return {
          countUsed: result.rows[0].count_used,
          tokensUsed: Number(result.rows[0].tokens_used),
        };
      },
      [tenantId],
    );
  }

  async putKillSwitch(input: PutKillSwitchInput): Promise<KillSwitch> {
    return this.withTransaction(
      async (client) => {
        const result = await client.query<{
          tenant_id: string;
          scope: string;
          value: string;
          enabled: boolean;
          reason: string | null;
          actor: string;
          updated_at: Date | string;
        }>(
          `INSERT INTO commander_action_kill_switches (tenant_id, scope, value, enabled, reason, actor, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (tenant_id, scope, value) DO UPDATE
           SET enabled = EXCLUDED.enabled,
               reason = EXCLUDED.reason,
               actor = EXCLUDED.actor,
               updated_at = now()
         RETURNING tenant_id, scope, value, enabled, reason, actor, updated_at`,
          [
            input.tenantId,
            input.scope,
            input.value,
            input.enabled,
            input.reason ?? null,
            input.actor,
          ],
        );
        return mapKillSwitch(result.rows[0]!);
      },
      [input.tenantId],
    );
  }

  async removeKillSwitch(input: RemoveKillSwitchInput): Promise<void> {
    await this.withTransaction(
      async (client) => {
        await client.query(
          `DELETE FROM commander_action_kill_switches WHERE tenant_id=$1 AND scope=$2 AND value=$3`,
          [input.tenantId, input.scope, input.value],
        );
      },
      [input.tenantId],
    );
  }

  async listKillSwitches(tenantId: string): Promise<KillSwitch[]> {
    return this.withTransaction(
      async (client) => {
        const result = await client.query<{
          tenant_id: string;
          scope: string;
          value: string;
          enabled: boolean;
          reason: string | null;
          actor: string;
          updated_at: Date | string;
        }>(
          `SELECT tenant_id, scope, value, enabled, reason, actor, updated_at
         FROM commander_action_kill_switches
         WHERE tenant_id=$1
         ORDER BY scope, value`,
          [tenantId],
        );
        return result.rows.map((row) => mapKillSwitch(row));
      },
      [tenantId],
    );
  }

  async findMatchingKillSwitch(
    tenantId: string,
    dims: KillSwitchMatchDims,
  ): Promise<KillSwitch | null> {
    return findMatchingKillSwitchWithLookup(tenantId, dims, (id) => this.listKillSwitches(id));
  }

  async listEvents(runId: string, tenantId: string): Promise<KernelEvent[]> {
    return this.withTransaction(
      async (client) => {
        const result = await client.query<{
          id: string;
          aggregate_type: KernelEvent['aggregateType'];
          aggregate_id: string;
          sequence: number;
          type: string;
          tenant_id: string;
          run_id: string;
          step_id: string | null;
          causation_id: string | null;
          correlation_id: string | null;
          actor: string;
          schema_version: string;
          payload: Record<string, unknown> | null;
          occurred_at: Date | string;
        }>(
          `SELECT * FROM commander_events WHERE run_id=$1 AND tenant_id=$2 ORDER BY occurred_at, sequence`,
          [runId, tenantId],
        );
        return result.rows.map((row) => ({
          eventId: row.id,
          aggregateType: row.aggregate_type,
          aggregateId: row.aggregate_id,
          sequence: Number(row.sequence),
          type: row.type,
          tenantId: row.tenant_id,
          runId: row.run_id,
          stepId: row.step_id ?? undefined,
          causationId: row.causation_id ?? undefined,
          correlationId: row.correlation_id ?? undefined,
          actor: row.actor,
          schemaVersion: row.schema_version,
          payload: row.payload ?? {},
          occurredAt: iso(row.occurred_at),
        }));
      },
      [tenantId],
    );
  }

  async listEffectsForRun(runId: string, tenantId: string): Promise<KernelEffect[]> {
    return this.withTransaction(
      async (client) => {
        const result = await client.query<DbEffect>(
          `SELECT * FROM commander_effects WHERE run_id=$1 AND tenant_id=$2 ORDER BY created_at, id`,
          [runId, tenantId],
        );
        return result.rows.map((row) => fromEffect(row));
      },
      [tenantId],
    );
  }

  async getAdapterOpsEvidenceContext(
    input: AdapterOpsEvidenceContextRequest,
  ): Promise<AdapterOpsEvidenceContext> {
    if (!this.options.adapterOpsMode) {
      throw new Error('ADAPTER_OPS_EVIDENCE_AUTHORITY_REQUIRED');
    }
    if (
      !input.workerId.trim() ||
      !Number.isSafeInteger(input.workerGeneration) ||
      input.workerGeneration <= 0 ||
      !input.claimSecret ||
      !input.tenantId ||
      !input.runId ||
      !input.effectId ||
      !input.claimToken
    ) {
      throw new Error('ADAPTER_OPS_EVIDENCE_CONTEXT_INVALID');
    }
    const client = await this.pool.connect();
    try {
      const result = await client.query<{
        result:
          | {
              effect: AdapterOpsEvidenceContext['effect'];
              events: Array<{
                type: string;
                tenant_id: string;
                run_id: string;
                step_id: string | null;
                aggregate_id: string;
                occurred_at: Date | string;
                payload: Record<string, unknown> | null;
              }>;
              evidence: DbEvidence | null;
            }
          | string
          | null;
      }>(
        `SELECT read_adapter_ops_evidence_context(
           $1::text,$2::bigint,$3::text,$4::text,$5::text,$6::text,$7::text
         ) AS result`,
        [
          input.workerId,
          input.workerGeneration,
          input.claimSecret,
          input.tenantId,
          input.runId,
          input.effectId,
          input.claimToken,
        ],
      );
      const raw = result.rows[0]?.result;
      if (raw == null) throw new Error('ADAPTER_OPS_EVIDENCE_CONTEXT_DENIED');
      const context =
        typeof raw === 'string'
          ? (JSON.parse(raw) as {
              effect: AdapterOpsEvidenceContext['effect'];
              events: Array<{
                type: string;
                tenant_id: string;
                run_id: string;
                step_id: string | null;
                aggregate_id: string;
                occurred_at: Date | string;
                payload: Record<string, unknown> | null;
              }>;
              evidence: DbEvidence | null;
            })
          : raw;
      if (!context?.effect || !Array.isArray(context.events)) {
        throw new Error('ADAPTER_OPS_EVIDENCE_CONTEXT_INVALID');
      }
      return {
        effect: {
          ...context.effect,
          createdAt: iso(context.effect.createdAt),
          ...(context.effect.completedAt ? { completedAt: iso(context.effect.completedAt) } : {}),
        },
        events: context.events.map((event) => ({
          type: event.type,
          tenantId: event.tenant_id,
          runId: event.run_id,
          ...(event.step_id ? { stepId: event.step_id } : {}),
          aggregateId: event.aggregate_id,
          occurredAt: iso(event.occurred_at),
          payload: event.payload ?? {},
        })),
        evidence: context.evidence ? fromEvidence(context.evidence) : null,
      };
    } finally {
      client.release();
    }
  }

  async completeCompensationEffectWithEvidence(
    input: AdapterOpsCompensationTerminalEvidenceBinding & {
      response: Record<string, unknown>;
    },
  ): Promise<KernelEffect | null> {
    return this.callAdapterOpsCompensationTerminalEvidence(
      'complete_compensation_effect_with_evidence',
      input,
    );
  }

  async failCompensationEffectWithEvidence(
    input: AdapterOpsCompensationTerminalEvidenceBinding & {
      error: {
        code: string;
        message: string;
        retryable: boolean;
        details?: Record<string, unknown>;
      };
    },
  ): Promise<KernelEffect | null> {
    return this.callAdapterOpsCompensationTerminalEvidence(
      'fail_compensation_effect_with_evidence',
      input,
    );
  }

  private async callAdapterOpsCompensationTerminalEvidence(
    rpc: 'complete_compensation_effect_with_evidence' | 'fail_compensation_effect_with_evidence',
    input: AdapterOpsCompensationTerminalEvidenceBinding & {
      response?: Record<string, unknown>;
      error?: {
        code: string;
        message: string;
        retryable: boolean;
        details?: Record<string, unknown>;
      };
    },
  ): Promise<KernelEffect | null> {
    if (!this.options.adapterOpsMode) {
      throw new Error('ADAPTER_OPS_COMPENSATION_TERMINAL_AUTHORITY_REQUIRED');
    }
    if (
      !input.workerId.trim() ||
      !Number.isSafeInteger(input.workerGeneration) ||
      input.workerGeneration <= 0 ||
      !input.claimSecret ||
      !input.tenantId ||
      !input.runId ||
      !input.stepId ||
      !input.effectId ||
      !input.requestId ||
      !input.requestClaimToken ||
      !input.outboxMessageId ||
      !input.outboxClaimToken ||
      !input.lease.workerId ||
      !Number.isSafeInteger(input.lease.workerGeneration) ||
      (input.lease.workerGeneration ?? 0) <= 0 ||
      !input.lease.token ||
      !Number.isSafeInteger(input.lease.fencingEpoch) ||
      input.lease.fencingEpoch <= 0 ||
      input.actor !== input.workerId
    ) {
      throw new Error('ADAPTER_OPS_COMPENSATION_TERMINAL_INPUT_INVALID');
    }
    const client = await this.pool.connect();
    try {
      const result = await client.query<{ result: DbEffect | string | null }>(
        `SELECT ${rpc}($1::jsonb) AS result`,
        [json(input)],
      );
      const raw = result.rows[0]?.result;
      if (raw == null) return null;
      return fromEffect(typeof raw === 'string' ? JSON.parse(raw) : raw);
    } finally {
      client.release();
    }
  }

  private async appendEvidenceInTransaction(
    client: SqlClient,
    record: KernelEvidenceRecord,
  ): Promise<{ inserted: boolean }> {
    const inserted = await client.query<DbEvidence>(
      `INSERT INTO commander_evidence_receipts
           (tenant_id, run_id, bundle_id, action_digest, body, content_hash, signature,
            created_at, anchored_at, retention_until)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8::timestamptz,$9::timestamptz,$10::timestamptz)
         ON CONFLICT (tenant_id, bundle_id) DO NOTHING
         RETURNING *`,
      [
        record.tenantId,
        record.runId,
        record.bundleId,
        record.actionDigest,
        json(record.body),
        record.contentHash,
        json(record.signature),
        record.createdAt,
        record.anchoredAt,
        record.retentionUntil,
      ],
    );
    if (inserted.rows[0]) return { inserted: true };

    const existing = await client.query<DbEvidence>(
      `SELECT * FROM commander_evidence_receipts
       WHERE tenant_id=$1 AND bundle_id=$2`,
      [record.tenantId, record.bundleId],
    );
    if (!existing.rows[0] || canonical(fromEvidence(existing.rows[0])) !== canonical(record)) {
      throw new Error('EVIDENCE_CONFLICT');
    }
    return { inserted: false };
  }

  async appendEvidence(record: KernelEvidenceRecord): Promise<{ inserted: boolean }> {
    return this.withTransaction(
      (client) => this.appendEvidenceInTransaction(client, record),
      [record.tenantId],
    );
  }

  async getEvidence(runId: string, tenantId: string): Promise<KernelEvidenceRecord | null> {
    return this.withTransaction(
      async (client) => {
        const result = await client.query<DbEvidence>(
          `SELECT * FROM commander_evidence_receipts
         WHERE run_id=$1 AND tenant_id=$2
         ORDER BY created_at DESC, bundle_id DESC
         LIMIT 1`,
          [runId, tenantId],
        );
        return result.rows[0] ? fromEvidence(result.rows[0]) : null;
      },
      [tenantId],
    );
  }

  async listEvidence(tenantId: string): Promise<KernelEvidenceRecord[]> {
    return this.withTransaction(
      async (client) => {
        const result = await client.query<DbEvidence>(
          `SELECT * FROM commander_evidence_receipts
         WHERE tenant_id=$1 ORDER BY created_at, bundle_id`,
          [tenantId],
        );
        return result.rows.map(fromEvidence);
      },
      [tenantId],
    );
  }

  async checkEvidenceRepositoryAvailability(): Promise<{ ready: boolean }> {
    let client: SqlClient | null = null;
    try {
      // This is a global catalog probe used before a tenant is known. Keep it
      // outside withTransaction: that helper intentionally rejects an empty
      // tenant scope for API-role repositories.
      client = await this.pool.connect();
      const result = await client.query<{
        available: boolean;
        context_rpc?: boolean;
        terminal_complete_rpc?: boolean;
        terminal_fail_rpc?: boolean;
      }>(
        this.options.adapterOpsMode
          ? `SELECT
               to_regclass('public.commander_evidence_receipts') IS NOT NULL AS available,
               to_regprocedure('public.read_adapter_ops_evidence_context(text,bigint,text,text,text,text,text)') IS NOT NULL AS context_rpc,
               to_regprocedure('public.complete_compensation_effect_with_evidence(jsonb)') IS NOT NULL AS terminal_complete_rpc,
               to_regprocedure('public.fail_compensation_effect_with_evidence(jsonb)') IS NOT NULL AS terminal_fail_rpc`
          : "SELECT to_regclass('public.commander_evidence_receipts') IS NOT NULL AS available",
      );
      const row = result.rows[0];
      return {
        ready:
          result.rowCount === 1 &&
          row?.available === true &&
          (!this.options.adapterOpsMode ||
            (row.context_rpc === true &&
              row.terminal_complete_rpc === true &&
              row.terminal_fail_rpc === true)),
      };
    } catch {
      return { ready: false };
    } finally {
      if (client) await client.release();
    }
  }

  // ── Durable Timers ─────────────────────────────────────────────────────────

  async createTimer(request: CreateTimerRequest, actor: string): Promise<KernelTimer> {
    const id = `tmr_${randomUUID()}`;
    return this.withTransaction(
      async (client) => {
        const result = await client.query<{
          id: string;
          run_id: string;
          step_id: string;
          tenant_id: string;
          fires_at: Date | string;
          timer_type: string;
          state: string;
          payload: Record<string, unknown>;
          created_at: Date | string;
          fired_at: Date | string | null;
        }>(
          `INSERT INTO commander_timers (id,run_id,step_id,tenant_id,fires_at,timer_type,payload)
          VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING *`,
          [
            id,
            request.runId,
            request.stepId,
            request.tenantId,
            request.firesAt,
            request.timerType,
            json(request.payload ?? {}),
          ],
        );
        await this.appendEvent(client, {
          aggregateType: 'run',
          aggregateId: request.runId,
          sequence: 0,
          type: 'timer.created',
          tenantId: request.tenantId,
          runId: request.runId,
          stepId: request.stepId,
          actor,
          payload: {
            timerId: id,
            timerType: request.timerType,
            firesAt: request.firesAt.toISOString(),
          },
        });
        return mapTimer(result.rows[0]!);
      },
      [request.tenantId],
    );
  }

  async cancelTimer(timerId: string, tenantId: string): Promise<boolean> {
    return this.withTransaction(
      async (client) => {
        const result = await client.query(
          `UPDATE commander_timers SET state='CANCELLED' WHERE id=$1 AND tenant_id=$2 AND state='PENDING'`,
          [timerId, tenantId],
        );
        return (result.rowCount ?? 0) === 1;
      },
      [tenantId],
    );
  }

  async claimExpiredTimers(now: Date = new Date(), limit: number = 100): Promise<KernelTimer[]> {
    return this.withTransaction(async (client) => {
      const claimToken = randomUUID();
      const result = await client.query<{
        id: string;
        run_id: string;
        step_id: string;
        tenant_id: string;
        fires_at: Date | string;
        timer_type: string;
        state: string;
        payload: Record<string, unknown>;
        created_at: Date | string;
        fired_at: Date | string | null;
        claim_token: string | null;
      }>(
        `UPDATE commander_timers SET state='PROCESSING', claim_token=$3, claimed_at=$1
          WHERE id IN (
            SELECT id FROM commander_timers
            WHERE (state='PENDING' OR (state='PROCESSING' AND claimed_at <= $1::timestamptz - interval '60 seconds')) AND fires_at <= $1
            ORDER BY fires_at LIMIT $2
            FOR UPDATE SKIP LOCKED
          )
          RETURNING *`,
        [now, limit, claimToken],
      );
      return result.rows.map(mapTimer);
    });
  }

  async acknowledgeTimer(timerId: string, tenantId: string, claimToken: string): Promise<boolean> {
    return this.withTransaction(
      async (client) => {
        const result = await client.query(
          `UPDATE commander_timers SET state='FIRED', fired_at=now(), claim_token=NULL, claimed_at=NULL
         WHERE id=$1 AND tenant_id=$2 AND state='PROCESSING' AND claim_token=$3`,
          [timerId, tenantId, claimToken],
        );
        return (result.rowCount ?? 0) === 1;
      },
      [tenantId],
    );
  }

  async retryTimer(timerId: string, tenantId: string, claimToken: string): Promise<boolean> {
    return this.withTransaction(
      async (client) => {
        const result = await client.query(
          `UPDATE commander_timers SET state='PENDING', claim_token=NULL, claimed_at=NULL
         WHERE id=$1 AND tenant_id=$2 AND state='PROCESSING' AND claim_token=$3`,
          [timerId, tenantId, claimToken],
        );
        return (result.rowCount ?? 0) === 1;
      },
      [tenantId],
    );
  }

  // ── Interactions ───────────────────────────────────────────────────────────

  async createInteraction(
    request: CreateInteractionRequest,
    actor: string,
  ): Promise<KernelInteraction> {
    const id = request.id ?? `itr_${randomUUID()}`;
    return this.withTransaction(
      async (client) => {
        const step = await client.query<{ id: string }>(
          `SELECT id FROM commander_steps WHERE id=$1 AND run_id=$2 AND tenant_id=$3`,
          [request.stepId, request.runId, request.tenantId],
        );
        if (!step.rows[0]) {
          throw new KernelInvariantError(
            'STEP_NOT_FOUND',
            `Step ${request.stepId} not found for run ${request.runId} in tenant ${request.tenantId}`,
          );
        }
        const result = await client.query<{
          id: string;
          run_id: string;
          step_id: string;
          tenant_id: string;
          status: string;
          prompt: string;
          response: Record<string, unknown> | null;
          created_at: Date | string;
          answered_at: Date | string | null;
          expires_at: Date | string | null;
        }>(
          `INSERT INTO commander_interactions (id,run_id,step_id,tenant_id,prompt,expires_at)
          VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
          [
            id,
            request.runId,
            request.stepId,
            request.tenantId,
            request.prompt,
            request.expiresAt ?? null,
          ],
        );
        await this.appendEvent(client, {
          aggregateType: 'interaction',
          aggregateId: id,
          sequence: 0,
          type: 'interaction.created',
          tenantId: request.tenantId,
          runId: request.runId,
          stepId: request.stepId,
          actor,
          payload: {
            interactionId: id,
            prompt: request.prompt,
            expiresAt: request.expiresAt?.toISOString() ?? null,
          },
        });
        return mapInteraction(result.rows[0]!);
      },
      [request.tenantId],
    );
  }

  async answerInteraction(request: AnswerInteractionRequest): Promise<KernelInteraction> {
    return this.withTransaction(
      async (client) => {
        const locked = await client.query<{
          id: string;
          run_id: string;
          step_id: string;
          tenant_id: string;
          status: string;
          prompt: string;
          response: Record<string, unknown> | null;
          created_at: Date | string;
          answered_at: Date | string | null;
          expires_at: Date | string | null;
          step_state: KernelStepState;
        }>(
          `SELECT i.*, s.state AS step_state
          FROM commander_interactions i
          JOIN commander_steps s
            ON s.id=i.step_id AND s.run_id=i.run_id AND s.tenant_id=i.tenant_id
          WHERE i.id=$1 AND i.run_id=$2 AND i.tenant_id=$3
            AND i.status='pending' AND ($4::boolean OR s.state='WAITING_FOR_HUMAN')
          FOR UPDATE OF i, s`,
          [request.interactionId, request.runId, request.tenantId, request.releaseStep === false],
        );
        const interaction = locked.rows[0];
        if (!interaction) {
          throw new KernelInvariantError(
            'INTERACTION_NOT_FOUND',
            `Interaction ${request.interactionId} not found or already answered`,
          );
        }
        // KTO-01: an interaction past its expiry must not be answerable. The
        // check runs under the same row lock as the answer, before the step is
        // released or any answer event is appended; an unparseable expiry is
        // treated as expired rather than silently ignored.
        if (interaction.expires_at !== null) {
          const expiry = new Date(interaction.expires_at).getTime();
          if (!Number.isFinite(expiry) || expiry <= Date.now()) {
            throw new KernelInvariantError(
              'INTERACTION_EXPIRED',
              `Interaction ${request.interactionId} expired at ${String(interaction.expires_at)}`,
            );
          }
        }
        let released: { rows: DbStep[] };
        if (request.releaseStep === false) {
          const current = await client.query<DbStep>(
            `SELECT * FROM commander_steps
           WHERE id=$1 AND run_id=$2 AND tenant_id=$3
             AND ($4::boolean OR state='WAITING_FOR_HUMAN')`,
            [interaction.step_id, request.runId, request.tenantId, request.releaseStep === false],
          );
          if (!current.rows[0]) {
            throw new KernelInvariantError(
              'INTERACTION_NOT_FOUND',
              `Interaction ${request.interactionId} has no matching waiting step`,
            );
          }
          released = { rows: current.rows };
        } else {
          assertStepTransition(interaction.step_state, 'RETRY_WAIT');
          released = await client.query<DbStep>(
            `UPDATE commander_steps
           SET state='RETRY_WAIT', scheduled_at=now(), version=version+1, updated_at=now(),
             lease_worker_id=NULL, lease_worker_generation=0, lease_token=NULL, lease_expires_at=NULL
           WHERE id=$1 AND run_id=$2 AND tenant_id=$3 AND state='WAITING_FOR_HUMAN'
           RETURNING *`,
            [interaction.step_id, request.runId, request.tenantId],
          );
          if (!released.rows[0]) {
            throw new KernelInvariantError(
              'INTERACTION_NOT_FOUND',
              `Interaction ${request.interactionId} has no matching waiting step`,
            );
          }
        }
        const result = await client.query<{
          id: string;
          run_id: string;
          step_id: string;
          tenant_id: string;
          status: string;
          prompt: string;
          response: Record<string, unknown> | null;
          created_at: Date | string;
          answered_at: Date | string | null;
          expires_at: Date | string | null;
        }>(
          `UPDATE commander_interactions
          SET status='answered', response=$1::jsonb, answered_at=now()
          WHERE id=$2 AND run_id=$3 AND tenant_id=$4 AND step_id=$5 AND status='pending'
          RETURNING *`,
          [
            json(request.response),
            request.interactionId,
            request.runId,
            request.tenantId,
            interaction.step_id,
          ],
        );
        if (!result.rows[0]) {
          throw new KernelInvariantError(
            'INTERACTION_NOT_FOUND',
            `Interaction ${request.interactionId} not found or already answered`,
          );
        }
        const step = fromStep(released.rows[0]!);
        await this.appendEvent(client, {
          aggregateType: 'interaction',
          aggregateId: request.interactionId,
          sequence: 1,
          type: 'interaction.answered',
          tenantId: request.tenantId,
          runId: request.runId,
          stepId: interaction.step_id,
          actor: request.actor,
          payload: { response: request.response },
        });
        if (request.releaseStep !== false) {
          await this.appendEvent(client, {
            aggregateType: 'step',
            aggregateId: step.id,
            sequence: step.version,
            type: 'step.interaction_answered',
            tenantId: step.tenantId,
            runId: step.runId,
            stepId: step.id,
            actor: request.actor,
            payload: { interactionId: request.interactionId },
          });
        }
        return mapInteraction(result.rows[0]!);
      },
      [request.tenantId],
    );
  }

  async getInteraction(interactionId: string, tenantId: string): Promise<KernelInteraction | null> {
    return this.withTransaction(
      async (client) => {
        const result = await client.query<{
          id: string;
          run_id: string;
          step_id: string;
          tenant_id: string;
          status: string;
          prompt: string;
          response: Record<string, unknown> | null;
          created_at: Date | string;
          answered_at: Date | string | null;
          expires_at: Date | string | null;
        }>('SELECT * FROM commander_interactions WHERE id=$1 AND tenant_id=$2', [
          interactionId,
          tenantId,
        ]);
        return result.rows[0] ? mapInteraction(result.rows[0]) : null;
      },
      [tenantId],
    );
  }

  async listInteractions(runId: string, tenantId: string): Promise<KernelInteraction[]> {
    return this.withTransaction(
      async (client) => {
        const result = await client.query<{
          id: string;
          run_id: string;
          step_id: string;
          tenant_id: string;
          status: string;
          prompt: string;
          response: Record<string, unknown> | null;
          created_at: Date | string;
          answered_at: Date | string | null;
          expires_at: Date | string | null;
        }>(
          'SELECT * FROM commander_interactions WHERE run_id=$1 AND tenant_id=$2 ORDER BY created_at',
          [runId, tenantId],
        );
        return result.rows.map(mapInteraction);
      },
      [tenantId],
    );
  }

  async expireStaleInteractions(
    now: Date = new Date(),
    limit: number = 100,
  ): Promise<KernelInteraction[]> {
    return this.withTransaction(async (client) => {
      const result = await client.query<{
        id: string;
        run_id: string;
        step_id: string;
        tenant_id: string;
        status: string;
        prompt: string;
        response: Record<string, unknown> | null;
        created_at: Date | string;
        answered_at: Date | string | null;
        expires_at: Date | string | null;
      }>(
        `UPDATE commander_interactions SET status='expired'
          WHERE id IN (
            SELECT id FROM commander_interactions
            WHERE status='pending' AND expires_at IS NOT NULL AND expires_at <= $1
            LIMIT $2
            FOR UPDATE SKIP LOCKED
          )
          RETURNING *`,
        [now, limit],
      );
      return result.rows.map(mapInteraction);
    });
  }

  // ── Outbox DLQ ─────────────────────────────────────────────────────────────

  async sweepOutboxDlq(
    now: Date = new Date(),
    limit: number = 50,
  ): Promise<{ movedToDlq: number; backoffApplied: number }> {
    return this.withTransaction(async (client) => {
      let movedToDlq = 0;
      let backoffApplied = 0;

      // 1. Move messages that exceeded max_attempts to DLQ
      const expired = await client.query<{
        id: string;
        event_id: string;
        tenant_id: string;
        topic: string;
        key: string;
        payload: Record<string, unknown>;
        attempts: number;
        max_attempts: number;
        created_at: Date | string;
      }>(
        `SELECT id, event_id, tenant_id, topic, key, payload, attempts, max_attempts, created_at
          FROM commander_outbox
          WHERE published_at IS NULL AND moved_to_dlq_at IS NULL AND attempts >= max_attempts
            AND (claimed_at IS NULL OR claimed_at <= $2::timestamptz - interval '60 seconds')
          ORDER BY created_at LIMIT $1
          FOR UPDATE SKIP LOCKED`,
        [limit, now],
      );
      for (const row of expired.rows) {
        const dlqId = `dlq_${randomUUID()}`;
        await client.query(
          `INSERT INTO commander_outbox_dlq (id, original_id, event_id, tenant_id, topic, key, payload, attempts, dlq_reason, original_created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,'max_attempts_exceeded',$9)`,
          [
            dlqId,
            row.id,
            row.event_id,
            row.tenant_id,
            row.topic,
            row.key,
            json(row.payload),
            row.attempts,
            row.created_at,
          ],
        );
        await client.query(
          `UPDATE commander_outbox SET dlq_reason='max_attempts_exceeded', moved_to_dlq_at=now() WHERE id=$1`,
          [row.id],
        );
        movedToDlq++;
      }

      // 2. Apply exponential backoff to messages below threshold
      //    available_at = now() + (2^attempts * 1000ms)
      const backoff = await client.query<{
        id: string;
        attempts: number;
      }>(
        `UPDATE commander_outbox
           SET available_at = now() + (POWER(2, attempts) * INTERVAL '1 second'),
               claim_token = NULL,
               claimed_at = NULL
           WHERE id IN (
             SELECT id FROM commander_outbox
             WHERE published_at IS NULL
               AND moved_to_dlq_at IS NULL
               AND attempts > 0
               AND attempts < max_attempts
               AND available_at <= $1
               AND (claimed_at IS NULL OR claimed_at <= $1::timestamptz - interval '60 seconds')
             LIMIT $2
             FOR UPDATE SKIP LOCKED
           )
           RETURNING id, attempts`,
        [now, limit],
      );
      backoffApplied = backoff.rowCount ?? 0;

      return { movedToDlq, backoffApplied };
    });
  }

  async listDlqEntries(limit: number = 100, topic?: string): Promise<KernelDlqEntry[]> {
    return this.withTransaction(async (client) => {
      const result = await client.query<{
        id: string;
        original_id: string;
        event_id: string;
        tenant_id: string;
        topic: string;
        key: string;
        payload: Record<string, unknown>;
        attempts: number;
        dlq_reason: string | null;
        original_created_at: Date | string;
        moved_to_dlq_at: Date | string;
      }>(
        topic
          ? 'SELECT * FROM commander_outbox_dlq WHERE topic=$1 ORDER BY moved_to_dlq_at DESC LIMIT $2'
          : 'SELECT * FROM commander_outbox_dlq ORDER BY moved_to_dlq_at DESC LIMIT $1',
        topic ? [topic, limit] : [limit],
      );
      return result.rows.map((row) => ({
        id: row.id,
        originalId: row.original_id,
        eventId: row.event_id,
        tenantId: row.tenant_id,
        topic: row.topic,
        key: row.key,
        payload: row.payload ?? {},
        attempts: row.attempts,
        dlqReason: row.dlq_reason ?? undefined,
        originalCreatedAt: iso(row.original_created_at),
        movedToDlqAt: iso(row.moved_to_dlq_at),
      }));
    });
  }

  async replayDlqEntry(dlqId: string): Promise<boolean> {
    return this.withTransaction(async (client) => {
      const dlq = await client.query<{
        id: string;
        original_id: string;
        event_id: string;
        tenant_id: string;
        topic: string;
        key: string;
        payload: Record<string, unknown>;
      }>(`SELECT * FROM commander_outbox_dlq WHERE id=$1 FOR UPDATE`, [dlqId]);
      if (!dlq.rows[0]) return false;

      const row = dlq.rows[0]!;
      const newOutboxId = randomUUID();
      await client.query(
        `INSERT INTO commander_outbox (id, event_id, tenant_id, topic, key, payload, attempts, max_attempts)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,0,10)`,
        [newOutboxId, row.event_id, row.tenant_id, row.topic, row.key, json(row.payload)],
      );
      await client.query(`DELETE FROM commander_outbox_dlq WHERE id=$1`, [dlqId]);
      return true;
    });
  }

  private async lockRunState(
    client: SqlClient,
    runId: string,
    tenantId: string,
  ): Promise<KernelRunState | null> {
    const result = await client.query<{ state: KernelRunState }>(
      'SELECT state FROM commander_runs WHERE id=$1 AND tenant_id=$2 FOR UPDATE',
      [runId, tenantId],
    );
    return result.rows[0]?.state ?? null;
  }

  private async lockStepStates(
    client: SqlClient,
    runId: string,
    tenantId: string,
  ): Promise<Array<{ id: string; state: KernelStepState }>> {
    const result = await client.query<{ id: string; state: KernelStepState }>(
      'SELECT id, state FROM commander_steps WHERE run_id=$1 AND tenant_id=$2 FOR UPDATE',
      [runId, tenantId],
    );
    return result.rows;
  }

  private async requestCompensationIfNeeded(
    client: SqlClient,
    step: Pick<KernelStep, 'id' | 'tenantId' | 'runId'>,
    fencingEpoch: number,
    actor: string,
    at = new Date(),
  ): Promise<boolean> {
    const effectSnapshot = await client.query<{ id: string; state: 'ADMITTED' | 'COMPLETED' }>(
      `SELECT id, state FROM commander_effects
       WHERE run_id=$1 AND tenant_id=$2 AND state IN ('COMPLETED','ADMITTED')
       ORDER BY created_at ASC
       FOR UPDATE`,
      [step.runId, step.tenantId],
    );
    const completedEffectIds = effectSnapshot.rows
      .filter((effect) => effect.state === 'COMPLETED')
      .map((effect) => effect.id);
    if (completedEffectIds.length === 0) return false;

    const previousState = await this.lockRunState(client, step.runId, step.tenantId);
    if (!previousState) return false;
    if (previousState === 'COMPENSATING') {
      await this.cancelOpenStepsForTerminalRun(
        client,
        step.runId,
        step.tenantId,
        actor,
        'run_compensating',
      );
      return true;
    }
    assertRunTransition(previousState, 'COMPENSATING');
    const updated = await client.query<DbRun>(
      `UPDATE commander_runs
       SET state='COMPENSATING', version=version+1, updated_at=$1
       WHERE id=$2 AND tenant_id=$3 AND state=$4
       RETURNING *`,
      [at.toISOString(), step.runId, step.tenantId, previousState],
    );
    if (!updated.rows[0]) return false;
    const run = fromRun(updated.rows[0]);
    await this.appendEvent(client, {
      aggregateType: 'run',
      aggregateId: run.id,
      sequence: run.version,
      type: 'run.compensating',
      tenantId: run.tenantId,
      runId: run.id,
      stepId: step.id,
      actor,
      payload: { fencingEpoch },
    });
    const compensationKey = `${run.tenantId}/${run.id}/${fencingEpoch}`;
    await this.appendEvent(
      client,
      {
        aggregateType: 'effect',
        aggregateId: `compensation:${compensationKey}`,
        sequence: 1,
        type: 'kernel.compensation.requested',
        tenantId: run.tenantId,
        runId: run.id,
        stepId: step.id,
        actor,
        payload: { effectIds: completedEffectIds, fencingEpoch },
      },
      compensationKey,
    );
    await this.cancelOpenStepsForTerminalRun(
      client,
      run.id,
      run.tenantId,
      actor,
      'run_compensating',
    );
    return true;
  }

  private async cancelOpenStepsForTerminalRun(
    client: SqlClient,
    runId: string,
    tenantId: string,
    actor: string,
    reason: string,
  ): Promise<void> {
    const previousSteps = await this.lockStepStates(client, runId, tenantId);
    const previousStates = new Map(previousSteps.map((step) => [step.id, step.state]));
    for (const step of previousSteps) {
      if (!['SUCCEEDED', 'FAILED', 'CANCELLED', 'SKIPPED'].includes(step.state)) {
        assertStepTransition(step.state, 'CANCELLED');
      }
    }
    const cancelled = await client.query<DbStep>(
      `UPDATE commander_steps
       SET state='CANCELLED',
           error=jsonb_build_object('code','RUN_TERMINAL','message',$1::text,'retryable',false),
           version=version+1, updated_at=now(),
           lease_worker_id=NULL, lease_token=NULL, lease_expires_at=NULL
       WHERE run_id=$2 AND tenant_id=$3
         AND state NOT IN ('SUCCEEDED','FAILED','CANCELLED','SKIPPED')
       RETURNING *`,
      [reason, runId, tenantId],
    );
    for (const row of cancelled.rows) {
      const step = fromStep(row);
      const previousState = previousStates.get(step.id);
      if (previousState === 'RUNNING') await this.releaseTenantSlot(client, tenantId);
      await this.parkOrphanAdmittedEffects(client, step, reason, actor);
      await this.appendEvent(client, {
        aggregateType: 'step',
        aggregateId: step.id,
        sequence: step.version,
        type: 'step.cancelled',
        tenantId,
        runId,
        stepId: step.id,
        actor,
        payload: { reason, previousState },
      });
    }
  }

  private async finishRunIfTerminal(
    client: SqlClient,
    runId: string,
    tenantId: string,
    actor: string,
  ): Promise<void> {
    const previousState = await this.lockRunState(client, runId, tenantId);
    if (!previousState) return;
    const states = await client.query<{ state: string }>(
      'SELECT state FROM commander_steps WHERE run_id=$1 AND tenant_id=$2 FOR UPDATE',
      [runId, tenantId],
    );
    const terminalCandidate =
      states.rows.some((row) => row.state === 'FAILED') ||
      (states.rows.length > 0 &&
        states.rows.every((row) => ['SUCCEEDED', 'SKIPPED'].includes(row.state)));
    if (
      terminalCandidate &&
      (await this.hasUnreceiptedConsequentialEffect(client, runId, tenantId))
    )
      return;
    if (states.rows.some((row) => row.state === 'FAILED')) {
      if (previousState === 'FAILED') return;
      assertRunTransition(previousState, 'FAILED');
      await this.cancelOpenStepsForTerminalRun(client, runId, tenantId, actor, 'run_failed');
      const updated = await client.query<DbRun>(
        `UPDATE commander_runs SET state='FAILED', version=version+1, updated_at=now(), terminal_at=now() WHERE id=$1 AND tenant_id=$2 AND state NOT IN ('FAILED','SUCCEEDED') RETURNING *`,
        [runId, tenantId],
      );
      if (updated.rows[0])
        await this.appendEvent(client, {
          aggregateType: 'run',
          aggregateId: runId,
          sequence: Number(updated.rows[0].version),
          type: 'run.failed',
          tenantId,
          runId,
          actor,
          payload: {},
        });
    } else if (
      states.rows.length > 0 &&
      states.rows.every((row) => ['SUCCEEDED', 'SKIPPED'].includes(row.state))
    ) {
      if (previousState === 'SUCCEEDED') return;
      assertRunTransition(previousState, 'SUCCEEDED');
      const updated = await client.query<DbRun>(
        `UPDATE commander_runs SET state='SUCCEEDED', version=version+1, updated_at=now(), terminal_at=now() WHERE id=$1 AND tenant_id=$2 AND state NOT IN ('FAILED','SUCCEEDED') RETURNING *`,
        [runId, tenantId],
      );
      if (updated.rows[0])
        await this.appendEvent(client, {
          aggregateType: 'run',
          aggregateId: runId,
          sequence: Number(updated.rows[0].version),
          type: 'run.succeeded',
          tenantId,
          runId,
          actor,
          payload: {},
        });
    }
  }
  protected async hasUnreceiptedConsequentialEffect(
    client: SqlClient,
    runId: string,
    tenantId: string,
  ): Promise<boolean> {
    const effects = await client.query<DbEffect>(
      'SELECT * FROM commander_effects WHERE run_id=$1 AND tenant_id=$2',
      [runId, tenantId],
    );
    for (const row of effects.rows) {
      const effect = fromEffect(row);
      if (!isClassAEffectType(effect.type)) continue;
      if (!(await this.hasEvidenceForEffect(client, effect))) return true;
    }
    return false;
  }
  protected async hasEvidenceForEffect(client: SqlClient, effect: KernelEffect): Promise<boolean> {
    const receipt = await client.query<DbEvidence>(
      `SELECT * FROM commander_evidence_receipts
       WHERE tenant_id=$1 AND run_id=$2 AND bundle_id=$3 LIMIT 1`,
      [effect.tenantId, effect.runId, `evidence_${effect.id}`],
    );
    if (!receipt.rows[0]) return false;
    try {
      assertEvidenceRecordBoundToEffect(fromEvidence(receipt.rows[0]), effect);
      return true;
    } catch {
      return false;
    }
  }
  private async releaseTenantSlot(client: SqlClient, tenantId: string): Promise<void> {
    await client.query(
      `UPDATE commander_tenant_execution_usage
       SET running_steps=GREATEST(0, running_steps-1), updated_at=now() WHERE tenant_id=$1`,
      [tenantId],
    );
  }
  private async parkOrphanAdmittedEffects(
    client: SqlClient,
    step: Pick<KernelStep, 'id' | 'tenantId' | 'runId'>,
    reason: string,
    actor: string,
  ): Promise<void> {
    const unknownAt = new Date().toISOString();
    const policy = createReconcilePolicy({ unknownAt });
    const uncertain = await client.query<{ id: string }>(
      `UPDATE commander_effects SET
         state='COMPLETION_UNKNOWN',
         response=jsonb_build_object('reason',$1::text),
         reconcile_max_attempts=$5,
         reconcile_initial_delay_ms=$6,
         reconcile_max_delay_ms=$7,
         reconcile_deadline_at=LEAST($8::timestamptz, COALESCE(governed_action_deadline_at, $8::timestamptz)),
         reconcile_disposition='PENDING',
         reconcile_after=$4::timestamptz,
         reconcile_attempts=0,
         reconcile_observed_at=NULL,
         reconcile_last_error=NULL,
         reconcile_escalated_at=NULL,
         reconcile_escalation_code=NULL,
         reconcile_claim_token=NULL,
         reconcile_claim_expires_at=NULL,
         reconcile_claimed_at=NULL,
         reconcile_claim_worker_id=NULL,
         reconcile_claim_worker_generation=NULL
       WHERE step_id=$2 AND tenant_id=$3 AND state='ADMITTED'
       RETURNING id`,
      [
        reason,
        step.id,
        step.tenantId,
        unknownAt,
        policy.maxAttempts,
        policy.initialDelayMs,
        policy.maxDelayMs,
        policy.deadlineAt,
      ],
    );
    for (const effect of uncertain.rows) {
      await this.appendEvent(client, {
        aggregateType: 'effect',
        aggregateId: effect.id,
        sequence: 2,
        type: 'effect.completion_unknown',
        tenantId: step.tenantId,
        runId: step.runId,
        stepId: step.id,
        actor,
        payload: { reason },
      });
    }
  }
  protected async appendEvent(
    client: SqlClient,
    event: Omit<import('./types.js').KernelEvent, 'eventId' | 'schemaVersion' | 'occurredAt'>,
    outboxKey = event.runId,
  ): Promise<void> {
    const eventId = randomUUID();
    await client.query(
      `INSERT INTO commander_events (id,aggregate_type,aggregate_id,sequence,type,tenant_id,run_id,step_id,causation_id,correlation_id,actor,schema_version,payload)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'v2',$12::jsonb)`,
      [
        eventId,
        event.aggregateType,
        event.aggregateId,
        event.sequence,
        event.type,
        event.tenantId,
        event.runId,
        event.stepId ?? null,
        event.causationId ?? null,
        event.correlationId ?? null,
        event.actor,
        json(event.payload),
      ],
    );
    await client.query(
      `INSERT INTO commander_outbox (id,event_id,tenant_id,topic,key,payload) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
      [
        randomUUID(),
        eventId,
        event.tenantId,
        `commander.${event.type}`,
        outboxKey,
        json({
          ...event.payload,
          eventId,
          type: event.type,
          runId: event.runId,
          stepId: event.stepId ?? null,
          tenantId: event.tenantId,
        }),
      ],
    );
  }
  private assertGraph(command: CreateKernelRun): void {
    const ids = new Set<string>();
    for (const step of command.steps) {
      if (ids.has(step.id))
        throw new KernelInvariantError('DUPLICATE_STEP', `Duplicate step ${step.id}`);
      ids.add(step.id);
    }
    for (const step of command.steps)
      for (const dependency of step.dependencies ?? [])
        if (!ids.has(dependency))
          throw new KernelInvariantError(
            'INVALID_GRAPH',
            `Step ${step.id} depends on unknown step ${dependency}`,
          );
  }
  protected async withTransaction<T>(
    fn: (client: SqlClient) => Promise<T>,
    tenantIds: string[] = [],
  ): Promise<T> {
    if (tenantIds.length === 0 && !this.options.schedulerMode) {
      throw new Error(
        'Kernel write must explicitly carry tenant scope (or use a scheduler-mode repository)',
      );
    }
    if (this.options.tenantContextAuthority && tenantIds.length !== 1) {
      throw new Error('TENANT_CONTEXT_EXACTLY_ONE_TENANT_REQUIRED');
    }
    const scope = tenantIds.length > 0 ? tenantIds.join(',') : '*';
    const client = await this.pool.connect();
    let released = false;
    try {
      if (this.options.tenantContextAuthority) {
        await client.query(BEGIN_APP_TENANT_TRANSACTION_SQL);
        const targetResult = await client.query<{
          database_oid: number;
          backend_pid: number;
          xid: string;
        }>(READ_APP_TENANT_TRANSACTION_TARGET_SQL);
        const targetRow = targetResult.rows[0];
        if (
          targetResult.rowCount !== 1 ||
          !targetRow ||
          !Number.isInteger(Number(targetRow.database_oid)) ||
          !Number.isInteger(Number(targetRow.backend_pid)) ||
          !/^[1-9][0-9]*$/.test(String(targetRow.xid))
        ) {
          throw new Error('TENANT_CONTEXT_INVALID');
        }
        const target: AppTenantTransactionTarget = {
          databaseOid: Number(targetRow.database_oid),
          backendPid: Number(targetRow.backend_pid),
          xid: String(targetRow.xid),
        };
        const issued = await this.options.tenantContextAuthority.issue(tenantIds[0]!, target);
        const bind = buildBindAppTenantContextQuery(issued.contextId);
        const bound = await client.query<{ tenant_id: string }>(bind.text, bind.values);
        if (bound.rowCount !== 1 || bound.rows[0]?.tenant_id !== tenantIds[0]) {
          throw new Error('TENANT_CONTEXT_INVALID');
        }
        if (this.options.tenantContextPhase === 'expand') {
          const compatibility = buildSetLegacyTenantScopeQuery(bound.rows[0].tenant_id);
          await client.query(compatibility.text, compatibility.values);
        }
        const value = await fn(client);
        const close = buildCloseAppTenantContextQuery(issued.contextId);
        await client.query(close.text, close.values);
        await client.query('COMMIT');
        return value;
      }

      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_scope',$1,true)", [scope]);
      const value = await fn(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      let connectionError = unknownConnectionStateError(error);
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        connectionError = unknownConnectionStateError(rollbackError);
      }
      await client.release(connectionError);
      released = true;
      throw error;
    } finally {
      if (!released) await client.release();
    }
  }
}

// ── Row mappers ──────────────────────────────────────────────────────────────

function mapKillSwitch(row: {
  tenant_id: string;
  scope: string;
  value: string;
  enabled: boolean;
  reason: string | null;
  actor: string;
  updated_at: Date | string;
}): KillSwitch {
  return {
    tenantId: row.tenant_id,
    scope: row.scope as KillSwitch['scope'],
    value: row.value,
    enabled: row.enabled,
    reason: row.reason ?? undefined,
    actor: row.actor,
    updatedAt: iso(row.updated_at),
  };
}

function mapTimer(row: {
  id: string;
  run_id: string;
  step_id: string;
  tenant_id: string;
  fires_at: Date | string;
  timer_type: string;
  state: string;
  payload: Record<string, unknown>;
  created_at: Date | string;
  fired_at: Date | string | null;
  claim_token?: string | null;
}): KernelTimer {
  return {
    id: row.id,
    runId: row.run_id,
    stepId: row.step_id,
    tenantId: row.tenant_id,
    firesAt: iso(row.fires_at),
    timerType: row.timer_type as KernelTimer['timerType'],
    state: row.state as KernelTimer['state'],
    payload: row.payload ?? {},
    createdAt: iso(row.created_at),
    firedAt: row.fired_at ? iso(row.fired_at) : undefined,
    claimToken: row.claim_token ?? undefined,
  };
}

function mapInteraction(row: {
  id: string;
  run_id: string;
  step_id: string;
  tenant_id: string;
  status: string;
  prompt: string;
  response: Record<string, unknown> | null;
  created_at: Date | string;
  answered_at: Date | string | null;
  expires_at: Date | string | null;
}): KernelInteraction {
  return {
    id: row.id,
    runId: row.run_id,
    stepId: row.step_id,
    tenantId: row.tenant_id,
    status: row.status as KernelInteraction['status'],
    prompt: row.prompt,
    response: row.response ?? undefined,
    createdAt: iso(row.created_at),
    answeredAt: row.answered_at ? iso(row.answered_at) : undefined,
    expiresAt: row.expires_at ? iso(row.expires_at) : undefined,
  };
}
