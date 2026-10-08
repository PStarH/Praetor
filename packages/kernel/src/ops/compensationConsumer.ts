import type { EffectEnvelope } from '@praetor/contracts';
import { deriveEffectIdempotencyKey } from '@praetor/effect-broker';
import {
  canonicalCompensationHash,
  validateGovernedCompensationAuthorization,
  type CompensationAuthorizationErrorCode,
  type GovernedCompensationAuthorization,
} from './compensationAuthority.js';
import type {
  ClaimedCompensationRequest,
  CompensationAuthorizationRecord,
  CompensationMutationResult,
  FinalizeCompensationInput,
  KernelCompensationRequest,
  ParkCompensationUnknownInput,
} from '../types.js';
import type { KernelEvidenceRecord } from '../evidenceRepository.js';

export const KERNEL_COMPENSATION_TOPIC = 'commander.kernel.compensation.requested';
export const LEGACY_COMPENSATION_TOPIC = 'commander.compensation';

export interface CompensationClaimAuth {
  workerId: string;
  workerGeneration: number;
  claimSecret: string;
}

export type ClaimedCompensationWork = ClaimedCompensationRequest;

export type CompensationWorkDispositionResult = CompensationMutationResult;

export interface CompensationOutboxPort {
  claimCompensationWork(
    input: CompensationClaimAuth & { topic: typeof KERNEL_COMPENSATION_TOPIC; limit: number },
  ): Promise<ClaimedCompensationWork[]>;
  parkCompensationUnknown(input: ParkCompensationUnknownInput): Promise<CompensationMutationResult>;
  finalizeCompensation(input: FinalizeCompensationInput): Promise<CompensationMutationResult>;
}

export interface CompensationEffectBroker {
  admit(input: {
    effectId: string;
    token: string;
    type: string;
    request: Record<string, unknown>;
    idempotencyKey: string;
    lease: ClaimedCompensationWork['lease'];
    actor: string;
    workloadBinding: {
      tenantId: string;
      runId: string;
      stepId: string;
      workloadId: string;
    };
    compensationClaim?: {
      requestId: string;
      requestClaimToken: string;
      outboxMessageId: string;
      outboxClaimToken: string;
    };
  }): Promise<{ admitted: boolean; effectId: string; replayed: boolean; reason?: string }>;
  executeAdmitted(input: { effectId: string; timeoutMs?: number }): Promise<{
    effectId: string;
    replayed: boolean;
    response?: Record<string, unknown>;
  }>;
}

export type CompensationTokenContext =
  | GovernedCompensationAuthorization
  | {
      authorization: CompensationAuthorizationRecord;
      request: KernelCompensationRequest;
      forwardResponse: Record<string, unknown>;
    };

export interface CompensationTokenProvider {
  (authorization: CompensationTokenContext): Promise<string | null>;
}

export interface CompensationConsumerOptions extends CompensationClaimAuth {
  topic?: typeof KERNEL_COMPENSATION_TOPIC;
  limit?: number;
  timeoutMs?: number;
  registry: {
    resolve(action: string): { descriptor?: { adapterVersion?: string } } | null;
  };
  terminalEvidence?: (input: {
    tenantId: string;
    runId: string;
    effectId: string;
    projectedState: 'COMPLETED' | 'CONFIRMED_NOT_APPLIED' | 'COMPLETION_UNKNOWN';
    response: Record<string, unknown>;
    eventType: string;
    disposition: 'COMPLETED' | 'CONFIRMED_NOT_APPLIED' | 'ESCALATED';
    claimToken: string;
  }) => Promise<KernelEvidenceRecord>;
  onAdapterUnregistered?: (input: {
    tenantId: string;
    runId: string;
    stepId: string;
    compensationAction: string;
    outboxMessageId: string;
  }) => Promise<void>;
}

export interface CompensationConsumeResult {
  consumed: number;
  succeeded: number;
  handedOff: number;
  escalated: number;
  replayed: number;
}

function durableExecution(work: ClaimedCompensationRequest) {
  const { authorization, request, forwardResponse } = work;
  const effectId = request.compensationEffectId;
  if (!effectId) throw mutationRejected('CLAIM_EFFECT_ID_MISSING');
  if (request.destination.length === 0) throw mutationRejected('DESTINATION_MISSING');
  const requestPayload = {
    originalEffectId: request.originalEffectId,
    destination: request.destination,
    forwardResponse,
    compensationPatch: authorization.compensationPatch,
  };
  return {
    authorization,
    effectId,
    runId: request.compensationRunId,
    stepId: request.compensationStepId,
    requestPayload,
    idempotencyKey: deriveEffectIdempotencyKey({
      tenantId: request.tenantId,
      runId: request.compensationRunId,
      stepId: request.compensationStepId,
      effectId,
      request: {
        originalEffectId: request.originalEffectId,
        destination: request.destination,
        forwardResponse,
        compensationPatch: authorization.compensationPatch,
      },
    }),
  };
}

function validateDurableClaim(work: ClaimedCompensationRequest): boolean {
  const { authorization, request, forwardResponse } = work;
  return (
    authorization.id === request.authorizationId &&
    authorization.tenantId === request.tenantId &&
    authorization.originalRunId === request.originalRunId &&
    authorization.originalEffectId === request.originalEffectId &&
    authorization.adapterVersion === request.adapterVersion &&
    authorization.compensationEffectType === request.compensationEffectType &&
    authorization.decision !== 'deny' &&
    Date.parse(authorization.expiresAt) > Date.now() &&
    canonicalCompensationHash(forwardResponse) === authorization.forwardReceiptHash &&
    canonicalCompensationHash({
      type: authorization.compensationEffectType,
      originalEffectId: authorization.originalEffectId,
      adapterVersion: authorization.adapterVersion,
      destination: request.destination,
      forwardResponse,
      compensationPatch: authorization.compensationPatch,
    }) === authorization.actionDigest
  );
}

function mutationRejected(reason: string): Error & { code: string } {
  return Object.assign(new Error(`compensation mutation rejected: ${reason}`), {
    code: `COMPENSATION_${reason}`,
  });
}

function requireDisposition(
  result: CompensationWorkDispositionResult | CompensationMutationResult,
  disposition: 'COMPLETED' | 'COMPLETION_UNKNOWN' | 'ESCALATED',
): void {
  if (!result.applied) throw mutationRejected(result.reason);
  if (result.disposition !== disposition) {
    throw Object.assign(new Error('compensation mutation returned an invalid disposition'), {
      code: 'COMPENSATION_DISPOSITION_INVALID',
    });
  }
}

function uncertaintyCode(error: unknown): 'COMPLETION_UNKNOWN' | 'COMPLETION_UNCONFIRMED' | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  return error.code === 'COMPLETION_UNKNOWN' || error.code === 'COMPLETION_UNCONFIRMED'
    ? error.code
    : null;
}

function assertClaimBinding(
  work: ClaimedCompensationWork,
  options: CompensationConsumerOptions,
): void {
  const tenantId = work.request.tenantId;
  const authorizationTenantId = work.authorization.tenantId;
  const claimToken = work.outboxClaimToken;
  if (
    tenantId !== authorizationTenantId ||
    !claimToken ||
    work.lease.workerId !== options.workerId ||
    work.lease.workerGeneration !== options.workerGeneration ||
    !work.lease.token ||
    !Number.isSafeInteger(work.lease.fencingEpoch) ||
    work.lease.fencingEpoch < 0
  ) {
    throw Object.assign(new Error('governed compensation claim binding is invalid'), {
      code: 'COMPENSATION_WORKER_FENCED',
    });
  }
}

async function escalate(
  outbox: CompensationOutboxPort,
  work: ClaimedCompensationWork,
  options: CompensationConsumerOptions,
  reason:
    | CompensationAuthorizationErrorCode
    | 'COMPENSATION_ADAPTER_UNREGISTERED'
    | 'COMPENSATION_ADAPTER_VERSION_MISMATCH'
    | 'COMPENSATION_TOKEN_REFUSED'
    | 'COMPENSATION_ADMIT_REJECTED',
): Promise<void> {
  const effectId = work.request.compensationEffectId;
  if (!effectId) throw mutationRejected('CLAIM_EFFECT_ID_MISSING');
  const finalized = await outbox.finalizeCompensation({
    workerId: options.workerId,
    workerGeneration: options.workerGeneration,
    claimSecret: options.claimSecret,
    tenantId: work.request.tenantId,
    requestId: work.request.id,
    effectId,
    disposition: 'ESCALATED',
    actor: options.workerId,
    outboxMessageId: work.outboxMessageId,
    outboxClaimToken: work.outboxClaimToken,
    response: { reason },
  });
  requireDisposition(finalized, 'ESCALATED');
}

export async function consumeCompensationBatch(
  outbox: CompensationOutboxPort,
  broker: CompensationEffectBroker,
  tokenProvider: CompensationTokenProvider,
  options: CompensationConsumerOptions,
): Promise<CompensationConsumeResult> {
  const works = await outbox.claimCompensationWork({
    workerId: options.workerId,
    workerGeneration: options.workerGeneration,
    claimSecret: options.claimSecret,
    topic: options.topic ?? KERNEL_COMPENSATION_TOPIC,
    limit: options.limit ?? 50,
  });
  const result: CompensationConsumeResult = {
    consumed: works.length,
    succeeded: 0,
    handedOff: 0,
    escalated: 0,
    replayed: 0,
  };

  for (const work of works) {
    assertClaimBinding(work, options);
    let authorization: GovernedCompensationAuthorization | CompensationAuthorizationRecord;
    let effectId: string;
    let runId: string;
    let stepId: string;
    let requestPayload: Record<string, unknown>;
    let idempotencyKey: string;
    if (!validateDurableClaim(work)) {
      await escalate(outbox, work, options, 'COMPENSATION_ACTION_DIGEST_MISMATCH');
      result.escalated += 1;
      continue;
    }
    const projected = durableExecution(work);
    authorization = projected.authorization;
    effectId = projected.effectId;
    runId = projected.runId;
    stepId = projected.stepId;
    requestPayload = projected.requestPayload;
    idempotencyKey = projected.idempotencyKey;
    const adapter = options.registry.resolve(authorization.compensationEffectType);
    if (!adapter) {
      await options.onAdapterUnregistered?.({
        tenantId: authorization.tenantId,
        runId,
        stepId,
        compensationAction: authorization.compensationEffectType,
        outboxMessageId: work.outboxMessageId,
      });
      await escalate(outbox, work, options, 'COMPENSATION_ADAPTER_UNREGISTERED');
      result.escalated += 1;
      continue;
    }
    if (adapter.descriptor?.adapterVersion !== authorization.adapterVersion) {
      await escalate(outbox, work, options, 'COMPENSATION_ADAPTER_VERSION_MISMATCH');
      result.escalated += 1;
      continue;
    }

    const token = await tokenProvider({
      authorization: work.authorization,
      request: work.request,
      forwardResponse: work.forwardResponse,
    });
    if (!token) {
      await escalate(outbox, work, options, 'COMPENSATION_TOKEN_REFUSED');
      result.escalated += 1;
      continue;
    }
    const admission = await broker.admit({
      effectId,
      token,
      type: authorization.compensationEffectType,
      request: requestPayload,
      idempotencyKey,
      lease: work.lease,
      actor: options.workerId,
      workloadBinding: {
        tenantId: authorization.tenantId,
        runId,
        stepId,
        workloadId: options.workerId,
      },
      compensationClaim: {
        requestId: work.request.id,
        requestClaimToken: work.request.claimToken ?? '',
        outboxMessageId: work.outboxMessageId,
        outboxClaimToken: work.outboxClaimToken,
      },
    });
    if (!admission.admitted || admission.effectId !== effectId) {
      await escalate(outbox, work, options, 'COMPENSATION_ADMIT_REJECTED');
      result.escalated += 1;
      continue;
    }
    if (admission.replayed) result.replayed += 1;

    let execution: Awaited<ReturnType<CompensationEffectBroker['executeAdmitted']>>;
    try {
      execution = await broker.executeAdmitted({
        effectId,
        timeoutMs: options.timeoutMs ?? 30_000,
      });
    } catch (error) {
      const code = uncertaintyCode(error);
      if (!code) throw error;
      requireDisposition(
        await outbox.parkCompensationUnknown({
          workerId: options.workerId,
          workerGeneration: options.workerGeneration,
          claimSecret: options.claimSecret,
          tenantId: work.request.tenantId,
          requestId: work.request.id,
          effectId,
          actor: options.workerId,
          outboxMessageId: work.outboxMessageId,
          outboxClaimToken: work.outboxClaimToken,
          error: { code, message: 'Compensation completion is uncertain' },
        }),
        'COMPLETION_UNKNOWN',
      );
      result.handedOff += 1;
      continue;
    }

    if (execution.effectId !== effectId || !execution.response) {
      throw Object.assign(new Error('compensation execution receipt is invalid'), {
        code: 'COMPENSATION_EXECUTION_RECEIPT_INVALID',
      });
    }
    if (execution.replayed) result.replayed += 1;
    requireDisposition(
      await outbox.finalizeCompensation({
        workerId: options.workerId,
        workerGeneration: options.workerGeneration,
        claimSecret: options.claimSecret,
        tenantId: work.request.tenantId,
        requestId: work.request.id,
        effectId,
        disposition: 'COMPLETED',
        actor: options.workerId,
        outboxMessageId: work.outboxMessageId,
        outboxClaimToken: work.outboxClaimToken,
        response: execution.response,
        evidence: await options.terminalEvidence?.({
          tenantId: work.request.tenantId,
          runId: work.request.compensationRunId,
          effectId,
          projectedState: 'COMPLETED',
          response: execution.response,
          eventType: 'compensation.completed',
          disposition: 'COMPLETED',
          claimToken: work.outboxClaimToken,
        }),
      }),
      'COMPLETED',
    );
    result.succeeded += 1;
  }

  return result;
}

export function normalizeCompensationPayload(
  raw: Record<string, unknown>,
): GovernedCompensationAuthorization | null {
  const validation = validateGovernedCompensationAuthorization(raw);
  return validation.valid ? validation.authorization : null;
}

export function envelopeFromCompensationPayload(
  authorization: GovernedCompensationAuthorization,
): EffectEnvelope {
  return {
    effect_id: authorization.compensationEffectId,
    tenant_id: authorization.tenantId,
    run_id: authorization.compensationRunId,
    step_id: authorization.compensationStepId,
    action: authorization.compensationEffectType,
    payload: authorization.compensationRequest,
    idempotency_key: authorization.idempotencyKey,
    status: 'admitted',
  };
}
