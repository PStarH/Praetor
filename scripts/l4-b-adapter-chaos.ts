#!/usr/bin/env tsx
/**
 * L4-B adapter chaos — timeout-after-remote-commit (ENFORCED, not live proof).
 *
 * Uses injectable fake HTTP / mock adapter clients only. Does NOT contact GitHub
 * or ServiceNow. Proves: remote create count stays 1 after timeout + reconcile.
 *
 * Usage:
 *   pnpm tsx scripts/l4-b-adapter-chaos.ts
 *   pnpm --workspace-root exec tsx --test scripts/l4-b-adapter-chaos.test.ts
 */

import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import {
  CapabilityTokenIssuer,
  CapabilityTokenVerifier,
  EffectBroker,
  EffectBrokerError,
  canonicalRequestHash,
  createEvidenceSigner,
} from '@praetor/effect-broker';
import {
  InMemoryKernelRepository,
  seedFreshOperationsDrains,
} from '@praetor/kernel/testing/inMemoryRepository';
import {
  ActionAdapterRegistry,
  createGitHubPullRequestCreateAdapter,
} from '@praetor/action-adapters';
import { createActionAdapterEffectExecutor } from '../packages/worker-plane/src/actionAdapterExecutor.js';
import { ReconciliationDaemon } from '../packages/adapter-ops/src/reconciliationDaemon.js';

export const L4B_CHAOS_MODE = 'enforced-fake-http' as const;

export interface L4BChaosRemoteCounters {
  createCount: number;
  writeCount: number;
}

export interface L4BChaosResult {
  mode: typeof L4B_CHAOS_MODE;
  passed: boolean;
  remoteCreateCount: number;
  effectState: string;
  detail?: string;
  elapsedMs: number;
}

const tenantId = 'l4-b-chaos-tenant';
const destination = 'github://octo/repo/pulls';
const workerId = 'worker-chaos';
const workerGeneration = 1;

function chaosCredentials() {
  return {
    async getGitHubToken() {
      return 'gh-chaos-token';
    },
    async getServiceNowCredentials() {
      throw new Error('not used');
    },
  };
}

export function createChaosMockFetch(counters: L4BChaosRemoteCounters) {
  const pulls: Array<{
    number: number;
    html_url: string;
    state: string;
    body: string;
    head: { ref: string; sha: string; repo: { full_name: string } };
    base: { ref: string; repo: { full_name: string } };
  }> = [];

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method === 'GET' && url === 'https://api.github.com/user') {
      return new Response(JSON.stringify({ login: 'octocat' }), { status: 200 });
    }
    if (method === 'GET' && url.includes('/pulls?')) {
      return new Response(JSON.stringify(pulls), { status: 200 });
    }
    if (method === 'POST' && url.endsWith('/pulls')) {
      counters.createCount += 1;
      counters.writeCount += 1;
      const body = JSON.parse(String(init?.body)) as {
        title: string;
        body: string;
        head: string;
        base: string;
      };
      const created = {
        number: pulls.length + 1,
        html_url: `https://github.com/octo/repo/pull/${pulls.length + 1}`,
        state: 'open',
        title: body.title,
        body: body.body,
        head: { ref: body.head, sha: 'a'.repeat(40), repo: { full_name: 'octo/repo' } },
        base: { ref: body.base, repo: { full_name: 'octo/repo' } },
        merged: false,
        merged_at: null,
        user: { login: 'octocat' },
      };
      pulls.push(created);
      return new Response(JSON.stringify(created), { status: 201 });
    }
    return new Response('unexpected', { status: 500 });
  };
}

export async function runL4BAdapterChaos(): Promise<L4BChaosResult> {
  const started = Date.now();
  const counters: L4BChaosRemoteCounters = { createCount: 0, writeCount: 0 };
  const fetchImpl = createChaosMockFetch(counters);
  const adapter = createGitHubPullRequestCreateAdapter({
    credentials: chaosCredentials(),
    fetch: fetchImpl,
  });
  const registry = new ActionAdapterRegistry([adapter]);
  const executor = createActionAdapterEffectExecutor(registry);
  const kernel = new InMemoryKernelRepository();
  // Kernel admission of Class A effects is fail-closed on operations readiness:
  // without live reconcile/compensate drains it returns OPERATIONS_NOT_READY.
  seedFreshOperationsDrains(kernel, tenantId);
  const claimSecret = kernel.seedTestWorker(workerId, [tenantId], workerGeneration, {
    capabilities: ['tool', 'effect.execute'],
  });
  // Reconcile mutations are fail-closed on worker claim authz (WORKER_FENCED without it),
  // so the daemon needs its own registered adapter-ops reconcile drain identity.
  const reconcileWorkerId = `reconcile:${tenantId}:chaos`;
  const reconcileWorkerGeneration = 1;
  const reconcileClaimSecret = kernel.seedTestWorker(
    reconcileWorkerId,
    [tenantId],
    reconcileWorkerGeneration,
    {
      capabilities: ['effect.reconcile'],
      identitySubject: 'db:commander_adapter_ops',
      registeredAt: new Date(Date.now() - 1_000),
      lastHeartbeatAt: new Date(),
    },
  );

  await kernel.createRun(
    {
      id: 'run-chaos',
      tenantId,
      intentHash: 'intent',
      workGraphHash: 'graph',
      workGraphVersion: 'v1',
      policySnapshotId: 'policy',
      steps: [{ id: 'step-chaos', kind: 'tool' }],
    },
    'chaos',
  );
  const step = await kernel.claimNextStep({
    workerId,
    workerGeneration,
    claimSecret,
    capabilities: ['tool'],
    leaseTtlMs: 60_000,
  });
  assert.ok(step?.lease);
  await kernel.setAllowlistEntry(tenantId, 'connector.github.pull-request.create', true);

  const issuer = CapabilityTokenIssuer.generate({
    issuer: 'commander-worker',
    audience: 'commander.effect-broker',
    keyId: 'chaos',
  });
  const tokens = new CapabilityTokenVerifier({
    issuer: 'commander-worker',
    audience: 'commander.effect-broker',
    publicKeys: { chaos: issuer.publicKey },
  });

  const request = {
    destination,
    idempotencyKey: 'chaos-idem-1',
    args: { title: 'Chaos PR', body: 'chaos', head: 'feature', base: 'main' },
  };

  const broker = new EffectBroker(
    tokens,
    {
      evaluate: async () => ({
        effect: 'allow',
        decisionId: 'chaos-allow',
        policySnapshotId: 'chaos-policy',
        reason: 'ok',
      }),
    },
    kernel,
    executor,
    { append: async () => {} },
    { localWorkerId: workerId, requireRequestBinding: false },
  );

  const effectId = 'eff-chaos-1';
  const token = issuer.issue({
    jti: 'jti-chaos',
    tenantId,
    runId: 'run-chaos',
    stepId: step.id,
    effectTypes: ['connector.github.pull-request.create'],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    requestHash: canonicalRequestHash(request),
    // Class A fixtures must carry actionDigest (Task 2 gate — do not weaken broker).
    actionDigest: 'a'.repeat(64),
    policySnapshotId: 'chaos-policy',
    workerId,
    workerGeneration,
  });

  const originalComplete = kernel.completeEffect.bind(kernel);
  kernel.completeEffect = async () => null;

  try {
    await assert.rejects(
      () =>
        broker.execute({
          effectId,
          token,
          type: 'connector.github.pull-request.create',
          request,
          idempotencyKey: request.idempotencyKey,
          lease: step.lease!,
          actor: workerId,
        }),
      (error: unknown) =>
        error instanceof EffectBrokerError && error.code === 'COMPLETION_UNCONFIRMED',
    );
  } finally {
    kernel.completeEffect = originalComplete;
  }

  assert.equal(counters.createCount, 1, 'remote commit happened once before timeout');

  const unknownEffect = await kernel.getEffect(effectId, tenantId);
  assert.equal(unknownEffect?.state, 'COMPLETION_UNKNOWN');

  await kernel.requestReconcile({
    effectId,
    tenantId,
    actor: 'chaos',
    reconcileAfter: new Date().toISOString(),
  });

  const daemon = new ReconciliationDaemon({
    repository: kernel,
    registry,
    actor: 'reconciliation-daemon',
    pollIntervalMs: 60_000,
    batchSize: 10,
    workerId: reconcileWorkerId,
    workerGeneration: reconcileWorkerGeneration,
    claimSecret: reconcileClaimSecret,
    // Terminal reconcile evidence is fail-closed without a signer (EVIDENCE_SIGNING_KEY_REQUIRED).
    evidenceSigner: createEvidenceSigner({
      privateKeyPem: generateKeyPairSync('ed25519')
        .privateKey.export({ format: 'pem', type: 'pkcs8' })
        .toString(),
      keyId: 'l4-b-chaos-evidence',
    }),
    brokerFactory: (querier) =>
      new EffectBroker(
        tokens,
        {
          evaluate: async () => ({
            effect: 'allow',
            decisionId: 'recon',
            policySnapshotId: 'policy',
            reason: 'ok',
          }),
        },
        kernel,
        {
          execute: async () => {
            throw new Error('no write on reconcile');
          },
        },
        { append: async () => {} },
        { requireRequestBinding: false },
      ),
  });

  const stats = await daemon.tick();
  assert.equal(stats.completed, 1);

  const completed = await kernel.getEffect(effectId, tenantId);
  assert.equal(completed?.state, 'COMPLETED');
  assert.equal(counters.createCount, 1, 'chaos: no second remote create after reconcile');

  return {
    mode: L4B_CHAOS_MODE,
    passed: true,
    remoteCreateCount: counters.createCount,
    effectState: completed?.state ?? 'UNKNOWN',
    elapsedMs: Date.now() - started,
  };
}

async function main(): Promise<void> {
  const result = await runL4BAdapterChaos();
  console.log(
    JSON.stringify(
      {
        ...result,
        honesty: 'ENFORCED (injectable fake HTTP — not live proof)',
      },
      null,
      2,
    ),
  );
  if (!result.passed) {
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
