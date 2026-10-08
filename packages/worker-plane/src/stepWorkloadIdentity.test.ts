import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CapabilityTokenIssuer,
  CapabilityTokenVerifier,
  EffectBroker,
  canonicalRequestHash,
} from '@praetor/effect-broker';
import type { ClaimedStep, WorkerRecord } from './types.js';
import {
  getStepWorkloadBinding,
  mintStepCapabilityToken,
  requireStepWorkloadBinding,
  runWithStepWorkloadIdentity,
} from './stepWorkloadIdentity.js';

const worker: WorkerRecord = {
  id: 'w1',
  kind: 'agent',
  version: 'v1',
  capabilities: ['agent'],
  maxConcurrency: 2,
  status: 'ACTIVE',
  generation: 1,
  activeSteps: 0,
  identitySubject: 'spiffe://commander/worker/w1',
  tenantIds: ['tenant-a'],
  registeredAt: '2099-01-01T00:00:00.000Z',
  lastHeartbeatAt: '2099-01-01T00:00:00.000Z',
};

const step: ClaimedStep = {
  id: 'step-1',
  runId: 'run-1',
  tenantId: 'tenant-a',
  kind: 'agent',
  version: 1,
  attempt: 1,
  input: {},
  lease: {
    workerId: 'w1',
    workerGeneration: 1,
    token: 'lease',
    fencingEpoch: 1,
    expiresAt: '2099-01-01T00:00:00.000Z',
  },
};

describe('stepWorkloadIdentity (L3-07 / Task 3)', () => {
  it('derives binding from claim + worker registration via ALS', () => {
    runWithStepWorkloadIdentity(step, worker, () => {
      const binding = getStepWorkloadBinding();
      assert.ok(binding);
      assert.equal(binding.tenantId, 'tenant-a');
      assert.equal(binding.runId, 'run-1');
      assert.equal(binding.stepId, 'step-1');
      assert.equal(binding.workloadId, 'w1:1');
      assert.equal(binding.workerId, 'w1');
      assert.equal(binding.workerGeneration, 1);
    });
    assert.equal(getStepWorkloadBinding(), undefined);
  });

  it('throws WORKLOAD_LEASE_BINDING_MISMATCH when lease workerId/generation diverge', () => {
    const staleGen: ClaimedStep = {
      ...step,
      lease: { ...step.lease, workerGeneration: 0 },
    };
    assert.throws(
      () => runWithStepWorkloadIdentity(staleGen, worker, () => undefined),
      /WORKLOAD_LEASE_BINDING_MISMATCH/,
    );
    const wrongWorker: ClaimedStep = {
      ...step,
      lease: { ...step.lease, workerId: 'other' },
    };
    assert.throws(
      () => runWithStepWorkloadIdentity(wrongWorker, worker, () => undefined),
      /WORKLOAD_LEASE_BINDING_MISMATCH/,
    );
    const missingGen: ClaimedStep = {
      ...step,
      lease: { workerId: 'w1', token: 'lease', fencingEpoch: 1, expiresAt: step.lease.expiresAt },
    };
    assert.throws(
      () => runWithStepWorkloadIdentity(missingGen, worker, () => undefined),
      /WORKLOAD_LEASE_BINDING_MISMATCH/,
    );
  });

  it('mintStepCapabilityToken uses binding tenant/run/step/workloadId only', async () => {
    const issuer = CapabilityTokenIssuer.generate({
      issuer: 'commander-worker',
      audience: 'commander.effect-broker',
      keyId: 'k1',
    });
    await runWithStepWorkloadIdentity(step, worker, async () => {
      const binding = requireStepWorkloadBinding();
      const token = mintStepCapabilityToken({
        issuer,
        effectType: 'crm.write',
        request: { action: 'x' },
      });
      const ver = new CapabilityTokenVerifier({
        issuer: 'commander-worker',
        audience: 'commander.effect-broker',
        publicKeys: { k1: issuer.publicKey },
      });
      const grant = await ver.verify(token);
      assert.equal(grant.tenantId, binding.tenantId);
      assert.equal(grant.runId, binding.runId);
      assert.equal(grant.stepId, binding.stepId);
      assert.equal(grant.workloadId, binding.workloadId);
      assert.equal(grant.workerId, binding.workerId);
      assert.equal(grant.workerGeneration, binding.workerGeneration);
      assert.equal(grant.requestHash, canonicalRequestHash({ action: 'x' }));
      assert.equal(
        grant.actionDigest,
        canonicalRequestHash({ action: 'x' }),
        'Class A mint must include actionDigest',
      );
    });
  });

  it('requireStepWorkloadBinding fails outside ALS', () => {
    assert.throws(() => requireStepWorkloadBinding(), /WORKLOAD_IDENTITY_REQUIRED/);
  });

  it('routes broker admit with binding and rejects cross-tenant mint', async () => {
    const issuer = CapabilityTokenIssuer.generate({
      issuer: 'commander-worker',
      audience: 'commander.effect-broker',
      keyId: 'k1',
    });
    const tokens = new CapabilityTokenVerifier({
      issuer: 'commander-worker',
      audience: 'commander.effect-broker',
      publicKeys: { k1: issuer.publicKey },
    });
    const broker = new EffectBroker(
      tokens,
      {
        evaluate: async () => ({
          effect: 'allow' as const,
          decisionId: 'd1',
          reason: 'ok',
          policySnapshotId: 'p1',
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

    await runWithStepWorkloadIdentity(step, worker, async () => {
      const binding = requireStepWorkloadBinding();
      const good = mintStepCapabilityToken({
        issuer,
        effectType: 'crm.write',
        request: {},
      });
      const admitted = await broker.admit({
        effectId: 'eff-1',
        token: good,
        type: 'crm.write',
        request: {},
        idempotencyKey: 'idem-1',
        lease: { workerId: 'w1', workerGeneration: 1, token: 'lease', fencingEpoch: 1 },
        actor: 'w1',
        workloadBinding: binding,
      });
      assert.equal(admitted.admitted, true);

      const badToken = issuer.issue({
        jti: 'bad',
        tenantId: 'tenant-b',
        runId: 'run-1',
        stepId: 'step-1',
        effectTypes: ['crm.write'],
        expiresAt: '2099-01-01T00:00:00.000Z',
        requestHash: canonicalRequestHash({}),
        workerId: 'w1',
        workerGeneration: 1,
      });
      const rejected = await broker.admit({
        effectId: 'eff-2',
        token: badToken,
        type: 'crm.write',
        request: {},
        idempotencyKey: 'idem-2',
        lease: { workerId: 'w1', workerGeneration: 1, token: 'lease', fencingEpoch: 1 },
        actor: 'w1',
        workloadBinding: binding,
      });
      assert.equal(rejected.admitted, false);
      assert.equal(rejected.reason, 'TENANT_MISMATCH');
    });
  });

  it('rejects WORKER_FENCE_MISMATCH when grant worker diverges from lease', async () => {
    const issuer = CapabilityTokenIssuer.generate({
      issuer: 'commander-worker',
      audience: 'commander.effect-broker',
      keyId: 'k1',
    });
    const tokens = new CapabilityTokenVerifier({
      issuer: 'commander-worker',
      audience: 'commander.effect-broker',
      publicKeys: { k1: issuer.publicKey },
    });
    const broker = new EffectBroker(
      tokens,
      {
        evaluate: async () => ({
          effect: 'allow' as const,
          decisionId: 'd1',
          reason: 'ok',
          policySnapshotId: 'p1',
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

    await runWithStepWorkloadIdentity(step, worker, async () => {
      const binding = requireStepWorkloadBinding();
      const token = mintStepCapabilityToken({
        issuer,
        effectType: 'crm.write',
        request: {},
      });
      const rejected = await broker.admit({
        effectId: 'eff-fence',
        token,
        type: 'crm.write',
        request: {},
        idempotencyKey: 'idem-fence',
        lease: { workerId: 'w1', workerGeneration: 99, token: 'lease', fencingEpoch: 1 },
        actor: 'w1',
        workloadBinding: binding,
      });
      assert.equal(rejected.admitted, false);
      assert.equal(rejected.reason, 'WORKER_FENCE_MISMATCH');
    });
  });

  it('isolates ALS binding across concurrent steps (no cross-step reuse)', async () => {
    const workerB: WorkerRecord = { ...worker, id: 'w2', generation: 2, tenantIds: ['tenant-b'] };
    const stepA: ClaimedStep = {
      ...step,
      id: 'step-a',
      runId: 'run-a',
      lease: { ...step.lease, workerId: 'w1', workerGeneration: 1 },
    };
    const stepB: ClaimedStep = {
      ...step,
      id: 'step-b',
      runId: 'run-b',
      tenantId: 'tenant-b',
      lease: { ...step.lease, workerId: 'w2', workerGeneration: 2 },
    };
    const seen: Array<{ stepId: string; tenantId: string; workloadId: string }> = [];

    await Promise.all([
      runWithStepWorkloadIdentity(stepA, worker, async () => {
        await new Promise((r) => setTimeout(r, 20));
        const b = requireStepWorkloadBinding();
        seen.push({ stepId: b.stepId, tenantId: b.tenantId, workloadId: b.workloadId });
      }),
      runWithStepWorkloadIdentity(stepB, workerB, async () => {
        await new Promise((r) => setTimeout(r, 5));
        const b = requireStepWorkloadBinding();
        seen.push({ stepId: b.stepId, tenantId: b.tenantId, workloadId: b.workloadId });
      }),
    ]);

    assert.equal(seen.length, 2);
    const byStep = Object.fromEntries(seen.map((s) => [s.stepId, s]));
    assert.equal(byStep['step-a']?.tenantId, 'tenant-a');
    assert.equal(byStep['step-b']?.tenantId, 'tenant-b');
    assert.equal(byStep['step-a']?.workloadId, 'w1:1');
    assert.equal(byStep['step-b']?.workloadId, 'w2:2');
  });
});
