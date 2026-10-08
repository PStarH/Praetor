import type { KernelEffect, KernelEvidenceRecord } from '@praetor/kernel';
import {
  buildTerminalEvidenceRecordFromKernel,
  type EffectOutcomeQuerier,
  type EvidenceSigner,
} from '@praetor/effect-broker';

export interface OpsLoopHealth {
  mode: 'draining';
  running: boolean;
  inFlight: boolean;
  lastStartedAt?: string;
  lastSucceededAt?: string;
  lastFailedAt?: string;
  lastErrorCode?: string;
  claimed: number;
  /** Terminal successes only. An undetermined `COMPLETION_UNKNOWN` handoff is NOT a completion. */
  completed: number;
  /**
   * AO-03: compensation handoffs whose outcome is undetermined
   * (`parkCompensationUnknown`/`handoffCompensationUnknown`). Reported as its
   * own bucket so an unresolved remote effect can never be read as success.
   */
  handedOff: number;
  escalated: number;
  rescheduled: number;
  skippedOverlappingTicks: number;
}

export interface ReconciliationTickStats {
  claimed: number;
  completed: number;
  escalated: number;
  rescheduled: number;
}

export interface OpsLoopTelemetryEvent {
  type: 'ops_loop_tick_failed';
  loop: 'reconciliation' | 'compensation';
  errorCode: string;
  errorMessage?: string;
  at: string;
}

interface ReconcileClaimAuth {
  tenantId: string;
  effectId: string;
  workerId: string;
  workerGeneration: number;
  claimSecret: string;
  claimToken: string;
  evidence?: KernelEvidenceRecord;
}

type ReconcileMutationResult =
  | {
      applied: true;
      replayed: boolean;
      disposition: 'COMPLETED' | 'CONFIRMED_NOT_APPLIED' | 'RESCHEDULED' | 'ESCALATED';
      receipt: unknown;
    }
  | { applied: false; reason: string };

type ReconcileDisposition = Extract<ReconcileMutationResult, { applied: true }>['disposition'];

interface ReconciliationRepository {
  listEffectsForRun(runId: string, tenantId: string): Promise<KernelEffect[]>;
  listEvents(
    runId: string,
    tenantId: string,
  ): Promise<
    Array<{
      type: string;
      tenantId: string;
      runId: string;
      stepId?: string;
      aggregateId: string;
      occurredAt: string;
      payload: Record<string, unknown>;
    }>
  >;
  claimReconcileEffects(input: {
    workerId: string;
    workerGeneration: number;
    claimSecret: string;
    limit: number;
  }): Promise<Array<{ effect: KernelEffect; claimToken: string }>>;
  completeReconcileEffect(
    input: ReconcileClaimAuth & { response: Record<string, unknown> },
  ): Promise<ReconcileMutationResult>;
  confirmEffectNotApplied(
    input: ReconcileClaimAuth & { response: Record<string, unknown> },
  ): Promise<ReconcileMutationResult>;
  rescheduleReconcileEffect(
    input: ReconcileClaimAuth & { lastError: { code: string; message: string } },
  ): Promise<ReconcileMutationResult>;
  escalateReconcileEffect(
    input: ReconcileClaimAuth & {
      reason:
        | 'RECONCILE_ADAPTER_NOT_FOUND'
        | 'RECONCILE_QUERY_UNSUPPORTED'
        | 'COMPENSATION_QUERY_UNSUPPORTED';
    },
  ): Promise<ReconcileMutationResult>;
}

interface ReconciliationRegistry {
  resolve(effectType: string): unknown | null;
  outcomeQuerierFor(effectType: string): EffectOutcomeQuerier | null;
}

type ReconciliationOutcome =
  | { status: 'APPLIED'; response: Record<string, unknown> }
  | { status: 'NOT_APPLIED'; response: Record<string, unknown> }
  | { status: 'UNKNOWN'; error: { code: string; message: string } };

interface ReconciliationBroker {
  reconcileUnknown(input: {
    effect: KernelEffect;
    querier: EffectOutcomeQuerier;
  }): Promise<ReconciliationOutcome>;
}

const EMPTY_RECONCILIATION_STATS: ReconciliationTickStats = {
  claimed: 0,
  completed: 0,
  escalated: 0,
  rescheduled: 0,
};

/**
 * AO-06: the kernel's worker-path `claim_reconcile_effects` RPC leases every
 * claim for a fixed 60s (packages/kernel/src/evidenceSchema.ts) and it takes no
 * TTL argument, so adapter-ops cannot extend the lease. The daemon must
 * therefore bound its own per-effect outcome query below that lease: a query
 * that outlives the lease is fenced on mutation (`CLAIM_EXPIRED`, so attempts
 * do not advance) and the same effect is re-driven forever.
 */
export const DURABLE_RECONCILE_CLAIM_LEASE_MS = 60_000;

export const DEFAULT_RECONCILE_QUERY_TIMEOUT_MS = 30_000;

export const RECONCILE_QUERY_TIMEOUT = 'RECONCILE_QUERY_TIMEOUT';

const RECOGNIZED_ERROR_NAMES = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'URIError',
  'EvalError',
  'AggregateError',
  'AbortError',
]);

function firstCodePoints(value: string, limit: number): string {
  return Array.from(value).slice(0, limit).join('');
}

function normalizedEffectType(effectType: string): string {
  return effectType.replace(/[^A-Za-z0-9._:-]/g, '_');
}

function thrownKind(error: unknown): string {
  if (error instanceof Error) {
    return RECOGNIZED_ERROR_NAMES.has(error.name) ? error.name : 'Error';
  }
  if (error === null) return 'non-Error:null';
  return `non-Error:${typeof error}`;
}

export function reconcileQueryThrownError(
  error: unknown,
  effectType: string,
): { code: 'RECONCILE_QUERY_THROWN'; message: string } {
  return {
    code: 'RECONCILE_QUERY_THROWN',
    message: firstCodePoints(
      `Outcome query threw ${thrownKind(error)} for effect type ${normalizedEffectType(effectType)}`,
      512,
    ),
  };
}

export function opsLoopErrorCode(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.length > 0
  ) {
    return error.code;
  }
  if (error instanceof Error && error.name) return error.name;
  return 'UNKNOWN';
}

export function opsLoopErrorMessage(error: unknown): string | undefined {
  if (error instanceof Error && error.message.trim().length > 0) {
    return firstCodePoints(error.message, 512);
  }
  if (typeof error === 'string' && error.trim().length > 0) {
    return firstCodePoints(error, 512);
  }
  return undefined;
}

export interface ReconciliationDaemonOptions {
  repository: ReconciliationRepository;
  terminalEvidenceContext?: Pick<
    import('@praetor/effect-broker').EffectKernelPort,
    'getTerminalEvidenceContext'
  >;
  brokerFactory: (querier: EffectOutcomeQuerier) => ReconciliationBroker;
  registry: ReconciliationRegistry;
  pollIntervalMs: number;
  batchSize: number;
  workerId: string;
  workerGeneration: number;
  claimSecret: string;
  evidenceSigner?: EvidenceSigner;
  evidenceRetentionMs?: number;
  heartbeat?: () => Promise<void>;
  drain?: () => Promise<void>;
  telemetry?: (event: OpsLoopTelemetryEvent) => void;
  /**
   * Per-effect outcome-query budget. Must be a positive integer strictly below
   * the durable claim lease (AO-06). Defaults to 30s.
   */
  queryTimeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function adapterOutcomeInvalid(effectType: string): ReconciliationOutcome {
  return {
    status: 'UNKNOWN',
    error: {
      code: 'ADAPTER_OUTCOME_INVALID',
      message: firstCodePoints(
        `Adapter outcome invalid for effect type ${normalizedEffectType(effectType)}`,
        512,
      ),
    },
  };
}

function normalizeOutcome(value: unknown, effectType: string): ReconciliationOutcome {
  if (!isRecord(value) || typeof value.status !== 'string') {
    return adapterOutcomeInvalid(effectType);
  }
  if ((value.status === 'APPLIED' || value.status === 'NOT_APPLIED') && isRecord(value.response)) {
    return { status: value.status, response: value.response };
  }
  if (
    value.status === 'UNKNOWN' &&
    isRecord(value.error) &&
    typeof value.error.code === 'string' &&
    value.error.code.length > 0 &&
    typeof value.error.message === 'string' &&
    value.error.message.length > 0
  ) {
    return {
      status: 'UNKNOWN',
      error: { code: value.error.code, message: value.error.message },
    };
  }
  return adapterOutcomeInvalid(effectType);
}

function transitionRejected(reason: string): Error & { code: string } {
  return Object.assign(new Error(`reconciliation mutation rejected: ${reason}`), {
    code: `RECONCILE_${reason}`,
  });
}

function appliedDisposition(
  result: ReconcileMutationResult,
  allowed: readonly ReconcileDisposition[],
): ReconcileMutationResult & { applied: true } {
  if (!result.applied) throw transitionRejected(result.reason);
  if (!allowed.includes(result.disposition)) {
    throw Object.assign(new Error('reconciliation mutation returned an invalid disposition'), {
      code: 'RECONCILE_DISPOSITION_INVALID',
    });
  }
  return result;
}

export class ReconciliationDaemon {
  private timer: NodeJS.Timeout | null = null;
  private activeTick: Promise<ReconciliationTickStats> | null = null;
  private lastTickSucceeded = false;
  private readonly healthState: OpsLoopHealth = {
    mode: 'draining',
    running: false,
    inFlight: false,
    claimed: 0,
    completed: 0,
    handedOff: 0,
    escalated: 0,
    rescheduled: 0,
    skippedOverlappingTicks: 0,
  };

  private readonly queryTimeoutMs: number;

  constructor(private readonly options: ReconciliationDaemonOptions) {
    const queryTimeoutMs = options.queryTimeoutMs ?? DEFAULT_RECONCILE_QUERY_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(queryTimeoutMs) ||
      queryTimeoutMs <= 0 ||
      queryTimeoutMs >= DURABLE_RECONCILE_CLAIM_LEASE_MS
    ) {
      throw new Error(
        `RECONCILE_QUERY_TIMEOUT_INVALID: queryTimeoutMs must be a positive integer below the ` +
          `durable reconcile claim lease (${DURABLE_RECONCILE_CLAIM_LEASE_MS}ms)`,
      );
    }
    this.queryTimeoutMs = queryTimeoutMs;
  }

  start(): void {
    if (this.healthState.running) return;
    this.healthState.running = true;
    this.lastTickSucceeded = false;
    delete this.healthState.lastSucceededAt;
    this.timer = setInterval(() => {
      void this.tick().catch(() => {
        // tick() records health and telemetry before rejecting.
      });
    }, this.options.pollIntervalMs);
    void this.tick().catch(() => {
      // tick() records health and telemetry before rejecting.
    });
  }

  async stop(options: { drain?: boolean } = {}): Promise<void> {
    const shouldDrain = this.healthState.running && options.drain !== false;
    this.healthState.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const errors: unknown[] = [];
    try {
      await this.activeTick;
    } catch (error) {
      errors.push(error);
    }
    if (shouldDrain && this.options.drain) {
      try {
        await this.options.drain();
      } catch (error) {
        this.recordFailure(error);
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'reconciliation daemon stop failed');
  }

  isHealthy(now = Date.now()): boolean {
    if (!this.healthState.running || !this.lastTickSucceeded || !this.healthState.lastSucceededAt) {
      return false;
    }
    return now - Date.parse(this.healthState.lastSucceededAt) <= this.options.pollIntervalMs * 3;
  }

  getHealth(): OpsLoopHealth {
    return { ...this.healthState };
  }

  async tick(): Promise<ReconciliationTickStats> {
    if (this.activeTick) {
      this.healthState.skippedOverlappingTicks += 1;
      return { ...EMPTY_RECONCILIATION_STATS };
    }
    this.healthState.inFlight = true;
    this.healthState.lastStartedAt = new Date().toISOString();
    const activeTick = this.runTick().finally(() => {
      if (this.activeTick === activeTick) {
        this.activeTick = null;
        this.healthState.inFlight = false;
      }
    });
    this.activeTick = activeTick;
    return activeTick;
  }

  private async runTick(): Promise<ReconciliationTickStats> {
    const stats = { ...EMPTY_RECONCILIATION_STATS };
    let claimed: Awaited<ReturnType<ReconciliationRepository['claimReconcileEffects']>>;
    try {
      claimed = await this.options.repository.claimReconcileEffects({
        workerId: this.options.workerId,
        workerGeneration: this.options.workerGeneration,
        claimSecret: this.options.claimSecret,
        limit: this.options.batchSize,
      });
    } catch (error) {
      this.recordFailure(error);
      throw error;
    }

    stats.claimed = claimed.length;
    let tickFailure: unknown;
    for (const { effect, claimToken } of claimed) {
      try {
        await this.reconcileClaim(effect, claimToken, stats);
      } catch (error) {
        tickFailure ??= error;
      }
    }

    this.healthState.claimed += stats.claimed;
    this.healthState.completed += stats.completed;
    this.healthState.escalated += stats.escalated;
    this.healthState.rescheduled += stats.rescheduled;
    if (tickFailure !== undefined) {
      this.recordFailure(tickFailure);
      throw tickFailure;
    }
    try {
      await this.options.heartbeat?.();
      this.healthState.lastSucceededAt = new Date().toISOString();
      this.lastTickSucceeded = true;
    } catch (error) {
      this.recordFailure(error);
      throw error;
    }
    return stats;
  }

  private async reconcileClaim(
    effect: KernelEffect,
    claimToken: string,
    stats: ReconciliationTickStats,
  ): Promise<void> {
    const auth: ReconcileClaimAuth = {
      tenantId: effect.tenantId,
      effectId: effect.id,
      workerId: this.options.workerId,
      workerGeneration: this.options.workerGeneration,
      claimSecret: this.options.claimSecret,
      claimToken,
    };
    if (this.options.registry.resolve(effect.type) === null) {
      const evidence = await this.buildEvidence(
        effect,
        claimToken,
        'COMPLETION_UNKNOWN',
        { reason: 'RECONCILE_ADAPTER_NOT_FOUND' },
        'effect.reconcile_escalated',
        'RECONCILE_ADAPTER_NOT_FOUND',
      );
      const result = appliedDisposition(
        await this.options.repository.escalateReconcileEffect({
          ...auth,
          reason: 'RECONCILE_ADAPTER_NOT_FOUND',
          evidence,
        }),
        ['ESCALATED'],
      );
      if (result.disposition === 'ESCALATED') stats.escalated += 1;
      return;
    }

    const querier = this.options.registry.outcomeQuerierFor(effect.type);
    if (!querier) {
      const reason = effect.type.startsWith('compensate.')
        ? 'COMPENSATION_QUERY_UNSUPPORTED'
        : 'RECONCILE_QUERY_UNSUPPORTED';
      const evidence = await this.buildEvidence(
        effect,
        claimToken,
        'COMPLETION_UNKNOWN',
        { reason },
        'effect.reconcile_escalated',
        reason,
      );
      const result = appliedDisposition(
        await this.options.repository.escalateReconcileEffect({
          ...auth,
          reason,
          evidence,
        }),
        ['ESCALATED'],
      );
      if (result.disposition === 'ESCALATED') stats.escalated += 1;
      return;
    }

    const broker = this.options.brokerFactory(querier);
    const outcome = await this.queryOutcomeWithinBudget(broker, effect, querier);

    if (outcome.status === 'APPLIED') {
      const evidence = await this.buildEvidence(
        effect,
        claimToken,
        'COMPLETED',
        outcome.response,
        'effect.reconciled_completed',
        'COMPLETED',
      );
      appliedDisposition(
        await this.options.repository.completeReconcileEffect({
          ...auth,
          response: outcome.response,
          evidence,
        }),
        ['COMPLETED'],
      );
      stats.completed += 1;
      return;
    }
    if (outcome.status === 'NOT_APPLIED') {
      const evidence = await this.buildEvidence(
        effect,
        claimToken,
        'CONFIRMED_NOT_APPLIED',
        outcome.response,
        'effect.confirmed_not_applied',
        'CONFIRMED_NOT_APPLIED',
      );
      appliedDisposition(
        await this.options.repository.confirmEffectNotApplied({
          ...auth,
          response: outcome.response,
          evidence,
        }),
        ['CONFIRMED_NOT_APPLIED'],
      );
      stats.completed += 1;
      return;
    }

    const evidence = await this.buildEvidence(
      effect,
      claimToken,
      'COMPLETION_UNKNOWN',
      outcome.error,
      'effect.reconcile_escalated',
      'ESCALATED',
    );
    const result = appliedDisposition(
      await this.options.repository.rescheduleReconcileEffect({
        ...auth,
        lastError: outcome.error,
        evidence,
      }),
      ['RESCHEDULED', 'ESCALATED'],
    );
    if (result.disposition === 'ESCALATED') stats.escalated += 1;
    else stats.rescheduled += 1;
  }

  /**
   * AO-06: an outcome query that outlives its budget is the *absence* of a
   * decision, never an approval. It becomes `UNKNOWN`, which takes the existing
   * reschedule path (so `reconcile_attempts`/backoff/deadline advance) instead
   * of blocking the tick until the 60s claim lease expires and the mutation is
   * fenced — the loop that used to re-drive a slow effect forever.
   */
  private async queryOutcomeWithinBudget(
    broker: ReconciliationBroker,
    effect: KernelEffect,
    querier: EffectOutcomeQuerier,
  ): Promise<ReconciliationOutcome> {
    let timer: NodeJS.Timeout | undefined;
    const controller = new AbortController();
    const boundedQuerier: EffectOutcomeQuerier = {
      queryOutcome: (input) => {
        const signal = input.signal
          ? AbortSignal.any([input.signal, controller.signal])
          : controller.signal;
        signal.throwIfAborted();
        return querier.queryOutcome({ ...input, signal });
      },
    };
    try {
      return await Promise.race([
        Promise.resolve(broker.reconcileUnknown({ effect, querier: boundedQuerier })).then(
          (value) => normalizeOutcome(value, effect.type),
        ),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            const error = Object.assign(
              new Error('reconciliation outcome query exceeded its budget'),
              { code: RECONCILE_QUERY_TIMEOUT },
            );
            // Settle the timeout first: abort listeners may synchronously resolve a query.
            reject(error);
            controller.abort(error);
          }, this.queryTimeoutMs);
          timer.unref();
        }),
      ]);
    } catch (error) {
      if (opsLoopErrorCode(error) === RECONCILE_QUERY_TIMEOUT) {
        return {
          status: 'UNKNOWN',
          error: {
            code: RECONCILE_QUERY_TIMEOUT,
            message: firstCodePoints(
              `Outcome query exceeded ${this.queryTimeoutMs}ms budget for effect type ` +
                normalizedEffectType(effect.type),
              512,
            ),
          },
        };
      }
      return { status: 'UNKNOWN', error: reconcileQueryThrownError(error, effect.type) };
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
    }
  }

  private async buildEvidence(
    effect: KernelEffect,
    claimToken: string,
    projectedState: 'COMPLETED' | 'CONFIRMED_NOT_APPLIED' | 'COMPLETION_UNKNOWN',
    response: Record<string, unknown>,
    eventType: string,
    disposition: string,
  ): Promise<KernelEvidenceRecord> {
    if (!this.options.evidenceSigner) {
      throw Object.assign(new Error('reconciliation evidence signer is required'), {
        code: 'EVIDENCE_SIGNING_KEY_REQUIRED',
      });
    }
    const recordedAt = new Date().toISOString();
    const evidence = await buildTerminalEvidenceRecordFromKernel({
      kernel: this.options.terminalEvidenceContext ?? this.options.repository,
      signer: this.options.evidenceSigner,
      tenantId: effect.tenantId,
      runId: effect.runId,
      effectId: effect.id,
      projectedState,
      response,
      terminalEvent: {
        type: eventType,
        severity: projectedState === 'COMPLETED' ? 'low' : 'high',
        details: { disposition },
      },
      recordedAt,
      retentionUntil: new Date(
        Date.parse(recordedAt) + (this.options.evidenceRetentionMs ?? 365 * 24 * 60 * 60 * 1_000),
      ).toISOString(),
      claimToken,
    });
    return {
      ...evidence,
      body: Object.fromEntries(Object.entries(evidence.body)),
    };
  }

  private recordFailure(error: unknown): void {
    this.lastTickSucceeded = false;
    const at = new Date().toISOString();
    const errorCode = opsLoopErrorCode(error);
    this.healthState.lastFailedAt = at;
    this.healthState.lastErrorCode = errorCode;
    this.options.telemetry?.({
      type: 'ops_loop_tick_failed',
      loop: 'reconciliation',
      errorCode,
      ...(opsLoopErrorMessage(error) ? { errorMessage: opsLoopErrorMessage(error) } : {}),
      at,
    });
  }
}
