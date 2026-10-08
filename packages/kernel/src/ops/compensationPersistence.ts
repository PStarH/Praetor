import { deriveEffectIdempotencyKey } from '@praetor/effect-broker';
import {
  canonicalCompensationHash,
  sealGovernedCompensationAuthorization,
  type GovernedCompensationAuthorization,
  type GovernedCompensationAuthorizationInput,
} from './compensationAuthority.js';
import type { CompensationAuthorizationRecord, KernelEffect, KernelRunState } from '../types.js';
import type {
  CompensationApprovalBinding,
  CompensationDecisionEffect,
} from './compensationAuthority.js';

/** Legacy test-fixture input. Production authority uses CompensationAuthorizationRecord. */
export interface LegacyGovernedCompensationInput {
  tenantId: string;
  originalRunId: string;
  originalEffectId: string;
  forwardReceipt: Record<string, unknown>;
  adapterVersion: string;
  compensationEffectType: string;
  compensationPatch: Record<string, unknown>;
  policyDecisionId: string;
  policySnapshotId: string;
  actionDigest: string;
  decisionEffect: CompensationDecisionEffect;
  authorizationExpiresAt: string;
  approvalBinding: CompensationApprovalBinding | null;
  actor: string;
}

export type CompensationRequestEscalationReason =
  | 'POLICY_DENIED'
  | 'APPROVAL_REQUIRED'
  | 'APPROVAL_BINDING_INVALID'
  | 'AUTHORIZATION_EXPIRED'
  | 'FORWARD_RECEIPT_MISMATCH'
  | 'ACTION_DIGEST_MISMATCH';

export interface GovernedCompensationIdentifiers {
  authorizationId: string;
  requestId: string;
  compensationRunId: string;
  compensationStepId: string;
  compensationEffectId: string;
  idempotencyKey: string;
}

export type PreparedCompensationRequest = {
  authorization: GovernedCompensationAuthorization;
  identifiers: GovernedCompensationIdentifiers;
  escalationReason: CompensationRequestEscalationReason | null;
};

/** Immutable binding persisted on the compensation run for evidence lookup. */
export interface DurableCompensationMetadataAuthorization {
  schema: 'commander.compensation/v1';
  authorizationId: string;
  requestId: string;
  tenantId: string;
  originalRunId: string;
  originalEffectId: string;
  originalRunStateAtRequest: string;
  compensationRunId: string;
  compensationStepId: string;
  compensationEffectId: string;
  compensationEffectType: string;
  compensationRequest: Record<string, unknown>;
  idempotencyKey: string;
  forwardReceipt: Record<string, unknown>;
  forwardReceiptHash: string;
  requestHash: string;
  adapterVersion: string;
  policyDecisionId: string;
  policySnapshotId: string;
  actionDigest: string;
  decisionEffect: CompensationDecisionEffect;
  authorizationExpiresAt: string;
  approvalBinding: CompensationApprovalBinding | null;
}

export function durableCompensationMetadataAuthorization(input: {
  authorization: CompensationAuthorizationRecord;
  requestId: string;
  compensationRunId: string;
  compensationStepId: string;
  compensationEffectId: string;
  originalRunStateAtRequest: KernelRunState;
  originalEffect: Pick<KernelEffect, 'request' | 'response'>;
  approvalBinding?: CompensationApprovalBinding | null;
}): DurableCompensationMetadataAuthorization {
  const { authorization, originalEffect } = input;
  const forwardReceipt = originalEffect.response ?? {};
  const compensationRequest = {
    originalEffectId: authorization.originalEffectId,
    destination: originalEffect.request.destination,
    forwardResponse: forwardReceipt,
    compensationPatch: authorization.compensationPatch,
  };
  return {
    schema: 'commander.compensation/v1',
    authorizationId: authorization.id,
    requestId: input.requestId,
    tenantId: authorization.tenantId,
    originalRunId: authorization.originalRunId,
    originalEffectId: authorization.originalEffectId,
    originalRunStateAtRequest: input.originalRunStateAtRequest,
    compensationRunId: input.compensationRunId,
    compensationStepId: input.compensationStepId,
    compensationEffectId: input.compensationEffectId,
    compensationEffectType: authorization.compensationEffectType,
    compensationRequest,
    idempotencyKey: deriveEffectIdempotencyKey({
      tenantId: authorization.tenantId,
      runId: input.compensationRunId,
      stepId: input.compensationStepId,
      effectId: input.compensationEffectId,
      request: compensationRequest,
    }),
    forwardReceipt,
    forwardReceiptHash: authorization.forwardReceiptHash,
    requestHash: canonicalCompensationHash(compensationRequest),
    adapterVersion: authorization.adapterVersion,
    policyDecisionId: authorization.policyDecisionId,
    policySnapshotId: authorization.policySnapshotId,
    actionDigest: authorization.actionDigest,
    decisionEffect: authorization.decision,
    authorizationExpiresAt: authorization.expiresAt,
    approvalBinding: input.approvalBinding ?? authorization.approvalBinding ?? null,
  };
}

function stableId(prefix: string, value: unknown, length: number): string {
  return `${prefix}_${canonicalCompensationHash(value).slice(0, length)}`;
}

export function governedCompensationIdentifiers(
  input: Pick<
    LegacyGovernedCompensationInput,
    'tenantId' | 'originalRunId' | 'originalEffectId' | 'adapterVersion'
  > & {
    compensationRequest?: Record<string, unknown>;
  },
): GovernedCompensationIdentifiers {
  const identity = {
    protocol: 'commander.compensation/v1',
    tenantId: input.tenantId,
    originalRunId: input.originalRunId,
    originalEffectId: input.originalEffectId,
    adapterVersion: input.adapterVersion,
  };
  const authorizationId = stableId('authorization', identity, 40);
  const requestId = stableId('request', { ...identity, authorizationId }, 40);
  const compensationRunId = stableId('run', { ...identity, purpose: 'compensation-run' }, 40);
  const compensationStepId = stableId('step', { compensationRunId, kind: 'tool' }, 32);
  // The effect identity must be stable before deriving the idempotency key;
  // deriving either from the other would create a cycle.
  const compensationEffectId = stableId(
    'effect',
    { ...identity, compensationRunId, purpose: 'compensation-effect' },
    40,
  );
  const compensationRequest = input.compensationRequest ?? {
    originalEffectId: input.originalEffectId,
    forwardResponse: {},
    compensationPatch: {},
  };
  const idempotencyKey = deriveEffectIdempotencyKey({
    tenantId: input.tenantId,
    runId: compensationRunId,
    stepId: compensationStepId,
    effectId: compensationEffectId,
    request: compensationRequest,
  });
  return {
    authorizationId,
    requestId,
    compensationRunId,
    compensationStepId,
    compensationEffectId,
    idempotencyKey,
  };
}

export function governedCompensationAuthorizationInput(input: {
  request: LegacyGovernedCompensationInput;
  originalRunStateAtRequest: KernelRunState;
  originalEffect: Pick<KernelEffect, 'request' | 'response'>;
}): GovernedCompensationAuthorizationInput {
  const compensationRequest = {
    originalEffectId: input.request.originalEffectId,
    destination: input.originalEffect.request.destination,
    forwardResponse: input.request.forwardReceipt,
    compensationPatch: input.request.compensationPatch,
  };
  const identifiers = governedCompensationIdentifiers({
    ...input.request,
    compensationRequest,
  });
  const idempotencyKey = deriveEffectIdempotencyKey({
    tenantId: input.request.tenantId,
    runId: identifiers.compensationRunId,
    stepId: identifiers.compensationStepId,
    effectId: identifiers.compensationEffectId,
    request: compensationRequest,
  });
  return {
    schema: 'commander.compensation/v1',
    authorizationId: identifiers.authorizationId,
    requestId: identifiers.requestId,
    tenantId: input.request.tenantId,
    originalRunId: input.request.originalRunId,
    originalEffectId: input.request.originalEffectId,
    originalRunStateAtRequest: input.originalRunStateAtRequest,
    compensationRunId: identifiers.compensationRunId,
    compensationStepId: identifiers.compensationStepId,
    compensationEffectId: identifiers.compensationEffectId,
    compensationEffectType: input.request.compensationEffectType,
    compensationRequest,
    idempotencyKey,
    forwardReceipt: input.request.forwardReceipt,
    adapterVersion: input.request.adapterVersion,
    policyDecisionId: input.request.policyDecisionId,
    policySnapshotId: input.request.policySnapshotId,
    decisionEffect: input.request.decisionEffect,
    authorizationExpiresAt: input.request.authorizationExpiresAt,
    approvalBinding: input.request.approvalBinding,
  };
}

export function prepareCompensationRequest(input: {
  request: LegacyGovernedCompensationInput;
  originalRunStateAtRequest: KernelRunState;
  originalEffect: Pick<KernelEffect, 'request' | 'response'>;
  now?: Date;
}): PreparedCompensationRequest {
  const compensationRequest = {
    originalEffectId: input.request.originalEffectId,
    destination: input.originalEffect.request.destination,
    forwardResponse: input.request.forwardReceipt,
    compensationPatch: input.request.compensationPatch,
  };
  const identifiers = governedCompensationIdentifiers({
    ...input.request,
    compensationRequest,
  });
  const authorization = sealGovernedCompensationAuthorization(
    governedCompensationAuthorizationInput(input),
  );
  const now = input.now ?? new Date();
  const authorizationExpiresAt = Date.parse(input.request.authorizationExpiresAt);
  const approvalExpiresAt = input.request.approvalBinding
    ? Date.parse(input.request.approvalBinding.expiresAt)
    : null;
  let escalationReason: CompensationRequestEscalationReason | null = null;
  if (
    canonicalCompensationHash(input.request.forwardReceipt) !==
    canonicalCompensationHash(input.originalEffect.response ?? {})
  ) {
    escalationReason = 'FORWARD_RECEIPT_MISMATCH';
  } else if (input.request.decisionEffect === 'deny') {
    escalationReason = 'POLICY_DENIED';
  } else if (!Number.isFinite(authorizationExpiresAt) || authorizationExpiresAt <= now.getTime()) {
    escalationReason = 'AUTHORIZATION_EXPIRED';
  } else if (
    input.request.decisionEffect === 'require_approval' &&
    input.request.approvalBinding === null
  ) {
    escalationReason = 'APPROVAL_REQUIRED';
  } else if (
    (input.request.decisionEffect === 'allow' && input.request.approvalBinding !== null) ||
    (input.request.approvalBinding !== null &&
      (input.request.approvalBinding.actionDigest !== input.request.actionDigest ||
        input.request.approvalBinding.policySnapshotId !== input.request.policySnapshotId ||
        approvalExpiresAt === null ||
        !Number.isFinite(approvalExpiresAt) ||
        approvalExpiresAt <= now.getTime()))
  ) {
    escalationReason = 'APPROVAL_BINDING_INVALID';
  } else if (input.request.actionDigest !== authorization.actionDigest) {
    escalationReason = 'ACTION_DIGEST_MISMATCH';
  }
  return {
    authorization,
    identifiers: { ...identifiers, idempotencyKey: authorization.idempotencyKey },
    escalationReason,
  };
}
