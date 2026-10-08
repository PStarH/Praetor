import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  __testLlmInvokeRegistrySize,
  __testPlantLlmInvokeEntry,
  createLlmEffectAuth,
  dispatchLlmEffect,
  hashLlmCallContent,
  resetLlmInvokeRegistryForTests,
  runWithLlmEffectAuth,
  wrapProviderWithEffectBroker,
  type LlmEffectAuth,
} from './llmBrokerBridge.js';
import type { LLMProvider, LLMRequest, LLMResponse } from '@praetor/core';
import { resetControlPlane } from '@praetor/core';
import {
  CapabilityTokenIssuer,
  CapabilityTokenVerifier,
  EffectBroker,
  EffectBrokerError,
  canonicalRequestHash,
  deriveEffectIdempotencyKey,
  type EffectExecutor,
  type EffectKernelPort,
  type PolicyEvaluator,
  type AuditSink,
} from '@praetor/effect-broker';
import type { ClaimedStep } from './types.js';
import { runWithStepWorkloadIdentity } from './stepWorkloadIdentity.js';

const DEFAULT_WORKER_ID = 'w1';

/**
 * Run `fn` inside the step-workload ALS. The bridge no longer fabricates a
 * binding from the caller-supplied auth, so every LLM effect test must
 * establish the verified step identity the way production does.
 */
function withStepBinding<T>(
  identity: {
    tenantId?: string;
    runId?: string;
    stepId?: string;
    workerId?: string;
    workerGeneration?: number;
  },
  fn: () => T,
): T {
  const tenantId = identity.tenantId ?? 't1';
  const runId = identity.runId ?? 'r1';
  const stepId = identity.stepId ?? 's1';
  const workerId = identity.workerId ?? DEFAULT_WORKER_ID;
  const workerGeneration = identity.workerGeneration ?? 1;
  const step: ClaimedStep = {
    id: stepId,
    runId,
    tenantId,
    kind: 'agent',
    version: 1,
    attempt: 1,
    input: {},
    lease: {
      workerId,
      workerGeneration,
      token: 'lease',
      fencingEpoch: 1,
      expiresAt: '2099-01-01T00:00:00.000Z',
    },
  };
  const worker: Parameters<typeof runWithStepWorkloadIdentity>[1] = {
    id: workerId,
    kind: 'agent',
    version: 'v1',
    capabilities: ['agent'],
    maxConcurrency: 2,
    status: 'ACTIVE',
    generation: workerGeneration,
    activeSteps: 0,
    identitySubject: `spiffe://commander/worker/${workerId}`,
    tenantIds: [tenantId],
    registeredAt: '2099-01-01T00:00:00.000Z',
    lastHeartbeatAt: '2099-01-01T00:00:00.000Z',
  };
  return runWithStepWorkloadIdentity(step, worker, fn);
}

function mockProvider(name = 'mock'): LLMProvider {
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

function makeBroker(options?: { localWorkerId?: string; executor?: EffectExecutor }): {
  broker: EffectBroker;
  issuer: CapabilityTokenIssuer;
} {
  const localWorkerId = options?.localWorkerId ?? DEFAULT_WORKER_ID;
  const issuer = CapabilityTokenIssuer.generate({
    issuer: 'commander-worker',
    audience: 'commander.effect-broker',
    keyId: 'test-llm',
  });
  const tokens = new CapabilityTokenVerifier({
    issuer: 'commander-worker',
    audience: 'commander.effect-broker',
    publicKeys: { 'test-llm': issuer.publicKey },
  });
  const policy: PolicyEvaluator = {
    evaluate: async () => ({
      effect: 'allow',
      decisionId: 'llm-test-allow',
      reason: 'test',
      policySnapshotId: 'p1',
    }),
  };
  const kernel: EffectKernelPort = {
    admitEffect: async (input) => ({
      admitted: true,
      effect: { id: input.id, state: 'admitted' },
    }),
    completeEffect: async (_id, _tenant, _lease, response) => ({ ok: true, response }),
  };
  const executor: EffectExecutor = options?.executor ?? {
    execute: async (input) => dispatchFromExecutionContext(input),
  };
  const audit: AuditSink = { append: async () => undefined };
  const broker = new EffectBroker(tokens, policy, kernel, executor, audit, {
    audience: 'commander.effect-broker',
    requireRequestBinding: true,
    localWorkerId,
  });
  return { broker, issuer };
}

describe('llmBrokerBridge (WS2 §1)', () => {
  afterEach(() => {
    resetLlmInvokeRegistryForTests();
  });

  it('mints call-time request-bound tokens and routes through broker', async () => {
    const { broker, issuer } = makeBroker();
    const wrapped = wrapProviderWithEffectBroker(mockProvider('openai'), broker);
    const response = await withStepBinding({ tenantId: 't1', runId: 'r1', stepId: 's1' }, () => {
      const auth = createLlmEffectAuth({
        actor: 'worker-1',
        lease: {
          workerId: DEFAULT_WORKER_ID,
          workerGeneration: 1,
          token: 'lease',
          fencingEpoch: 1,
        },
        issuer,
      });
      return runWithLlmEffectAuth(auth, () =>
        wrapped.call({
          model: 'gpt',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      );
    });
    assert.match(String(response.content), /hi/);
    assert.equal(__testLlmInvokeRegistrySize(), 0);
  });

  it('fail-closes when LLM auth context is missing', async () => {
    const { broker } = makeBroker();
    const wrapped = wrapProviderWithEffectBroker(mockProvider(), broker);
    await assert.rejects(
      () => wrapped.call({ model: 'gpt', messages: [] }),
      /EFFECT_AUTHORIZATION_REQUIRED/,
    );
  });

  it('does not confuse colon-bearing tenantIds in registry keys', async () => {
    const { broker, issuer } = makeBroker();
    const wrapped = wrapProviderWithEffectBroker(mockProvider('openai'), broker);
    const [r1, r2] = await Promise.all([
      withStepBinding({ tenantId: 'acme:prod', runId: 'r1', stepId: 's1' }, () => {
        const authColon = createLlmEffectAuth({
          actor: 'worker-1',
          lease: {
            workerId: DEFAULT_WORKER_ID,
            workerGeneration: 1,
            token: 'lease',
            fencingEpoch: 1,
          },
          issuer,
        });
        return runWithLlmEffectAuth(authColon, () =>
          wrapped.call({ model: 'gpt', messages: [{ role: 'user', content: 'colon-tenant' }] }),
        );
      }),
      withStepBinding({ tenantId: 'acme', runId: 'r2', stepId: 's2' }, () => {
        const authPlain = createLlmEffectAuth({
          actor: 'worker-1',
          lease: {
            workerId: DEFAULT_WORKER_ID,
            workerGeneration: 1,
            token: 'lease',
            fencingEpoch: 1,
          },
          issuer,
        });
        return runWithLlmEffectAuth(authPlain, () =>
          wrapped.call({ model: 'gpt', messages: [{ role: 'user', content: 'plain-tenant' }] }),
        );
      }),
    ]);
    assert.match(String(r1.content), /colon-tenant/);
    assert.match(String(r2.content), /plain-tenant/);
    assert.equal(__testLlmInvokeRegistrySize(), 0);
  });

  it('rejects tenant B dispatch for tenant A registry entry (LLM_TENANT_MISMATCH)', async () => {
    const { broker, issuer } = makeBroker({
      executor: {
        execute: async (input) =>
          dispatchLlmEffect({
            type: input.type,
            request: input.request,
            signal: input.signal,
            tenantId: 'tenant-b',
            workerId: input.executionContext!.workerId,
            fencingEpoch: input.executionContext!.fencingEpoch,
            leaseToken: input.executionContext!.leaseToken,
          }),
      },
    });
    const wrapped = wrapProviderWithEffectBroker(mockProvider('openai'), broker);
    await withStepBinding({ tenantId: 'tenant-a', runId: 'r1', stepId: 's1' }, async () => {
      const auth = createLlmEffectAuth({
        actor: 'worker-1',
        lease: {
          workerId: DEFAULT_WORKER_ID,
          workerGeneration: 1,
          token: 'lease',
          fencingEpoch: 1,
        },
        issuer,
      });
      await assert.rejects(
        () =>
          runWithLlmEffectAuth(auth, () =>
            wrapped.call({ model: 'gpt', messages: [{ role: 'user', content: 'x' }] }),
          ),
        /LLM_TENANT_MISMATCH/,
      );
    });
    assert.equal(__testLlmInvokeRegistrySize(), 0);
  });

  it('rejects dispatch when workerId does not match registry entry', async () => {
    const { broker, issuer } = makeBroker({
      executor: {
        execute: async (input) =>
          dispatchLlmEffect({
            type: input.type,
            request: input.request,
            signal: input.signal,
            tenantId: input.executionContext!.tenantId,
            workerId: 'wrong-worker',
            fencingEpoch: input.executionContext!.fencingEpoch,
            leaseToken: input.executionContext!.leaseToken,
          }),
      },
    });
    const wrapped = wrapProviderWithEffectBroker(mockProvider('openai'), broker);
    await withStepBinding({ tenantId: 't1', runId: 'r1', stepId: 's1' }, async () => {
      const auth = createLlmEffectAuth({
        actor: 'worker-1',
        lease: {
          workerId: DEFAULT_WORKER_ID,
          workerGeneration: 1,
          token: 'lease',
          fencingEpoch: 1,
        },
        issuer,
      });
      await assert.rejects(
        () =>
          runWithLlmEffectAuth(auth, () =>
            wrapped.call({ model: 'gpt', messages: [{ role: 'user', content: 'x' }] }),
          ),
        /LLM_WORKER_MISMATCH/,
      );
    });
    assert.equal(__testLlmInvokeRegistrySize(), 0);
  });

  it('one-shot second dispatch yields LLM_INVOKE_MISS', async () => {
    let capturedEffectId: string | undefined;
    let capturedHash: string | undefined;
    const { broker, issuer } = makeBroker({
      executor: {
        execute: async (input) => {
          capturedEffectId = input.request.effectId as string;
          capturedHash = input.request.contentHash as string;
          return dispatchFromExecutionContext(input);
        },
      },
    });
    const wrapped = wrapProviderWithEffectBroker(mockProvider('openai'), broker);
    await withStepBinding({ tenantId: 't1', runId: 'r1', stepId: 's1' }, async () => {
      const auth = createLlmEffectAuth({
        actor: 'worker-1',
        lease: {
          workerId: DEFAULT_WORKER_ID,
          workerGeneration: 1,
          token: 'lease',
          fencingEpoch: 1,
        },
        issuer,
      });
      await runWithLlmEffectAuth(auth, () =>
        wrapped.call({ model: 'gpt', messages: [{ role: 'user', content: 'once' }] }),
      );
    });
    assert.ok(capturedEffectId);
    assert.ok(capturedHash);
    await assert.rejects(
      () =>
        dispatchLlmEffect({
          type: 'llm.openai',
          request: { effectId: capturedEffectId!, contentHash: capturedHash! },
          tenantId: 't1',
          workerId: DEFAULT_WORKER_ID,
          fencingEpoch: 1,
          leaseToken: 'lease',
        }),
      /LLM_INVOKE_MISS/,
    );
  });

  it('fail-closes wrap construction when COMMANDER_LLM_INVOKE_MODE=disabled', () => {
    const prev = process.env.COMMANDER_LLM_INVOKE_MODE;
    process.env.COMMANDER_LLM_INVOKE_MODE = 'disabled';
    try {
      const { broker } = makeBroker();
      assert.throws(
        () => wrapProviderWithEffectBroker(mockProvider(), broker),
        /LLM_INVOKE_MODE_DISABLED/,
      );
    } finally {
      if (prev === undefined) delete process.env.COMMANDER_LLM_INVOKE_MODE;
      else process.env.COMMANDER_LLM_INVOKE_MODE = prev;
    }
  });

  it('fail-closes wrap for sealed or unknown COMMANDER_LLM_INVOKE_MODE (C-γ not shipped)', () => {
    const prev = process.env.COMMANDER_LLM_INVOKE_MODE;
    try {
      const { broker } = makeBroker();
      for (const mode of ['sealed', 'bogus']) {
        process.env.COMMANDER_LLM_INVOKE_MODE = mode;
        assert.throws(
          () => wrapProviderWithEffectBroker(mockProvider(), broker),
          /LLM_INVOKE_MODE_DISABLED/,
        );
      }
    } finally {
      if (prev === undefined) delete process.env.COMMANDER_LLM_INVOKE_MODE;
      else process.env.COMMANDER_LLM_INVOKE_MODE = prev;
    }
  });

  it('rejects dispatch when registry entry expiresAt has passed', async () => {
    __testPlantLlmInvokeEntry({
      tenantId: 't1',
      effectId: 'e-expired',
      runId: 'r1',
      stepId: 's1',
      workerId: DEFAULT_WORKER_ID,
      fencingEpoch: 1,
      leaseToken: 'lease',
      contentHash: 'abc',
      expiresAt: Date.now() - 1,
      invoke: async () => {
        throw new Error('should not invoke');
      },
    });
    await assert.rejects(
      () =>
        dispatchLlmEffect({
          type: 'llm.openai',
          request: { effectId: 'e-expired', contentHash: 'abc' },
          tenantId: 't1',
          workerId: DEFAULT_WORKER_ID,
          fencingEpoch: 1,
          leaseToken: 'lease',
        }),
      /LLM_INVOKE_EXPIRED/,
    );
    assert.equal(__testLlmInvokeRegistrySize(), 0);
  });

  it('isolates concurrent multi-tenant broker.execute calls', async () => {
    const { broker, issuer } = makeBroker();
    const wrapped = wrapProviderWithEffectBroker(mockProvider('openai'), broker);
    const results = await Promise.all(
      (['t-a', 't-b', 't-c'] as const).map((tenantId) =>
        withStepBinding({ tenantId, runId: `run-${tenantId}`, stepId: 's1' }, () => {
          const auth = createLlmEffectAuth({
            actor: 'worker-1',
            lease: {
              workerId: DEFAULT_WORKER_ID,
              workerGeneration: 1,
              token: 'lease',
              fencingEpoch: 1,
            },
            issuer,
          });
          return runWithLlmEffectAuth(auth, () =>
            wrapped.call({
              model: 'gpt',
              messages: [{ role: 'user', content: tenantId }],
            }),
          );
        }),
      ),
    );
    assert.equal(results.length, 3);
    for (const [i, tenantId] of (['t-a', 't-b', 't-c'] as const).entries()) {
      assert.match(String(results[i]!.content), new RegExp(tenantId));
    }
    assert.equal(__testLlmInvokeRegistrySize(), 0);
  });

  it('fail-closes LLM mint/admit in production without step workload ALS', async () => {
    const { broker, issuer } = makeBroker();
    const wrapped = wrapProviderWithEffectBroker(mockProvider('openai'), broker);
    const orig = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      assert.throws(
        () =>
          createLlmEffectAuth({
            actor: 'worker-1',
            lease: { workerId: 'w1', workerGeneration: 1, token: 'lease', fencingEpoch: 1 },
            issuer,
          }),
        /WORKLOAD_IDENTITY_REQUIRED/,
      );
      // Auth minted outside ALS must not synthesize binding in production. The
      // literal is deliberately incomplete (no workloadId); the broker must fail
      // closed rather than fabricate one, so it is bridged to the auth type.
      const auth = {
        tenantId: 't1',
        runId: 'r1',
        stepId: 's1',
        actor: 'worker-1',
        lease: { workerId: 'w1' as const, workerGeneration: 1, token: 'lease', fencingEpoch: 1 },
        mintCapabilityToken: () =>
          issuer.issue({
            jti: 'x',
            tenantId: 't1',
            runId: 'r1',
            stepId: 's1',
            workloadId: 'wl_x',
            effectTypes: ['llm.openai'],
            expiresAt: '2099-01-01T00:00:00.000Z',
            requestHash: canonicalRequestHash({}),
          }),
      } as unknown as LlmEffectAuth;
      await assert.rejects(
        () => runWithLlmEffectAuth(auth, () => wrapped.call({ model: 'gpt', messages: [] })),
        /WORKLOAD_IDENTITY_REQUIRED/,
      );
    } finally {
      process.env.NODE_ENV = orig;
    }
  });

  it('rejects when mint binds a different request hash (request binding)', async () => {
    const { broker, issuer } = makeBroker();
    const wrapped = wrapProviderWithEffectBroker(mockProvider('openai'), broker);
    await withStepBinding({ tenantId: 't1', runId: 'r1', stepId: 's1' }, async () => {
      const auth = createLlmEffectAuth({
        actor: 'worker-1',
        lease: {
          workerId: DEFAULT_WORKER_ID,
          workerGeneration: 1,
          token: 'lease',
          fencingEpoch: 1,
        },
        issuer,
      });
      // Sabotage: mint against a different body than the broker receives.
      // Fence fields must still match lease so admit reaches REQUEST_HASH_MISMATCH.
      auth.mintCapabilityToken = () =>
        issuer.issue({
          jti: 'bad',
          tenantId: 't1',
          runId: 'r1',
          stepId: 's1',
          workloadId: auth.workloadId,
          workerId: DEFAULT_WORKER_ID,
          workerGeneration: 1,
          effectTypes: ['llm.openai'],
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          requestHash: canonicalRequestHash({ wrong: true }),
        });
      await assert.rejects(
        () =>
          runWithLlmEffectAuth(auth, () =>
            wrapped.call({ model: 'gpt', messages: [{ role: 'user', content: 'x' }] }),
          ),
        /REQUEST_HASH_MISMATCH/,
      );
    });
  });

  it('contentHash covers prompt text (different messages → different hash)', () => {
    const a = hashLlmCallContent({
      model: 'gpt',
      messages: [{ role: 'user', content: 'alpha' }],
    });
    const b = hashLlmCallContent({
      model: 'gpt',
      messages: [{ role: 'user', content: 'beta' }],
    });
    assert.notEqual(a, b);
    assert.match(a, /^[a-f0-9]{64}$/);
  });

  it('WP07 preserves the legacy hash when new semantic fields are unset', () => {
    const request: LLMRequest = { model: 'gpt', messages: [{ role: 'user', content: 'legacy' }] };
    const legacyHash = canonicalRequestHash({
      model: 'gpt',
      messages: [{ role: 'user', content: 'legacy' }],
      maxTokens: null,
      temperature: null,
      stop: null,
      tools: null,
      responseFormat: null,
      reasoningConfig: null,
      safePrompt: null,
    });
    assert.equal(hashLlmCallContent(request), legacyHash);
    assert.equal(
      hashLlmCallContent({
        ...request,
        cacheConfig: undefined,
        parallelToolCalls: undefined,
      }),
      legacyHash,
    );
  });

  it('WP07 distinguishes unset, false, and true parallelToolCalls', () => {
    const request: LLMRequest = { model: 'gpt', messages: [] };
    const hashes = [
      hashLlmCallContent(request),
      hashLlmCallContent({ ...request, parallelToolCalls: false }),
      hashLlmCallContent({ ...request, parallelToolCalls: true }),
    ];
    assert.equal(new Set(hashes).size, 3);
  });

  const cacheConfig: NonNullable<LLMRequest['cacheConfig']> = {
    cacheSystemPrompt: false,
    cacheTools: false,
    useCacheControl: false,
  };
  for (const change of [
    { cacheSystemPrompt: true },
    { cacheTools: true },
    { useCacheControl: true },
    { cacheHistory: 2 },
    { cacheTtl: '1h' },
    { promptCacheKey: 'cache-key' },
    { geminiCachedContentName: 'cachedContents/test' },
    { isBatch: false },
    { isBatch: true },
    { promptCacheRetention: '24h' },
  ] satisfies Array<Partial<NonNullable<LLMRequest['cacheConfig']>>>) {
    it(`WP07 binds cacheConfig variant ${JSON.stringify(change)}`, () => {
      const request: LLMRequest = { model: 'gpt', messages: [] };
      const hashes = [
        hashLlmCallContent(request),
        hashLlmCallContent({ ...request, cacheConfig }),
        hashLlmCallContent({ ...request, cacheConfig: { ...cacheConfig, ...change } }),
      ];
      assert.equal(new Set(hashes).size, 3);
    });
  }

  it('WP07 canonicalizes cacheConfig property order', () => {
    const request: LLMRequest = { model: 'gpt', messages: [], parallelToolCalls: false };
    assert.equal(
      hashLlmCallContent({ ...request, cacheConfig: { ...cacheConfig, isBatch: true } }),
      hashLlmCallContent({ ...request, cacheConfig: { isBatch: true, ...cacheConfig } }),
    );
  });

  it('WP07 ignores signal identity and abort state in content hashes', () => {
    for (const semantic of [{}, { cacheConfig, parallelToolCalls: false }]) {
      const request: LLMRequest = { model: 'gpt', messages: [], ...semantic };
      const expected = hashLlmCallContent(request);
      const first = new AbortController();
      const second = new AbortController();
      assert.equal(hashLlmCallContent({ ...request, signal: first.signal }), expected);
      assert.equal(hashLlmCallContent({ ...request, signal: second.signal }), expected);
      first.abort(new Error('cancelled'));
      assert.equal(hashLlmCallContent({ ...request, signal: first.signal }), expected);
    }
  });

  it('WP07 gives semantic variants distinct broker effect IDs and idempotency keys', async (t) => {
    const { broker, issuer } = makeBroker();
    const execute = t.mock.method(broker, 'execute');
    const wrapped = wrapProviderWithEffectBroker(mockProvider(), broker);
    const base: LLMRequest = { model: 'gpt', messages: [] };
    const requests: LLMRequest[] = [
      base,
      { ...base, parallelToolCalls: false },
      { ...base, parallelToolCalls: true },
      { ...base, cacheConfig },
      { ...base, cacheConfig: { ...cacheConfig, isBatch: true } },
    ];
    await withStepBinding({ tenantId: 't1', runId: 'r1', stepId: 's1' }, async () => {
      const auth = createLlmEffectAuth({
        actor: 'worker-1',
        lease: {
          workerId: DEFAULT_WORKER_ID,
          workerGeneration: 1,
          token: 'lease',
          fencingEpoch: 1,
        },
        issuer,
      });
      for (const request of requests) {
        await runWithLlmEffectAuth(auth, () => wrapped.call(request));
      }
    });
    const inputs = execute.mock.calls.map((call) => call.arguments[0]);
    assert.equal(new Set(inputs.map((input) => input.effectId)).size, requests.length);
    assert.equal(new Set(inputs.map((input) => input.idempotencyKey)).size, requests.length);
    for (const [index, input] of inputs.entries()) {
      assert.equal(input.effectId, `llm:r1:s1:${hashLlmCallContent(requests[index]!)}`);
      // The key is no longer the raw effectId: it is the broker-derived key,
      // which is what the 'derive' policy recomputes and accepts.
      assert.equal(
        input.idempotencyKey,
        deriveEffectIdempotencyKey({
          tenantId: 't1',
          runId: 'r1',
          stepId: 's1',
          effectId: input.effectId,
          request: input.request,
        }),
      );
      assert.notEqual(input.idempotencyKey, input.effectId);
      assert.equal(input.request.effectId, input.effectId);
    }
    assert.equal(__testLlmInvokeRegistrySize(), 0);
  });

  it('fail-closes admit when lease.workerGeneration mismatches (kernel fencing)', async () => {
    const issuer = CapabilityTokenIssuer.generate({
      issuer: 'commander-worker',
      audience: 'commander.effect-broker',
      keyId: 'fence-test',
    });
    const tokens = new CapabilityTokenVerifier({
      issuer: 'commander-worker',
      audience: 'commander.effect-broker',
      publicKeys: { 'fence-test': issuer.publicKey },
    });
    // Mirror kernel live(): missing generation coerces to -1 and loses against claimed ≥0.
    const claimedGeneration = 2;
    const kernel: EffectKernelPort = {
      admitEffect: async (input) => {
        const supplied = input.lease.workerGeneration ?? -1;
        if (supplied !== claimedGeneration) {
          return { admitted: false, reason: 'LEASE_LOST' };
        }
        return { admitted: true, effect: { id: input.id, state: 'admitted' } };
      },
      completeEffect: async (_id, _tenant, _lease, response) => ({ ok: true, response }),
    };
    const policy: PolicyEvaluator = {
      evaluate: async () => ({
        effect: 'allow',
        decisionId: 'llm-fence-allow',
        reason: 'test',
        policySnapshotId: 'p1',
      }),
    };
    const broker = new EffectBroker(
      tokens,
      policy,
      kernel,
      { execute: async (input) => dispatchFromExecutionContext(input) },
      { append: async () => undefined },
      {
        audience: 'commander.effect-broker',
        requireRequestBinding: true,
        localWorkerId: DEFAULT_WORKER_ID,
      },
    );
    const wrapped = wrapProviderWithEffectBroker(mockProvider('openai'), broker);

    await withStepBinding(
      { tenantId: 't1', runId: 'r1', stepId: 's1', workerGeneration: 1 },
      async () => {
        await assert.rejects(
          () =>
            runWithLlmEffectAuth(
              createLlmEffectAuth({
                actor: 'worker-1',
                // Grant↔lease fence matches; kernel claimed generation differs → LEASE_LOST
                lease: {
                  workerId: DEFAULT_WORKER_ID,
                  workerGeneration: 1,
                  token: 'lease',
                  fencingEpoch: 1,
                },
                issuer,
              }),
              () => wrapped.call({ model: 'gpt', messages: [{ role: 'user', content: 'x' }] }),
            ),
          (err: unknown) => {
            assert.ok(err instanceof Error);
            // Broker surfaces kernel LEASE_LOST as EFFECT_ADMISSION_REJECTED + details.reason
            assert.match(err.message, /EFFECT_ADMISSION_REJECTED/);
            assert.equal((err as { details?: { reason?: string } }).details?.reason, 'LEASE_LOST');
            return true;
          },
        );
      },
    );

    const ok = await withStepBinding(
      { tenantId: 't1', runId: 'r1', stepId: 's1', workerGeneration: claimedGeneration },
      () =>
        runWithLlmEffectAuth(
          createLlmEffectAuth({
            actor: 'worker-1',
            lease: {
              workerId: DEFAULT_WORKER_ID,
              workerGeneration: claimedGeneration,
              token: 'lease',
              fencingEpoch: 1,
            },
            issuer,
          }),
          () => wrapped.call({ model: 'gpt', messages: [{ role: 'user', content: 'ok' }] }),
        ),
    );
    assert.match(String(ok.content), /ok/);
  });

  it('freezes call payload so contentHash and provider invoke stay atomic', async () => {
    const { broker, issuer } = makeBroker();
    let seen: LLMRequest | undefined;
    const provider: LLMProvider = {
      name: 'mock',
      async call(req: LLMRequest) {
        seen = req;
        return {
          content: 'ok',
          model: req.model ?? 'm',
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          finishReason: 'stop',
        };
      },
    };
    const wrapped = wrapProviderWithEffectBroker(provider, broker);
    const mutable: LLMRequest = {
      model: 'gpt',
      messages: [{ role: 'user', content: 'original' }],
    };
    const response = await withStepBinding({ tenantId: 't1', runId: 'r1', stepId: 's1' }, () => {
      const auth = createLlmEffectAuth({
        actor: 'worker-1',
        lease: {
          workerId: DEFAULT_WORKER_ID,
          workerGeneration: 1,
          token: 'lease',
          fencingEpoch: 1,
        },
        issuer,
      });
      return runWithLlmEffectAuth(auth, async () => {
        const pending = wrapped.call(mutable);
        // Mutate after call starts — wrap must not observe the mutated messages.
        mutable.messages = [{ role: 'user', content: 'TAMPERED' }];
        return pending;
      });
    });
    assert.equal(response.content, 'ok');
    assert.equal(seen?.messages?.[0]?.content, 'original');
  });

  it('uses content-stable idempotency keys so identical retries dedupe', async () => {
    const issuer = CapabilityTokenIssuer.generate({
      issuer: 'commander-worker',
      audience: 'commander.effect-broker',
      keyId: 'idem-llm',
    });
    const tokens = new CapabilityTokenVerifier({
      issuer: 'commander-worker',
      audience: 'commander.effect-broker',
      publicKeys: { 'idem-llm': issuer.publicKey },
    });
    const seenKeys: string[] = [];
    const seenRequests: Array<Record<string, unknown>> = [];
    let callCount = 0;
    const kernel: EffectKernelPort = {
      admitEffect: async (input) => {
        seenKeys.push(input.idempotencyKey);
        seenRequests.push(input.request);
        const prior = seenKeys.filter((k) => k === input.idempotencyKey).length > 1;
        if (prior) {
          return {
            admitted: true,
            replayed: true,
            effect: {
              id: input.id,
              state: 'COMPLETED',
              response: {
                content: 'cached',
                model: 'm',
                usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
                finishReason: 'stop',
              },
            },
          };
        }
        return { admitted: true, effect: { id: input.id, state: 'ADMITTED' } };
      },
      completeEffect: async (_id, _tenant, _lease, response) => response,
    };
    const broker = new EffectBroker(
      tokens,
      {
        evaluate: async () => ({
          effect: 'allow',
          decisionId: 'd',
          reason: 'ok',
          policySnapshotId: 'p1',
        }),
      },
      kernel,
      {
        execute: async (input) => {
          callCount += 1;
          return dispatchFromExecutionContext(input);
        },
      },
      { append: async () => undefined },
      {
        audience: 'commander.effect-broker',
        requireRequestBinding: true,
        localWorkerId: DEFAULT_WORKER_ID,
      },
    );
    const wrapped = wrapProviderWithEffectBroker(mockProvider('openai'), broker);
    const req = { model: 'gpt', messages: [{ role: 'user' as const, content: 'same' }] };
    const contentHash = hashLlmCallContent(req);
    const expectedEffectId = `llm:r1:s1:${contentHash}`;

    const { first, second } = await withStepBinding(
      { tenantId: 't1', runId: 'r1', stepId: 's1' },
      async () => {
        const auth = createLlmEffectAuth({
          actor: 'worker-1',
          lease: {
            workerId: DEFAULT_WORKER_ID,
            workerGeneration: 1,
            token: 'lease',
            fencingEpoch: 1,
          },
          issuer,
        });
        const firstCall = await runWithLlmEffectAuth(auth, () => wrapped.call(req));
        const secondCall = await runWithLlmEffectAuth(auth, () => wrapped.call(req));
        return { first: firstCall, second: secondCall };
      },
    );

    const expectedDerivedKey = deriveEffectIdempotencyKey({
      tenantId: 't1',
      runId: 'r1',
      stepId: 's1',
      effectId: expectedEffectId,
      request: seenRequests[0]!,
    });
    assert.equal(seenKeys[0], expectedDerivedKey);
    assert.equal(seenKeys[1], expectedDerivedKey);
    assert.notEqual(seenKeys[0], expectedEffectId);
    assert.equal(callCount, 1, 'second call must be COMPLETED cache hit, not re-invoke provider');
    assert.match(String(first.content), /same/);
    assert.equal(second.content, 'cached');
  });

  it('rejects dispatch when fencingEpoch or leaseToken mismatches registry', async () => {
    const { broker, issuer } = makeBroker({
      executor: {
        execute: async (input) =>
          dispatchLlmEffect({
            type: input.type,
            request: input.request,
            signal: input.signal,
            tenantId: input.executionContext!.tenantId,
            workerId: input.executionContext!.workerId,
            fencingEpoch: 99,
            leaseToken: input.executionContext!.leaseToken,
          }),
      },
    });
    const wrapped = wrapProviderWithEffectBroker(mockProvider('openai'), broker);
    await withStepBinding({ tenantId: 't1', runId: 'r1', stepId: 's1' }, async () => {
      const auth = createLlmEffectAuth({
        actor: 'worker-1',
        lease: {
          workerId: DEFAULT_WORKER_ID,
          workerGeneration: 1,
          token: 'lease',
          fencingEpoch: 1,
        },
        issuer,
      });
      await assert.rejects(
        () =>
          runWithLlmEffectAuth(auth, () =>
            wrapped.call({ model: 'gpt', messages: [{ role: 'user', content: 'x' }] }),
          ),
        /LLM_LEASE_MISMATCH/,
      );
    });
  });

  it('aborts in-flight dispatch when broker signal aborts', async () => {
    const neverResolve = new Promise<LLMResponse>(() => undefined);
    const provider: LLMProvider = {
      name: 'slow',
      call: () => neverResolve,
    };
    const controller = new AbortController();
    const { broker, issuer } = makeBroker({
      executor: {
        execute: async (input) => {
          queueMicrotask(() => controller.abort(new Error('Effect timeout')));
          return dispatchLlmEffect({
            type: input.type,
            request: input.request,
            signal: controller.signal,
            tenantId: input.executionContext!.tenantId,
            workerId: input.executionContext!.workerId,
            fencingEpoch: input.executionContext!.fencingEpoch,
            leaseToken: input.executionContext!.leaseToken,
          });
        },
      },
    });
    const wrapped = wrapProviderWithEffectBroker(provider, broker);
    await withStepBinding({ tenantId: 't1', runId: 'r1', stepId: 's1' }, async () => {
      const auth = createLlmEffectAuth({
        actor: 'worker-1',
        lease: {
          workerId: DEFAULT_WORKER_ID,
          workerGeneration: 1,
          token: 'lease',
          fencingEpoch: 1,
        },
        issuer,
      });
      await assert.rejects(
        () =>
          runWithLlmEffectAuth(auth, () =>
            wrapped.call({ model: 'gpt', messages: [{ role: 'user', content: 'hang' }] }),
          ),
        /Effect timeout/,
      );
    });
    assert.equal(__testLlmInvokeRegistrySize(), 0);
  });

  it('COMPLETION_UNCONFIRMED: no same-effectId replay; new effectId retries', async () => {
    let completeCalls = 0;
    let providerCalls = 0;
    let unknownMarked = 0;
    let firstEffectId: string | undefined;
    const issuer = CapabilityTokenIssuer.generate({
      issuer: 'commander-worker',
      audience: 'commander.effect-broker',
      keyId: 'unknown-retry',
    });
    const tokens = new CapabilityTokenVerifier({
      issuer: 'commander-worker',
      audience: 'commander.effect-broker',
      publicKeys: { 'unknown-retry': issuer.publicKey },
    });
    const kernel: EffectKernelPort = {
      admitEffect: async (input) => ({
        admitted: true,
        effect: { id: input.id, state: 'admitted' },
      }),
      completeEffect: async (_id, _tenant, _lease, response) => {
        completeCalls += 1;
        if (completeCalls === 1) return null;
        return { ok: true, response };
      },
      markEffectCompletionUnknown: async () => {
        unknownMarked += 1;
        return {};
      },
    };
    const broker = new EffectBroker(
      tokens,
      {
        evaluate: async () => ({
          effect: 'allow',
          decisionId: 'llm-unknown-allow',
          reason: 'test',
          policySnapshotId: 'p1',
        }),
      },
      kernel,
      {
        execute: async (input) => {
          if (!firstEffectId) firstEffectId = String(input.request.effectId);
          return dispatchFromExecutionContext(input);
        },
      },
      { append: async () => undefined },
      {
        audience: 'commander.effect-broker',
        requireRequestBinding: true,
        localWorkerId: DEFAULT_WORKER_ID,
      },
    );
    const provider: LLMProvider = {
      name: 'openai',
      async call(req: LLMRequest) {
        providerCalls += 1;
        return {
          content: String(req.messages?.[0]?.content ?? ''),
          model: req.model ?? 'm',
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          finishReason: 'stop',
        };
      },
    };
    const wrapped = wrapProviderWithEffectBroker(provider, broker);
    await withStepBinding({ tenantId: 't1', runId: 'r1', stepId: 's1' }, async () => {
      const auth = createLlmEffectAuth({
        actor: 'worker-1',
        lease: {
          workerId: DEFAULT_WORKER_ID,
          workerGeneration: 1,
          token: 'lease',
          fencingEpoch: 1,
        },
        issuer,
      });

      await assert.rejects(
        () =>
          runWithLlmEffectAuth(auth, () =>
            wrapped.call({ model: 'gpt', messages: [{ role: 'user', content: 'first' }] }),
          ),
        (err: unknown) => err instanceof EffectBrokerError && err.code === 'COMPLETION_UNCONFIRMED',
      );
      assert.equal(providerCalls, 1);
      assert.equal(unknownMarked, 1);
      assert.ok(firstEffectId);

      // Same effectId cannot re-invoke provider (one-shot + wrap finally cleared registry).
      await assert.rejects(
        () =>
          dispatchLlmEffect({
            type: 'llm.openai',
            request: {
              effectId: firstEffectId!,
              contentHash: hashLlmCallContent({
                model: 'gpt',
                messages: [{ role: 'user', content: 'first' }],
              }),
            },
            tenantId: 't1',
            workerId: DEFAULT_WORKER_ID,
            fencingEpoch: 1,
            leaseToken: 'lease',
          }),
        /LLM_INVOKE_MISS/,
      );
      assert.equal(providerCalls, 1);

      // Client retries with different content → new content-stable effectId — allowed.
      const retry = await runWithLlmEffectAuth(auth, () =>
        wrapped.call({ model: 'gpt', messages: [{ role: 'user', content: 'retry' }] }),
      );
      assert.match(String(retry.content), /retry/);
      assert.equal(providerCalls, 2);
      assert.equal(completeCalls, 2);
    });
  });

  it('fail-closes createLlmEffectAuth in production without step identity', () => {
    resetControlPlane();
    const { issuer } = makeBroker();
    const orig = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      assert.throws(
        () =>
          createLlmEffectAuth({
            actor: 'worker-1',
            lease: { workerId: 'w1', workerGeneration: 1, token: 'lease', fencingEpoch: 1 },
            issuer,
          }),
        /WORKLOAD_IDENTITY_REQUIRED/,
      );
    } finally {
      process.env.NODE_ENV = orig;
    }
  });

  it('mints from verified step identity, not caller tenant override', async () => {
    const { broker, issuer } = makeBroker();
    const wrapped = wrapProviderWithEffectBroker(mockProvider('openai'), broker);
    const step: ClaimedStep = {
      id: 'step-1',
      runId: 'run-1',
      tenantId: 'tenant-from-identity',
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
    const worker = {
      id: 'w1',
      kind: 'agent' as const,
      version: 'v1',
      capabilities: ['agent'],
      maxConcurrency: 2,
      status: 'ACTIVE' as const,
      generation: 1,
      activeSteps: 0,
      identitySubject: 'spiffe://commander/worker/w1',
      tenantIds: ['tenant-from-identity'],
      registeredAt: '2099-01-01T00:00:00.000Z',
      lastHeartbeatAt: '2099-01-01T00:00:00.000Z',
    };
    await runWithStepWorkloadIdentity(step, worker, async () => {
      const auth = createLlmEffectAuth({
        actor: 'worker-1',
        lease: { workerId: 'w1', workerGeneration: 1, token: 'lease', fencingEpoch: 1 },
        issuer,
      });
      // Identity is the ALS binding; there is no caller-supplied override path
      // left to attempt (createLlmEffectAuth no longer accepts identity fields).
      assert.equal(auth.tenantId, 'tenant-from-identity');
      assert.equal(auth.runId, 'run-1');
      assert.equal(auth.stepId, 'step-1');
      assert.equal(auth.workloadId, 'w1:1');
      const response = await runWithLlmEffectAuth(auth, () =>
        wrapped.call({
          model: 'gpt',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      );
      assert.match(String(response.content), /hi/);
    });
  });
});
