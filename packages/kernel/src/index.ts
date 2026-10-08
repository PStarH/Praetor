/**
 * Commander Execution Kernel (Architecture V2).
 *
 * This package owns durable run and step lifecycle semantics. It intentionally
 * contains no provider, tool, HTTP, plugin, or CLI implementation. Those are
 * worker/control-plane concerns and must talk to the kernel through this
 * boundary.
 */

export {
  KERNEL_CLAIM_SQL,
  KERNEL_CLAIM_RECONCILE_SQL,
  KERNEL_CLAIM_SECRET_SQL,
  KERNEL_ADAPTER_OPS_SQL,
  KERNEL_RLS_SQL,
  KERNEL_ROLES_SQL,
  KERNEL_SCHEMA_SQL,
  KERNEL_SCHEMA_VERSION,
} from './schema.js';
export {
  KERNEL_MIGRATIONS,
  KERNEL_TASK1_BASELINE_MIGRATIONS,
  KERNEL_TASK1_CLOSURE_MIGRATIONS,
  KERNEL_TASK1_CLOSURE_MIGRATION_CHECKSUMS,
  KERNEL_TASK2_FORWARD_MIGRATION_CHECKSUMS,
  KERNEL_TASK2_FORWARD_MIGRATIONS,
  KERNEL_APPLIED_MIGRATION_DESCRIPTORS_SQL,
  KERNEL_SIGNED_EVIDENCE_MIGRATIONS,
  KERNEL_MEMORY_SCHEMA_MIGRATIONS,
  runKernelMigrations,
  runTask1ClosureMigrations,
} from './migrations.js';
export { KERNEL_SIGNED_EVIDENCE_SQL } from './evidenceSchema.js';
export { KERNEL_MEMORY_SCHEMA_SQL } from './memorySchema.js';
export { KERNEL_CAPABILITY_DURABLE_ACCESS_SQL } from './capabilityPersistence.js';
export {
  TASK1_DATABASE_ROLES,
  canonicalBootstrapJson,
  canonicalBootstrapSha256,
  createDatabasePeerBinding,
  createDatabasePeerBindingInput,
  createOriginBinding,
  createPrebootstrapSnapshots,
  verifyDatabasePeerBinding,
  verifyPersistedOriginBinding,
} from './canonicalBootstrap.js';
export type {
  BootstrapIdentitiesV1,
  BootstrapIdentityV1,
  DatabasePeerBindingInputRoleV1,
  DatabasePeerBindingInputV1,
  DatabasePeerBindingRoleV1,
  DatabasePeerBindingV1,
  OriginBindingV1,
  PrebootstrapInventoryV1,
  PrebootstrapSnapshotsV1,
  Task1DatabaseRole,
} from './canonicalBootstrap.js';
export {
  AUTHORITY_CLASSIFIER_MANIFEST_SHA256,
  AUTHORITY_CLASSIFIER_MANIFEST_V1,
  authorityClassifierManifestSha256,
  exportAuthorityClassifierManifest,
  verifyAuthorityClassifierCatalog,
  verifyAuthorityClassifierManifest,
} from './authorityClassifierManifest.js';
export {
  TASK1_CATALOG_QUERIES,
  classifyTask1CatalogOrigin,
  collectTask1PrebootstrapInventory,
  exportTask1CatalogPostcondition,
  verifyTask1CatalogPostcondition,
} from './task1Catalog.js';
export type {
  Task1CatalogBootstrapContext,
  Task1CatalogOriginKind,
  Task1CatalogPostconditionStage,
} from './task1Catalog.js';
export {
  KERNEL_TASK1_HELM_LIFECYCLE_GATE_SQL,
  PostgresTask1LifecycleOwnerTransactions,
  TASK1_LIFECYCLE_DESCRIPTOR_SQL,
  TASK1_LIFECYCLE_LOCK_STATE_SQL,
  Task1LifecycleLedger,
  createTask1OperationAuditNonce,
  verifyTask1FreshPendingRetry,
} from './task1LifecycleLedger.js';
export type {
  Task1FreshPendingRetry,
  Task1LifecycleLockedState,
  Task1LifecycleOperation,
  Task1LifecycleOwnerTransaction,
  Task1LifecycleOwnerTransactions,
  Task1LifecycleRequest,
  Task1LifecycleResult,
  Task1PlatformBinding,
} from './task1LifecycleLedger.js';
export { decideTenantCutoverOperation } from './tenantCutoverStateMachine.js';
export type {
  TenantCutoverCommand,
  TenantCutoverDecision,
  TenantCutoverOperationIdentity,
  TenantCutoverOperationKind,
  TenantCutoverPlatformKind,
  TenantCutoverRecordedExpand,
  TenantCutoverRequest,
  TenantCutoverRuntimePhase,
  TenantCutoverState,
} from './tenantCutoverStateMachine.js';
export {
  generateWorkerClaimSecret,
  hashWorkerClaimSecret,
  verifyWorkerClaimSecret,
} from './claimSecret.js';
export {
  seedTenantAuthorityAllowedTenants,
  seedWorkerClaimSecret,
  seedWorkerAllowedTenants,
} from './seedWorkerClaimSecret.js';
export type { ClaimSecretSeedClient } from './seedWorkerClaimSecret.js';
export { PostgresKernelRepository, PostgresTenantContextAuthority } from './postgres.js';
export { SqliteKernelRepository } from './sqlite.js';
export {
  buildVerifiedPostgresPoolConfig,
  createVerifiedPostgresPool,
  verifyPeerCertificateSpki,
} from './postgresRuntime.js';
export type { VerifiedPostgresPoolInput } from './postgresRuntime.js';
export {
  createKernelRepository,
  resolveKernelBackend,
  KernelBackendRefusedError,
  KernelBackendMissingError,
} from './repositoryFactory.js';
export type {
  KernelBackend,
  KernelRepositoryFactoryOptions,
  KernelRepositoryHandle,
} from './repositoryFactory.js';
export {
  SQLITE_KERNEL_SCHEMA_SQL,
  SQLITE_KERNEL_SCHEMA_VERSION,
  SQLITE_KERNEL_TABLES,
} from './sqliteSchema.js';
export { assertRunTransition, assertStepTransition } from './transitionValidation.js';
export { InMemoryOutboxDeliveryPort } from './ops/outbox/inMemoryOutboxDeliveryPort.js';
export { PostgresOutboxDeliveryPort } from './ops/outbox/postgresOutboxDeliveryPort.js';
export { KernelOutboxPublisher } from './ops/outbox/kernelOutboxPublisher.js';
export type { KernelOutboxPublishResult } from './ops/outbox/kernelOutboxPublisher.js';
export { OutboxPublisher } from './ops/outbox/compatibilityPublisher.js';
export type { EventPublisher } from './ops/outbox/compatibilityPublisher.js';
export { ReclaimDaemon } from './ops/reclaimDaemon.js';
export { consumeCompensationBatch, KERNEL_COMPENSATION_TOPIC } from './ops/compensationConsumer.js';
export type {
  CompensationConsumeResult,
  CompensationConsumerOptions,
  CompensationEffectBroker,
  CompensationOutboxPort,
  CompensationTokenProvider,
  CompensationTokenContext,
} from './ops/compensationConsumer.js';
export type { ReclaimDaemonConfig, ReclaimStats } from './ops/reclaimDaemon.js';
export { KernelOpsRuntime } from './ops/opsRuntime.js';
export type { KernelOpsRuntimeDependencies, OpsLoopHealth } from './ops/opsRuntime.js';
export { InteractionExpiryWorker, TimerWakeupWorker } from './ops/timerWakeupWorker.js';
export type { TimerWakeupWorkerConfig } from './ops/timerWakeupWorker.js';
export type {
  ClaimedOutboxDelivery,
  OutboxDeliveryError,
  OutboxDeliveryOptions,
  OutboxDeliveryPort,
  OutboxEnvelope,
} from './ops/outbox/types.js';
export type {
  PostgresKernelRepositoryOptions,
  SqlClient,
  SqlPool,
  SqlQueryResult,
} from './postgres.js';
export type { KernelRepository } from './repository.js';
export { InMemoryEvidenceRepository } from './evidenceRepository.js';
export type {
  AdapterOpsCompensationTerminalEvidenceAuthority,
  AdapterOpsCompensationTerminalEvidenceBinding,
  AdapterOpsEvidenceContext,
  AdapterOpsEvidenceContextAuthority,
  AdapterOpsEvidenceContextRequest,
  EvidenceRepository,
  KernelEvidenceRecord,
  KernelEvidenceSignature,
} from './evidenceRepository.js';
export { observeTask1DatabasePeers } from './task1DatabasePeer.js';
export type {
  Task1DatabasePeerObservation,
  Task1DatabasePeerObserverOptions,
} from './task1DatabasePeer.js';
export {
  KernelCapabilityReplayStore,
  KernelCapabilityRevocationStore,
  createDurableCapabilityReplayConsume,
} from './capabilityStores.js';
export type {
  CapabilityReplayRepository,
  CapabilityRevocationRepository,
} from './capabilityStores.js';
export {
  CAPABILITY_AUTHORITY_REQUIRED,
  CAPABILITY_AUDIENCE_ENV,
  CAPABILITY_ISSUER_ENV,
  CAPABILITY_JWKS_JSON_ENV,
  CAPABILITY_KEY_ID_ENV,
  CAPABILITY_PRIVATE_KEY_PEM_ENV,
  createCapabilityAuthority,
} from './capabilityAuthority.js';
export type {
  CapabilityAuthority,
  CapabilityAuthorityEnv,
  CreateCapabilityAuthorityOptions,
} from './capabilityAuthority.js';
export { KERNEL_API_VERSION, OPERATIONS_HEARTBEAT_TTL_MS, KernelInvariantError } from './types.js';
export {
  DEFAULT_RECONCILE_DEADLINE_MS,
  RECONCILE_CLAIM_TTL_MS,
  RECONCILE_INITIAL_DELAY_MS,
  RECONCILE_MAX_ATTEMPTS,
  RECONCILE_MAX_DELAY_MS,
  createReconcilePolicy,
  nextReconcileAfter,
  reconcileDeadlineWindowMs,
} from './reconcilePolicy.js';
export type {
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
  KernelErrorDetails,
  KernelEvent,
  KernelInteraction,
  KernelLease,
  KernelOutboxMessage,
  OperationsReadiness,
  KernelCompensationAdmissionBinding,
  KernelRun,
  KernelRunHandle,
  KernelRunState,
  KernelStep,
  KernelStepState,
  KernelTimer,
  MarkEffectCompletionUnknownRequest,
  NewKernelStep,
  ReconcileEffectRequest,
  RequestReconcileInput,
  RequestReconcileResult,
  ReconcileDisposition,
  ReconcileEscalationCode,
  ReconcilePolicy,
  ReconcileQueryError,
  ReconcileQueryErrorCode,
  ClaimReconcileEffectsInput,
  ClaimedReconcileEffect,
  RescheduleReconcileInput,
  EscalateReconcileInput,
  FailEffectRequest,
  RequestCompensationInput,
  RequestCompensationResult,
  CompensationAuthorizationRecord,
  KernelCompensationRequest,
  ClaimCompensationRequestInput,
  ClaimedCompensationRequest,
  CompensationDisposition,
  CompensationMutationResult,
  FinalizeCompensationInput,
  ParkCompensationUnknownInput,
  InteractionStatus,
  TimerState,
  TimerType,
  TenantExecutionControl,
  KillSwitch,
  KillSwitchMatchDims,
  KillSwitchScope,
  PutKillSwitchInput,
  RemoveKillSwitchInput,
} from './types.js';

// Object storage (interface only — implementations are in testing/)
export type { ObjectStorage, ObjectStorageRef } from './testing/objectStorage.js';
// InMemoryKernelRepository: import from `@praetor/kernel/testing/inMemoryRepository`
// — not re-exported from the main barrel (tests/harnesses only).
