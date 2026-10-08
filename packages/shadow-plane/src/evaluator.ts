import {
  ACTION_GATEWAY_POLICY_ID,
  actionGatewayPolicySnapshot,
  evaluateActionGatewayPolicy,
} from '@praetor/contracts';
import { canonicalBytes, sha256Hex } from './canonical.js';
import type { ShadowObservationV1 } from './contracts.js';

export type ShadowHypotheticalDecision =
  'allow' | 'deny' | 'require_approval' | 'insufficient_evidence';

export interface ShadowEvaluation {
  decision: ShadowHypotheticalDecision;
  decisionId: string;
  reasonCode: string;
  policyId: typeof ACTION_GATEWAY_POLICY_ID;
  policyDigest: string;
}

export interface ShadowPolicyPin {
  policyId: string;
  policyDigest: string;
  expectedDigest?: string;
}

export function observationDigest(observation: ShadowObservationV1): string {
  return sha256Hex(canonicalBytes(observation));
}

export function evaluateShadowObservation(
  observation: ShadowObservationV1,
  pin: ShadowPolicyPin,
): ShadowEvaluation {
  const snapshot = actionGatewayPolicySnapshot();
  if (pin.policyId !== snapshot.policyId || pin.policyDigest !== snapshot.descriptorDigest) {
    throw new Error('SHADOW_POLICY_MISMATCH');
  }
  if (pin.expectedDigest !== undefined && observationDigest(observation) !== pin.expectedDigest) {
    throw new Error('SHADOW_DIGEST_MISMATCH');
  }
  // Supportability is decided before the missing-fact short-circuit. Otherwise a
  // specified but unregistered action paired with a null fact was downgraded to
  // insufficient_evidence/MISSING_POLICY_FACTS, losing the SHADOW_UNSUPPORTED_ACTION
  // rejection evidence and distorting the report's rejected/uncomparable counts.
  if (
    observation.effectType !== null &&
    observation.effectType !== 'connector.kubernetes.deployment.rollback'
  ) {
    throw new Error('SHADOW_UNSUPPORTED_ACTION');
  }
  if (observation.tool !== null && observation.tool !== 'kubernetes.deployment.rollback') {
    throw new Error('SHADOW_UNSUPPORTED_ACTION');
  }
  if (
    observation.effectType === null ||
    observation.tool === null ||
    observation.destination === null
  ) {
    return {
      decision: 'insufficient_evidence',
      decisionId: 'shadow-insufficient-evidence',
      reasonCode: 'MISSING_POLICY_FACTS',
      policyId: ACTION_GATEWAY_POLICY_ID,
      policyDigest: snapshot.descriptorDigest,
    };
  }
  const decision = evaluateActionGatewayPolicy({
    effectType: observation.effectType,
    tool: observation.tool,
    destination: observation.destination,
  });
  return {
    decision: decision.effect,
    decisionId: decision.decisionId,
    reasonCode: decision.reasonCode,
    policyId: ACTION_GATEWAY_POLICY_ID,
    policyDigest: snapshot.descriptorDigest,
  };
}
