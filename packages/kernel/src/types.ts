/** Canonical, versioned execution-kernel domain types. */

import type { KernelErrorDetails, KernelEvent, RunState, StepState } from '@praetor/contracts';
import type { KernelEvidenceRecord } from './evidenceRepository.js';
export type { KernelErrorDetails, KernelEvent } from '@praetor/contracts';

export const KERNEL_API_VERSION = 'v2' as const;
export const OPERATIONS_HEARTBEAT_TTL_MS = 30_000;

export interface OperationsReadiness {
  ready: boolean;
  reason?: 'RECONCILIATION_DRAIN_UNAVAILABLE' | 'COMPENSATION_DRAIN_UNAVAILABLE';
  reconciliationWorkers: number;
  compensationWorkers: number;
  checkedAt: string;
}

/** Task 1 contract only; Task 3 supplies the atomic compensation claim RPC. */
export interface KernelCompensationAdmissionBinding {
  authorizationId: string;
  requestId: string;
  claimToken: string;
  requestClaimToken?: string;
  outboxMessageId?: string;
  outboxClaimToken?: string;
}

/** Re-exported from @praetor/contracts; kept for source compatibility. */
export type KernelRunState = RunState;
/** Re-exported from @praetor/contracts; kept for source compatibility. */
export type KernelStepState = StepState;

export interface KernelRunHandle {
  runId: string;
  state: KernelRunState;
  leaseToken: string;
  fencingEpoch: number;
  intentHash: string;
  tenantId: string;
  resumed: boolean;
  acquired: boolean;
}

export interface KernelRun {
  id: string;
  tenantId: string;
  intentHash: string;
  workGraphHash: string;
  workGraphVersion: string;
  state: KernelRunState;
  version: number;
  policySnapshotId: string;
  createdAt: string;
  updatedAt: string;
  pausedAt?: string;
  terminalAt?: string;
  metadata: Record<string, unknown>;
}

export interface TenantExecutionControl {
  tenantId: string;
  paused: boolean;
  generation: number;
  actor: string;
  reason?: string;
  pausedAt?: string;
  resumedAt?: string;
}

export interface KernelStep {
  id: string;
  runId: string;
  tenantId: string;
  kind: string;
  state: KernelStepState;
  version: number;
  attempt: number;
  maxAttempts: number;
  priority: number;
  dependencies: string[];
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: KernelErrorDetails;
  scheduledAt: string;
  lease?: KernelLease;
  createdAt: string;
  updatedAt: string;
}

export interface KernelLease {
  workerId: string;
  /** Generation from the durable worker registry; stale processes are fenced. */
  workerGeneration?: number;
  token: string;
  fencingEpoch: number;
  expiresAt: string;
}

export interface KernelOutboxMessage {
  id: string;
  eventId: string;
  tenantId: string;
  topic: string;
  key: string;
  payload: Record<string, unknown>;
  attempts: number;
  availableAt: string;
  publishedAt?: string;
  /** Present only when this message is leased to a publisher. */
  claimToken?: string;
  createdAt: string;
}

export interface KernelEffect {
  id: string;
  runId: string;
  stepId: string;
  tenantId: string;
  type: string;
  idempotencyKey: string;
  requestHash: string;
  policyDecisionId: string;
  /** Immutable policy snapshot pinned at admit. */
  policySnapshotId: string;
  /** Canonical digest of the authorized external action. */
  actionDigest: string;
  /** Worker id from the admit lease (never null after Task 2 backfill). */
  leaseWorkerId: string;
  /** Worker registry generation from the admit lease (required, never nullable). */
  leaseWorkerGeneration: number;
  /** Fencing epoch from the admit lease. */
  leaseFencingEpoch: number;
  state: 'ADMITTED' | 'COMPLETION_UNKNOWN' | 'CONFIRMED_NOT_APPLIED' | 'COMPLETED' | 'FAILED';
  request: Record<string, unknown>;
  response?: Record<string, unknown>;
  createdAt: string;
  completedAt?: string;
  reconcileAttempts: number;
  governedActionDeadlineAt: string | null;
  reconcilePolicy: ReconcilePolicy | null;
  reconcileDisposition: ReconcileDisposition | null;
  reconcileAfter: string | null;
  reconcileObservedAt: string | null;
  reconcileClaimToken: string | null;
  reconcileClaimExpiresAt: string | null;
  reconcileClaimedAt: string | null;
  reconcileClaimWorkerId: string | null;
  reconcileClaimWorkerGeneration: number | null;
  reconcileLastError: ReconcileQueryError | null;
  reconcileEscalatedAt: string | null;
  reconcileEscalationCode: ReconcileEscalationCode | null;
}

export interface ReconcilePolicy {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  deadlineAt: string;
}

export type ReconcileDisposition =
  'PENDING' | 'CONFIRMED_APPLIED' | 'CONFIRMED_NOT_APPLIED' | 'ESCALATED';

export type ReconcileQueryErrorCode =
  | 'RECONCILE_OUTCOME_NOT_YET_VISIBLE'
  | 'RECONCILE_MULTIPLE_MATCHES'
  | 'RECONCILE_QUERY_TIMEOUT'
  | 'RECONCILE_QUERY_TRANSPORT'
  | 'RECONCILE_QUERY_RATE_LIMITED'
  | 'RECONCILE_QUERY_UNAVAILABLE'
  | 'RECONCILE_QUERY_AUTHENTICATION_FAILED'
  | 'RECONCILE_QUERY_AUTHORIZATION_FAILED'
  | 'RECONCILE_QUERY_CONFIGURATION_INVALID'
  | 'RECONCILE_QUERY_RESPONSE_INVALID'
  | 'RECONCILE_NEGATIVE_PROOF_INVALID'
  | 'RECONCILE_QUERY_UNCLASSIFIED';

export interface ReconcileQueryError {
  category?: 'TRANSIENT' | 'PERMANENT';
  code: string;
  message: string;
}

export type ReconcileEscalationCode =
  | 'RECONCILE_POLICY_BACKFILL_REVIEW_REQUIRED'
  | 'RECONCILE_LEGACY_TERMINAL_CONFLICT'
  | 'RECONCILE_DEADLINE_EXPIRED'
  | 'RECONCILE_MAX_ATTEMPTS_EXHAUSTED'
  | 'RECONCILE_ADAPTER_NOT_FOUND'
  | 'RECONCILE_QUERY_UNSUPPORTED'
  | 'COMPENSATION_QUERY_UNSUPPORTED'
  | 'RECONCILE_QUERY_PERMANENT_FAILURE';

export interface CreateKernelRun {
  id: string;
  tenantId: string;
  intentHash: string;
  workGraphHash: string;
  workGraphVersion: string;
  policySnapshotId: string;
  metadata?: Record<string, unknown>;
  steps: Array<NewKernelStep>;
}

export interface NewKernelStep {
  id: string;
  kind: string;
  initialState?: 'PENDING' | 'WAITING_FOR_HUMAN';
  interaction?: {
    id: string;
    prompt: string;
    expiresAt?: string;
  };
  input?: Record<string, unknown>;
  dependencies?: string[];
  priority?: number;
  maxAttempts?: number;
  scheduledAt?: string;
}

export interface ClaimStepRequest {
  workerId: string;
  /** Durable worker-registry generation. Required by production Postgres claims. */
  workerGeneration?: number;
  /**
   * Unforgeable claim secret from register() (process memory only).
   * Required on the worker (non-scheduler) claim path.
   */
  claimSecret?: string;
  leaseTtlMs: number;
  /**
   * @deprecated Ignored on the worker (non-scheduler) claim path. Tenant authorization
   * comes only from durable `commander_workers.tenant_ids` via `claim_next_step`.
   * Scheduler-mode repositories may still use this as an optional filter.
   */
  tenantId?: string;
  /**
   * @deprecated Ignored on the worker (non-scheduler) claim path — callers cannot
   * widen or select tenant scope. Drop from new call sites; durable authz only.
   */
  tenantIds?: string[];
  /** Step kinds this worker is authorized and able to execute. */
  capabilities?: string[];
  now?: Date;
}

export interface CompleteStepRequest {
  stepId: string;
  tenantId: string;
  lease: Pick<KernelLease, 'workerId' | 'workerGeneration' | 'token' | 'fencingEpoch'>;
  output?: Record<string, unknown>;
  expectedVersion: number;
  actor: string;
}

export interface FailStepRequest {
  stepId: string;
  tenantId: string;
  lease: Pick<KernelLease, 'workerId' | 'workerGeneration' | 'token' | 'fencingEpoch'>;
  error: KernelErrorDetails;
  expectedVersion: number;
  actor: string;
  retryAt?: Date;
  /** Return the attempt consumed by claim when a worker stops before execution begins. */
  refundAttempt?: boolean;
}

export interface AdmitEffectRequest {
  id: string;
  runId: string;
  stepId: string;
  tenantId: string;
  type: string;
  idempotencyKey: string;
  policyDecisionId: string;
  /** Immutable policy snapshot that authorized this admit. */
  policySnapshotId: string;
  /** Canonical digest of the authorized external action. */
  actionDigest: string;
  request: Record<string, unknown>;
  lease: Pick<KernelLease, 'workerId' | 'workerGeneration' | 'token' | 'fencingEpoch'>;
  compensationBinding?: KernelCompensationAdmissionBinding;
  actor: string;
}

export interface MarkEffectCompletionUnknownRequest {
  effectId: string;
  tenantId: string;
  reason: string;
  actor: string;
  governedActionDeadlineAt?: string;
  lease?: Pick<KernelLease, 'workerId' | 'workerGeneration' | 'token' | 'fencingEpoch'>;
}

export interface ParkEffectCompletionUnknownInput {
  tenantId: string;
  effectId: string;
  workerId: string;
  workerGeneration: number;
  claimSecret: string;
  leaseToken: string;
  fencingEpoch: number;
  error: { code: string; message: string };
  governedActionDeadlineAt?: string;
}

export type ParkEffectCompletionUnknownResult =
  | { parked: true; replayed: boolean; effect: KernelEffect }
  | {
      parked: false;
      reason:
        | 'NOT_FOUND'
        | 'NOT_ADMITTED_OR_UNKNOWN'
        | 'ADMISSION_BINDING_MISMATCH'
        | 'LEASE_FENCED'
        | 'STEP_TERMINAL_RACE';
    };

/** L3-08a: advance COMPLETION_UNKNOWN after remote query (no worker lease). */
export interface ReconcileEffectRequest {
  effectId: string;
  tenantId: string;
  state: 'COMPLETED' | 'FAILED';
  response: Record<string, unknown>;
  actor: string;
}

export interface RequestReconcileInput {
  effectId: string;
  tenantId: string;
  actor: string;
}

export type RequestReconcileResult =
  | {
      scheduled: true;
      effectId: string;
      state: 'COMPLETION_UNKNOWN';
      reconcileAfter: string;
      alreadyScheduled: boolean;
    }
  | {
      scheduled: false;
      reason: 'NOT_FOUND' | 'NOT_UNKNOWN' | 'ESCALATED' | 'DEADLINE_EXPIRED';
    };

export interface ReconcileClaimAuth {
  tenantId: string;
  effectId: string;
  workerId: string;
  workerGeneration: number;
  claimSecret: string;
  claimToken: string;
  /** Signed terminal receipt. Required when this mutation reaches a terminal disposition. */
  evidence?: KernelEvidenceRecord;
}

export type ReconcileMutationInput =
  | (ReconcileClaimAuth & { mutation: 'COMPLETE'; response: Record<string, unknown> })
  | (ReconcileClaimAuth & {
      mutation: 'CONFIRM_NOT_APPLIED';
      response: Record<string, unknown>;
    })
  | (ReconcileClaimAuth & { mutation: 'RESCHEDULE'; lastError: ReconcileQueryError })
  | (ReconcileClaimAuth & {
      mutation: 'ESCALATE';
      reason:
        | 'RECONCILE_ADAPTER_NOT_FOUND'
        | 'RECONCILE_QUERY_UNSUPPORTED'
        | 'COMPENSATION_QUERY_UNSUPPORTED'
        | 'RECONCILE_POLICY_BACKFILL_REVIEW_REQUIRED';
    });

export interface ReconcileMutationReceipt {
  effectId: string;
  requestFingerprint: string;
  effectState: KernelEffect['state'];
  reconcileAttempts: number;
  reconcileAfter: string | null;
  reconcileEscalatedAt: string | null;
  eventId: string;
}

export type ReconcileMutationResult =
  | {
      applied: true;
      replayed: boolean;
      disposition: 'COMPLETED' | 'CONFIRMED_NOT_APPLIED' | 'RESCHEDULED' | 'ESCALATED';
      receipt: ReconcileMutationReceipt;
    }
  | {
      applied: false;
      reason:
        | 'NOT_FOUND'
        | 'NOT_COMPLETION_UNKNOWN'
        | 'CLAIM_NOT_OWNED'
        | 'CLAIM_EXPIRED'
        | 'WORKER_FENCED'
        | 'CLAIM_REPLAY_CONFLICT'
        | 'TERMINAL_EVIDENCE_REQUIRED';
    }
  | {
      applied: false;
      reason: 'STEP_TERMINAL_RACE';
      stepState: 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'SKIPPED';
    }
  | {
      applied: false;
      reason: 'RUN_TERMINAL_RACE';
      runState: 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'COMPENSATED';
    };

export interface ClaimReconcileEffectsInput {
  limit: number;
  now?: Date;
  claimTtlMs?: number;
  /**
   * Required on the worker (non-scheduler) path. Tenant authorization comes only
   * from durable `commander_workers.tenant_ids` via `claim_reconcile_effects`.
   * Scheduler-mode repositories may omit this and scan under BYPASSRLS.
   */
  workerId?: string;
  /** Durable worker-registry generation. Required with workerId on the worker path. */
  workerGeneration?: number;
  /**
   * Unforgeable claim secret from register() (process memory only).
   * Required on the worker (non-scheduler) path with workerId.
   */
  claimSecret?: string;
}

export interface ClaimedReconcileEffect {
  effect: KernelEffect;
  claimToken: string;
}

export interface RescheduleReconcileInput {
  effectId: string;
  tenantId: string;
  claimToken: string;
  reconcileAfter: string;
  lastError?: ReconcileQueryError;
}

export interface EscalateReconcileInput {
  effectId: string;
  tenantId: string;
  claimToken: string;
  reason: string;
  code?: ReconcileEscalationCode;
}

export interface FailEffectRequest {
  effectId: string;
  tenantId: string;
  lease: Pick<KernelLease, 'workerId' | 'workerGeneration' | 'token' | 'fencingEpoch'>;
  error: { code: string; message: string; retryable: boolean; details?: Record<string, unknown> };
  actor: string;
}

export interface CompensationAuthorizationRecord {
  id: string;
  tenantId: string;
  originalRunId: string;
  originalEffectId: string;
  compensationEffectType: string;
  adapterVersion: string;
  compensationPatch: Record<string, unknown>;
  forwardReceiptHash: string;
  policyDecisionId: string;
  policySnapshotId: string;
  decision: 'allow' | 'require_approval' | 'deny';
  actionDigest: string;
  expiresAt: string;
  approvalInteractionId?: string;
  /** Exact approval binding returned with a claimed, already-approved request. */
  approvalBinding?: {
    approvalId: string;
    approverPrincipalId: string;
    actionDigest: string;
    policySnapshotId: string;
    expiresAt: string;
  } | null;
}

export interface RequestCompensationInput {
  tenantId: string;
  authorizationId: string;
  actor: string;
}

export interface KernelCompensationRequest {
  id: string;
  tenantId: string;
  originalRunId: string;
  originalEffectId: string;
  compensationRunId: string;
  compensationStepId: string;
  adapterVersion: string;
  compensationEffectType: string;
  /** Original external destination, carried through the durable compensation claim. */
  destination: string;
  compensationPatch: Record<string, unknown>;
  forwardReceiptHash: string;
  authorizationId: string;
  reconcilePolicy: ReconcilePolicy;
  state:
    | 'AUTHORIZED'
    | 'CLAIMED'
    | 'COMPLETION_UNKNOWN'
    | 'COMPLETED'
    | 'CONFIRMED_NOT_APPLIED'
    | 'ESCALATED';
  claimWorkerId?: string;
  claimWorkerGeneration?: number;
  claimToken?: string;
  claimExpiresAt?: string;
  compensationEffectId?: string;
}

export type RequestCompensationResult =
  | { accepted: true; request: KernelCompensationRequest; replayed: boolean }
  | {
      accepted: false;
      requestId: string;
      reason:
        | 'AUTHORIZATION_NOT_FOUND'
        | 'FORWARD_EFFECT_NOT_FOUND'
        | 'FORWARD_RECEIPT_MISMATCH'
        | 'ACTION_DIGEST_MISMATCH'
        | 'POLICY_DENIED'
        | 'AUTHORIZATION_EXPIRED'
        | 'APPROVAL_REQUIRED'
        | 'APPROVAL_BINDING_MISMATCH';
    };

export interface CompensationClaimIdentity {
  workerId: string;
  workerGeneration: number;
  claimSecret: string;
}

export interface ClaimCompensationRequestInput extends CompensationClaimIdentity {
  requestId: string;
  outboxMessageId: string;
  leaseTtlMs?: number;
  now?: Date;
}

export interface ClaimedCompensationRequest {
  request: KernelCompensationRequest;
  forwardResponse: Record<string, unknown>;
  lease: KernelLease;
  outboxMessageId: string;
  outboxClaimToken: string;
  authorization: CompensationAuthorizationRecord;
}

export type CompensationDisposition =
  'COMPLETED' | 'CONFIRMED_NOT_APPLIED' | 'COMPLETION_UNKNOWN' | 'ESCALATED';

export interface FinalizeCompensationInput extends CompensationClaimIdentity {
  tenantId: string;
  requestId: string;
  effectId: string;
  disposition: Exclude<CompensationDisposition, 'COMPLETION_UNKNOWN'>;
  actor: string;
  outboxMessageId: string;
  outboxClaimToken: string;
  response?: Record<string, unknown>;
  /** Signed action-scoped receipt persisted atomically with the terminal mutation. */
  evidence?: KernelEvidenceRecord;
}

export interface ParkCompensationUnknownInput extends CompensationClaimIdentity {
  tenantId: string;
  requestId: string;
  effectId: string;
  actor: string;
  outboxMessageId: string;
  outboxClaimToken: string;
  error: { code: string; message: string };
}

export type CompensationMutationResult =
  | { applied: true; disposition: CompensationDisposition; replayed: boolean }
  | { applied: false; reason: string };

export type AdmitEffectResult =
  | { admitted: true; replayed: false; effect: KernelEffect }
  | { admitted: true; replayed: true; effect: KernelEffect }
  | {
      admitted: false;
      reason:
        | 'LEASE_LOST'
        | 'STEP_NOT_RUNNING'
        | 'IDEMPOTENCY_CONFLICT'
        | 'POLICY_SNAPSHOT_ID_REQUIRED'
        | 'LEASE_WORKER_ID_REQUIRED'
        | 'OPERATIONS_NOT_READY'
        | 'COMPENSATION_ADMISSION_UNAVAILABLE';
    };

export class KernelInvariantError extends Error {
  constructor(
    readonly code:
      | 'DUPLICATE_RUN'
      | 'DUPLICATE_STEP'
      | 'DUPLICATE_INTERACTION'
      | 'INVALID_GRAPH'
      | 'LEASE_LOST'
      | 'VERSION_CONFLICT'
      | 'INVALID_TRANSITION'
      | 'PRODUCTION_STORAGE_REQUIRED'
      | 'IDEMPOTENCY_CONFLICT'
      | 'TIMER_NOT_FOUND'
      | 'INTERACTION_NOT_FOUND'
      | 'INTERACTION_EXPIRED'
      | 'INTERACTION_ALREADY_ANSWERED'
      | 'STEP_NOT_FOUND'
      | 'KILL_SWITCH_LOOKUP_FAILED'
      | 'COMPENSATION_RECONCILIATION_REQUEST_MISSING'
      | 'COMPENSATION_RECONCILIATION_REQUEST_TERMINAL_RACE'
      | 'COMPENSATION_RECONCILIATION_RUN_MISSING'
      | 'COMPENSATION_RECONCILIATION_TERMINAL_TRANSITION_REJECTED',
    message: string,
  ) {
    super(message);
    this.name = 'KernelInvariantError';
  }
}

// ── Durable Timers ──────────────────────────────────────────────────────────

export type TimerType = 'INTERACTION_TIMEOUT' | 'RETRY_DELAY' | 'STEP_DEADLINE';
export type TimerState = 'PENDING' | 'PROCESSING' | 'FIRED' | 'CANCELLED';

export interface KernelTimer {
  id: string;
  runId: string;
  stepId: string;
  tenantId: string;
  firesAt: string;
  timerType: TimerType;
  state: TimerState;
  payload: Record<string, unknown>;
  createdAt: string;
  firedAt?: string;
  claimToken?: string;
}

export interface CreateTimerRequest {
  runId: string;
  stepId: string;
  tenantId: string;
  firesAt: Date;
  timerType: TimerType;
  payload?: Record<string, unknown>;
}

// ── Interactions ────────────────────────────────────────────────────────────

export type InteractionStatus = 'pending' | 'answered' | 'expired' | 'cancelled';

export interface KernelInteraction {
  id: string;
  runId: string;
  stepId: string;
  tenantId: string;
  status: InteractionStatus;
  prompt: string;
  response?: Record<string, unknown>;
  createdAt: string;
  answeredAt?: string;
  expiresAt?: string;
}

export interface CreateInteractionRequest {
  id?: string;
  runId: string;
  stepId: string;
  tenantId: string;
  prompt: string;
  expiresAt?: Date;
}

export interface AnswerInteractionRequest {
  interactionId: string;
  runId: string;
  tenantId: string;
  response: Record<string, unknown>;
  actor: string;
  /** When false, answer only; step stays WAITING_FOR_HUMAN. Default true. */
  releaseStep?: boolean;
}

// ── Kill switches (L4-04) ───────────────────────────────────────────────────

export type KillSwitchScope =
  'tenant' | 'package' | 'model' | 'tool' | 'destination' | 'effect-type';

export interface KillSwitch {
  tenantId: string;
  scope: KillSwitchScope;
  value: string;
  enabled: boolean;
  reason?: string;
  actor: string;
  updatedAt: string;
}

export interface PutKillSwitchInput {
  tenantId: string;
  scope: KillSwitchScope;
  value: string;
  enabled: boolean;
  reason?: string;
  actor: string;
}

export interface RemoveKillSwitchInput {
  tenantId: string;
  scope: KillSwitchScope;
  value: string;
}

export interface KillSwitchMatchDims {
  package?: string;
  model?: string;
  tool?: string;
  destination?: string;
  effectType?: string;
}

// ── Outbox DLQ ──────────────────────────────────────────────────────────────

export interface KernelDlqEntry {
  id: string;
  originalId: string;
  eventId: string;
  tenantId: string;
  topic: string;
  key: string;
  payload: Record<string, unknown>;
  attempts: number;
  dlqReason?: string;
  originalCreatedAt: string;
  movedToDlqAt: string;
}
