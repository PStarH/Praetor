/**
 * SDK API v1 — stable versioned resources (Architecture V2).
 *
 * These types are the public contract. Do not leak core internals here.
 */

import type {
  ActionApprovalRequestV1,
  ActionCompensationApprovalRequestV1,
  ActionCompensationApprovalResponseV1,
  ActionCompensationRequestResponseV1,
  ActionCompensationRequestV1,
  ActionDecisionV1,
  ActionEffectV1,
  ActionErrorDetailV1,
  ActionErrorV1,
  ActionEvidenceV1,
  ActionKillSwitchScopeV1,
  ActionKillSwitchUpdateV1,
  ActionKillSwitchV1,
  ActionProposeRequestV1,
  ActionProposeResponseV1,
  ActionReconcileAcceptedV1,
  ActionSimulationResponseV1,
  ActionSimulationV1,
  ActionStateV1,
  GovernedActionV1,
  RunState,
  StepState,
} from '@praetor/contracts';

export const SDK_API_VERSION = 'v1' as const;

/** Canonical run state. Re-exported from @praetor/contracts. */
export type RunStateV1 = RunState;

/** Canonical step state. Re-exported from @praetor/contracts. */
export type StepStateV1 = StepState;

/**
 * @deprecated Use {@link RunStateV1} from @praetor/contracts.
 * Legacy lowercase status names are being removed in Architecture V2 (WP7).
 */
export type RunStatusV1 = RunStateV1;

export interface RunV1 {
  id: string;
  status: RunStateV1;
  goal: string;
  tenantId?: string;
  createdAt: string;
  updatedAt?: string;
  summary?: string;
  error?: string;
}

export interface StepV1 {
  id: string;
  runId: string;
  state: StepStateV1;
  attempt: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt?: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: { code: string; message: string; retryable: boolean };
}

export interface WorkGraphV1 {
  id: string;
  profile: 'run' | 'swarm' | 'drive' | 'goal' | 'company';
  goal: string;
  nodeCount: number;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface InteractionV1 {
  id: string;
  runId: string;
  status: 'pending' | 'answered' | 'expired' | 'cancelled';
  prompt: string;
  response?: unknown;
  createdAt: string;
  expiresAt?: string;
}

export interface ArtifactV1 {
  id: string;
  runId: string;
  name: string;
  contentType: string;
  uri?: string;
  digest?: string;
  createdAt: string;
}

export interface PolicyBundleV1 {
  name: string;
  version: number;
  effectDefaults: { allow: boolean; requireApproval: boolean };
}

export type ActionEffect = ActionEffectV1;
export type ActionDecision = ActionDecisionV1;
export type ActionSimulation = ActionSimulationV1;
export type GovernedActionState = ActionStateV1;
export type GovernedAction = GovernedActionV1;
export type ProposeActionInput = ActionProposeRequestV1;
export type ActionApprovalInput = ActionApprovalRequestV1;
export type ActionCompensationInput = ActionCompensationRequestV1;
export type ActionCompensationApprovalInput = ActionCompensationApprovalRequestV1;
export type ActionCompensationResult = ActionCompensationRequestResponseV1;
export type ActionCompensationApprovalResult = ActionCompensationApprovalResponseV1;
export type SimulateActionResult = ActionSimulationResponseV1;
export type ProposeActionResult = ActionProposeResponseV1 & { accepted: boolean };
export type RequestReconcileResult = ActionReconcileAcceptedV1;
export type ActionEvidenceBundle = ActionEvidenceV1;
export type GatewayErrorDetail = ActionErrorDetailV1;
export type GatewayErrorResponse = ActionErrorV1;
export type KillSwitchScope = ActionKillSwitchScopeV1;
export type KillSwitch = ActionKillSwitchV1;
export type KillSwitchUpdateInput = ActionKillSwitchUpdateV1;

export interface ActionEvidenceJwk {
  kty: 'OKP';
  crv: 'Ed25519';
  x: string;
  kid: string;
  alg?: 'EdDSA';
  use?: 'sig';
}

export interface ActionEvidenceJwks {
  keys: ActionEvidenceJwk[];
}

export interface ActionEvidenceVerification {
  valid: boolean;
  payload?: Record<string, unknown>;
  error?: GatewayErrorDetail;
}

/** Resources exposed by the Gateway under /api/v1/... */
export const SDK_V1_RESOURCES = [
  'runs',
  'workgraphs',
  'interactions',
  'artifacts',
  'policy-bundles',
] as const;

export type SdkV1Resource = (typeof SDK_V1_RESOURCES)[number];
