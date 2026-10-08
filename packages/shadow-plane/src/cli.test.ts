import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  truncateSync,
  writeFileSync,
  symlinkSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { actionGatewayPolicySnapshot } from '@praetor/contracts';
import { canonicalBytes, sha256Hex } from './canonical.js';
import { parseShadowManifest, parseShadowObservation } from './contracts.js';
import { observationDigest } from './evaluator.js';
import { runShadowCli, type ShadowCliRepository } from './cli.js';

const manifestKeys = generateKeyPairSync('ed25519');
const reportKeys = generateKeyPairSync('ed25519');
const snapshot = actionGatewayPolicySnapshot();
it('executes the installed CLI through a package-manager symlink', () => {
  const directory = mkdtempSync(join(tmpdir(), 'shadow-bin-'));
  const executable = join(directory, 'commander-shadow.ts');
  symlinkSync(fileURLToPath(new URL('./cli.ts', import.meta.url)), executable);
  const result = spawnSync(process.execPath, ['--import', 'tsx', executable], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout), { status: 'error', code: 'SHADOW_USAGE_INVALID' });
});
const trustedManifests = new Map([
  [
    'manifest-key-1',
    {
      algorithm: 'Ed25519' as const,
      keyId: 'manifest-key-1',
      status: 'active' as const,
      publicKey: manifestKeys.publicKey,
    },
  ],
]);

function observation() {
  return parseShadowObservation({
    schema: 'commander.shadow-observation/v1',
    campaignId: 'campaign-1',
    tenantId: 'tenant-1',
    producerId: 'producer-1',
    batchId: 'batch-1',
    index: 0,
    observationId: 'observation-1',
    occurredAt: '2026-09-01T00:00:00.000Z',
    workflow: 'kubernetes.deployment.rollback',
    effectType: 'connector.kubernetes.deployment.rollback',
    tool: 'kubernetes.deployment.rollback',
    destination: 'k8s://cluster/namespace/deployments/api',
    productionDecision: 'require_approval',
    productionReasonCode: 'REGISTERED_ADAPTER_POLICY',
  });
}

function manifest() {
  const input = observation();
  const unsigned = {
    schema: 'commander.shadow-manifest/v1',
    campaignId: 'campaign-1',
    tenantId: 'tenant-1',
    producerId: 'producer-1',
    policyId: snapshot.policyId,
    policyDigest: snapshot.descriptorDigest,
    batchId: 'batch-1',
    closesAt: '2026-09-02T00:00:00.000Z',
    records: [{ index: 0, observationId: input.observationId, digest: observationDigest(input) }],
    keyId: 'manifest-key-1',
  };
  return parseShadowManifest({
    ...unsigned,
    signature: sign(null, canonicalBytes(unsigned), manifestKeys.privateKey).toString('base64url'),
  });
}

class FakeRepository implements ShadowCliRepository {
  readonly calls: string[] = [];
  readonly imported: unknown[] = [];
  async registerManifest() {
    this.calls.push('register');
    return { idempotent: false };
  }
  async importObservation(_tenantId: string, value: unknown) {
    this.calls.push('import');
    this.imported.push(value);
    if (value === null || typeof value !== 'object' || !('campaignId' in value)) {
      throw new Error('SHADOW_MISSING_FIELD');
    }
    if (
      value !== null &&
      typeof value === 'object' &&
      'productionDecision' in value &&
      value.productionDecision === 'invalid'
    ) {
      throw new Error('SHADOW_INVALID_DECISION');
    }
    return { idempotent: false };
  }
  async closeDueBatch() {
    this.calls.push('close');
  }
  async readReport() {
    this.calls.push('report');
    const input = observation();
    const registeredManifest = manifest();
    return {
      campaign: {
        campaign_id: 'campaign-1',
        policy_id: snapshot.policyId,
        policy_digest: snapshot.descriptorDigest,
        state: 'open',
      },
      batches: [
        {
          batch_id: 'batch-1',
          state: 'closed',
          manifest: registeredManifest,
          manifest_digest: sha256Hex(canonicalBytes(registeredManifest)),
        },
      ],
      records: [
        {
          batch_id: 'batch-1',
          record_index: 0,
          observation_id: input.observationId,
          digest: observationDigest(input),
          status: 'compared',
          canonical_observation: input,
          hypothetical_decision: 'require_approval',
          hypothetical_decision_id: 'action-gateway-manifest-require_approval',
          hypothetical_reason_code: 'REGISTERED_ADAPTER_POLICY',
          production_decision: 'require_approval',
          production_reason_code: 'REGISTERED_ADAPTER_POLICY',
          comparison: 'match',
        },
      ],
    };
  }
  async withdrawCampaign() {
    this.calls.push('withdraw');
  }
  async runRetention() {
    this.calls.push('retention');
    return 2;
  }
  async readiness(_tenantId?: string, _freshness?: number, operation = 'status') {
    this.calls.push(`ready:${operation}`);
    return { ready: true, code: 'SHADOW_READY' };
  }
}

function dependencies(repository: ShadowCliRepository) {
  return {
    repository,
    tenantId: 'tenant-1',
    cleanupFreshnessMinutes: 90,
    reportSigning: { keyId: 'report-key-1', privateKey: reportKeys.privateKey },
    manifestTrust: trustedManifests,
    sourceRevision: 'abc123',
    now: () => new Date('2026-09-03T00:00:00.000Z'),
  };
}

describe('commander-shadow CLI', () => {
  it('reports typed manifest validation codes without their input details', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'commander-shadow-cli-invalid-'));
    const file = join(directory, 'manifest.json');
    writeFileSync(file, JSON.stringify({ secret_customer_field: 'sensitive-value' }));
    assert.deepEqual(
      await runShadowCli(
        ['manifest', 'register', '--file', file],
        dependencies(new FakeRepository()),
      ),
      {
        exitCode: 1,
        output: { status: 'error', code: 'SHADOW_UNKNOWN_FIELD' },
      },
    );
  });

  it('returns actionable allowlisted errors without exposing other error contents', async () => {
    for (const code of [
      'SHADOW_BATCH_NOT_DUE',
      'SHADOW_MANIFEST_KEY_REVOKED',
      'COMMANDER_SHADOW_TENANT_ID_REQUIRED',
      'COMMANDER_DATABASE_TLS_CA_FILE_UNREADABLE',
    ]) {
      const repository = new FakeRepository();
      repository.closeDueBatch = async () => {
        throw new Error(code);
      };
      assert.deepEqual(
        await runShadowCli(
          ['batch', 'close', '--campaign', 'campaign-1', '--batch', 'batch-1'],
          dependencies(repository),
        ),
        {
          exitCode: 1,
          output: { status: 'error', code },
        },
      );
    }
    for (const error of [
      new Error('postgres://user:secret@db/tenant'),
      new Error('SHADOW_BATCH_NOT_DUE secret'),
      new Error('SHADOW_UNKNOWN_SECRET'),
      { message: 'SHADOW_BATCH_NOT_DUE', payload: 'secret' },
      'SHADOW_BATCH_NOT_DUE',
    ]) {
      const repository = new FakeRepository();
      repository.closeDueBatch = async () => {
        throw error;
      };
      assert.deepEqual(
        await runShadowCli(
          ['batch', 'close', '--campaign', 'campaign-1', '--batch', 'batch-1'],
          dependencies(repository),
        ),
        {
          exitCode: 1,
          output: { status: 'error', code: 'SHADOW_COMMAND_FAILED' },
        },
      );
    }
  });

  it('permits cleanup without report credentials and fails export before reading data', async () => {
    const repository = new FakeRepository();
    const { reportSigning, sourceRevision, ...cleanupDependencies } = dependencies(repository);
    assert.equal((await runShadowCli(['retention', 'run'], cleanupDependencies)).exitCode, 0);
    assert.equal(
      (
        await runShadowCli(
          ['campaign', 'withdraw', '--campaign', 'campaign-1', '--confirm', 'campaign-1'],
          cleanupDependencies,
        )
      ).exitCode,
      0,
    );
    assert.deepEqual(
      await runShadowCli(
        ['report', 'export', '--campaign', 'campaign-1', '--output', '/unused'],
        cleanupDependencies,
      ),
      {
        exitCode: 1,
        output: {
          status: 'error',
          code: 'COMMANDER_SHADOW_REPORT_SIGNING_PRIVATE_KEY_PEM_REQUIRED',
        },
      },
    );
    assert.equal(repository.calls.includes('report'), false);
  });

  it('routes every command through the repository and verifies exported evidence offline', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'commander-shadow-cli-'));
    const manifestFile = join(directory, 'manifest.json');
    const importFile = join(directory, 'observations.ndjson');
    const reportFile = join(directory, 'report.json');
    const publicKeyFile = join(directory, 'report-public.json');
    const manifestKeysFile = join(directory, 'manifest-keys.json');
    writeFileSync(manifestFile, JSON.stringify(manifest()));
    writeFileSync(importFile, `${JSON.stringify(observation())}\n`);
    writeFileSync(
      publicKeyFile,
      JSON.stringify({
        schema: 'commander.shadow-report-trust/v1',
        algorithm: 'Ed25519',
        keyId: 'report-key-1',
        status: 'active',
        publicKeyPem: reportKeys.publicKey.export({ format: 'pem', type: 'spki' }),
      }),
    );
    writeFileSync(
      manifestKeysFile,
      JSON.stringify([
        {
          algorithm: 'Ed25519',
          keyId: 'manifest-key-1',
          status: 'active',
          publicKeyPem: manifestKeys.publicKey.export({ format: 'pem', type: 'spki' }),
        },
      ]),
    );
    const repository = new FakeRepository();
    const deps = dependencies(repository);

    for (const argv of [
      ['manifest', 'register', '--file', manifestFile],
      ['import', '--file', importFile],
      ['batch', 'close', '--campaign', 'campaign-1', '--batch', 'batch-1'],
      ['report', 'export', '--campaign', 'campaign-1', '--output', reportFile],
      ['campaign', 'withdraw', '--campaign', 'campaign-1', '--confirm', 'campaign-1'],
      ['retention', 'run'],
      ['status'],
    ])
      assert.equal((await runShadowCli(argv, deps)).exitCode, 0);

    const verify = await runShadowCli([
      'report',
      'verify',
      '--bundle',
      reportFile,
      '--public-key',
      publicKeyFile,
      '--manifest-keys',
      manifestKeysFile,
    ]);
    assert.deepEqual(verify, {
      exitCode: 0,
      output: { status: 'ok', code: 'SHADOW_REPORT_VALID' },
    });

    // CLI-level tamper detection: mutating a record inside the exported bundle
    // must not verify. Previously the only tampered-bundle coverage lived in
    // report.test.ts (the unit verifier), not in the CLI command path.
    const tamperedFile = join(directory, 'report-tampered.json');
    const exported = JSON.parse(readFileSync(reportFile, 'utf8')) as {
      records: Array<{ hypotheticalDecision: string }>;
    };
    assert.ok(exported.records.length > 0, 'the exported report must carry records');
    exported.records[0]!.hypotheticalDecision = 'deny';
    writeFileSync(tamperedFile, JSON.stringify(exported));
    const tampered = await runShadowCli([
      'report',
      'verify',
      '--bundle',
      tamperedFile,
      '--public-key',
      publicKeyFile,
      '--manifest-keys',
      manifestKeysFile,
    ]);
    assert.equal(tampered.exitCode, 1);
    assert.equal(tampered.output.status, 'error');
    assert.equal((tampered.output as { code?: string }).code, 'SHADOW_REPORT_SIGNATURE_INVALID');

    const revokedKeyFile = join(directory, 'report-revoked.json');
    writeFileSync(
      revokedKeyFile,
      JSON.stringify({
        schema: 'commander.shadow-report-trust/v1',
        algorithm: 'Ed25519',
        keyId: 'report-key-1',
        status: 'revoked',
        publicKeyPem: reportKeys.publicKey.export({ format: 'pem', type: 'spki' }),
      }),
    );
    assert.equal(
      (
        await runShadowCli([
          'report',
          'verify',
          '--bundle',
          reportFile,
          '--public-key',
          revokedKeyFile,
          '--manifest-keys',
          manifestKeysFile,
        ])
      ).output.code,
      'SHADOW_REPORT_KEY_REVOKED',
    );
    assert.deepEqual(repository.calls, [
      'ready:manifest-register',
      'register',
      'ready:import',
      'import',
      'ready:batch-close',
      'close',
      'ready:report-export',
      'report',
      'ready:campaign-withdraw',
      'withdraw',
      'ready:retention-run',
      'retention',
      'ready:status',
    ]);
    assert.equal(JSON.parse(readFileSync(reportFile, 'utf8')).schema, 'commander.shadow-report/v1');
  });

  it('requires exact withdrawal confirmation and reports partial imports', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'commander-shadow-cli-'));
    const file = join(directory, 'partial.ndjson');
    writeFileSync(file, `${JSON.stringify(observation())}\n{"bad":true}\n`);
    const repository = new FakeRepository();
    assert.equal(
      (
        await runShadowCli(
          ['campaign', 'withdraw', '--campaign', 'campaign-1', '--confirm', 'yes'],
          dependencies(repository),
        )
      ).exitCode,
      1,
    );
    const result = await runShadowCli(['import', '--file', file], dependencies(repository));
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.output, {
      status: 'error',
      code: 'SHADOW_IMPORT_PARTIAL',
      imported: 1,
      existing: 0,
      rejected: 1,
    });
  });

  it('passes bound schema-invalid observations to PostgreSQL for rejection evidence', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'commander-shadow-cli-'));
    const file = join(directory, 'rejected.ndjson');
    writeFileSync(file, `${JSON.stringify({ ...observation(), productionDecision: 'invalid' })}\n`);
    const repository = new FakeRepository();
    const result = await runShadowCli(['import', '--file', file], dependencies(repository));
    assert.deepEqual(result, {
      exitCode: 1,
      output: {
        status: 'error',
        code: 'SHADOW_IMPORT_PARTIAL',
        imported: 0,
        existing: 0,
        rejected: 1,
      },
    });
    assert.equal(repository.imported.length, 1);
  });

  it('counts sensitive observations as rejections and continues the bounded import', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'commander-shadow-cli-'));
    const file = join(directory, 'sensitive.ndjson');
    writeFileSync(file, `${JSON.stringify(observation())}\n${JSON.stringify(observation())}\n`);
    const repository = new FakeRepository();
    let attempts = 0;
    repository.importObservation = async () => {
      if (attempts++ === 0) throw new Error('SHADOW_SENSITIVE_DATA');
      return { idempotent: false };
    };
    assert.deepEqual(await runShadowCli(['import', '--file', file], dependencies(repository)), {
      exitCode: 1,
      output: {
        status: 'error',
        code: 'SHADOW_IMPORT_PARTIAL',
        imported: 1,
        existing: 0,
        rejected: 1,
      },
    });
  });

  it('bounds NDJSON lines and sanitizes unexpected errors', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'commander-shadow-cli-'));
    const file = join(directory, 'oversize.ndjson');
    writeFileSync(file, `${'x'.repeat(17_000)}\n`);
    const repository = new FakeRepository();
    const oversized = await runShadowCli(['import', '--file', file], dependencies(repository));
    assert.equal(oversized.exitCode, 1);
    assert.equal(oversized.output.code, 'SHADOW_IMPORT_PARTIAL');
    repository.registerManifest = async () => {
      throw new Error('postgres://user:top-secret@db/customer');
    };
    const manifestFile = join(directory, 'manifest.json');
    writeFileSync(manifestFile, JSON.stringify(manifest()));
    const failed = await runShadowCli(
      ['manifest', 'register', '--file', manifestFile],
      dependencies(repository),
    );
    assert.deepEqual(failed, {
      exitCode: 1,
      output: { status: 'error', code: 'SHADOW_COMMAND_FAILED' },
    });
    assert.doesNotMatch(JSON.stringify(failed), /top-secret|postgres:/);
  });

  it('rejects an empty import file and reports idempotent replays separately', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'commander-shadow-cli-'));
    const empty = join(directory, 'empty.ndjson');
    writeFileSync(empty, '');
    assert.deepEqual(
      await runShadowCli(['import', '--file', empty], dependencies(new FakeRepository())),
      {
        exitCode: 1,
        output: {
          status: 'error',
          code: 'SHADOW_IMPORT_EMPTY',
          imported: 0,
          existing: 0,
          rejected: 0,
        },
      },
    );

    const replay = join(directory, 'replay.ndjson');
    writeFileSync(replay, `${JSON.stringify(observation())}\n`);
    const repository = new FakeRepository();
    repository.importObservation = async () => ({ idempotent: true });
    assert.deepEqual(await runShadowCli(['import', '--file', replay], dependencies(repository)), {
      exitCode: 0,
      output: {
        status: 'ok',
        code: 'SHADOW_IMPORT_COMPLETE',
        imported: 0,
        existing: 1,
        rejected: 0,
      },
    });
  });

  it('bounds the record count and reports truncation instead of counting the tail as rejected', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'commander-shadow-cli-'));
    const file = join(directory, 'truncated.ndjson');
    writeFileSync(file, `${JSON.stringify(observation())}\n`.repeat(10_001));
    const repository = new FakeRepository();
    assert.deepEqual(await runShadowCli(['import', '--file', file], dependencies(repository)), {
      exitCode: 1,
      output: {
        status: 'error',
        code: 'SHADOW_IMPORT_TRUNCATED',
        imported: 10_000,
        existing: 0,
        rejected: 0,
      },
    });
    assert.equal(repository.imported.length, 10_000);
  });

  it('bounds the total import bytes without a single line terminator', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'commander-shadow-cli-'));
    const file = join(directory, 'unterminated.ndjson');
    // A sparse file larger than the byte cap: without the cap the stream is read
    // to EOF before the (per-line) bound can reject it.
    writeFileSync(file, '');
    truncateSync(file, 10_000 * 16 * 1024 + 1);
    const result = await runShadowCli(
      ['import', '--file', file],
      dependencies(new FakeRepository()),
    );
    assert.deepEqual(result, {
      exitCode: 1,
      output: { status: 'error', code: 'SHADOW_IMPORT_TOO_LARGE' },
    });
  });

  it('distinguishes a non-regular --file from an oversized one', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'commander-shadow-cli-'));
    const subdirectory = join(directory, 'subdirectory');
    mkdirSync(subdirectory);
    assert.deepEqual(
      await runShadowCli(
        ['manifest', 'register', '--file', subdirectory],
        dependencies(new FakeRepository()),
      ),
      { exitCode: 1, output: { status: 'error', code: 'SHADOW_INPUT_NOT_REGULAR' } },
    );
  });

  it('passes atomicExport failure codes through the CLI error boundary', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'commander-shadow-cli-'));
    assert.deepEqual(
      await runShadowCli(
        [
          'report',
          'export',
          '--campaign',
          'campaign-1',
          '--output',
          join(directory, 'missing-parent', 'report.json'),
        ],
        dependencies(new FakeRepository()),
      ),
      { exitCode: 1, output: { status: 'error', code: 'SHADOW_EXPORT_PARENT_INVALID' } },
    );
  });

  it('fails closed on operation readiness and lets retention recover overdue cleanup', async () => {
    const repository = new FakeRepository();
    repository.readiness = async (
      _tenantId?: string,
      _freshness?: number,
      operation = 'status',
    ) => {
      repository.calls.push(`ready:${operation}`);
      return operation === 'retention-run'
        ? { ready: true, code: 'SHADOW_READY' }
        : { ready: false, code: 'SHADOW_CLEANUP_OVERDUE' };
    };
    const directory = mkdtempSync(join(tmpdir(), 'commander-shadow-cli-'));
    const manifestFile = join(directory, 'manifest.json');
    writeFileSync(manifestFile, JSON.stringify(manifest()));

    assert.deepEqual(
      await runShadowCli(
        ['manifest', 'register', '--file', manifestFile],
        dependencies(repository),
      ),
      { exitCode: 1, output: { status: 'error', code: 'SHADOW_CLEANUP_OVERDUE' } },
    );
    assert.equal(
      (await runShadowCli(['retention', 'run'], dependencies(repository))).output.code,
      'SHADOW_RETENTION_COMPLETE',
    );
    assert.deepEqual(repository.calls, [
      'ready:manifest-register',
      'ready:retention-run',
      'retention',
    ]);
  });
});
