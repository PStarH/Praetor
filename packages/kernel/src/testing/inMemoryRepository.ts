/** Test-only model of the kernel repository. Never export from the package root. */
import { randomUUID } from 'node:crypto';
import { deriveEffectIdempotencyKey } from '@praetor/effect-broker';
import type { KernelRepository } from '../repository.js';
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
  KernelStep,
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
  ReconcileMutationReceipt,
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
} from '../types.js';
import { OPERATIONS_HEARTBEAT_TTL_MS } from '../types.js';
import { isClassAEffectType } from '@praetor/contracts';
import { findMatchingKillSwitchWithLookup } from '../killSwitchMatching.js';
import {
  KERNEL_COMPENSATION_TOPIC,
  LEGACY_COMPENSATION_TOPIC,
  type ClaimedCompensationWork,
  type CompensationClaimAuth,
} from '../ops/compensationConsumer.js';
import {
  canonicalCompensationHash,
  sealGovernedCompensationAuthorization,
  validateGovernedCompensationAuthorization,
  type GovernedCompensationAuthorization,
} from '../ops/compensationAuthority.js';
import { durableCompensationMetadataAuthorization } from '../ops/compensationPersistence.js';
import { KernelInvariantError } from '../types.js';
import { createReconcilePolicy, nextReconcileAfter } from '../reconcilePolicy.js';
import { assertRunTransition, assertStepTransition } from '../transitionValidation.js';
import { createHash } from 'node:crypto';
import {
  assertEvidenceRecordBoundToEffect,
  type KernelEvidenceRecord,
} from '../evidenceRepository.js';
import {
  generateWorkerClaimSecret,
  hashWorkerClaimSecret,
  verifyWorkerClaimSecret,
} from '../claimSecret.js';

const clone = <T>(value: T): T => structuredClone(value);
const now = () => new Date().toISOString();
const live = (
  lease: KernelStep['lease'],
  supplied: Pick<KernelLease, 'workerId' | 'workerGeneration' | 'token' | 'fencingEpoch'>,
) =>
  Boolean(
    lease &&
    lease.workerId === supplied.workerId &&
    lease.token === supplied.token &&
    lease.fencingEpoch === supplied.fencingEpoch &&
    (lease.workerGeneration ?? -1) === (supplied.workerGeneration ?? -1) &&
    Date.parse(lease.expiresAt) > Date.now(),
  );
const canonical = (value: unknown): string =>
  value === null || typeof value !== 'object'
    ? JSON.stringify(value)
    : Array.isArray(value)
      ? `[${value.map(canonical).join(',')}]`
      : `{${Object.keys(value as Record<string, unknown>)
          .sort()
          .map(
            (key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
          )
          .join(',')}}`;
const requestHash = (value: Record<string, unknown>): string =>
  createHash('sha256').update(canonical(value)).digest('hex');
const reconcileDefaults = (): Pick<
  KernelEffect,
  | 'reconcileAttempts'
  | 'governedActionDeadlineAt'
  | 'reconcilePolicy'
  | 'reconcileDisposition'
  | 'reconcileAfter'
  | 'reconcileObservedAt'
  | 'reconcileClaimToken'
  | 'reconcileClaimExpiresAt'
  | 'reconcileClaimedAt'
  | 'reconcileClaimWorkerId'
  | 'reconcileClaimWorkerGeneration'
  | 'reconcileLastError'
  | 'reconcileEscalatedAt'
  | 'reconcileEscalationCode'
> => ({
  reconcileAttempts: 0,
  governedActionDeadlineAt: null,
  reconcilePolicy: null,
  reconcileDisposition: null,
  reconcileAfter: null,
  reconcileObservedAt: null,
  reconcileClaimToken: null,
  reconcileClaimExpiresAt: null,
  reconcileClaimedAt: null,
  reconcileClaimWorkerId: null,
  reconcileClaimWorkerGeneration: null,
  reconcileLastError: null,
  reconcileEscalatedAt: null,
  reconcileEscalationCode: null,
});
const TERMINAL_RUN_STATES = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'COMPENSATED']);

export interface InMemoryKernelRepositoryOptions {
  /**
   * When false (worker claim path), authorize tenants from durable worker
   * records only — caller tenantIds cannot widen; empty caller tenantIds ≠ all.
   * Default true preserves legacy test fixtures that claim without seeding workers.
   */
  schedulerMode?: boolean;
}

type InMemoryWorkerRecord = {
  tenantIds: string[];
  status: 'ACTIVE' | 'DRAINING' | 'OFFLINE';
  generation: number;
  capabilities: string[];
  registeredAt: string;
  lastHeartbeatAt: string;
  identitySubject: string;
};

export class InMemoryKernelRepository implements KernelRepository {
  private readonly runs = new Map<string, KernelRun>();
  private readonly steps = new Map<string, KernelStep>();
  private readonly effectsByKey = new Map<string, KernelEffect>();
  private readonly effects = new Map<string, KernelEffect>();
  private readonly evidence = new Map<string, KernelEvidenceRecord>();
  private readonly events: KernelEvent[] = [];
  private readonly outbox = new Map<string, KernelOutboxMessage>();
  private readonly outboxClaims = new Map<string, { token: string; expiresAt: number }>();
  private readonly tenantLimits = new Map<string, number>();
  private readonly tenantControls = new Map<string, TenantExecutionControl>();
  private readonly lastFencingEpoch = new Map<string, number>();
  private readonly interactions = new Map<string, KernelInteraction>();
  private readonly workers = new Map<string, InMemoryWorkerRecord>();
  // WS2 EffectBroker monopoly state
  private readonly capabilityRevocations = new Map<
    string,
    { tenantId: string; expiresAt: number; reason?: string }
  >();
  /** Key: `${tenantId}|${jti}|${nonce}` → expiresAt ms */
  private readonly capabilityReplays = new Map<string, number>();
  private readonly effectAllowlist = new Map<string, Map<string, boolean>>(); // tenantId -> (actionPattern -> allowed)
  private readonly effectQuota = new Map<string, { countUsed: number; tokensUsed: number }>(); // `${tenantId}|${actionClass}|${day}`
  private readonly killSwitches = new Map<string, KillSwitch>(); // `${tenantId}|${scope}|${value}`
  /** workerId → claim secret hash for worker-mode claims. */
  private readonly claimSecretHashes = new Map<string, { generation: number; hash: Buffer }>();
  private readonly reconcileReceipts = new Map<
    string,
    {
      workerId: string;
      workerGeneration: number;
      claimTokenHash: string;
      requestFingerprint: string;
      result: Extract<ReconcileMutationResult, { applied: true }>;
    }
  >();
  private readonly compensationAuthorizations = new Map<string, CompensationAuthorizationRecord>();
  private readonly compensationRequests = new Map<string, KernelCompensationRequest>();
  private readonly compensationMutationReceipts = new Map<
    string,
    {
      fingerprint: string;
      result: Extract<CompensationMutationResult, { applied: true }>;
    }
  >();
  // Outbox DLQ (declared early so claimOutboxByTopic can filter DLQ'd messages)
  private readonly dlq = new Map<string, KernelDlqEntry>();
  /** Test-only: configurable maximum publish attempts before an outbox message is moved to the DLQ. */
  outboxMaxAttempts = 10;
  private readonly schedulerMode: boolean;

  constructor(options: InMemoryKernelRepositoryOptions = {}) {
    this.schedulerMode = options.schedulerMode ?? true;
  }

  async appendEvidence(record: KernelEvidenceRecord): Promise<{ inserted: boolean }> {
    const key = `${record.tenantId}\u0000${record.bundleId}`;
    const existing = this.evidence.get(key);
    if (existing) {
      if (canonical(existing) !== canonical(record)) throw new Error('EVIDENCE_CONFLICT');
      return { inserted: false };
    }
    this.evidence.set(key, clone(record));
    return { inserted: true };
  }

  async getEvidence(runId: string, tenantId: string): Promise<KernelEvidenceRecord | null> {
    const record = [...this.evidence.values()]
      .filter((candidate) => candidate.tenantId === tenantId && candidate.runId === runId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    return record ? clone(record) : null;
  }

  async listEvidence(tenantId: string): Promise<KernelEvidenceRecord[]> {
    return [...this.evidence.values()]
      .filter((record) => record.tenantId === tenantId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(clone);
  }

  async checkEvidenceRepositoryAvailability(): Promise<{ ready: boolean }> {
    return { ready: true };
  }

  /** Test-only: enqueue an arbitrary outbox message (used by compensation DLQ proofs). */
  seedOutboxMessage(input: {
    topic: string;
    tenantId?: string;
    key?: string;
    payload?: Record<string, unknown>;
    attempts?: number;
  }): KernelOutboxMessage {
    const createdAt = now();
    const message: KernelOutboxMessage = {
      id: randomUUID(),
      eventId: `evt_${randomUUID()}`,
      tenantId: input.tenantId ?? 'tenant-a',
      topic: input.topic,
      key: input.key ?? 'key',
      payload: input.payload ?? {},
      attempts: input.attempts ?? 0,
      availableAt: createdAt,
      createdAt,
    };
    this.outbox.set(message.id, message);
    return clone(message);
  }

  /** DR drill support: snapshot internal state for backup/restore testing.
   *  Includes the transactional outbox so that unpublished messages survive
   *  a backup/restore cycle (mirrors a real Postgres outbox table). */
  snapshot(): {
    runs: Map<string, KernelRun>;
    steps: Map<string, KernelStep>;
    interactions: Map<string, KernelInteraction>;
    events: KernelEvent[];
    outbox: Map<string, KernelOutboxMessage>;
    outboxClaims: Map<string, { token: string; expiresAt: number }>;
  } {
    return {
      runs: new Map([...this.runs].map(([k, v]) => [k, structuredClone(v)])),
      steps: new Map([...this.steps].map(([k, v]) => [k, structuredClone(v)])),
      interactions: new Map([...this.interactions].map(([k, v]) => [k, structuredClone(v)])),
      events: this.events.map((e) => structuredClone(e)),
      outbox: new Map([...this.outbox].map(([k, v]) => [k, structuredClone(v)])),
      outboxClaims: new Map([...this.outboxClaims].map(([k, v]) => [k, structuredClone(v)])),
    };
  }

  /** DR drill support: restore from a snapshot into this instance.
   *  The outbox fields are optional for backward compatibility with older
   *  snapshots that only carried runs/steps/events. */
  loadSnapshot(snapshot: {
    runs: Map<string, KernelRun>;
    steps: Map<string, KernelStep>;
    interactions?: Map<string, KernelInteraction>;
    events: KernelEvent[];
    outbox?: Map<string, KernelOutboxMessage>;
    outboxClaims?: Map<string, { token: string; expiresAt: number }>;
  }): void {
    this.runs.clear();
    for (const [k, v] of snapshot.runs) this.runs.set(k, v);
    this.steps.clear();
    for (const [k, v] of snapshot.steps) this.steps.set(k, v);
    this.interactions.clear();
    if (snapshot.interactions)
      for (const [k, v] of snapshot.interactions) this.interactions.set(k, structuredClone(v));
    this.events.length = 0;
    for (const e of snapshot.events) this.events.push(e);
    this.outbox.clear();
    if (snapshot.outbox)
      for (const [k, v] of snapshot.outbox) this.outbox.set(k, structuredClone(v));
    this.outboxClaims.clear();
    if (snapshot.outboxClaims)
      for (const [k, v] of snapshot.outboxClaims) this.outboxClaims.set(k, structuredClone(v));
  }

  async initialize(): Promise<void> {
    /* explicit no-op for tests */
  }

  /** Test helper: durable worker registry used by worker-mode claimNextStep. Returns claim secret. */
  seedTestWorker(
    workerId: string,
    tenantIds: string[],
    generation = 1,
    options?: {
      status?: 'ACTIVE' | 'DRAINING' | 'OFFLINE';
      claimSecret?: string;
      capabilities?: string[];
      registeredAt?: Date;
      lastHeartbeatAt?: Date;
      identitySubject?: string;
    },
  ): string {
    const claimSecret = options?.claimSecret ?? generateWorkerClaimSecret();
    this.workers.set(workerId, {
      tenantIds: [...tenantIds],
      status: options?.status ?? 'ACTIVE',
      generation,
      capabilities: [...(options?.capabilities ?? ['agent', 'tool'])],
      registeredAt: (options?.registeredAt ?? new Date()).toISOString(),
      lastHeartbeatAt: (options?.lastHeartbeatAt ?? new Date()).toISOString(),
      identitySubject: options?.identitySubject ?? workerId,
    });
    this.claimSecretHashes.set(workerId, {
      generation,
      hash: hashWorkerClaimSecret(claimSecret),
    });
    return claimSecret;
  }

  private resolveDurableWorkerTenantScope(
    workerId: string,
    workerGeneration: number,
    claimSecret?: string,
  ): { tenantIds: string[]; openEnded: boolean } | null {
    if (!claimSecret || claimSecret.length === 0) return null;
    const stored = this.claimSecretHashes.get(workerId);
    if (
      !stored ||
      stored.generation !== workerGeneration ||
      !verifyWorkerClaimSecret(claimSecret, stored.hash)
    ) {
      return null;
    }
    const worker = this.workers.get(workerId);
    if (!worker || worker.status !== 'ACTIVE' || worker.generation !== workerGeneration) {
      return null;
    }
    const parsed = worker.tenantIds.filter((t) => typeof t === 'string' && t.length > 0);
    // Product decision: durable '*' fail-closed (parity with claim_* DEFINER / SQLite).
    if (parsed.includes('*')) return null;
    if (parsed.length === 0) return null;
    return { tenantIds: parsed, openEnded: false };
  }

  async createRun(command: CreateKernelRun, actor: string): Promise<KernelRun> {
    if (this.runs.has(command.id))
      throw new KernelInvariantError('DUPLICATE_RUN', `Run ${command.id} already exists`);
    const ids = new Set(command.steps.map((step) => step.id));
    if (ids.size !== command.steps.length || [...ids].some((id) => this.steps.has(id)))
      throw new KernelInvariantError('DUPLICATE_STEP', 'Duplicate step ID');
    for (const step of command.steps)
      for (const dep of step.dependencies ?? [])
        if (!ids.has(dep))
          throw new KernelInvariantError('INVALID_GRAPH', `Unknown dependency ${dep}`);
    const interactionIds = command.steps.flatMap((step) =>
      step.interaction ? [step.interaction.id] : [],
    );
    if (
      new Set(interactionIds).size !== interactionIds.length ||
      interactionIds.some((id) => this.interactions.has(id))
    ) {
      throw new KernelInvariantError('DUPLICATE_INTERACTION', 'Duplicate interaction ID');
    }
    const createdAt = now();
    const run: KernelRun = {
      id: command.id,
      tenantId: command.tenantId,
      intentHash: command.intentHash,
      workGraphHash: command.workGraphHash,
      workGraphVersion: command.workGraphVersion,
      policySnapshotId: command.policySnapshotId,
      state: 'PENDING',
      version: 1,
      metadata: command.metadata ?? {},
      createdAt,
      updatedAt: createdAt,
    };
    this.runs.set(run.id, run);
    for (const newStep of command.steps) {
      const step: KernelStep = {
        id: newStep.id,
        runId: run.id,
        tenantId: run.tenantId,
        kind: newStep.kind,
        state: newStep.initialState ?? 'PENDING',
        version: 1,
        attempt: 0,
        maxAttempts: newStep.maxAttempts ?? 1,
        priority: newStep.priority ?? 0,
        dependencies: newStep.dependencies ?? [],
        input: newStep.input ?? {},
        scheduledAt: newStep.scheduledAt ?? createdAt,
        createdAt,
        updatedAt: createdAt,
      };
      this.steps.set(step.id, step);
      if (newStep.interaction) {
        const interaction: KernelInteraction = {
          id: newStep.interaction.id,
          runId: run.id,
          stepId: step.id,
          tenantId: run.tenantId,
          status: 'pending',
          prompt: newStep.interaction.prompt,
          createdAt,
          expiresAt: newStep.interaction.expiresAt,
        };
        this.interactions.set(interaction.id, interaction);
        this.event(
          'interaction',
          interaction.id,
          0,
          'interaction.created',
          run.tenantId,
          run.id,
          step.id,
          actor,
          {
            interactionId: interaction.id,
            prompt: interaction.prompt,
            expiresAt: interaction.expiresAt ?? null,
          },
        );
      }
    }
    this.event('run', run.id, run.version, 'run.created', run.tenantId, run.id, undefined, actor, {
      stepCount: command.steps.length,
    });
    return clone(run);
  }
  async setTenantConcurrencyLimit(tenantId: string, maxConcurrentSteps: number): Promise<void> {
    if (!Number.isInteger(maxConcurrentSteps) || maxConcurrentSteps <= 0) {
      throw new Error('maxConcurrentSteps must be a positive integer');
    }
    this.tenantLimits.set(tenantId, maxConcurrentSteps);
  }
  async getRun(runId: string, tenantId: string): Promise<KernelRun | null> {
    const record = this.runs.get(runId);
    return record?.tenantId === tenantId ? clone(record) : null;
  }
  async listRuns(tenantId: string, options?: { limit?: number }): Promise<KernelRun[]> {
    const requested = options?.limit ?? 50;
    const limit = Math.min(
      200,
      Math.max(1, Number.isFinite(requested) ? Math.trunc(requested) : 50),
    );
    return [...this.runs.values()]
      .filter((run) => run.tenantId === tenantId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id))
      .slice(0, limit)
      .map(clone);
  }
  async getStep(stepId: string, tenantId: string): Promise<KernelStep | null> {
    const record = this.steps.get(stepId);
    return record?.tenantId === tenantId ? clone(record) : null;
  }
  async claimNextStep(request: ClaimStepRequest): Promise<KernelStep | null> {
    const at = request.now ?? new Date();
    const workerGeneration = request.workerGeneration ?? -1;
    let tenantFilter: string[] | null; // null = open-ended (all tenants)
    if (!this.schedulerMode) {
      // Worker path: durable authz only — empty caller tenantIds must not mean all.
      const scope = this.resolveDurableWorkerTenantScope(
        request.workerId,
        workerGeneration,
        request.claimSecret,
      );
      if (!scope) return null;
      tenantFilter = scope.openEnded ? null : scope.tenantIds;
    } else {
      const caller = request.tenantIds ?? (request.tenantId ? [request.tenantId] : []);
      tenantFilter = caller.length === 0 ? null : caller;
    }
    const candidate = [...this.steps.values()]
      .filter(
        (step) =>
          (tenantFilter === null || tenantFilter.includes(step.tenantId)) &&
          (!request.capabilities ||
            request.capabilities.length === 0 ||
            request.capabilities.includes(step.kind)) &&
          ['PENDING', 'RETRY_WAIT'].includes(step.state) &&
          !this.tenantControls.get(step.tenantId)?.paused &&
          ['PENDING', 'RUNNING'].includes(this.runs.get(step.runId)?.state ?? 'FAILED') &&
          this.runs.get(step.runId)?.metadata.compensationRequestId == null &&
          Date.parse(step.scheduledAt) <= at.getTime() &&
          step.dependencies.every((id) =>
            ['SUCCEEDED', 'SKIPPED'].includes(this.steps.get(id)?.state ?? 'FAILED'),
          ) &&
          [...this.steps.values()].filter(
            (other) => other.tenantId === step.tenantId && other.state === 'RUNNING',
          ).length < (this.tenantLimits.get(step.tenantId) ?? Number.MAX_SAFE_INTEGER),
      )
      .sort((a, b) => {
        // Aging: boost priority by +1 per minute of waiting, capped at 1000.
        const ageA = Math.floor((at.getTime() - Date.parse(a.scheduledAt)) / 60_000);
        const ageB = Math.floor((at.getTime() - Date.parse(b.scheduledAt)) / 60_000);
        const boostedA = Math.min(a.priority + ageA, 1000);
        const boostedB = Math.min(b.priority + ageB, 1000);
        // Sort by: fewest running steps for tenant → boosted priority → earliest scheduled
        const runningA = [...this.steps.values()].filter(
          (s) => s.tenantId === a.tenantId && s.state === 'RUNNING',
        ).length;
        const runningB = [...this.steps.values()].filter(
          (s) => s.tenantId === b.tenantId && s.state === 'RUNNING',
        ).length;
        return (
          runningA - runningB || boostedB - boostedA || a.scheduledAt.localeCompare(b.scheduledAt)
        );
      })[0];
    if (!candidate) return null;
    assertStepTransition(candidate.state, 'RUNNING');
    const run = this.runs.get(candidate.runId)!;
    if (run.state === 'PENDING') assertRunTransition(run.state, 'RUNNING');
    candidate.state = 'RUNNING';
    candidate.version++;
    candidate.attempt++;
    candidate.updatedAt = at.toISOString();
    const lastEpoch = candidate.lease?.fencingEpoch ?? this.lastFencingEpoch.get(candidate.id) ?? 0;
    candidate.lease = {
      workerId: request.workerId,
      workerGeneration: request.workerGeneration ?? 0,
      token: randomUUID(),
      fencingEpoch: lastEpoch + 1,
      expiresAt: new Date(at.getTime() + request.leaseTtlMs).toISOString(),
    };
    this.lastFencingEpoch.delete(candidate.id);
    if (run.state === 'PENDING') {
      run.state = 'RUNNING';
      run.version++;
      run.updatedAt = at.toISOString();
    }
    this.event(
      'step',
      candidate.id,
      candidate.version,
      'step.claimed',
      candidate.tenantId,
      candidate.runId,
      candidate.id,
      request.workerId,
      { fencingEpoch: candidate.lease.fencingEpoch },
    );
    return clone(candidate);
  }
  async heartbeatStep(
    stepId: string,
    tenantId: string,
    lease: Pick<KernelLease, 'workerId' | 'workerGeneration' | 'token' | 'fencingEpoch'>,
    leaseTtlMs: number,
  ): Promise<KernelStep | null> {
    const step = this.steps.get(stepId);
    if (!step || step.tenantId !== tenantId || step.state !== 'RUNNING' || !live(step.lease, lease))
      return null;
    step.lease!.expiresAt = new Date(Date.now() + leaseTtlMs).toISOString();
    step.updatedAt = now();
    return clone(step);
  }
  async reclaimExpiredLeases(at = new Date(), limit = 100): Promise<KernelStep[]> {
    const reclaimed: KernelStep[] = [];
    for (const step of [...this.steps.values()]
      .filter(
        (candidate) =>
          candidate.state === 'RUNNING' &&
          candidate.lease &&
          Date.parse(candidate.lease.expiresAt) <= at.getTime(),
      )
      .slice(0, limit)) {
      const retryable = step.attempt < step.maxAttempts;
      const hasAdmittedEffect = [...this.effects.values()].some(
        (effect) =>
          effect.stepId === step.id &&
          effect.tenantId === step.tenantId &&
          effect.state === 'ADMITTED',
      );
      const nextState = hasAdmittedEffect
        ? 'WAITING_FOR_RECONCILIATION'
        : retryable
          ? 'RETRY_WAIT'
          : 'FAILED';
      assertStepTransition(step.state, nextState);
      const fencingEpoch = step.lease?.fencingEpoch ?? 0;
      if (step.lease) this.lastFencingEpoch.set(step.id, step.lease.fencingEpoch);
      step.state = nextState;
      step.version++;
      step.lease = undefined;
      step.updatedAt = at.toISOString();
      step.scheduledAt = !hasAdmittedEffect && retryable ? at.toISOString() : step.scheduledAt;
      step.error = {
        code: 'LEASE_EXPIRED',
        message: 'Worker lease expired before terminal transition',
        retryable: !hasAdmittedEffect && retryable,
      };
      this.event(
        'step',
        step.id,
        step.version,
        retryable ? 'step.lease_expired_requeued' : 'step.lease_expired_failed',
        step.tenantId,
        step.runId,
        step.id,
        'kernel.recovery',
        { attempt: step.attempt },
      );
      this.parkOrphanAdmittedEffects(step, 'lease_expired', 'kernel.recovery');
      if (!retryable && !hasAdmittedEffect) {
        if (!this.requestCompensationIfNeeded(step, fencingEpoch, 'kernel.recovery', at)) {
          this.finish(step.runId, 'kernel.recovery');
        }
      }
      reclaimed.push(clone(step));
    }
    return reclaimed;
  }
  async completeStep(request: CompleteStepRequest): Promise<KernelStep | null> {
    const step = this.steps.get(request.stepId);
    if (
      !step ||
      step.tenantId !== request.tenantId ||
      step.state !== 'RUNNING' ||
      step.version !== request.expectedVersion ||
      !live(step.lease, request.lease)
    )
      return null;
    assertStepTransition(step.state, 'SUCCEEDED');
    step.state = 'SUCCEEDED';
    step.output = request.output;
    step.version++;
    step.lease = undefined;
    step.updatedAt = now();
    this.event(
      'step',
      step.id,
      step.version,
      'step.succeeded',
      step.tenantId,
      step.runId,
      step.id,
      request.actor,
      {},
    );
    this.parkOrphanAdmittedEffects(step, 'step_succeeded', request.actor);
    this.finish(step.runId, request.actor);
    return clone(step);
  }
  async failStep(request: FailStepRequest): Promise<KernelStep | null> {
    const step = this.steps.get(request.stepId);
    if (
      !step ||
      step.tenantId !== request.tenantId ||
      step.state !== 'RUNNING' ||
      step.version !== request.expectedVersion ||
      !live(step.lease, request.lease)
    )
      return null;
    if (request.refundAttempt && step.attempt > 0) step.attempt -= 1;
    const retry =
      request.error.retryable && Boolean(request.retryAt) && step.attempt < step.maxAttempts;
    const nextState = retry ? 'RETRY_WAIT' : 'FAILED';
    assertStepTransition(step.state, nextState);
    const fencingEpoch = step.lease?.fencingEpoch ?? this.lastFencingEpoch.get(step.id) ?? 0;
    if (step.lease) this.lastFencingEpoch.set(step.id, step.lease.fencingEpoch);
    step.state = nextState;
    step.error = request.error;
    step.scheduledAt = request.retryAt?.toISOString() ?? step.scheduledAt;
    step.version++;
    step.lease = undefined;
    step.updatedAt = now();
    this.event(
      'step',
      step.id,
      step.version,
      retry ? 'step.retry_scheduled' : 'step.failed',
      step.tenantId,
      step.runId,
      step.id,
      request.actor,
      { error: request.error, refundAttempt: Boolean(request.refundAttempt) },
    );
    this.parkOrphanAdmittedEffects(step, 'step_failed', request.actor);
    if (!retry && !this.requestCompensationIfNeeded(step, fencingEpoch, request.actor)) {
      this.finish(step.runId, request.actor);
    }
    return clone(step);
  }
  async wakeRetryStep(stepId: string, tenantId: string, actor: string): Promise<KernelStep | null> {
    const step = this.steps.get(stepId);
    if (!step || step.tenantId !== tenantId || step.state !== 'RETRY_WAIT') return null;
    step.scheduledAt = now();
    step.version++;
    step.lease = undefined;
    step.updatedAt = step.scheduledAt;
    this.event(
      'step',
      step.id,
      step.version,
      'step.retry_woken',
      step.tenantId,
      step.runId,
      step.id,
      actor,
      {},
    );
    return clone(step);
  }
  async failStepByTimer(
    stepId: string,
    tenantId: string,
    error: { code: string; message: string; retryable: boolean; details?: Record<string, unknown> },
    actor: string,
  ): Promise<KernelStep | null> {
    const step = this.steps.get(stepId);
    if (
      !step ||
      step.tenantId !== tenantId ||
      ['SUCCEEDED', 'FAILED', 'CANCELLED', 'SKIPPED'].includes(step.state)
    )
      return null;
    const wasRunning = step.state === 'RUNNING';
    assertStepTransition(step.state, 'FAILED');
    const fencingEpoch = step.lease?.fencingEpoch ?? this.lastFencingEpoch.get(step.id) ?? 0;
    if (step.lease) this.lastFencingEpoch.set(step.id, step.lease.fencingEpoch);
    step.state = 'FAILED';
    step.error = error;
    step.version++;
    step.lease = undefined;
    step.updatedAt = now();
    this.event(
      'step',
      step.id,
      step.version,
      'step.failed',
      step.tenantId,
      step.runId,
      step.id,
      actor,
      { error },
    );
    if (wasRunning) this.parkOrphanAdmittedEffects(step, 'step_failed', actor);
    if (!this.requestCompensationIfNeeded(step, fencingEpoch, actor)) {
      this.finish(step.runId, actor);
    }
    return clone(step);
  }
  async pauseRun(runId: string, tenantId: string, actor: string): Promise<KernelRun | null> {
    const run = this.runs.get(runId);
    if (!run || run.tenantId !== tenantId || !['PENDING', 'RUNNING'].includes(run.state))
      return null;
    assertRunTransition(run.state, 'PAUSED');
    for (const step of this.steps.values()) {
      if (step.runId === runId && step.tenantId === tenantId && step.state === 'RUNNING') {
        assertStepTransition(step.state, 'RETRY_WAIT');
      }
    }
    run.state = 'PAUSED';
    run.version++;
    run.updatedAt = now();
    run.pausedAt = run.updatedAt;
    for (const step of this.steps.values()) {
      if (step.runId === runId && step.tenantId === tenantId && step.state === 'RUNNING') {
        if (step.lease) this.lastFencingEpoch.set(step.id, step.lease.fencingEpoch);
        step.state = 'RETRY_WAIT';
        step.version++;
        step.lease = undefined;
        step.updatedAt = run.updatedAt;
        this.parkOrphanAdmittedEffects(step, 'run_paused', actor);
        this.event(
          'step',
          step.id,
          step.version,
          'step.paused',
          step.tenantId,
          step.runId,
          step.id,
          actor,
          { previousState: 'RUNNING' },
        );
      }
    }
    this.event('run', run.id, run.version, 'run.paused', tenantId, runId, undefined, actor, {});
    return clone(run);
  }
  async resumeRun(runId: string, tenantId: string, actor: string): Promise<KernelRun | null> {
    const run = this.runs.get(runId);
    if (!run || run.tenantId !== tenantId || run.state !== 'PAUSED') return null;
    assertRunTransition(run.state, 'RUNNING');
    run.state = 'RUNNING';
    run.version++;
    run.updatedAt = now();
    run.pausedAt = undefined;
    this.event('run', run.id, run.version, 'run.resumed', tenantId, runId, undefined, actor, {});
    return clone(run);
  }
  async cancelRun(runId: string, tenantId: string, actor: string): Promise<KernelRun | null> {
    const run = this.runs.get(runId);
    if (!run || run.tenantId !== tenantId || !['PENDING', 'RUNNING', 'PAUSED'].includes(run.state))
      return null;
    assertRunTransition(run.state, 'CANCELLED');
    for (const step of this.steps.values()) {
      if (
        step.runId === runId &&
        step.tenantId === tenantId &&
        !['SUCCEEDED', 'FAILED', 'CANCELLED', 'SKIPPED'].includes(step.state)
      ) {
        assertStepTransition(step.state, 'CANCELLED');
      }
    }
    run.state = 'CANCELLED';
    run.version++;
    run.updatedAt = now();
    run.terminalAt = run.updatedAt;
    for (const step of this.steps.values()) {
      if (
        step.runId === runId &&
        step.tenantId === tenantId &&
        !['SUCCEEDED', 'FAILED', 'CANCELLED', 'SKIPPED'].includes(step.state)
      ) {
        const previousState = step.state;
        step.state = 'CANCELLED';
        step.version++;
        step.lease = undefined;
        step.updatedAt = run.updatedAt;
        this.parkOrphanAdmittedEffects(step, 'run_cancelled', actor);
        this.event(
          'step',
          step.id,
          step.version,
          'step.cancelled',
          step.tenantId,
          step.runId,
          step.id,
          actor,
          { previousState },
        );
      }
    }
    this.event('run', run.id, run.version, 'run.cancelled', tenantId, runId, undefined, actor, {});
    return clone(run);
  }
  async pauseTenant(
    tenantId: string,
    actor: string,
    reason?: string,
  ): Promise<TenantExecutionControl> {
    const affected = [...this.steps.values()].filter(
      (step) => step.tenantId === tenantId && step.state === 'RUNNING',
    );
    for (const step of affected) assertStepTransition(step.state, 'RETRY_WAIT');
    const previous = this.tenantControls.get(tenantId);
    const pausedAt = now();
    const control: TenantExecutionControl = {
      tenantId,
      paused: true,
      generation: (previous?.generation ?? 0) + 1,
      actor,
      reason,
      pausedAt,
    };
    this.tenantControls.set(tenantId, control);
    for (const step of affected) {
      if (step.lease) this.lastFencingEpoch.set(step.id, step.lease.fencingEpoch);
      step.state = 'RETRY_WAIT';
      step.version++;
      step.lease = undefined;
      step.updatedAt = pausedAt;
      step.scheduledAt = pausedAt;
      this.parkOrphanAdmittedEffects(step, 'tenant_paused', actor);
      this.event(
        'step',
        step.id,
        step.version,
        'step.tenant_paused',
        tenantId,
        step.runId,
        step.id,
        actor,
        { reason },
      );
    }
    this.event(
      'tenant',
      tenantId,
      control.generation,
      'tenant.paused',
      tenantId,
      `tenant:${tenantId}`,
      undefined,
      actor,
      { reason },
    );
    return clone(control);
  }
  async resumeTenant(tenantId: string, actor: string): Promise<TenantExecutionControl> {
    const previous = this.tenantControls.get(tenantId);
    const control: TenantExecutionControl = {
      tenantId,
      paused: false,
      generation: (previous?.generation ?? 0) + 1,
      actor,
      resumedAt: now(),
    };
    this.tenantControls.set(tenantId, control);
    this.event(
      'tenant',
      tenantId,
      control.generation,
      'tenant.resumed',
      tenantId,
      `tenant:${tenantId}`,
      undefined,
      actor,
      {},
    );
    return clone(control);
  }
  async getTenantExecutionControl(tenantId: string): Promise<TenantExecutionControl> {
    const control = this.tenantControls.get(tenantId);
    return clone(control ?? { tenantId, paused: false, generation: 0, actor: 'kernel' });
  }
  async getOperationsReadiness(tenantId: string, at = new Date()): Promise<OperationsReadiness> {
    const threshold = at.getTime() - OPERATIONS_HEARTBEAT_TTL_MS;
    const count = (capability: string) =>
      [...this.workers.values()].filter(
        (worker) =>
          worker.status === 'ACTIVE' &&
          worker.identitySubject === 'db:commander_adapter_ops' &&
          worker.tenantIds.includes(tenantId) &&
          worker.capabilities.length === 1 &&
          worker.capabilities[0] === capability &&
          Date.parse(worker.lastHeartbeatAt) > Date.parse(worker.registeredAt) &&
          Date.parse(worker.lastHeartbeatAt) >= threshold,
      ).length;
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
    return this.admitEffectValidated(request, false);
  }
  private async admitEffectValidated(
    request: AdmitEffectRequest,
    canonicalCompensationAdmission: boolean,
  ): Promise<AdmitEffectResult> {
    // Fail-closed: never let a blank policySnapshotId / lease.workerId slip
    // through to storage where it would otherwise coerce to 'legacy-unbound'.
    if (!request.policySnapshotId || !request.policySnapshotId.trim()) {
      return { admitted: false, reason: 'POLICY_SNAPSHOT_ID_REQUIRED' };
    }
    if (!request.lease.workerId || !request.lease.workerId.trim()) {
      return { admitted: false, reason: 'LEASE_WORKER_ID_REQUIRED' };
    }
    const isCompensation = request.type.toLowerCase().startsWith('compensate.');
    const key = `${request.tenantId}:${request.idempotencyKey}`;
    const step = this.steps.get(request.stepId);
    if (
      !step ||
      step.runId !== request.runId ||
      step.tenantId !== request.tenantId ||
      step.state !== 'RUNNING' ||
      !live(step.lease, request.lease)
    ) {
      return { admitted: false, reason: 'LEASE_LOST' };
    }
    if (isCompensation && !canonicalCompensationAdmission) {
      const binding = request.compensationBinding;
      const run = this.runs.get(request.runId);
      const evidence = run ? this.compensationAuthorization(run) : null;
      const stepAuthorization = (step.input as { authorization?: unknown }).authorization;
      const worker = this.workers.get(request.lease.workerId);
      // The compact producer payload is located by its outbox claim token; it
      // is only a cross-check against the durable rows resolved below.
      const outboxMessage = binding
        ? [...this.outbox.values()].find(
            (message) =>
              !message.publishedAt &&
              message.topic === KERNEL_COMPENSATION_TOPIC &&
              this.outboxClaims.get(message.id)?.token === binding.claimToken,
          )
        : undefined;
      const payload = outboxMessage?.payload;
      const payloadRequestId = typeof payload?.requestId === 'string' ? payload.requestId : null;
      const payloadAuthorizationId =
        typeof payload?.authorizationId === 'string' ? payload.authorizationId : null;
      const payloadTenantId = typeof payload?.tenantId === 'string' ? payload.tenantId : null;
      const payloadActionDigest =
        typeof payload?.actionDigest === 'string' ? payload.actionDigest : null;
      // Mirror claimCompensationWork: the durable compensation request is the
      // resolution root, then its authorization record, then the completed
      // forward effect.
      const durableRequest = payloadRequestId
        ? this.compensationRequests.get(payloadRequestId)
        : undefined;
      const durableAuthorization = durableRequest
        ? this.compensationAuthorizations.get(durableRequest.authorizationId)
        : undefined;
      const originalEffect = durableRequest
        ? this.effects.get(durableRequest.originalEffectId)
        : undefined;
      const governed =
        durableRequest && durableAuthorization && originalEffect?.state === 'COMPLETED' && evidence
          ? this.governedCompensationAuthorizationFromDurableEvidence({
              evidence,
              request: durableRequest,
              durableAuthorization,
              originalEffect,
            })
          : null;
      if (
        !governed ||
        !binding ||
        canonical(stepAuthorization) !== canonical(evidence) ||
        payloadTenantId !== request.tenantId ||
        payloadRequestId !== durableRequest?.id ||
        payloadAuthorizationId !== durableAuthorization?.id ||
        payloadActionDigest !== durableAuthorization?.actionDigest ||
        durableRequest?.tenantId !== request.tenantId ||
        durableRequest?.authorizationId !== durableAuthorization?.id ||
        binding.authorizationId !== governed.authorizationId ||
        binding.requestId !== governed.requestId ||
        binding.claimToken !== request.lease.token ||
        governed.compensationEffectId !== request.id ||
        governed.compensationEffectType !== request.type ||
        governed.compensationRunId !== request.runId ||
        governed.compensationStepId !== request.stepId ||
        governed.idempotencyKey !== request.idempotencyKey ||
        governed.policyDecisionId !== request.policyDecisionId ||
        governed.policySnapshotId !== request.policySnapshotId ||
        governed.actionDigest !== request.actionDigest ||
        canonical(governed.compensationRequest) !== canonical(request.request) ||
        worker?.identitySubject !== 'db:commander_adapter_ops' ||
        worker.generation !== request.lease.workerGeneration ||
        worker.status !== 'ACTIVE' ||
        worker.capabilities.length !== 1 ||
        worker.capabilities[0] !== 'effect.compensate' ||
        !worker.tenantIds.includes(request.tenantId)
      ) {
        return { admitted: false, reason: 'COMPENSATION_ADMISSION_UNAVAILABLE' };
      }
    }
    const fingerprint = requestHash(request.request);
    const previous = this.effectsByKey.get(key);
    if (previous) {
      if (
        previous.runId !== request.runId ||
        previous.stepId !== request.stepId ||
        previous.type !== request.type ||
        previous.requestHash !== fingerprint ||
        previous.policyDecisionId !== request.policyDecisionId ||
        previous.policySnapshotId !== request.policySnapshotId ||
        previous.actionDigest !== request.actionDigest
      ) {
        return { admitted: false, reason: 'IDEMPOTENCY_CONFLICT' };
      }
      if (
        isClassAEffectType(request.type) &&
        !isCompensation &&
        previous.state !== 'COMPLETED' &&
        !(await this.getOperationsReadiness(request.tenantId)).ready
      ) {
        return { admitted: false, reason: 'OPERATIONS_NOT_READY' };
      }
      return { admitted: true, replayed: true, effect: clone(previous) };
    }
    if (
      isClassAEffectType(request.type) &&
      !isCompensation &&
      !(await this.getOperationsReadiness(request.tenantId)).ready
    ) {
      return { admitted: false, reason: 'OPERATIONS_NOT_READY' };
    }
    const effect: KernelEffect = {
      id: request.id,
      runId: request.runId,
      stepId: request.stepId,
      tenantId: request.tenantId,
      type: request.type,
      idempotencyKey: request.idempotencyKey,
      requestHash: fingerprint,
      policyDecisionId: request.policyDecisionId,
      policySnapshotId: request.policySnapshotId,
      actionDigest: request.actionDigest,
      leaseWorkerId: request.lease.workerId,
      leaseWorkerGeneration: request.lease.workerGeneration ?? -1,
      leaseFencingEpoch: request.lease.fencingEpoch,
      state: 'ADMITTED',
      request: request.request,
      createdAt: now(),
      ...reconcileDefaults(),
    };
    this.effects.set(effect.id, effect);
    this.effectsByKey.set(key, effect);
    this.event(
      'effect',
      effect.id,
      1,
      'effect.admitted',
      effect.tenantId,
      effect.runId,
      effect.stepId,
      request.actor,
      {
        type: effect.type,
        policySnapshotId: effect.policySnapshotId,
        actionDigest: effect.actionDigest,
      },
    );
    return { admitted: true, replayed: false, effect: clone(effect) };
  }
  async completeEffect(
    effectId: string,
    tenantId: string,
    lease: Pick<KernelLease, 'workerId' | 'workerGeneration' | 'token' | 'fencingEpoch'>,
    response: Record<string, unknown>,
    actor: string,
  ): Promise<KernelEffect | null> {
    const effect = this.effects.get(effectId);
    const step = effect ? this.steps.get(effect.stepId) : undefined;
    if (
      !effect ||
      !step ||
      effect.tenantId !== tenantId ||
      effect.state !== 'ADMITTED' ||
      step.state !== 'RUNNING' ||
      !live(step.lease, lease)
    )
      return null;
    effect.state = 'COMPLETED';
    effect.response = response;
    effect.completedAt = now();
    this.event(
      'effect',
      effect.id,
      2,
      'effect.completed',
      tenantId,
      effect.runId,
      effect.stepId,
      actor,
      {},
    );
    return clone(effect);
  }
  async completeEffectWithEvidence(
    effectId: string,
    tenantId: string,
    lease: Pick<KernelLease, 'workerId' | 'workerGeneration' | 'token' | 'fencingEpoch'>,
    response: Record<string, unknown>,
    actor: string,
    evidence: KernelEvidenceRecord,
  ): Promise<KernelEffect | null> {
    const effect = this.effects.get(effectId);
    const step = effect ? this.steps.get(effect.stepId) : undefined;
    const run = effect ? this.runs.get(effect.runId) : undefined;
    const compensationComplete =
      !!effect &&
      effect.type.startsWith('compensate.') &&
      !!run &&
      run.state === 'COMPENSATING' &&
      !!step &&
      effect.tenantId === tenantId &&
      effect.state === 'ADMITTED';
    if (!compensationComplete) {
      if (
        !effect ||
        !step ||
        effect.tenantId !== tenantId ||
        effect.state !== 'ADMITTED' ||
        step.state !== 'RUNNING' ||
        !live(step.lease, lease)
      )
        return null;
    }
    assertEvidenceRecordBoundToEffect(evidence, { ...effect, state: 'COMPLETED' });
    const evidenceKey = `${evidence.tenantId}\u0000${evidence.bundleId}`;
    const existing = this.evidence.get(evidenceKey);
    if (existing && canonical(existing) !== canonical(evidence))
      throw new Error('EVIDENCE_CONFLICT');

    effect.state = 'COMPLETED';
    effect.response = response;
    effect.completedAt = now();
    if (!existing) this.evidence.set(evidenceKey, clone(evidence));
    this.event(
      'effect',
      effect.id,
      2,
      'effect.completed',
      tenantId,
      effect.runId,
      effect.stepId,
      actor,
      {},
    );
    return clone(effect);
  }
  async failEffectWithEvidence(
    request: FailEffectRequest & { evidence: KernelEvidenceRecord },
  ): Promise<KernelEffect | null> {
    const effect = this.effects.get(request.effectId);
    const step = effect ? this.steps.get(effect.stepId) : undefined;
    if (
      !effect ||
      !step ||
      effect.tenantId !== request.tenantId ||
      effect.state !== 'ADMITTED' ||
      step.state !== 'RUNNING' ||
      !live(step.lease, request.lease)
    ) {
      return null;
    }
    const projected = { ...effect, state: 'FAILED' as const };
    assertEvidenceRecordBoundToEffect(request.evidence, projected);
    const evidenceKey = `${request.evidence.tenantId}\u0000${request.evidence.bundleId}`;
    const existing = this.evidence.get(evidenceKey);
    if (existing && canonical(existing) !== canonical(request.evidence)) {
      throw new Error('EVIDENCE_CONFLICT');
    }
    effect.state = 'FAILED';
    effect.response = clone(request.error);
    effect.completedAt = now();
    if (!existing) this.evidence.set(evidenceKey, clone(request.evidence));
    this.event(
      'effect',
      effect.id,
      2,
      'effect.failed',
      request.tenantId,
      effect.runId,
      effect.stepId,
      request.actor,
      { error: request.error },
    );
    return clone(effect);
  }
  async markEffectCompletionUnknown(
    request: MarkEffectCompletionUnknownRequest,
  ): Promise<KernelEffect | null> {
    const effect = this.effects.get(request.effectId);
    const step = effect ? this.steps.get(effect.stepId) : undefined;
    const run = effect ? this.runs.get(effect.runId) : undefined;
    if (
      !effect ||
      !step ||
      !run ||
      effect.tenantId !== request.tenantId ||
      effect.state !== 'ADMITTED' ||
      step.state !== 'RUNNING' ||
      !['RUNNING', 'COMPENSATING'].includes(run.state) ||
      (request.lease !== undefined && !live(step.lease, request.lease))
    )
      return null;
    const unknownAt = now();
    effect.state = 'COMPLETION_UNKNOWN';
    effect.response = { completionUnknownReason: request.reason };
    effect.governedActionDeadlineAt = request.governedActionDeadlineAt ?? null;
    effect.reconcilePolicy = createReconcilePolicy({
      unknownAt,
      governedActionDeadlineAt: request.governedActionDeadlineAt,
    });
    effect.reconcileDisposition = 'PENDING';
    effect.reconcileAfter = unknownAt;
    effect.reconcileAttempts = 0;
    step.state = 'WAITING_FOR_RECONCILIATION';
    step.version += 1;
    if (step.lease) this.lastFencingEpoch.set(step.id, step.lease.fencingEpoch);
    step.lease = undefined;
    step.updatedAt = unknownAt;
    this.event(
      'effect',
      effect.id,
      2,
      'effect.completion_unknown',
      effect.tenantId,
      effect.runId,
      effect.stepId,
      request.actor,
      { reason: request.reason },
    );
    return clone(effect);
  }
  async parkEffectCompletionUnknown(
    input: ParkEffectCompletionUnknownInput,
  ): Promise<ParkEffectCompletionUnknownResult> {
    const effect = this.effects.get(input.effectId);
    if (!effect || effect.tenantId !== input.tenantId) {
      return { parked: false, reason: 'NOT_FOUND' };
    }
    const step = this.steps.get(effect.stepId);
    const run = this.runs.get(effect.runId);
    if (!step || !run) return { parked: false, reason: 'NOT_FOUND' };
    const scope = this.resolveDurableWorkerTenantScope(
      input.workerId,
      input.workerGeneration,
      input.claimSecret,
    );
    const worker = this.workers.get(input.workerId);
    if (
      !scope?.tenantIds.includes(input.tenantId) ||
      (!worker?.capabilities.includes('effect.execute') && !worker?.capabilities.includes('tool'))
    ) {
      return { parked: false, reason: 'LEASE_FENCED' };
    }
    const fingerprint = requestHash({
      tenantId: input.tenantId,
      effectId: input.effectId,
      workerId: input.workerId,
      workerGeneration: input.workerGeneration,
      leaseTokenHash: createHash('sha256').update(input.leaseToken).digest('hex'),
      fencingEpoch: input.fencingEpoch,
    });
    const prior = (effect.response as { completionUnknownFingerprint?: string } | undefined)
      ?.completionUnknownFingerprint;
    if (effect.state === 'COMPLETION_UNKNOWN') {
      return prior === fingerprint
        ? { parked: true, replayed: true, effect: clone(effect) }
        : { parked: false, reason: 'ADMISSION_BINDING_MISMATCH' };
    }
    if (effect.state !== 'ADMITTED') {
      return { parked: false, reason: 'NOT_ADMITTED_OR_UNKNOWN' };
    }
    if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'SKIPPED'].includes(step.state)) {
      return { parked: false, reason: 'STEP_TERMINAL_RACE' };
    }
    if (
      step.state !== 'RUNNING' ||
      !step.lease ||
      step.lease.workerId !== input.workerId ||
      step.lease.workerGeneration !== input.workerGeneration ||
      step.lease.token !== input.leaseToken ||
      step.lease.fencingEpoch !== input.fencingEpoch ||
      effect.leaseWorkerId !== input.workerId ||
      effect.leaseWorkerGeneration !== input.workerGeneration ||
      effect.leaseFencingEpoch !== input.fencingEpoch
    ) {
      return { parked: false, reason: 'ADMISSION_BINDING_MISMATCH' };
    }
    const unknownAt = now();
    effect.state = 'COMPLETION_UNKNOWN';
    effect.response = {
      completionUnknownError: clone(input.error),
      completionUnknownFingerprint: fingerprint,
    };
    effect.governedActionDeadlineAt = input.governedActionDeadlineAt ?? null;
    effect.reconcilePolicy = createReconcilePolicy({
      unknownAt,
      governedActionDeadlineAt: input.governedActionDeadlineAt,
    });
    effect.reconcileDisposition = 'PENDING';
    effect.reconcileAfter = unknownAt;
    effect.reconcileAttempts = 0;
    effect.reconcileLastError = { ...input.error };
    step.state = 'WAITING_FOR_RECONCILIATION';
    step.version += 1;
    step.lease = undefined;
    step.updatedAt = unknownAt;
    this.event(
      'effect',
      effect.id,
      2,
      'effect.completion_unknown',
      effect.tenantId,
      effect.runId,
      effect.stepId,
      input.workerId,
      { error: input.error },
    );
    return { parked: true, replayed: false, effect: clone(effect) };
  }
  private parkOrphanAdmittedEffects(
    step: Pick<KernelStep, 'id' | 'tenantId' | 'runId'>,
    reason: string,
    actor: string,
  ): void {
    for (const effect of this.effects.values()) {
      if (
        effect.stepId === step.id &&
        effect.tenantId === step.tenantId &&
        effect.state === 'ADMITTED'
      ) {
        const unknownAt = now();
        effect.state = 'COMPLETION_UNKNOWN';
        effect.response = { completionUnknownReason: reason };
        effect.reconcilePolicy = createReconcilePolicy({ unknownAt });
        effect.reconcileDisposition = 'PENDING';
        effect.reconcileAfter = unknownAt;
        effect.reconcileAttempts = 0;
        const linked = this.steps.get(effect.stepId);
        if (linked && linked.state === 'RUNNING') {
          linked.state = 'WAITING_FOR_RECONCILIATION';
          linked.version += 1;
          linked.lease = undefined;
          linked.updatedAt = unknownAt;
        }
        this.event(
          'effect',
          effect.id,
          2,
          'effect.completion_unknown',
          effect.tenantId,
          effect.runId,
          effect.stepId,
          actor,
          { reason },
        );
      }
    }
  }
  async getEffect(effectId: string, tenantId: string): Promise<KernelEffect | null> {
    const effect = this.effects.get(effectId);
    if (!effect || effect.tenantId !== tenantId) return null;
    return clone(effect);
  }
  async reconcileEffect(request: ReconcileEffectRequest): Promise<KernelEffect | null> {
    const effect = this.effects.get(request.effectId);
    if (!effect || effect.tenantId !== request.tenantId || effect.state !== 'COMPLETION_UNKNOWN')
      return null;
    effect.state = request.state;
    effect.response = request.response;
    effect.completedAt = now();
    this.event(
      'effect',
      effect.id,
      3,
      request.state === 'COMPLETED' ? 'effect.reconciled_completed' : 'effect.reconciled_failed',
      effect.tenantId,
      effect.runId,
      effect.stepId,
      request.actor,
      {},
    );
    return clone(effect);
  }
  async requestReconcile(input: RequestReconcileInput): Promise<RequestReconcileResult> {
    const effect = this.effects.get(input.effectId);
    const requestedAt = now();
    if (!effect || effect.tenantId !== input.tenantId) {
      return { scheduled: false, reason: 'NOT_FOUND' };
    }
    if (effect.state !== 'COMPLETION_UNKNOWN') {
      return { scheduled: false, reason: 'NOT_UNKNOWN' };
    }
    if (effect.reconcileDisposition === 'ESCALATED' || effect.reconcileEscalatedAt) {
      return { scheduled: false, reason: 'ESCALATED' };
    }
    if (
      !effect.reconcilePolicy ||
      Date.parse(effect.reconcilePolicy.deadlineAt) <= Date.parse(requestedAt)
    ) {
      return { scheduled: false, reason: 'DEADLINE_EXPIRED' };
    }
    const prior = effect.reconcileAfter ?? requestedAt;
    effect.reconcileAfter = new Date(
      Math.min(Date.parse(prior), Date.parse(requestedAt)),
    ).toISOString();
    this.event(
      'effect',
      effect.id,
      effect.reconcileAttempts + 3,
      'effect.reconcile_requested',
      effect.tenantId,
      effect.runId,
      effect.stepId,
      input.actor,
      { reconcileAfter: effect.reconcileAfter },
    );
    return {
      scheduled: true,
      effectId: effect.id,
      state: 'COMPLETION_UNKNOWN',
      reconcileAfter: effect.reconcileAfter,
      alreadyScheduled: Date.parse(prior) <= Date.parse(requestedAt),
    };
  }
  async claimReconcileEffects(
    input: ClaimReconcileEffectsInput,
  ): Promise<ClaimedReconcileEffect[]> {
    const at = input.now ?? new Date();
    const claimTtlMs = input.claimTtlMs ?? 60_000;
    const claimed: ClaimedReconcileEffect[] = [];
    let tenantFilter: string[] | null = null; // null = open-ended
    if (!this.schedulerMode) {
      const workerId = input.workerId?.trim();
      if (!workerId) return [];
      const scope = this.resolveDurableWorkerTenantScope(
        workerId,
        input.workerGeneration ?? -1,
        input.claimSecret,
      );
      if (!scope) return [];
      tenantFilter = scope.openEnded ? null : scope.tenantIds;
    }
    const candidates = [...this.effects.values()]
      .filter((effect) => {
        if (tenantFilter !== null && !tenantFilter.includes(effect.tenantId)) return false;
        if (
          effect.state !== 'COMPLETION_UNKNOWN' ||
          effect.reconcileDisposition !== 'PENDING' ||
          effect.reconcileEscalatedAt ||
          !effect.reconcilePolicy ||
          Date.parse(effect.reconcilePolicy.deadlineAt) <= at.getTime()
        )
          return false;
        if (!effect.reconcileAfter || Date.parse(effect.reconcileAfter) > at.getTime())
          return false;
        if (
          effect.reconcileClaimExpiresAt &&
          Date.parse(effect.reconcileClaimExpiresAt) > at.getTime()
        ) {
          return false;
        }
        return true;
      })
      .sort((a, b) => Date.parse(a.reconcileAfter ?? '') - Date.parse(b.reconcileAfter ?? ''));
    for (const effect of candidates.slice(0, input.limit)) {
      this.reconcileReceipts.delete(effect.id);
      const claimToken = randomUUID();
      effect.reconcileClaimToken = claimToken;
      effect.reconcileClaimExpiresAt = new Date(at.getTime() + claimTtlMs).toISOString();
      effect.reconcileClaimedAt = at.toISOString();
      effect.reconcileClaimWorkerId = input.workerId ?? 'scheduler';
      effect.reconcileClaimWorkerGeneration = input.workerGeneration ?? 1;
      claimed.push({ effect: clone(effect), claimToken });
    }
    return claimed;
  }
  async completeReconcileEffect(
    input: ReconcileClaimAuth & { response: Record<string, unknown> },
  ): Promise<ReconcileMutationResult> {
    return this.applyReconcileMutation(input, 'COMPLETE', input.response);
  }
  async confirmEffectNotApplied(
    input: ReconcileClaimAuth & { response: Record<string, unknown> },
  ): Promise<ReconcileMutationResult> {
    return this.applyReconcileMutation(input, 'CONFIRM_NOT_APPLIED', input.response);
  }
  async rescheduleReconcileEffect(
    input: ReconcileClaimAuth & { lastError: ReconcileQueryError },
  ): Promise<ReconcileMutationResult> {
    return this.applyReconcileMutation(input, 'RESCHEDULE', input.lastError);
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
    return this.applyReconcileMutation(input, 'ESCALATE', input.reason);
  }
  private async applyReconcileMutation(
    input: ReconcileClaimAuth,
    mutation: 'COMPLETE' | 'CONFIRM_NOT_APPLIED' | 'RESCHEDULE' | 'ESCALATE',
    payload: Record<string, unknown> | ReconcileQueryError | string,
  ): Promise<ReconcileMutationResult> {
    const effect = this.effects.get(input.effectId);
    if (!effect || effect.tenantId !== input.tenantId) {
      return { applied: false, reason: 'NOT_FOUND' };
    }
    const scope = this.resolveDurableWorkerTenantScope(
      input.workerId,
      input.workerGeneration,
      input.claimSecret,
    );
    const worker = this.workers.get(input.workerId);
    if (
      !scope?.tenantIds.includes(input.tenantId) ||
      !worker?.capabilities.includes('effect.reconcile')
    ) {
      return { applied: false, reason: 'WORKER_FENCED' };
    }
    const step = this.steps.get(effect.stepId);
    const run = this.runs.get(effect.runId);
    if (!step || !run) return { applied: false, reason: 'NOT_FOUND' };
    const claimTokenHash = createHash('sha256').update(input.claimToken).digest('hex');
    const requestFingerprint = requestHash({
      mutation,
      tenantId: input.tenantId,
      effectId: input.effectId,
      payload,
      evidenceContentHash: input.evidence?.contentHash ?? null,
    });
    const currentClaimMatches =
      effect.reconcileClaimToken === input.claimToken &&
      effect.reconcileClaimWorkerId === input.workerId &&
      effect.reconcileClaimWorkerGeneration === input.workerGeneration;
    if (!effect.reconcileClaimToken) {
      const prior = this.reconcileReceipts.get(effect.id);
      if (
        prior &&
        prior.workerId === input.workerId &&
        prior.workerGeneration === input.workerGeneration &&
        prior.claimTokenHash === claimTokenHash
      ) {
        return prior.requestFingerprint === requestFingerprint
          ? { ...clone(prior.result), replayed: true }
          : { applied: false, reason: 'CLAIM_REPLAY_CONFLICT' };
      }
      return { applied: false, reason: 'CLAIM_NOT_OWNED' };
    }
    if (!currentClaimMatches) return { applied: false, reason: 'CLAIM_NOT_OWNED' };
    if (
      !effect.reconcileClaimExpiresAt ||
      Date.parse(effect.reconcileClaimExpiresAt) <= Date.now()
    ) {
      return { applied: false, reason: 'CLAIM_EXPIRED' };
    }
    if (effect.state !== 'COMPLETION_UNKNOWN') {
      return { applied: false, reason: 'NOT_COMPLETION_UNKNOWN' };
    }
    if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'SKIPPED'].includes(step.state)) {
      return {
        applied: false,
        reason: 'STEP_TERMINAL_RACE',
        stepState: step.state as 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'SKIPPED',
      };
    }
    if (TERMINAL_RUN_STATES.has(run.state)) {
      return {
        applied: false,
        reason: 'RUN_TERMINAL_RACE',
        runState: run.state as 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'COMPENSATED',
      };
    }
    const observedAt = now();
    const policy = effect.reconcilePolicy;
    const nextAttempt = effect.reconcileAttempts + 1;
    const nextAfter = policy ? nextReconcileAfter(policy, nextAttempt, observedAt) : null;
    const rescheduleEscalates =
      mutation === 'RESCHEDULE' &&
      !!policy &&
      (policy.maxAttempts === 0 ||
        !nextAfter ||
        Date.parse(nextAfter) >= Date.parse(policy.deadlineAt) ||
        nextAttempt >= policy.maxAttempts);
    const projectedState =
      mutation === 'COMPLETE'
        ? ('COMPLETED' as const)
        : mutation === 'CONFIRM_NOT_APPLIED'
          ? ('CONFIRMED_NOT_APPLIED' as const)
          : mutation === 'ESCALATE' || rescheduleEscalates
            ? ('COMPLETION_UNKNOWN' as const)
            : null;
    let evidenceEntry: { key: string; record: KernelEvidenceRecord } | null = null;
    if (projectedState) {
      if (!input.evidence) {
        return { applied: false, reason: 'TERMINAL_EVIDENCE_REQUIRED' };
      }
      assertEvidenceRecordBoundToEffect(input.evidence, { ...effect, state: projectedState });
      const key = `${input.evidence.tenantId}\u0000${input.evidence.bundleId}`;
      const existing = this.evidence.get(key);
      if (existing && canonical(existing) !== canonical(input.evidence)) {
        throw new Error('EVIDENCE_CONFLICT');
      }
      evidenceEntry = { key, record: input.evidence };
    }
    let disposition: Extract<ReconcileMutationResult, { applied: true }>['disposition'];
    let eventType: string;
    if (mutation === 'COMPLETE') {
      effect.state = 'COMPLETED';
      effect.response = clone(payload as Record<string, unknown>);
      effect.completedAt = observedAt;
      effect.reconcileDisposition = 'CONFIRMED_APPLIED';
      effect.reconcileObservedAt = observedAt;
      step.state = 'SUCCEEDED';
      step.version += 1;
      step.output = clone(payload as Record<string, unknown>);
      step.updatedAt = observedAt;
      disposition = 'COMPLETED';
      eventType = 'effect.reconciled_completed';
    } else if (mutation === 'CONFIRM_NOT_APPLIED') {
      effect.state = 'CONFIRMED_NOT_APPLIED';
      effect.response = clone(payload as Record<string, unknown>);
      effect.completedAt = observedAt;
      effect.reconcileDisposition = 'CONFIRMED_NOT_APPLIED';
      effect.reconcileObservedAt = observedAt;
      step.state = 'FAILED';
      step.version += 1;
      step.error = {
        code: 'REMOTE_NOT_APPLIED',
        message: 'Remote outcome confirmed the action was not applied',
        retryable: false,
      };
      step.updatedAt = observedAt;
      disposition = 'CONFIRMED_NOT_APPLIED';
      eventType = 'effect.confirmed_not_applied';
    } else if (mutation === 'RESCHEDULE') {
      if (!policy) return { applied: false, reason: 'NOT_COMPLETION_UNKNOWN' };
      effect.reconcileAttempts = nextAttempt;
      effect.reconcileObservedAt = observedAt;
      effect.reconcileLastError = clone(payload as ReconcileQueryError);
      if (
        policy.maxAttempts === 0 ||
        Date.parse(nextAfter!) >= Date.parse(policy.deadlineAt) ||
        nextAttempt >= policy.maxAttempts
      ) {
        effect.reconcileDisposition = 'ESCALATED';
        effect.reconcileEscalatedAt = observedAt;
        effect.reconcileEscalationCode =
          policy.maxAttempts === 0
            ? 'RECONCILE_POLICY_BACKFILL_REVIEW_REQUIRED'
            : Date.parse(nextAfter!) >= Date.parse(policy.deadlineAt)
              ? 'RECONCILE_DEADLINE_EXPIRED'
              : 'RECONCILE_MAX_ATTEMPTS_EXHAUSTED';
        step.state = 'WAITING_FOR_HUMAN';
        step.version += 1;
        step.updatedAt = observedAt;
        disposition = 'ESCALATED';
        eventType = 'effect.reconcile_escalated';
      } else {
        effect.reconcileAfter = nextAfter!;
        disposition = 'RESCHEDULED';
        eventType = 'effect.reconcile_rescheduled';
      }
    } else {
      effect.reconcileDisposition = 'ESCALATED';
      effect.reconcileEscalatedAt = observedAt;
      effect.reconcileEscalationCode = payload as
        | 'RECONCILE_ADAPTER_NOT_FOUND'
        | 'RECONCILE_QUERY_UNSUPPORTED'
        | 'COMPENSATION_QUERY_UNSUPPORTED'
        | 'RECONCILE_POLICY_BACKFILL_REVIEW_REQUIRED';
      step.state = 'WAITING_FOR_HUMAN';
      step.version += 1;
      step.updatedAt = observedAt;
      disposition = 'ESCALATED';
      eventType = 'effect.reconcile_escalated';
    }
    effect.reconcileClaimToken = null;
    effect.reconcileClaimExpiresAt = null;
    effect.reconcileClaimedAt = null;
    effect.reconcileClaimWorkerId = null;
    effect.reconcileClaimWorkerGeneration = null;
    const eventId = this.event(
      'effect',
      effect.id,
      effect.reconcileAttempts + 3,
      eventType,
      effect.tenantId,
      effect.runId,
      effect.stepId,
      input.workerId,
      { disposition, requestFingerprint },
    );
    if (evidenceEntry && !this.evidence.has(evidenceEntry.key)) {
      this.evidence.set(evidenceEntry.key, clone(evidenceEntry.record));
    }
    const receipt: ReconcileMutationReceipt = {
      effectId: effect.id,
      requestFingerprint,
      effectState: effect.state,
      reconcileAttempts: effect.reconcileAttempts,
      reconcileAfter: effect.reconcileAfter,
      reconcileEscalatedAt: effect.reconcileEscalatedAt,
      eventId,
    };
    const result: Extract<ReconcileMutationResult, { applied: true }> = {
      applied: true,
      replayed: false,
      disposition,
      receipt,
    };
    this.reconcileReceipts.set(effect.id, {
      workerId: input.workerId,
      workerGeneration: input.workerGeneration,
      claimTokenHash,
      requestFingerprint,
      result: clone(result),
    });
    if (effect.type.startsWith('compensate.')) {
      this.closeReconciledCompensation(effect, mutation, payload, input.workerId, observedAt);
    } else if (mutation === 'COMPLETE' || mutation === 'CONFIRM_NOT_APPLIED') {
      this.finish(effect.runId, input.workerId);
    }
    return result;
  }

  private closeReconciledCompensation(
    effect: KernelEffect,
    mutation: 'COMPLETE' | 'CONFIRM_NOT_APPLIED' | 'RESCHEDULE' | 'ESCALATE',
    payload: Record<string, unknown> | ReconcileQueryError | string,
    actor: string,
    observedAt: string,
  ): void {
    const request = [...this.compensationRequests.values()].find(
      (candidate) =>
        candidate.tenantId === effect.tenantId && candidate.compensationEffectId === effect.id,
    );
    if (!request) {
      throw new KernelInvariantError(
        'COMPENSATION_RECONCILIATION_REQUEST_MISSING',
        `No compensation reconciliation request exists for effect ${effect.id}`,
      );
    }
    if (mutation === 'RESCHEDULE') return;
    if (request.state !== 'COMPLETION_UNKNOWN') {
      throw new KernelInvariantError(
        'COMPENSATION_RECONCILIATION_REQUEST_TERMINAL_RACE',
        `Compensation reconciliation request ${request.id} is already terminal`,
      );
    }
    if (mutation === 'ESCALATE') {
      request.state = 'ESCALATED';
      return;
    }
    const step = this.steps.get(request.compensationStepId);
    const compensationRun = this.runs.get(request.compensationRunId);
    const originalRun = this.runs.get(request.originalRunId);
    if (!step || !compensationRun || !originalRun) {
      throw new KernelInvariantError(
        'COMPENSATION_RECONCILIATION_RUN_MISSING',
        `Compensation reconciliation state is missing its run or step for request ${request.id}`,
      );
    }
    const eventPayload = {
      requestId: request.id,
      originalRunId: request.originalRunId,
      originalEffectId: request.originalEffectId,
      compensationRunId: request.compensationRunId,
      compensationEffectId: effect.id,
      disposition: mutation === 'COMPLETE' ? 'COMPLETED' : 'CONFIRMED_NOT_APPLIED',
    };
    const nextSequence = (aggregateType: KernelEvent['aggregateType'], aggregateId: string) =>
      this.events
        .filter(
          (event) => event.aggregateType === aggregateType && event.aggregateId === aggregateId,
        )
        .reduce((highest, event) => Math.max(highest, event.sequence), 0) + 1;
    let originalTerminalEvent = false;
    if (mutation === 'COMPLETE') {
      if (
        compensationRun.state !== 'COMPENSATING' ||
        !['COMPENSATING', 'COMPENSATED'].includes(originalRun.state)
      ) {
        throw new KernelInvariantError(
          'COMPENSATION_RECONCILIATION_TERMINAL_TRANSITION_REJECTED',
          `Cannot complete compensation reconciliation request ${request.id} from its current run state`,
        );
      }
      request.state = 'COMPLETED';
      compensationRun.state = 'SUCCEEDED';
      compensationRun.version += 1;
      compensationRun.updatedAt = observedAt;
      compensationRun.terminalAt = observedAt;
      if (originalRun.state === 'COMPENSATING') {
        originalRun.state = 'COMPENSATED';
        originalRun.version += 1;
        originalRun.updatedAt = observedAt;
        originalRun.terminalAt = observedAt;
      } else {
        originalTerminalEvent = this.events.some(
          (event) =>
            event.aggregateType === 'run' &&
            event.aggregateId === originalRun.id &&
            event.type === 'run.compensated',
        );
        if (!originalTerminalEvent) {
          originalRun.version += 1;
          originalRun.updatedAt = observedAt;
        }
      }
      this.event(
        'step',
        step.id,
        step.version,
        'step.succeeded',
        step.tenantId,
        step.runId,
        step.id,
        actor,
        eventPayload,
      );
      this.event(
        'run',
        compensationRun.id,
        compensationRun.version,
        'run.succeeded',
        compensationRun.tenantId,
        compensationRun.id,
        step.id,
        actor,
        eventPayload,
      );
      if (!originalTerminalEvent) {
        this.event(
          'run',
          originalRun.id,
          originalRun.version,
          'run.compensated',
          originalRun.tenantId,
          originalRun.id,
          undefined,
          actor,
          eventPayload,
        );
      }
      this.event(
        'effect',
        effect.id,
        nextSequence('effect', effect.id),
        'compensation.completed',
        effect.tenantId,
        effect.runId,
        effect.stepId,
        actor,
        eventPayload,
      );
      return;
    }
    if (compensationRun.state !== 'COMPENSATING' || originalRun.state !== 'COMPENSATING') {
      throw new KernelInvariantError(
        'COMPENSATION_RECONCILIATION_TERMINAL_TRANSITION_REJECTED',
        `Cannot confirm non-application for compensation reconciliation request ${request.id} from its current run state`,
      );
    }
    request.state = 'CONFIRMED_NOT_APPLIED';
    compensationRun.state = 'FAILED';
    compensationRun.version += 1;
    compensationRun.updatedAt = observedAt;
    compensationRun.terminalAt = observedAt;
    originalRun.state = 'FAILED';
    originalRun.version += 1;
    originalRun.updatedAt = observedAt;
    originalRun.terminalAt = observedAt;
    this.event(
      'step',
      step.id,
      step.version,
      'step.failed',
      step.tenantId,
      step.runId,
      step.id,
      actor,
      eventPayload,
    );
    this.event(
      'run',
      compensationRun.id,
      compensationRun.version,
      'run.failed',
      compensationRun.tenantId,
      compensationRun.id,
      step.id,
      actor,
      eventPayload,
    );
    this.event(
      'run',
      originalRun.id,
      originalRun.version,
      'run.failed',
      originalRun.tenantId,
      originalRun.id,
      undefined,
      actor,
      eventPayload,
    );
  }
  async rescheduleReconcile(input: RescheduleReconcileInput): Promise<boolean> {
    const effect = this.effects.get(input.effectId);
    if (
      !effect ||
      effect.tenantId !== input.tenantId ||
      effect.state !== 'COMPLETION_UNKNOWN' ||
      effect.reconcileDisposition !== 'PENDING' ||
      !effect.reconcilePolicy ||
      effect.reconcileClaimToken !== input.claimToken
    ) {
      return false;
    }
    const observedAt = now();
    effect.reconcileAttempts += 1;
    effect.reconcileObservedAt = observedAt;
    effect.reconcileAfter = nextReconcileAfter(
      effect.reconcilePolicy,
      effect.reconcileAttempts,
      observedAt,
    );
    effect.reconcileClaimToken = null;
    effect.reconcileClaimExpiresAt = null;
    effect.reconcileClaimedAt = null;
    effect.reconcileClaimWorkerId = null;
    effect.reconcileClaimWorkerGeneration = null;
    if (input.lastError) {
      effect.reconcileLastError = input.lastError;
    }
    return true;
  }
  async escalateReconcile(input: EscalateReconcileInput): Promise<boolean> {
    const effect = this.effects.get(input.effectId);
    if (
      !effect ||
      effect.tenantId !== input.tenantId ||
      effect.state !== 'COMPLETION_UNKNOWN' ||
      effect.reconcileClaimToken !== input.claimToken
    ) {
      return false;
    }
    effect.reconcileEscalatedAt = now();
    effect.reconcileDisposition = 'ESCALATED';
    effect.reconcileEscalationCode = input.code ?? 'RECONCILE_QUERY_PERMANENT_FAILURE';
    effect.reconcileClaimToken = null;
    effect.reconcileClaimExpiresAt = null;
    effect.reconcileLastError = {
      category: 'PERMANENT',
      code: 'RECONCILE_QUERY_UNCLASSIFIED',
      message: input.reason,
    };
    this.event(
      'effect',
      effect.id,
      effect.reconcileAttempts + 100,
      'effect.reconcile_escalated',
      effect.tenantId,
      effect.runId,
      effect.stepId,
      'reconciliation-daemon',
      { reason: input.reason },
    );
    return true;
  }
  async releaseReconcileClaim(
    effectId: string,
    tenantId: string,
    claimToken: string,
  ): Promise<boolean> {
    const effect = this.effects.get(effectId);
    if (!effect || effect.tenantId !== tenantId || effect.reconcileClaimToken !== claimToken) {
      return false;
    }
    effect.reconcileClaimToken = null;
    effect.reconcileClaimExpiresAt = null;
    return true;
  }
  async failEffect(request: FailEffectRequest): Promise<KernelEffect | null> {
    const effect = this.effects.get(request.effectId);
    const step = effect ? this.steps.get(effect.stepId) : undefined;
    if (
      !effect ||
      !step ||
      effect.tenantId !== request.tenantId ||
      effect.state !== 'ADMITTED' ||
      step.state !== 'RUNNING' ||
      !live(step.lease, request.lease)
    ) {
      return null;
    }
    effect.state = 'FAILED';
    effect.response = request.error;
    effect.completedAt = now();
    this.event(
      'effect',
      effect.id,
      2,
      'effect.failed',
      request.tenantId,
      effect.runId,
      effect.stepId,
      request.actor,
      { error: request.error },
    );
    return clone(effect);
  }
  async createCompensationAuthorization(
    authorization: CompensationAuthorizationRecord,
  ): Promise<{ authorization: CompensationAuthorizationRecord; replayed: boolean }> {
    const existing = this.compensationAuthorizations.get(authorization.id);
    if (existing) {
      if (canonical(existing) !== canonical(authorization)) {
        throw new KernelInvariantError(
          'IDEMPOTENCY_CONFLICT',
          'Compensation authorization inputs differ',
        );
      }
      return { authorization: clone(existing), replayed: true };
    }
    const effect = this.effects.get(authorization.originalEffectId);
    if (
      !effect ||
      effect.tenantId !== authorization.tenantId ||
      effect.runId !== authorization.originalRunId ||
      effect.state !== 'COMPLETED' ||
      effect.type.startsWith('compensate.')
    ) {
      throw new KernelInvariantError(
        'IDEMPOTENCY_CONFLICT',
        'Completed forward effect was not found',
      );
    }
    this.compensationAuthorizations.set(authorization.id, clone(authorization));
    return { authorization: clone(authorization), replayed: false };
  }

  async getCompensationAuthorization(
    authorizationId: string,
    tenantId: string,
  ): Promise<CompensationAuthorizationRecord | null> {
    const authorization = this.compensationAuthorizations.get(authorizationId);
    return authorization?.tenantId === tenantId ? clone(authorization) : null;
  }

  private compensationRequestId(authorization: CompensationAuthorizationRecord): string {
    return `request_${canonicalCompensationHash({
      tenantId: authorization.tenantId,
      originalEffectId: authorization.originalEffectId,
      adapterVersion: authorization.adapterVersion,
      actionDigest: authorization.actionDigest,
    }).slice(0, 40)}`;
  }

  async requestCompensation(input: RequestCompensationInput): Promise<RequestCompensationResult> {
    const authorizationId =
      typeof input.authorizationId === 'string' ? input.authorizationId.trim() : '';
    const missingRequestId = `request_${canonicalCompensationHash({
      tenantId: input.tenantId,
      authorizationId,
    }).slice(0, 40)}`;
    if (!authorizationId) {
      return { accepted: false, requestId: missingRequestId, reason: 'AUTHORIZATION_NOT_FOUND' };
    }
    const authorization = this.compensationAuthorizations.get(authorizationId);
    if (!authorization || authorization.tenantId !== input.tenantId) {
      return { accepted: false, requestId: missingRequestId, reason: 'AUTHORIZATION_NOT_FOUND' };
    }
    const requestId = this.compensationRequestId(authorization);
    const existing = this.compensationRequests.get(requestId);
    if (existing) {
      if (existing.authorizationId !== authorization.id) {
        return { accepted: false, requestId, reason: 'ACTION_DIGEST_MISMATCH' };
      }
      return { accepted: true, request: clone(existing), replayed: true };
    }
    const originalEffect = this.effects.get(authorization.originalEffectId);
    const originalRun = this.runs.get(authorization.originalRunId);
    if (
      !originalEffect ||
      !originalRun ||
      originalEffect.tenantId !== input.tenantId ||
      originalEffect.runId !== authorization.originalRunId ||
      originalEffect.state !== 'COMPLETED' ||
      originalEffect.type.startsWith('compensate.')
    ) {
      return { accepted: false, requestId, reason: 'FORWARD_EFFECT_NOT_FOUND' };
    }
    const forwardResponse = originalEffect.response ?? {};
    if (canonicalCompensationHash(forwardResponse) !== authorization.forwardReceiptHash) {
      return { accepted: false, requestId, reason: 'FORWARD_RECEIPT_MISMATCH' };
    }
    const expectedDigest = canonicalCompensationHash({
      type: authorization.compensationEffectType,
      originalEffectId: authorization.originalEffectId,
      adapterVersion: authorization.adapterVersion,
      destination:
        typeof originalEffect.request.destination === 'string'
          ? originalEffect.request.destination
          : '',
      forwardResponse,
      compensationPatch: authorization.compensationPatch,
    });
    if (expectedDigest !== authorization.actionDigest) {
      return { accepted: false, requestId, reason: 'ACTION_DIGEST_MISMATCH' };
    }
    if (authorization.decision === 'deny') {
      return { accepted: false, requestId, reason: 'POLICY_DENIED' };
    }
    if (
      !Number.isFinite(Date.parse(authorization.expiresAt)) ||
      Date.parse(authorization.expiresAt) <= Date.now()
    ) {
      return { accepted: false, requestId, reason: 'AUTHORIZATION_EXPIRED' };
    }
    if (authorization.decision === 'require_approval') {
      if (!authorization.approvalInteractionId) {
        return { accepted: false, requestId, reason: 'APPROVAL_REQUIRED' };
      }
      const approval = this.interactions.get(authorization.approvalInteractionId);
      const response = approval?.response ?? {};
      if (
        !approval ||
        approval.tenantId !== input.tenantId ||
        approval.runId !== authorization.originalRunId ||
        approval.status !== 'answered' ||
        response.approved !== true ||
        response.authorizationId !== authorization.id ||
        response.actionDigest !== authorization.actionDigest ||
        response.policyDecisionId !== authorization.policyDecisionId ||
        response.policySnapshotId !== authorization.policySnapshotId ||
        Date.parse(approval.expiresAt ?? '') <= Date.now()
      ) {
        return { accepted: false, requestId, reason: 'APPROVAL_BINDING_MISMATCH' };
      }
    }
    const compensationRunId = `run_${canonicalCompensationHash({ requestId, purpose: 'compensation' }).slice(0, 40)}`;
    const compensationStepId = `step_${canonicalCompensationHash({ requestId, purpose: 'compensation' }).slice(0, 32)}`;
    const compensationEffectId = `effect_${canonicalCompensationHash({
      requestId,
      originalEffectId: authorization.originalEffectId,
    }).slice(0, 40)}`;
    const request: KernelCompensationRequest = {
      id: requestId,
      tenantId: input.tenantId,
      originalRunId: authorization.originalRunId,
      originalEffectId: authorization.originalEffectId,
      compensationRunId,
      compensationStepId,
      adapterVersion: authorization.adapterVersion,
      compensationEffectType: authorization.compensationEffectType,
      destination:
        typeof originalEffect.request.destination === 'string'
          ? originalEffect.request.destination
          : '',
      compensationPatch: clone(authorization.compensationPatch),
      forwardReceiptHash: authorization.forwardReceiptHash,
      authorizationId: authorization.id,
      reconcilePolicy: createReconcilePolicy({ unknownAt: now() }),
      state: 'AUTHORIZED',
      compensationEffectId,
    };
    const metadataAuthorization = durableCompensationMetadataAuthorization({
      authorization,
      requestId,
      compensationRunId,
      compensationStepId,
      compensationEffectId,
      originalRunStateAtRequest: originalRun.state,
      originalEffect,
    });
    await this.createRun(
      {
        id: compensationRunId,
        tenantId: input.tenantId,
        intentHash: canonicalCompensationHash({ requestId, purpose: 'intent' }),
        workGraphHash: canonicalCompensationHash({ compensationStepId }),
        workGraphVersion: 'action-gateway-compensation/v2',
        policySnapshotId: authorization.policySnapshotId,
        metadata: {
          compensationRequestId: requestId,
          authorizationId: authorization.id,
          compensation: { authorization: metadataAuthorization, disposition: 'PENDING' },
        },
        steps: [
          {
            id: compensationStepId,
            kind: 'tool',
            input: { requestId, authorization: metadataAuthorization },
          },
        ],
      },
      input.actor,
    );
    this.compensationRequests.set(requestId, clone(request));
    const eventId = randomUUID();
    const occurredAt = now();
    this.events.push({
      eventId,
      aggregateType: 'effect',
      aggregateId: requestId,
      sequence: 1,
      type: 'kernel.compensation.requested',
      tenantId: input.tenantId,
      runId: compensationRunId,
      stepId: compensationStepId,
      actor: input.actor,
      schemaVersion: 'v2',
      payload: {
        requestId,
        authorizationId: authorization.id,
        actionDigest: authorization.actionDigest,
      },
      occurredAt,
    });
    const outboxId = randomUUID();
    this.outbox.set(outboxId, {
      id: outboxId,
      eventId,
      tenantId: input.tenantId,
      topic: KERNEL_COMPENSATION_TOPIC,
      key: requestId,
      payload: {
        requestId,
        authorizationId: authorization.id,
        tenantId: input.tenantId,
        actionDigest: authorization.actionDigest,
      },
      attempts: 0,
      availableAt: occurredAt,
      createdAt: occurredAt,
    });
    return { accepted: true, request: clone(request), replayed: false };
  }

  private compensationAuthorization(run: KernelRun): GovernedCompensationAuthorization | null {
    const compensation = run.metadata.compensation;
    if (typeof compensation !== 'object' || compensation === null) return null;
    const authorization = (compensation as Record<string, unknown>).authorization;
    return typeof authorization === 'object' && authorization !== null
      ? (authorization as GovernedCompensationAuthorization)
      : null;
  }

  async claimOutbox(
    limit: number,
    at = new Date(),
    tenantId?: string,
  ): Promise<KernelOutboxMessage[]> {
    return [...this.outbox.values()]
      .filter((message) => {
        if (message.publishedAt) return false;
        if (
          message.topic === KERNEL_COMPENSATION_TOPIC ||
          message.topic === LEGACY_COMPENSATION_TOPIC
        )
          return false;
        if (tenantId && message.payload.tenantId !== tenantId) return false;
        if ([...this.dlq.values()].some((e) => e.originalId === message.id)) return false;
        if (message.attempts >= this.outboxMaxAttempts) return false;
        const claim = this.outboxClaims.get(message.id);
        return (
          Date.parse(message.availableAt) <= at.getTime() &&
          (!claim || claim.expiresAt <= at.getTime())
        );
      })
      .slice(0, limit)
      .map((message) => {
        const token = randomUUID();
        message.attempts++;
        message.claimToken = token;
        this.outboxClaims.set(message.id, { token, expiresAt: at.getTime() + 60_000 });
        return clone(message);
      });
  }
  async markOutboxPublished(
    messageId: string,
    claimToken: string,
    tenantId?: string,
  ): Promise<boolean> {
    const message = this.outbox.get(messageId);
    const claim = this.outboxClaims.get(messageId);
    if (!message || message.publishedAt || claim?.token !== claimToken) return false;
    if (tenantId && message.tenantId !== tenantId) return false;
    message.publishedAt = now();
    message.claimToken = undefined;
    this.outboxClaims.delete(messageId);
    return true;
  }
  async retryOutbox(
    messageId: string,
    claimToken: string,
    _error: { code: string; message: string },
    at = new Date(),
    tenantId?: string,
  ): Promise<boolean> {
    const message = this.outbox.get(messageId);
    const claim = this.outboxClaims.get(messageId);
    if (!message || message.publishedAt || claim?.token !== claimToken) return false;
    if (tenantId && message.tenantId !== tenantId) return false;
    message.availableAt = new Date(
      at.getTime() + Math.pow(2, Math.max(0, message.attempts - 1)) * 1000,
    ).toISOString();
    message.claimToken = undefined;
    this.outboxClaims.delete(messageId);
    return true;
  }

  async claimCompensationRequest(
    input: ClaimCompensationRequestInput,
  ): Promise<ClaimedCompensationRequest | null> {
    const scope = this.resolveDurableWorkerTenantScope(
      input.workerId,
      input.workerGeneration,
      input.claimSecret,
    );
    const worker = this.workers.get(input.workerId);
    const request = this.compensationRequests.get(input.requestId);
    const message = this.outbox.get(input.outboxMessageId);
    if (
      !scope ||
      !worker ||
      worker.identitySubject !== 'db:commander_adapter_ops' ||
      canonical(worker.capabilities) !== canonical(['effect.compensate']) ||
      !request ||
      !scope.tenantIds.includes(request.tenantId) ||
      !message ||
      message.tenantId !== request.tenantId ||
      message.topic !== KERNEL_COMPENSATION_TOPIC ||
      message.publishedAt ||
      message.payload.requestId !== request.id ||
      message.payload.authorizationId !== request.authorizationId
    ) {
      return null;
    }
    const authorization = this.compensationAuthorizations.get(request.authorizationId);
    const originalEffect = this.effects.get(request.originalEffectId);
    const originalRun = this.runs.get(request.originalRunId);
    if (
      !authorization ||
      authorization.tenantId !== request.tenantId ||
      message.payload.actionDigest !== authorization.actionDigest ||
      !originalEffect?.response ||
      !originalRun ||
      ![
        'PENDING',
        'RUNNING',
        'PAUSED',
        'SUCCEEDED',
        'FAILED',
        'CANCELLED',
        'COMPENSATING',
      ].includes(originalRun.state) ||
      canonicalCompensationHash(originalEffect.response) !== authorization.forwardReceiptHash
    ) {
      return null;
    }
    const at = input.now ?? new Date();
    if (
      request.state === 'CLAIMED' &&
      request.claimExpiresAt &&
      Date.parse(request.claimExpiresAt) > at.getTime() &&
      request.claimWorkerId !== input.workerId
    ) {
      return null;
    }
    if (request.state !== 'AUTHORIZED' && request.state !== 'CLAIMED') return null;
    const run = this.runs.get(request.compensationRunId);
    const step = this.steps.get(request.compensationStepId);
    if (
      !run ||
      !step ||
      !['PENDING', 'COMPENSATING'].includes(run.state) ||
      !['PENDING', 'RUNNING'].includes(step.state)
    ) {
      return null;
    }
    const outboxClaimToken = randomUUID();
    const leaseTtlMs = input.leaseTtlMs ?? 60_000;
    const fencingEpoch = (this.lastFencingEpoch.get(step.id) ?? 0) + 1;
    this.lastFencingEpoch.set(step.id, fencingEpoch);
    const expiresAt = new Date(at.getTime() + leaseTtlMs).toISOString();
    request.state = 'CLAIMED';
    request.claimWorkerId = input.workerId;
    request.claimWorkerGeneration = input.workerGeneration;
    request.claimToken = outboxClaimToken;
    request.claimExpiresAt = expiresAt;
    request.compensationEffectId ??= `effect_${canonicalCompensationHash({
      requestId: request.id,
      originalEffectId: request.originalEffectId,
    }).slice(0, 40)}`;
    run.state = 'COMPENSATING';
    run.version += 1;
    run.updatedAt = at.toISOString();
    this.event(
      'run',
      run.id,
      run.version,
      'run.compensating',
      run.tenantId,
      run.id,
      step.id,
      input.workerId,
      { requestId: request.id, originalRunId: originalRun.id },
    );
    const originalRunTransitioned = originalRun.state !== 'COMPENSATING';
    if (originalRunTransitioned) originalRun.version += 1;
    originalRun.state = 'COMPENSATING';
    originalRun.terminalAt = undefined;
    originalRun.updatedAt = at.toISOString();
    if (originalRunTransitioned) {
      this.event(
        'run',
        originalRun.id,
        originalRun.version,
        'run.compensating',
        originalRun.tenantId,
        originalRun.id,
        undefined,
        input.workerId,
        { requestId: request.id, compensationRunId: run.id },
      );
    }
    step.state = 'RUNNING';
    step.version += 1;
    step.updatedAt = at.toISOString();
    step.lease = {
      workerId: input.workerId,
      workerGeneration: input.workerGeneration,
      token: outboxClaimToken,
      fencingEpoch,
      expiresAt,
    };
    message.claimToken = outboxClaimToken;
    this.outboxClaims.set(message.id, {
      token: outboxClaimToken,
      expiresAt: at.getTime() + leaseTtlMs,
    });
    return {
      request: clone(request),
      authorization: clone(authorization),
      forwardResponse: clone(originalEffect.response),
      lease: clone(step.lease),
      outboxMessageId: message.id,
      outboxClaimToken,
    };
  }

  async admitCompensationEffect(
    input: AdmitEffectRequest & {
      requestId: string;
      requestClaimToken: string;
      outboxMessageId: string;
      outboxClaimToken: string;
    },
  ): Promise<AdmitEffectResult> {
    const request = this.compensationRequests.get(input.requestId);
    const authorization = request
      ? this.compensationAuthorizations.get(request.authorizationId)
      : undefined;
    const originalEffect = request ? this.effects.get(request.originalEffectId) : undefined;
    if (
      !request ||
      !authorization ||
      !originalEffect?.response ||
      request.state !== 'CLAIMED' ||
      request.compensationEffectId !== input.id ||
      request.compensationRunId !== input.runId ||
      request.compensationStepId !== input.stepId ||
      request.tenantId !== input.tenantId ||
      request.claimToken !== input.requestClaimToken ||
      request.claimToken !== input.outboxClaimToken ||
      input.outboxMessageId !==
        [...this.outbox.values()].find((m) => m.id === input.outboxMessageId)?.id ||
      input.type !== authorization.compensationEffectType ||
      input.policyDecisionId !== authorization.policyDecisionId ||
      input.policySnapshotId !== authorization.policySnapshotId ||
      input.actionDigest !== authorization.actionDigest ||
      canonical(input.request) !==
        canonical({
          originalEffectId: request.originalEffectId,
          destination: originalEffect.request.destination,
          forwardResponse: originalEffect.response,
          compensationPatch: authorization.compensationPatch,
        })
    ) {
      return { admitted: false, reason: 'COMPENSATION_ADMISSION_UNAVAILABLE' };
    }
    return this.admitEffectValidated(input, true);
  }

  private compensationMutation(
    input: FinalizeCompensationInput | ParkCompensationRequestUnknownInput,
    disposition: import('../types.js').CompensationDisposition,
    payload: unknown,
  ):
    | {
        request: KernelCompensationRequest;
        message: KernelOutboxMessage;
        replay?: CompensationMutationResult;
      }
    | { rejection: CompensationMutationResult } {
    const fingerprint = canonical({ input, disposition, payload });
    const receipt = this.compensationMutationReceipts.get(input.outboxMessageId);
    if (receipt) {
      return receipt.fingerprint === fingerprint
        ? { rejection: { ...receipt.result, replayed: true } }
        : { rejection: { applied: false, reason: 'CLAIM_REPLAY_CONFLICT' } };
    }
    const request = this.compensationRequests.get(input.requestId);
    const message = this.outbox.get(input.outboxMessageId);
    const scope = this.resolveDurableWorkerTenantScope(
      input.workerId,
      input.workerGeneration,
      input.claimSecret,
    );
    if (
      !scope ||
      !scope.tenantIds.includes(input.tenantId) ||
      !request ||
      request.tenantId !== input.tenantId ||
      request.compensationEffectId !== input.effectId ||
      request.claimWorkerId !== input.workerId ||
      request.claimWorkerGeneration !== input.workerGeneration ||
      request.claimToken !== input.outboxClaimToken ||
      !message ||
      message.publishedAt ||
      message.claimToken !== input.outboxClaimToken
    ) {
      return { rejection: { applied: false, reason: 'CLAIM_NOT_OWNED' } };
    }
    return { request, message };
  }

  private acknowledgeCompensationMutation(
    input: FinalizeCompensationInput | ParkCompensationRequestUnknownInput,
    disposition: import('../types.js').CompensationDisposition,
    payload: unknown,
    message: KernelOutboxMessage,
  ): CompensationMutationResult {
    message.publishedAt = now();
    message.claimToken = undefined;
    this.outboxClaims.delete(message.id);
    const result = { applied: true as const, disposition, replayed: false };
    this.compensationMutationReceipts.set(message.id, {
      fingerprint: canonical({ input, disposition, payload }),
      result,
    });
    return result;
  }

  async parkCompensationUnknown(
    input: ParkCompensationRequestUnknownInput,
  ): Promise<CompensationMutationResult> {
    const checked = this.compensationMutation(input, 'COMPLETION_UNKNOWN', input.error);
    if ('rejection' in checked) return checked.rejection;
    const { request, message } = checked;
    const effect = this.effects.get(input.effectId);
    const step = this.steps.get(request.compensationStepId);
    const run = this.runs.get(request.compensationRunId);
    if (!effect || !step || !run || !['ADMITTED', 'COMPLETION_UNKNOWN'].includes(effect.state)) {
      return { applied: false, reason: 'EFFECT_NOT_ADMITTED_OR_UNKNOWN' };
    }
    effect.state = 'COMPLETION_UNKNOWN';
    effect.response = clone(input.error);
    effect.reconcilePolicy = clone(request.reconcilePolicy);
    effect.reconcileDisposition = 'PENDING';
    effect.reconcileAfter = now();
    request.state = 'COMPLETION_UNKNOWN';
    step.state = 'WAITING_FOR_RECONCILIATION';
    step.lease = undefined;
    run.state = 'COMPENSATING';
    return this.acknowledgeCompensationMutation(input, 'COMPLETION_UNKNOWN', input.error, message);
  }

  async finalizeCompensation(
    input: FinalizeCompensationInput,
  ): Promise<CompensationMutationResult> {
    const checked = this.compensationMutation(input, input.disposition, input.response ?? {});
    if ('rejection' in checked) return checked.rejection;
    const { request, message } = checked;
    const effect = this.effects.get(input.effectId);
    const step = this.steps.get(request.compensationStepId);
    const run = this.runs.get(request.compensationRunId);
    const originalRun = this.runs.get(request.originalRunId);
    if (!step || !run || !originalRun) return { applied: false, reason: 'NOT_FOUND' };
    if (!effect) {
      if (input.disposition !== 'ESCALATED' || input.evidence) {
        return { applied: false, reason: 'PRE_ADMISSION_ESCALATION_ONLY' };
      }
      request.state = 'ESCALATED';
      step.state = 'WAITING_FOR_HUMAN';
      step.lease = undefined;
      run.state = 'COMPENSATING';
      return this.acknowledgeCompensationMutation(
        input,
        'ESCALATED',
        input.response ?? {},
        message,
      );
    }
    const projectedEffect = {
      ...effect,
      state:
        input.disposition === 'COMPLETED'
          ? effect.state
          : input.disposition === 'CONFIRMED_NOT_APPLIED'
            ? ('CONFIRMED_NOT_APPLIED' as const)
            : ('COMPLETION_UNKNOWN' as const),
    };
    if (!input.evidence) {
      return { applied: false, reason: 'TERMINAL_EVIDENCE_REQUIRED' };
    }
    if (input.disposition === 'COMPLETED' && effect.state !== 'COMPLETED') {
      return { applied: false, reason: 'EFFECT_NOT_COMPLETED' };
    }
    if (
      input.disposition === 'CONFIRMED_NOT_APPLIED' &&
      effect.state !== 'COMPLETION_UNKNOWN' &&
      effect.state !== 'CONFIRMED_NOT_APPLIED'
    ) {
      return { applied: false, reason: 'EFFECT_NOT_UNKNOWN' };
    }
    if (input.disposition === 'ESCALATED' && effect.state !== 'COMPLETION_UNKNOWN') {
      return { applied: false, reason: 'EFFECT_NOT_UNKNOWN' };
    }
    assertEvidenceRecordBoundToEffect(input.evidence, projectedEffect);
    await this.appendEvidence(input.evidence);
    const terminalAt = now();
    const eventPayload = {
      requestId: request.id,
      originalRunId: originalRun.id,
      originalEffectId: request.originalEffectId,
      compensationRunId: run.id,
      compensationEffectId: effect.id,
      disposition: input.disposition,
    };
    if (input.disposition === 'COMPLETED') {
      request.state = 'COMPLETED';
      step.state = 'SUCCEEDED';
      step.output = clone(input.response ?? {});
      step.version += 1;
      step.updatedAt = terminalAt;
      run.state = 'SUCCEEDED';
      run.version += 1;
      run.updatedAt = terminalAt;
      run.terminalAt = terminalAt;
      if (originalRun.state === 'COMPENSATING') {
        originalRun.state = 'COMPENSATED';
        originalRun.version += 1;
        originalRun.updatedAt = terminalAt;
        originalRun.terminalAt = terminalAt;
      }
      this.event(
        'step',
        step.id,
        step.version,
        'step.succeeded',
        step.tenantId,
        step.runId,
        step.id,
        input.actor,
        eventPayload,
      );
      this.event(
        'run',
        run.id,
        run.version,
        'run.succeeded',
        run.tenantId,
        run.id,
        step.id,
        input.actor,
        eventPayload,
      );
      this.event(
        'run',
        originalRun.id,
        originalRun.version,
        'run.compensated',
        originalRun.tenantId,
        originalRun.id,
        undefined,
        input.actor,
        eventPayload,
      );
      const sequence =
        this.events
          .filter((event) => event.aggregateType === 'effect' && event.aggregateId === effect.id)
          .reduce((highest, event) => Math.max(highest, event.sequence), 0) + 1;
      this.event(
        'effect',
        effect.id,
        sequence,
        'compensation.completed',
        effect.tenantId,
        effect.runId,
        effect.stepId,
        input.actor,
        {
          originalRunId: originalRun.id,
          originalEffectId: request.originalEffectId,
          compensationRunId: run.id,
          compensationEffectId: effect.id,
        },
      );
    } else if (input.disposition === 'CONFIRMED_NOT_APPLIED') {
      effect.state = 'CONFIRMED_NOT_APPLIED';
      effect.response = clone(input.response ?? {});
      request.state = 'CONFIRMED_NOT_APPLIED';
      step.state = 'FAILED';
      step.version += 1;
      step.updatedAt = terminalAt;
      run.state = 'FAILED';
      run.version += 1;
      run.updatedAt = terminalAt;
      run.terminalAt = terminalAt;
      if (originalRun.state === 'COMPENSATING') {
        originalRun.state = 'FAILED';
        originalRun.version += 1;
        originalRun.updatedAt = terminalAt;
        originalRun.terminalAt = terminalAt;
      }
      this.event(
        'step',
        step.id,
        step.version,
        'step.failed',
        step.tenantId,
        step.runId,
        step.id,
        input.actor,
        eventPayload,
      );
      this.event(
        'run',
        run.id,
        run.version,
        'run.failed',
        run.tenantId,
        run.id,
        step.id,
        input.actor,
        eventPayload,
      );
      this.event(
        'run',
        originalRun.id,
        originalRun.version,
        'run.failed',
        originalRun.tenantId,
        originalRun.id,
        undefined,
        input.actor,
        eventPayload,
      );
    } else {
      request.state = 'ESCALATED';
      step.state = 'WAITING_FOR_HUMAN';
      run.state = 'COMPENSATING';
    }
    if (input.disposition === 'ESCALATED') {
      effect.reconcileDisposition = 'ESCALATED';
      effect.reconcileEscalatedAt = now();
      effect.reconcileEscalationCode = 'COMPENSATION_QUERY_UNSUPPORTED';
      effect.reconcileAfter = null;
    }
    step.lease = undefined;
    return this.acknowledgeCompensationMutation(
      input,
      input.disposition,
      input.response ?? {},
      message,
    );
  }

  /**
   * Rebuild the sealed governed authorization from the durable records the
   * producer wrote — the compensation request, its authorization record, the
   * completed forward effect and the run-metadata evidence copy. The compact
   * outbox payload is only a cross-check; it is never authoritative.
   */
  private governedCompensationAuthorizationFromDurableEvidence(input: {
    evidence: GovernedCompensationAuthorization;
    request: KernelCompensationRequest;
    durableAuthorization: CompensationAuthorizationRecord;
    originalEffect: KernelEffect;
  }): GovernedCompensationAuthorization | null {
    const evidence = input.evidence as unknown as Record<string, unknown>;
    const { request, durableAuthorization } = input;
    const forwardResponse = (input.originalEffect.response ?? {}) as Record<string, unknown>;
    const compensationRequest = {
      originalEffectId: request.originalEffectId,
      destination: input.originalEffect.request.destination,
      forwardResponse,
      compensationPatch: durableAuthorization.compensationPatch,
    };
    if (
      evidence.schema !== 'commander.compensation/v1' ||
      typeof evidence.originalRunStateAtRequest !== 'string' ||
      evidence.originalRunStateAtRequest.length === 0 ||
      typeof evidence.compensationEffectId !== 'string' ||
      evidence.compensationEffectId.length === 0 ||
      evidence.authorizationId !== durableAuthorization.id ||
      evidence.requestId !== request.id ||
      evidence.tenantId !== request.tenantId ||
      evidence.originalRunId !== request.originalRunId ||
      evidence.originalEffectId !== request.originalEffectId ||
      evidence.compensationRunId !== request.compensationRunId ||
      evidence.compensationStepId !== request.compensationStepId ||
      evidence.compensationEffectType !== durableAuthorization.compensationEffectType ||
      evidence.adapterVersion !== durableAuthorization.adapterVersion ||
      evidence.policyDecisionId !== durableAuthorization.policyDecisionId ||
      evidence.policySnapshotId !== durableAuthorization.policySnapshotId ||
      evidence.decisionEffect !== durableAuthorization.decision ||
      evidence.authorizationExpiresAt !== durableAuthorization.expiresAt ||
      evidence.forwardReceiptHash !== durableAuthorization.forwardReceiptHash ||
      evidence.actionDigest !== durableAuthorization.actionDigest ||
      canonical(evidence.compensationRequest) !== canonical(compensationRequest) ||
      canonical(evidence.forwardReceipt ?? null) !== canonical(forwardResponse) ||
      canonical(evidence.approvalBinding ?? null) !==
        canonical(durableAuthorization.approvalBinding ?? null) ||
      durableAuthorization.originalRunId !== request.originalRunId ||
      durableAuthorization.originalEffectId !== request.originalEffectId ||
      durableAuthorization.compensationEffectType !== request.compensationEffectType ||
      durableAuthorization.adapterVersion !== request.adapterVersion ||
      durableAuthorization.forwardReceiptHash !== request.forwardReceiptHash ||
      canonical(durableAuthorization.compensationPatch) !== canonical(request.compensationPatch) ||
      canonicalCompensationHash(forwardResponse) !== durableAuthorization.forwardReceiptHash
    ) {
      return null;
    }
    const sealed = sealGovernedCompensationAuthorization({
      schema: 'commander.compensation/v1',
      authorizationId: durableAuthorization.id,
      requestId: request.id,
      tenantId: request.tenantId,
      originalRunId: request.originalRunId,
      originalEffectId: request.originalEffectId,
      originalRunStateAtRequest: evidence.originalRunStateAtRequest,
      compensationRunId: request.compensationRunId,
      compensationStepId: request.compensationStepId,
      compensationEffectId: evidence.compensationEffectId,
      compensationEffectType: durableAuthorization.compensationEffectType,
      compensationRequest,
      idempotencyKey: deriveEffectIdempotencyKey({
        tenantId: request.tenantId,
        runId: request.compensationRunId,
        stepId: request.compensationStepId,
        effectId: evidence.compensationEffectId,
        request: compensationRequest,
      }),
      forwardReceipt: forwardResponse,
      adapterVersion: durableAuthorization.adapterVersion,
      policyDecisionId: durableAuthorization.policyDecisionId,
      policySnapshotId: durableAuthorization.policySnapshotId,
      decisionEffect: durableAuthorization.decision,
      authorizationExpiresAt: durableAuthorization.expiresAt,
      approvalBinding: durableAuthorization.approvalBinding ?? null,
    });
    const validation = validateGovernedCompensationAuthorization(sealed);
    if (!validation.valid) return null;
    // Re-sealing recomputes `actionDigest` from the JS digest projection, which
    // covers a DIFFERENT field set than the durable authorization's digest:
    // `requestCompensation` and create_compensation_authorization_internal_v1
    // hash {type, originalEffectId, adapterVersion, destination, forwardResponse,
    // compensationPatch}. Trusting the re-derived value made
    // `governed.actionDigest !== request.actionDigest` in admitEffect, so a
    // durable authorization could be requested but never admitted. The stored row
    // is the authority, exactly as it is in Postgres.
    return { ...validation.authorization, actionDigest: durableAuthorization.actionDigest };
  }

  async claimCompensationWork(
    input: CompensationClaimAuth & { topic: typeof KERNEL_COMPENSATION_TOPIC; limit: number },
  ): Promise<ClaimedCompensationWork[]> {
    const worker = this.workers.get(input.workerId);
    if (
      worker?.identitySubject !== 'db:commander_adapter_ops' ||
      worker.capabilities.length !== 1 ||
      worker.capabilities[0] !== 'effect.compensate'
    ) {
      return [];
    }
    const messages = await this.claimOutboxByTopic(input.topic, input.limit, new Date(), input);
    const claimed: ClaimedCompensationWork[] = [];
    for (const message of messages) {
      const claimToken = message.claimToken ?? '';
      const payload = message.payload;
      const payloadRequestId = typeof payload.requestId === 'string' ? payload.requestId : null;
      const payloadAuthorizationId =
        typeof payload.authorizationId === 'string' ? payload.authorizationId : null;
      const payloadTenantId = typeof payload.tenantId === 'string' ? payload.tenantId : null;
      const payloadActionDigest =
        typeof payload.actionDigest === 'string' ? payload.actionDigest : null;
      // Mirror claim_compensation_request_v2: the durable request is the
      // resolution root, then its sealed authorization record. The compact
      // outbox payload only cross-checks those durable rows.
      const request = payloadRequestId
        ? this.compensationRequests.get(payloadRequestId)
        : undefined;
      const durableAuthorization = request
        ? this.compensationAuthorizations.get(request.authorizationId)
        : undefined;
      const run = request ? this.runs.get(request.compensationRunId) : undefined;
      const step = request ? this.steps.get(request.compensationStepId) : undefined;
      const originalEffect = request ? this.effects.get(request.originalEffectId) : undefined;
      const runAuthorization = run ? this.compensationAuthorization(run) : null;
      const stepAuthorization = step
        ? (step.input as { authorization?: unknown }).authorization
        : undefined;
      const authorization =
        request && durableAuthorization && originalEffect && runAuthorization
          ? this.governedCompensationAuthorizationFromDurableEvidence({
              evidence: runAuthorization,
              request,
              durableAuthorization,
              originalEffect,
            })
          : null;
      if (
        !request ||
        !durableAuthorization ||
        !originalEffect ||
        !authorization ||
        payloadTenantId !== message.tenantId ||
        payloadRequestId !== request.id ||
        payloadAuthorizationId !== durableAuthorization.id ||
        payloadActionDigest !== durableAuthorization.actionDigest ||
        request.tenantId !== message.tenantId ||
        request.authorizationId !== durableAuthorization.id ||
        !run ||
        !step ||
        run.state !== 'PENDING' ||
        step.state !== 'PENDING' ||
        !runAuthorization ||
        !stepAuthorization ||
        canonical(runAuthorization) !== canonical(stepAuthorization) ||
        !claimToken
      ) {
        await this.markOutboxPublished(message.id, claimToken, message.tenantId);
        this.event(
          'effect',
          `compensation:${message.id}`,
          1,
          'compensation.authorization_required',
          message.tenantId,
          String(message.payload.runId ?? `compensation:${message.id}`),
          typeof message.payload.stepId === 'string' ? message.payload.stepId : undefined,
          input.workerId,
          { reason: 'COMPENSATION_AUTHORIZATION_REQUIRED', messageId: message.id },
        );
        continue;
      }
      const fencingEpoch =
        (this.lastFencingEpoch.get(step.id) ?? step.lease?.fencingEpoch ?? 0) + 1;
      // COMPENSATING (not RUNNING): claimCompensationRequest and the Postgres
      // batch claim — which delegates to it — both set this, and completeEffect
      // only treats a compensate.* effect as a governed compensation completion
      // when its run is COMPENSATING.
      if (run.state === 'PENDING') run.state = 'COMPENSATING';
      step.state = 'RUNNING';
      step.version += 1;
      const claimExpiresAt = new Date(Date.now() + 60_000).toISOString();
      step.lease = {
        workerId: input.workerId,
        workerGeneration: input.workerGeneration,
        token: claimToken,
        fencingEpoch,
        expiresAt: claimExpiresAt,
      };
      step.updatedAt = now();
      // Stamp the durable request's ownership exactly as claimCompensationRequest
      // does. finalizeCompensation validates request.claimWorkerId /
      // claimWorkerGeneration / claimToken, so a claim that only assigns the step
      // lease is rejected as CLAIM_NOT_OWNED when the consumer settles it.
      request.state = 'CLAIMED';
      request.claimWorkerId = input.workerId;
      request.claimWorkerGeneration = input.workerGeneration;
      request.claimToken = claimToken;
      request.claimExpiresAt = claimExpiresAt;
      // Keep the batch claim identical to claimCompensationRequest and the
      // Postgres implementation: the consumer receives durable request data
      // plus the outbox identity and claim token.
      claimed.push({
        request: clone(request),
        // `durableAuthorization` is the same row, already narrowed non-null by
        // the guard above; re-reading the map here only widened it back to
        // `... | undefined`.
        authorization: clone(durableAuthorization),
        forwardResponse: clone(originalEffect.response ?? {}),
        lease: clone(step.lease),
        outboxMessageId: message.id,
        outboxClaimToken: claimToken,
      });
    }
    return claimed;
  }

  private compensationContext(
    compensationEffectId: string,
    tenantId: string,
  ): {
    authorization: GovernedCompensationAuthorization;
    run: KernelRun;
    step: KernelStep;
    originalRun: KernelRun;
    effect: KernelEffect | undefined;
  } | null {
    for (const run of this.runs.values()) {
      if (run.tenantId !== tenantId) continue;
      const authorization = this.compensationAuthorization(run);
      if (!authorization || authorization.compensationEffectId !== compensationEffectId) continue;
      const step = this.steps.get(authorization.compensationStepId);
      const originalRun = this.runs.get(authorization.originalRunId);
      if (!step || !originalRun || originalRun.tenantId !== tenantId) return null;
      return {
        authorization,
        run,
        step,
        originalRun,
        effect: this.effects.get(compensationEffectId),
      };
    }
    return null;
  }

  // ── WS2 EffectBroker monopoly ──

  async claimOutboxByTopic(
    topic: string,
    limit: number,
    at = new Date(),
    authz?: { workerId: string; workerGeneration: number; claimSecret: string },
  ): Promise<KernelOutboxMessage[]> {
    let tenantFilter: string[] | null = null;
    if (!this.schedulerMode) {
      const workerId = authz?.workerId?.trim();
      if (!workerId) {
        throw new Error('claimOutboxByTopic requires workerId on the worker LOGIN path');
      }
      if (typeof authz?.workerGeneration !== 'number' || !Number.isFinite(authz.workerGeneration)) {
        throw new Error(
          'claimOutboxByTopic requires finite workerGeneration on the worker LOGIN path',
        );
      }
      if (!authz.claimSecret) {
        throw new Error('claimOutboxByTopic requires claimSecret on the worker LOGIN path');
      }
      const scope = this.resolveDurableWorkerTenantScope(
        workerId,
        authz.workerGeneration,
        authz.claimSecret,
      );
      if (!scope) return [];
      tenantFilter = scope.openEnded ? null : scope.tenantIds;
    }
    return [...this.outbox.values()]
      .filter((message) => {
        if (message.topic !== topic || message.publishedAt) return false;
        if (tenantFilter !== null && !tenantFilter.includes(message.tenantId)) return false;
        if ([...this.dlq.values()].some((e) => e.originalId === message.id)) return false;
        if (message.attempts >= this.outboxMaxAttempts) return false;
        const claim = this.outboxClaims.get(message.id);
        return (
          Date.parse(message.availableAt) <= at.getTime() &&
          (!claim || claim.expiresAt <= at.getTime())
        );
      })
      .slice(0, limit)
      .map((message) => {
        const token = randomUUID();
        message.attempts++;
        message.claimToken = token;
        this.outboxClaims.set(message.id, { token, expiresAt: at.getTime() + 60_000 });
        return clone(message);
      });
  }

  async isCapabilityRevoked(jti: string, tenantId: string): Promise<boolean> {
    const key = `${tenantId}\0${jti}`;
    const entry = this.capabilityRevocations.get(key);
    if (!entry) return false;
    if (entry.expiresAt <= Date.now()) {
      this.capabilityRevocations.delete(key);
      return false;
    }
    return true;
  }

  async revokeCapability(input: {
    jti: string;
    tenantId: string;
    expiresAt: string;
    reason?: string;
  }): Promise<void> {
    this.capabilityRevocations.set(`${input.tenantId}\0${input.jti}`, {
      tenantId: input.tenantId,
      expiresAt: Date.parse(input.expiresAt),
      reason: input.reason,
    });
  }

  async consumeCapabilityReplay(input: {
    tenantId: string;
    jti: string;
    nonce: string;
    expiresAt: string;
  }): Promise<boolean> {
    const now = Date.now();
    for (const [key, expiry] of this.capabilityReplays) {
      if (expiry <= now) this.capabilityReplays.delete(key);
    }
    const key = `${input.tenantId}|${input.jti}|${input.nonce}`;
    if (this.capabilityReplays.has(key)) return true;
    this.capabilityReplays.set(key, Date.parse(input.expiresAt));
    return false;
  }

  async isActionAllowed(tenantId: string, action: string): Promise<boolean> {
    const tenantMap = this.effectAllowlist.get(tenantId);
    if (!tenantMap || tenantMap.size === 0) return false; // fail-closed
    let best: { allowed: boolean; exact: boolean; len: number } | null = null;
    for (const [pattern, allowed] of tenantMap) {
      const matches =
        pattern === action || (pattern.endsWith('.*') && action.startsWith(pattern.slice(0, -1)));
      if (!matches) continue;
      const candidate = { allowed, exact: pattern === action, len: pattern.length };
      if (
        !best ||
        (candidate.exact && !best.exact) ||
        (candidate.exact === best.exact && candidate.len > best.len)
      )
        best = candidate;
    }
    return best ? best.allowed : false;
  }

  async setAllowlistEntry(
    tenantId: string,
    actionPattern: string,
    allowed: boolean,
  ): Promise<void> {
    let tenantMap = this.effectAllowlist.get(tenantId);
    if (!tenantMap) {
      tenantMap = new Map();
      this.effectAllowlist.set(tenantId, tenantMap);
    }
    tenantMap.set(actionPattern, allowed);
  }

  async ensureAllowlistDefault(
    tenantId: string,
    actionPattern: string,
    allowed: boolean,
  ): Promise<void> {
    let tenantMap = this.effectAllowlist.get(tenantId);
    if (!tenantMap) {
      tenantMap = new Map();
      this.effectAllowlist.set(tenantId, tenantMap);
    }
    if (!tenantMap.has(actionPattern)) tenantMap.set(actionPattern, allowed);
  }

  async incrementQuota(input: {
    tenantId: string;
    actionClass: string;
    tokensUsed?: number;
    now?: Date;
  }): Promise<{ countUsed: number; tokensUsed: number }> {
    const day = (input.now ?? new Date()).toISOString().slice(0, 10);
    const key = `${input.tenantId}|${input.actionClass}|${day}`;
    const entry = this.effectQuota.get(key) ?? { countUsed: 0, tokensUsed: 0 };
    entry.countUsed += 1;
    entry.tokensUsed += input.tokensUsed ?? 0;
    this.effectQuota.set(key, entry);
    return { countUsed: entry.countUsed, tokensUsed: entry.tokensUsed };
  }

  async getQuota(
    tenantId: string,
    actionClass: string,
    at = new Date(),
  ): Promise<{ countUsed: number; tokensUsed: number }> {
    const day = at.toISOString().slice(0, 10);
    const key = `${tenantId}|${actionClass}|${day}`;
    return this.effectQuota.get(key) ?? { countUsed: 0, tokensUsed: 0 };
  }

  private killSwitchKey(tenantId: string, scope: KillSwitch['scope'], value: string): string {
    return `${tenantId}|${scope}|${value}`;
  }

  async putKillSwitch(input: PutKillSwitchInput): Promise<KillSwitch> {
    const entry: KillSwitch = {
      tenantId: input.tenantId,
      scope: input.scope,
      value: input.value,
      enabled: input.enabled,
      reason: input.reason,
      actor: input.actor,
      updatedAt: now(),
    };
    this.killSwitches.set(this.killSwitchKey(input.tenantId, input.scope, input.value), entry);
    return clone(entry);
  }

  async removeKillSwitch(input: RemoveKillSwitchInput): Promise<void> {
    this.killSwitches.delete(this.killSwitchKey(input.tenantId, input.scope, input.value));
  }

  async listKillSwitches(tenantId: string): Promise<KillSwitch[]> {
    return [...this.killSwitches.values()]
      .filter((entry) => entry.tenantId === tenantId)
      .map(clone)
      .sort((a, b) => a.scope.localeCompare(b.scope) || a.value.localeCompare(b.value));
  }

  async findMatchingKillSwitch(
    tenantId: string,
    dims: KillSwitchMatchDims,
  ): Promise<KillSwitch | null> {
    return findMatchingKillSwitchWithLookup(tenantId, dims, (id) => this.listKillSwitches(id));
  }

  async listEvents(runId: string, tenantId: string): Promise<KernelEvent[]> {
    return this.events
      .filter((event) => event.runId === runId && event.tenantId === tenantId)
      .map(clone);
  }
  async listEffectsForRun(runId: string, tenantId: string): Promise<KernelEffect[]> {
    return [...this.effects.values()]
      .filter((effect) => effect.runId === runId && effect.tenantId === tenantId)
      .map(clone);
  }

  // ── Durable Timers ──
  private readonly timers = new Map<string, KernelTimer>();
  async createTimer(request: CreateTimerRequest, actor: string): Promise<KernelTimer> {
    const timer: KernelTimer = {
      id: `tmr_${randomUUID()}`,
      runId: request.runId,
      stepId: request.stepId,
      tenantId: request.tenantId,
      firesAt: request.firesAt.toISOString(),
      timerType: request.timerType,
      state: 'PENDING',
      payload: request.payload ?? {},
      createdAt: now(),
    };
    this.timers.set(timer.id, timer);
    this.event(
      'run',
      request.runId,
      0,
      'timer.created',
      request.tenantId,
      request.runId,
      request.stepId,
      actor,
      { timerId: timer.id },
    );
    return clone(timer);
  }
  async cancelTimer(timerId: string, tenantId: string): Promise<boolean> {
    const timer = this.timers.get(timerId);
    if (!timer || timer.tenantId !== tenantId || timer.state !== 'PENDING') return false;
    timer.state = 'CANCELLED';
    return true;
  }
  async claimExpiredTimers(at = new Date(), limit = 100): Promise<KernelTimer[]> {
    const expired = [...this.timers.values()]
      .filter((t) => t.state === 'PENDING' && Date.parse(t.firesAt) <= at.getTime())
      .sort((a, b) => a.firesAt.localeCompare(b.firesAt))
      .slice(0, limit);
    for (const t of expired) {
      t.state = 'PROCESSING';
      t.claimToken = randomUUID();
    }
    return expired.map(clone);
  }
  async acknowledgeTimer(timerId: string, tenantId: string, claimToken: string): Promise<boolean> {
    const timer = this.timers.get(timerId);
    if (
      !timer ||
      timer.tenantId !== tenantId ||
      timer.state !== 'PROCESSING' ||
      timer.claimToken !== claimToken
    )
      return false;
    timer.state = 'FIRED';
    timer.firedAt = now();
    timer.claimToken = undefined;
    return true;
  }
  async retryTimer(timerId: string, tenantId: string, claimToken: string): Promise<boolean> {
    const timer = this.timers.get(timerId);
    if (
      !timer ||
      timer.tenantId !== tenantId ||
      timer.state !== 'PROCESSING' ||
      timer.claimToken !== claimToken
    )
      return false;
    timer.state = 'PENDING';
    timer.claimToken = undefined;
    return true;
  }

  // ── Interactions ──
  async createInteraction(
    request: CreateInteractionRequest,
    actor: string,
  ): Promise<KernelInteraction> {
    const step = this.steps.get(request.stepId);
    if (!step || step.tenantId !== request.tenantId || step.runId !== request.runId) {
      throw new KernelInvariantError(
        'STEP_NOT_FOUND',
        `Step ${request.stepId} not found for run ${request.runId} in tenant ${request.tenantId}`,
      );
    }
    const interaction: KernelInteraction = {
      id: request.id ?? `itr_${randomUUID()}`,
      runId: request.runId,
      stepId: request.stepId,
      tenantId: request.tenantId,
      status: 'pending',
      prompt: request.prompt,
      createdAt: now(),
      expiresAt: request.expiresAt?.toISOString(),
    };
    this.interactions.set(interaction.id, interaction);
    this.event(
      'interaction',
      interaction.id,
      0,
      'interaction.created',
      request.tenantId,
      request.runId,
      request.stepId,
      actor,
      {
        interactionId: interaction.id,
        prompt: interaction.prompt,
        expiresAt: interaction.expiresAt ?? null,
      },
    );
    return clone(interaction);
  }
  async answerInteraction(request: AnswerInteractionRequest): Promise<KernelInteraction> {
    const interaction = this.interactions.get(request.interactionId);
    if (
      !interaction ||
      interaction.runId !== request.runId ||
      interaction.tenantId !== request.tenantId ||
      interaction.status !== 'pending'
    ) {
      throw new KernelInvariantError(
        'INTERACTION_NOT_FOUND',
        `Interaction ${request.interactionId} not found or already answered`,
      );
    }
    const step = this.steps.get(interaction.stepId);
    if (
      !step ||
      step.runId !== request.runId ||
      step.tenantId !== request.tenantId ||
      (request.releaseStep !== false && step.state !== 'WAITING_FOR_HUMAN')
    ) {
      throw new KernelInvariantError(
        'INTERACTION_NOT_FOUND',
        `Interaction ${request.interactionId} has no matching waiting step`,
      );
    }
    // KTO-01: mirror the PostgreSQL answer transaction — an expired interaction
    // is not answerable, and the check happens before the step is released or
    // any answer event is appended.
    if (interaction.expiresAt !== undefined) {
      const expiry = Date.parse(interaction.expiresAt);
      if (!Number.isFinite(expiry) || expiry <= Date.parse(now())) {
        throw new KernelInvariantError(
          'INTERACTION_EXPIRED',
          `Interaction ${request.interactionId} expired at ${interaction.expiresAt}`,
        );
      }
    }
    const answeredAt = now();
    interaction.status = 'answered';
    interaction.response = request.response;
    interaction.answeredAt = answeredAt;
    if (request.releaseStep !== false) {
      assertStepTransition(step.state, 'RETRY_WAIT');
      step.state = 'RETRY_WAIT';
      step.scheduledAt = answeredAt;
      step.version++;
      step.lease = undefined;
      step.updatedAt = answeredAt;
    }
    this.event(
      'interaction',
      interaction.id,
      1,
      'interaction.answered',
      request.tenantId,
      request.runId,
      interaction.stepId,
      request.actor,
      { response: request.response },
    );
    if (request.releaseStep !== false) {
      this.event(
        'step',
        step.id,
        step.version,
        'step.interaction_answered',
        step.tenantId,
        step.runId,
        step.id,
        request.actor,
        { interactionId: interaction.id },
      );
    }
    return clone(interaction);
  }
  async getInteraction(interactionId: string, tenantId: string): Promise<KernelInteraction | null> {
    const interaction = this.interactions.get(interactionId);
    return interaction?.tenantId === tenantId ? clone(interaction) : null;
  }
  async listInteractions(runId: string, tenantId: string): Promise<KernelInteraction[]> {
    return [...this.interactions.values()]
      .filter((i) => i.runId === runId && i.tenantId === tenantId)
      .map(clone);
  }
  async expireStaleInteractions(at = new Date(), limit = 100): Promise<KernelInteraction[]> {
    const expired = [...this.interactions.values()]
      .filter(
        (i) => i.status === 'pending' && i.expiresAt && Date.parse(i.expiresAt) <= at.getTime(),
      )
      .slice(0, limit);
    for (const i of expired) {
      i.status = 'expired';
    }
    return expired.map(clone);
  }

  // ── Outbox DLQ ──
  async sweepOutboxDlq(
    at = new Date(),
    _limit = 50,
  ): Promise<{ movedToDlq: number; backoffApplied: number }> {
    let movedToDlq = 0;
    let backoffApplied = 0;
    for (const [id, msg] of [...this.outbox.entries()]) {
      if (msg.publishedAt) continue;
      // Mirrors Postgres FOR UPDATE SKIP LOCKED: don't touch messages with an active claim.
      const claim = this.outboxClaims.get(id);
      if (claim && claim.expiresAt > at.getTime()) continue;
      if (msg.attempts >= this.outboxMaxAttempts) {
        const dlqEntry: KernelDlqEntry = {
          id: `dlq_${randomUUID()}`,
          originalId: id,
          eventId: msg.eventId,
          tenantId: msg.tenantId,
          topic: msg.topic,
          key: msg.key,
          payload: msg.payload,
          attempts: msg.attempts,
          dlqReason: 'max_attempts_exceeded',
          originalCreatedAt: msg.createdAt,
          movedToDlqAt: now(),
        };
        this.dlq.set(dlqEntry.id, dlqEntry);
        msg.publishedAt = now();
        msg.claimToken = undefined;
        this.outboxClaims.delete(id);
        movedToDlq++;
      } else if (msg.attempts > 0 && Date.parse(msg.availableAt) <= at.getTime()) {
        msg.availableAt = new Date(at.getTime() + Math.pow(2, msg.attempts) * 1000).toISOString();
        msg.claimToken = undefined;
        this.outboxClaims.delete(id);
        backoffApplied++;
      }
    }
    return { movedToDlq, backoffApplied };
  }
  async listDlqEntries(limit = 100, topic?: string): Promise<KernelDlqEntry[]> {
    let entries = [...this.dlq.values()];
    if (topic) entries = entries.filter((e) => e.topic === topic);
    return entries.slice(0, limit).map(clone);
  }
  async replayDlqEntry(dlqId: string): Promise<boolean> {
    const entry = this.dlq.get(dlqId);
    if (!entry) return false;
    const newMsg: KernelOutboxMessage = {
      id: randomUUID(),
      eventId: entry.eventId,
      tenantId: entry.tenantId,
      topic: entry.topic,
      key: entry.key,
      payload: entry.payload,
      attempts: 0,
      availableAt: now(),
      createdAt: now(),
    };
    this.outbox.set(newMsg.id, newMsg);
    this.dlq.delete(dlqId);
    return true;
  }

  private requestCompensationIfNeeded(
    step: Pick<KernelStep, 'id' | 'tenantId' | 'runId'>,
    fencingEpoch: number,
    actor: string,
    at = new Date(),
  ): boolean {
    const completedEffects = [...this.effects.values()].filter(
      (effect) =>
        effect.runId === step.runId &&
        effect.tenantId === step.tenantId &&
        effect.state === 'COMPLETED',
    );
    if (completedEffects.length === 0) return false;
    const run = this.runs.get(step.runId);
    if (!run) return false;
    const compensationKey = `${run.tenantId}/${run.id}/${fencingEpoch}`;
    this.event(
      'effect',
      `compensation:${compensationKey}`,
      1,
      'compensation.authorization_required',
      run.tenantId,
      run.id,
      step.id,
      actor,
      {
        reason: 'COMPENSATION_AUTHORIZATION_REQUIRED',
        originalRunId: run.id,
        originalEffectIds: completedEffects.map((effect) => effect.id),
        fencingEpoch,
      },
      compensationKey,
    );
    return false;
  }

  private cancelOpenStepsForTerminalRun(
    runId: string,
    tenantId: string,
    actor: string,
    reason: string,
  ): void {
    for (const step of this.steps.values()) {
      if (step.runId !== runId || step.tenantId !== tenantId) continue;
      if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'SKIPPED'].includes(step.state)) continue;
      const previousState = step.state;
      assertStepTransition(previousState, 'CANCELLED');
      if (step.lease) this.lastFencingEpoch.set(step.id, step.lease.fencingEpoch);
      step.state = 'CANCELLED';
      step.version++;
      step.lease = undefined;
      step.updatedAt = now();
      step.error = { code: 'RUN_TERMINAL', message: reason, retryable: false };
      this.parkOrphanAdmittedEffects(step, reason, actor);
      this.event(
        'step',
        step.id,
        step.version,
        'step.cancelled',
        step.tenantId,
        step.runId,
        step.id,
        actor,
        { reason, previousState },
      );
    }
  }

  private event(
    aggregateType: KernelEvent['aggregateType'],
    aggregateId: string,
    sequence: number,
    type: string,
    tenantId: string,
    runId: string,
    stepId: string | undefined,
    actor: string,
    payload: Record<string, unknown>,
    outboxKey = runId,
  ): string {
    const event: KernelEvent = {
      eventId: randomUUID(),
      aggregateType,
      aggregateId,
      sequence,
      type,
      tenantId,
      runId,
      stepId,
      actor,
      schemaVersion: 'v2',
      payload,
      occurredAt: now(),
    };
    this.events.push(event);
    const message: KernelOutboxMessage = {
      id: randomUUID(),
      eventId: event.eventId,
      tenantId,
      topic: `commander.${type}`,
      key: outboxKey,
      payload: {
        ...payload,
        eventId: event.eventId,
        type,
        runId,
        stepId: stepId ?? null,
        tenantId,
      },
      attempts: 0,
      availableAt: event.occurredAt,
      createdAt: event.occurredAt,
    };
    this.outbox.set(message.id, message);
    return event.eventId;
  }
  private finish(runId: string, actor: string): void {
    const run = this.runs.get(runId)!;
    const steps = [...this.steps.values()].filter((step) => step.runId === runId);
    const terminalCandidate =
      steps.some((step) => step.state === 'FAILED') ||
      (steps.length > 0 && steps.every((step) => ['SUCCEEDED', 'SKIPPED'].includes(step.state)));
    if (terminalCandidate && this.hasUnreceiptedConsequentialEffect(runId, run.tenantId)) return;
    if (steps.some((step) => step.state === 'FAILED')) {
      assertRunTransition(run.state, 'FAILED');
      this.cancelOpenStepsForTerminalRun(runId, run.tenantId, actor, 'run_failed');
      run.state = 'FAILED';
      run.version++;
      run.updatedAt = now();
      run.terminalAt = run.updatedAt;
      this.event(
        'run',
        run.id,
        run.version,
        'run.failed',
        run.tenantId,
        run.id,
        undefined,
        actor,
        {},
      );
    } else if (
      steps.length > 0 &&
      steps.every((step) => ['SUCCEEDED', 'SKIPPED'].includes(step.state))
    ) {
      assertRunTransition(run.state, 'SUCCEEDED');
      run.state = 'SUCCEEDED';
      run.version++;
      run.updatedAt = now();
      run.terminalAt = run.updatedAt;
      this.event(
        'run',
        run.id,
        run.version,
        'run.succeeded',
        run.tenantId,
        run.id,
        undefined,
        actor,
        {},
      );
    }
  }
  private hasUnreceiptedConsequentialEffect(runId: string, tenantId: string): boolean {
    return [...this.effects.values()].some((effect) => {
      if (
        effect.runId !== runId ||
        effect.tenantId !== tenantId ||
        !isClassAEffectType(effect.type)
      ) {
        return false;
      }
      return !this.hasEvidenceForEffect(effect);
    });
  }
  private hasEvidenceForEffect(effect: KernelEffect): boolean {
    const receipt = this.evidence.get(`${effect.tenantId}\u0000evidence_${effect.id}`);
    if (!receipt) return false;
    try {
      assertEvidenceRecordBoundToEffect(receipt, effect);
      return true;
    } catch {
      return false;
    }
  }
}

export function seedFreshOperationsDrains(
  repository: InMemoryKernelRepository,
  tenantId: string,
  at = new Date(),
): void {
  for (const [role, capability] of [
    ['reconcile', 'effect.reconcile'],
    ['compensation', 'effect.compensate'],
  ] as const) {
    repository.seedTestWorker(`${role}:${tenantId}`, [tenantId], 1, {
      capabilities: [capability],
      identitySubject: 'db:commander_adapter_ops',
      registeredAt: new Date(at.getTime() - 10_000),
      lastHeartbeatAt: new Date(at.getTime() - 1_000),
    });
  }
}
