/**
 * Security module — centralized security infrastructure for Commander.
 *
 * Exports:
 * - SecurityAuditLogger: audit trail for all security events
 * - SecurityMonitor: continuous monitoring, anomaly detection, alerting
 * - GuardianAgent: semantic drift, anomaly, and safety monitoring for agents
 * - CapabilityTokenIssuer/Verifier: short-lived HMAC-signed authorization tokens
 * - AuditChainLedger: tamper-evident hash-chained audit log
 * - AgentLineage: immutable parent→child agent relationship tracking
 */
export {
  SecurityAuditLogger,
  getSecurityAuditLogger,
  resetSecurityAuditLogger,
} from './securityAuditLogger';

export type {
  SecurityEventType,
  SecuritySeverity,
  SecurityEvent,
  SecurityStats,
} from './securityAuditLogger';

export { SecurityMonitor, getSecurityMonitor, resetSecurityMonitor } from './securityMonitor';

export type { SecurityAlert, SecurityHealth } from './securityMonitor';

export { GuardianAgent, getGuardianAgent, resetGuardianAgent } from './guardianAgent';

export type {
  GuardianAction,
  GuardianInterventionType,
  GuardianEvidencePack,
  GuardianConfig,
} from './guardianAgent';

// CapabilityToken — short-lived HMAC-signed authorization tokens (Phase 2.1)
export {
  CapabilityTokenIssuer,
  CapabilityTokenVerifier,
  CapabilityTokenError,
  decode,
  sign,
  getCapabilityTokenIssuer,
  getCapabilityTokenVerifier,
  resetCapabilityTokenState,
  resetRevocationLedger,
  resolveMasterKey,
  CAPABILITY_TOKEN_KEY_ENV,
  DEFAULT_MAX_TTL_SECONDS,
  MAX_DELEGATION_DEPTH,
  CLOCK_SKEW_SECONDS,
} from './capabilityToken';

export type {
  CapabilityRejectReason,
  CapabilityScope,
  CapabilityPayload,
  IssueOptions,
  VerifyRequest,
  VerifyResult,
  VerifyResultOk,
  VerifyResultErr,
  ParsedCapabilityToken,
  VerifierOptions,
  IssuerOptions,
  CapabilityAuditLogger,
  RiskLevel,
} from './capabilityToken';

// AuditChainLedger — tamper-evident hash-chained audit log (Phase 1.1)
export {
  AuditChainLedger,
  getAuditChainLedger,
  resetAuditChainLedger,
  computeEntryHmac,
  deriveTenantKey,
  resolveMasterKey as resolveAuditChainMasterKey,
  collectPersistedEntries,
  GENESIS_HASH,
  CHAIN_PROTOCOL_VERSION,
  AUDIT_CHAIN_KEY_ENV,
} from './auditChainLedger';

export type {
  AuditChainEntry,
  ChainBreakReason,
  ChainBreak,
  VerifyResult as AuditChainVerifyResult,
  VerifyOptions as AuditChainVerifyOptions,
} from './auditChainLedger';

// AgentLineage — immutable parent→child agent relationship tracking (Phase 2.2)
export { AgentLineage, getAgentLineage, resetAgentLineage } from './agentLineage';

export type { LineageNode, LineageEventType, LineageSummary, LineageQuery } from './agentLineage';

// SupplyChainScanner — skill/tool pre-load security scanning
export {
  SupplyChainScanner,
  getSupplyChainScanner,
  resetSupplyChainScanner,
} from './supplyChainScanner';

export type {
  SupplyChainScanSeverity,
  SupplyChainScanRequest,
  SupplyChainScanResult,
  SupplyChainAction,
  ToolDependency,
  FilePermission,
  NetworkPermission,
  SupplyChainProvenance,
} from './supplyChainScanner';

// RedTeamFramework — automated adversarial security testing
export {
  RedTeamFramework,
  getRedTeamFramework,
  resetRedTeamFramework,
  createContentScannerDefender,
  createComprehensiveDefender,
  generateSecurityReport,
  generateSecurityReportJson,
  ATTACK_SCENARIOS,
} from './redTeamFramework';

export type {
  AttackCategory,
  TestResult,
  RedTeamTestScenario,
  RedTeamTestResult,
  RedTeamRunReport,
  RedTeamProgressCallback,
} from './redTeamFramework';

// OutputSanitizer — data exfiltration prevention at the output boundary
export {
  OutputSanitizer,
  getOutputSanitizer,
  resetOutputSanitizer,
  sanitizeOutput,
  sanitizeIfNeeded,
} from './outputSanitizer';

export type {
  SensitivityCategory,
  RedactionStrategy,
  RedactionRule,
  RedactionRecord,
  SanitizeResult,
  OutputSanitizerConfig,
} from './outputSanitizer';

// LiteLLMPricing — real-time model pricing from LiteLLM GitHub registry
export { LiteLLMPricing, getLiteLLMPricing, resetLiteLLMPricing } from './litellmPricing';

// UnifiedCostAuthority — single source of truth for cost enforcement
export {
  UnifiedCostAuthority,
  getUnifiedCostAuthority,
  resetUnifiedCostAuthority,
} from './unifiedCostAuthority';
export type {
  UCACallContext,
  UCADecision,
  UCAPostCallResult,
  BudgetSnapshot,
  BudgetCap,
  CostLedgerEntry,
  ToolCostProfile,
} from './unifiedCostAuthority';

// AgentSOC — P0-P4 event classification, playbook engine, escalation paths, health dashboard
export { AgentSoc, getAgentSoc, resetAgentSoc } from './agentSoc';

export type {
  IncidentPriority,
  IncidentStatus,
  EscalationLevel,
  PlaybookTrigger,
  IncidentClassification,
  SlaTarget,
  Incident,
  PlaybookAction,
  Playbook,
  PostmortemReport,
  SocHealth,
  AgentSocConfig,
} from './agentSoc';

// EuAiActCompliance — EU AI Act Article 12/13/14 self-assessment reporting
export {
  EuAiActComplianceReporter,
  getEuAiActComplianceReporter,
  resetEuAiActComplianceReporter,
} from './euAiActCompliance';

export type {
  EuAiActReport,
  Article12Report,
  Article13Report,
  Article14Report,
  ComplianceSummary,
  ComplianceReportOptions,
} from './euAiActCompliance';

// AgentStandbyManager — hot standby agent architecture with auto-failover
export {
  AgentStandbyManager,
  getAgentStandbyManager,
  resetAgentStandbyManager,
} from './agentStandbyManager';

export type {
  AgentTier,
  AgentInstance,
  SwitchTrigger,
  SwitchEvent,
  StandbyConfig,
  StandbyHealth,
  StandbyStatus,
} from './agentStandbyManager';

// RedTeamBaseline — regression detection for configured red-team CI/CD
export {
  RedTeamBaselineManager,
  getRedTeamBaseline,
  resetRedTeamBaseline,
} from './redTeamBaseline';

export type {
  RegressionSeverity,
  RegressionResult,
  ImprovementResult,
  BaselineComparison,
  BaselineConfig,
} from './redTeamBaseline';

// EdgeSecurityProfile — unified edge/offline mode: auto-detect, local-only, encrypted state, strict sandbox
export {
  EdgeSecurityProfile,
  getEdgeSecurityProfile,
  resetEdgeSecurityProfile,
} from './edgeSecurityProfile';

export type {
  EdgeMode,
  EdgeDetectionMethod,
  EdgeDetectionResult,
  EdgeResourceAssessment,
  EdgeSecurityConfig,
  EdgeSecurityStatus,
} from './edgeSecurityProfile';

// ComplianceAuditManager — ISO 42001/NIST AI RMF mapping, posture scoring, trend analysis, audit reports
export {
  ComplianceAuditManager,
  getComplianceAuditManager,
  resetComplianceAuditManager,
} from './complianceAuditReport';

export type {
  IsoClause,
  NistAirmfFunction,
  ScoringDimension,
  ComplianceControl,
  DimensionScore,
  SecurityPosture,
  PostureSnapshot,
  IsoComplianceSummary,
  NistRmfAlignmentSummary,
  ComplianceAuditReport,
  TrendAnalysis,
  AuditChecklistItem,
  ComplianceConfig,
} from './complianceAuditReport';

// ThreatIntelligenceFeed — dynamic threat feed with TLP, source registration, SupplyChainScanner integration
export {
  ThreatIntelligenceFeed,
  getThreatIntelligenceFeed,
  resetThreatIntelligenceFeed,
} from './threatIntelligenceFeed';

export type {
  TlpLevel,
  ThreatSignature,
  ThreatFeedSource,
  ThreatFeedHealth,
  ThreatFeedConfig,
} from './threatIntelligenceFeed';

// CrossAgentCorrelator — multi-agent attack chain detection
export {
  CrossAgentCorrelator,
  getCrossAgentCorrelator,
  resetCrossAgentCorrelator,
} from './crossAgentCorrelator';

export type {
  CorrelationRuleType,
  CrossAgentEvent,
  CorrelationMatch,
  CorrelationRule,
  CorrelatorConfig,
} from './crossAgentCorrelator';

// MLInjectionDetector — embedding-based semantic injection detection
export {
  MLInjectionDetector,
  getMLInjectionDetector,
  resetMLInjectionDetector,
} from './mlInjectionDetector';

export type { InjectionVector, DetectionResult, MLDetectorConfig } from './mlInjectionDetector';

// FuzzTestFramework — mutation-based tool input fuzzer with coverage-guided feedback
export {
  FuzzTestFramework,
  getFuzzTestFramework,
  resetFuzzTestFramework,
  createFileSystemToolHarness,
  createWebSearchToolHarness,
} from './fuzzTestFramework';

export type {
  MutationStrategy,
  FuzzSeverity,
  FuzzInput,
  FuzzResult,
  FuzzRunReport,
  FuzzerConfig,
  ToolHarness,
} from './fuzzTestFramework';

// PostQuantumCrypto — PQ-safe hash (SHAKE-256), key generation, signing, verification
export {
  PostQuantumCrypto,
  getPostQuantumCrypto,
  resetPostQuantumCrypto,
  pqHash,
  pqVerifyMac,
} from './postQuantumCrypto';

export type {
  PqAlgorithm,
  PqKeyPair,
  PqMac,
  PqHashResult,
  PqCryptoConfig,
} from './postQuantumCrypto';

// MultimodalContentScanner — voice/video/image threat scanning
export {
  MultimodalContentScanner,
  getMultimodalContentScanner,
  resetMultimodalContentScanner,
} from './multimodalContentScanner';

export type {
  ModalityType,
  MultimodalThreatType,
  MultimodalThreatSeverity,
  MultimodalThreat,
  MultimodalScanResult,
  MultimodalScannerConfig,
} from './multimodalContentScanner';

// SandboxVerifier — formal sandbox verification harness
export { SandboxVerifier, getSandboxVerifier, resetSandboxVerifier } from './sandboxVerifier';

export type {
  VerificationArea,
  VerificationResult,
  VerificationTest,
  VerificationEvidence,
  SandboxVerificationReport,
  VerifierConfig,
} from './sandboxVerifier';

// VoiceContentScanner — enhanced audio/voice threat scanning
export {
  VoiceContentScanner,
  getVoiceContentScanner,
  resetVoiceContentScanner,
} from './voiceContentScanner';

export type {
  VoiceThreatType,
  VoiceThreatSeverity,
  VoiceThreat,
  VoiceScanResult,
  VoiceScannerConfig,
} from './voiceContentScanner';

// FederatedIdentity — cross-org trust delegation with HMAC+OIDC JWT dual signing (Phase 3)
export {
  FederatedIdentity,
  getFederatedIdentity,
  resetFederatedIdentity,
  resolveFederationKey,
  resolveFederationOIDCKey,
  FEDERATION_KEY_ENV,
  FEDERATION_OIDC_KEY_ENV,
} from './federatedIdentity';

export type {
  ResourceScope,
  FederationTrust,
  IssueTrustParams,
  FederatedExchangeResult,
  FederatedExchangeRejection,
  FederatedExchangeOutcome,
  FederationRejectReason,
} from './federatedIdentity';

// TEESandbox — Trusted Execution Environment (AWS Nitro Enclaves / GCP Confidential VMs)
export { TEESandbox } from '../sandbox/teeEnclave';
export type { TEEBackend, TEEAttestation, TEESandboxResult } from '../sandbox/teeEnclave';

// MitreAtlasMapper — automatic MITRE ATLAS tactics/techniques mapping
export { MitreAtlasMapper, getMitreAtlasMapper, resetMitreAtlasMapper } from './mitreAtlasMapper';
export type {
  AtlasTactic,
  AtlasTechnique,
  AtlasSubTechnique,
  AtlasHeatmapCell,
  AtlasMapping,
  MitreAtlasReport,
} from './mitreAtlasMapper';

// AdaptiveHITL — risk-adaptive human-in-the-loop strategy engine
export { AdaptiveHITL, getAdaptiveHitl, resetAdaptiveHitl, maxStrategy } from './adaptiveHitl';
export type {
  HITLStrategy,
  ToolRiskSignal,
  AgentConfidenceSignal,
  CorrelationSignal as HITLCorrelationSignal,
  VerificationSignal as HITLVerificationSignal,
  MissionSignal,
  HITLSignalBundle,
  HITLFactor,
  HITLDecision,
  AgentBehaviorProfile,
  AdaptiveHITLConfig,
} from './adaptiveHitl';

// SecurityBenchmarkRunner — automated CI/CD security benchmark scoring (AgentDojo, Agent-SafetyBench, AgentHarm)
export {
  SecurityBenchmarkRunner,
  getSecurityBenchmarkRunner,
  resetSecurityBenchmarkRunner,
  ALL_BENCHMARK_CASES,
  getCasesForBenchmark,
} from './securityBenchmarkRunner';
export type {
  BenchmarkId,
  BenchmarkTestCase,
  BenchmarkTestResult,
  BenchmarkRunReport,
  BenchmarkTrend,
  BenchmarkRunnerConfig,
  DefenderFn,
} from './securityBenchmarkRunner';

// CommanderDefender — reusable multi-layer defense stack for live runtime and benchmarks
export { createCommanderDefender } from './commanderDefender';
export type {
  DefenderOptions,
  DefenseResult,
  DefenderFn as CommanderDefenderFn,
} from './commanderDefender';

// SupplyChainAttestor — SPDX 2.3 SBOM generation + Sigstore keyless attestation + verification
export {
  SupplyChainAttestor,
  getSupplyChainAttestor,
  resetSupplyChainAttestor,
  componentToPurl,
  hashFile,
  hashString,
} from './supplyChainAttestor';
export type {
  SpdxPackage,
  SpdxRelationship,
  SpdxDocument,
  InTotoStatement,
  AttestationBundle,
  AttestationResult,
  VerificationResult as AttestationVerificationResult,
  ComponentEntry,
  AttestorConfig,
} from './supplyChainAttestor';

// DifferentialPrivacyLayer — ε-DP Laplace/Gaussian noise for cross-agent memory sharing
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
} from './differentialPrivacyLayer';
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
} from './differentialPrivacyLayer';

// Scanner→Attestor bridge — SupplyChainScanner now auto-calls SupplyChainAttestor
// on passed scans. The attestor singleton is accessible via getSupplyChainAttestor().
// Re-exported here for convenience.

// OwaspAgenticAiTop10 — unified ASI01–ASI10 per-ASI risk scoring with
// rolling-window aggregation so SIEM/dashboards see a single OS-aligned
// view of agentic risk per rolling window. Avoids OOM via per-minute
// bucketing; bridges Guardian / SupplyChain / CrossAgent signals.
export {
  OwaspAgenticAiTop10,
  getOwaspAsiTop10,
  resetOwaspAsiTop10,
  recordGuardianIntervention,
  recordSupplyChainFinding,
  recordCrossAgentFinding,
  ALL_ASIS,
} from './owaspAgenticAiTop10';
export type {
  OwaspAsiId,
  OwaspAsiConfig,
  OwaspAsiReport,
  AsDetection,
  AsSeverity,
  AsBlockState,
  AsiScore,
} from './owaspAgenticAiTop10';

// RotationSignoffVerifier — D2.6 + D2.7 + D2.8 + D2.9 + D3.0 + D3.1 + D3.2 hardening policy gate.
// §6 sign-off binding via GPG-verified commit SHAs. Library-grade async pure
// functions (`runVerifierAsync`, `evaluateSignoffAsync`, `verifyShaAsync`,
// `verifyShasConcurrent`, `parseArgs`, …) plus public types (`SignoffRow`,
// `VerifyResult`, `CliArgs`, `VerifyShaResult`, `RunVerifierOptions`,
// `RunVerifierAsyncOptions`) and policy constants (`POLICY_MIN_VERIFIED_ROWS`,
// `POLICY_VERSION`, `VERIFY_CONCURRENCY_DEFAULT`). Stable library surface — both
// the CLI wrapper and any `Commander`-internal programmatic consumer can drive
// the policy gate without re-implementing parsing or evaluation.
//
// D3.2 async surface: `verifyShaAsync`, `evaluateSignoffAsync`, `runVerifierAsync`,
// `verifyShasConcurrent` provide bounded concurrency + AbortSignal cancellation.
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
} from './rotationSignoffVerifier';

// EncryptedSecretsVault — AES-256-GCM 加密密钥保险库，替代明文环境变量存储
export {
  EncryptedSecretsVault,
  getEncryptedSecretsVault,
  resetEncryptedSecretsVault,
} from './encryptedSecretsVault';
export type {
  SecretMetadata,
  StoredSecret,
  VaultConfig,
  VaultExportBundle,
  VaultStats,
} from './encryptedSecretsVault';

// SecureApiKeyResolver — vault-first API key resolution with env fallback
export {
  resolveSecureApiKey,
  resolveSecureApiKeys,
  initSecureApiKeyResolver,
} from './secureApiKeyResolver';

// DataLossPrevention — 全面数据泄露防护系统，覆盖 API/日志/工具/Agent/SSE 出口点
export {
  DataLossPrevention,
  getDataLossPrevention,
  resetDataLossPrevention,
  scanContent,
  sanitizeContent,
  dlpResponseMiddleware,
} from './dataLossPrevention';
export type {
  DLPRiskLevel,
  SensitiveDataType,
  RedactionStrategy as DLPRedactionStrategy,
  DLPExitPoint,
  SensitiveDataMatch,
  DLPScanResult,
  DLPConfig,
  DLPStats,
} from './dataLossPrevention';

// BillExplosionGuard — 未接线参考实现。线上成本上限是 UnifiedCostAuthority。
export {
  BillExplosionGuard,
  getBillExplosionGuard,
  resetBillExplosionGuard,
} from './billExplosionGuard';
export type {
  BillGuardAction,
  BillAttackPattern,
  BillingPeriod,
  BillGuardConfig,
  BillGuardState,
  CostCheckResult,
  CostSnapshot,
  BillCostReport,
  SessionState,
  TenantCostState,
} from './billExplosionGuard';

// ZeroTrustValidator — 零信任请求验证器，HMAC 签名 + 防重放 + 时序安全比较
export {
  ZeroTrustValidator,
  getZeroTrustValidator,
  resetZeroTrustValidator,
  zeroTrustMiddleware,
} from './zeroTrustValidator';
export type {
  ZeroTrustValidationResult,
  ZeroTrustRejectReason,
  SigningKeyEntry,
  ZeroTrustConfig,
  SignRequestParams,
  GeneratedSignature,
} from './zeroTrustValidator';

// EnterpriseSecurityGateway — 企业级统一安全网关，7 层纵深防御协调器
export {
  EnterpriseSecurityGateway,
  getEnterpriseSecurityGateway,
  resetEnterpriseSecurityGateway,
} from './enterpriseSecurityGateway';
export type {
  EnterpriseGatewayConfig,
  PreLLMCheckParams,
  PostLLMCheckParams,
  PreToolCheckParams,
  PostToolCheckParams,
  SecurityCheckResult,
  SecurityLayer,
  GatewayStatus,
} from './enterpriseSecurityGateway';

// RuntimeDependencyGuard — 运行时依赖完整性防护（防篡改、依赖混淆、post-install 审计、typosquatting 检测）
export {
  RuntimeDependencyGuard,
  getRuntimeDependencyGuard,
  resetRuntimeDependencyGuard,
} from './runtimeDependencyGuard';
export type {
  DependencyIntegrityRecord,
  PostInstallScriptAnalysis,
  TyposquattingResult,
  DependencyConfusionCheck,
  RuntimeDependencyGuardConfig,
  IntegrityViolation,
} from './runtimeDependencyGuard';

// ToolPoisoningGuard — MCP 工具中毒攻击（TPA）防护
export {
  ToolPoisoningGuard,
  getToolPoisoningGuard,
  resetToolPoisoningGuard,
  POISONING_PATTERNS,
} from './toolPoisoningGuard';
export type {
  ToolDescriptionScanResult,
  PoisoningFinding,
  ToolBehaviorBaseline,
  ToolSecurityClassification,
  PoisoningPattern,
  ToolPoisoningConfig,
} from './toolPoisoningGuard';

// CVEDatabaseIntegration — CVE 数据库集成与实时漏洞检查
export {
  CVEDatabaseIntegration,
  getCVEDatabaseIntegration,
  resetCVEDatabaseIntegration,
} from './cveDatabaseIntegration';

// ActiveDeceptionSystem — 主动欺骗防御系统（蜜罐端点 + 金丝雀令牌 + 诱饵凭证）
export {
  ActiveDeceptionSystem,
  getActiveDeceptionSystem,
  resetActiveDeceptionSystem,
} from './activeDeceptionSystem';
export type {
  HoneypotEndpoint,
  CanaryToken,
  DecoyCredential,
  AttackerProfile,
  DeceptionResponse,
  DeceptionConfig,
  CanaryTokenType,
} from './activeDeceptionSystem';

export type {
  CVEEntry,
  CVESeverity,
  CVECategory,
  AffectedProduct,
  FixedVersion,
  PackageToCheck,
  VulnerabilityMatch,
  CVECheckResult,
  VulnerabilityReport,
  RemediationSuggestion,
  CVEFeedSource,
  CVEConfig,
} from './cveDatabaseIntegration';

export type {
  SignoffRow,
  CliArgs,
  VerifyShaResult,
  RunVerifierOptions,
  RunVerifierAsyncOptions,
  // VerifyResult is intentionally NOT re-exported from the security barrel:
  // `@praetor/core/security` already exports an unrelated `VerifyResult`
  // from `./capabilityToken` (used by AuthManager), and TypeScript forbids
  // duplicate identifiers at the barrel surface. Consumers should reach this
  // module's `VerifyResult` via one of three alternatives:
  //   • Value-inference:  const r = await evaluateSignoffAsync(rows);  // r: VerifyResult
  //   • Direct path:      import type { VerifyResult } from
  //                        '@praetor/core/security/rotationSignoffVerifier'
  //   • Main-barrel alias: import type { RotationSignoffResult } from '@praetor/core'
} from './rotationSignoffVerifier';

// A2AMessageSecurity — A2A 协议消息级安全（OWASP ASI07）：HMAC 签名 + AES-256-GCM
// 加密 + 身份证明 + 重放防御。注意：本模块的 `VerificationResult` 类型与
// `./sandboxVerifier` 导出的同名类型冲突，因此此处以 `A2AVerificationResult`
// 别名导出；如需原名，请直接从本模块路径导入。
export {
  A2AMessageSecurity,
  getA2AMessageSecurity,
  resetA2AMessageSecurity,
} from './a2aMessageSecurity';
export type {
  SecurityLevel,
  AgentIdentity,
  SenderContext,
  A2AMessage,
  SecuredMessage,
  A2AMessageSecurityConfig,
  SemanticAnalyzer,
} from './a2aMessageSecurity';
export type { VerificationResult as A2AVerificationResult } from './a2aMessageSecurity';

// MemoryPoisoningDefenseEngine — 全面记忆投毒防御引擎 (OWASP ASI06/ASI07)
// 覆盖全部 5 类攻击: 写入/检索/摘要/反思/跨会话持久化投毒
export {
  MemoryPoisoningDefenseEngine,
  getMemoryPoisoningDefenseEngine,
  resetMemoryPoisoningDefenseEngine,
} from './memoryPoisoningDefenseEngine';

// GoalHijackDetector — 目标劫持检测器 (OWASP ASI01)
// 运行时检测 4 类目标劫持：直接覆盖、间接注入、目标漂移、递归篡改
export {
  GoalHijackDetector,
  getGoalHijackDetector,
  resetGoalHijackDetector,
} from './goalHijackDetector';
export type {
  HijackType,
  HijackSeverity,
  OriginalGoal,
  GoalContext,
  HijackDetectionResult,
  GoalModificationRecord,
  GoalHijackConfig,
} from './goalHijackDetector';

// SemanticFirewall — 语义防火墙 (OWASP ASI06/ASI07)
// 5 层纵深防御：内容净化 → 溯源追踪 → 写入前验证(正则+LLM语义) → 隔离区 → 审计日志
export { SemanticFirewall, getSemanticFirewall, resetSemanticFirewall } from './semanticFirewall';
export type {
  ProvenanceOrigin,
  TrustLevel,
  WriteDecision,
  DangerCategory,
  ProvenanceRecord,
  SemanticAnalysisResult,
  SemanticAnalyzerCallback,
  WriteContext,
  ValidationResult,
  QuarantinedItem,
  AuditLogEntry,
  SemanticFirewallConfig,
} from './semanticFirewall';
export type { SanitizeResult as SemanticFirewallSanitizeResult } from './semanticFirewall';
export type {
  PoisoningType,
  PoisoningSeverity,
  SourceCredibility,
  MemoryWriteContext,
  DefenseResult as MemoryPoisoningDefenseResult,
  RetrievedMemoryEntry,
  RetrievalValidationResult,
  TaintEntry,
  TaintReport,
  MemoryPoisoningDefenseConfig,
} from './memoryPoisoningDefenseEngine';

// AdaptiveThreatLearningEngine — 自适应威胁学习引擎
// 从每次检测到的攻击中学习，生成可复用签名，实时合成新检测规则，威胁模型演化
export {
  AdaptiveThreatLearningEngine,
  getAdaptiveThreatLearningEngine,
  resetAdaptiveThreatLearningEngine,
} from './adaptiveThreatLearningEngine';
export type {
  SignatureCategory,
  SignatureStatus,
  RuleAction,
  AttackFamilyType,
  AttackContext,
  AttackSignature,
  SynthesizedRule,
  AttackFamily,
  ThreatModel,
  SignatureMatchResult,
  SignatureCheckRequest,
  AdaptiveLearningConfig,
} from './adaptiveThreatLearningEngine';

// DynamicCostGuardian — 动态成本卫士
// 每租户消费指纹、自适应阈值、新型经济攻击向量检测、实时成本异常响应
export {
  DynamicCostGuardian,
  getDynamicCostGuardian,
  resetDynamicCostGuardian,
} from './dynamicCostGuardian';
export type {
  SpendingPeriod,
  DeviationLevel,
  EconomicAttackType,
  SpendingFingerprint,
  DynamicThreshold,
  EconomicAttackDetection,
  CostAnomalyResponse,
  CostRecord,
  DynamicCostConfig,
} from './dynamicCostGuardian';

// AttackCampaignTracker — 攻击战役追踪器
// 跨事件/天/代理追踪演化的攻击战役，战役演化分析，战役关联，预测性防御
export {
  AttackCampaignTracker,
  getAttackCampaignTracker,
  resetAttackCampaignTracker,
} from './attackCampaignTracker';

// UnifiedAuditLog — cross-source audit log aggregator
// Merges security/approval/execution/user-action/configuration audit producers
// into a single normalized, queryable, exportable trail.
export {
  UnifiedAuditLog,
  getUnifiedAuditLog,
  resetUnifiedAuditLog,
  SENSITIVE_BODY_KEYS,
} from './unifiedAuditLog';

export type {
  UnifiedAuditCategory,
  UnifiedAuditSeverity,
  UnifiedAuditEntry,
  AuditQueryFilters,
  AuditTimelinePoint,
  AuditStats,
  AuditExportFormat,
  UnifiedAuditLogOptions,
} from './unifiedAuditLog';
export { checkToolGuardian, checkRemoteAgentGuardian } from './securityGuardianFacade';
export type {
  ToolGuardianCheckParams,
  ToolGuardianCheckResult,
  ToolGuardianBlockKind,
} from './securityGuardianFacade';
export { startAuditAggregatorBridge, stopAuditAggregatorBridge } from './auditAggregatorBridge';
export type {
  CampaignPhase,
  CampaignSeverity,
  PredictionType,
  AttackEvent,
  AttackCampaign,
  CampaignEvolution,
  CampaignGroup,
  CampaignPrediction,
  CampaignTrackerConfig,
} from './attackCampaignTracker';

// TTSR — Time Traveling Streamed Rules (零成本规则注入引擎)
export {
  TtsrEngine,
  getTtsrEngine,
  resetTtsrEngine,
  scanStreamChunk,
  BUILTIN_TTSR_RULE_SETS,
  SECURITY_TTSR_RULES,
  QUALITY_TTSR_RULES,
  COMMANDER_TTSR_RULES,
} from './ttsrEngine';
export type {
  TtsrRule,
  TtsrRuleSet,
  TtsrRuleMode,
  TtsrMatchResult,
  TtsrSessionState,
  TtsrInterceptResult,
} from './ttsrEngine';

// UniversalSanitizer & ResourceGovernor — unified sanitization and outbound-call governance
export { UniversalSanitizer, ResourceGovernor, IntegrityLayer } from './securityPrimitives';
export type { SignedEntry } from './securityPrimitives';

// WS9 audit-chain integrity (manifest + fail-closed persistor).
// Runtime wiring: installAuditChainIntegrity() when COMMANDER_AUDIT_MANIFEST_DIR is set.
export {
  ChainManifest,
  FailClosedPersistor,
  AsymmetricChainSigner,
  InMemoryKeyProvider,
  FileKeyProvider,
  verifyWithManifest,
  startVerifyTimer,
  installAuditChainIntegrity,
  resetAuditChainIntegrity,
} from './auditChainIntegrity';
export type { ChainHead, ManifestEntry, KeyProvider } from './auditChainIntegrity';

export {
  installOutboundNetworkPolicy,
  uninstallOutboundNetworkPolicy,
  resetOutboundNetworkPolicy,
  getOutboundNetworkPolicy,
  OutboundNetworkPolicy,
} from './outboundNetworkPolicy';
export type { OutboundNetworkPolicyConfig } from './outboundNetworkPolicy';
