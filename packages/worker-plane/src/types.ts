/** Public contracts for the isolated Commander worker plane. */

export type WorkerKind = 'agent' | 'tool' | 'evaluator' | 'connector' | 'sandbox';
export type WorkerStatus = 'ACTIVE' | 'DRAINING' | 'OFFLINE';

export interface WorkerIdentity {
  /** SPIFFE/JWT/OIDC subject. Verification is delegated to WorkerAuthenticator. */
  subject: string;
  token: string;
  expiresAt: string;
}

export interface WorkerDefinition {
  id: string;
  kind: WorkerKind;
  version: string;
  capabilities: string[];
  maxConcurrency: number;
  labels?: Record<string, string>;
}

export interface WorkerAuthorization {
  /** Empty or ['*'] permits every tenant. */
  tenantIds: string[];
  /** Empty or ['*'] permits every capability. */
  capabilities: string[];
}

export interface WorkerRecord extends WorkerDefinition {
  status: WorkerStatus;
  generation: number;
  activeSteps: number;
  identitySubject: string;
  tenantIds: string[];
  registeredAt: string;
  lastHeartbeatAt: string;
  /**
   * Plaintext claim secret returned once from register(). Keep in process memory;
   * never log or persist. Required for claim_next_step / claim_reconcile_effects.
   */
  claimSecret?: string;
}

export interface WorkerRegistry {
  initialize(): Promise<void>;
  register(
    definition: WorkerDefinition,
    identitySubject: string,
    tenantIds: string[],
    previousClaimSecret?: string,
  ): Promise<WorkerRecord>;
  heartbeat(
    workerId: string,
    generation: number,
    activeSteps: number,
    claimSecret: string,
  ): Promise<WorkerRecord | null>;
  drain(workerId: string, generation: number, claimSecret: string): Promise<boolean>;
  markStale(before: Date): Promise<number>;
  get(workerId: string): Promise<WorkerRecord | null>;
}

export interface WorkerAuthenticator {
  authenticate(
    identity: WorkerIdentity,
    definition: WorkerDefinition,
  ): Promise<WorkerAuthorization>;
}

export interface WorkerLease {
  workerId: string;
  /** Durable registry generation used by kernel fencing. */
  workerGeneration?: number;
  token: string;
  fencingEpoch: number;
  expiresAt: string;
}

export interface ClaimedStep {
  id: string;
  runId: string;
  tenantId: string;
  kind: string;
  version: number;
  attempt: number;
  input: Record<string, unknown>;
  lease: WorkerLease;
}

/** Structural boundary implemented by @praetor/kernel; no legacy runtime imports allowed. */
export interface KernelWorkerPort {
  claimNextStep(request: {
    workerId: string;
    workerGeneration?: number;
    /** Unforgeable claim secret from register() — required on worker claim path. */
    claimSecret?: string;
    leaseTtlMs: number;
    /**
     * @deprecated Ignored — claim authz is durable worker registration only.
     * Callers must not pass tenant scope; Domain D claim RPC drops/hard-denies it.
     */
    tenantIds?: string[];
    capabilities: string[];
  }): Promise<ClaimedStep | null>;
  heartbeatStep(
    stepId: string,
    tenantId: string,
    lease: WorkerLease,
    leaseTtlMs: number,
  ): Promise<unknown | null>;
  completeStep(request: {
    stepId: string;
    tenantId: string;
    lease: WorkerLease;
    expectedVersion: number;
    output?: Record<string, unknown>;
    actor: string;
  }): Promise<unknown | null>;
  failStep(request: {
    stepId: string;
    tenantId: string;
    lease: WorkerLease;
    expectedVersion: number;
    error: { code: string; message: string; retryable: boolean; details?: Record<string, unknown> };
    retryAt?: Date;
    actor: string;
    /** See FailStepRequest.refundAttempt — stop-during-claim must not burn the only attempt. */
    refundAttempt?: boolean;
  }): Promise<unknown | null>;
}

export interface StepExecutor {
  execute(
    step: ClaimedStep,
    context: { signal: AbortSignal; worker: WorkerRecord },
  ): Promise<Record<string, unknown> | undefined>;
}

export class WorkerExecutionError extends Error {
  constructor(
    message: string,
    readonly options: {
      code?: string;
      retryable?: boolean;
      retryDelayMs?: number;
      details?: Record<string, unknown>;
    } = {},
    cause?: unknown,
  ) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'WorkerExecutionError';
  }
}

export interface WorkerServiceConfig {
  leaseTtlMs?: number;
  workerHeartbeatMs?: number;
  pollIntervalMs?: number;
  /** WP-04: hard bound on stop()'s in-flight drain before remaining work is abandoned. */
  drainTimeoutMs?: number;
  sandboxReadiness?: WorkerSandboxReadiness;
  /** Called after registry.register so callers can bind worker generation (e.g. EffectBroker). */
  onRegistered?: (worker: WorkerRecord) => void;
  /**
   * WP-05: claim-loop liveness signal — `false` when the claim path fails (readiness
   * must clear), `true` when a claim RPC succeeds (refresh). Never a one-shot latch.
   */
  onClaimLoopHealth?: (healthy: boolean) => void;
  /** WP-11: releases process-owned resources (e.g. the verified Postgres pool). */
  onDispose?: () => Promise<void> | void;
}

export interface WorkerSandboxReadiness {
  assertReady(): Promise<void>;
}
