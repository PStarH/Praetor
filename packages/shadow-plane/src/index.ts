export {
  SHADOW_MANIFEST_SCHEMA,
  SHADOW_OBSERVATION_SCHEMA,
  SHADOW_PRODUCTION_DECISIONS,
  SHADOW_PRODUCTION_REASON_CODES,
  SHADOW_WORKFLOW,
  ShadowContractError,
  parseShadowManifest,
  parseShadowObservation,
} from './contracts.js';
export type {
  ShadowContractErrorCode,
  ShadowManifestRecordV1,
  ShadowManifestV1,
  ShadowObservationV1,
  ShadowProductionDecision,
  ShadowProductionReasonCode,
} from './contracts.js';
export { canonicalBytes, sha256Hex, verifyEd25519 } from './canonical.js';
export { actionGatewayPolicySnapshot } from '@praetor/contracts';
export { evaluateShadowObservation, observationDigest } from './evaluator.js';
export type { ShadowEvaluation, ShadowHypotheticalDecision, ShadowPolicyPin } from './evaluator.js';
export { compareShadowDecision } from './comparison.js';
export type { ShadowComparison } from './comparison.js';
export { SHADOW_SCHEMA_SQL, SHADOW_SCHEMA_VERSION } from './schema.js';
export { asShadowSqlPool, ShadowRepository } from './repository.js';
export type {
  ShadowCampaignReportData,
  ShadowDatabaseOperation,
  ShadowImportResult,
  ShadowRepositoryOptions,
  ShadowSqlClient,
  ShadowSqlPool,
  ShadowSqlResult,
} from './repository.js';
export { loadShadowStartupConfig } from './startupConfig.js';
export type { ShadowStartupConfig } from './startupConfig.js';
export { atomicExport } from './atomicExport.js';
export {
  buildSignedShadowReport,
  SHADOW_REPORT_SCHEMA,
  SHADOW_REPORT_TRUST_SCHEMA,
  verifyShadowReport,
} from './report.js';
export type {
  ShadowDecisionMatrix,
  ShadowReportBundle,
  ShadowReportCounts,
  ShadowManifestTrust,
  ShadowReportRecord,
  ShadowReportSigningOptions,
  ShadowReportTrust,
  ShadowTerminalStatus,
} from './report.js';
