/**
 * Cross-package idempotency / workload-binding contract for the LLM bridge.
 *
 * D.2 — the key `wrapProviderWithEffectBroker` passes must satisfy the broker's
 *       `'derive'` policy (the derived value, never the raw effect id).
 * D.3 — the bridge must fail closed outside the step-workload ALS instead of
 *       fabricating a workload binding from the caller-supplied auth object.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CapabilityTokenIssuer,
  CapabilityTokenVerifier,
  EffectBroker,
  canonicalRequestHash,
  deriveEffectIdempotencyKey,
  type EffectExecutor,
  type EffectKernelPort,
} from '@praetor/effect-broker';
import type { LLMProvider, LLMRequest, LLMResponse } from '@praetor/core';
import {
  createLlmEffectAuth,
  dispatchLlmEffect,
  runWithLlmEffectAuth,
  wrapProviderWithEffectBroker,
  type LlmEffectAuth,
} from './llmBrokerBridge.js';
import { runWithStepWorkloadIdentity } from './stepWorkloadIdentity.js';
import type { ClaimedStep } from './types.js';

const TENANT_ID = 't1';
const RUN_ID = 'r1';
const STEP_ID = 's1';
const WORKER_ID = 'w1';

function mockProvider(name = 'openai'): LLMProvider {
  return {
    name,
    async call(req: LLMRequest): Promise<LLMResponse> {
      return {
        content: `echo:${JSON.stringify(req.messages?.[0] ?? '')}`,
        model: req.model ?? 'm',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: 'stop',
      };
    },
  };
}

function dispatchFromExecutionContext(input: Parameters<EffectExecutor['execute']>[0]) {
  const ctx = input.executionContext;
  if (
    !ctx?.tenantId ||
    !ctx.workerId ||
    typeof ctx.fencingEpoch !== 'number' ||
    typeof ctx.leaseToken !== 'string'
  ) {
    throw new Error('test executor: missing executionContext lease fields');
  }
  return dispatchLlmEffect({
    type: input.type,
    request: input.request,
    signal: input.signal,
    tenantId: ctx.tenantId,
    workerId: ctx.workerId,
    fencingEpoch: ctx.fencingEpoch,
    leaseToken: ctx.leaseToken,
  });
}

function makeBroker(options: { idempotencyKeyPolicy?: 'derive' | 'caller' } = {}): {
  broker: EffectBroker;
  issuer: CapabilityTokenIssuer;
} {
  const issuer = CapabilityTokenIssuer.generate({
    issuer: 'commander-worker',
    audience: 'commander.effect-broker',
    keyId: 'idem-contract',
  });
  const tokens = new CapabilityTokenVerifier({
    issuer: 'commander-worker',
    audience: 'commander.effect-broker',
    publicKeys: { 'idem-contract': issuer.publicKey },
  });
  const kernel: EffectKernelPort = {
    admitEffect: async (input) => ({
      admitted: true,
      effect: { id: input.id, state: 'ADMITTED' },
    }),
    completeEffect: async (_id, _tenant, _lease, response) => ({ ok: true, response }),
  };
  const executor: EffectExecutor = {
    execute: async (input) => dispatchFromExecutionContext(input),
  };
  const broker = new EffectBroker(
    tokens,
    {
      evaluate: async () => ({
        effect: 'allow',
        decisionId: 'd1',
        reason: 'ok',
        policySnapshotId: 'p1',
      }),
    },
    kernel,
    executor,
    { append: async () => undefined },
    {
      audience: 'commander.effect-broker',
      requireRequestBinding: true,
      localWorkerId: WORKER_ID,
      ...(options.idempotencyKeyPolicy
        ? { idempotencyKeyPolicy: options.idempotencyKeyPolicy }
        : {}),
    },
  );
  return { broker, issuer };
}

function withStepBinding<T>(fn: () => T): T {
  const step: ClaimedStep = {
    id: STEP_ID,
    runId: RUN_ID,
    tenantId: TENANT_ID,
    kind: 'agent',
    version: 1,
    attempt: 1,
    input: {},
    lease: {
      workerId: WORKER_ID,
      workerGeneration: 1,
      token: 'lease',
      fencingEpoch: 1,
      expiresAt: '2099-01-01T00:00:00.000Z',
    },
  };
  const worker: Parameters<typeof runWithStepWorkloadIdentity>[1] = {
    id: WORKER_ID,
    kind: 'agent',
    version: 'v1',
    capabilities: ['agent'],
    maxConcurrency: 2,
    status: 'ACTIVE',
    generation: 1,
    activeSteps: 0,
    identitySubject: `spiffe://commander/worker/${WORKER_ID}`,
    tenantIds: [TENANT_ID],
    registeredAt: '2099-01-01T00:00:00.000Z',
    lastHeartbeatAt: '2099-01-01T00:00:00.000Z',
  };
  return runWithStepWorkloadIdentity(step, worker, fn);
}

describe('D.2 the LLM bridge passes a key the derive policy accepts', () => {
  it('drives a derive-policy broker end-to-end and passes the derived key', async (t) => {
    const { broker, issuer } = makeBroker({ idempotencyKeyPolicy: 'derive' });
    const execute = t.mock.method(broker, 'execute');
    const wrapped = wrapProviderWithEffectBroker(mockProvider('openai'), broker);

    const response = await withStepBinding(() => {
      const auth = createLlmEffectAuth({
        actor: 'worker-1',
        lease: { workerId: WORKER_ID, workerGeneration: 1, token: 'lease', fencingEpoch: 1 },
        issuer,
      });
      return runWithLlmEffectAuth(auth, () =>
        wrapped.call({ model: 'gpt', messages: [{ role: 'user', content: 'derive-me' }] }),
      );
    });

    // The broker admitted and dispatched: a raw effect-id key would have been
    // rejected with IDEMPOTENCY_KEY_MISMATCH instead.
    assert.match(String(response.content), /derive-me/);
    assert.equal(execute.mock.calls.length, 1);
    const input = execute.mock.calls[0]!.arguments[0];
    assert.notEqual(input.idempotencyKey, input.effectId);
    assert.equal(
      input.idempotencyKey,
      deriveEffectIdempotencyKey({
        tenantId: TENANT_ID,
        runId: RUN_ID,
        stepId: STEP_ID,
        effectId: input.effectId,
        request: input.request,
      }),
    );
  });
});

describe('D.3 the LLM bridge never fabricates a workload binding', () => {
  it('fails closed outside the step-workload ALS instead of using caller-supplied auth', async () => {
    const { broker, issuer } = makeBroker();
    const wrapped = wrapProviderWithEffectBroker(mockProvider('openai'), broker);

    // Caller-supplied identity that used to become the admit binding in
    // non-production. It is minted outside any step-workload ALS.
    const forged: LlmEffectAuth = {
      tenantId: TENANT_ID,
      runId: RUN_ID,
      stepId: STEP_ID,
      workloadId: 'wl-forged-by-caller',
      actor: 'worker-1',
      lease: { workerId: WORKER_ID, workerGeneration: 1, token: 'lease', fencingEpoch: 1 },
      mintCapabilityToken: ({ effectType, request }) =>
        issuer.issue({
          jti: 'forged-jti',
          tenantId: TENANT_ID,
          runId: RUN_ID,
          stepId: STEP_ID,
          workloadId: 'wl-forged-by-caller',
          workerId: WORKER_ID,
          workerGeneration: 1,
          effectTypes: [effectType],
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          requestHash: canonicalRequestHash(request),
        }),
    };

    await assert.rejects(
      () => runWithLlmEffectAuth(forged, () => wrapped.call({ model: 'gpt', messages: [] })),
      /WORKLOAD_IDENTITY_REQUIRED/,
    );
  });
});
