/**
 * Compatibility re-export — canonical factory lives in ./gap/gapPlugin.
 * Prefer: import { createGapPlugin } from './gap/gapPlugin' or '@praetor/core'.
 */
export {
  createGapPlugin,
  GapRegistry,
  IssueAutoCreate,
  SlaEnforcer,
  computeMetrics,
  loadGapConfig,
  appendNdjson,
  readNdjson,
  ensureDir,
  runQuarterlyAudit,
  saveAuditReport,
  renderAuditMarkdown,
  isCritical,
  isOverdue,
  computeSlaDeadline,
  computeRepairDeadline,
} from './gap/gapPlugin';
export type {
  RecordGapInput,
  ListFilter,
  IssueDraft,
  CreateResult,
  SlaEnforcerDeps,
  GapMetrics,
  GapConfig,
  AuditReport,
  GapEntry,
  GapSource,
  GapSeverity,
  GapStatus,
  GapRegressionCheck,
} from './gap/gapPlugin';
