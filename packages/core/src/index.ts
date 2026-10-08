/**
 * Commander — Public API Surface
 *
 * Re-exports all public types, interfaces, and classes.
 */

// ============================================================================
// DEPRECATION INDEX (2026-07-07)
//
// Remaining deprecated items that still have active callers and are kept
// for backward compatibility. Cleaned items have been removed from this
// index. Search for `@deprecated` to find the inline marker + full context.
//
// | Item                                         | Migration target                          | Status |
// |----------------------------------------------|-------------------------------------------|--------|
// | lsp/lspClient.ts:457 (sendNotification)      | sendRequest()                             | keep   |
// | pluginTypes.ts:296 (hookManager field)       | PluginLoader + sandbox context            | keep   |
// | logging.ts:421 (legacy adapter)              | Logger factory in @praetor/core/logging | keep   |
// | ultimate/types.ts:52,63 (topology aliases)   | D3.2 canonical topology names             | keep   |
// ============================================================================
export * from './models';
export { reportSilentFailure } from './silentFailureReporter';
export { optionalImport, optionalRequire } from './optionalImport';

// Orchestration exports
export { SequentialPipelineBuilder, calculateOrchestrationMetrics } from './orchestration';
export type {
  SequentialStep,
  SequentialContext,
  SequentialStepResult,
  SequentialPipelineStatus,
  SequentialPipeline,
  SequentialPipelineRun,
  SequentialEvent,
  SequentialEventHandler,
  OrchestrationMetrics,
  TokenUsage,
} from './orchestration';

// Memory exports
export {
  createMemoryStore,
  resolveMemoryStoreType,
  fromProjectMemoryItem,
  toProjectMemoryItem,
} from './episodicMemory';
export type {
  MemoryPriority,
  EpisodicMemoryItem,
  MemorySearchQuery,
  MemorySearchResult,
  MemoryWriteOptions,
  MemoryManageOptions,
  MemoryStats,
  MemoryStore,
} from './episodicMemory';
export type {
  ProjectMemoryItem,
  ProjectMemoryOverview,
  ProjectMemorySearchOptions,
} from './memory/apiTypes';
export {
  MemoryServiceValidationError,
  assertForgetTarget,
  assertLimit,
  assertMemoryScope,
} from './memory/memoryService';
export type {
  ForgetMemoryInput,
  ListMemoryInput,
  MemoryPage,
  MemoryRecord,
  MemoryRetentionPolicy,
  MemoryScope,
  MemorySearchResult as MemoryServiceSearchResult,
  MemoryService,
  MemoryServiceMaintenance,
  RetrieveMemoryInput,
  SearchMemoryInput,
  StoreMemoryInput,
} from './memory/memoryService';
export { InMemoryMemoryService } from './memory/inMemoryMemoryService';
export { PostgresMemoryService } from './memory/postgresMemoryService';
export { MemoryStoreFacade } from './memory/memoryStoreFacade';
export { writeProductMemory } from './memory/writeProductMemory';
export { MemoryMigrationRunner } from './memory/memoryMigration';
export { assertNamespaced, assertNamespacedStoreInput } from './memory/namespaceGuard';
export type { MemoryNamespaceAcl } from './memory/namespaceGuard';
export type {
  LegacyMemoryRecord,
  MemoryMigrationCheckpointStore,
  MemoryMigrationResult,
  MemoryMigrationSource,
  TenantMapping,
} from './memory/memoryMigration';

// Ultimate Framework exports (legacy)
export type {
  OrchestrationMode,
  OrchestrationDecision,
  TokenBudgetAllocation,
  ModelTierConfig,
  AllocatedBudget,
  QualityGate,
  QualityGateResult,
} from './ultimateFramework';
export { DEFAULT_MODEL_CONFIG, QualityGateExecutor } from './ultimateFramework';
export {
  CompensationQueue,
  getCompensationQueue,
  resetCompensationQueueForTesting,
  defaultCompensationQueuePath,
} from './atr/compensationQueue';
export type { CompensationQueueItem, CompensationQueueConfig } from './atr/compensationQueue';

// Ultimate Multi-Agent Orchestration System (v2)
export {
  UltimateOrchestrator,
  deliberate,
  RecursiveAtomizer,
  TopologyRouter,
  SubAgentExecutor,
  MultiAgentSynthesizer,
  ArtifactSystem,
  getArtifactSystem,
  resetArtifactSystem,
  AgentTeamManager,
  getTeamManager,
  WorkCoordinator,
  getWorkCoordinator,
  resetWorkCoordinator,
  getEffortRules,
  classifyEffortLevel,
  selectTopologyForEffort,
} from './ultimate/index';

export type {
  OrchestrationTopology,
  TaskDAG,
  TaskDAGNode,
  TaskDAGEdge,
  DeliberationPlan,
  TaskTreeNode,
  ArtifactReference,
  AgentTeam,
  TeamMember,
  SharedTask,
  InboxMessage,
  CapabilityVector,
  AgentCapability,
  EffortLevel,
  EffortScalingRules,
  ThinkingBudget,
  SynthesisStrategy,
  SynthesisConfig,
  QualityGateConfig,
  UltimateExecutionContext,
  UltimateExecutionResult,
  UltimateMetrics,
  ExecutionError,
  UltimateOrchestratorConfig,
  WorkItem,
  WorkStatus,
  WorkEvent,
  WorkEventHandler,
  EnqueueInput,
  ClaimFilter,
  TeamStatus,
} from './ultimate/index';

export {
  DEFAULT_THINKING_BUDGET,
  DEFAULT_SYNTHESIS_CONFIG,
  DEFAULT_ULTIMATE_CONFIG,
} from './ultimate/index';

// Tools — Web Search, File System, Code Execution
export {
  WebSearchTool,
  WebFetchTool,
  FileReadTool,
  FileWriteTool,
  FileEditTool,
  FileSearchTool,
  FileListTool,
  FileHashEditTool,
  PythonExecuteTool,
  ShellExecuteTool,
  createAllTools,
  MetaTool,
  getBuiltinMetaSpecs,
  findMatchingMetaSpec,
  ToolRegistry,
  TOOL_CATEGORIES,
} from './tools/index';
export type { MetaToolSpec, MetaToolStep, AgentDef } from './tools/index';

// Agent Loop — Persistent multi-agent execution
export { CommanderAgentLoop } from './agentLoop';
export type { AgentLoopConfig } from './agentLoop';

// Goal module — multi-agent goal-driven execution loop
export { GoalOrchestrator } from './goal/goalOrchestrator';
export type {
  GoalNode,
  GoalConfig,
  GoalResult,
  RoundLedger,
  RoundDecision,
  ManagerDecomposition,
  ManagerReview,
  CriticOutput,
  CritiqueResult,
  CritiqueFinding,
  CritiqueCategory,
} from './goal/types';

// ContentScanner exports - Agent Security Layer
export {
  DefaultContentScanner,
  createContentScanner,
  scanContent,
  scanToolOutputForInjection,
} from './contentScanner';
export type { ContentScanner } from './contentScanner';

// UniversalSanitizer & ResourceGovernor — unified sanitization and outbound-call governance
export { UniversalSanitizer, ResourceGovernor, IntegrityLayer } from './security';
export type { SignedEntry } from './security';

// IM Provider SPI
export type {
  IMProvider,
  IMMessage,
  IMReply,
  IMIncomingRequest,
  IMOutboundCredentials,
  IMThreadContext,
  IMContextStore,
  IMOutboundDispatcher,
} from './im';
export {
  IMProviderRegistry,
  getIMProviderRegistry,
  resetIMProviderRegistry,
  InMemoryIMContextStore,
  getIMContextStore,
  resetIMContextStore,
  DefaultIMOutboundDispatcher,
  getIMOutboundDispatcher,
  resetIMOutboundDispatcher,
} from './im';

// Configuration Validation
export {
  createSchema,
  validateConfig,
  mergeWithDefaults,
  validateRuntimeConfig,
  validateHttpServerConfig,
  validateField,
} from './runtime/configValidator';
export type {
  FieldType,
  ConfigField,
  ConfigSchema,
  ConfigValidationResult,
  ConfigValidationError,
} from './runtime/configValidator';

// Authentication & Authorization
export {
  AuthManager,
  getAuthManager,
  resetAuthManager,
  ROLE_HIERARCHY,
} from './runtime/authManager';
export type { AuthRole, AuthUser, ApiKeyEntry } from './runtime/authManager';
export { OIDCAuthPlugin, createOIDCPluginFromEnv } from './runtime/oidcAuthPlugin';
export type {
  OIDCPluginConfig,
  AuthPlugin,
  AuthPluginResult,
  JWKWithKid,
} from './runtime/oidcAuthPlugin';

// Webhook Dispatcher
export {
  WebhookDispatcher,
  getWebhookDispatcher,
  resetWebhookDispatcher,
} from './runtime/webhookDispatcher';
export type { WebhookConfig, WebhookEvent, WebhookDelivery } from './runtime/webhookDispatcher';

// Runtime Types
export type {
  AgentExecutionContext,
  AgentExecutionResult,
  AgentExecutionStep,
  AgentRuntimeConfig,
  RetryConfig,
} from './runtime/types/execution';
export type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMMessage,
  LLMStreamChunk,
  ReasoningConfig,
} from './runtime/types/llm';
export type { ModelTier } from './runtime/types/shared';
export type { MessageBusTopic, BusMessage } from './runtime/types/messageBus';

// ThreeLayerMemory
export {
  ThreeLayerMemory,
  getGlobalThreeLayerMemory,
  resetGlobalThreeLayerMemory,
  createThreeLayerMemory,
} from './threeLayerMemory';

// Logging & Metrics
export { Logger, getGlobalLogger, getGlobalMetrics } from './logging';

// Error Handler
export {
  ErrorHandler,
  CommanderError,
  TaskComplexityError,
  OrchestrationError,
  BudgetExhaustedError,
  MemoryError,
  ConsensusError,
  InspectionError,
} from './errorHandler';

// Shell & Runner exports
export {
  resetSandboxManager,
  getSandboxManager,
  SandboxManager,
  SandboxInitializationError,
  ExecPolicyEngine,
  TEESandbox,
} from './sandbox';
export {
  SandboxPolicyError,
  assertProductionSandboxPolicy,
  assertProductionSandboxReady,
  assertProductionSandboxSource,
  resolveSandboxPolicy,
} from './sandbox';
export {
  buildWorkloadDockerOptions,
  createSandboxWorkloadContext,
  validateSandboxWorkloadContext,
  workloadContainerName,
} from './sandbox';
export type {
  SandboxMode,
  SandboxProfile,
  SandboxMechanism,
  NetworkPolicy,
  FileAccessPolicy,
  SandboxExecutionResult,
  SandboxWorkloadContext,
  SandboxEnvironment,
  SandboxIsolation,
  SandboxPolicy,
  PlatformSandbox,
  TEEBackend,
  TEEAttestation,
  TEESandboxResult,
} from './sandbox';

// Credential Manager
export {
  CredentialManager,
  getCredentialManager,
  resetCredentialManager,
} from './runtime/credentialManager';

// Hallucination Detector
export { HallucinationDetector, getHallucinationDetector } from './hallucinationDetector';

export type { HallucinationSignal, HallucinationReport } from './hallucinationDetector';

// Security Subsystem
export {
  SecurityMonitor,
  getSecurityMonitor,
  resetSecurityMonitor,
} from './security/securityMonitor';
export { GuardianAgent, getGuardianAgent, resetGuardianAgent } from './security/guardianAgent';
export {
  SecurityAuditLogger,
  getSecurityAuditLogger,
  resetSecurityAuditLogger,
} from './security/securityAuditLogger';
export {
  ZeroTrustValidator,
  getZeroTrustValidator,
  zeroTrustMiddleware,
} from './security/zeroTrustValidator';
export type {
  ZeroTrustValidationResult,
  ZeroTrustRejectReason,
  SigningKeyEntry,
  ZeroTrustConfig,
  SignRequestParams,
  GeneratedSignature,
} from './security/zeroTrustValidator';

// CapabilityToken — short-lived HMAC-signed authorization tokens
export {
  CapabilityTokenIssuer,
  CapabilityTokenVerifier,
  CapabilityTokenError,
  getCapabilityTokenIssuer,
  resetCapabilityTokenState,
} from './security/capabilityToken';
export type {
  CapabilityScope,
  CapabilityPayload,
  VerifyResult,
  RiskLevel,
} from './security/capabilityToken';

// AuditChainLedger — tamper-evident hash-chained audit log
export {
  AuditChainLedger,
  getAuditChainLedger,
  resetAuditChainLedger,
} from './security/auditChainLedger';

// WS9 audit-chain integrity (manifest + verify timer; opt-in via COMMANDER_AUDIT_MANIFEST_DIR)
export {
  installAuditChainIntegrity,
  resetAuditChainIntegrity,
  ChainManifest,
  FailClosedPersistor,
  verifyWithManifest,
} from './security/auditChainIntegrity';

// OutboundNetworkPolicy — egress firewall + SSRF defense (install once at process boot)
export {
  installOutboundNetworkPolicy,
  uninstallOutboundNetworkPolicy,
  resetOutboundNetworkPolicy,
  getOutboundNetworkPolicy,
} from './security/outboundNetworkPolicy';

// AgentLineage — immutable parent→child agent relationship tracking
export { AgentLineage, getAgentLineage, resetAgentLineage } from './security/agentLineage';
export type { LineageNode, LineageSummary, LineageQuery } from './security/agentLineage';

// SupplyChainScanner — skill/tool pre-load security scanning
export { SupplyChainScanner, getSupplyChainScanner } from './security/supplyChainScanner';
export type { SupplyChainScanRequest, SupplyChainScanResult } from './security/supplyChainScanner';

// RedTeamFramework — automated adversarial security testing
export {
  RedTeamFramework,
  getRedTeamFramework,
  createContentScannerDefender,
  createComprehensiveDefender,
  generateSecurityReport,
  generateSecurityReportJson,
  ATTACK_SCENARIOS,
} from './security/redTeamFramework';
export type {
  RedTeamTestScenario,
  RedTeamTestResult,
  RedTeamRunReport,
} from './security/redTeamFramework';

// OutputSanitizer — data exfiltration prevention at the output boundary
export {
  OutputSanitizer,
  getOutputSanitizer,
  resetOutputSanitizer,
  sanitizeOutput,
  sanitizeIfNeeded,
} from './security/outputSanitizer';
export type {
  SensitivityCategory,
  RedactionStrategy,
  RedactionRule,
  RedactionRecord,
  SanitizeResult,
  OutputSanitizerConfig,
} from './security/outputSanitizer';

// UnifiedCostAuthority — single source of truth for cost enforcement
export {
  UnifiedCostAuthority,
  getUnifiedCostAuthority,
  resetUnifiedCostAuthority,
} from './security/unifiedCostAuthority';
export type {
  UCACallContext,
  UCADecision,
  UCAPostCallResult,
  BudgetSnapshot,
  BudgetCap,
  CostLedgerEntry,
  ToolCostProfile,
} from './security/unifiedCostAuthority';

// AgentSOC — P0-P4 incident classification, playbook engine, escalation paths, SOC dashboard
export { AgentSoc, getAgentSoc, resetAgentSoc } from './security/agentSoc';
export type {
  IncidentPriority,
  IncidentStatus,
  EscalationLevel,
  PlaybookTrigger,
  Incident,
  Playbook,
  PostmortemReport,
  SocHealth,
  AgentSocConfig,
} from './security/agentSoc';

// EuAiActCompliance — EU AI Act Article 12/13/14 self-assessment reporting
export {
  EuAiActComplianceReporter,
  getEuAiActComplianceReporter,
  resetEuAiActComplianceReporter,
} from './security/euAiActCompliance';
export type {
  EuAiActReport,
  Article12Report,
  Article13Report,
  Article14Report,
  ComplianceSummary,
  ComplianceReportOptions,
} from './security/euAiActCompliance';

// AgentStandbyManager — hot standby agent architecture with auto-failover
export { AgentStandbyManager, getAgentStandbyManager } from './security/agentStandbyManager';
export type {
  AgentTier,
  AgentInstance,
  SwitchTrigger,
  SwitchEvent,
  StandbyConfig,
  StandbyHealth,
} from './security/agentStandbyManager';

// RedTeamBaseline — regression detection for configured red-team CI/CD
export { RedTeamBaselineManager, getRedTeamBaseline } from './security/redTeamBaseline';
export type {
  RegressionSeverity,
  RegressionResult,
  ImprovementResult,
  BaselineComparison,
} from './security/redTeamBaseline';

// EdgeSecurityProfile — unified edge/offline mode
export { EdgeSecurityProfile, getEdgeSecurityProfile } from './security/edgeSecurityProfile';
export type {
  EdgeMode,
  EdgeDetectionResult,
  EdgeSecurityConfig,
  EdgeSecurityStatus,
} from './security/edgeSecurityProfile';

// ComplianceAuditManager — ISO 42001/NIST AI RMF audit preparation
export {
  ComplianceAuditManager,
  getComplianceAuditManager,
} from './security/complianceAuditReport';
export type {
  ComplianceControl,
  DimensionScore,
  SecurityPosture,
  PostureSnapshot,
  ComplianceAuditReport,
  TrendAnalysis,
} from './security/complianceAuditReport';

// ThreatIntelligenceFeed — dynamic threat feed with TLP and SupplyChainScanner integration
export {
  ThreatIntelligenceFeed,
  getThreatIntelligenceFeed,
  resetThreatIntelligenceFeed,
} from './security/threatIntelligenceFeed';
export type {
  TlpLevel,
  ThreatSignature,
  ThreatFeedSource,
  ThreatFeedHealth,
  ThreatFeedConfig,
} from './security/threatIntelligenceFeed';

// CrossAgentCorrelator — multi-agent attack chain detection
export {
  CrossAgentCorrelator,
  getCrossAgentCorrelator,
  resetCrossAgentCorrelator,
} from './security/crossAgentCorrelator';
export type {
  CorrelationRuleType,
  CrossAgentEvent,
  CorrelationMatch,
  CorrelationRule,
  CorrelatorConfig,
} from './security/crossAgentCorrelator';

// MLInjectionDetector — embedding-based semantic injection detection
export {
  MLInjectionDetector,
  getMLInjectionDetector,
  resetMLInjectionDetector,
} from './security/mlInjectionDetector';
export type {
  InjectionVector,
  DetectionResult,
  MLDetectorConfig,
} from './security/mlInjectionDetector';

// FuzzTestFramework — mutation-based tool input fuzzer with coverage-guided feedback
export {
  FuzzTestFramework,
  getFuzzTestFramework,
  resetFuzzTestFramework,
} from './security/fuzzTestFramework';
export type {
  FuzzInput,
  FuzzResult,
  FuzzRunReport,
  FuzzerConfig,
} from './security/fuzzTestFramework';

// CrossTenantFuzzTest — mutation-based tenant isolation fuzzer
export {
  CrossTenantFuzzTest,
  createInMemoryCrossTenantTarget,
  getCrossTenantFuzzTest,
  resetCrossTenantFuzzTest,
} from './security/crossTenantFuzz';
export type {
  CrossTenantAttackVector,
  CrossTenantFuzzConfig,
  CrossTenantTarget,
  CrossTenantFuzzCase,
  CrossTenantLeak,
  CrossTenantFuzzResult,
  CrossTenantFuzzReport,
} from './security/crossTenantFuzz';

// DataLeakageVerifier — deterministic cross-tenant data leakage validation
export {
  DataLeakageVerifier,
  createInMemoryLeakageTarget,
  getDataLeakageVerifier,
  resetDataLeakageVerifier,
} from './security/dataLeakageVerifier';
export type {
  LeakageVector,
  DataLeakageConfig,
  DataLeakageTarget,
  LeakageTestCase,
  DataLeak,
  DataLeakageReport,
} from './security/dataLeakageVerifier';

// PostQuantumCrypto — PQ-safe hash (SHAKE-256), key generation, MAC creation/verification
export {
  PostQuantumCrypto,
  getPostQuantumCrypto,
  resetPostQuantumCrypto,
  pqHash,
  pqVerifyMac,
} from './security/postQuantumCrypto';
export type { PqKeyPair, PqMac, PqHashResult, PqCryptoConfig } from './security/postQuantumCrypto';

// MultimodalContentScanner — voice/video/image threat scanning
export {
  MultimodalContentScanner,
  getMultimodalContentScanner,
  resetMultimodalContentScanner,
} from './security/multimodalContentScanner';
export type {
  MultimodalThreat,
  MultimodalScanResult,
  MultimodalScannerConfig,
} from './security/multimodalContentScanner';

// SandboxVerifier — formal sandbox verification harness
export {
  SandboxVerifier,
  getSandboxVerifier,
  resetSandboxVerifier,
} from './security/sandboxVerifier';
export type { SandboxVerificationReport } from './security/sandboxVerifier';

// VoiceContentScanner — enhanced audio/voice threat scanning
export {
  VoiceContentScanner,
  getVoiceContentScanner,
  resetVoiceContentScanner,
} from './security/voiceContentScanner';
export type { VoiceThreat, VoiceScanResult } from './security/voiceContentScanner';

// FederatedIdentity — cross-org trust delegation with HMAC+OIDC JWT dual signing (Phase 3)
export {
  FederatedIdentity,
  getFederatedIdentity,
  resetFederatedIdentity,
} from './security/federatedIdentity';
export type {
  FederationTrust,
  FederatedExchangeResult,
  FederatedExchangeOutcome,
} from './security/federatedIdentity';

// MitreAtlasMapper — MITRE ATLAS tactics/techniques mapping
export {
  MitreAtlasMapper,
  getMitreAtlasMapper,
  resetMitreAtlasMapper,
} from './security/mitreAtlasMapper';
export type {
  AtlasTactic,
  AtlasTechnique,
  AtlasHeatmapCell,
  AtlasMapping,
  MitreAtlasReport,
} from './security/mitreAtlasMapper';

// AdaptiveHITL — risk-adaptive human-in-the-loop strategy engine
export {
  AdaptiveHITL,
  getAdaptiveHitl,
  resetAdaptiveHitl,
  maxStrategy,
} from './security/adaptiveHitl';
export type {
  HITLStrategy,
  ToolRiskSignal,
  AgentConfidenceSignal,
  MissionSignal,
  HITLSignalBundle,
  HITLFactor,
  HITLDecision,
  AgentBehaviorProfile,
  AdaptiveHITLConfig,
} from './security/adaptiveHitl';

// SecurityBenchmarkRunner — automated CI/CD security benchmark scoring
export {
  SecurityBenchmarkRunner,
  getSecurityBenchmarkRunner,
  ALL_BENCHMARK_CASES,
  getCasesForBenchmark,
} from './security/securityBenchmarkRunner';
export type {
  BenchmarkId,
  BenchmarkTestCase,
  BenchmarkTestResult,
  BenchmarkRunReport,
  BenchmarkTrend,
  BenchmarkRunnerConfig,
  DefenderFn,
} from './security/securityBenchmarkRunner';

// SupplyChainAttestor — SPDX 2.3 SBOM + Sigstore keyless attestation
export {
  SupplyChainAttestor,
  getSupplyChainAttestor,
  resetSupplyChainAttestor,
  componentToPurl,
  hashFile,
  hashString,
} from './security/supplyChainAttestor';
export type {
  SpdxDocument,
  AttestationBundle,
  AttestationResult,
  VerificationResult,
  ComponentEntry,
  AttestorConfig,
} from './security/supplyChainAttestor';

// DifferentialPrivacyLayer — ε-DP Laplace/Gaussian mechanisms for cross-agent memory sharing
export {
  DifferentialPrivacyLayer,
  getDifferentialPrivacyLayer,
  resetDifferentialPrivacyLayer,
  sampleLaplace,
  sampleGaussian,
  laplaceMechanism,
  gaussianMechanism,
  analyzeSensitivity,
  classifyEpsilon,
} from './security/differentialPrivacyLayer';
export type {
  DPPrivacyLevel,
  DPQueryType,
  DPSensitivity,
  DPDataBounds,
  PrivacyBudget,
  DifferentialPrivacyConfig,
  DPQueryResult,
  DPQueryRejection,
  DPQueryOutcome,
} from './security/differentialPrivacyLayer';

// Cost Estimation
export { CostEstimator, getCostEstimator, resetCostEstimator } from './runtime/costEstimator';
export type { CostEstimatorConfig } from './runtime/costEstimator';

// Anomaly Detection
export { getAnomalyDetector } from './observability/anomalyDetector';

// SLO Management
export { SLOManager, getSLOManager } from './observability/sloManager';

// Decision Provenance
export { buildDecisions, decisionsSummary } from './observability/decisionProvenance';

// Execution Provenance
export { captureProvenance } from './runtime/provenance';

// Metrics (from metricsCollector, not the logging re-export)
export {
  getMetricsCollector,
  resetMetricsCollector,
  MetricsCollector,
} from './runtime/metricsCollector';

// Health checks (shared HealthCollector so the API layer does not dual-track)
// buildHealthSources() wires HealthSources to the global runtime singletons
// (message bus + dead-letter queue) so /health/detailed reports real status
// instead of the previous fake "not wired" stub. Exposed so surfaces like
// apps/api can construct a wired HealthCollector without re-implementing the
// per-getter error-fallback plumbing each time.
export { HealthCollector, buildHealthSources } from './runtime/healthCheck';
export type { HealthSources, HealthCheckResult, DLQCategoryCount } from './runtime/healthCheck';

// Evaluation — LLM-as-Judge, dataset versioning, A/B experiment comparison
// Now delivered via the builtin-eval plugin (plugins/builtin/eval).
export * from './plugins/builtin/eval';
export {
  createEvalPlugin,
  getSharedJudgeEngine,
  getSharedDatasetManager,
  getSharedABComparator,
} from './plugins/builtin/evalPlugin';

// Tenant Provider — multi-tenant isolation primitives
export {
  NullTenantProvider,
  SimpleTenantProvider,
  ThreeLayerMemoryRegistry,
  getGlobalTenantProvider,
  setGlobalTenantProvider,
  resetGlobalTenantProvider,
  getGlobalMemoryRegistry,
  resetGlobalMemoryRegistry,
} from './runtime/tenantProvider';
export type { TenantProvider } from './runtime/tenantProvider';

// Cost Model — token-based price calculation (single source of truth in core)
export {
  CostModel,
  getCostModel,
  resetCostModel,
  DEFAULT_PRICING,
} from './observability/costModel';
export type { CostBreakdown, TokenBreakdown, ModelPricing } from './observability/types';

// Observability HTTP API — unified handler for trace/cost/decision endpoints
export { handleObservabilityRequest, OBSERVABILITY_HTTP_ROUTES } from './observability/httpApi';
export type { ObservabilityDeps, ObservabilityResult } from './observability/httpApi';

// Runtime System — Agent Execution Engine
// The './runtime' barrel above already re-exports the common runtime types.
// Only CacheConfig/CacheUsage are kept from the concrete './runtime/types'
// file because they are not currently exported through the barrel.
export type { CacheConfig, CacheUsage } from './runtime/types';
export {
  ModelRouter,
  getModelRouter,
  resetModelRouter,
  MessageBus,
  getMessageBus,
  resetMessageBus,
  ExecutionTraceRecorder,
  getTraceRecorder,
  resetTraceRecorder,
  AgentRuntime,
  createAgentRuntimeFactory,
  OpenAIProvider,
  AnthropicProvider,
  GoogleProvider,
  OpenRouterProvider,
  DeepSeekProvider,
  GLMProvider,
  MiMoProvider,
  XiaomiProvider,
  OllamaProvider,
  VLLMProvider,
  CohereProvider,
  MistralProvider,
  GroqProvider,
  TogetherProvider,
  PerplexityProvider,
  FireworksProvider,
  ReplicateProvider,
  BedrockProvider,
  XAIProvider,
  AnyscaleProvider,
  DeepInfraProvider,
  AgnesProvider,
  MCPRemoteRuntime,
  SSEStream,
  selectTools,
  getToolRelevanceScores,
  getToolCategory,
  isConfidentResponse,
  hasInformationGain,
  PatternTracker,
  getPatternTracker,
  resetPatternTracker,
  planSpeculativeExecution,
  isSpeculativelySafe,
  // SOP generation & dashboard
  exportSOPFromTrace,
  exportSOPFromResult,
  formatSOPAsMarkdown,
  formatSOPAsContext,
  listSOPs,
  getSOP,
  getSOPMarkdown,
  getSOPDashboardData,
  renderSOPDashboardHtml,
  // OpenTelemetry Exporter
  OpenTelemetryExporter,
  getOTelExporter,
  resetOTelExporter,
  // Structured output & context window
  parseStructuredOutput,
  validateStructuredOutput,
  validateShape,
  ContextWindowManager,
  estimateTotalTokens,
  // Trace store
  PersistentTraceStore,
  // HTTP server & channel adapter
  CommanderHttpServer,
  createHttpServer,
  BaseChannelAdapter,
  // Unified verification & task analysis
  UnifiedVerificationPipeline,
  detectTaskType,
  classifyProvisionIntent,
  // Token governor
  TokenGovernor,
  getTokenGovernor,
  resetTokenGovernor,
  // Tool calling infrastructure
  ToolResultCache,
  ToolOutputManager,
  ToolOrchestrator,
  toolErrorRow,
  ToolAvailabilityManager,
  evaluate,
  allOf,
  anyOf,
  not,
  always,
  never,
  earlySteps,
  budgetRelaxed,
  budgetNotCritical,
  notYetUsed,
  requiresTool,
  maxErrors,
  createDefaultRules,
  ToolPlanner,
  // Reliability & privacy
  ReliabilityEngine,
  PrivacyRouter,
  getPrivacyRouter,
  resetPrivacyRouter,
} from './runtime';
export type {
  AgentRuntimeInterface,
  AgentRuntimeFactory,
  AgentRuntimeFactoryOptions,
} from './runtime';
export { KernelStepExecutor } from './runtime/kernelStepExecutor';
export type {
  EmbeddingFunction,
  ToolRetrievalConfig,
  EntropyGatingConfig,
  SpeculativeExecutionConfig,
  // SOP types
  SOPListItem,
  SOPDashboardData,
  SOPTemplate,
  SOPPhase,
  SOPDecision,
  SOPToolCall,
  SOPFileAccess,
  // OpenTelemetry
  OTelExporterConfig,
  OTelSpan,
  // Token governor
  OptimizationStrategy,
  BudgetState,
  GovernorDecision,
  GovernorConfig,
  TaskCategory,
  // Context window
  ContextWindowConfig,
  WindowAction,
  // Trace store
  TraceStore,
  // Tool calling infrastructure
  OrchestratorConfig,
  OrchestratedResult,
  ToolExecutionPlan,
  ToolExecutionContext,
  SyntheticErrorRow,
  PreToolCallGateResult,
  AvailabilityContext,
  AvailabilityExpression,
  ToolAvailabilityRule,
  ExecutionPlan,
  ExecutionStage,
  DependencyEdge,
  ResourceConflict,
  // Reliability & privacy
  ReliabilityEngineConfig,
  ReliabilityStats,
  PrivacyRouterConfig,
  PrivacyDecision,
  PrivacyRoute,
  SensitivityMatch,
  SensitivityCategory as PrivacySensitivityCategory,
  // Channel adapter
  ChannelAdapter,
  ChannelConfig,
  ChannelMessage,
  ChannelStatus,
  ChannelAttachment,
  SendOptions,
  MessageRole,
} from './runtime';

// HTML Reporting — now delivered via the builtin-reporting plugin.
// Public API preserved for backwards compatibility. HTMLReport/HTMLReportSection
// types remain exported from ./runtime/types (see above).
export {
  HTMLReportRenderer,
  getHTMLReportRenderer,
  createWarRoomHTMLReport,
} from './plugins/builtin/reporting';
export { createReportingPlugin } from './plugins/builtin/reportingPlugin';

// Self-Evolution Engine — Meta-learning & optimization
export {
  MetaLearner,
  getMetaLearner,
  resetMetaLearner,
  DEFAULT_META_LEARNER_CONFIG,
} from './selfEvolution/metaLearner';
export { TrajectoryAnalyzer } from './selfEvolution/trajectoryAnalyzer';
export { EvolverAgent, getEvolverAgent, resetEvolverAgent } from './selfEvolution/evolverAgent';
export type { EvolverMutation, EvolutionCycle } from './selfEvolution/evolverAgent';
export {
  ReflectionEngine,
  createReflectionEngine,
  getGlobalReflectionEngine,
} from './reflectionEngine';
export { ConsensusChecker, createConsensusChecker } from './consensusCheck';

// Consensus & Fault Tolerance Module (Commander-BFT-C3)
// Now delivered via the builtin-consensus plugin. Public API preserved for
// backwards compatibility.
export {
  // Adaptive stopping (Beta-Binomial + KS test)
  AdaptiveStoppingController,
  BetaBinomialTracker,
  ksTest,
  answersToNumeric,
  // BPD detector (graph backward propagation)
  BPDDetector,
  getBPDDetector,
  resetBPDDetector,
  // Topology state machine (4-state dynamic switching)
  TopologyStateMachine,
  getTopologyStateMachine,
  resetTopologyStateMachine,
  // SAC protocol (receiver-side consensus)
  SACProtocol,
  getSACProtocol,
  resetSACProtocol,
  // CourtEval (adversarial court evaluation)
  CourtEvalEngine,
} from './plugins/builtin/consensus';
export type {
  DebateRound,
  AdaptiveStoppingResult,
  AdaptiveStoppingConfig,
  AgentNode as ConsensusAgentNode,
  CommunicationEdge,
  RejectionSignal,
  AgentAnomalyReport,
  BPDConfig,
  TopologyState,
  TopologyStateConfig,
  StateTransitionEvent,
  TopologyStateSnapshot,
  SACProposal,
  SACEvaluation,
  SACConsensusResult,
  SACConfig,
  CourtRole,
  CourtParticipant,
  GraderScores,
  CriticAttack,
  DefenseResponse,
  CourtVerdict,
  CourtEvalConfig,
} from './plugins/builtin/consensus';
export {
  createConsensusPlugin,
  getSharedAdaptiveStopping,
  getSharedCourtEval,
} from './plugins/builtin/consensusPlugin';

// Incremental SCC Detector (deadlock prevention)
export {
  IncrementalSCCDetector,
  getIncrementalSCCDetector,
  resetIncrementalSCCDetector,
} from './runtime/incrementalSCC';
export type {
  SCCNode,
  SCCEdge,
  SCCComponent,
  DeadlockAlert,
  IncrementalSCCConfig,
} from './runtime/incrementalSCC';

// Hierarchical Timeout Manager
export {
  HierarchicalTimeoutManager,
  getHierarchicalTimeoutManager,
  resetHierarchicalTimeoutManager,
} from './runtime/hierarchicalTimeout';
export type {
  TimeoutLevel,
  TimeoutAction,
  TimeoutConfig,
  TimeoutEvent,
  ActiveTimeout,
  HierarchicalTimeoutConfig,
} from './runtime/hierarchicalTimeout';

// Supervision Tree (OTP-inspired)
export {
  Supervisor,
  SupervisionTreeRegistry,
  getSupervisionTreeRegistry,
  resetSupervisionTreeRegistry,
} from './runtime/supervisionTree';
export type {
  RestartStrategy,
  ChildState,
  ChildSpec,
  ChildHandle,
  ChildHealthStatus,
  ChildEntry,
  SupervisorConfig,
  SupervisionEvent,
  SupervisionEventHandler,
} from './runtime/supervisionTree';

// PRM (Process Reward Model) regression gate types
export type { PRMScoreEntry, PRMRegressionAlert, PRMConfig } from './selfEvolution/regressionGate';

export { TaskComplexityAnalyzer } from './taskComplexityAnalyzer';

// Runtime Enhancements — Agent Execution Improvements
export { CycleDetector } from './runtime/cycleDetector';
export { ToolApproval, DEFAULT_APPROVAL_POLICIES } from './runtime/toolApproval';
export type {
  ApprovalRequest,
  ApprovalResult,
  ApprovalLevel,
  ApprovalPolicy,
} from './runtime/toolApproval';
export { EvolutionaryWorkflowEngine } from './runtime/evolutionaryWorkflowEngine';
export type {
  WorkflowNode,
  WorkflowEdge,
  WorkflowDAG,
  EvolutionResult,
  EvolutionOptions,
} from './runtime/evolutionaryWorkflowTypes';
// Unified Verification Pipeline
export type {
  VerificationSignal,
  VerificationReport,
  UVPTaskContext,
  UVPConfig,
  TaskType,
  ProvisionIntentScores,
} from './runtime/unifiedVerificationTypes';

// Token Budget Governor

// Token Budget Manager — per-run proportional sub-agent allocation
export {
  TokenBudgetManager,
  getTokenBudgetManager,
  resetTokenBudgetManager,
} from './runtime/tokenBudgetManager';
export type {
  SubAgentAllocation,
  RunBudgetStatus,
  TokenBudgetConfig,
} from './runtime/tokenBudgetManager';

// Checkpoint Writer — MiMo-style independent checkpoint sub-agent
export {
  CheckpointWriter,
  getCheckpointWriter,
  resetCheckpointWriter,
} from './runtime/checkpointWriter';
export type {
  CheckpointWriterConfig,
  CheckpointTrigger,
  CheckpointDocument,
  CheckpointResult,
} from './runtime/checkpointWriter';

// Goal Judge — Independent judge model for verifying task completion
export { GoalJudge, getGoalJudge, resetGoalJudge } from './runtime/goalJudge';
export type {
  StopCondition,
  StopConditionResult,
  JudgeVerdict,
  GoalJudgeConfig,
} from './runtime/goalJudge';

// Rebuild Prompt — Layer 5: complete context window reset + reconstruction
export {
  RebuildPrompt,
  getRebuildPrompt,
  resetRebuildPrompt,
  isRebuilt,
} from './runtime/rebuildPrompt';
export type { RebuildParams, RebuildSection, RebuildResult } from './runtime/rebuildPrompt';
// Topology & Workflow Optimization
export { ReflexionTopologicalOptimizer as TopologyOptimizer } from './ultimate/topologyOptimizer';
export type {
  TopologyDiagnostics,
  OptimizationProposal,
  OptimizationAction,
} from './ultimate/topologyOptimizer';
export { RuntimeWorkflowAdapter } from './ultimate/runtimeWorkflowAdapter';
export type { AdaptiveExecutionResult } from './ultimate/runtimeWorkflowAdapter';

// Plugin System — Hooks & Extensions
export {
  HookManager,
  getHookManager,
  resetHookManager,
  createLoggingPlugin,
} from './pluginManager';
export type {
  CommanderPlugin,
  BuiltinPluginTool,
  HookPoint,
  PluginServiceDeclaration,
  BeforeToolCallContext,
  AfterToolCallContext,
  BeforeLLMCallContext,
  AfterLLMCallContext,
  AgentStartContext,
  AgentCompleteContext,
  ErrorContext,
} from './pluginManager';

// Built-in Plugins — RAG Knowledge Base
export { createRagPlugin } from './plugins/builtin/ragPlugin';
export { createTaintTrackingPlugin } from './plugins/builtin/taintTrackingPlugin';
export { createGapPlugin } from './plugins/builtin/gap/gapPlugin';
export { createObservabilityPlugin } from './plugins/builtin/observabilityPlugin';
export { createRaspExtensionsPlugin } from './plugins/builtin/raspExtensionsPlugin';
export { registerBuiltinPlugins } from './plugins/builtin/registerBuiltinPlugins';
export type {
  RegisterBuiltinPluginsOptions,
  RegisterBuiltinPluginsResult,
  BuiltinPluginId,
} from './plugins/builtin/registerBuiltinPlugins';
export {
  KnowledgeBaseStore,
  createKbEmbeddingFunction,
  getSharedKnowledgeBaseStore,
  setSharedKnowledgeBaseStore,
} from './plugins/builtin/knowledgeBaseStore';
export type {
  KbDocumentMeta,
  KbSearchResult,
  KbIngestResult,
} from './plugins/builtin/knowledgeBaseStore';

// TELOS Framework — Token-Efficient Low-waste Orchestration System
export type {
  TELOSBudget,
  TokenCheckResult,
  CostRecord,
  CostSummary,
  BudgetAlert,
  TELOSPlanContext,
  TELOSAgentAssignment,
  TELOSOrchestrationMode,
  ProviderEndpoint,
  ProviderHealth,
  ProviderSelection,
  StreamChunk,
  StreamCallback,
  StreamController,
  TELOSConfig,
} from './telos/types';
export { DEFAULT_TELOS_CONFIG } from './telos/types';
export {
  TokenSentinel,
  getTokenSentinel,
  resetTokenSentinel,
  estimateTokenCount,
  estimateMessagesTokens,
  calculateCost,
  ProviderPool,
  getProviderPool,
  resetProviderPool,
  TELOSOrchestrator,
  HeuristicEvaluator,
  EvalSuite,
  getHeuristicEvaluator,
  resetHeuristicEvaluator,
  EVALUATION_DIMENSIONS,
  DEFAULT_EVAL_CRITERIA,
} from './telos';

// MCP — Model Context Protocol
export type {
  MCPTool,
  MCPResource,
  MCPPrompt,
  MCPContentItem,
  MCPToolResult,
  MCPResourceContents,
  MCPJsonSchema,
  MCPTransport,
  MCPClientConfig,
  MCPInitializeResult,
  MCPServerCapabilities,
  JSONRPCRequest,
  JSONRPCResponse,
  A2AAgentCard,
  A2AJsonRpcRequest,
  A2AJsonRpcResponse,
  A2ATask,
  A2ATaskState,
  A2AMessage,
} from './mcp';
export {
  MCPClient,
  StdioClientTransport,
  StreamableHTTPClientTransport,
  createMCPClient,
  MCPServer,
  LOCAL_MCP_TOOL_NAMES,
  buildMcpActionEnvelope,
  createFetchActionGatewayExecutor,
  toolRequiresActionGateway,
  shouldRouteToolThroughActionGateway,
  ActionGatewayPolicyError,
  MCP_ERROR_CODES,
  MCP_PROTOCOL_VERSION,
  canTransition,
  AGENT_CARD_WELL_KNOWN_PATH,
  A2A_VERSION_HEADER,
  A2A_PROTOCOL_VERSION,
  A2A_ERROR,
  A2A_METHODS,
} from './mcp';
export type {
  ActionGatewayProposeInput,
  ActionGatewayProposeResult,
  ActionGatewayExecutor,
} from './mcp';

export { SwarmOrchestrator, FusionEngine, DEFAULT_SWARM_CONFIG } from './swarm';
export type {
  SwarmConfig,
  SwarmNode,
  SwarmManager,
  SwarmTopology,
  FusionConflict,
  FusionReport,
  SwarmResult,
  SwarmStatus,
} from './swarm';

export { DriveOrchestrator, DEFAULT_DRIVE_CONFIG } from './drive';
export type { DriveConfig, DriveStep, DriveState, DriveResult, DriveStatus } from './drive';

// Experimental — not yet wired into the main execution flow
export { PluginLoader, getPluginLoader } from './pluginLoader';

// SecurityOrchestrator — unified runtime security coordination facade
export {
  SecurityOrchestrator,
  getSecurityOrchestrator,
  resetSecurityOrchestrator,
} from './runtime/securityOrchestrator';
export type {
  SecurityOrchestratorDecision,
  SecurityOrchestratorConfig,
} from './runtime/securityOrchestrator';

// Commander Core — tiered auto-configuration control center (recommended entry)
export { Commander } from './commanderCore';
export type { CommanderResult, CommanderStatus } from './commanderCore';

// ============================================================================
// Orchestration Patterns — Concurrent / Graph(DAG) / MixtureOfAgents / Router
// 及扩展能力：CrossPollination / DynamicReplanner / AutoLoopRunner
// 参考 LangGraph / swarms / ClawTeam best practice，补齐企业效率场景缺失的
// 多 agent 编排模式。详见 orchestrationPatterns.ts 及各模式文件头注释。
// ============================================================================
export type {
  AnyStep,
  StepExecutor,
  StepOutput,
  StepResult,
  ExecutionContext,
  OrchestrationRun,
  OrchestrationRunStatus,
  OrchestrationPattern,
  OrchestrationEvent,
  OrchestrationEventHandler,
  BaseOrchestrationConfig,
  PatternMetrics,
} from './orchestrationPatterns';
export {
  executeStepWithRetry,
  mergeTokenUsage,
  computePatternMetrics,
  runWithConcurrencyLimit,
  StepTimeoutError,
} from './orchestrationPatterns';

export { runConcurrentWorkflow, ConcurrentWorkflowBuilder } from './orchestrationConcurrent';
export type { ConcurrentWorkflowConfig } from './orchestrationConcurrent';

export {
  runGraphWorkflow,
  GraphWorkflowBuilder,
  validateGraph,
  topologicalLayers,
  findTerminalNodes,
  GraphValidationError,
} from './orchestrationGraph';
export type { GraphWorkflowConfig, GraphNode } from './orchestrationGraph';

export { runMixtureOfAgents, MixtureOfAgentsBuilder } from './orchestrationMixture';
export type { MixtureOfAgentsConfig, SynthesizerInput } from './orchestrationMixture';

export {
  runSwarmRouter,
  SwarmRouterBuilder,
  decidePattern,
  RouterConfigError,
  DEFAULT_ROUTING_RULES,
} from './orchestrationRouter';
export type {
  SwarmRouterConfig,
  TaskProfile,
  RouterDecision,
  RoutingRule,
  LLMRouter,
  RoutedSteps,
} from './orchestrationRouter';

export {
  CrossPollinationEngine,
  defaultHeuristicExtractor,
  buildCrossPollinationReport,
} from './crossPollination';
export type { Insight, InsightExtractor, CrossPollinationReport } from './crossPollination';

export { runDynamicReplan } from './dynamicReplanner';
export type {
  DynamicReplanConfig,
  DynamicReplanRun,
  ReplanDecision,
  ReplanContext,
  ReplannerHook,
} from './dynamicReplanner';

export {
  runAutoLoop,
  defaultCompletionDetector,
  createConvergenceDetector,
} from './autoLoopRunner';
export type { AutoLoopConfig, AutoLoopRun, CompletionDetector } from './autoLoopRunner';
export type { CommanderOptions, DeploymentTier, ResolvedConfig } from './commander/tier';
export type { ProbeResult } from './commander/probe';

// Compensation Primitives — in-memory mutation rollback registry
// ---------------------------------------------------------
// CompensationRegistry (class) + CompensableAction + CompensationHandler
// are the in-memory predecessor. A saga-based durable scheduling primitive
// (CompensationScheduler, CompensationFn, etc.) is re-exported further below
// under `// Saga Runtime`. The registry is in-memory by default but becomes
// durable when wired to a CompensationQueue via setCompensationQueue() —
// durable enqueue happens automatically inside compensateAll() once retries
// exhaust; processQueue() is for recovery-on-restart (drains persisted queue
// items back into in-memory handlers via claimNext()). Use the saga scheduler
// for DAG-ordered retry semantics; per-step policy lives in `CompensationFn`
// + `defaultCompensationRetryPolicy`.
//
// These symbols are already exported via the './runtime' barrel above.

// Saga Runtime — durable compensating transactions
export {
  createSaga,
  buildSaga,
  SagaBuilder,
  SagaBuilderError,
  runSaga,
  startSaga,
  SagaCoordinator,
  SagaCoordinatorError,
  SagaNodeError,
  SagaAbortedError,
  attachSagaHandle,
  ExecutionGraph,
  ExecutionGraphError,
  CheckpointManager,
  CheckpointError,
  InMemorySagaStore,
  FileSagaStore,
  InProcessWorkerPool,
  WorkerPool,
  WorkerPoolError,
  CompensationScheduler,
  CompensationSchedulerError,
  defaultCompensationRetryPolicy,
  ApprovalManager,
  ApprovalError,
  InMemoryApprovalStore,
  FileApprovalStore,
  ApprovalStoreError,
  RetryController,
  RetryControllerError,
  mergeRetryPolicy,
  isStepNode,
  isParallelNode,
  isNestedNode,
  isApprovalNode,
} from './saga';
export type {
  SagaGraph,
  SagaNode,
  SagaStepNode,
  SagaParallelNode,
  SagaNestedNode,
  SagaApprovalNode,
  SagaContext,
  SagaResult,
  SagaEvent,
  SagaEventKind,
  SagaStateSnapshot,
  NodeState,
  SagaRunOptions,
  SagaRunHandle,
  RunningSaga,
  SagaStepOptions,
  SagaParallelConfig,
  SagaNestedConfig,
  SagaApprovalConfig,
  RetryPolicy,
  CompensationFn,
  SagaStore,
  FileSagaStoreOptions,
  SagaApprovalRequest,
  SagaApprovalDecision,
  SagaApprovalResult,
  ApprovalStore,
  ApprovalManagerOptions,
  ApprovalWaitOptions,
  FileApprovalStoreOptions,
  SagaWorkerPoolOptions,
  CompensableStep,
  CompensationAttempt,
  CompensationResult,
  FailedCompensation,
  DeadLetterSink,
  CompensationSchedulerOptions,
  RecoveredState,
} from './saga';
export {
  DEFAULT_RETRY_POLICY,
  DEFAULT_STEP_TIMEOUT_MS,
  DEFAULT_LEASE_TTL_SECONDS,
  DEFAULT_IDEMPOTENCY_TTL_SECONDS,
} from './saga';

// RotationSignoffVerifier — D2.6 + D2.7 + D2.8 + D2.9 + D3.0 + D3.1 + D3.2 hardening policy gate.
// §6 sign-off binding via GPG-verified commit SHAs. Library-grade async surface:
// pure functions (`runVerifierAsync`, `evaluateSignoffAsync`, `verifyShaAsync`,
// `verifyShasConcurrent`, `parseArgs`, …) plus public types (`SignoffRow`,
// `VerifyResult`, `CliArgs`, `VerifyShaResult`, `RunVerifierOptions`,
// `RunVerifierAsyncOptions`) and policy constants (`POLICY_MIN_VERIFIED_ROWS`,
// `POLICY_VERSION`, `VERIFY_CONCURRENCY_DEFAULT`). Stable programmatic API; the
// CLI wrapper at `scripts/verify-rotation-signoff.ts` drives the async surface.
//
// D3.2 async surface: bounded-concurrency batcher + AbortSignal cancellation.
// The legacy sync surface (`verifySha`, `evaluateSignoff`, `runVerifier`) was
// removed in the structural-debt cleanup; all consumers should use the async
// variants.
export {
  SHA_RE,
  DEFAULT_DOC_PATH,
  POLICY_MIN_VERIFIED_ROWS,
  POLICY_VERSION,
  VERIFY_CONCURRENCY_DEFAULT,
  extractSection,
  parseSignoffTable,
  countColumns,
  verifyShaAsync,
  evaluateSignoffAsync,
  runVerifierAsync,
  verifyShasConcurrent,
  formatReport,
  parseArgs,
} from './security/rotationSignoffVerifier';
export type {
  SignoffRow as RotationSignoffRow,
  VerifyResult as RotationSignoffResult,
  CliArgs as RotationSignoffCliArgs,
  VerifyShaResult as RotationVerifyShaResult,
  RunVerifierOptions,
  RunVerifierAsyncOptions as RotationRunVerifierAsyncOptions,
} from './security/rotationSignoffVerifier';

// Request data scrubbing
export { scrubRequest, redactPii, DEFAULT_IGNORE_FIELDS } from './shadow';

// ============================================================================
// Architecture V2 surfaces
// ============================================================================
export {
  planWorkGraph,
  executeWorkGraph,
  profileFromCliVerb,
  OrchestrationPlanner,
  getOrchestrationPlanner,
} from './planner';
export type {
  PlannerProfile,
  WorkNodeKind,
  WorkNode,
  WorkGraph,
  PlanInput,
  WorkGraphExecutor,
} from './planner';

export {
  SideEffectGate,
  SideEffectGateError,
  getSideEffectGate,
  resetSideEffectGate,
  setSideEffectGate,
} from './runtime/sideEffectGate';
export type {
  SideEffectRequest,
  SideEffectAdmission,
  SideEffectGateOptions,
} from './runtime/sideEffectGate';

export { KernelWorkerPool } from './atr/workerPool';
export type { WorkerExecutor, WorkerPoolOptions, WorkerPoolStats } from './atr/workerPool';

export { ControlPlane, getControlPlane, resetControlPlane } from './controlPlane';
export type { WorkloadIdentity, ControlPlaneConfig } from './controlPlane';

export { InterruptError, HumanInteractionRequired } from './runtime/interruptError';

export {
  executePluginToolSandboxed,
  getPluginSandboxMode,
  PluginSandboxError,
} from './plugins/pluginSandbox';
export type {
  PluginSandboxMode,
  SandboxedToolRequest,
  SandboxedToolResult,
} from './plugins/pluginSandbox';
