import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { AdapterExecutionError } from '@praetor/effect-broker';
import { KubernetesRollbackFaultArm, type FaultControlCommand } from './faultControl.js';

const destination = 'k8s://cluster-a/team-a/deployments/api';

function command(): FaultControlCommand {
  return {
    campaignId: 'campaign-a',
    tenantId: 'tenant-a',
    provider: 'kubernetes',
    destination,
    destinationHash: createHash('sha256').update(destination).digest('hex'),
    effectId: 'effect-a',
    idempotencyKey: 'idem-a',
    faults: ['adapter.timeout-after-commit'],
    audience: 'commander.effect-broker',
    sourceCommit: 'a'.repeat(40),
    imageDigest: `sha256:${'a'.repeat(64)}`,
    expiresAt: '2030-01-01T00:01:00.000Z',
    nonce: 'nonce-a',
    issuer: 'commander',
    keyId: 'kid-a',
    workerId: 'compensation-daemon',
    workerGeneration: 1,
  };
}

describe('KubernetesRollbackFaultArm', () => {
  it('consumes exactly one matching committed PATCH and disarms before classifying it unknown', async () => {
    const arm = new KubernetesRollbackFaultArm();
    const controller = new AbortController();
    const pending = arm.apply({ command: command(), signal: controller.signal });

    await assert.rejects(
      () =>
        arm.afterPatchResponse({
          tenantId: 'tenant-a',
          effectId: 'effect-a',
          idempotencyKey: 'idem-a',
          destination,
        }),
      (error: unknown) =>
        error instanceof AdapterExecutionError &&
        error.code === 'GOVERNED_TIMEOUT_AFTER_COMMIT' &&
        error.commitState === 'UNKNOWN' &&
        error.retryMode === 'QUERY_FIRST',
    );
    await pending;

    await arm.afterPatchResponse({
      tenantId: 'tenant-a',
      effectId: 'effect-a',
      idempotencyKey: 'idem-a',
      destination,
    });
    await arm.cleanup({ command: command() });
  });

  it('does not consume an arm for a different effect', async () => {
    const arm = new KubernetesRollbackFaultArm();
    const controller = new AbortController();
    const pending = arm.apply({ command: command(), signal: controller.signal });

    await arm.afterPatchResponse({
      tenantId: 'tenant-a',
      effectId: 'other-effect',
      idempotencyKey: 'idem-a',
      destination,
    });
    controller.abort();
    await assert.rejects(() => pending, /FAULT_CONTROL_ABORTED/);
  });
});
