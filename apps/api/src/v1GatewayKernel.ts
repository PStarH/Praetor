import { createHash } from 'node:crypto';

import {
  createKernelRepository,
  type KernelRepository,
  type KernelRepositoryHandle,
  type AnswerInteractionRequest,
  type KernelEffect,
  type KernelEvent,
  type KernelInteraction,
  type KernelRun,
  type KernelStep,
  type KillSwitch,
  type KillSwitchMatchDims,
  type NewKernelStep,
  type PutKillSwitchInput,
  type RemoveKillSwitchInput,
  type OperationsReadiness,
  type RequestReconcileResult,
  type CompensationAuthorizationRecord,
  type CreateInteractionRequest,
  type RequestCompensationInput,
  type RequestCompensationResult,
} from '@praetor/kernel';
import type { EvidenceBundle, EvidenceSignature } from '@praetor/effect-broker';

export type {
  KillSwitch,
  KillSwitchMatchDims,
  KillSwitchScope,
  PutKillSwitchInput,
  RemoveKillSwitchInput,
} from '@praetor/kernel';

export type ActionReconcileRequestResult = RequestReconcileResult;

export interface GatewayEvidenceRecord {
  tenantId: string;
  runId: string;
  bundleId: string;
  actionDigest: string;
  body: EvidenceBundle;
  contentHash: string;
  signature: EvidenceSignature | null;
  createdAt: string;
  anchoredAt: string | null;
  retentionUntil: string;
}

function isEvidenceBundle(value: unknown): value is EvidenceBundle {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const bundle = value as Record<string, unknown>;
  const scope = bundle.scope;
  return (
    typeof bundle.schemaVersion === 'string' &&
    typeof bundle.bodyVersion === 'string' &&
    typeof bundle.bundleId === 'string' &&
    typeof bundle.exportedAt === 'string' &&
    typeof bundle.actionDigest === 'string' &&
    typeof bundle.terminalDisposition === 'string' &&
    typeof bundle.contentHash === 'string' &&
    Array.isArray(bundle.effects) &&
    Array.isArray(bundle.auditEvents) &&
    typeof scope === 'object' &&
    scope !== null &&
    typeof (scope as Record<string, unknown>).tenantId === 'string' &&
    typeof (scope as Record<string, unknown>).runId === 'string'
  );
}

export interface V1KernelGateway {
  getOperationsReadiness(tenantId: string, now?: Date): Promise<OperationsReadiness>;
  /** Optional read-only evidence repository availability probe; absent is not ready. */
  getEvidenceRepositoryAvailability?(): Promise<{ ready: boolean }>;
  submit(input: {
    tenantId: string;
    idempotencyKey: string;
    goal: string;
    steps: NewKernelStep[];
    workGraphVersion: string;
    policySnapshotId: string;
    metadata?: Record<string, unknown>;
    actor: string;
  }): Promise<{ run: KernelRun; created: boolean }>;
  getRun(runId: string, tenantId: string): Promise<KernelRun | null>;
  getStep(stepId: string, tenantId: string): Promise<KernelStep | null>;
  listEvents(runId: string, tenantId: string): Promise<KernelEvent[]>;
  listInteractions(runId: string, tenantId: string): Promise<KernelInteraction[]>;
  createInteraction(input: CreateInteractionRequest, actor: string): Promise<KernelInteraction>;
  answerInteraction(input: AnswerInteractionRequest): Promise<KernelInteraction>;
  listEffects(runId: string, tenantId: string): Promise<KernelEffect[]>;
  getEffect(effectId: string, tenantId: string): Promise<KernelEffect | null>;
  getEvidence(runId: string, tenantId: string): Promise<GatewayEvidenceRecord | null>;
  requestReconcile(
    effectId: string,
    tenantId: string,
    actor: string,
  ): Promise<ActionReconcileRequestResult>;
  createCompensationAuthorization(
    authorization: CompensationAuthorizationRecord,
  ): Promise<{ authorization: CompensationAuthorizationRecord; replayed: boolean }>;
  getCompensationAuthorization(
    authorizationId: string,
    tenantId: string,
  ): Promise<CompensationAuthorizationRecord | null>;
  requestCompensation(input: RequestCompensationInput): Promise<RequestCompensationResult>;
  /**
   * Pause a run, releasing any active worker leases but keeping scheduled work.
   * Returns null when the run was not found or is not in a pausable state.
   */
  pauseRun(runId: string, tenantId: string, actor: string): Promise<KernelRun | null>;
  /**
   * Resume a paused run so that pending steps become claimable again.
   * Returns null when the run was not found or is not currently paused.
   */
  resumeRun(runId: string, tenantId: string, actor: string): Promise<KernelRun | null>;
  /**
   * Cancel a run and mark all non-terminal steps CANCELLED.
   * Returns null when the run was not found or has already reached a terminal state.
   */
  cancelRun(runId: string, tenantId: string, actor: string): Promise<KernelRun | null>;
  putKillSwitch(input: PutKillSwitchInput): Promise<KillSwitch>;
  removeKillSwitch(input: RemoveKillSwitchInput): Promise<void>;
  listKillSwitches(tenantId: string): Promise<KillSwitch[]>;
  findMatchingKillSwitch(tenantId: string, dims: KillSwitchMatchDims): Promise<KillSwitch | null>;
}

export type { KernelRun } from '@praetor/kernel';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function kernelInvariantCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`)
    .join(',')}}`;
}

export function canonicalValueHash(value: unknown): string {
  return sha256(canonicalStringify(value));
}

export function deriveGatewayRunId(tenantId: string, idempotencyKey: string): string {
  return `run_${sha256(`${tenantId}:${idempotencyKey}`).slice(0, 40)}`;
}

export function legacyGatewaySubmissionHash(
  input: Pick<
    Parameters<V1KernelGateway['submit']>[0],
    'goal' | 'steps' | 'workGraphVersion' | 'policySnapshotId' | 'metadata'
  >,
): string {
  return sha256(
    JSON.stringify({
      goal: input.goal,
      steps: input.steps,
      workGraphVersion: input.workGraphVersion,
      policySnapshotId: input.policySnapshotId,
      metadata: input.metadata ?? {},
    }),
  );
}

function submissionHashMatches(
  stored: unknown,
  input: Pick<
    Parameters<V1KernelGateway['submit']>[0],
    'goal' | 'steps' | 'workGraphVersion' | 'policySnapshotId' | 'metadata'
  >,
): boolean {
  if (typeof stored !== 'string') return false;
  if (stored === canonicalGatewaySubmissionHash(input)) return true;
  return stored === legacyGatewaySubmissionHash(input);
}

export function canonicalGatewaySubmissionHash(
  input: Pick<
    Parameters<V1KernelGateway['submit']>[0],
    'goal' | 'steps' | 'workGraphVersion' | 'policySnapshotId' | 'metadata'
  >,
): string {
  return canonicalValueHash({
    goal: input.goal,
    steps: input.steps,
    workGraphVersion: input.workGraphVersion,
    policySnapshotId: input.policySnapshotId,
    metadata: input.metadata ?? {},
  });
}

export function canonicalWorkGraphHash(steps: NewKernelStep[]): string {
  const canonicalSteps = steps
    .map((s) => ({
      id: s.id,
      kind: s.kind,
      initialState: s.initialState ?? 'PENDING',
      interaction: s.interaction
        ? {
            id: s.interaction.id,
            prompt: s.interaction.prompt,
            expiresAt: s.interaction.expiresAt ?? null,
          }
        : null,
      dependencies: [...(s.dependencies ?? [])].sort(),
      input: s.input ?? {},
      maxAttempts: s.maxAttempts ?? 1,
      priority: s.priority ?? 0,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return sha256(canonicalStringify(canonicalSteps));
}

class RepositoryV1KernelGateway implements V1KernelGateway {
  constructor(private readonly repository: KernelRepository) {}

  getOperationsReadiness(tenantId: string, now?: Date): Promise<OperationsReadiness> {
    return this.repository.getOperationsReadiness(tenantId, now);
  }

  async getEvidenceRepositoryAvailability(): Promise<{ ready: boolean }> {
    return (await this.repository.checkEvidenceRepositoryAvailability?.()) ?? { ready: false };
  }

  async submit(
    input: Parameters<V1KernelGateway['submit']>[0],
  ): Promise<{ run: KernelRun; created: boolean }> {
    const submissionHash = canonicalGatewaySubmissionHash(input);
    const runId = deriveGatewayRunId(input.tenantId, input.idempotencyKey);
    try {
      const run = await this.repository.createRun(
        {
          id: runId,
          tenantId: input.tenantId,
          intentHash: sha256(input.goal),
          workGraphHash: canonicalWorkGraphHash(input.steps),
          workGraphVersion: input.workGraphVersion,
          policySnapshotId: input.policySnapshotId,
          metadata: {
            ...input.metadata,
            goal: input.goal,
            submissionHash,
            idempotencyKey: input.idempotencyKey,
          },
          steps: input.steps,
        },
        input.actor,
      );
      return { run, created: true };
    } catch (error) {
      if (kernelInvariantCode(error) === 'DUPLICATE_STEP') {
        // A step id collided with an already-persisted step (e.g. caller-supplied
        // ids reused across runs, or duplicate ids within one submission). Surface
        // a clean 409 instead of letting the invariant error escape as an HTTP 500.
        throw new GatewayStepIdConflictError(
          'One or more step ids collide with an existing run; supply run-unique step ids.',
        );
      }
      if (kernelInvariantCode(error) !== 'DUPLICATE_RUN') throw error;
      const existing = await this.repository.getRun(runId, input.tenantId);
      if (!existing || !submissionHashMatches(existing.metadata.submissionHash, input)) {
        throw new GatewayIdempotencyConflictError(
          'Idempotency-Key was already used with a different request',
        );
      }
      return { run: existing, created: false };
    }
  }

  getRun(runId: string, tenantId: string): Promise<KernelRun | null> {
    return this.repository.getRun(runId, tenantId);
  }
  getStep(stepId: string, tenantId: string): Promise<KernelStep | null> {
    return this.repository.getStep(stepId, tenantId);
  }
  listEvents(runId: string, tenantId: string): Promise<KernelEvent[]> {
    return this.repository.listEvents(runId, tenantId);
  }
  listInteractions(runId: string, tenantId: string): Promise<KernelInteraction[]> {
    return this.repository.listInteractions(runId, tenantId);
  }
  createInteraction(input: CreateInteractionRequest, actor: string): Promise<KernelInteraction> {
    return this.repository.createInteraction(input, actor);
  }
  answerInteraction(input: AnswerInteractionRequest): Promise<KernelInteraction> {
    return this.repository.answerInteraction(input);
  }
  listEffects(runId: string, tenantId: string): Promise<KernelEffect[]> {
    return this.repository.listEffectsForRun(runId, tenantId);
  }
  getEffect(effectId: string, tenantId: string): Promise<KernelEffect | null> {
    return this.repository.getEffect(effectId, tenantId);
  }
  async getEvidence(runId: string, tenantId: string): Promise<GatewayEvidenceRecord | null> {
    const record = await this.repository.getEvidence(runId, tenantId);
    if (!record) return null;
    if (!isEvidenceBundle(record.body)) throw new Error('EVIDENCE_INVALID');
    return { ...record, body: record.body };
  }
  requestReconcile(
    effectId: string,
    tenantId: string,
    actor: string,
  ): Promise<ActionReconcileRequestResult> {
    return this.requestReconcileFromRepository(effectId, tenantId, actor);
  }
  createCompensationAuthorization(
    authorization: CompensationAuthorizationRecord,
  ): Promise<{ authorization: CompensationAuthorizationRecord; replayed: boolean }> {
    return this.repository.createCompensationAuthorization(authorization);
  }
  getCompensationAuthorization(
    authorizationId: string,
    tenantId: string,
  ): Promise<CompensationAuthorizationRecord | null> {
    return this.repository.getCompensationAuthorization(authorizationId, tenantId);
  }
  requestCompensation(input: RequestCompensationInput): Promise<RequestCompensationResult> {
    return this.repository.requestCompensation(input);
  }
  private async requestReconcileFromRepository(
    effectId: string,
    tenantId: string,
    actor: string,
  ): Promise<ActionReconcileRequestResult> {
    return this.repository.requestReconcile({ effectId, tenantId, actor });
  }
  pauseRun(runId: string, tenantId: string, actor: string): Promise<KernelRun | null> {
    return this.repository.pauseRun(runId, tenantId, actor);
  }
  resumeRun(runId: string, tenantId: string, actor: string): Promise<KernelRun | null> {
    return this.repository.resumeRun(runId, tenantId, actor);
  }
  cancelRun(runId: string, tenantId: string, actor: string): Promise<KernelRun | null> {
    return this.repository.cancelRun(runId, tenantId, actor);
  }
  putKillSwitch(input: PutKillSwitchInput): Promise<KillSwitch> {
    return this.repository.putKillSwitch(input);
  }
  removeKillSwitch(input: RemoveKillSwitchInput): Promise<void> {
    return this.repository.removeKillSwitch(input);
  }
  listKillSwitches(tenantId: string): Promise<KillSwitch[]> {
    return this.repository.listKillSwitches(tenantId);
  }
  findMatchingKillSwitch(tenantId: string, dims: KillSwitchMatchDims): Promise<KillSwitch | null> {
    return this.repository.findMatchingKillSwitch(tenantId, dims);
  }
}

export class GatewayIdempotencyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GatewayIdempotencyConflictError';
  }
}

export class GatewayStepIdConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GatewayStepIdConflictError';
  }
}

let gateway: V1KernelGateway | null = null;
let initializePromise: Promise<void> | null = null;
let repositoryHandle: KernelRepositoryHandle | null = null;

/**
 * Kernel Postgres DSN: COMMANDER_KERNEL_DATABASE_URL, else DATABASE_URL.
 * Empty string when neither is set.
 */
export function getKernelDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.PRAETOR_KERNEL_DATABASE_URL ??
    env.COMMANDER_KERNEL_DATABASE_URL ??
    env.DATABASE_URL ??
    ''
  ).trim();
}

export function isPraetorKernelEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.PRAETOR_KERNEL_ENABLED ?? env.COMMANDER_KERNEL_ENABLED ?? '').trim().toLowerCase();
  if (raw === '0' || raw === 'false' || raw === 'off' || raw === 'no') return false;
  if (raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes') return true;
  if (env.NODE_ENV === 'production') return true;
  if (env.PRAETOR_V2_MODE === '1' || env.COMMANDER_V2_MODE === '1') return true;
  return getKernelDatabaseUrl(env).length > 0;
}

export function isPraetorKernelExplicitlyDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.PRAETOR_KERNEL_ENABLED ?? env.COMMANDER_KERNEL_ENABLED ?? '').trim().toLowerCase();
  return raw === '0' || raw === 'false' || raw === 'off' || raw === 'no';
}

export const isCommanderKernelEnabled = isPraetorKernelEnabled;
export const isCommanderKernelExplicitlyDisabled = isPraetorKernelExplicitlyDisabled;

export async function initializeV1KernelGateway(): Promise<void> {
  if (!isCommanderKernelEnabled()) return;
  if (initializePromise) return initializePromise;
  if (!getKernelDatabaseUrl())
    throw new Error(
      'Kernel enabled (COMMANDER_KERNEL_ENABLED default-on or =1) requires COMMANDER_KERNEL_DATABASE_URL or DATABASE_URL',
    );
  initializePromise = (async () => {
    const handle = await createKernelRepository({
      env: {
        ...process.env,
        COMMANDER_KERNEL_BACKEND: 'postgres',
      },
    });
    repositoryHandle = handle;
    gateway = new RepositoryV1KernelGateway(handle.repository);
  })();
  return initializePromise;
}

export async function closeV1KernelGateway(): Promise<void> {
  const handle = repositoryHandle;
  repositoryHandle = null;
  gateway = null;
  initializePromise = null;
  await handle?.close();
}

export function getV1KernelGateway(): V1KernelGateway | null {
  return gateway;
}

/** Test-only wiring hook; never call from production bootstrap. */
/** Test-only factory over any KernelRepository implementation. */
export function createV1KernelGateway(repository: KernelRepository): V1KernelGateway {
  return new RepositoryV1KernelGateway(repository);
}

export function setV1KernelGatewayForTest(value: V1KernelGateway | null): void {
  gateway = value;
}
