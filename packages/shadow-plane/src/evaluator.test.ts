import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, it } from 'node:test';
import { actionGatewayPolicySnapshot } from '@praetor/contracts';
import { canonicalBytes, sha256Hex, verifyEd25519 } from './canonical.js';
import { parseShadowManifest, parseShadowObservation } from './contracts.js';
import { evaluateShadowObservation, observationDigest } from './evaluator.js';

const snapshot = actionGatewayPolicySnapshot();

function observation(overrides: Record<string, unknown> = {}) {
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
    destination: 'k8s://cluster-1/namespace-1/deployments/api',
    productionDecision: 'require_approval',
    productionReasonCode: 'REGISTERED_ADAPTER_POLICY',
    ...overrides,
  });
}

describe('canonical crypto and historical evaluation', () => {
  it('uses RFC 8785 bytes and lowercase SHA-256', () => {
    assert.equal(canonicalBytes({ b: 1, a: 'é' }).toString('utf8'), '{"a":"é","b":1}');
    assert.match(sha256Hex(Buffer.from('commander')), /^[0-9a-f]{64}$/);
    assert.equal(sha256Hex(Buffer.from('commander')), sha256Hex(Buffer.from('commander')));
  });

  it('verifies Ed25519 and rejects tampering, wrong keys, and non-canonical base64url', () => {
    const trusted = generateKeyPairSync('ed25519');
    const wrong = generateKeyPairSync('ed25519');
    const body = { campaignId: 'campaign-1', records: [1, 2] };
    const signature = sign(null, canonicalBytes(body), trusted.privateKey).toString('base64url');
    assert.equal(verifyEd25519(body, signature, trusted.publicKey), true);
    assert.equal(verifyEd25519({ ...body, records: [1, 3] }, signature, trusted.publicKey), false);
    assert.equal(verifyEd25519(body, signature, wrong.publicKey), false);
    assert.equal(verifyEd25519(body, `${signature}=`, trusted.publicKey), false);
  });

  it('signs a manifest without its detached signature field', () => {
    const pair = generateKeyPairSync('ed25519');
    const unsigned = {
      schema: 'commander.shadow-manifest/v1',
      campaignId: 'campaign-1',
      tenantId: 'tenant-1',
      producerId: 'producer-1',
      policyId: snapshot.policyId,
      policyDigest: snapshot.descriptorDigest,
      batchId: 'batch-1',
      closesAt: '2026-09-02T00:00:00.000Z',
      records: [
        { index: 0, observationId: 'observation-1', digest: observationDigest(observation()) },
      ],
      keyId: 'manifest-key-1',
    };
    const signature = sign(null, canonicalBytes(unsigned), pair.privateKey).toString('base64url');
    const parsed = parseShadowManifest({ ...unsigned, signature });
    const { signature: detached, ...signedBody } = parsed;
    assert.equal(verifyEd25519(signedBody, detached, pair.publicKey), true);
  });

  it('requires the pinned policy and matching record digest', () => {
    const input = observation();
    assert.deepEqual(
      evaluateShadowObservation(input, {
        policyId: snapshot.policyId,
        policyDigest: snapshot.descriptorDigest,
        expectedDigest: observationDigest(input),
      }),
      {
        decision: 'require_approval',
        decisionId: 'action-gateway-manifest-require_approval',
        reasonCode: 'REGISTERED_ADAPTER_POLICY',
        policyId: snapshot.policyId,
        policyDigest: snapshot.descriptorDigest,
      },
    );
    assert.throws(
      () =>
        evaluateShadowObservation(input, {
          policyId: 'other',
          policyDigest: snapshot.descriptorDigest,
        }),
      /SHADOW_POLICY_MISMATCH/,
    );
    assert.throws(
      () =>
        evaluateShadowObservation(input, {
          policyId: snapshot.policyId,
          policyDigest: 'b'.repeat(64),
          expectedDigest: 'c'.repeat(64),
        }),
      /SHADOW_POLICY_MISMATCH/,
    );
    assert.throws(
      () =>
        evaluateShadowObservation(input, {
          policyId: snapshot.policyId,
          policyDigest: snapshot.descriptorDigest,
          expectedDigest: 'c'.repeat(64),
        }),
      /SHADOW_DIGEST_MISMATCH/,
    );
  });

  it('denies malformed destinations and maps missing facts to insufficient evidence', () => {
    assert.equal(
      evaluateShadowObservation(observation({ destination: 'k8s://bad' }), {
        policyId: snapshot.policyId,
        policyDigest: snapshot.descriptorDigest,
      }).decision,
      'deny',
    );
    assert.deepEqual(
      evaluateShadowObservation(observation({ destination: null }), {
        policyId: snapshot.policyId,
        policyDigest: snapshot.descriptorDigest,
      }),
      {
        decision: 'insufficient_evidence',
        decisionId: 'shadow-insufficient-evidence',
        reasonCode: 'MISSING_POLICY_FACTS',
        policyId: snapshot.policyId,
        policyDigest: snapshot.descriptorDigest,
      },
    );
  });

  it('rejects unsupported actions before the missing-fact short-circuit', () => {
    const pin = { policyId: snapshot.policyId, policyDigest: snapshot.descriptorDigest };
    // A specified but unregistered action is unsupported even when another fact
    // is null; it must not be downgraded to insufficient_evidence.
    assert.throws(
      () =>
        evaluateShadowObservation(
          observation({
            effectType: 'connector.aws.s3.delete',
            tool: 'aws.s3.delete',
            destination: null,
          }),
          pin,
        ),
      /SHADOW_UNSUPPORTED_ACTION/,
    );
    assert.throws(
      () => evaluateShadowObservation(observation({ tool: 'aws.s3.delete' }), pin),
      /SHADOW_UNSUPPORTED_ACTION/,
    );
    assert.throws(
      () => evaluateShadowObservation(observation({ effectType: 'connector.aws.s3.delete' }), pin),
      /SHADOW_UNSUPPORTED_ACTION/,
    );
  });
});
