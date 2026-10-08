/**
 * L3-03a Effect monopoly acceptance — tool / connector fail-closed routing.
 * Spec: spec/l3-03a-effect-tool-monopoly.md §4
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  CapabilityTokenIssuer,
  CapabilityTokenVerifier,
  EffectBroker,
  EffectBrokerError,
  canonicalRequestHash,
  type EffectKernelPort,
} from '@praetor/effect-broker';
import { issueLocalToolCapabilityToken } from './stepWorkloadIdentity.js';
import { createWorkerPolicyEvaluator } from './bootstrap.js';
import { ConnectorStepExecutor } from './connectorStepExecutor.js';
import {
  assertEffectBrokerForProduction,
  isProductionEffectGate,
  mustRouteExternalEffectThroughBroker,
} from './effectGate.js';
import { MapToolEffectCatalog } from './toolEffectCatalog.js';
import { ToolStepExecutor } from './toolStepExecutor.js';
import { runWithStepWorkloadIdentity } from './stepWorkloadIdentity.js';
import { WorkerExecutionError } from './types.js';
import type { ClaimedStep, WorkerRecord } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ac = new AbortController();

function createMockWorker(): WorkerRecord {
  return {
    id: 'worker-1',
    kind: 'agent',
    version: '0.2.0',
    capabilities: ['agent', 'tool', 'connector'],
    maxConcurrency: 10,
    status: 'ACTIVE',
    generation: 1,
    activeSteps: 0,
    identitySubject: 'test-worker',
    tenantIds: ['tenant-a'],
    registeredAt: new Date().toISOString(),
    lastHeartbeatAt: new Date().toISOString(),
  };
}

function createMockStep(overrides?: Partial<ClaimedStep>): ClaimedStep {
  return {
    id: 'step-1',
    runId: 'run-1',
    tenantId: 'tenant-a',
    kind: 'tool',
    version: 1,
    attempt: 1,
    input: { toolName: 'echo', args: { message: 'hello' } },
    lease: {
      workerId: 'worker-1',
      workerGeneration: 1,
      token: 'token-1',
      fencingEpoch: 1,
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    },
    ...overrides,
  };
}

async function withEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: () => T | Promise<T>,
): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    prev[key] = process.env[key];
    const value = overrides[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(overrides)) {
      const value = prev[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function makeTokenPair() {
  const issuer = CapabilityTokenIssuer.generate({
    issuer: 'commander-worker',
    audience: 'commander.effect-broker',
    keyId: 'l3-03a',
  });
  const verifier = new CapabilityTokenVerifier({
    issuer: 'commander-worker',
    audience: 'commander.effect-broker',
    publicKeys: { 'l3-03a': issuer.publicKey },
  });
  return { issuer, verifier };
}

function makeBroker(opts: {
  policy?:
    | ReturnType<typeof createWorkerPolicyEvaluator>
    | { evaluate: (...args: never[]) => Promise<unknown> };
  kernel?: Partial<EffectKernelPort>;
  executor?: {
    execute: (input: {
      type: string;
      request: Record<string, unknown>;
    }) => Promise<Record<string, unknown>>;
  };
}) {
  const { issuer, verifier } = makeTokenPair();
  const kernel: EffectKernelPort = {
    admitEffect: async (input) => ({ admitted: true, effect: { id: input.id, state: 'ADMITTED' } }),
    completeEffect: async (_id, _tenant, _lease, response) => ({ ok: true, response }),
    isActionAllowed: async () => true,
    ...opts.kernel,
  };
  const broker = new EffectBroker(
    verifier,
    (opts.policy ?? {
      evaluate: async () => ({
        effect: 'allow' as const,
        decisionId: 'test-allow',
        reason: 'ok',
        policySnapshotId: 'p1',
      }),
    }) as never,
    kernel,
    opts.executor ?? { execute: async () => ({ ok: true }) },
    { append: async () => undefined },
    { audience: 'commander.effect-broker', requireRequestBinding: true },
  );
  return { broker, issuer };
}

describe('effectGate helpers (L3-03a)', () => {
  it('isProductionEffectGate respects NODE_ENV / enterprise / require flag', async () => {
    await withEnv(
      {
        NODE_ENV: 'production',
        COMMANDER_PROFILE: undefined,
        COMMANDER_REQUIRE_EFFECT_BROKER: undefined,
      },
      () => {
        assert.equal(isProductionEffectGate(), true);
      },
    );
    await withEnv(
      {
        NODE_ENV: 'test',
        COMMANDER_PROFILE: 'enterprise',
        COMMANDER_REQUIRE_EFFECT_BROKER: undefined,
      },
      () => {
        assert.equal(isProductionEffectGate(), true);
      },
    );
    await withEnv(
      { NODE_ENV: 'test', COMMANDER_PROFILE: undefined, COMMANDER_REQUIRE_EFFECT_BROKER: '1' },
      () => {
        assert.equal(isProductionEffectGate(), true);
      },
    );
    await withEnv(
      {
        NODE_ENV: 'test',
        COMMANDER_PROFILE: undefined,
        COMMANDER_REQUIRE_EFFECT_BROKER: undefined,
      },
      () => {
        assert.equal(isProductionEffectGate(), false);
      },
    );
  });

  it('mustRouteExternalEffectThroughBroker: explicit external, prod default, catalog localOnly', async () => {
    assert.equal(mustRouteExternalEffectThroughBroker({ hasExternalEffects: true }), true);
    const catalog = new MapToolEffectCatalog(new Set(['echo']), new Set(['memory']));
    await withEnv({ NODE_ENV: 'production' }, () => {
      assert.equal(mustRouteExternalEffectThroughBroker({}), true);
      assert.equal(mustRouteExternalEffectThroughBroker({ localOnly: true }), true);
      assert.equal(
        mustRouteExternalEffectThroughBroker({ localOnly: true }, { toolName: 'echo', catalog }),
        false,
      );
    });
    await withEnv(
      {
        NODE_ENV: 'test',
        COMMANDER_PROFILE: undefined,
        COMMANDER_REQUIRE_EFFECT_BROKER: undefined,
      },
      () => {
        assert.equal(mustRouteExternalEffectThroughBroker({}), false);
        assert.equal(mustRouteExternalEffectThroughBroker({ localOnly: true }), false);
      },
    );
  });
});

describe('L3-03a ToolStepExecutor production monopoly', () => {
  it('1. Prod construction without broker throws EFFECT_BROKER_UNAVAILABLE', async () => {
    await withEnv({ NODE_ENV: 'production' }, () => {
      assert.throws(
        () => new ToolStepExecutor({ get: () => null }),
        (err: unknown) => err instanceof Error && /EFFECT_BROKER_UNAVAILABLE/.test(err.message),
      );
      assert.throws(
        () => assertEffectBrokerForProduction('tool step executor', undefined),
        /EFFECT_BROKER_UNAVAILABLE/,
      );
    });
  });

  it('2. COMMANDER_REQUIRE_EFFECT_BROKER=1 omits hasExternalEffects → still routes via broker; handler never called', async () => {
    let handlerInvoked = false;
    let brokerInvoked = false;
    const stubBroker = {
      execute: async () => {
        brokerInvoked = true;
        return { effectId: 'e1', replayed: false, response: { via: 'broker' } };
      },
    };
    await withEnv({ NODE_ENV: 'test', COMMANDER_REQUIRE_EFFECT_BROKER: '1' }, async () => {
      const { issuer } = makeTokenPair();
      const executor = new ToolStepExecutor(
        {
          get: () => ({
            execute: async () => {
              handlerInvoked = true;
              return {};
            },
          }),
        },
        stubBroker,
        issuer,
      );
      const step = createMockStep({
        input: {
          toolName: 'http.post',
          args: { url: 'https://example.test' },
          effectId: 'effect-1',
          idempotencyKey: 'idem-1',
          capabilityToken: 'tok',
        },
      });
      const worker = createMockWorker();
      const result = await runWithStepWorkloadIdentity(step, worker, () =>
        executor.execute(step, {
          signal: ac.signal,
          worker,
        }),
      );
      assert.equal(handlerInvoked, false);
      assert.equal(brokerInvoked, true);
      assert.deepEqual((result as { result: unknown }).result, { via: 'broker' });
    });
  });

  it('3. require-broker flag + catalog-authorized localOnly echo may use registry without broker fields', async () => {
    await withEnv({ NODE_ENV: 'test', COMMANDER_REQUIRE_EFFECT_BROKER: '1' }, async () => {
      const catalog = new MapToolEffectCatalog(new Set(['echo']), new Set());
      const stubBroker = {
        execute: async () => {
          throw new Error('broker must not run for localOnly');
        },
      };
      const executor = new ToolStepExecutor(
        {
          get: (name) =>
            name === 'echo' ? { execute: async (args) => ({ echo: args.message }) } : null,
        },
        stubBroker,
        undefined,
        catalog,
      );
      const step = createMockStep({
        input: {
          toolName: 'echo',
          args: { message: 'hi' },
          localOnly: true,
          capabilityToken: issueLocalToolCapabilityToken({ toolName: 'echo', aud: 'tenant-a' }),
        },
      });
      const result = await executor.execute(step, {
        signal: ac.signal,
        worker: createMockWorker(),
      });
      assert.deepEqual((result as { result: unknown }).result, { echo: 'hi' });
    });
  });

  it('4. bootstrap deny-default → crm.write → POLICY_DENIED via ToolStepExecutor', async () => {
    const policy = createWorkerPolicyEvaluator({});
    const request = { account: 'acme' };
    const decision = await policy.evaluate({
      tenantId: 'tenant-a',
      runId: 'run-1',
      stepId: 'step-1',
      type: 'crm.write',
      request,
      token: {} as never,
    });
    assert.equal(decision.effect, 'deny');
    assert.equal(decision.decisionId, 'deny-default');

    const { broker, issuer } = makeBroker({
      policy,
      kernel: { isActionAllowed: async () => true },
    });
    const token = issuer.issue({
      jti: 'jti-crm',
      tenantId: 'tenant-a',
      runId: 'run-1',
      stepId: 'step-1',
      workerId: 'worker-1',
      workerGeneration: 1,
      effectTypes: ['crm.write'],
      expiresAt: '2099-01-01T00:00:00.000Z',
      policySnapshotId: decision.policySnapshotId,
      requestHash: canonicalRequestHash(request),
    });

    const executor = new ToolStepExecutor({ get: () => null }, broker);
    const step = createMockStep({
      input: {
        toolName: 'crm.write',
        args: request,
        hasExternalEffects: true,
        effectId: 'eff-crm',
        idempotencyKey: 'idem-crm',
        capabilityToken: token,
      },
    });
    await assert.rejects(
      () => executor.execute(step, { signal: ac.signal, worker: createMockWorker() }),
      (err: unknown) =>
        err instanceof WorkerExecutionError &&
        err.options.code === 'POLICY_DENIED' &&
        err.message === 'POLICY_DENIED',
    );
  });

  it('5. Allowlist ENFORCED: isActionAllowed false → ACTION_NOT_ALLOWLISTED', async () => {
    const { broker, issuer } = makeBroker({
      policy: {
        evaluate: async () => ({
          effect: 'allow' as const,
          decisionId: 'allow-test',
          reason: 'ok',
          policySnapshotId: 'p1',
        }),
      },
      kernel: { isActionAllowed: async () => false },
      executor: {
        execute: async () => {
          throw new Error('must not execute');
        },
      },
    });
    const request = { url: 'https://example.test' };
    const token = issuer.issue({
      jti: 'jti-http',
      tenantId: 'tenant-a',
      runId: 'run-1',
      stepId: 'step-1',
      workerId: 'worker-1',
      workerGeneration: 1,
      effectTypes: ['http.post'],
      expiresAt: '2099-01-01T00:00:00.000Z',
      policySnapshotId: 'p1',
      requestHash: canonicalRequestHash(request),
    });
    const executor = new ToolStepExecutor({ get: () => null }, broker);
    const step = createMockStep({
      input: {
        toolName: 'http.post',
        args: request,
        hasExternalEffects: true,
        effectId: 'eff-http',
        idempotencyKey: 'idem-http',
        capabilityToken: token,
      },
    });
    await assert.rejects(
      () => executor.execute(step, { signal: ac.signal, worker: createMockWorker() }),
      (err: unknown) =>
        err instanceof WorkerExecutionError && err.message === 'ACTION_NOT_ALLOWLISTED',
    );
    // Direct broker path: grant fence must match the lease used at admit.
    const directToken = issuer.issue({
      jti: 'jti-http-direct',
      tenantId: 'tenant-a',
      runId: 'run-1',
      stepId: 'step-1',
      workerId: 'w',
      workerGeneration: 1,
      effectTypes: ['http.post'],
      expiresAt: '2099-01-01T00:00:00.000Z',
      policySnapshotId: 'p1',
      requestHash: canonicalRequestHash(request),
    });
    await assert.rejects(
      () =>
        broker.execute({
          effectId: 'eff-direct',
          token: directToken,
          type: 'http.post',
          request,
          idempotencyKey: 'idem-direct',
          lease: { workerId: 'w', workerGeneration: 1, token: 'l', fencingEpoch: 1 },
          actor: 'w',
        }),
      (err: unknown) => err instanceof EffectBrokerError && err.code === 'ACTION_NOT_ALLOWLISTED',
    );
  });

  it('6. COMMANDER_WORKER_EFFECT_POLICY=permit still denies non-llm tools', async () => {
    const policy = createWorkerPolicyEvaluator({
      COMMANDER_WORKER_EFFECT_POLICY: 'permit',
    } as NodeJS.ProcessEnv);
    const tool = await policy.evaluate({
      tenantId: 't1',
      runId: 'r1',
      stepId: 's1',
      type: 'crm.write',
      request: {},
      token: {} as never,
    });
    assert.equal(tool.effect, 'deny');
    assert.notEqual(tool.decisionId, 'permit-default');

    const llm = await policy.evaluate({
      tenantId: 't1',
      runId: 'r1',
      stepId: 's1',
      type: 'llm.openai',
      request: {},
      token: {} as never,
    });
    assert.equal(llm.effect, 'allow');
  });
});

describe('L3-03a ConnectorStepExecutor production monopoly', () => {
  it('7a. Prod construction without broker throws', async () => {
    await withEnv({ NODE_ENV: 'production' }, () => {
      assert.throws(() => new ConnectorStepExecutor(), /EFFECT_BROKER_UNAVAILABLE/);
    });
  });

  it('7b. COMMANDER_REQUIRE_EFFECT_BROKER=1 omits hasExternalEffects → broker path; registry unused', async () => {
    let registryHit = false;
    let brokerHit = false;
    const stubBroker = {
      execute: async (input: { type: string }) => {
        brokerHit = true;
        assert.equal(input.type, 'postgres.query');
        return { effectId: 'c1', replayed: false, response: { rows: [] } };
      },
    };
    await withEnv({ NODE_ENV: 'test', COMMANDER_REQUIRE_EFFECT_BROKER: '1' }, async () => {
      const { issuer } = makeTokenPair();
      const executor = new ConnectorStepExecutor(
        {
          get: () => {
            registryHit = true;
            return {
              initialize: async () => undefined,
              execute: async () => ({}),
              close: async () => undefined,
            };
          },
          register: () => undefined,
        },
        stubBroker,
        issuer,
      );
      const step = createMockStep({
        kind: 'connector',
        input: {
          connectorName: 'postgres',
          operation: 'query',
          args: { sql: 'select 1' },
          effectId: 'eff-c',
          idempotencyKey: 'idem-c',
          capabilityToken: 'tok',
        },
      });
      const worker = createMockWorker();
      const result = await runWithStepWorkloadIdentity(step, worker, () =>
        executor.execute(step, {
          signal: ac.signal,
          worker,
        }),
      );
      assert.equal(registryHit, false);
      assert.equal(brokerHit, true);
      assert.deepEqual((result as { result: unknown }).result, { rows: [] });
    });
  });

  it('7c. require-broker flag + catalog-authorized localOnly connector may use registry', async () => {
    await withEnv({ NODE_ENV: 'test', COMMANDER_REQUIRE_EFFECT_BROKER: '1' }, async () => {
      const catalog = new MapToolEffectCatalog(new Set(), new Set(['memory']));
      const executor = new ConnectorStepExecutor(
        {
          get: (name) =>
            name === 'memory'
              ? {
                  initialize: async () => undefined,
                  execute: async (op, args) => ({ op, args }),
                  close: async () => undefined,
                }
              : null,
          register: () => undefined,
        },
        {
          execute: async () => {
            throw new Error('broker must not run');
          },
        },
        undefined,
        catalog,
      );
      const step = createMockStep({
        kind: 'connector',
        input: {
          connectorName: 'memory',
          operation: 'get',
          args: { key: 'k' },
          localOnly: true,
        },
      });
      const result = await executor.execute(step, {
        signal: ac.signal,
        worker: createMockWorker(),
      });
      assert.deepEqual((result as { result: unknown }).result, { op: 'get', args: { key: 'k' } });
    });
  });
});

describe('L3-03a static: executors have no direct external IO', () => {
  it('8. every step executor contains no fetch/execSync/spawn/child_process', () => {
    // Covers every step-execution unit, not just the tool/connector pair: a new
    // executor added to the worker plane must not silently gain direct egress.
    const files = [
      'toolStepExecutor.ts',
      'connectorStepExecutor.ts',
      'evaluatorStepExecutor.ts',
      'actionAdapterExecutor.ts',
      'workerRuntimeAdapter.ts',
      'llmBrokerBridge.ts',
      'ticketAdapter.ts',
      'effectGate.ts',
    ];
    const forbidden = /\b(fetch|execSync|execFile|execFileSync|spawn|spawnSync|child_process)\b/;
    for (const file of files) {
      // Strip comments first: a comment mentioning `spawn` must not fail the
      // guard, and code must not hide behind a commented-out import.
      const src = readFileSync(join(__dirname, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      assert.equal(
        forbidden.test(src),
        false,
        `${file} must not contain direct external IO primitives`,
      );
    }
  });
});
