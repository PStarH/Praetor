#!/usr/bin/env node

import { createPublicKey, type KeyObject } from 'node:crypto';
import { createReadStream, realpathSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createVerifiedPostgresPool } from '@praetor/postgres-runtime';
import { atomicExport } from './atomicExport.js';
import { parseShadowManifest, ShadowContractError, type ShadowManifestV1 } from './contracts.js';
import {
  buildSignedShadowReport,
  SHADOW_REPORT_TRUST_SCHEMA,
  verifyShadowReport,
  type ShadowReportTrust,
  type ShadowManifestTrust,
} from './report.js';
import {
  asShadowSqlPool,
  ShadowRepository,
  type ShadowCampaignReportData,
  type ShadowImportResult,
} from './repository.js';
import { loadShadowStartupConfig, type ShadowDatabaseOperation } from './startupConfig.js';

const MAX_NDJSON_LINE_BYTES = 16 * 1024;
const MAX_IMPORT_RECORDS = 10_000;
// The record cap only bounds the number of lines; without a byte cap a single
// unterminated line (or a file far larger than the record cap can ever consume)
// is read to EOF. Bound the stream itself to the largest payload the record cap
// can legitimately carry.
const MAX_IMPORT_BYTES = MAX_IMPORT_RECORDS * MAX_NDJSON_LINE_BYTES;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_REPORT_BYTES = 192 * 1024 * 1024;
const MAX_PUBLIC_KEY_BYTES = 64 * 1024;
const SOURCE_REVISION = /^[\x21-\x7e]{1,128}$/;
const TRUST_RECORD_KEYS = ['algorithm', 'keyId', 'publicKeyPem', 'schema', 'status'] as const;

// Only exact application-owned codes may cross the CLI error boundary.
const SAFE_ERROR_CODES = new Set([
  'SHADOW_INVALID_VALUE',
  'SHADOW_UNKNOWN_FIELD',
  'SHADOW_MISSING_FIELD',
  'SHADOW_INVALID_IDENTIFIER',
  'SHADOW_INVALID_SCHEMA',
  'SHADOW_UNSUPPORTED_WORKFLOW',
  'SHADOW_INVALID_DECISION',
  'SHADOW_INVALID_REASON_CODE',
  'SHADOW_INVALID_TIMESTAMP',
  'SHADOW_INVALID_DIGEST',
  'SHADOW_INVALID_SIGNATURE',
  'SHADOW_RECORD_LIMIT',
  'SHADOW_INDEX_SEQUENCE',
  'SHADOW_DUPLICATE_OBSERVATION',
  'SHADOW_SIZE_LIMIT',
  'SHADOW_SENSITIVE_DATA',
  'COMMANDER_SHADOW_DATABASE_URL_REQUIRED',
  'COMMANDER_SHADOW_TENANT_ID_REQUIRED',
  'COMMANDER_SHADOW_TENANT_ID_INVALID',
  'COMMANDER_SHADOW_TENANT_ID_PLACEHOLDER',
  'COMMANDER_SHADOW_RETENTION_DAYS_REQUIRED',
  'COMMANDER_SHADOW_RETENTION_DAYS_INVALID',
  'COMMANDER_SHADOW_TRUSTED_MANIFEST_KEYS_JSON_REQUIRED',
  'COMMANDER_SHADOW_TRUSTED_MANIFEST_KEYS_JSON_INVALID',
  'COMMANDER_SHADOW_MANIFEST_KEY_INVALID',
  'COMMANDER_SHADOW_REPORT_SIGNING_KEY_ID_REQUIRED',
  'COMMANDER_SHADOW_REPORT_SIGNING_KEY_ID_INVALID',
  'COMMANDER_SHADOW_REPORT_SIGNING_KEY_ID_PLACEHOLDER',
  'COMMANDER_SHADOW_REPORT_SIGNING_PRIVATE_KEY_PEM_REQUIRED',
  'COMMANDER_SHADOW_REPORT_SIGNING_PRIVATE_KEY_PEM_INVALID',
  'COMMANDER_SHADOW_CLEANUP_FRESHNESS_MINUTES_REQUIRED',
  'COMMANDER_SHADOW_CLEANUP_FRESHNESS_MINUTES_INVALID',
  'COMMANDER_SHADOW_INGESTION_ATTESTATION_KEY_HEX_INVALID',
  'COMMANDER_SHADOW_SOURCE_REVISION_INVALID',
  'COMMANDER_DATABASE_TLS_CA_FILE_REQUIRED',
  'COMMANDER_DATABASE_TLS_CA_FILE_UNREADABLE',
  'COMMANDER_DATABASE_TLS_CA_FILE_INVALID',
  'COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256_REQUIRED',
  'COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256_INVALID',
  'COMMANDER_DATABASE_DSN_INVALID',
  'COMMANDER_DATABASE_DSN_TLS_OPTION_FORBIDDEN',
  'COMMANDER_DATABASE_SSLMODE_VERIFY_FULL_REQUIRED',
  'COMMANDER_DATABASE_SERVER_CERTIFICATE_INVALID',
  'COMMANDER_DATABASE_SERVER_SPKI_MISMATCH',
  'SHADOW_INPUT_TOO_LARGE',
  'SHADOW_INPUT_NOT_REGULAR',
  'SHADOW_IMPORT_TOO_LARGE',
  'SHADOW_BATCH_NOT_DUE',
  'SHADOW_BATCH_NOT_FOUND',
  'SHADOW_BATCH_CLOSED',
  'SHADOW_CAMPAIGN_CLOSED',
  'SHADOW_CAMPAIGN_NOT_FOUND',
  'SHADOW_CAMPAIGN_NOT_OPEN',
  'SHADOW_INGESTION_ATTESTATION_KEY_REQUIRED',
  'SHADOW_INGESTION_ROLE_REQUIRED',
  'SHADOW_MANIFEST_KEY_INVALID',
  'SHADOW_MANIFEST_KEY_REVOKED',
  'SHADOW_MANIFEST_KEY_UNTRUSTED',
  'SHADOW_MANIFEST_SIGNATURE_INVALID',
  'SHADOW_POLICY_MISMATCH',
  'SHADOW_PRODUCER_MISMATCH',
  'SHADOW_TENANT_MISMATCH',
  'SHADOW_OBSERVATION_CONFLICT',
  'SHADOW_REPORT_CAMPAIGN_NOT_FOUND',
  'SHADOW_REPORT_BATCH_OPEN',
  'SHADOW_REPORT_NOT_TERMINAL',
  'SHADOW_EXPORT_PARENT_INVALID',
  'SHADOW_EXPORT_SYMLINK_FORBIDDEN',
  'SHADOW_REPORT_DATA_INVALID',
  'SHADOW_REPORT_RECORD_INVALID',
  'SHADOW_MANIFEST_DIGEST_MISMATCH',
  'SHADOW_REPORT_MANIFEST_RECORD_MISMATCH',
]);

export interface ShadowCliRepository {
  registerManifest(tenantId: string, manifest: ShadowManifestV1): Promise<{ idempotent: boolean }>;
  importObservation(
    tenantId: string,
    observation: unknown,
  ): Promise<ShadowImportResult | { idempotent: boolean }>;
  closeDueBatch(tenantId: string, campaignId: string, batchId: string): Promise<void>;
  readReport(tenantId: string, campaignId: string): Promise<ShadowCampaignReportData>;
  withdrawCampaign(tenantId: string, campaignId: string): Promise<void>;
  runRetention(tenantId: string): Promise<number>;
  readiness(
    tenantId: string,
    cleanupFreshnessMinutes: number,
    operation: ShadowDatabaseOperation,
  ): Promise<{ ready: boolean; code: string }>;
}

export interface ShadowCliDependencies {
  repository: ShadowCliRepository;
  tenantId: string;
  cleanupFreshnessMinutes: number;
  reportSigning?: { keyId: string; privateKey: KeyObject };
  manifestTrust: ReadonlyMap<string, ShadowManifestTrust>;
  sourceRevision?: string;
  now?: () => Date;
}

export interface ShadowCliResult {
  exitCode: 0 | 1;
  output: Record<string, unknown>;
}

type ParsedCommand =
  | { name: 'manifest-register'; file: string }
  | { name: 'import'; file: string }
  | { name: 'batch-close'; campaign: string; batch: string }
  | { name: 'report-export'; campaign: string; output: string }
  | { name: 'report-verify'; bundle: string; publicKey: string; manifestKeys: string }
  | { name: 'campaign-withdraw'; campaign: string; confirm: string }
  | { name: 'retention-run' }
  | { name: 'status' };

function ok(code: string, fields: Record<string, unknown> = {}): ShadowCliResult {
  return { exitCode: 0, output: { status: 'ok', code, ...fields } };
}

function failure(code: string, fields: Record<string, unknown> = {}): ShadowCliResult {
  return { exitCode: 1, output: { status: 'error', code, ...fields } };
}

function options(argv: string[], names: readonly string[]): Record<string, string> | null {
  if (argv.length !== names.length * 2) return null;
  const allowed = new Set(names);
  const result: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || !value || value.startsWith('--')) return null;
    const name = flag.slice(2);
    if (!allowed.has(name) || result[name] !== undefined) return null;
    result[name] = value;
  }
  return names.every((name) => result[name] !== undefined) ? result : null;
}

function parseCommand(argv: string[]): ParsedCommand | null {
  const [first, second, ...rest] = argv;
  if (first === 'manifest' && second === 'register') {
    const parsed = options(rest, ['file']);
    return parsed ? { name: 'manifest-register', file: parsed.file! } : null;
  }
  if (first === 'import') {
    const parsed = options(
      [second, ...rest].filter((value): value is string => value !== undefined),
      ['file'],
    );
    return parsed ? { name: 'import', file: parsed.file! } : null;
  }
  if (first === 'batch' && second === 'close') {
    const parsed = options(rest, ['campaign', 'batch']);
    return parsed
      ? { name: 'batch-close', campaign: parsed.campaign!, batch: parsed.batch! }
      : null;
  }
  if (first === 'report' && second === 'export') {
    const parsed = options(rest, ['campaign', 'output']);
    return parsed
      ? { name: 'report-export', campaign: parsed.campaign!, output: parsed.output! }
      : null;
  }
  if (first === 'report' && second === 'verify') {
    const parsed = options(rest, ['bundle', 'public-key', 'manifest-keys']);
    return parsed
      ? {
          name: 'report-verify',
          bundle: parsed.bundle!,
          publicKey: parsed['public-key']!,
          manifestKeys: parsed['manifest-keys']!,
        }
      : null;
  }
  if (first === 'campaign' && second === 'withdraw') {
    const parsed = options(rest, ['campaign', 'confirm']);
    return parsed
      ? { name: 'campaign-withdraw', campaign: parsed.campaign!, confirm: parsed.confirm! }
      : null;
  }
  if (first === 'retention' && second === 'run' && rest.length === 0)
    return { name: 'retention-run' };
  if (first === 'status' && second === undefined && rest.length === 0) return { name: 'status' };
  return null;
}

async function readBoundedFile(path: string, maximumBytes: number): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error('SHADOW_INPUT_NOT_REGULAR');
    if (stats.size > maximumBytes) throw new Error('SHADOW_INPUT_TOO_LARGE');
    const contents = await handle.readFile();
    if (contents.length > maximumBytes) throw new Error('SHADOW_INPUT_TOO_LARGE');
    return contents;
  } finally {
    await handle.close();
  }
}

async function readJson(path: string, maximumBytes: number): Promise<unknown> {
  return JSON.parse((await readBoundedFile(path, maximumBytes)).toString('utf8')) as unknown;
}

async function* ndjsonLines(
  path: string,
  maximumBytes: number,
): AsyncGenerator<{ line?: Buffer; rejected: boolean }, void, undefined> {
  const stream = createReadStream(path);
  let pieces: Buffer[] = [];
  let pendingBytes = 0;
  let overflow = false;
  let consumedBytes = 0;

  for await (const value of stream) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    consumedBytes += chunk.length;
    if (consumedBytes > maximumBytes) {
      // Stop reading rather than draining an unbounded file to EOF. Throwing
      // here also closes the read stream through the for-await protocol.
      throw new Error('SHADOW_IMPORT_TOO_LARGE');
    }
    let start = 0;
    for (let index = 0; index < chunk.length; index += 1) {
      if (chunk[index] !== 0x0a) continue;
      const piece = chunk.subarray(start, index);
      if (!overflow && pendingBytes + piece.length <= MAX_NDJSON_LINE_BYTES) {
        pieces.push(piece);
        pendingBytes += piece.length;
      } else {
        overflow = true;
      }
      yield overflow
        ? { rejected: true }
        : { line: Buffer.concat(pieces, pendingBytes), rejected: false };
      pieces = [];
      pendingBytes = 0;
      overflow = false;
      start = index + 1;
    }
    const tail = chunk.subarray(start);
    if (overflow) continue;
    if (pendingBytes + tail.length <= MAX_NDJSON_LINE_BYTES) {
      pieces.push(tail);
      pendingBytes += tail.length;
    } else {
      pieces = [];
      pendingBytes = 0;
      overflow = true;
    }
  }
  if (overflow) yield { rejected: true };
  else if (pendingBytes > 0) yield { line: Buffer.concat(pieces, pendingBytes), rejected: false };
}

async function verifyReport(command: Extract<ParsedCommand, { name: 'report-verify' }>) {
  const bundle = await readJson(command.bundle, MAX_REPORT_BYTES);
  const value = await readJson(command.publicKey, MAX_PUBLIC_KEY_BYTES);
  const manifestValues = await readJson(command.manifestKeys, MAX_PUBLIC_KEY_BYTES);
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return failure('SHADOW_REPORT_KEY_INVALID');
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join('\0') !== [...TRUST_RECORD_KEYS].sort().join('\0') ||
    record.schema !== SHADOW_REPORT_TRUST_SCHEMA ||
    record.algorithm !== 'Ed25519' ||
    !SOURCE_REVISION.test(typeof record.keyId === 'string' ? record.keyId : '') ||
    (record.status !== 'active' && record.status !== 'revoked') ||
    typeof record.publicKeyPem !== 'string'
  )
    return failure('SHADOW_REPORT_KEY_INVALID');
  const keyId = record.keyId as string;
  const status = record.status as 'active' | 'revoked';
  const publicKeyPem = record.publicKeyPem as string;
  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey(publicKeyPem);
  } catch {
    return failure('SHADOW_REPORT_KEY_INVALID');
  }
  const trust: ShadowReportTrust = {
    algorithm: 'Ed25519',
    keyId,
    status,
    publicKey,
  };
  if (!Array.isArray(manifestValues) || manifestValues.length === 0)
    return failure('SHADOW_REPORT_MANIFEST_KEY_INVALID');
  const manifestTrust = new Map<string, ShadowManifestTrust>();
  for (const value of manifestValues) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      return failure('SHADOW_REPORT_MANIFEST_KEY_INVALID');
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).sort().join('\0') !==
        ['algorithm', 'keyId', 'publicKeyPem', 'status'].sort().join('\0') ||
      record.algorithm !== 'Ed25519' ||
      !SOURCE_REVISION.test(typeof record.keyId === 'string' ? record.keyId : '') ||
      (record.status !== 'active' && record.status !== 'revoked') ||
      typeof record.publicKeyPem !== 'string' ||
      manifestTrust.has(record.keyId as string)
    )
      return failure('SHADOW_REPORT_MANIFEST_KEY_INVALID');
    let manifestPublicKey: KeyObject;
    try {
      manifestPublicKey = createPublicKey(record.publicKeyPem);
      if (manifestPublicKey.asymmetricKeyType !== 'ed25519') throw new Error('wrong type');
    } catch {
      return failure('SHADOW_REPORT_MANIFEST_KEY_INVALID');
    }
    manifestTrust.set(record.keyId as string, {
      algorithm: 'Ed25519',
      keyId: record.keyId as string,
      status: record.status,
      publicKey: manifestPublicKey,
    });
  }
  const verification = verifyShadowReport(bundle, trust, manifestTrust);
  return verification.valid ? ok(verification.code) : failure(verification.code);
}

async function importObservations(
  file: string,
  dependencies: ShadowCliDependencies,
): Promise<ShadowCliResult> {
  let imported = 0;
  let existing = 0;
  let rejected = 0;
  let seen = 0;
  let truncated = false;
  for await (const item of ndjsonLines(file, MAX_IMPORT_BYTES)) {
    seen += 1;
    if (seen > MAX_IMPORT_RECORDS) {
      // The record cap is a bound on the work, not a per-line rejection: stop
      // reading and report the truncation explicitly instead of counting the
      // rest of an unbounded file as `rejected`.
      truncated = true;
      break;
    }
    if (item.rejected || !item.line || item.line.length === 0) {
      rejected += 1;
      continue;
    }
    let observation: unknown;
    try {
      observation = JSON.parse(item.line.toString('utf8')) as unknown;
    } catch {
      rejected += 1;
      continue;
    }
    try {
      const result = await dependencies.repository.importObservation(
        dependencies.tenantId,
        observation,
      );
      // An idempotent replay wrote nothing, so it must not be reported as a
      // fresh import; operators use `imported` as evidence that rows landed.
      if (result.idempotent) existing += 1;
      else imported += 1;
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (
        /^(?:SHADOW_(?:INVALID|UNKNOWN|MISSING|SIZE|UNSUPPORTED)|SHADOW_SENSITIVE_DATA|SHADOW_DIGEST_MISMATCH|SHADOW_EVALUATION_FAILED)/.test(
          code,
        )
      ) {
        rejected += 1;
        continue;
      }
      throw error;
    }
  }
  const counts = { imported, existing, rejected };
  // A file with no lines at all (truncated export, unwritten file) is not a
  // successful import of zero rows; it is an empty input that must fail closed.
  if (seen === 0) return failure('SHADOW_IMPORT_EMPTY', counts);
  if (truncated) return failure('SHADOW_IMPORT_TRUNCATED', counts);
  return rejected === 0
    ? ok('SHADOW_IMPORT_COMPLETE', counts)
    : failure('SHADOW_IMPORT_PARTIAL', counts);
}

async function execute(command: ParsedCommand, dependencies: ShadowCliDependencies) {
  if (command.name === 'report-verify') return verifyReport(command);
  const readiness = await dependencies.repository.readiness(
    dependencies.tenantId,
    dependencies.cleanupFreshnessMinutes,
    command.name,
  );
  if (!readiness.ready) return failure(readiness.code);
  switch (command.name) {
    case 'manifest-register': {
      const manifest = parseShadowManifest(await readJson(command.file, MAX_MANIFEST_BYTES));
      const result = await dependencies.repository.registerManifest(
        dependencies.tenantId,
        manifest,
      );
      return ok(
        result.idempotent ? 'SHADOW_MANIFEST_ALREADY_REGISTERED' : 'SHADOW_MANIFEST_REGISTERED',
      );
    }
    case 'import':
      return importObservations(command.file, dependencies);
    case 'batch-close':
      await dependencies.repository.closeDueBatch(
        dependencies.tenantId,
        command.campaign,
        command.batch,
      );
      return ok('SHADOW_BATCH_CLOSED');
    case 'report-export': {
      if (!dependencies.reportSigning)
        return failure('COMMANDER_SHADOW_REPORT_SIGNING_PRIVATE_KEY_PEM_REQUIRED');
      if (!dependencies.sourceRevision || !SOURCE_REVISION.test(dependencies.sourceRevision))
        return failure('COMMANDER_SHADOW_SOURCE_REVISION_INVALID');
      const data = await dependencies.repository.readReport(
        dependencies.tenantId,
        command.campaign,
      );
      const report = buildSignedShadowReport(data, {
        keyId: dependencies.reportSigning.keyId,
        privateKey: dependencies.reportSigning.privateKey,
        generatedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
        sourceRevision: dependencies.sourceRevision,
        manifestTrust: dependencies.manifestTrust,
      });
      atomicExport(command.output, `${JSON.stringify(report)}\n`);
      return ok('SHADOW_REPORT_EXPORTED');
    }
    case 'campaign-withdraw':
      if (command.confirm !== command.campaign)
        return failure('SHADOW_WITHDRAW_CONFIRMATION_REQUIRED');
      await dependencies.repository.withdrawCampaign(dependencies.tenantId, command.campaign);
      return ok('SHADOW_CAMPAIGN_WITHDRAWN');
    case 'retention-run': {
      const deleted = await dependencies.repository.runRetention(dependencies.tenantId);
      return ok('SHADOW_RETENTION_COMPLETE', { deleted });
    }
    case 'status': {
      return ok(readiness.code);
    }
  }
}

async function productionDependencies(operation: ShadowDatabaseOperation): Promise<{
  dependencies: ShadowCliDependencies;
  close: () => Promise<void>;
}> {
  const config = loadShadowStartupConfig(operation);
  const sourceRevision =
    operation === 'report-export'
      ? process.env.COMMANDER_SHADOW_SOURCE_REVISION?.trim()
      : undefined;
  if (operation === 'report-export' && (!sourceRevision || !SOURCE_REVISION.test(sourceRevision))) {
    throw new Error('COMMANDER_SHADOW_SOURCE_REVISION_INVALID');
  }
  const pool = createVerifiedPostgresPool(config.poolInput);
  return {
    dependencies: {
      repository: new ShadowRepository(asShadowSqlPool(pool), {
        retentionDays: config.retentionDays,
        ...(config.ingestionAttestationKey
          ? { ingestionAttestationKey: config.ingestionAttestationKey }
          : {}),
        trustedManifestPublicKeys: config.trustedManifestPublicKeys,
      }),
      tenantId: config.tenantId,
      cleanupFreshnessMinutes: config.cleanupFreshnessMinutes,
      ...(config.reportSigning ? { reportSigning: config.reportSigning } : {}),
      manifestTrust: config.trustedManifestPublicKeys,
      ...(sourceRevision ? { sourceRevision } : {}),
    },
    close: () => pool.end(),
  };
}

export async function runShadowCli(
  argv: string[],
  injectedDependencies?: ShadowCliDependencies,
): Promise<ShadowCliResult> {
  const command = parseCommand(argv);
  if (!command) return failure('SHADOW_USAGE_INVALID');
  try {
    if (command.name === 'report-verify') return await verifyReport(command);
    if (injectedDependencies) return await execute(command, injectedDependencies);
    const production = await productionDependencies(command.name);
    try {
      return await execute(command, production.dependencies);
    } finally {
      await production.close();
    }
  } catch (error) {
    const code =
      error instanceof ShadowContractError
        ? error.code
        : error instanceof Error
          ? error.message
          : '';
    return failure(SAFE_ERROR_CODES.has(code) ? code : 'SHADOW_COMMAND_FAILED');
  }
}

async function main(): Promise<void> {
  const result = await runShadowCli(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result.output)}\n`);
  process.exitCode = result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  void main();
}
