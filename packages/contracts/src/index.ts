/**
 * @praetor/contracts — Architecture V2 shared public contracts.
 *
 * This package contains ONLY types, constants, and pure validation helpers.
 * It must never import runtime implementation code from @praetor/core,
 * @praetor/kernel, or any provider/tool package.
 */

export { CONTRACTS_VERSION } from './resources.js';
export type {
  AgentDefinitionV2,
  ArtifactV2,
  ConnectorDefinitionV2,
  ConnectorAuthMode,
  EffectV2,
  EffectStatus,
  EnvironmentV2,
  InteractionV2,
  OrganizationV2,
  PolicyBundleV2,
  PrincipalV2,
  ProjectV2,
  RunV2,
  StepV2,
  ToolDefinitionV2,
  ToolRiskLevel,
  WorkGraphV2,
  WorkerV2,
} from './resources.js';

export {
  isTerminalRunState,
  isTerminalStepState,
  isValidRunTransition,
  isValidStepTransition,
  RUN_STATES,
  RUN_TRANSITIONS,
  STEP_STATES,
  STEP_TRANSITIONS,
  TERMINAL_RUN_STATES,
  TERMINAL_STEP_STATES,
} from './states.js';
export type { RunState, StepState } from './states.js';

export type { AggregateType, KernelEvent } from './events.js';

// --- WS2 Effect Envelope (unified external side-effect contract) ---
export {
  ACTION_KILL_SWITCH_SCOPES_V1,
  ACTION_STATES_V1,
  EFFECT_ACTION_NAMESPACES,
  EFFECT_ID_PATTERN,
  actionNamespace,
  isValidEffectEnvelopeIdentity,
} from './effects.js';
export type {
  ActionApprovalRequestV1,
  ActionCompensationApprovalRequestV1,
  ActionCompensationApprovalResponseV1,
  ActionCompensationAuthorizationV1,
  ActionCompensationAwaitingApprovalV1,
  ActionCompensationRequestAcceptedV1,
  ActionCompensationRequestResponseV1,
  ActionCompensationRequestV1,
  ActionDecisionV1,
  ActionEffectV1,
  ActionErrorDetailV1,
  ActionErrorV1,
  ActionEvidenceAuditEventV1,
  ActionEvidenceEffectV1,
  ActionEvidenceReceiptV1,
  ActionEvidenceSignatureV1,
  ActionEvidenceV1,
  ActionEvidenceVerificationV1,
  ActionKillSwitchListResponseV1,
  ActionKillSwitchResponseV1,
  ActionKillSwitchScopeV1,
  ActionKillSwitchUpdateV1,
  ActionKillSwitchV1,
  ActionProposeRequestV1,
  ActionProposeResponseV1,
  ActionReconcileAcceptedV1,
  ActionRejectionRequestV1,
  ActionResponseV1,
  ActionSimulationResponseV1,
  ActionSimulationV1,
  ActionStateV1,
  EffectActionNamespace,
  EffectEnvelope,
  EffectEnvelopeStatus,
  GovernedActionV1,
} from './effects.js';

export {
  isActionLearningRecordExportable,
  validateActionLearningRecordV1,
} from './actionLearning.js';
export type {
  ActionLearningApprovalOutcomeV1,
  ActionLearningConsentV1,
  ActionLearningDeletionStatusV1,
  ActionLearningPolicyOutcomeV1,
  ActionLearningReconciliationPathV1,
  ActionLearningRecordV1,
  ActionLearningRemoteOutcomeV1,
} from './actionLearning.js';

export { KERNEL_ERROR_CODES } from './errors.js';
export type { KernelErrorCode, KernelErrorDetails } from './errors.js';
export { isClassAEffectType } from './effectClassification.js';

export { validateRunTransition, validateStepTransition } from './transitions.js';
export type { TransitionResult } from './transitions.js';

// --- JSON Schema definitions ---
export {
  CONTRACT_SCHEMAS,
  actionApprovalRequestSchema,
  actionDecisionSchema,
  actionErrorSchema,
  actionEvidenceSchema,
  actionKillSwitchListResponseSchema,
  actionKillSwitchResponseSchema,
  actionKillSwitchSchema,
  actionKillSwitchUpdateSchema,
  actionProposeRequestSchema,
  actionProposeResponseSchema,
  actionReconcileAcceptedSchema,
  actionRejectionRequestSchema,
  actionResponseSchema,
  actionSimulationResponseSchema,
  actionSimulationSchema,
  governedActionSchema,
} from './schemas.js';
export type { ContractSchemaName } from './schemas.js';

// --- OpenAPI V1 specification ---
export { OPENAPI_V1_SPEC } from './openapi.js';
export type { OpenApiV1Spec } from './openapi.js';

// --- Compatibility & version checking ---
export {
  CONTRACT_VERSION,
  MIN_SUPPORTED_SCHEMA_VERSION,
  detectBreakingChanges,
  isCompatibleSchemaVersion,
  snapshotContracts,
  validateResource,
} from './compatibility.js';
export type { ContractSnapshot } from './compatibility.js';

// --- Constitution versioned envelopes + grant (L4 action gateway) ---
export {
  CONSTITUTION_CONTRACT_VERSIONS,
  RUN_CONTRACT_VERSION,
  EVENT_CONTRACT_VERSION,
  EFFECT_CONTRACT_VERSION,
  GRANT_CONTRACT_VERSION,
  ARTIFACT_CONTRACT_VERSION,
} from './versioned.js';
export type { VersionedContract, ConstitutionContractVersion } from './versioned.js';

export { GRANT_CONTRACT_VERSION as GRANT_VERSION, wrapGrantV1 } from './grant.js';
export type { GrantV1, GrantContractV1 } from './grant.js';

export { upcastLegacyGrantToV1, getLegacyGrantUpcastCount } from './upcasters/index.js';
export type { LegacyGrantPayload } from './upcasters/index.js';

export {
  commanderActionMarker,
  compensationIdempotencyKey,
  evaluateManifestGatewayEffect,
  findAdapterManifest,
  FIXED_ACTION_ADAPTER_MANIFESTS,
  githubPrBodyMarker,
  GITHUB_PULL_REQUEST_CREATE_DESCRIPTOR,
  KUBERNETES_DEPLOYMENT_ROLLBACK_DESCRIPTOR,
  servicenowCorrelationId,
  SERVICENOW_INCIDENT_CREATE_DESCRIPTOR,
} from './actionAdapters.js';
export type { ActionAdapterDescriptorV1, ActionGatewayEffect } from './actionAdapters.js';

export {
  ACTION_GATEWAY_POLICY_ID,
  actionGatewayPolicySnapshot,
  evaluateActionGatewayPolicy,
} from './actionGatewayPolicy.js';
export type {
  ActionGatewayPolicyDecision,
  ActionGatewayPolicyInput,
} from './actionGatewayPolicy.js';

// --- Shared identity, policy, audit, and plugin contracts ---
export { CONTROL_PLANE_API_VERSION, CONTROL_PLANE_RESOURCES } from './controlPlane.js';
export type {
  AuditEventV2,
  ControlPlaneResource,
  PluginSandboxMode,
  PolicyDecisionV2,
  PolicyEffect,
  WorkloadIdentity,
} from './controlPlane.js';
