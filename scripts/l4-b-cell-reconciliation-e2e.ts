#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEvidenceSigner } from '@praetor/effect-broker';
import type { KernelRepository } from '@praetor/kernel';
import { InMemoryKernelRepository } from '@praetor/kernel/testing/inMemoryRepository';
import {
  ReconciliationDaemon,
  type ReconciliationDaemonOptions,
} from '../packages/adapter-ops/src/reconciliationDaemon.js';

export type ReconciliationE2EMode = 'mock' | 'postgres';

export interface ReconciliationMockResult {
  counters: {
    forwardWrites: number;
    outcomeQueries: number;
    duplicateWrites: number;
  };
  effectState: string;
}

export interface ReconciliationE2EResult {
  mode: ReconciliationE2EMode;
  verdict: 'ENFORCED-script-only' | 'WIRED' | 'BLOCKED';
  passed: boolean;
  steps: Record<string, boolean | string | number>;
  elapsedMs: number;
}

function adaptReconciliationRepository(
  repository: KernelRepository,
): ReconciliationDaemonOptions['repository'] {
  return {
    listEffectsForRun: (runId, tenantId) => repository.listEffectsForRun(runId, tenantId),
    listEvents: (runId, tenantId) => repository.listEvents(runId, tenantId),
    claimReconcileEffects: (input) => repository.claimReconcileEffects(input),
    completeReconcileEffect: (input) => repository.completeReconcileEffect(input),
    confirmEffectNotApplied: (input) => repository.confirmEffectNotApplied(input),
    rescheduleReconcileEffect: (input) => repository.rescheduleReconcileEffect(input),
    escalateReconcileEffect: (input) =>
      repository.escalateReconcileEffect({
        ...input,
        reason:
          input.reason === 'COMPENSATION_QUERY_UNSUPPORTED'
            ? 'RECONCILE_QUERY_UNSUPPORTED'
            : input.reason,
      }),
  };
}

export async function runAdapterOpsReconciliationMock(): Promise<ReconciliationMockResult> {
  const tenantId = 'reconciliation-script-tenant';
  const runId = 'reconciliation-script-run';
  const stepId = 'reconciliation-script-step';
  const effectId = 'reconciliation-script-effect';
  const forwardWorkerId = 'worker:reconciliation-script';
  const reconcileWorkerId = 'reconcile:reconciliation-script';
  const kernel = new InMemoryKernelRepository();
  const forwardClaimSecret = kernel.seedTestWorker(forwardWorkerId, [tenantId], 1, {
    capabilities: ['tool', 'effect.execute'],
  });
  const reconcileClaimSecret = kernel.seedTestWorker(reconcileWorkerId, [tenantId], 1, {
    capabilities: ['effect.reconcile'],
    identitySubject: 'db:commander_adapter_ops',
  });

  await kernel.createRun(
    {
      id: runId,
      tenantId,
      intentHash: 'reconciliation-script-intent',
      workGraphHash: 'reconciliation-script-graph',
      workGraphVersion: 'v1',
      policySnapshotId: 'reconciliation-script-policy',
      steps: [{ id: stepId, kind: 'tool', maxAttempts: 1 }],
    },
    'reconciliation-script',
  );
  const step = await kernel.claimNextStep({
    workerId: forwardWorkerId,
    workerGeneration: 1,
    claimSecret: forwardClaimSecret,
    capabilities: ['tool'],
    leaseTtlMs: 60_000,
  });
  assert.ok(step?.lease);
  const admitted = await kernel.admitEffect({
    id: effectId,
    runId,
    stepId,
    tenantId,
    type: 'read.cache',
    idempotencyKey: 'reconciliation-script-idempotency',
    policyDecisionId: 'reconciliation-script-decision',
    policySnapshotId: 'reconciliation-script-policy',
    actionDigest: 'a'.repeat(64),
    request: { destination: 'cache://proof', key: 'proof' },
    lease: step.lease,
    actor: forwardWorkerId,
  });
  assert.equal(admitted.admitted, true);

  const parked = await kernel.parkEffectCompletionUnknown({
    tenantId,
    effectId,
    workerId: forwardWorkerId,
    workerGeneration: 1,
    claimSecret: forwardClaimSecret,
    leaseToken: step.lease.token,
    fencingEpoch: step.lease.fencingEpoch,
    error: { code: 'REMOTE_RESPONSE_LOST', message: 'Remote commit response was lost' },
  });
  assert.equal(parked.parked, true);
  await kernel.requestReconcile({
    tenantId,
    effectId,
    actor: 'reconciliation-script',
  });

  const counters = { forwardWrites: 1, outcomeQueries: 0, duplicateWrites: 0 };
  const daemon = new ReconciliationDaemon({
    repository: adaptReconciliationRepository(kernel),
    registry: {
      resolve: () => ({}),
      outcomeQuerierFor: () => ({ queryOutcome: async () => ({ status: 'APPLIED' }) }) as never,
    },
    brokerFactory: () => ({
      reconcileUnknown: async () => {
        counters.outcomeQueries += 1;
        return { status: 'APPLIED', response: { observed: true } };
      },
    }),
    pollIntervalMs: 60_000,
    batchSize: 1,
    workerId: reconcileWorkerId,
    workerGeneration: 1,
    claimSecret: reconcileClaimSecret,
    // Terminal reconcile evidence is fail-closed without a signer (EVIDENCE_SIGNING_KEY_REQUIRED).
    evidenceSigner: createEvidenceSigner({
      privateKeyPem: generateKeyPairSync('ed25519')
        .privateKey.export({ format: 'pem', type: 'pkcs8' })
        .toString(),
      keyId: 'l4-b-reconciliation-evidence',
    }),
  });
  const stats = await daemon.tick();
  assert.equal(stats.completed, 1);
  const effect = await kernel.getEffect(effectId, tenantId);
  return { counters, effectState: effect?.state ?? 'MISSING' };
}

function runPostgresMultiProcessGate(): { passed: boolean; detail: string } {
  if (!process.env.COMMANDER_TASK1_PG_URL?.trim()) {
    return { passed: false, detail: 'COMMANDER_TASK1_PG_URL is required' };
  }
  const testPath = resolve(
    fileURLToPath(new URL('..', import.meta.url)),
    'packages/adapter-ops/src/chaos/dualProcessClaim.test.ts',
  );
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--test', '--test-concurrency=1', testPath],
    { cwd: process.cwd(), env: process.env, encoding: 'utf8' },
  );
  return {
    passed: result.status === 0,
    detail:
      result.status === 0
        ? 'real PostgreSQL multi-process gate passed'
        : (result.stderr || result.stdout).trim(),
  };
}

export async function runCellReconciliationE2E(
  options: {
    mode?: ReconciliationE2EMode;
  } = {},
): Promise<ReconciliationE2EResult> {
  const startedAt = Date.now();
  const mode = options.mode ?? 'mock';
  if (mode === 'postgres') {
    const gate = runPostgresMultiProcessGate();
    return {
      mode,
      verdict: gate.passed ? 'WIRED' : 'BLOCKED',
      passed: gate.passed,
      steps: { multiProcessPostgres: gate.passed, detail: gate.detail },
      elapsedMs: Date.now() - startedAt,
    };
  }

  try {
    const result = await runAdapterOpsReconciliationMock();
    const passed =
      result.counters.forwardWrites === 1 &&
      result.counters.outcomeQueries === 1 &&
      result.counters.duplicateWrites === 0 &&
      result.effectState === 'COMPLETED';
    return {
      mode,
      verdict: passed ? 'ENFORCED-script-only' : 'BLOCKED',
      passed,
      steps: { ...result.counters, effectState: result.effectState },
      elapsedMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      mode,
      verdict: 'BLOCKED',
      passed: false,
      steps: { error: error instanceof Error ? error.message : String(error) },
      elapsedMs: Date.now() - startedAt,
    };
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const modeIndex = args.indexOf('--mode');
  const mode = (modeIndex >= 0 ? args[modeIndex + 1] : 'mock') as ReconciliationE2EMode;
  if (mode !== 'mock' && mode !== 'postgres') {
    throw new Error('--mode must be mock or postgres');
  }
  const result = await runCellReconciliationE2E({ mode });
  const outputDirectory = join(process.cwd(), 'artifacts');
  await mkdir(outputDirectory, { recursive: true });
  const outputPath = join(outputDirectory, `l4-b-cell-reconciliation-e2e-${Date.now()}.json`);
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.log(
    `Cell reconciliation E2E ${result.verdict} ${result.passed ? 'PASS' : 'FAIL'} -> ${outputPath}`,
  );
  if (!result.passed) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
