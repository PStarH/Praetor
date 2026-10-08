import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, it } from 'node:test';
import { actionGatewayPolicySnapshot } from '@praetor/contracts';
import { canonicalBytes, sha256Hex } from './canonical.js';
import { parseShadowManifest, parseShadowObservation } from './contracts.js';
import { observationDigest } from './evaluator.js';
import type { ShadowCampaignReportData } from './repository.js';
import { buildSignedShadowReport, verifyShadowReport } from './report.js';

const pair = generateKeyPairSync('ed25519');
const wrong = generateKeyPairSync('ed25519');
const manifestPair = generateKeyPairSync('ed25519');
const snapshot = actionGatewayPolicySnapshot();
const trustedManifests = new Map([
  [
    'manifest-key-1',
    {
      algorithm: 'Ed25519' as const,
      keyId: 'manifest-key-1',
      status: 'active' as const,
      publicKey: manifestPair.publicKey,
    },
  ],
]);

function resignReport(bundle: ReturnType<typeof buildSignedShadowReport>) {
  bundle.hashes.recordsSha256 = sha256Hex(canonicalBytes(bundle.records));
  const { signature: _signature, ...body } = bundle;
  bundle.signature = sign(null, canonicalBytes(body), pair.privateKey).toString('base64url');
}

function signManifest(unsigned: Record<string, unknown>): Record<string, unknown> {
  return {
    ...unsigned,
    signature: sign(null, canonicalBytes(unsigned), manifestPair.privateKey).toString('base64url'),
  };
}

// Re-signs one embedded manifest with the trusted manifest key, so a mutation is
// as authoritative as the original material and only semantics can reject it.
function replaceBundleManifest(
  bundle: ReturnType<typeof buildSignedShadowReport>,
  position: number,
  mutate: (manifest: Record<string, unknown>) => void,
): void {
  const { signature: _signature, ...unsigned } = bundle.manifests[position]! as unknown as Record<
    string,
    unknown
  >;
  mutate(unsigned);
  bundle.manifests[position] = parseShadowManifest(signManifest(unsigned));
  bundle.hashes.manifestsSha256 = sha256Hex(canonicalBytes(bundle.manifests));
}

function reportData(): ShadowCampaignReportData {
  const records: Record<string, unknown>[] = [];
  const manifestRecords: Record<string, unknown>[] = [];
  for (let index = 0; index < 100; index += 1) {
    const observation = parseShadowObservation({
      schema: 'commander.shadow-observation/v1',
      campaignId: 'campaign-100',
      tenantId: 'tenant-1',
      producerId: 'producer-1',
      batchId: 'batch-100',
      index,
      observationId: `observation-${index}`,
      occurredAt: '2026-09-01T00:00:00.000Z',
      workflow: 'kubernetes.deployment.rollback',
      effectType: 'connector.kubernetes.deployment.rollback',
      tool: 'kubernetes.deployment.rollback',
      destination: 'k8s://cluster/namespace/deployments/api',
      productionDecision: index < 20 ? 'allow' : index < 80 ? 'require_approval' : 'unknown',
      productionReasonCode: index >= 20 && index < 80 ? 'REGISTERED_ADAPTER_POLICY' : undefined,
    });
    manifestRecords.push({
      index,
      observationId: observation.observationId,
      digest: observationDigest(observation),
    });
    let status = 'failed';
    if (index < 80) status = 'compared';
    else if (index < 90) status = 'uncomparable';
    else if (index < 95) status = 'missing';
    else if (index < 98) status = 'rejected';
    records.push({
      batch_id: 'batch-100',
      record_index: index,
      observation_id: observation.observationId,
      digest: observationDigest(observation),
      status,
      ...(status === 'rejected' || status === 'failed'
        ? {
            attempt_digest: 'b'.repeat(64),
            attempt_code:
              status === 'rejected' ? 'SHADOW_INVALID_DECISION' : 'SHADOW_EVALUATION_FAILED',
            attempted_at: '2026-09-01T01:00:00.000Z',
          }
        : {}),
      ...(index < 90
        ? {
            canonical_observation: observation,
            hypothetical_decision: 'require_approval',
            hypothetical_decision_id: 'action-gateway-manifest-require_approval',
            hypothetical_reason_code: 'REGISTERED_ADAPTER_POLICY',
            production_decision: observation.productionDecision,
            production_reason_code: observation.productionReasonCode ?? null,
            comparison: index < 20 ? 'mismatch' : index < 80 ? 'match' : 'uncomparable',
          }
        : {}),
    });
  }
  const unsignedManifest = {
    schema: 'commander.shadow-manifest/v1',
    campaignId: 'campaign-100',
    tenantId: 'tenant-1',
    producerId: 'producer-1',
    policyId: snapshot.policyId,
    policyDigest: snapshot.descriptorDigest,
    batchId: 'batch-100',
    closesAt: '2026-09-02T00:00:00.000Z',
    records: manifestRecords,
    keyId: 'manifest-key-1',
  };
  const manifest = {
    ...unsignedManifest,
    signature: sign(null, canonicalBytes(unsignedManifest), manifestPair.privateKey).toString(
      'base64url',
    ),
  };
  return {
    campaign: {
      campaign_id: 'campaign-100',
      policy_id: snapshot.policyId,
      policy_digest: snapshot.descriptorDigest,
      state: 'open',
    },
    batches: [
      {
        batch_id: 'batch-100',
        state: 'closed',
        manifest_digest: sha256Hex(canonicalBytes(manifest)),
        manifest,
      },
    ],
    records,
  };
}

function singleRecordReportData(
  batches: Array<{ batchId: string; tenantId: string; producerId: string }>,
): ShadowCampaignReportData {
  const records: Record<string, unknown>[] = [];
  const manifestBatches: Record<string, unknown>[] = [];
  for (const batch of batches) {
    const observation = parseShadowObservation({
      schema: 'commander.shadow-observation/v1',
      campaignId: 'campaign-100',
      tenantId: batch.tenantId,
      producerId: batch.producerId,
      batchId: batch.batchId,
      index: 0,
      observationId: `${batch.batchId}-observation-0`,
      occurredAt: '2026-09-01T00:00:00.000Z',
      workflow: 'kubernetes.deployment.rollback',
      effectType: 'connector.kubernetes.deployment.rollback',
      tool: 'kubernetes.deployment.rollback',
      destination: 'k8s://cluster/namespace/deployments/api',
      productionDecision: 'require_approval',
      productionReasonCode: 'REGISTERED_ADAPTER_POLICY',
    });
    const digest = observationDigest(observation);
    const unsigned = {
      schema: 'commander.shadow-manifest/v1',
      campaignId: 'campaign-100',
      tenantId: batch.tenantId,
      producerId: batch.producerId,
      policyId: snapshot.policyId,
      policyDigest: snapshot.descriptorDigest,
      batchId: batch.batchId,
      closesAt: '2026-09-02T00:00:00.000Z',
      records: [{ index: 0, observationId: observation.observationId, digest }],
      keyId: 'manifest-key-1',
    };
    const manifest = signManifest(unsigned);
    manifestBatches.push({
      batch_id: batch.batchId,
      state: 'closed',
      manifest_digest: sha256Hex(canonicalBytes(manifest)),
      manifest,
    });
    records.push({
      batch_id: batch.batchId,
      record_index: 0,
      observation_id: observation.observationId,
      digest,
      status: 'compared',
      canonical_observation: observation,
      hypothetical_decision: 'require_approval',
      hypothetical_decision_id: 'action-gateway-manifest-require_approval',
      hypothetical_reason_code: 'REGISTERED_ADAPTER_POLICY',
      production_decision: 'require_approval',
      production_reason_code: 'REGISTERED_ADAPTER_POLICY',
      comparison: 'match',
    });
  }
  return {
    campaign: {
      campaign_id: 'campaign-100',
      policy_id: snapshot.policyId,
      policy_digest: snapshot.descriptorDigest,
      state: 'open',
    },
    batches: manifestBatches,
    records,
  };
}

describe('signed historical evaluation report', () => {
  it('refuses to sign records detached from the signed manifest identity or denominator', () => {
    for (const mutation of [
      (data: ShadowCampaignReportData) => {
        data.records.pop();
      },
      (data: ShadowCampaignReportData) => {
        data.records[0]!.observation_id = 'other';
      },
    ]) {
      const data = reportData();
      mutation(data);
      assert.throws(
        () =>
          buildSignedShadowReport(data, {
            keyId: 'report-key-1',
            privateKey: pair.privateKey,
            generatedAt: '2026-09-03T00:00:00.000Z',
            sourceRevision: 'abc123',
            manifestTrust: trustedManifests,
          }),
        /SHADOW_REPORT_MANIFEST_RECORD_MISMATCH/,
      );
    }
  });
  it('reports the exact 100-record denominator and all terminal states without cost or proof claims', () => {
    const bundle = buildSignedShadowReport(reportData(), {
      keyId: 'report-key-1',
      privateKey: pair.privateKey,
      generatedAt: '2026-09-03T00:00:00.000Z',
      sourceRevision: 'abc123',
      manifestTrust: trustedManifests,
    });
    assert.deepEqual(bundle.counts, {
      expected: 100,
      missing: 5,
      rejected: 3,
      failed: 2,
      uncomparable: 10,
      compared: 80,
      matches: 60,
      mismatches: 20,
    });
    assert.equal(bundle.decisionMatrix.allow.require_approval, 20);
    assert.equal(bundle.decisionMatrix.require_approval.require_approval, 60);
    assert.deepEqual(Object.keys(bundle.decisionMatrix), ['allow', 'deny', 'require_approval']);
    assert.equal(bundle.differences.length, 20);
    assert.equal(bundle.differences[0]?.productionDecision, 'allow');
    assert.deepEqual(bundle.records[95]?.attempt, {
      digest: 'b'.repeat(64),
      code: 'SHADOW_INVALID_DECISION',
      attemptedAt: '2026-09-01T01:00:00.000Z',
    });
    const serialized = JSON.stringify(bundle);
    assert.doesNotMatch(serialized, /cost/i);
    assert.doesNotMatch(serialized, /PROVEN|production-ready|customer-accepted/i);
  });

  it('verifies hashes, signature, counts, and deterministic re-evaluation', () => {
    const bundle = buildSignedShadowReport(reportData(), {
      keyId: 'report-key-1',
      privateKey: pair.privateKey,
      generatedAt: '2026-09-03T00:00:00.000Z',
      sourceRevision: 'abc123',
      manifestTrust: trustedManifests,
    });
    const trust = {
      algorithm: 'Ed25519' as const,
      keyId: 'report-key-1',
      status: 'active' as const,
      publicKey: pair.publicKey,
    };
    assert.deepEqual(verifyShadowReport(bundle, trust, trustedManifests), {
      valid: true,
      code: 'SHADOW_REPORT_VALID',
    });
    assert.deepEqual(
      verifyShadowReport(bundle, { ...trust, publicKey: wrong.publicKey }, trustedManifests),
      {
        valid: false,
        code: 'SHADOW_REPORT_SIGNATURE_INVALID',
      },
    );
    assert.deepEqual(
      verifyShadowReport(bundle, { ...trust, status: 'revoked' }, trustedManifests),
      {
        valid: false,
        code: 'SHADOW_REPORT_KEY_REVOKED',
      },
    );
    assert.deepEqual(
      verifyShadowReport(bundle, { ...trust, keyId: 'replacement-key' }, trustedManifests),
      {
        valid: false,
        code: 'SHADOW_REPORT_KEY_ID_MISMATCH',
      },
    );
    const tampered = structuredClone(bundle);
    tampered.records[0]!.hypotheticalDecision = 'deny';
    assert.equal(verifyShadowReport(tampered, trust, trustedManifests).valid, false);

    const inconsistent = structuredClone(bundle);
    inconsistent.records[20]!.observationId = 'other-observation';
    inconsistent.hashes.recordsSha256 = sha256Hex(canonicalBytes(inconsistent.records));
    const { signature: _signature, ...body } = inconsistent;
    inconsistent.signature = sign(null, canonicalBytes(body), pair.privateKey).toString(
      'base64url',
    );
    assert.deepEqual(verifyShadowReport(inconsistent, trust, trustedManifests), {
      valid: false,
      code: 'SHADOW_REPORT_MANIFEST_RECORD_MISMATCH',
    });
  });

  it('rejects report creation while any batch remains open', () => {
    const data = reportData();
    data.batches[0]!.state = 'open';
    assert.throws(
      () =>
        buildSignedShadowReport(data, {
          keyId: 'report-key-1',
          privateKey: pair.privateKey,
          generatedAt: '2026-09-03T00:00:00.000Z',
          sourceRevision: 'abc123',
          manifestTrust: trustedManifests,
        }),
      /SHADOW_REPORT_BATCH_OPEN/,
    );
  });

  it('normalizes PostgreSQL timestamptz Date values in rejected and failed attempts', () => {
    const data = reportData();
    data.records[95]!.attempted_at = new Date('2026-09-01T01:00:00.000Z');
    data.records[98]!.attempted_at = new Date('2026-09-01T02:00:00.000Z');

    const bundle = buildSignedShadowReport(data, {
      keyId: 'report-key-1',
      privateKey: pair.privateKey,
      generatedAt: '2026-09-03T00:00:00.000Z',
      sourceRevision: 'abc123',
      manifestTrust: trustedManifests,
    });

    assert.equal(bundle.records[95]?.attempt?.attemptedAt, '2026-09-01T01:00:00.000Z');
    assert.equal(bundle.records[98]?.attempt?.attemptedAt, '2026-09-01T02:00:00.000Z');
  });

  it('rejects persisted fields that do not belong to the terminal status before signing', () => {
    for (const status of ['missing', 'rejected'] as const) {
      const data = reportData();
      data.records[0]!.status = status;
      if (status === 'rejected') {
        data.records[0]!.attempt_digest = 'b'.repeat(64);
        data.records[0]!.attempt_code = 'SHADOW_INVALID_DECISION';
        data.records[0]!.attempted_at = '2026-09-01T01:00:00.000Z';
      }
      assert.throws(
        () =>
          buildSignedShadowReport(data, {
            keyId: 'report-key-1',
            privateKey: pair.privateKey,
            generatedAt: '2026-09-03T00:00:00.000Z',
            sourceRevision: 'abc123',
            manifestTrust: trustedManifests,
          }),
        /SHADOW_REPORT_RECORD_INVALID/,
        status,
      );
    }
  });

  it('rejects missing facts and duplicated production decisions during verification', () => {
    const trust = {
      algorithm: 'Ed25519' as const,
      keyId: 'report-key-1',
      status: 'active' as const,
      publicKey: pair.publicKey,
    };
    const missingFacts = buildSignedShadowReport(reportData(), {
      keyId: 'report-key-1',
      privateKey: pair.privateKey,
      generatedAt: '2026-09-03T00:00:00.000Z',
      sourceRevision: 'abc123',
      manifestTrust: trustedManifests,
    });
    delete missingFacts.records[0]!.facts;
    resignReport(missingFacts);
    assert.deepEqual(verifyShadowReport(missingFacts, trust, trustedManifests), {
      valid: false,
      code: 'SHADOW_REPORT_RECORD_INVALID',
    });

    const inconsistentDecision = buildSignedShadowReport(reportData(), {
      keyId: 'report-key-1',
      privateKey: pair.privateKey,
      generatedAt: '2026-09-03T00:00:00.000Z',
      sourceRevision: 'abc123',
      manifestTrust: trustedManifests,
    });
    inconsistentDecision.records[20]!.productionDecision = 'deny';
    resignReport(inconsistentDecision);
    assert.deepEqual(verifyShadowReport(inconsistentDecision, trust, trustedManifests), {
      valid: false,
      code: 'SHADOW_REPORT_RECORD_INVALID',
    });
  });

  it('rejects status and comparison disagreement even when aggregates are resigned', () => {
    const bundle = buildSignedShadowReport(reportData(), {
      keyId: 'report-key-1',
      privateKey: pair.privateKey,
      generatedAt: '2026-09-03T00:00:00.000Z',
      sourceRevision: 'abc123',
      manifestTrust: trustedManifests,
    });
    bundle.records[0]!.status = 'uncomparable';
    bundle.counts.compared -= 1;
    bundle.counts.uncomparable += 1;
    bundle.counts.mismatches -= 1;
    bundle.decisionMatrix.allow.require_approval -= 1;
    bundle.differences.shift();
    resignReport(bundle);

    assert.deepEqual(
      verifyShadowReport(
        bundle,
        {
          algorithm: 'Ed25519',
          keyId: 'report-key-1',
          status: 'active',
          publicKey: pair.publicKey,
        },
        trustedManifests,
      ),
      { valid: false, code: 'SHADOW_REPORT_RECORD_INVALID' },
    );
  });

  it('independently verifies active manifest trust during construction and verification', () => {
    const options = {
      keyId: 'report-key-1',
      privateKey: pair.privateKey,
      generatedAt: '2026-09-03T00:00:00.000Z',
      sourceRevision: 'abc123',
      manifestTrust: trustedManifests,
    };
    assert.throws(
      () => buildSignedShadowReport(reportData(), { ...options, manifestTrust: new Map() }),
      /SHADOW_MANIFEST_KEY_UNTRUSTED/,
    );
    assert.throws(
      () =>
        buildSignedShadowReport(reportData(), {
          ...options,
          manifestTrust: new Map([
            ['manifest-key-1', { ...trustedManifests.get('manifest-key-1')!, status: 'revoked' }],
          ]),
        }),
      /SHADOW_MANIFEST_KEY_REVOKED/,
    );

    const bundle = buildSignedShadowReport(reportData(), options);
    const reportTrust = {
      algorithm: 'Ed25519' as const,
      keyId: 'report-key-1',
      status: 'active' as const,
      publicKey: pair.publicKey,
    };
    assert.deepEqual(verifyShadowReport(bundle, reportTrust, new Map()), {
      valid: false,
      code: 'SHADOW_REPORT_MANIFEST_KEY_UNTRUSTED',
    });
    assert.deepEqual(
      verifyShadowReport(
        bundle,
        reportTrust,
        new Map([
          ['manifest-key-1', { ...trustedManifests.get('manifest-key-1')!, status: 'revoked' }],
        ]),
      ),
      { valid: false, code: 'SHADOW_REPORT_MANIFEST_KEY_REVOKED' },
    );
    assert.deepEqual(
      verifyShadowReport(
        bundle,
        reportTrust,
        new Map([
          [
            'manifest-key-1',
            { ...trustedManifests.get('manifest-key-1')!, publicKey: wrong.publicKey },
          ],
        ]),
      ),
      { valid: false, code: 'SHADOW_REPORT_MANIFEST_SIGNATURE_INVALID' },
    );

    const tampered = structuredClone(bundle);
    tampered.manifests[0]!.producerId = 'other-producer';
    tampered.hashes.manifestsSha256 = sha256Hex(canonicalBytes(tampered.manifests));
    const { signature: _signature, ...body } = tampered;
    tampered.signature = sign(null, canonicalBytes(body), pair.privateKey).toString('base64url');
    assert.deepEqual(verifyShadowReport(tampered, reportTrust, trustedManifests), {
      valid: false,
      code: 'SHADOW_REPORT_MANIFEST_SIGNATURE_INVALID',
    });
  });

  const reportOptions = {
    keyId: 'report-key-1',
    privateKey: pair.privateKey,
    generatedAt: '2026-09-03T00:00:00.000Z',
    sourceRevision: 'abc123',
    manifestTrust: trustedManifests,
  };
  const reportTrust = {
    algorithm: 'Ed25519' as const,
    keyId: 'report-key-1',
    status: 'active' as const,
    publicKey: pair.publicKey,
  };

  it('refuses to sign facts that contradict their signed manifest tenant or producer', () => {
    for (const [field, value] of [
      ['tenantId', 'other-tenant'],
      ['producerId', 'other-producer'],
    ] as const) {
      const data = reportData();
      const batch = data.batches[0]!;
      const { signature: _signature, ...unsigned } = batch.manifest as Record<string, unknown>;
      const resigned = signManifest({ ...unsigned, [field]: value });
      batch.manifest = resigned;
      batch.manifest_digest = sha256Hex(canonicalBytes(resigned));
      assert.throws(
        () => buildSignedShadowReport(data, reportOptions),
        /SHADOW_REPORT_MANIFEST_RECORD_MISMATCH/,
        field,
      );
    }
  });

  it('rejects a re-signed report whose manifest tenant or producer contradicts its facts', () => {
    for (const [field, value] of [
      ['tenantId', 'other-tenant'],
      ['producerId', 'other-producer'],
    ] as const) {
      const bundle = buildSignedShadowReport(reportData(), reportOptions);
      replaceBundleManifest(bundle, 0, (manifest) => {
        manifest[field] = value;
      });
      resignReport(bundle);
      assert.deepEqual(verifyShadowReport(bundle, reportTrust, trustedManifests), {
        valid: false,
        code: 'SHADOW_REPORT_MANIFEST_RECORD_MISMATCH',
      });
    }
  });

  it('binds tenant and producer across the whole campaign, not just within one batch', () => {
    const consistent = singleRecordReportData([
      { batchId: 'batch-100', tenantId: 'tenant-1', producerId: 'producer-1' },
      { batchId: 'batch-101', tenantId: 'tenant-1', producerId: 'producer-1' },
    ]);
    assert.deepEqual(
      verifyShadowReport(
        buildSignedShadowReport(consistent, reportOptions),
        reportTrust,
        trustedManifests,
      ),
      { valid: true, code: 'SHADOW_REPORT_VALID' },
    );
    for (const second of [
      { batchId: 'batch-101', tenantId: 'tenant-2', producerId: 'producer-1' },
      { batchId: 'batch-101', tenantId: 'tenant-1', producerId: 'producer-2' },
    ]) {
      const data = singleRecordReportData([
        { batchId: 'batch-100', tenantId: 'tenant-1', producerId: 'producer-1' },
        second,
      ]);
      assert.throws(
        () => buildSignedShadowReport(data, reportOptions),
        /SHADOW_REPORT_MANIFEST_RECORD_MISMATCH/,
        JSON.stringify(second),
      );
    }
  });
});
