import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  canonicalRequestHash,
  CapabilityTokenIssuer,
  CapabilityTokenVerifier,
  InMemoryCapabilityReplayStore,
} from '@praetor/effect-broker';
import { CampaignFaultControlHandler, type FaultControlCommand } from './faultControl.js';

const audience = 'commander.g3.fault-control';
const destination = 'k8s://doks-g3/tenant-a/deployments/api';
const destinationHash = createHash('sha256').update(destination).digest('hex');
const commit = '416b75ef416b75ef416b75ef416b75ef416b75ef';
const imageDigest = `sha256:${'a'.repeat(64)}`;

function command(overrides: Partial<FaultControlCommand> = {}): FaultControlCommand {
  return {
    campaignId: 'g3-campaign-001',
    tenantId: 'tenant-a',
    provider: 'digitalocean',
    destination,
    destinationHash,
    effectId: 'effect-g3-001',
    idempotencyKey: 'g3-fault-control-001',
    faults: ['adapter.timeout-after-commit'],
    audience,
    sourceCommit: commit,
    imageDigest,
    expiresAt: '2030-01-01T00:01:00.000Z',
    nonce: 'nonce-g3-001',
    issuer: 'commander-g3-authority',
    keyId: 'g3-key-1',
    workerId: 'compensation-daemon',
    workerGeneration: 1,
    ...overrides,
  };
}

function signedCapability(
  input: FaultControlCommand,
  signingIssuer = input.issuer,
): {
  token: string;
  verifier: CapabilityTokenVerifier;
} {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const issuer = new CapabilityTokenIssuer({
    issuer: signingIssuer,
    audience,
    keyId: input.keyId,
    privateKey,
    clock: () => new Date('2030-01-01T00:00:00.000Z'),
  });
  const token = issuer.issue({
    jti: 'g3-jti-001',
    tenantId: input.tenantId,
    runId: input.campaignId,
    stepId: input.effectId,
    effectTypes: ['fault-control.campaign'],
    expiresAt: input.expiresAt,
    requestHash: canonicalRequestHash({ ...input }),
    nonce: input.nonce,
  });
  const verifier = new CapabilityTokenVerifier({
    issuer: signingIssuer,
    audience,
    publicKeys: { [input.keyId]: publicKey },
    replay: new InMemoryCapabilityReplayStore(),
    clock: () => new Date('2030-01-01T00:00:00.000Z'),
  });
  return { token, verifier };
}

function fixture(input = command()) {
  const { token, verifier } = signedCapability(input);
  const audits: string[] = [];
  const auditDetails: Array<Record<string, unknown>> = [];
  const calls: string[] = [];
  const handler = new CampaignFaultControlHandler({
    capability: verifier,
    audit: {
      append: async (event) => {
        audits.push(event.type);
        auditDetails.push(event.details);
      },
    },
    runtime: {
      tenantId: 'tenant-a',
      audience,
      sourceCommit: commit,
      imageDigest,
      sourceDirty: false,
      allowedDestinations: [{ provider: 'digitalocean', destinationHash }],
      allowedFaults: ['adapter.timeout-after-commit'],
      workerId: 'compensation-daemon',
      workerGeneration: 1,
    },
    executor: {
      apply: async () => {
        calls.push('apply');
      },
      cleanup: async () => {
        calls.push('cleanup');
      },
    },
    clock: () => new Date('2030-01-01T00:00:00.000Z'),
  });
  return { handler, input, token, audits, auditDetails, calls };
}

describe('CampaignFaultControlHandler', () => {
  it('accepts an exact signed capability and always cleans up after execution', async () => {
    const { handler, input, token, audits, calls } = fixture();

    const result = await handler.handle({ token, command: input });

    assert.deepEqual(result, { accepted: true });
    assert.deepEqual(calls, ['apply', 'cleanup']);
    assert.deepEqual(audits, [
      'fault_control.accepted',
      'fault_control.completed',
      'fault_control.cleaned',
    ]);
  });

  it('rejects a capability whose request binding does not match the submitted fault set', async () => {
    const { handler, input, token, audits, calls } = fixture();

    const result = await handler.handle({
      token,
      command: { ...input, faults: ['adapter.kill-after-commit'] },
    });

    assert.deepEqual(result, { accepted: false, code: 'FAULT_CONTROL_REQUEST_BINDING_MISMATCH' });
    assert.deepEqual(calls, []);
    assert.deepEqual(audits, ['fault_control.rejected']);
  });

  it('rejects a capability for a stale adapter-ops worker generation', async () => {
    const input = command({ workerGeneration: 2 });
    const { handler, token, audits, auditDetails, calls } = fixture(input);

    const result = await handler.handle({ token, command: input });

    assert.deepEqual(result, { accepted: false, code: 'FAULT_CONTROL_RUNTIME_DENIED' });
    assert.deepEqual(calls, []);
    assert.deepEqual(audits, ['fault_control.rejected']);
    assert.equal(auditDetails[0]?.cellTenantId, 'tenant-a');
  });

  it('rejects a valid foreign-tenant capability before arming this cell destination', async () => {
    const input = command({ tenantId: 'tenant-b' });
    const { handler, token, audits, calls } = fixture(input);

    const result = await handler.handle({ token, command: input });

    assert.deepEqual(result, { accepted: false, code: 'FAULT_CONTROL_RUNTIME_DENIED' });
    assert.deepEqual(calls, []);
    assert.deepEqual(audits, ['fault_control.rejected']);
  });

  it('rejects a signed grant whose issuer differs from the command capability claim', async () => {
    const { handler, input, audits, calls } = fixture();
    const foreignCapability = signedCapability(input, 'untrusted-g3-authority');
    const foreignHandler = new CampaignFaultControlHandler({
      capability: foreignCapability.verifier,
      audit: {
        append: async (event) => {
          audits.push(event.type);
        },
      },
      runtime: {
        tenantId: 'tenant-a',
        audience,
        sourceCommit: commit,
        imageDigest,
        sourceDirty: false,
        allowedDestinations: [{ provider: 'digitalocean', destinationHash }],
        allowedFaults: ['adapter.timeout-after-commit'],
        workerId: 'compensation-daemon',
        workerGeneration: 1,
      },
      executor: {
        apply: async () => {
          calls.push('apply');
        },
        cleanup: async () => {
          calls.push('cleanup');
        },
      },
      clock: () => new Date('2030-01-01T00:00:00.000Z'),
    });

    const result = await foreignHandler.handle({ token: foreignCapability.token, command: input });

    assert.deepEqual(result, { accepted: false, code: 'FAULT_CONTROL_REQUEST_BINDING_MISMATCH' });
    assert.deepEqual(calls, []);
    assert.deepEqual(audits, ['fault_control.rejected']);
  });

  it('aborts timed out execution and cleans up the admitted fault', async () => {
    const { input, audits, calls } = fixture();
    const timeoutCapability = signedCapability(input);
    const timeoutHandler = new CampaignFaultControlHandler({
      capability: timeoutCapability.verifier,
      audit: {
        append: async (event) => {
          audits.push(event.type);
        },
      },
      runtime: {
        tenantId: 'tenant-a',
        audience,
        sourceCommit: commit,
        imageDigest,
        sourceDirty: false,
        allowedDestinations: [{ provider: 'digitalocean', destinationHash }],
        allowedFaults: ['adapter.timeout-after-commit'],
        workerId: 'compensation-daemon',
        workerGeneration: 1,
      },
      executor: {
        apply: async () => new Promise<void>(() => {}),
        cleanup: async () => {
          calls.push('cleanup');
        },
      },
      clock: () => new Date('2030-01-01T00:00:00.000Z'),
    });

    const result = await timeoutHandler.handle({
      token: timeoutCapability.token,
      command: input,
      timeoutMs: 1,
    });

    assert.deepEqual(result, { accepted: false, code: 'FAULT_CONTROL_EXECUTION_TIMEOUT' });
    assert.deepEqual(calls, ['cleanup']);
    assert.deepEqual(audits, [
      'fault_control.accepted',
      'fault_control.failed',
      'fault_control.cleaned',
    ]);
  });

  it('does not report success when mandatory cleanup fails', async () => {
    const { input, token, audits } = fixture();
    const cleanupCapability = signedCapability(input);
    const handler = new CampaignFaultControlHandler({
      capability: cleanupCapability.verifier,
      audit: {
        append: async (event) => {
          audits.push(event.type);
        },
      },
      runtime: {
        tenantId: 'tenant-a',
        audience,
        sourceCommit: commit,
        imageDigest,
        sourceDirty: false,
        allowedDestinations: [{ provider: 'digitalocean', destinationHash }],
        allowedFaults: ['adapter.timeout-after-commit'],
        workerId: 'compensation-daemon',
        workerGeneration: 1,
      },
      executor: {
        apply: async () => {},
        cleanup: async () => {
          throw new Error('remote cleanup failed');
        },
      },
      clock: () => new Date('2030-01-01T00:00:00.000Z'),
    });

    const result = await handler.handle({ token: cleanupCapability.token, command: input });

    assert.deepEqual(result, { accepted: false, code: 'FAULT_CONTROL_CLEANUP_FAILED' });
    assert.deepEqual(audits, [
      'fault_control.accepted',
      'fault_control.completed',
      'fault_control.cleanup_failed',
    ]);
  });

  it('limits execution to the signed capability expiry and cleans up', async () => {
    const input = command({ expiresAt: '2030-01-01T00:00:00.010Z' });
    const capability = signedCapability(input);
    const audits: string[] = [];
    const calls: string[] = [];
    const handler = new CampaignFaultControlHandler({
      capability: capability.verifier,
      audit: {
        append: async (event) => {
          audits.push(event.type);
        },
      },
      runtime: {
        tenantId: 'tenant-a',
        audience,
        sourceCommit: commit,
        imageDigest,
        sourceDirty: false,
        allowedDestinations: [{ provider: 'digitalocean', destinationHash }],
        allowedFaults: ['adapter.timeout-after-commit'],
        workerId: 'compensation-daemon',
        workerGeneration: 1,
      },
      executor: {
        apply: async ({ signal }) =>
          new Promise<void>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
        cleanup: async () => {
          calls.push('cleanup');
        },
      },
      clock: () => new Date('2030-01-01T00:00:00.000Z'),
    });

    const result = await handler.handle({
      token: capability.token,
      command: input,
      timeoutMs: 30_000,
    });

    assert.deepEqual(result, { accepted: false, code: 'FAULT_CONTROL_CAPABILITY_EXPIRED' });
    assert.deepEqual(calls, ['cleanup']);
    assert.deepEqual(audits, [
      'fault_control.accepted',
      'fault_control.failed',
      'fault_control.cleaned',
    ]);
  });

  it('rejects a capability whose total lifetime exceeds the five-minute control window', async () => {
    const input = command({ expiresAt: '2030-01-01T00:06:00.000Z' });
    const { handler, token, audits, calls } = fixture(input);

    const result = await handler.handle({ token, command: input });

    assert.deepEqual(result, { accepted: false, code: 'FAULT_CONTROL_RUNTIME_DENIED' });
    assert.deepEqual(calls, []);
    assert.deepEqual(audits, ['fault_control.rejected']);
  });
});
