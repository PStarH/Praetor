#!/usr/bin/env tsx
/**
 * Authority closure live proof against real PostgreSQL.
 *
 * Fail-closed: every nested boolean must be true or exit 1 with evidenceLevel FAILED.
 * Skipped / soft-pass is not allowed.
 *
 * Usage (only against a provisioner-owned, run-scoped instance — see
 * ci-database-scope.ts; the proof applies migrations and re-passwords the five
 * non-owner deploy-gate roles, so it must never run against a shared cluster):
 *   export OWNER_DSN='postgres://<owner>:<password>@<host>:5432/<db>'
 *   export COMMANDER_KERNEL_DATABASE_URL="$OWNER_DSN"
 *   export COMMANDER_CI_INSTANCE_MUTATION=yes
 *   export COMMANDER_CI_INSTANCE_ID="<provisioner run id>"
 *   export COMMANDER_CI_PROVISION_TOKEN="<provisioner run credential>"
 *   export COMMANDER_CI_PASSWORD_COMMANDER_APP="<run-scoped password>"
 *   # ... one COMMANDER_CI_PASSWORD_* per deploy-gate role
 *   pnpm proof:authority
 */

import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import {
  DEPLOY_GATE_ROLES,
  assertProvisionedCiInstance,
  resolveRolePassword,
  type DeployGateRole,
} from './ci-database-scope.js';
import {
  CapabilityTokenIssuer,
  CapabilityTokenVerifier,
  EffectBroker,
  canonicalRequestHash,
} from '../packages/effect-broker/src/index.js';
import {
  createCapabilityAuthority,
  CAPABILITY_AUTHORITY_REQUIRED,
  CAPABILITY_JWKS_JSON_ENV,
  CAPABILITY_KEY_ID_ENV,
  CAPABILITY_PRIVATE_KEY_PEM_ENV,
  PostgresKernelRepository,
  runKernelMigrations,
  seedWorkerAllowedTenants,
  seedWorkerClaimSecret,
  KERNEL_COMPENSATION_TOPIC,
} from '../packages/kernel/src/index.js';
import { InMemoryKernelRepository } from '@praetor/kernel/testing/inMemoryRepository';
import {
  PostgresTenantContextAuthority,
  type SqlClient,
  type SqlPool,
} from '../packages/kernel/src/postgres.js';
import { TENANT_TABLES } from '../packages/kernel/src/schema.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACT_PATH = resolve(ROOT, '.superpowers/sdd/authority-closure-proof-latest.json');
const MANIFEST_PATH = resolve(
  ROOT,
  '.superpowers/sdd/authority-closure-proof-latest.manifest.json',
);
const LOG_PATH = resolve(ROOT, '.superpowers/sdd/authority-closure-proof-latest.log.json');
const EVIDENCE_PATH = resolve(
  ROOT,
  '.superpowers/sdd/authority-closure-proof-latest.evidence.json',
);
const SOURCE_MANIFEST_PATH = resolve(
  ROOT,
  '.superpowers/sdd/authority-closure-proof-latest.source.json',
);
/**
 * The proof used to fall back to a public default DSN on port 5433 with the
 * password equal to the user name, and to public default role passwords equal
 * to the role name. Both are gone: a missing DSN or password is a failure,
 * evaluated before any connection is opened.
 */

export interface AuthorityProofResult {
  gitSha: string;
  metadata: AuthorityProofMetadata;
  database: {
    rlsEnabled: boolean;
    rolesSeparated: boolean;
    workerDirectInsertRejected: boolean;
    workerDirectUpdateRejected: boolean;
    workerCrossTenantRegisterRejected: boolean;
    peerClaimWithoutSecretRejected: boolean;
    workerIdentityTakeoverRejected: boolean;
    workerRevocationDeleteRejected: boolean;
    claimExecuteRequiresSecret: boolean;
    workerOutsideAllowlistWriteRejected: boolean;
    adapterOpsRoleSeparated: boolean;
    adapterOpsRpcOnly: boolean;
    classAAdmissionRpcOnly: boolean;
    schedulerRawEffectInsertRejected: boolean;
    runtimeCrossTenantAdmissionRejected: boolean;
    invalidAdapterOpsWorkerIdRejected: boolean;
  };
  effect: {
    policyBound: boolean;
    actionDigestBound: boolean;
    actionDigestRequired: boolean;
    fenced: boolean;
  };
  capability: {
    replayRejected: boolean;
    revocationObserved: boolean;
    rotationObserved: boolean;
    enterpriseRefusesGenerate: boolean;
  };
  passed: boolean;
  evidenceLevel: 'ENFORCED' | 'FAILED';
  failures: string[];
  checkedAt: string;
}

export interface AuthorityProofMetadata {
  workflowId: string;
  source: {
    commit: string;
    dirty: boolean;
    trackedDiffSha256: string;
    untrackedFiles: string[];
  };
  versions: {
    dependencies: string;
    image: string;
    protocol: string;
    contract: string;
    policy: string;
    adapter: string;
  };
  environment: {
    topology: string;
    backend: string;
    tenants: string[];
    databaseRoles: string[];
  };
  provider: { externalSystemReality: string };
  fault: { description: string; injectionPoints: string[] };
  outcomes: { expected: string[]; observed: string[] };
  timing: { startedAt: string; endedAt: string; durationMs: number };
  generatingCommand: string;
  hashes: { logs: string[]; evidence: string[]; artifacts: string[] };
  limitations: string[];
  untestedBranches: string[];
}

const nonEmpty = (value: unknown): boolean =>
  typeof value === 'string'
    ? value.trim().length > 0
    : Array.isArray(value)
      ? value.length > 0 && value.every(nonEmpty)
      : typeof value === 'number'
        ? Number.isFinite(value) && value >= 0
        : typeof value === 'boolean';

/**
 * Presence is not provenance. `nonEmpty()` returns true for *any* boolean, so
 * a `dirty: true` source passed the mandatory-field check and the proof signed
 * an ENFORCED certificate from an unclean worktree. These checks validate the
 * value, not the field's existence.
 *
 * The failure codes deliberately reuse the ones `deriveTechnicalVerdict` in
 * proof-metadata.ts already emits (SOURCE_DIRTY, SOURCE_COMMIT_INVALID) so the
 * repository has one vocabulary for one condition.
 */
export function validateSourceProvenance(
  source: AuthorityProofMetadata['source'] | undefined,
  expectedCommit?: string,
): string[] {
  const failures: string[] = [];
  const commit = source?.commit;

  if (typeof commit !== 'string' || !/^[a-f0-9]{40,64}$/.test(commit)) {
    failures.push('SOURCE_COMMIT_INVALID: source.commit is not a full 40-64 hex commit');
  } else if (expectedCommit !== undefined && commit !== expectedCommit) {
    failures.push('SOURCE_COMMIT_MISMATCH: source.commit is not this candidate');
  }

  // The correct value of `dirty` is exactly `false`; missing, 'false', 0 and
  // true are all failures.
  if (source?.dirty !== false) {
    failures.push('SOURCE_DIRTY: source.dirty is not exactly false');
  }

  return failures;
}

/**
 * Detect source drift between the start and the end of a proof run. A proof
 * that measured one source snapshot cannot certify another.
 */
export function sourceSnapshotFailures(
  expected: AuthorityProofMetadata['source'],
  observed: AuthorityProofMetadata['source'],
): string[] {
  const failures: string[] = [];
  if (expected.commit !== observed.commit) {
    failures.push('SOURCE_DRIFTED_DURING_PROOF: commit changed mid-run');
  }
  if (expected.dirty !== observed.dirty) {
    failures.push('SOURCE_DRIFTED_DURING_PROOF: worktree cleanliness changed mid-run');
  }
  if (expected.trackedDiffSha256 !== observed.trackedDiffSha256) {
    failures.push('SOURCE_DRIFTED_DURING_PROOF: tracked diff changed mid-run');
  }
  if (canonicalJson(expected.untrackedFiles) !== canonicalJson(observed.untrackedFiles)) {
    failures.push('SOURCE_DRIFTED_DURING_PROOF: untracked source set changed mid-run');
  }
  return failures;
}

export function validateProofMetadata(metadata: AuthorityProofMetadata): string[] {
  const mandatory: Array<[string, unknown]> = [
    ['workflowId', metadata.workflowId],
    ['source.commit', metadata.source?.commit],
    ['source.dirty', metadata.source?.dirty],
    ['source.trackedDiffSha256', metadata.source?.trackedDiffSha256],
    ['versions.dependencies', metadata.versions?.dependencies],
    ['versions.image', metadata.versions?.image],
    ['versions.protocol', metadata.versions?.protocol],
    ['versions.contract', metadata.versions?.contract],
    ['versions.policy', metadata.versions?.policy],
    ['versions.adapter', metadata.versions?.adapter],
    ['environment.topology', metadata.environment?.topology],
    ['environment.backend', metadata.environment?.backend],
    ['environment.tenants', metadata.environment?.tenants],
    ['environment.databaseRoles', metadata.environment?.databaseRoles],
    ['provider.externalSystemReality', metadata.provider?.externalSystemReality],
    ['fault.description', metadata.fault?.description],
    ['fault.injectionPoints', metadata.fault?.injectionPoints],
    ['outcomes.expected', metadata.outcomes?.expected],
    ['outcomes.observed', metadata.outcomes?.observed],
    ['timing.startedAt', metadata.timing?.startedAt],
    ['timing.endedAt', metadata.timing?.endedAt],
    ['timing.durationMs', metadata.timing?.durationMs],
    ['generatingCommand', metadata.generatingCommand],
    ['hashes.logs', metadata.hashes?.logs],
    ['hashes.evidence', metadata.hashes?.evidence],
    ['hashes.artifacts', metadata.hashes?.artifacts],
    ['limitations', metadata.limitations],
    ['untestedBranches', metadata.untestedBranches],
  ];
  const failures = mandatory
    .filter(([, value]) => !nonEmpty(value))
    .map(([name]) => `mandatory metadata empty: ${name}`);
  failures.push(...validateSourceProvenance(metadata.source));
  if (
    metadata.source?.trackedDiffSha256 &&
    !/^[a-f0-9]{64}$/.test(metadata.source.trackedDiffSha256)
  ) {
    failures.push('invalid source hash: source.trackedDiffSha256');
  }
  if (
    Array.isArray(metadata.source?.untrackedFiles) &&
    metadata.source.untrackedFiles.some((value) => !/^.+:sha256:[a-f0-9]{64}$/.test(value))
  ) {
    failures.push('invalid source hash reference: source.untrackedFiles');
  }
  const hashReference = /^[^:\s]+:sha256:[a-f0-9]{64}$/;
  for (const [name, values] of [
    ['hashes.logs', metadata.hashes?.logs],
    ['hashes.evidence', metadata.hashes?.evidence],
    ['hashes.artifacts', metadata.hashes?.artifacts],
  ] as const) {
    if (Array.isArray(values) && values.some((value) => !hashReference.test(value))) {
      failures.push(`invalid metadata hash reference: ${name}`);
    }
  }
  return failures;
}

export function createArtifactManifest(artifact: string, artifactBody: string) {
  return { artifact, algorithm: 'sha256' as const, artifactSha256: sha256Hex(artifactBody) };
}

function emptyProofMetadata(): AuthorityProofMetadata {
  return {
    workflowId: '',
    source: { commit: '', dirty: false, trackedDiffSha256: '', untrackedFiles: [] },
    versions: { dependencies: '', image: '', protocol: '', contract: '', policy: '', adapter: '' },
    environment: { topology: '', backend: '', tenants: [], databaseRoles: [] },
    provider: { externalSystemReality: '' },
    fault: { description: '', injectionPoints: [] },
    outcomes: { expected: [], observed: [] },
    timing: { startedAt: '', endedAt: '', durationMs: -1 },
    generatingCommand: '',
    hashes: { logs: [], evidence: [], artifacts: [] },
    limitations: [],
    untestedBranches: [],
  };
}

function resolveGitDirty(): boolean {
  try {
    return (
      execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim()
        .length > 0
    );
  } catch {
    return true;
  }
}

export function captureWorkspaceSource(gitSha: string): AuthorityProofMetadata['source'] {
  try {
    const trackedDiff = execFileSync('git', ['diff', '--binary', 'HEAD', '--'], {
      cwd: ROOT,
      maxBuffer: 64 * 1024 * 1024,
    });
    const untrackedOutput = execFileSync(
      'git',
      ['ls-files', '--others', '--exclude-standard', '-z'],
      { cwd: ROOT, encoding: 'utf8' },
    );
    const untrackedFiles = untrackedOutput
      .split('\0')
      .filter(Boolean)
      .sort()
      .map((path) => `${path}:sha256:${sha256Hex(readFileSync(resolve(ROOT, path)))}`);
    return {
      commit: gitSha,
      dirty: resolveGitDirty(),
      trackedDiffSha256: sha256Hex(trackedDiff),
      untrackedFiles,
    };
  } catch {
    // Git collection failed. Never degrade to a clean-looking default: report
    // an explicitly unknown source so every downstream check fails closed.
    return {
      commit: 'SOURCE_UNKNOWN',
      dirty: true,
      trackedDiffSha256: '',
      untrackedFiles: [],
    };
  }
}

function createSourceManifestBody(source: AuthorityProofMetadata['source']): string {
  return `${canonicalJson(source)}\n`;
}

function createProofEvidenceBody(flags: AuthorityProofFlags): string {
  return `${canonicalJson({ flags })}\n`;
}

function createProofLogBody(input: Pick<AuthorityProofMetadata, 'outcomes' | 'timing'>): string {
  return `${canonicalJson(input)}\n`;
}

function buildProofMetadata(input: {
  gitSha: string;
  startedAt: string;
  endedAt: string;
  flags: AuthorityProofFlags;
  failures: readonly string[];
  tenants: string[];
  source: AuthorityProofMetadata['source'];
}): AuthorityProofMetadata {
  const outcomes: AuthorityProofMetadata['outcomes'] = {
    expected: ['all authority flags true', 'no raw runtime authority bypass'],
    observed:
      input.failures.length === 0
        ? ['all authority flags true']
        : ['authority proof failures recorded'],
  };
  const timing: AuthorityProofMetadata['timing'] = {
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    durationMs: Math.max(0, Date.parse(input.endedAt) - Date.parse(input.startedAt)),
  };
  const lockfile = readFileSync(resolve(ROOT, 'pnpm-lock.yaml'));
  const proofHarness = readFileSync(resolve(ROOT, 'scripts/authority-closure-proof.ts'));
  return {
    workflowId: 'commander-wave2-task1-authority-closure',
    source: input.source,
    versions: {
      dependencies: `pnpm-lock.yaml:sha256:${sha256Hex(lockfile)}`,
      image: 'not-applicable:local-host',
      protocol: 'v1',
      contract: 'v2',
      policy: 'v1',
      adapter: 'v1',
    },
    environment: {
      topology: 'single-process-local-role-clients',
      backend: 'postgresql-16',
      tenants: input.tenants,
      databaseRoles: [
        'commander_owner',
        'commander_app',
        'commander_worker',
        'commander_scheduler',
        'commander_adapter_ops',
      ],
    },
    provider: { externalSystemReality: 'not-applicable' },
    fault: {
      description: 'raw-role authority rejection checks',
      injectionPoints: ['database-role-rpc-boundary'],
    },
    outcomes,
    timing,
    generatingCommand: 'pnpm proof:authority',
    hashes: {
      logs: [
        `.superpowers/sdd/authority-closure-proof-latest.log.json:sha256:${sha256Hex(createProofLogBody({ outcomes, timing }))}`,
      ],
      evidence: [
        `.superpowers/sdd/authority-closure-proof-latest.evidence.json:sha256:${sha256Hex(createProofEvidenceBody(input.flags))}`,
      ],
      artifacts: [
        `scripts/authority-closure-proof.ts:sha256:${sha256Hex(proofHarness)}`,
        `.superpowers/sdd/authority-closure-proof-latest.source.json:sha256:${sha256Hex(createSourceManifestBody(input.source))}`,
      ],
    },
    limitations: ['local PostgreSQL role clients in one process', 'no external provider'],
    untestedBranches: ['external provider fault injection', 'multi-process product topology'],
  };
}

export type AuthorityProofFlags = {
  database: AuthorityProofResult['database'];
  effect: AuthorityProofResult['effect'];
  capability: AuthorityProofResult['capability'];
};

/**
 * Prefer OWNER_DSN, then the kernel URL, then DATABASE_URL.
 * There is no local fallback DSN: an unconfigured target is a failure, not a
 * guess at a developer's machine.
 */
export function resolveOwnerDsn(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const owner = env.OWNER_DSN?.trim();
  if (owner) return owner;
  const kernel = env.COMMANDER_KERNEL_DATABASE_URL?.trim();
  if (kernel) return kernel;
  const database = env.DATABASE_URL?.trim();
  if (database) return database;
  return undefined;
}

/**
 * Role passwords for the five non-owner proof identities.
 *
 * These are run-scoped values the provisioner supplies. The proof used to
 * default each one to the role name itself; it now fails closed instead.
 */
export interface ProofRolePasswords {
  app: string;
  tenantAuthority: string;
  scheduler: string;
  worker: string;
  adapterOps: string;
}

export function resolveProofRolePasswords(env: NodeJS.ProcessEnv = process.env): {
  passwords?: ProofRolePasswords;
  failures: string[];
} {
  const mapping: Record<keyof ProofRolePasswords, DeployGateRole> = {
    app: 'commander_app',
    tenantAuthority: 'commander_tenant_authority',
    scheduler: 'commander_scheduler',
    worker: 'commander_worker',
    adapterOps: 'commander_adapter_ops',
  };
  const failures: string[] = [];
  const resolved: Partial<ProofRolePasswords> = {};
  for (const [key, role] of Object.entries(mapping) as Array<
    [keyof ProofRolePasswords, DeployGateRole]
  >) {
    const { password, failures: roleFailures } = resolveRolePassword(role, env);
    if (password === undefined) failures.push(...roleFailures);
    else resolved[key] = password;
  }
  if (failures.length > 0) return { failures };
  return { passwords: resolved as ProofRolePasswords, failures };
}

/** The deploy-gate roles the proof exercises, for admission diagnostics. */
export const PROOF_ROLES: readonly DeployGateRole[] = DEPLOY_GATE_ROLES;

export function deriveRoleDatabaseUrl(baseUrl: string, role: string, password: string): string {
  const url = new URL(baseUrl);
  url.username = role;
  url.password = password;
  return url.toString();
}

/** Stable JSON for hashing (sorted object keys, arrays preserve order). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      out[key] = sortKeys(obj[key]);
    }
    return out;
  }
  return value;
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Fail-closed finalize: any false flag or non-empty failures ⇒ FAILED. */
export function finalizeResult(input: {
  gitSha: string;
  flags: AuthorityProofFlags;
  failures: string[];
  metadata?: AuthorityProofMetadata;
  checkedAt?: string;
}): AuthorityProofResult {
  const failures = [...input.failures];
  const { database, effect, capability } = input.flags;
  const metadata = input.metadata ?? emptyProofMetadata();
  failures.push(...validateProofMetadata(metadata));
  // Bind the metadata's source to THIS candidate, not merely to "some commit".
  failures.push(...validateSourceProvenance(metadata.source, input.gitSha));

  const boolChecks: Array<[string, boolean]> = [
    ['database.rlsEnabled', database.rlsEnabled],
    ['database.rolesSeparated', database.rolesSeparated],
    ['database.workerDirectInsertRejected', database.workerDirectInsertRejected],
    ['database.workerDirectUpdateRejected', database.workerDirectUpdateRejected],
    ['database.workerCrossTenantRegisterRejected', database.workerCrossTenantRegisterRejected],
    ['database.peerClaimWithoutSecretRejected', database.peerClaimWithoutSecretRejected],
    ['database.workerIdentityTakeoverRejected', database.workerIdentityTakeoverRejected],
    ['database.workerRevocationDeleteRejected', database.workerRevocationDeleteRejected],
    ['database.claimExecuteRequiresSecret', database.claimExecuteRequiresSecret],
    ['database.workerOutsideAllowlistWriteRejected', database.workerOutsideAllowlistWriteRejected],
    ['database.adapterOpsRoleSeparated', database.adapterOpsRoleSeparated],
    ['database.adapterOpsRpcOnly', database.adapterOpsRpcOnly],
    ['database.classAAdmissionRpcOnly', database.classAAdmissionRpcOnly],
    ['database.schedulerRawEffectInsertRejected', database.schedulerRawEffectInsertRejected],
    ['database.runtimeCrossTenantAdmissionRejected', database.runtimeCrossTenantAdmissionRejected],
    ['database.invalidAdapterOpsWorkerIdRejected', database.invalidAdapterOpsWorkerIdRejected],
    ['effect.policyBound', effect.policyBound],
    ['effect.actionDigestBound', effect.actionDigestBound],
    ['effect.actionDigestRequired', effect.actionDigestRequired],
    ['effect.fenced', effect.fenced],
    ['capability.replayRejected', capability.replayRejected],
    ['capability.revocationObserved', capability.revocationObserved],
    ['capability.rotationObserved', capability.rotationObserved],
    ['capability.enterpriseRefusesGenerate', capability.enterpriseRefusesGenerate],
  ];
  for (const [name, ok] of boolChecks) {
    if (!ok && !failures.some((f) => f.includes(name))) {
      failures.push(`${name}=false`);
    }
  }

  if (!input.gitSha || input.gitSha === 'unknown') {
    if (!failures.some((f) => /gitSha/i.test(f))) {
      failures.push('gitSha unknown');
    }
  }

  const allTrue = boolChecks.every(([, ok]) => ok);
  const passed =
    allTrue && failures.length === 0 && Boolean(input.gitSha) && input.gitSha !== 'unknown';

  return {
    gitSha: input.gitSha,
    metadata,
    database: { ...database },
    effect: { ...effect },
    capability: { ...capability },
    passed,
    evidenceLevel: passed ? 'ENFORCED' : 'FAILED',
    failures,
    checkedAt: input.checkedAt ?? new Date().toISOString(),
  };
}

function resolveGitSha(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();
  } catch {
    return 'unknown';
  }
}

async function ensureRoleLogin(ownerPool: Pool, role: string, password: string): Promise<void> {
  const escaped = password.replace(/'/g, "''");
  await ownerPool.query(`ALTER ROLE ${role} WITH LOGIN PASSWORD '${escaped}'`);
}

function createLoginPool(roleDatabaseUrl: string): SqlPool & { end: () => Promise<void> } {
  const pool = new Pool({ connectionString: roleDatabaseUrl, max: 2 });
  return {
    connect: async () => (await pool.connect()) as SqlClient,
    end: () => pool.end(),
  };
}

function createRunCommand(
  tenantId: string,
  steps: Array<{ kind: string; dependencies?: string[]; maxAttempts?: number; priority?: number }>,
) {
  const runId = `run_${randomUUID().slice(0, 8)}`;
  const stepDefs = steps.map((s, i) => ({
    id: `${runId}-step-${i}`,
    kind: s.kind,
    dependencies: s.dependencies,
    maxAttempts: s.maxAttempts ?? 3,
    priority: s.priority ?? 0,
    // Schedule slightly in the past so claim_next_step's scheduled_at <= clock_timestamp()
    // still holds when the app host clock is ahead of Postgres (Docker clock skew).
    scheduledAt: new Date(Date.now() - 5_000).toISOString(),
  }));
  return {
    id: runId,
    tenantId,
    intentHash: createHash('sha256').update(runId).digest('hex'),
    workGraphHash: createHash('sha256').update(JSON.stringify(stepDefs)).digest('hex'),
    workGraphVersion: 'v1',
    policySnapshotId: 'authority-proof-policy',
    steps: stepDefs,
  };
}

export type Ed25519JwksKey = {
  kty: 'OKP';
  crv: 'Ed25519';
  kid: string;
  x: string;
  alg: 'EdDSA';
  use: 'sig';
};

export function ed25519Material(kid: string): {
  privateKeyPem: string;
  jwksJson: string;
  keyId: string;
  publicJwk: Ed25519JwksKey;
} {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const jwk = publicKey.export({ format: 'jwk' }) as { x?: string };
  if (!jwk.x) throw new Error(`ed25519Material(${kid}): missing public x`);
  const publicJwk: Ed25519JwksKey = {
    kty: 'OKP',
    crv: 'Ed25519',
    kid,
    x: jwk.x,
    alg: 'EdDSA',
    use: 'sig',
  };
  const jwksJson = JSON.stringify({ keys: [publicJwk] });
  return { privateKeyPem, jwksJson, keyId: kid, publicJwk };
}

/** Merge JWKS public keys (kid collision last-wins). Used for dual-key rotation proofs. */
export function mergeJwksJson(...materials: Array<{ publicJwk: Ed25519JwksKey }>): string {
  const byKid = new Map<string, Ed25519JwksKey>();
  for (const mat of materials) {
    byKid.set(mat.publicJwk.kid, mat.publicJwk);
  }
  return JSON.stringify({ keys: [...byKid.values()] });
}

function falseFlags(): AuthorityProofFlags {
  return {
    database: {
      rlsEnabled: false,
      rolesSeparated: false,
      workerDirectInsertRejected: false,
      workerDirectUpdateRejected: false,
      workerCrossTenantRegisterRejected: false,
      peerClaimWithoutSecretRejected: false,
      workerIdentityTakeoverRejected: false,
      workerRevocationDeleteRejected: false,
      claimExecuteRequiresSecret: false,
      workerOutsideAllowlistWriteRejected: false,
      adapterOpsRoleSeparated: false,
      adapterOpsRpcOnly: false,
      classAAdmissionRpcOnly: false,
      schedulerRawEffectInsertRejected: false,
      runtimeCrossTenantAdmissionRejected: false,
      invalidAdapterOpsWorkerIdRejected: false,
    },
    effect: {
      policyBound: false,
      actionDigestBound: false,
      actionDigestRequired: false,
      fenced: false,
    },
    capability: {
      replayRejected: false,
      revocationObserved: false,
      rotationObserved: false,
      enterpriseRefusesGenerate: false,
    },
  };
}

async function checkRlsEnabled(ownerPool: Pool, failures: string[]): Promise<boolean> {
  const rows = await ownerPool.query<{
    relname: string;
    relrowsecurity: boolean;
    relforcerowsecurity: boolean;
  }>(
    `SELECT relname, relrowsecurity, relforcerowsecurity
     FROM pg_class
     WHERE relname = ANY($1::text[])`,
    [TENANT_TABLES as unknown as string[]],
  );
  if (rows.rows.length !== TENANT_TABLES.length) {
    failures.push(
      `rlsEnabled: expected ${TENANT_TABLES.length} tenant tables, got ${rows.rows.length}`,
    );
    return false;
  }
  let ok = true;
  for (const row of rows.rows) {
    if (!row.relrowsecurity || !row.relforcerowsecurity) {
      ok = false;
      failures.push(
        `rlsEnabled: ${row.relname} ENABLE=${row.relrowsecurity} FORCE=${row.relforcerowsecurity}`,
      );
    }
  }
  return ok;
}

async function checkRolesSeparated(input: {
  ownerPool: Pool;
  appPool: SqlPool;
  workerPool: SqlPool;
  appRepo: PostgresKernelRepository;
  workerRepo: PostgresKernelRepository;
  tenantA: string;
  tenantB: string;
  failures: string[];
}): Promise<boolean> {
  const { ownerPool, appPool, workerPool, appRepo, workerRepo, tenantA, tenantB, failures } = input;
  let ok = true;

  const roles = await ownerPool.query<{
    rolname: string;
    rolbypassrls: boolean;
    rolsuper: boolean;
  }>(
    `SELECT rolname, rolbypassrls, rolsuper FROM pg_roles
     WHERE rolname IN ('commander_app','commander_worker','commander_scheduler','commander_adapter_ops')`,
  );
  const byName = new Map(roles.rows.map((r) => [r.rolname, r]));
  if (byName.get('commander_app')?.rolbypassrls !== false) {
    ok = false;
    failures.push('rolesSeparated: commander_app must not BYPASSRLS');
  }
  if (byName.get('commander_worker')?.rolbypassrls !== false) {
    ok = false;
    failures.push('rolesSeparated: commander_worker must not BYPASSRLS');
  }
  if (byName.get('commander_scheduler')?.rolbypassrls !== true) {
    ok = false;
    failures.push('rolesSeparated: commander_scheduler must BYPASSRLS');
  }
  if (byName.get('commander_adapter_ops')?.rolbypassrls !== false) {
    ok = false;
    failures.push('rolesSeparated: commander_adapter_ops must not BYPASSRLS');
  }
  for (const name of [
    'commander_app',
    'commander_worker',
    'commander_scheduler',
    'commander_adapter_ops',
  ]) {
    if (byName.get(name)?.rolsuper) {
      ok = false;
      failures.push(`rolesSeparated: ${name} must not be superuser`);
    }
  }

  // Raw-role cross-tenant: app scoped to A must not read B.
  const runA = createRunCommand(tenantA, [{ kind: 'agent' }]);
  const runB = createRunCommand(tenantB, [{ kind: 'agent' }]);
  await appRepo.createRun(runA, 'authority-proof');
  await appRepo.createRun(runB, 'authority-proof');

  const client = await appPool.connect();
  try {
    await client.query(`SELECT set_config('app.tenant_scope', $1, false)`, [tenantA]);
    try {
      const leaked = await client.query(`SELECT id FROM commander_runs WHERE tenant_id=$1`, [
        tenantB,
      ]);
      if (leaked.rows.length > 0) {
        ok = false;
        failures.push('rolesSeparated: app role leaked cross-tenant rows');
      }
    } catch (error) {
      if (!/TENANT_CONTEXT_INVALID/i.test(error instanceof Error ? error.message : String(error))) {
        throw error;
      }
    }
  } finally {
    try {
      await client.query(`SELECT set_config('app.tenant_scope', '', false)`);
    } catch {
      /* best-effort pool hygiene */
    }
    client.release();
  }

  // App cannot EXECUTE claim_next_step; worker can (after worker registration).
  const workerId = `proof-worker-${randomUUID().slice(0, 8)}`;
  await ownerPool.query(
    `INSERT INTO commander_workers (id,kind,version,capabilities,max_concurrency,status,generation,identity_subject,tenant_ids)
     VALUES ($1,'agent','v1','["agent"]',4,'ACTIVE',1,$1,$2::jsonb)
     ON CONFLICT (id) DO UPDATE SET generation=1, status='ACTIVE', tenant_ids=$2::jsonb`,
    [workerId, JSON.stringify([tenantA])],
  );
  const claimSecret = await seedWorkerClaimSecret(ownerPool, workerId, 1);

  let appDenied = false;
  try {
    await appRepo.claimNextStep({
      workerId,
      workerGeneration: 1,
      capabilities: ['agent'],
      leaseTtlMs: 30_000,
      claimSecret,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/permission denied/i.test(msg)) appDenied = true;
    else {
      ok = false;
      failures.push(`rolesSeparated: app claim unexpected error: ${msg}`);
    }
  }
  if (!appDenied) {
    ok = false;
    failures.push('rolesSeparated: commander_app must not EXECUTE claim_next_step');
  }

  // Drain then create a claimable step for worker.
  await ownerPool.query(
    `UPDATE commander_steps SET state='CANCELLED', updated_at=now()
     WHERE tenant_id = ANY($1::text[]) AND state IN ('PENDING','RETRY_WAIT')`,
    [[tenantA]],
  );
  const claimRun = createRunCommand(tenantA, [{ kind: 'agent' }]);
  await appRepo.createRun(claimRun, 'authority-proof');

  const identityClient = await workerPool.connect();
  try {
    const identity = await identityClient.query<{ session_user: string }>(
      'SELECT session_user::text AS session_user',
    );
    if (identity.rows[0]?.session_user !== 'commander_worker') {
      ok = false;
      failures.push(
        `rolesSeparated: expected session_user=commander_worker, got ${identity.rows[0]?.session_user}`,
      );
    }
  } finally {
    identityClient.release();
  }

  const claimed = await workerRepo.claimNextStep({
    workerId,
    workerGeneration: 1,
    capabilities: ['agent'],
    leaseTtlMs: 30_000,
    claimSecret,
  });
  if (!claimed) {
    ok = false;
    failures.push('rolesSeparated: commander_worker must claim via claim_next_step');
  }

  return ok;
}

async function checkEffectBindings(input: {
  ownerPool: Pool;
  appRepo: PostgresKernelRepository;
  workerRepo: PostgresKernelRepository;
  tenantId: string;
  failures: string[];
}): Promise<{
  policyBound: boolean;
  actionDigestBound: boolean;
  actionDigestRequired: boolean;
  fenced: boolean;
}> {
  const { ownerPool, appRepo, workerRepo, tenantId, failures } = input;
  let policyBound = false;
  let actionDigestBound = false;
  let actionDigestRequired = false;
  let fenced = false;

  const workerId = `proof-fence-${randomUUID().slice(0, 8)}`;
  await ownerPool.query(
    `INSERT INTO commander_workers (id,kind,version,capabilities,max_concurrency,status,generation,identity_subject,tenant_ids)
     VALUES ($1,'agent','v1','["agent"]',4,'ACTIVE',1,'db:commander_worker',$2::jsonb)`,
    [workerId, JSON.stringify([tenantId])],
  );
  const claimSecret = await seedWorkerClaimSecret(ownerPool, workerId, 1);

  try {
    await ownerPool.query(
      `UPDATE commander_steps SET state='CANCELLED', updated_at=now()
       WHERE tenant_id=$1 AND state IN ('PENDING','RETRY_WAIT','RUNNING')`,
      [tenantId],
    );
    await ownerPool.query(
      `UPDATE commander_tenant_execution_usage SET running_steps=0, updated_at=now() WHERE tenant_id=$1`,
      [tenantId],
    );

    const bindRun = createRunCommand(tenantId, [{ kind: 'agent' }]);
    await appRepo.createRun(bindRun, 'authority-proof');
    const claimed = await workerRepo.claimNextStep({
      workerId,
      workerGeneration: 1,
      capabilities: ['agent'],
      leaseTtlMs: 30_000,
      claimSecret,
    });
    if (!claimed?.lease) {
      failures.push('effect: claim failed before policy/digest/fence checks');
      return { policyBound, actionDigestBound, actionDigestRequired, fenced };
    }
    const lease = claimed.lease;
    const digest = 'c'.repeat(64);
    const idemKey = `bind-${randomUUID().slice(0, 8)}`;

    const admitted = await appRepo.admitEffect({
      id: `effect-bind-${randomUUID().slice(0, 8)}`,
      runId: bindRun.id,
      stepId: claimed.id,
      tenantId,
      type: 'http.write',
      idempotencyKey: idemKey,
      policyDecisionId: 'decision-bind',
      policySnapshotId: 'policy-bind-v1',
      actionDigest: digest,
      request: { target: 'bind' },
      lease,
      actor: workerId,
    });
    if (!admitted.admitted) {
      failures.push(
        `effect: initial admit failed (${'reason' in admitted ? admitted.reason : 'unknown'})`,
      );
      return { policyBound, actionDigestBound, actionDigestRequired, fenced };
    }

    const snapshotConflict = await appRepo.admitEffect({
      id: `effect-bind-snap-${randomUUID().slice(0, 8)}`,
      runId: bindRun.id,
      stepId: claimed.id,
      tenantId,
      type: 'http.write',
      idempotencyKey: idemKey,
      policyDecisionId: 'decision-bind',
      policySnapshotId: 'policy-bind-v2',
      actionDigest: digest,
      request: { target: 'bind' },
      lease,
      actor: workerId,
    });
    policyBound =
      snapshotConflict.admitted === false &&
      !snapshotConflict.admitted &&
      snapshotConflict.reason === 'IDEMPOTENCY_CONFLICT';
    if (!policyBound) {
      failures.push(
        `effect.policyBound: expected IDEMPOTENCY_CONFLICT, got ${JSON.stringify(snapshotConflict)}`,
      );
    }

    const digestConflict = await appRepo.admitEffect({
      id: `effect-bind-digest-${randomUUID().slice(0, 8)}`,
      runId: bindRun.id,
      stepId: claimed.id,
      tenantId,
      type: 'http.write',
      idempotencyKey: idemKey,
      policyDecisionId: 'decision-bind',
      policySnapshotId: 'policy-bind-v1',
      actionDigest: 'd'.repeat(64),
      request: { target: 'bind' },
      lease,
      actor: workerId,
    });
    actionDigestBound =
      digestConflict.admitted === false &&
      !digestConflict.admitted &&
      digestConflict.reason === 'IDEMPOTENCY_CONFLICT';
    if (!actionDigestBound) {
      failures.push(
        `effect.actionDigestBound: expected IDEMPOTENCY_CONFLICT, got ${JSON.stringify(digestConflict)}`,
      );
    }

    // Fence (kernel lease): rollover generation → stale lease admit must LEASE_LOST; stale claim null.
    await ownerPool.query('UPDATE commander_workers SET generation=2 WHERE id=$1', [workerId]);
    const staleAdmit = await appRepo.admitEffect({
      id: `effect-stale-${randomUUID().slice(0, 8)}`,
      runId: bindRun.id,
      stepId: claimed.id,
      tenantId,
      type: 'http.write',
      idempotencyKey: `stale-${randomUUID().slice(0, 8)}`,
      policyDecisionId: 'decision-stale',
      policySnapshotId: 'policy-bind-v1',
      actionDigest: 'e'.repeat(64),
      request: { target: 'stale' },
      lease,
      actor: workerId,
    });
    const staleClaim = await workerRepo.claimNextStep({
      workerId,
      workerGeneration: 1,
      capabilities: ['agent'],
      leaseTtlMs: 30_000,
      claimSecret,
    });
    const kernelFenced =
      staleAdmit.admitted === false &&
      !staleAdmit.admitted &&
      staleAdmit.reason === 'LEASE_LOST' &&
      staleClaim === null;
    if (!kernelFenced) {
      failures.push(
        `effect.fenced(kernel): expected LEASE_LOST + null claim, got admit=${JSON.stringify(staleAdmit)} claim=${staleClaim ? 'claimed' : 'null'}`,
      );
    }

    // Fence (broker): grant workerId/generation ≠ lease → WORKER_FENCE_MISMATCH (fail-closed).
    const fenceIssuer = CapabilityTokenIssuer.generate({
      issuer: 'commander-authority-proof',
      audience: 'commander.effect-broker',
      keyId: 'proof-fence',
    });
    const fenceVerifier = new CapabilityTokenVerifier({
      issuer: 'commander-authority-proof',
      audience: 'commander.effect-broker',
      publicKeys: { 'proof-fence': fenceIssuer.publicKey },
    });
    const fenceBroker = new EffectBroker(
      fenceVerifier,
      {
        evaluate: async () => ({
          effect: 'allow' as const,
          decisionId: 'authority-proof-fence',
          reason: 'ok',
          policySnapshotId: 'authority-proof-policy',
        }),
      },
      {
        admitEffect: async () => ({ admitted: true, effect: { id: 'e1', state: 'ADMITTED' } }),
        completeEffect: async () => ({}),
      },
      { execute: async () => ({ ok: true }) },
      { append: async () => undefined },
      { audience: 'commander.effect-broker', requireRequestBinding: true },
    );
    const workloadId = `wl_${bindRun.id}_${claimed.id}_fence`;
    const brokerRequest = { target: 'broker-fence' };
    const mismatchedGrant = fenceIssuer.issue({
      jti: `jti-broker-fence-${randomUUID().slice(0, 8)}`,
      tenantId,
      runId: bindRun.id,
      stepId: claimed.id,
      workloadId,
      effectTypes: ['http.write'],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      requestHash: canonicalRequestHash(brokerRequest),
      actionDigest: 'f'.repeat(64),
      // Deliberately diverge from lease workerGeneration (lease stays gen 1).
      workerId,
      workerGeneration: 99,
      nonce: randomUUID(),
    });
    const brokerFenceAdmit = await fenceBroker.admit({
      effectId: `eff-broker-fence-${randomUUID().slice(0, 8)}`,
      token: mismatchedGrant,
      type: 'http.write',
      request: brokerRequest,
      idempotencyKey: `broker-fence-${randomUUID().slice(0, 8)}`,
      lease: {
        workerId: lease.workerId,
        workerGeneration: lease.workerGeneration,
        token: lease.token,
        fencingEpoch: lease.fencingEpoch,
      },
      actor: workerId,
      workloadBinding: {
        tenantId,
        runId: bindRun.id,
        stepId: claimed.id,
        workloadId,
      },
    });
    const brokerFenced =
      brokerFenceAdmit.admitted === false &&
      !brokerFenceAdmit.admitted &&
      brokerFenceAdmit.reason === 'WORKER_FENCE_MISMATCH';
    if (!brokerFenced) {
      failures.push(
        `effect.fenced(broker): expected WORKER_FENCE_MISMATCH, got ${JSON.stringify(brokerFenceAdmit)}`,
      );
    }

    fenced = kernelFenced && brokerFenced;

    // Class A admit without actionDigest → ACTION_DIGEST_REQUIRED.
    const digestGateIssuer = CapabilityTokenIssuer.generate({
      issuer: 'commander-authority-proof',
      audience: 'commander.effect-broker',
      keyId: 'proof-digest-gate',
    });
    const digestGateVerifier = new CapabilityTokenVerifier({
      issuer: 'commander-authority-proof',
      audience: 'commander.effect-broker',
      publicKeys: { 'proof-digest-gate': digestGateIssuer.publicKey },
    });
    const digestGateBroker = new EffectBroker(
      digestGateVerifier,
      {
        evaluate: async () => ({
          effect: 'allow' as const,
          decisionId: 'authority-proof-digest',
          reason: 'ok',
          policySnapshotId: 'authority-proof-policy',
        }),
      },
      {
        admitEffect: async () => ({
          admitted: true,
          effect: { id: 'e-digest', state: 'ADMITTED' },
        }),
        completeEffect: async () => ({}),
      },
      { execute: async () => ({ ok: true }) },
      { append: async () => undefined },
      {
        audience: 'commander.effect-broker',
        requireRequestBinding: true,
        localWorkerId: workerId,
        localWorkerGeneration: 1,
      },
    );
    const digestGateRequest = { target: 'digest-gate' };
    const noDigestGrant = digestGateIssuer.issue({
      jti: `jti-digest-gate-${randomUUID().slice(0, 8)}`,
      tenantId,
      runId: bindRun.id,
      stepId: claimed.id,
      workloadId: `wl_${bindRun.id}_${claimed.id}_digest`,
      effectTypes: ['crm.write'],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      requestHash: canonicalRequestHash(digestGateRequest),
      workerId,
      workerGeneration: 1,
      nonce: randomUUID(),
    });
    const digestGateAdmit = await digestGateBroker.admit({
      effectId: `eff-digest-gate-${randomUUID().slice(0, 8)}`,
      token: noDigestGrant,
      type: 'crm.write',
      request: digestGateRequest,
      idempotencyKey: `digest-gate-${randomUUID().slice(0, 8)}`,
      lease: {
        workerId,
        workerGeneration: 1,
        token: lease.token,
        fencingEpoch: lease.fencingEpoch,
      },
      actor: workerId,
      workloadBinding: {
        tenantId,
        runId: bindRun.id,
        stepId: claimed.id,
        workloadId: `wl_${bindRun.id}_${claimed.id}_digest`,
      },
    });
    if (digestGateAdmit.admitted === false && digestGateAdmit.reason === 'ACTION_DIGEST_REQUIRED') {
      actionDigestRequired = true;
    } else {
      failures.push(
        `effect.actionDigestRequired: expected ACTION_DIGEST_REQUIRED, got ${JSON.stringify(digestGateAdmit)}`,
      );
    }
  } finally {
    await ownerPool.query('DELETE FROM commander_worker_claim_secrets WHERE worker_id=$1', [
      workerId,
    ]);
    await ownerPool.query('DELETE FROM commander_workers WHERE id=$1', [workerId]);
  }

  return { policyBound, actionDigestBound, actionDigestRequired, fenced };
}

async function checkCapability(input: {
  workerRepo: PostgresKernelRepository;
  tenantId: string;
  failures: string[];
}): Promise<AuthorityProofResult['capability']> {
  const { workerRepo, tenantId, failures } = input;
  const out: AuthorityProofResult['capability'] = {
    replayRejected: false,
    revocationObserved: false,
    rotationObserved: false,
    enterpriseRefusesGenerate: false,
  };

  const mat = ed25519Material(`proof-${randomUUID().slice(0, 8)}`);
  const env = {
    NODE_ENV: 'test',
    [CAPABILITY_PRIVATE_KEY_PEM_ENV]: mat.privateKeyPem,
    [CAPABILITY_KEY_ID_ENV]: mat.keyId,
    [CAPABILITY_JWKS_JSON_ENV]: mat.jwksJson,
  };

  // Worker LOGIN + schedulerMode: false — production verify/revoke observe path under RLS.
  const processA = createCapabilityAuthority(env, workerRepo, {
    issuer: 'commander-authority-proof',
    audience: 'commander.effect-broker',
  });
  const processB = createCapabilityAuthority(env, workerRepo, {
    issuer: 'commander-authority-proof',
    audience: 'commander.effect-broker',
  });

  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const replayToken = processA.issuer.issue({
    jti: `jti-replay-${randomUUID().slice(0, 8)}`,
    tenantId,
    runId: 'run-proof',
    stepId: 'step-proof',
    effectTypes: ['http.request'],
    expiresAt,
    nonce: `nonce-${randomUUID().slice(0, 8)}`,
  });

  await processA.verifier.verify(replayToken);
  try {
    await processB.verifier.verify(replayToken);
    failures.push('capability.replayRejected: second verify did not reject');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/replayed/i.test(msg)) out.replayRejected = true;
    else failures.push(`capability.replayRejected: unexpected error: ${msg}`);
  }

  const revJti = `jti-rev-${randomUUID().slice(0, 8)}`;
  const revToken = processA.issuer.issue({
    jti: revJti,
    tenantId,
    runId: 'run-proof',
    stepId: 'step-proof',
    effectTypes: ['http.request'],
    expiresAt,
    nonce: `nonce-rev-${randomUUID().slice(0, 8)}`,
  });
  // Revoke under worker tenant scope (not scheduler BYPASSRLS).
  await processA.revocations.revokeGrant({
    jti: revJti,
    tenantId,
    expiresAt,
    reason: 'authority-proof',
  });
  try {
    await processB.verifier.verify(revToken);
    failures.push('capability.revocationObserved: verify after revoke did not reject');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/revoked/i.test(msg)) out.revocationObserved = true;
    else failures.push(`capability.revocationObserved: unexpected error: ${msg}`);
  }

  // Real JWKS rotation (not merely foreign material):
  // 1–2 dual JWKS → 3 sign/verify with A → 4 retire A → 5 sign/verify with B → 6 reload.
  const keyA = ed25519Material('a');
  const keyB = ed25519Material('b');
  const dualJwks = mergeJwksJson(keyA, keyB);
  const issuerOpts = { issuer: 'commander-authority-proof', audience: 'commander.effect-broker' };

  const authADual = createCapabilityAuthority(
    {
      NODE_ENV: 'test',
      [CAPABILITY_PRIVATE_KEY_PEM_ENV]: keyA.privateKeyPem,
      [CAPABILITY_KEY_ID_ENV]: keyA.keyId,
      [CAPABILITY_JWKS_JSON_ENV]: dualJwks,
    },
    workerRepo,
    issuerOpts,
  );
  const tokenSignedByA = authADual.issuer.issue({
    jti: `jti-rot-a-${randomUUID().slice(0, 8)}`,
    tenantId,
    runId: 'run-proof',
    stepId: 'step-proof',
    effectTypes: ['http.request'],
    expiresAt,
    nonce: `nonce-rot-a-${randomUUID().slice(0, 8)}`,
  });

  let dualVerifyOk = false;
  try {
    await authADual.verifier.verify(tokenSignedByA);
    dualVerifyOk = true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    failures.push(`capability.rotationObserved: dual JWKS verify with A failed: ${msg}`);
  }

  const authBOnly = createCapabilityAuthority(
    {
      NODE_ENV: 'test',
      [CAPABILITY_PRIVATE_KEY_PEM_ENV]: keyB.privateKeyPem,
      [CAPABILITY_KEY_ID_ENV]: keyB.keyId,
      [CAPABILITY_JWKS_JSON_ENV]: keyB.jwksJson,
    },
    workerRepo,
    issuerOpts,
  );

  let rotatedAwayRejected = false;
  try {
    await authBOnly.verifier.verify(tokenSignedByA);
    failures.push(
      'capability.rotationObserved: rotated-away kid A still verified under B-only JWKS',
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Unknown capability token key id|unknown.*kid|key id/i.test(msg)) {
      rotatedAwayRejected = true;
    } else {
      failures.push(`capability.rotationObserved: expected unknown kid for retired A, got: ${msg}`);
    }
  }

  let bTokenOk = false;
  const tokenSignedByB = authBOnly.issuer.issue({
    jti: `jti-rot-b-${randomUUID().slice(0, 8)}`,
    tenantId,
    runId: 'run-proof',
    stepId: 'step-proof',
    effectTypes: ['http.request'],
    expiresAt,
    nonce: `nonce-rot-b-${randomUUID().slice(0, 8)}`,
  });
  try {
    await authBOnly.verifier.verify(tokenSignedByB);
    bTokenOk = true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    failures.push(`capability.rotationObserved: B-only JWKS verify with B failed: ${msg}`);
  }

  // Optional reload: second createCapabilityAuthority with B-only JWKS still verifies the
  // same B token (fresh in-memory replay store — proves JWKS/PEM reload, not durable replay).
  let reloadOk = false;
  const authBReload = createCapabilityAuthority(
    {
      NODE_ENV: 'test',
      [CAPABILITY_PRIVATE_KEY_PEM_ENV]: keyB.privateKeyPem,
      [CAPABILITY_KEY_ID_ENV]: keyB.keyId,
      [CAPABILITY_JWKS_JSON_ENV]: keyB.jwksJson,
    },
    new InMemoryKernelRepository(),
    issuerOpts,
  );
  try {
    await authBReload.verifier.verify(tokenSignedByB);
    reloadOk = true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    failures.push(`capability.rotationObserved: post-reload B token verify failed: ${msg}`);
  }

  // Sub-check: unknown/foreign kid still rejected (not sufficient alone for rotationObserved).
  let unknownKidRejected = false;
  const foreign = ed25519Material(`foreign-${randomUUID().slice(0, 8)}`);
  const foreignAuth = createCapabilityAuthority(
    {
      NODE_ENV: 'test',
      [CAPABILITY_PRIVATE_KEY_PEM_ENV]: foreign.privateKeyPem,
      [CAPABILITY_KEY_ID_ENV]: foreign.keyId,
      [CAPABILITY_JWKS_JSON_ENV]: foreign.jwksJson,
    },
    workerRepo,
    issuerOpts,
  );
  const foreignToken = foreignAuth.issuer.issue({
    jti: `jti-foreign-${randomUUID().slice(0, 8)}`,
    tenantId,
    runId: 'run-proof',
    stepId: 'step-proof',
    effectTypes: ['http.request'],
    expiresAt,
    nonce: `nonce-f-${randomUUID().slice(0, 8)}`,
  });
  try {
    await authBOnly.verifier.verify(foreignToken);
    failures.push('capability.rotationObserved: unknown kid did not reject');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Unknown capability token key id|unknown.*kid|key id/i.test(msg)) {
      unknownKidRejected = true;
    } else {
      failures.push(`capability.rotationObserved: unknown-kid sub-check unexpected error: ${msg}`);
    }
  }

  out.rotationObserved =
    dualVerifyOk && rotatedAwayRejected && bTokenOk && reloadOk && unknownKidRejected;

  // Enterprise / CELL_TIER refuse ephemeral key generation.
  const mem = new InMemoryKernelRepository();
  for (const signal of [
    { COMMANDER_PROFILE: 'enterprise' },
    { COMMANDER_CELL_TIER: 'enterprise' },
    { NODE_ENV: 'production' },
  ] as const) {
    try {
      createCapabilityAuthority({ ...signal }, mem);
      failures.push(
        `capability.enterpriseRefusesGenerate: expected CAPABILITY_AUTHORITY_REQUIRED under ${JSON.stringify(signal)}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith(CAPABILITY_AUTHORITY_REQUIRED)) {
        out.enterpriseRefusesGenerate = true;
      } else {
        failures.push(
          `capability.enterpriseRefusesGenerate: unexpected error under ${JSON.stringify(signal)}: ${msg}`,
        );
      }
    }
  }

  return out;
}

async function checkWorkerDsnThreat(input: {
  ownerPool: Pool;
  workerPool: SqlPool;
  workerRepo: PostgresKernelRepository;
  appRepo: PostgresKernelRepository;
  allowedTenant: string;
  ownerDsn: string;
  workerPassword: string;
  failures: string[];
}): Promise<{
  workerDirectInsertRejected: boolean;
  workerDirectUpdateRejected: boolean;
  workerCrossTenantRegisterRejected: boolean;
  peerClaimWithoutSecretRejected: boolean;
  workerIdentityTakeoverRejected: boolean;
  workerRevocationDeleteRejected: boolean;
  claimExecuteRequiresSecret: boolean;
  workerOutsideAllowlistWriteRejected: boolean;
}> {
  const { ownerPool, workerPool, workerRepo, appRepo, allowedTenant, failures } = input;
  let workerDirectInsertRejected = false;
  let workerDirectUpdateRejected = false;
  let workerCrossTenantRegisterRejected = false;
  let peerClaimWithoutSecretRejected = false;
  let workerIdentityTakeoverRejected = false;
  let workerRevocationDeleteRejected = false;
  let claimExecuteRequiresSecret = false;
  let workerOutsideAllowlistWriteRejected = false;

  await seedWorkerAllowedTenants(ownerPool, [allowedTenant]);

  // 0) EXECUTE grants: worker must EXECUTE the p_claim_secret overloads for
  //    claim_next_step / claim_outbox_by_topic, but not reconciliation claims;
  //    must not EXECUTE any stale overload that omits the secret argument.
  {
    const checkClaimExec = async (
      proname: string,
      hasSecretArg: (args: string) => boolean,
      label: string,
    ): Promise<boolean> => {
      const execRows = await ownerPool.query<{
        args: string;
        worker_exec: boolean;
      }>(
        `SELECT pg_get_function_identity_arguments(p.oid) AS args,
                has_function_privilege('commander_worker', p.oid, 'EXECUTE') AS worker_exec
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = $1`,
        [proname],
      );
      if (execRows.rows.length === 0) {
        failures.push(`database.claimExecuteRequiresSecret: missing function ${proname}`);
        return false;
      }
      const secretOverloads = execRows.rows.filter((r) => hasSecretArg(r.args));
      const staleOverloads = execRows.rows.filter((r) => !hasSecretArg(r.args));
      const workerHasSecretExec = secretOverloads.some((r) => r.worker_exec);
      const workerHasStaleExec = staleOverloads.some((r) => r.worker_exec);
      if (!workerHasSecretExec) {
        failures.push(`database.claimExecuteRequiresSecret: worker missing EXECUTE on ${label}`);
        return false;
      }
      if (workerHasStaleExec) {
        failures.push(
          `database.claimExecuteRequiresSecret: worker still has EXECUTE on stale ${proname} without secret`,
        );
        return false;
      }
      return true;
    };

    const nextStepSecret = (args: string): boolean => {
      if (/p_claim_secret/i.test(args)) return true;
      const types = [...args.matchAll(/\b(text|bigint|integer|jsonb)\b/gi)].map((m) =>
        m[1]!.toLowerCase(),
      );
      return types.length === 5 && types[3] === 'text' && types[4] === 'jsonb';
    };
    const outboxSecret = (args: string): boolean => {
      if (/p_claim_secret/i.test(args)) return true;
      const types = [...args.matchAll(/\b(text|bigint|integer|timestamptz)\b/gi)].map((m) =>
        m[1]!.toLowerCase(),
      );
      // text,bigint,text,integer,timestamptz,text
      return (
        types.length === 6 && types[0] === 'text' && types[2] === 'text' && types[5] === 'text'
      );
    };

    const okNext = await checkClaimExec(
      'claim_next_step',
      nextStepSecret,
      'claim_next_step with p_claim_secret',
    );
    const okOutbox = await checkClaimExec(
      'claim_outbox_by_topic',
      outboxSecret,
      'claim_outbox_by_topic with p_claim_secret',
    );
    const reconcileExec = await ownerPool.query<{ worker_exec: boolean }>(
      `SELECT has_function_privilege('commander_worker', p.oid, 'EXECUTE') AS worker_exec
       FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='claim_reconcile_effects'`,
    );
    const workerCannotReconcile =
      reconcileExec.rows.length > 0 && reconcileExec.rows.every((row) => !row.worker_exec);
    if (!workerCannotReconcile) {
      failures.push(
        'database.claimExecuteRequiresSecret: worker must not EXECUTE claim_reconcile_effects',
      );
    }
    if (okNext && okOutbox && workerCannotReconcile) {
      claimExecuteRequiresSecret = true;
    }
  }

  // 1) Worker LOGIN cannot INSERT into commander_workers (REVOKE INSERT).
  const directId = `proof-direct-${randomUUID().slice(0, 8)}`;
  const wClient = await workerPool.connect();
  try {
    await wClient.query(`SELECT set_config('app.tenant_scope', $1, false)`, [allowedTenant]);
    try {
      await wClient.query(
        `INSERT INTO commander_workers (id,kind,version,capabilities,max_concurrency,status,generation,identity_subject,tenant_ids)
         VALUES ($1,'agent','v1','[]',1,'ACTIVE',1,$1,$2::jsonb)`,
        [directId, JSON.stringify([allowedTenant])],
      );
      failures.push('database.workerDirectInsertRejected: INSERT unexpectedly succeeded');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/permission denied/i.test(msg)) workerDirectInsertRejected = true;
      else failures.push(`database.workerDirectInsertRejected: unexpected error: ${msg}`);
    }
    try {
      await wClient.query('SELECT secret_hash FROM commander_worker_claim_secrets LIMIT 1');
      failures.push(
        'database.peerClaimWithoutSecretRejected: worker SELECT claim_secrets unexpectedly succeeded',
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/permission denied/i.test(msg)) {
        failures.push(`commander_worker_claim_secrets SELECT unexpected error: ${msg}`);
      }
    }
  } finally {
    try {
      await wClient.query(`SELECT set_config('app.tenant_scope', '', false)`);
    } catch {
      /* best-effort pool hygiene */
    }
    wClient.release();
  }
  const updateId = `proof-upd-${randomUUID().slice(0, 8)}`;
  await ownerPool.query(
    `INSERT INTO commander_workers (id,kind,version,capabilities,max_concurrency,status,generation,identity_subject,tenant_ids)
     VALUES ($1,'agent','v1','["agent"]',1,'ACTIVE',1,$1,$2::jsonb)`,
    [updateId, JSON.stringify([allowedTenant])],
  );
  const updClient = await workerPool.connect();
  try {
    await updClient.query(`SELECT set_config('app.tenant_scope', $1, false)`, [allowedTenant]);
    try {
      await updClient.query(`UPDATE commander_workers SET tenant_ids = $1::jsonb WHERE id = $2`, [
        JSON.stringify([allowedTenant, 'victim-widen']),
        updateId,
      ]);
      failures.push('database.workerDirectUpdateRejected: UPDATE unexpectedly succeeded');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/permission denied/i.test(msg)) workerDirectUpdateRejected = true;
      else failures.push(`database.workerDirectUpdateRejected: unexpected error: ${msg}`);
    }
  } finally {
    try {
      await updClient.query(`SELECT set_config('app.tenant_scope', '', false)`);
    } catch {
      /* best-effort pool hygiene */
    }
    updClient.release();
  }

  // 1c) Worker cannot DELETE revocations (resurrect revoked jti) or erase outbox.
  const revokeJti = `proof-jti-${randomUUID()}`;
  await ownerPool.query(
    `INSERT INTO commander_capability_revocations (tenant_id, jti, expires_at)
     VALUES ($1, $2, now() + interval '1 hour')
     ON CONFLICT DO NOTHING`,
    [allowedTenant, revokeJti],
  );
  let revokeDeleteDenied = false;
  let outboxDeleteDenied = false;
  const delClient = await workerPool.connect();
  try {
    await delClient.query(`SELECT set_config('app.tenant_scope', $1, false)`, [allowedTenant]);
    try {
      await delClient.query(
        `DELETE FROM commander_capability_revocations WHERE tenant_id = $1 AND jti = $2`,
        [allowedTenant, revokeJti],
      );
      failures.push(
        'database.workerRevocationDeleteRejected: DELETE revocations unexpectedly succeeded',
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/permission denied/i.test(msg)) revokeDeleteDenied = true;
      else failures.push(`database.workerRevocationDeleteRejected: unexpected error: ${msg}`);
    }
    try {
      await delClient.query(`DELETE FROM commander_outbox WHERE tenant_id = $1`, [allowedTenant]);
      failures.push(
        'database.workerRevocationDeleteRejected: DELETE outbox unexpectedly succeeded',
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/permission denied/i.test(msg)) outboxDeleteDenied = true;
      else
        failures.push(`database.workerRevocationDeleteRejected: outbox unexpected error: ${msg}`);
    }
  } finally {
    try {
      await delClient.query(`SELECT set_config('app.tenant_scope', '', false)`);
    } catch {
      /* best-effort pool hygiene */
    }
    delClient.release();
  }
  if (revokeDeleteDenied && outboxDeleteDenied) {
    workerRevocationDeleteRejected = true;
  }

  // 2) Peer claim + outbox/reconcile secret gates — run BEFORE register_worker
  //    on the shared worker pool (DEFINER register can leave session state that
  //    flakes subsequent claim_next_step under worker LOGIN).
  const peerId = `proof-peer-${randomUUID().slice(0, 8)}`;
  await ownerPool.query(
    `INSERT INTO commander_workers (id,kind,version,capabilities,max_concurrency,status,generation,identity_subject,tenant_ids)
     VALUES ($1,'agent','v1','["agent"]',4,'ACTIVE',1,$1,$2::jsonb)`,
    [peerId, JSON.stringify([allowedTenant])],
  );
  const peerSecret = await seedWorkerClaimSecret(ownerPool, peerId, 1);
  await ownerPool.query(
    `UPDATE commander_steps SET state='CANCELLED', updated_at=now()
     WHERE tenant_id=$1 AND state IN ('PENDING','RETRY_WAIT','RUNNING')`,
    [allowedTenant],
  );
  await ownerPool.query(
    `UPDATE commander_tenant_execution_usage SET running_steps=0, updated_at=now() WHERE tenant_id=$1`,
    [allowedTenant],
  );
  const peerRun = createRunCommand(allowedTenant, [{ kind: 'agent' }]);
  await appRepo.createRun(peerRun, 'authority-proof');

  const noSecret = await workerRepo.claimNextStep({
    workerId: peerId,
    workerGeneration: 1,
    capabilities: ['agent'],
    leaseTtlMs: 30_000,
  });
  const wrongSecret = await workerRepo.claimNextStep({
    workerId: peerId,
    workerGeneration: 1,
    capabilities: ['agent'],
    leaseTtlMs: 30_000,
    claimSecret: 'peer-guess',
  });
  const withSecret = await workerRepo.claimNextStep({
    workerId: peerId,
    workerGeneration: 1,
    capabilities: ['agent'],
    leaseTtlMs: 30_000,
    claimSecret: peerSecret,
  });
  if (noSecret === null && wrongSecret === null && withSecret !== null) {
    const outboxId = `proof-obx-${randomUUID().slice(0, 8)}`;
    const eventId = `evt-${outboxId}`;
    await ownerPool.query(
      `INSERT INTO commander_events
         (id, aggregate_type, aggregate_id, sequence, type, tenant_id, run_id, actor, schema_version, payload)
       VALUES ($1,'run',$2,1,'compensation.requested',$3,$2,'authority-proof','v2','{}'::jsonb)`,
      [eventId, `run-${outboxId}`, allowedTenant],
    );
    await ownerPool.query(
      `INSERT INTO commander_outbox (id, event_id, tenant_id, topic, key, payload, attempts, max_attempts, available_at)
       VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, 0, 5, now())`,
      [outboxId, eventId, allowedTenant, KERNEL_COMPENSATION_TOPIC, `cmp/${outboxId}`],
    );
    const claimNowResult = await ownerPool.query<{ now: Date | string }>(
      'SELECT clock_timestamp() AS now',
    );
    const claimNow = new Date(claimNowResult.rows[0]?.now ?? Date.now());
    let outboxNo: unknown[] = [];
    let outboxWrong: unknown[] = [];
    let outboxOk: unknown[] = [];
    try {
      outboxNo = await workerRepo.claimOutboxByTopic(KERNEL_COMPENSATION_TOPIC, 10, claimNow, {
        workerId: peerId,
        workerGeneration: 1,
        claimSecret: '',
      });
    } catch {
      outboxNo = [];
    }
    outboxWrong = await workerRepo.claimOutboxByTopic(KERNEL_COMPENSATION_TOPIC, 10, claimNow, {
      workerId: peerId,
      workerGeneration: 1,
      claimSecret: 'peer-guess',
    });
    outboxOk = await workerRepo.claimOutboxByTopic(KERNEL_COMPENSATION_TOPIC, 10, claimNow, {
      workerId: peerId,
      workerGeneration: 1,
      claimSecret: peerSecret,
    });
    const outboxSecretOk =
      outboxNo.length === 0 &&
      outboxWrong.length === 0 &&
      outboxOk.some((m) => (m as { id?: string }).id === outboxId);
    if (outboxSecretOk) {
      peerClaimWithoutSecretRejected = true;
    } else {
      failures.push(
        `database.peerClaimWithoutSecretRejected: outboxOk=${outboxSecretOk} claimed=${outboxOk.length}`,
      );
    }
    await ownerPool.query('DELETE FROM commander_outbox WHERE id = $1', [outboxId]);
    await ownerPool.query('DELETE FROM commander_events WHERE id = $1', [eventId]);
  } else {
    failures.push(
      `database.peerClaimWithoutSecretRejected: noSecret=${noSecret ? 'claimed' : 'null'} wrongSecret=${wrongSecret ? 'claimed' : 'null'} withSecret=${withSecret ? 'ok' : 'null'}`,
    );
  }

  // 3) Outside-allowlist write + register_worker gates (after claim proofs).
  const outsideTenant = `outside-${randomUUID().slice(0, 8)}`;
  const outsideClient = await workerPool.connect();
  try {
    await outsideClient.query('BEGIN');
    await outsideClient.query(`SELECT set_config('app.tenant_scope', $1, true)`, [outsideTenant]);
    try {
      await outsideClient.query(
        `INSERT INTO commander_runs (
           id, tenant_id, intent_hash, work_graph_hash, work_graph_version, policy_snapshot_id, state
         ) VALUES ($1, $2, 'h', 'h', 'v1', 'proof', 'PENDING')`,
        [`proof-outside-${randomUUID().slice(0, 8)}`, outsideTenant],
      );
      failures.push(
        'database.workerOutsideAllowlistWriteRejected: INSERT outside allowlist unexpectedly succeeded',
      );
      await outsideClient.query('COMMIT');
    } catch (err) {
      try {
        await outsideClient.query('ROLLBACK');
      } catch {
        /* ignore */
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (/row-level security|permission denied/i.test(msg)) {
        workerOutsideAllowlistWriteRejected = true;
      } else {
        failures.push(`database.workerOutsideAllowlistWriteRejected: unexpected error: ${msg}`);
      }
    }
  } finally {
    outsideClient.release();
  }

  const victimId = `proof-victim-${randomUUID().slice(0, 8)}`;
  const regClient = await workerPool.connect();
  try {
    try {
      await regClient.query(
        `SELECT register_worker(
           $1::text, 'agent', 'v1', '["agent"]'::jsonb, '{}'::jsonb, 1, $1::text, $2::jsonb, NULL
         )`,
        [victimId, JSON.stringify(['victim-not-allowed'])],
      );
      failures.push(
        'database.workerCrossTenantRegisterRejected: register_worker unexpectedly succeeded',
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/WORKER_TENANT_NOT_ALLOWED/i.test(msg)) workerCrossTenantRegisterRejected = true;
      else failures.push(`database.workerCrossTenantRegisterRejected: unexpected error: ${msg}`);
    }
  } finally {
    regClient.release();
  }

  // Identity takeover: dedicated short-lived pool so register_worker cannot poison
  // the shared workerRepo pool used by later effect proofs.
  const hijackId = `proof-hijack-${randomUUID().slice(0, 8)}`;
  const workerUrl = deriveRoleDatabaseUrl(input.ownerDsn, 'commander_worker', input.workerPassword);
  const hijackPool = new Pool({ connectionString: workerUrl, max: 1 });
  try {
    const first = await hijackPool.query<{
      register_worker: { claim_secret?: string; generation?: number };
    }>(
      `SELECT register_worker(
         $1::text, 'agent', 'v1', '["agent"]'::jsonb, '{}'::jsonb, 1, $1::text, $2::jsonb, NULL
       ) AS register_worker`,
      [hijackId, JSON.stringify([allowedTenant])],
    );
    const firstSecret = first.rows[0]?.register_worker?.claim_secret;
    if (!firstSecret) {
      failures.push(
        'database.workerIdentityTakeoverRejected: initial register_worker returned no secret',
      );
    } else {
      try {
        await hijackPool.query(
          `SELECT register_worker(
             $1::text, 'agent', 'v9', '["agent"]'::jsonb, '{}'::jsonb, 1,
             'spiffe://evil/attacker', $2::jsonb, NULL
           )`,
          [hijackId, JSON.stringify([allowedTenant])],
        );
        failures.push(
          'database.workerIdentityTakeoverRejected: re-register without previous secret unexpectedly succeeded',
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/WORKER_REREGISTER_REQUIRES_SECRET/i.test(msg)) {
          const drained = await hijackPool.query<{ drain_worker: boolean }>(
            `SELECT drain_worker($1::text, 1::bigint, 'guess') AS drain_worker`,
            [hijackId],
          );
          if (drained.rows[0]?.drain_worker === true) {
            failures.push(
              'database.workerIdentityTakeoverRejected: drain_worker without secret succeeded',
            );
          } else {
            workerIdentityTakeoverRejected = true;
          }
        } else {
          failures.push(`database.workerIdentityTakeoverRejected: unexpected error: ${msg}`);
        }
      }
    }
  } finally {
    await hijackPool.end();
  }

  await ownerPool.query(
    'DELETE FROM commander_worker_claim_secrets WHERE worker_id = ANY($1::text[])',
    [[directId, victimId, peerId, updateId, hijackId]],
  );
  await ownerPool.query('DELETE FROM commander_workers WHERE id = ANY($1::text[])', [
    [directId, victimId, peerId, updateId, hijackId],
  ]);
  await ownerPool.query(
    `DELETE FROM commander_capability_revocations WHERE tenant_id = $1 AND jti = $2`,
    [allowedTenant, revokeJti],
  );

  return {
    workerDirectInsertRejected,
    workerDirectUpdateRejected,
    workerCrossTenantRegisterRejected,
    peerClaimWithoutSecretRejected,
    workerIdentityTakeoverRejected,
    workerRevocationDeleteRejected,
    claimExecuteRequiresSecret,
    workerOutsideAllowlistWriteRejected,
  };
}

async function checkAdapterOpsAuthority(input: {
  ownerPool: Pool;
  adapterOpsPool: SqlPool;
  workerPool: SqlPool;
  tenantId: string;
  failures: string[];
}): Promise<{
  adapterOpsRoleSeparated: boolean;
  adapterOpsRpcOnly: boolean;
  classAAdmissionRpcOnly: boolean;
  invalidAdapterOpsWorkerIdRejected: boolean;
}> {
  const { ownerPool, adapterOpsPool, tenantId, failures } = input;
  let adapterOpsRoleSeparated = false;
  let adapterOpsRpcOnly = false;
  let classAAdmissionRpcOnly = false;
  let invalidAdapterOpsWorkerIdRejected = false;
  const instanceId = `proof-${randomUUID().slice(0, 8)}`;

  const attrs = await ownerPool.query<{
    rolbypassrls: boolean;
    rolsuper: boolean;
    rolcreaterole: boolean;
  }>(
    `SELECT rolbypassrls, rolsuper, rolcreaterole FROM pg_roles
     WHERE rolname='commander_adapter_ops'`,
  );
  const identityClient = await adapterOpsPool.connect();
  try {
    const identity = await identityClient.query<{ session_user: string }>(
      'SELECT session_user::text AS session_user',
    );
    const role = attrs.rows[0];
    adapterOpsRoleSeparated =
      identity.rows[0]?.session_user === 'commander_adapter_ops' &&
      role?.rolbypassrls === false &&
      role?.rolsuper === false &&
      role?.rolcreaterole === false;
    if (!adapterOpsRoleSeparated) {
      failures.push('database.adapterOpsRoleSeparated: LOGIN identity or role attributes invalid');
    }

    const reconcile = await identityClient.query<{
      register_adapter_ops_worker: { id: string; generation: number; claim_secret: string };
    }>(
      `SELECT register_adapter_ops_worker('reconcile',$1,$2::jsonb,NULL) AS register_adapter_ops_worker`,
      [instanceId, JSON.stringify([tenantId])],
    );
    const compensation = await identityClient.query<{
      register_adapter_ops_worker: { id: string; generation: number; claim_secret: string };
    }>(
      `SELECT register_adapter_ops_worker('compensation',$1,$2::jsonb,NULL) AS register_adapter_ops_worker`,
      [instanceId, JSON.stringify([tenantId])],
    );
    const recon = reconcile.rows[0]?.register_adapter_ops_worker;
    const comp = compensation.rows[0]?.register_adapter_ops_worker;
    try {
      await identityClient.query(
        `SELECT register_adapter_ops_worker('reconcile','INVALID_ID',$1::jsonb,NULL)`,
        [JSON.stringify([tenantId])],
      );
    } catch (error) {
      invalidAdapterOpsWorkerIdRejected = /ADAPTER_OPS_INSTANCE_INVALID/i.test(
        error instanceof Error ? error.message : String(error),
      );
    }
    if (!invalidAdapterOpsWorkerIdRejected) {
      failures.push('database.invalidAdapterOpsWorkerIdRejected: invalid instance ID was accepted');
    }
    await identityClient.query('SELECT heartbeat_adapter_ops_worker($1,$2,$3)', [
      recon.id,
      recon.generation,
      recon.claim_secret,
    ]);
    await identityClient.query('SELECT heartbeat_adapter_ops_worker($1,$2,$3)', [
      comp.id,
      comp.generation,
      comp.claim_secret,
    ]);
    await identityClient.query('SELECT claim_reconcile_effects($1,$2,1,$3)', [
      recon.id,
      recon.generation,
      recon.claim_secret,
    ]);

    let directUpdateDenied = false;
    let genericRegisterDenied = false;
    let forwardClaimDenied = false;
    try {
      await identityClient.query('UPDATE commander_workers SET status=status WHERE id=$1', [
        recon.id,
      ]);
    } catch (error) {
      directUpdateDenied = /permission denied/i.test(
        error instanceof Error ? error.message : String(error),
      );
    }
    try {
      await identityClient.query(
        `SELECT register_worker('forged','agent','v1','["agent"]','{}',1,'forged',$1::jsonb,NULL)`,
        [JSON.stringify([tenantId])],
      );
    } catch (error) {
      genericRegisterDenied = /permission denied/i.test(
        error instanceof Error ? error.message : String(error),
      );
    }
    try {
      await identityClient.query(`SELECT claim_next_step('forged',1,1000,'guess','["agent"]')`);
    } catch (error) {
      forwardClaimDenied = /permission denied/i.test(
        error instanceof Error ? error.message : String(error),
      );
    }

    const workerReconcileExec = await ownerPool.query<{ allowed: boolean }>(
      `SELECT has_function_privilege('commander_worker', p.oid, 'EXECUTE') AS allowed
       FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='claim_reconcile_effects'`,
    );
    adapterOpsRpcOnly =
      directUpdateDenied &&
      genericRegisterDenied &&
      forwardClaimDenied &&
      workerReconcileExec.rows.every((row) => !row.allowed);
    if (!adapterOpsRpcOnly) {
      failures.push(
        'database.adapterOpsRpcOnly: adapter-ops or worker retained forbidden authority',
      );
    }
  } finally {
    identityClient.release();
  }

  const admission = await ownerPool.query<{
    owner: string;
    app_exec: boolean;
    worker_exec: boolean;
    adapter_exec: boolean;
    app_update: boolean;
    worker_update: boolean;
    adapter_update: boolean;
  }>(
    `SELECT r.rolname AS owner,
            has_function_privilege('commander_app', p.oid, 'EXECUTE') AS app_exec,
            has_function_privilege('commander_worker', p.oid, 'EXECUTE') AS worker_exec,
            has_function_privilege('commander_adapter_ops', p.oid, 'EXECUTE') AS adapter_exec,
            has_table_privilege('commander_app','commander_workers','UPDATE') AS app_update,
            has_table_privilege('commander_worker','commander_workers','UPDATE') AS worker_update,
            has_table_privilege('commander_adapter_ops','commander_workers','UPDATE') AS adapter_update
     FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner
     WHERE n.nspname='public' AND p.proname='admit_class_a_effect'`,
  );
  const rpc = admission.rows[0];
  classAAdmissionRpcOnly =
    rpc?.owner === 'commander_owner' &&
    rpc.app_exec &&
    rpc.worker_exec &&
    !rpc.adapter_exec &&
    !rpc.app_update &&
    !rpc.worker_update &&
    !rpc.adapter_update;
  if (!classAAdmissionRpcOnly) {
    failures.push(
      'database.classAAdmissionRpcOnly: owner/EXECUTE/table privilege contract invalid',
    );
  }

  return {
    adapterOpsRoleSeparated,
    adapterOpsRpcOnly,
    classAAdmissionRpcOnly,
    invalidAdapterOpsWorkerIdRejected,
  };
}

async function checkRuntimeAdmissionAttacks(input: {
  schedulerPool: SqlPool;
  appPool: SqlPool;
  workerPool: SqlPool;
  tenantA: string;
  tenantB: string;
  failures: string[];
}): Promise<{
  schedulerRawEffectInsertRejected: boolean;
  runtimeCrossTenantAdmissionRejected: boolean;
}> {
  const { schedulerPool, appPool, workerPool, tenantA, tenantB, failures } = input;
  let schedulerRawEffectInsertRejected = false;
  const schedulerClient = await schedulerPool.connect();
  try {
    await schedulerClient.query(
      `INSERT INTO commander_effects (
         id,run_id,step_id,tenant_id,type,idempotency_key,request_hash,
         policy_decision_id,policy_snapshot_id,action_digest,
         lease_worker_id,lease_worker_generation,lease_fencing_epoch,state,request
       ) VALUES ($1,'run','step',$2,'http.post','raw','hash','decision','policy','digest',
                 'worker',1,1,'ADMITTED','{}')`,
      [`proof-scheduler-raw-${randomUUID().slice(0, 8)}`, tenantA],
    );
  } catch (error) {
    schedulerRawEffectInsertRejected = /permission denied/i.test(
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    schedulerClient.release();
  }
  if (!schedulerRawEffectInsertRejected) {
    failures.push(
      'database.schedulerRawEffectInsertRejected: scheduler raw INSERT was not permission-denied',
    );
  }

  const argumentSql = [
    '$1::text',
    '$2::text',
    '$3::text',
    '$4::text',
    '$5::text',
    '$6::text',
    '$7::text',
    '$8::text',
    '$9::text',
    '$10::text',
    '$11::text',
    '$12::bigint',
    '$13::text',
    '$14::bigint',
    '$15::jsonb',
  ].join(',');
  let rejected = 0;
  for (const pool of [appPool, workerPool]) {
    const client = await pool.connect();
    try {
      await client.query(`SELECT set_config('app.tenant_scope', $1, false)`, [tenantA]);
      for (const [rpc, effectType] of [
        ['admit_class_a_effect', 'http.post'],
        ['admit_non_class_a_effect', 'read.cache'],
      ] as const) {
        try {
          await client.query(`SELECT * FROM ${rpc}(${argumentSql})`, [
            `proof-cross-${randomUUID().slice(0, 8)}`,
            'run',
            'step',
            tenantB,
            effectType,
            'idem',
            canonicalRequestHash({}),
            'decision',
            'policy',
            'digest',
            'worker',
            1,
            'lease',
            1,
            '{}',
          ]);
        } catch (error) {
          if (
            /TENANT_SCOPE_MISMATCH|TENANT_CONTEXT_INVALID/i.test(
              error instanceof Error ? error.message : String(error),
            )
          ) {
            rejected += 1;
          }
        }
      }
    } finally {
      try {
        await client.query(`SELECT set_config('app.tenant_scope', '', false)`);
      } catch {
        /* best-effort pool hygiene */
      }
      client.release();
    }
  }
  const runtimeCrossTenantAdmissionRejected = rejected === 4;
  if (!runtimeCrossTenantAdmissionRejected) {
    failures.push(
      `database.runtimeCrossTenantAdmissionRejected: rejected ${rejected}/4 raw attacks`,
    );
  }
  return { schedulerRawEffectInsertRejected, runtimeCrossTenantAdmissionRejected };
}

export async function runAuthorityProof(): Promise<AuthorityProofResult> {
  const startedAt = new Date().toISOString();
  const failures: string[] = [];
  const flags = falseFlags();
  const gitSha = resolveGitSha();
  const source = captureWorkspaceSource(gitSha);
  if (gitSha === 'unknown') {
    failures.push('gitSha unknown');
  }

  const ownerDsn = resolveOwnerDsn();
  let ownerPool: Pool | undefined;
  let appPool: (SqlPool & { end: () => Promise<void> }) | undefined;
  let workerPool: (SqlPool & { end: () => Promise<void> }) | undefined;
  let tenantAuthorityPool: (SqlPool & { end: () => Promise<void> }) | undefined;
  let adapterOpsPool: (SqlPool & { end: () => Promise<void> }) | undefined;
  let schedulerPool: (SqlPool & { end: () => Promise<void> }) | undefined;
  const suffix = `${Date.now()}`;
  const tenantA = `proof-a-${suffix}`;
  const tenantB = `proof-b-${suffix}`;
  const tenantCap = `proof-cap-${suffix}`;

  // ── Admission gate ────────────────────────────────────────────────────────
  // This proof runs migrations and re-passwords five cluster-level roles. That
  // is a mutating, cluster-scoped operation, so it must not happen implicitly
  // as part of an ordinary acceptance run. All of the following are checked
  // BEFORE a connection is opened, a migration is applied, or a role is touched.
  const rolePasswords = resolveProofRolePasswords();
  const admissionFailures = [
    ...(ownerDsn === undefined
      ? [
          'PROOF_OWNER_DSN_REQUIRED: no OWNER_DSN / COMMANDER_KERNEL_DATABASE_URL / DATABASE_URL configured',
        ]
      : assertProvisionedCiInstance(process.env, ownerDsn)),
    ...rolePasswords.failures,
  ];
  if (admissionFailures.length > 0) {
    failures.push(...admissionFailures);
    const endedAt = new Date().toISOString();
    return finalizeResult({
      gitSha,
      flags,
      failures,
      metadata: buildProofMetadata({
        gitSha,
        startedAt,
        endedAt,
        flags,
        failures,
        tenants: [tenantA, tenantB, tenantCap],
        source,
      }),
    });
  }
  const {
    app: appPassword,
    tenantAuthority: tenantAuthorityPassword,
    scheduler: schedulerPassword,
    worker: workerPassword,
    adapterOps: adapterOpsPassword,
  } = rolePasswords.passwords!;

  try {
    ownerPool = new Pool({ connectionString: ownerDsn!, max: 4 });
    await ownerPool.query('SELECT 1');
    await runKernelMigrations(ownerPool);

    await ensureRoleLogin(ownerPool, 'commander_app', appPassword);
    await ensureRoleLogin(ownerPool, 'commander_tenant_authority', tenantAuthorityPassword);
    await ensureRoleLogin(ownerPool, 'commander_scheduler', schedulerPassword);
    await ensureRoleLogin(ownerPool, 'commander_worker', workerPassword);
    await ensureRoleLogin(ownerPool, 'commander_adapter_ops', adapterOpsPassword);

    const appUrl = deriveRoleDatabaseUrl(ownerDsn!, 'commander_app', appPassword);
    const tenantAuthorityUrl = deriveRoleDatabaseUrl(
      ownerDsn!,
      'commander_tenant_authority',
      tenantAuthorityPassword,
    );
    const workerUrl = deriveRoleDatabaseUrl(ownerDsn!, 'commander_worker', workerPassword);
    const schedulerUrl = deriveRoleDatabaseUrl(ownerDsn!, 'commander_scheduler', schedulerPassword);
    const adapterOpsUrl = deriveRoleDatabaseUrl(
      ownerDsn!,
      'commander_adapter_ops',
      adapterOpsPassword,
    );

    appPool = createLoginPool(appUrl);
    tenantAuthorityPool = createLoginPool(tenantAuthorityUrl);
    workerPool = createLoginPool(workerUrl);
    schedulerPool = createLoginPool(schedulerUrl);
    adapterOpsPool = createLoginPool(adapterOpsUrl);

    const appRepo = new PostgresKernelRepository(appPool, {
      tenantContextAuthority: new PostgresTenantContextAuthority(tenantAuthorityPool),
      tenantContextPhase: 'enforce',
    });
    const workerRepo = new PostgresKernelRepository(workerPool, { schedulerMode: false });

    // Worker RLS now requires allowlist membership for any tenant-scoped write.
    await seedWorkerAllowedTenants(ownerPool, [tenantA, tenantB, tenantCap]);
    await ownerPool.query(
      `INSERT INTO commander_tenant_authority_allowed_tenants (tenant_id)
       VALUES ($1), ($2), ($3)
       ON CONFLICT (tenant_id) DO UPDATE SET enabled = true`,
      [tenantA, tenantB, tenantCap],
    );

    flags.database.rlsEnabled = await checkRlsEnabled(ownerPool, failures);
    flags.database.rolesSeparated = await checkRolesSeparated({
      ownerPool,
      appPool,
      workerPool,
      appRepo,
      workerRepo,
      tenantA,
      tenantB,
      failures,
    });

    const workerThreat = await checkWorkerDsnThreat({
      ownerPool,
      workerPool,
      workerRepo,
      appRepo,
      allowedTenant: tenantA,
      ownerDsn: ownerDsn!,
      workerPassword,
      failures,
    });
    flags.database.workerDirectInsertRejected = workerThreat.workerDirectInsertRejected;
    flags.database.workerDirectUpdateRejected = workerThreat.workerDirectUpdateRejected;
    flags.database.workerCrossTenantRegisterRejected =
      workerThreat.workerCrossTenantRegisterRejected;
    flags.database.peerClaimWithoutSecretRejected = workerThreat.peerClaimWithoutSecretRejected;
    flags.database.workerIdentityTakeoverRejected = workerThreat.workerIdentityTakeoverRejected;
    flags.database.workerRevocationDeleteRejected = workerThreat.workerRevocationDeleteRejected;
    flags.database.claimExecuteRequiresSecret = workerThreat.claimExecuteRequiresSecret;
    flags.database.workerOutsideAllowlistWriteRejected =
      workerThreat.workerOutsideAllowlistWriteRejected;

    const adapterOps = await checkAdapterOpsAuthority({
      ownerPool,
      adapterOpsPool,
      workerPool,
      tenantId: tenantA,
      failures,
    });
    flags.database.adapterOpsRoleSeparated = adapterOps.adapterOpsRoleSeparated;
    flags.database.adapterOpsRpcOnly = adapterOps.adapterOpsRpcOnly;
    flags.database.classAAdmissionRpcOnly = adapterOps.classAAdmissionRpcOnly;
    flags.database.invalidAdapterOpsWorkerIdRejected = adapterOps.invalidAdapterOpsWorkerIdRejected;

    const runtimeAttacks = await checkRuntimeAdmissionAttacks({
      schedulerPool,
      appPool,
      workerPool,
      tenantA,
      tenantB,
      failures,
    });
    flags.database.schedulerRawEffectInsertRejected =
      runtimeAttacks.schedulerRawEffectInsertRejected;
    flags.database.runtimeCrossTenantAdmissionRejected =
      runtimeAttacks.runtimeCrossTenantAdmissionRejected;

    const effect = await checkEffectBindings({
      ownerPool,
      appRepo,
      workerRepo,
      tenantId: tenantA,
      failures,
    });
    flags.effect = effect;

    flags.capability = await checkCapability({
      workerRepo,
      tenantId: tenantCap,
      failures,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    failures.push(`connect/migrate/proof error: ${msg}`);
  } finally {
    try {
      if (ownerPool) {
        await ownerPool.query('DELETE FROM commander_runs WHERE tenant_id = ANY($1::text[])', [
          [tenantA, tenantB, tenantCap],
        ]);
        await ownerPool.query(
          `DELETE FROM commander_capability_replays WHERE tenant_id = ANY($1::text[])`,
          [[tenantCap]],
        );
        await ownerPool.query(
          `DELETE FROM commander_capability_revocations WHERE tenant_id = ANY($1::text[])`,
          [[tenantCap]],
        );
        await ownerPool.query(
          `DELETE FROM commander_workers WHERE id LIKE $1 OR id LIKE $2 OR id LIKE $3 OR id LIKE $4 OR id LIKE $5 OR id LIKE $6 OR id LIKE $7`,
          [
            'proof-worker-%',
            'proof-fence-%',
            'proof-direct-%',
            'proof-victim-%',
            'proof-peer-%',
            'reconcile:proof-%',
            'compensation:proof-%',
          ],
        );
        await ownerPool.query(
          `DELETE FROM commander_worker_claim_secrets WHERE worker_id LIKE $1 OR worker_id LIKE $2 OR worker_id LIKE $3 OR worker_id LIKE $4 OR worker_id LIKE $5 OR worker_id LIKE $6 OR worker_id LIKE $7`,
          [
            'proof-worker-%',
            'proof-fence-%',
            'proof-direct-%',
            'proof-victim-%',
            'proof-peer-%',
            'reconcile:proof-%',
            'compensation:proof-%',
          ],
        );
        await ownerPool.query(
          `DELETE FROM commander_worker_allowed_tenants WHERE tenant_id = ANY($1::text[])`,
          [[tenantA, tenantB, tenantCap]],
        );
        await ownerPool.query(
          `DELETE FROM commander_tenant_authority_allowed_tenants WHERE tenant_id = ANY($1::text[])`,
          [[tenantA, tenantB, tenantCap]],
        );
      }
    } catch {
      /* cleanup best-effort */
    }
    await appPool?.end().catch(() => undefined);
    await tenantAuthorityPool?.end().catch(() => undefined);
    await workerPool?.end().catch(() => undefined);
    await schedulerPool?.end().catch(() => undefined);
    await adapterOpsPool?.end().catch(() => undefined);
    await ownerPool?.end().catch(() => undefined);
  }

  const endedAt = new Date().toISOString();
  // The proof measured a specific source snapshot. Re-capture it now and refuse
  // to certify anything if the source moved while the probes were running.
  // The proof's own artifacts are written by main() after this point, so they
  // cannot be mistaken for source drift.
  const observedSource = captureWorkspaceSource(gitSha);
  failures.push(...sourceSnapshotFailures(source, observedSource));

  return finalizeResult({
    gitSha,
    flags,
    failures,
    metadata: buildProofMetadata({
      gitSha,
      startedAt,
      endedAt,
      flags,
      failures,
      tenants: [tenantA, tenantB, tenantCap],
      source: observedSource,
    }),
  });
}

async function main(): Promise<void> {
  const result = await runAuthorityProof();
  const flags: AuthorityProofFlags = {
    database: result.database,
    effect: result.effect,
    capability: result.capability,
  };
  const evidenceBody = createProofEvidenceBody(flags);
  const logBody = createProofLogBody({
    outcomes: result.metadata.outcomes,
    timing: result.metadata.timing,
  });
  // Exact artifact bytes (canonical JSON + trailing newline) — sha256 matches file on disk.
  const artifactBody = `${canonicalJson(result)}\n`;
  const hash = sha256Hex(artifactBody);
  const sourceManifestBody = createSourceManifestBody(result.metadata.source);

  await mkdir(dirname(ARTIFACT_PATH), { recursive: true });
  await writeFile(EVIDENCE_PATH, evidenceBody, 'utf8');
  await writeFile(LOG_PATH, logBody, 'utf8');
  await writeFile(SOURCE_MANIFEST_PATH, sourceManifestBody, 'utf8');
  await writeFile(ARTIFACT_PATH, artifactBody, 'utf8');
  const manifestBody = `${canonicalJson(createArtifactManifest(ARTIFACT_PATH, artifactBody))}\n`;
  await writeFile(MANIFEST_PATH, manifestBody, 'utf8');

  // Human-readable summary on stderr; machine JSON on stdout.
  console.error(`authority-closure-proof: ${result.evidenceLevel} passed=${result.passed}`);
  console.error(`artifact: ${ARTIFACT_PATH}`);
  console.error(`sha256: ${hash}`);
  if (result.failures.length > 0) {
    for (const f of result.failures) console.error(`  - ${f}`);
  }
  process.stdout.write(artifactBody);

  if (!result.passed || result.evidenceLevel !== 'ENFORCED') {
    process.exit(1);
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
