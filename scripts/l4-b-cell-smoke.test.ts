import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  applyApiGateToComposeSidecarSteps,
  assertCapabilityAuthorityOnCellServices,
  assertKernelBackendOnCellServices,
  controlledChangeEvidenceFromProofResult,
  notReadyControlledChangeEvidence,
  runCellSmoke,
  runOptionalChaosStep,
} from './l4-b-cell-smoke.js';
import { generateCellEvidenceSigningMaterials } from './l4-b-cell-compose.js';
import { buildCellUpAssertEnv } from './l4-b-cell-up-assert.js';

const KERNEL_BACKEND_ENV = { COMMANDER_KERNEL_BACKEND: 'postgres' };

const CAPABILITY_ENV = {
  COMMANDER_CAPABILITY_PRIVATE_KEY_PEM: '-----BEGIN PRIVATE KEY-----\nM\n-----END PRIVATE KEY-----',
  COMMANDER_CAPABILITY_KEY_ID: 'test-kid',
  COMMANDER_CAPABILITY_JWKS_JSON:
    '{"keys":[{"kty":"OKP","crv":"Ed25519","x":"x","kid":"test-kid"}]}',
};

describe('l4-b-cell-smoke', () => {
  it('emits explicit NOT_READY controlled-change telemetry when no Kubernetes proof ran', () => {
    assert.deepEqual(notReadyControlledChangeEvidence(), {
      proofVerdict: 'NOT_READY',
      remoteOutcome: 'UNKNOWN',
      reconciliationLatencyMs: null,
      duplicateWriteCount: null,
      writesDuringReconciliation: null,
      compensationDisposition: 'NOT_RUN',
      irreducibleUnknownDisposition: 'NOT_RUN',
    });
  });

  it('rejects a PROVEN artifact that violates controlled-change invariants', () => {
    assert.throws(
      () =>
        controlledChangeEvidenceFromProofResult({
          verdict: 'PROVEN',
          failures: ['SIGNED_RECEIPT_REQUIRED'],
          metrics: {
            remoteOutcome: 'BOGUS',
            reconciliationLatencyMs: -1,
            duplicateWriteCount: 1,
            writesDuringReconciliation: 1,
            compensationDisposition: 'NOT_RUN',
            irreducibleUnknownDisposition: 'NOT_RUN',
          },
        }),
      /CONTROLLED_CHANGE/,
    );
    assert.throws(
      () =>
        controlledChangeEvidenceFromProofResult({
          verdict: 'PROVEN',
          failures: [],
          metrics: {
            remoteOutcome: 'APPLIED',
            reconciliationLatencyMs: 500,
            duplicateWriteCount: 0,
            writesDuringReconciliation: 0,
            compensationDisposition: 'APPLIED',
            irreducibleUnknownDisposition: 'ESCALATED',
          },
        }),
      /SIGNED_ARTIFACT_VERIFICATION_REQUIRED/,
    );
  });

  it('cell up-assert seeds the same explicit tenant scope it assigns to workers', () => {
    const env = buildCellUpAssertEnv();
    assert.equal(env.COMMANDER_CELL_TENANT_ID, 'cell-smoke-tenant');
    assert.equal(env.COMMANDER_WORKER_TENANTS, env.COMMANDER_CELL_TENANT_ID);
    assert.equal(env.COMMANDER_WORKER_ALLOWED_TENANTS, env.COMMANDER_CELL_TENANT_ID);
    assert.ok(env.COMMANDER_EVIDENCE_SIGNING_PRIVATE_KEY_PEM);
    assert.ok(env.COMMANDER_EVIDENCE_SIGNING_KEY_ID);
  });

  it('mock mode only asserts chaos step S6 (no fake deploy steps)', async (t) => {
    const result = await runCellSmoke({ mode: 'mock' });
    assert.equal(result.steps.S1, undefined);
    assert.equal(result.steps.S2, undefined);
    assert.equal(result.steps.S3, undefined);
    if (!result.steps.S6) {
      t.skip('chaos deps unavailable — build @praetor/effect-broker first');
      return;
    }
    assert.equal(result.steps.S6, true);
    assert.equal(result.passed, true);
  });

  it('mock mode fails when S6 is false', async (t) => {
    const result = await runCellSmoke({ mode: 'mock' });
    if (result.steps.S6) {
      t.skip('chaos deps available — covered by pass test');
      return;
    }
    assert.equal(result.passed, false, 'mock must not pass when S6 is false');
  });

  it('runOptionalChaosStep omits S7 by default when helper is missing', async () => {
    const steps: Record<string, boolean> = {};
    await runOptionalChaosStep(steps, {
      loadChaos: async () => {
        throw new Error('helper missing');
      },
    });
    assert.equal(steps.S7_chaos, undefined);
  });

  it('runOptionalChaosStep records S7=false when REQUIRE and helper missing', async () => {
    const steps: Record<string, boolean> = {};
    await runOptionalChaosStep(steps, {
      require: true,
      loadChaos: async () => {
        throw new Error('helper missing');
      },
    });
    assert.equal(steps.S7_chaos, false);
  });

  it('applyApiGateToComposeSidecarSteps forces S4–S6 false when S1 or S2 is false', () => {
    const steps = {
      S1: false,
      S2: true,
      S4_worker: true,
      S5_kernelOps: true,
      S6_adapterOps: true,
    };
    applyApiGateToComposeSidecarSteps(steps);
    assert.equal(steps.S4_worker, false);
    assert.equal(steps.S5_kernelOps, false);
    assert.equal(steps.S6_adapterOps, false);

    const okApi = {
      S1: true,
      S2: true,
      S4_worker: true,
      S5_kernelOps: true,
      S6_adapterOps: true,
    };
    applyApiGateToComposeSidecarSteps(okApi);
    assert.equal(okApi.S4_worker, true);
    assert.equal(okApi.S5_kernelOps, true);
    assert.equal(okApi.S6_adapterOps, true);
  });

  it('helm mode only asserts rendered template (no runtime S2/S3)', async () => {
    const result = await runCellSmoke({ mode: 'helm' });
    assert.equal(result.steps.S2, undefined);
    assert.equal(result.steps.S3, undefined);
    assert.equal(result.steps.S1, undefined);
    assert.equal(typeof result.steps.helm_template_assert, 'boolean');
    assert.equal(result.topology, 'helm-template-assert');
    assert.equal(result.passed, result.steps.helm_template_assert === true);
  });

  it('assertKernelBackendOnCellServices requires postgres on all four cell workloads', () => {
    assert.doesNotThrow(() =>
      assertKernelBackendOnCellServices({
        services: {
          api: { environment: KERNEL_BACKEND_ENV },
          worker: { environment: KERNEL_BACKEND_ENV },
          'kernel-ops': { environment: KERNEL_BACKEND_ENV },
          'adapter-ops': { environment: KERNEL_BACKEND_ENV },
        },
      }),
    );
  });

  it('assertKernelBackendOnCellServices rejects missing backend on a cell service', () => {
    assert.throws(
      () =>
        assertKernelBackendOnCellServices({
          services: {
            api: { environment: KERNEL_BACKEND_ENV },
            worker: { environment: {} },
            'kernel-ops': { environment: KERNEL_BACKEND_ENV },
            'adapter-ops': { environment: KERNEL_BACKEND_ENV },
          },
        }),
      /worker: COMMANDER_KERNEL_BACKEND must be postgres/,
    );
  });

  it('assertKernelBackendOnCellServices parses array-style environment entries', () => {
    assert.doesNotThrow(() =>
      assertKernelBackendOnCellServices({
        services: {
          api: { environment: ['COMMANDER_KERNEL_BACKEND=postgres'] },
          worker: { environment: ['COMMANDER_KERNEL_BACKEND=postgres'] },
          'kernel-ops': { environment: ['COMMANDER_KERNEL_BACKEND=postgres'] },
          'adapter-ops': { environment: ['COMMANDER_KERNEL_BACKEND=postgres'] },
        },
      }),
    );
  });

  it('assertCapabilityAuthorityOnCellServices requires PEM/JWKS/key id on worker and adapter-ops', () => {
    assert.doesNotThrow(() =>
      assertCapabilityAuthorityOnCellServices({
        services: {
          worker: { environment: { ...KERNEL_BACKEND_ENV, ...CAPABILITY_ENV } },
          'adapter-ops': { environment: { ...KERNEL_BACKEND_ENV, ...CAPABILITY_ENV } },
        },
      }),
    );
  });

  it('assertCapabilityAuthorityOnCellServices rejects missing JWKS', () => {
    assert.throws(
      () =>
        assertCapabilityAuthorityOnCellServices({
          services: {
            worker: {
              environment: {
                COMMANDER_CAPABILITY_PRIVATE_KEY_PEM:
                  CAPABILITY_ENV.COMMANDER_CAPABILITY_PRIVATE_KEY_PEM,
                COMMANDER_CAPABILITY_KEY_ID: CAPABILITY_ENV.COMMANDER_CAPABILITY_KEY_ID,
              },
            },
            'adapter-ops': { environment: CAPABILITY_ENV },
          },
        }),
      /COMMANDER_CAPABILITY_JWKS_JSON/,
    );
  });

  it('assertCapabilityAuthorityOnCellServices rejects HMAC capability-token-key on worker', () => {
    assert.throws(
      () =>
        assertCapabilityAuthorityOnCellServices({
          services: {
            worker: {
              environment: {
                ...CAPABILITY_ENV,
                COMMANDER_CAPABILITY_TOKEN_KEY: 'hmac-not-allowed',
              },
            },
            'adapter-ops': { environment: CAPABILITY_ENV },
          },
        }),
      /CAPABILITY_TOKEN_KEY/,
    );
  });
});
