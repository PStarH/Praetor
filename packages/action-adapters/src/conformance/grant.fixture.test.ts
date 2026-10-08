import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CapabilityTokenIssuer,
  CapabilityTokenVerifier,
  canonicalRequestHash,
} from '@praetor/effect-broker';
import { buildConformanceIssueInput, conformanceGrantIssueFields } from './grantFixture.js';

describe('conformance grant fixture', () => {
  it('buildConformanceIssueInput() default shape includes required grant fields', () => {
    const input = buildConformanceIssueInput();
    assert.equal(typeof input.policySnapshotId, 'string');
    assert.ok(input.policySnapshotId.length > 0);
    assert.equal(typeof input.workloadId, 'string');
    assert.ok(input.workloadId.length > 0);
    assert.equal(typeof input.nonce, 'string');
    assert.ok(input.nonce.length > 0);
  });

  it('issuer.issue(buildConformanceIssueInput(...)) round-trips via verify', async () => {
    const issuer = CapabilityTokenIssuer.generate({
      issuer: 'commander-worker',
      audience: 'commander.effect-broker',
      keyId: 'conformance',
    });
    const verifier = new CapabilityTokenVerifier({
      issuer: 'commander-worker',
      audience: 'commander.effect-broker',
      publicKeys: { conformance: issuer.publicKey },
    });
    const token = issuer.issue(
      buildConformanceIssueInput({
        jti: 'jti-fixture',
        tenantId: 'tenant-fixture',
        runId: 'run-fixture',
        stepId: 'step-fixture',
        effectTypes: ['connector.test.effect'],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        requestHash: canonicalRequestHash({ destination: 'test', idempotencyKey: 'k1', args: {} }),
      }),
    );
    const grant = await verifier.verify(token);
    assert.equal(grant.policySnapshotId, conformanceGrantIssueFields.policySnapshotId);
    assert.equal(grant.workloadId, conformanceGrantIssueFields.workloadId);
    assert.equal(grant.nonce, conformanceGrantIssueFields.nonce);
  });

  it('aligns chaos scenario constants with suite broker evaluate', () => {
    assert.equal(conformanceGrantIssueFields.workloadId, 'worker-1');
    assert.equal(conformanceGrantIssueFields.policySnapshotId, 'policy');
  });

  it('never hands out the shared fixture object by reference', () => {
    const first = buildConformanceIssueInput();
    assert.notEqual(first, conformanceGrantIssueFields);
    assert.equal(Object.isFrozen(conformanceGrantIssueFields), true);
    const mutable = first as unknown as Record<string, string>;
    mutable.nonce = 'mutated-by-caller';
    const second = buildConformanceIssueInput();
    assert.equal(second.nonce, 'nonce-conformance-chaos');
  });
});
