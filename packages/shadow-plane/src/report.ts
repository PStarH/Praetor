import { sign, type KeyObject } from 'node:crypto';
import { actionGatewayPolicySnapshot } from '@praetor/contracts';
import { canonicalBytes, sha256Hex, verifyEd25519 } from './canonical.js';
import {
  parseShadowManifest,
  parseShadowObservation,
  type ShadowManifestV1,
  type ShadowObservationV1,
  type ShadowProductionDecision,
} from './contracts.js';
import { compareShadowDecision, type ShadowComparison } from './comparison.js';
import {
  evaluateShadowObservation,
  observationDigest,
  type ShadowHypotheticalDecision,
} from './evaluator.js';
import type { ShadowCampaignReportData } from './repository.js';

export const SHADOW_REPORT_SCHEMA = 'commander.shadow-report/v1' as const;
export const SHADOW_REPORT_TRUST_SCHEMA = 'commander.shadow-report-trust/v1' as const;

export type ShadowTerminalStatus = 'missing' | 'rejected' | 'failed' | 'uncomparable' | 'compared';

export interface ShadowReportRecord {
  batchId: string;
  index: number;
  observationId: string;
  digest: string;
  status: ShadowTerminalStatus;
  attempt?: { digest: string; code: string; attemptedAt: string };
  facts?: ShadowObservationV1;
  hypotheticalDecision?: ShadowHypotheticalDecision;
  hypotheticalDecisionId?: string;
  hypotheticalReasonCode?: string;
  productionDecision?: ShadowProductionDecision;
  productionReasonCode?: string;
  comparison?: ShadowComparison;
}

export interface ShadowReportCounts {
  expected: number;
  missing: number;
  rejected: number;
  failed: number;
  uncomparable: number;
  compared: number;
  matches: number;
  mismatches: number;
}

type MatrixRow = Record<'allow' | 'deny' | 'require_approval', number>;
export type ShadowDecisionMatrix = Record<'allow' | 'deny' | 'require_approval', MatrixRow>;

export interface ShadowReportBundle {
  schema: typeof SHADOW_REPORT_SCHEMA;
  generatedAt: string;
  sourceRevision: string;
  evaluatorVersion: 'shadow-evaluator-v1';
  campaignId: string;
  policySnapshot: ReturnType<typeof actionGatewayPolicySnapshot>;
  manifests: ShadowManifestV1[];
  records: ShadowReportRecord[];
  counts: ShadowReportCounts;
  decisionMatrix: ShadowDecisionMatrix;
  differences: Array<{
    observationId: string;
    productionDecision: ShadowProductionDecision;
    hypotheticalDecision: ShadowHypotheticalDecision;
    productionReasonCode?: string;
    hypotheticalReasonCode: string;
    policyDigest: string;
  }>;
  hashes: { manifestsSha256: string; recordsSha256: string; policySha256: string };
  keyId: string;
  signature: string;
}

export interface ShadowReportSigningOptions {
  keyId: string;
  privateKey: KeyObject;
  generatedAt: string;
  sourceRevision: string;
  manifestTrust: ReadonlyMap<string, ShadowManifestTrust>;
}

export interface ShadowReportTrust {
  algorithm: 'Ed25519';
  keyId: string;
  status: 'active' | 'revoked';
  publicKey: KeyObject;
}

export type ShadowManifestTrust = ShadowReportTrust;

const TERMINAL = new Set<ShadowTerminalStatus>([
  'missing',
  'rejected',
  'failed',
  'uncomparable',
  'compared',
]);
const COMPARABLE = ['allow', 'deny', 'require_approval'] as const;
const HYPOTHETICAL = [...COMPARABLE, 'insufficient_evidence'] as const;
const PRODUCTION = [...COMPARABLE, 'unknown'] as const;
const COMPARISONS = ['match', 'mismatch', 'uncomparable'] as const;
const ATTEMPT_ROW_FIELDS = ['attempt_digest', 'attempt_code', 'attempted_at'] as const;
const DECISION_ROW_FIELDS = [
  'canonical_observation',
  'hypothetical_decision',
  'hypothetical_decision_id',
  'hypothetical_reason_code',
  'production_decision',
  'production_reason_code',
  'comparison',
] as const;
const REPORT_BASE_KEYS = ['batchId', 'digest', 'index', 'observationId', 'status'] as const;

function stringField(row: Record<string, unknown>, name: string): string {
  const value = row[name];
  if (typeof value !== 'string') throw new Error('SHADOW_REPORT_DATA_INVALID');
  return value;
}

function integerField(row: Record<string, unknown>, name: string): number {
  const value = row[name];
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Error('SHADOW_REPORT_DATA_INVALID');
  return value as number;
}

function digestField(row: Record<string, unknown>, name: string): string {
  const value = stringField(row, name);
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error('SHADOW_REPORT_DATA_INVALID');
  return value;
}

function timestampField(row: Record<string, unknown>, name: string): string {
  const raw = row[name];
  const value = raw instanceof Date ? raw.toISOString() : raw;
  if (typeof value !== 'string') throw new Error('SHADOW_REPORT_DATA_INVALID');
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value)
    throw new Error('SHADOW_REPORT_DATA_INVALID');
  return value;
}

function absentRowFields(row: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.every((field) => row[field] === null || row[field] === undefined);
}

function exactObjectKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const expected = [...allowed].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function reportRecordInvalid(): never {
  throw new Error('SHADOW_REPORT_RECORD_INVALID');
}

function manifestTrustError(
  manifest: ShadowManifestV1,
  trust: ReadonlyMap<string, ShadowManifestTrust>,
): string | null {
  const record = trust.get(manifest.keyId);
  if (!record) return 'SHADOW_MANIFEST_KEY_UNTRUSTED';
  if (record.status === 'revoked') return 'SHADOW_MANIFEST_KEY_REVOKED';
  if (
    record.status !== 'active' ||
    record.algorithm !== 'Ed25519' ||
    record.keyId !== manifest.keyId ||
    record.publicKey.asymmetricKeyType !== 'ed25519'
  ) {
    return 'SHADOW_MANIFEST_KEY_INVALID';
  }
  const { signature, ...signedBody } = manifest;
  return verifyEd25519(signedBody, signature, record.publicKey)
    ? null
    : 'SHADOW_MANIFEST_SIGNATURE_INVALID';
}

function emptyMatrix(): ShadowDecisionMatrix {
  return {
    allow: { allow: 0, deny: 0, require_approval: 0 },
    deny: { allow: 0, deny: 0, require_approval: 0 },
    require_approval: { allow: 0, deny: 0, require_approval: 0 },
  };
}

function reportRecords(rows: Record<string, unknown>[]): ShadowReportRecord[] {
  return rows.map((row) => {
    const status = stringField(row, 'status') as ShadowTerminalStatus;
    if (!TERMINAL.has(status)) throw new Error('SHADOW_REPORT_NOT_TERMINAL');
    const base: ShadowReportRecord = {
      batchId: stringField(row, 'batch_id'),
      index: integerField(row, 'record_index'),
      observationId: stringField(row, 'observation_id'),
      digest: digestField(row, 'digest'),
      status,
    };
    if (status === 'missing') {
      if (!absentRowFields(row, [...ATTEMPT_ROW_FIELDS, ...DECISION_ROW_FIELDS])) {
        reportRecordInvalid();
      }
      return base;
    }
    if (status === 'rejected' || status === 'failed') {
      if (!absentRowFields(row, DECISION_ROW_FIELDS)) reportRecordInvalid();
      return {
        ...base,
        attempt: {
          digest: digestField(row, 'attempt_digest'),
          code: stringField(row, 'attempt_code'),
          attemptedAt: timestampField(row, 'attempted_at'),
        },
      };
    }
    if (!absentRowFields(row, ATTEMPT_ROW_FIELDS)) reportRecordInvalid();
    const facts = parseShadowObservation(row.canonical_observation);
    const record: ShadowReportRecord = {
      ...base,
      facts,
      hypotheticalDecision: stringField(row, 'hypothetical_decision') as ShadowHypotheticalDecision,
      hypotheticalDecisionId: stringField(row, 'hypothetical_decision_id'),
      hypotheticalReasonCode: stringField(row, 'hypothetical_reason_code'),
      productionDecision: stringField(row, 'production_decision') as ShadowProductionDecision,
      ...(typeof row.production_reason_code === 'string'
        ? { productionReasonCode: row.production_reason_code }
        : {}),
      comparison: stringField(row, 'comparison') as ShadowComparison,
    };
    validateReportRecord(record);
    return record;
  });
}

function validateReportRecord(value: unknown): asserts value is ShadowReportRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) reportRecordInvalid();
  const record = value as Record<string, unknown>;
  const status = record.status;
  if (typeof status !== 'string' || !TERMINAL.has(status as ShadowTerminalStatus)) {
    reportRecordInvalid();
  }
  if (
    typeof record.batchId !== 'string' ||
    typeof record.observationId !== 'string' ||
    !Number.isSafeInteger(record.index) ||
    (record.index as number) < 0 ||
    typeof record.digest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(record.digest)
  ) {
    reportRecordInvalid();
  }
  if (status === 'missing') {
    if (!exactObjectKeys(record, REPORT_BASE_KEYS)) reportRecordInvalid();
    return;
  }
  if (status === 'rejected' || status === 'failed') {
    if (!exactObjectKeys(record, [...REPORT_BASE_KEYS, 'attempt'])) reportRecordInvalid();
    const attempt = record.attempt;
    if (attempt === null || typeof attempt !== 'object' || Array.isArray(attempt)) {
      reportRecordInvalid();
    }
    const fields = attempt as Record<string, unknown>;
    const time = typeof fields.attemptedAt === 'string' ? Date.parse(fields.attemptedAt) : NaN;
    if (
      !exactObjectKeys(fields, ['attemptedAt', 'code', 'digest']) ||
      typeof fields.digest !== 'string' ||
      !/^[0-9a-f]{64}$/.test(fields.digest) ||
      typeof fields.code !== 'string' ||
      typeof fields.attemptedAt !== 'string' ||
      !Number.isFinite(time) ||
      new Date(time).toISOString() !== fields.attemptedAt
    ) {
      reportRecordInvalid();
    }
    return;
  }

  const facts = parseShadowObservation(record.facts);
  const hasProductionReason = Object.hasOwn(record, 'productionReasonCode');
  const expectedKeys = [
    ...REPORT_BASE_KEYS,
    'facts',
    'hypotheticalDecision',
    'hypotheticalDecisionId',
    'hypotheticalReasonCode',
    'productionDecision',
    'comparison',
    ...(hasProductionReason ? ['productionReasonCode'] : []),
  ];
  if (
    !exactObjectKeys(record, expectedKeys) ||
    !HYPOTHETICAL.includes(record.hypotheticalDecision as (typeof HYPOTHETICAL)[number]) ||
    typeof record.hypotheticalDecisionId !== 'string' ||
    typeof record.hypotheticalReasonCode !== 'string' ||
    !PRODUCTION.includes(record.productionDecision as (typeof PRODUCTION)[number]) ||
    !COMPARISONS.includes(record.comparison as (typeof COMPARISONS)[number]) ||
    (hasProductionReason && typeof record.productionReasonCode !== 'string') ||
    record.productionDecision !== facts.productionDecision ||
    record.productionReasonCode !== facts.productionReasonCode ||
    observationDigest(facts) !== record.digest
  ) {
    reportRecordInvalid();
  }
  const snapshot = actionGatewayPolicySnapshot();
  const evaluation = evaluateShadowObservation(facts, {
    policyId: snapshot.policyId,
    policyDigest: snapshot.descriptorDigest,
    expectedDigest: record.digest as string,
  });
  const comparison = compareShadowDecision(facts.productionDecision, evaluation.decision);
  if (
    record.hypotheticalDecision !== evaluation.decision ||
    record.hypotheticalDecisionId !== evaluation.decisionId ||
    record.hypotheticalReasonCode !== evaluation.reasonCode ||
    record.comparison !== comparison ||
    (status === 'compared' && comparison === 'uncomparable') ||
    (status === 'uncomparable' && comparison !== 'uncomparable')
  ) {
    reportRecordInvalid();
  }
}

function aggregate(records: ShadowReportRecord[], policyDigest: string) {
  const counts: ShadowReportCounts = {
    expected: records.length,
    missing: 0,
    rejected: 0,
    failed: 0,
    uncomparable: 0,
    compared: 0,
    matches: 0,
    mismatches: 0,
  };
  const matrix = emptyMatrix();
  const differences: ShadowReportBundle['differences'] = [];
  for (const record of records) {
    counts[record.status] += 1;
    if (record.status === 'compared') {
      if (record.comparison === 'match') counts.matches += 1;
      else if (record.comparison === 'mismatch') counts.mismatches += 1;
      else throw new Error('SHADOW_REPORT_COMPARISON_INVALID');
      if (
        record.productionDecision &&
        record.productionDecision !== 'unknown' &&
        record.hypotheticalDecision &&
        record.hypotheticalDecision !== 'insufficient_evidence'
      )
        matrix[record.productionDecision][record.hypotheticalDecision] += 1;
      if (record.comparison === 'mismatch') {
        differences.push({
          observationId: record.observationId,
          productionDecision: record.productionDecision!,
          hypotheticalDecision: record.hypotheticalDecision!,
          ...(record.productionReasonCode
            ? { productionReasonCode: record.productionReasonCode }
            : {}),
          hypotheticalReasonCode: record.hypotheticalReasonCode!,
          policyDigest,
        });
      }
    }
  }
  return { counts, matrix, differences };
}

function validateManifestRecordBinding(
  report: Pick<ShadowReportBundle, 'manifests' | 'records' | 'campaignId' | 'policySnapshot'>,
): boolean {
  const expected = new Map<
    string,
    { observationId: string; digest: string; tenantId: string; producerId: string }
  >();
  let tenantId: string | null = null;
  let producerId: string | null = null;
  for (const rawManifest of report.manifests) {
    const manifest = parseShadowManifest(rawManifest);
    if (
      manifest.campaignId !== report.campaignId ||
      manifest.policyId !== report.policySnapshot.policyId ||
      manifest.policyDigest !== report.policySnapshot.descriptorDigest
    )
      return false;
    if (tenantId === null || producerId === null) {
      tenantId = manifest.tenantId;
      producerId = manifest.producerId;
    } else if (manifest.tenantId !== tenantId || manifest.producerId !== producerId) {
      return false;
    }
    for (const record of manifest.records) {
      const key = `${manifest.batchId}\u0000${record.index}`;
      if (expected.has(key)) return false;
      expected.set(key, {
        observationId: record.observationId,
        digest: record.digest,
        tenantId: manifest.tenantId,
        producerId: manifest.producerId,
      });
    }
  }
  if (expected.size !== report.records.length) return false;
  const seen = new Set<string>();
  for (const record of report.records) {
    const key = `${record.batchId}\u0000${record.index}`;
    const declared = expected.get(key);
    if (
      !declared ||
      seen.has(key) ||
      declared.observationId !== record.observationId ||
      declared.digest !== record.digest
    )
      return false;
    seen.add(key);
    if (
      record.facts &&
      (record.facts.campaignId !== report.campaignId ||
        record.facts.tenantId !== declared.tenantId ||
        record.facts.producerId !== declared.producerId ||
        record.facts.batchId !== record.batchId ||
        record.facts.index !== record.index ||
        record.facts.observationId !== record.observationId)
    )
      return false;
  }
  return true;
}

export function buildSignedShadowReport(
  data: ShadowCampaignReportData,
  options: ShadowReportSigningOptions,
): ShadowReportBundle {
  if (!data.campaign) throw new Error('SHADOW_REPORT_CAMPAIGN_NOT_FOUND');
  if (data.batches.some((batch) => batch.state !== 'closed'))
    throw new Error('SHADOW_REPORT_BATCH_OPEN');
  const campaignId = stringField(data.campaign, 'campaign_id');
  const policyDigest = stringField(data.campaign, 'policy_digest');
  const snapshot = actionGatewayPolicySnapshot();
  if (data.campaign.policy_id !== snapshot.policyId || policyDigest !== snapshot.descriptorDigest) {
    throw new Error('SHADOW_POLICY_MISMATCH');
  }
  const manifests = data.batches.map((batch) => {
    const manifest = parseShadowManifest(batch.manifest);
    if (digestField(batch, 'manifest_digest') !== sha256Hex(canonicalBytes(manifest))) {
      throw new Error('SHADOW_MANIFEST_DIGEST_MISMATCH');
    }
    const trustError = manifestTrustError(manifest, options.manifestTrust);
    if (trustError) throw new Error(trustError);
    return manifest;
  });
  const records = reportRecords(data.records);
  if (
    !validateManifestRecordBinding({ manifests, records, campaignId, policySnapshot: snapshot })
  ) {
    throw new Error('SHADOW_REPORT_MANIFEST_RECORD_MISMATCH');
  }
  const { counts, matrix, differences } = aggregate(records, policyDigest);
  const hashes = {
    manifestsSha256: sha256Hex(canonicalBytes(manifests)),
    recordsSha256: sha256Hex(canonicalBytes(records)),
    policySha256: sha256Hex(canonicalBytes(snapshot)),
  };
  const unsigned = {
    schema: SHADOW_REPORT_SCHEMA,
    generatedAt: options.generatedAt,
    sourceRevision: options.sourceRevision,
    evaluatorVersion: 'shadow-evaluator-v1' as const,
    campaignId,
    policySnapshot: snapshot,
    manifests,
    records,
    counts,
    decisionMatrix: matrix,
    differences,
    hashes,
    keyId: options.keyId,
  };
  return {
    ...unsigned,
    signature: sign(null, canonicalBytes(unsigned), options.privateKey).toString('base64url'),
  };
}

export function verifyShadowReport(
  value: unknown,
  trust: ShadowReportTrust,
  manifestTrust: ReadonlyMap<string, ShadowManifestTrust>,
): { valid: boolean; code: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return { valid: false, code: 'SHADOW_REPORT_INVALID' };
  const report = value as ShadowReportBundle;
  if (
    report.schema !== SHADOW_REPORT_SCHEMA ||
    typeof report.keyId !== 'string' ||
    typeof report.signature !== 'string'
  ) {
    return { valid: false, code: 'SHADOW_REPORT_INVALID' };
  }
  if (trust.algorithm !== 'Ed25519' || trust.publicKey.asymmetricKeyType !== 'ed25519')
    return { valid: false, code: 'SHADOW_REPORT_KEY_INVALID' };
  if (trust.status === 'revoked') return { valid: false, code: 'SHADOW_REPORT_KEY_REVOKED' };
  if (trust.status !== 'active') return { valid: false, code: 'SHADOW_REPORT_KEY_INVALID' };
  if (report.keyId !== trust.keyId) return { valid: false, code: 'SHADOW_REPORT_KEY_ID_MISMATCH' };
  const { signature, ...signedBody } = report;
  if (!verifyEd25519(signedBody, signature, trust.publicKey))
    return { valid: false, code: 'SHADOW_REPORT_SIGNATURE_INVALID' };
  try {
    if (!Array.isArray(report.manifests)) {
      return { valid: false, code: 'SHADOW_REPORT_INVALID' };
    }
    for (const rawManifest of report.manifests) {
      const manifest = parseShadowManifest(rawManifest);
      const trustError = manifestTrustError(manifest, manifestTrust);
      if (trustError) return { valid: false, code: `SHADOW_REPORT_${trustError.slice(7)}` };
    }
    if (
      report.hashes.manifestsSha256 !== sha256Hex(canonicalBytes(report.manifests)) ||
      report.hashes.recordsSha256 !== sha256Hex(canonicalBytes(report.records)) ||
      report.hashes.policySha256 !== sha256Hex(canonicalBytes(report.policySnapshot))
    )
      return { valid: false, code: 'SHADOW_REPORT_HASH_INVALID' };
    const snapshot = actionGatewayPolicySnapshot();
    if (canonicalBytes(report.policySnapshot).compare(canonicalBytes(snapshot)) !== 0) {
      return { valid: false, code: 'SHADOW_REPORT_POLICY_INVALID' };
    }
    try {
      if (!Array.isArray(report.records)) reportRecordInvalid();
      for (const record of report.records) validateReportRecord(record);
    } catch {
      return { valid: false, code: 'SHADOW_REPORT_RECORD_INVALID' };
    }
    const recomputed = aggregate(report.records, snapshot.descriptorDigest);
    if (canonicalBytes(recomputed.counts).compare(canonicalBytes(report.counts)) !== 0) {
      return { valid: false, code: 'SHADOW_REPORT_COUNTS_INVALID' };
    }
    if (
      canonicalBytes(recomputed.matrix).compare(canonicalBytes(report.decisionMatrix)) !== 0 ||
      canonicalBytes(recomputed.differences).compare(canonicalBytes(report.differences)) !== 0
    ) {
      return { valid: false, code: 'SHADOW_REPORT_AGGREGATES_INVALID' };
    }
    if (!validateManifestRecordBinding(report)) {
      return { valid: false, code: 'SHADOW_REPORT_MANIFEST_RECORD_MISMATCH' };
    }
    for (const record of report.records) {
      if (!record.facts) continue;
      if (observationDigest(record.facts) !== record.digest)
        return { valid: false, code: 'SHADOW_REPORT_RECORD_DIGEST_INVALID' };
      const evaluation = evaluateShadowObservation(record.facts, {
        policyId: snapshot.policyId,
        policyDigest: snapshot.descriptorDigest,
        expectedDigest: record.digest,
      });
      if (
        evaluation.decision !== record.hypotheticalDecision ||
        evaluation.decisionId !== record.hypotheticalDecisionId ||
        evaluation.reasonCode !== record.hypotheticalReasonCode ||
        compareShadowDecision(record.facts.productionDecision, evaluation.decision) !==
          record.comparison
      )
        return { valid: false, code: 'SHADOW_REPORT_REEVALUATION_INVALID' };
    }
    return { valid: true, code: 'SHADOW_REPORT_VALID' };
  } catch {
    return { valid: false, code: 'SHADOW_REPORT_INVALID' };
  }
}
