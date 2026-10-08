/**
 * L3-03b Gateway / localOnly catalog authority acceptance.
 * Spec: spec/l3-03b-gateway-localonly.md §4
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CapabilityTokenIssuer } from '@praetor/effect-broker';
import { issueLocalToolCapabilityToken } from './stepWorkloadIdentity.js';
import { ConnectorStepExecutor } from './connectorStepExecutor.js';
import {
  isCatalogAuthorizedLocalOnly,
  mustRouteExternalEffectThroughBroker,
} from './effectGate.js';
import {
  DENY_ALL_TOOL_EFFECT_CATALOG,
  MapToolEffectCatalog,
  createDefaultWorkerToolEffectCatalog,
} from './toolEffectCatalog.js';
import { ToolStepExecutor } from './toolStepExecutor.js';
import { runWithStepWorkloadIdentity } from './stepWorkloadIdentity.js';
import type { ClaimedStep, StepExecutor, WorkerRecord } from './types.js';

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

function makeCapabilityIssuer(): CapabilityTokenIssuer {
  return CapabilityTokenIssuer.generate({
    issuer: 'commander-worker-test',
    audience: 'commander.effect-broker',
    keyId: 'l3-03b',
  });
}

async function executeWithWorkload(
  executor: StepExecutor,
  step: ClaimedStep,
): Promise<Record<string, unknown> | undefined> {
  const worker = createMockWorker();
  return runWithStepWorkloadIdentity(step, worker, () =>
    executor.execute(step, { signal: ac.signal, worker }),
  );
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

describe('L3-03b catalog authority helpers', () => {
  it('isCatalogAuthorizedLocalOnly: prod requires catalog; dev accepts step claim', async () => {
    const catalog = new MapToolEffectCatalog(new Set(['echo']), new Set(['memory']));
    await withEnv({ NODE_ENV: 'production' }, () => {
      assert.equal(
        isCatalogAuthorizedLocalOnly({ localOnly: true }, { toolName: 'http.post', catalog }),
        false,
      );
      assert.equal(
        isCatalogAuthorizedLocalOnly({ localOnly: true }, { toolName: 'echo', catalog }),
        true,
      );
      assert.equal(
        isCatalogAuthorizedLocalOnly(
          { localOnly: true },
          { toolName: 'echo', catalog: DENY_ALL_TOOL_EFFECT_CATALOG },
        ),
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
        assert.equal(
          isCatalogAuthorizedLocalOnly(
            { localOnly: true },
            { toolName: 'http.post', catalog: DENY_ALL_TOOL_EFFECT_CATALOG },
          ),
          true,
        );
      },
    );
  });

  it('createDefaultWorkerToolEffectCatalog includes echo and memory', () => {
    const catalog = createDefaultWorkerToolEffectCatalog();
    assert.equal(catalog.isLocalOnlyTool('echo'), true);
    assert.equal(catalog.isLocalOnlyTool('http.post'), false);
    assert.equal(catalog.isLocalOnlyConnector('memory'), true);
    assert.equal(catalog.isLocalOnlyConnector('postgres'), false);
  });
});

describe('L3-03b forged localOnly bypass closed (production)', () => {
  it('1. Forged tool localOnly on http.post routes via broker; handler never called', async () => {
    let handlerInvoked = false;
    let brokerInvoked = false;
    const catalog = new MapToolEffectCatalog(new Set(['echo']), new Set());
    const stubBroker = {
      execute: async () => {
        brokerInvoked = true;
        return { effectId: 'e1', replayed: false, response: { via: 'broker' } };
      },
    };
    await withEnv({ NODE_ENV: 'test', COMMANDER_REQUIRE_EFFECT_BROKER: '1' }, async () => {
      const issuer = makeCapabilityIssuer();
      const executor = new ToolStepExecutor(
        {
          get: () => ({
            execute: async () => {
              handlerInvoked = true;
              return { leaked: true };
            },
          }),
        },
        stubBroker,
        issuer,
        catalog,
      );
      const step = createMockStep({
        input: {
          toolName: 'http.post',
          args: { url: 'https://evil.test' },
          localOnly: true,
          effectId: 'effect-1',
          idempotencyKey: 'idem-1',
          capabilityToken: 'tok',
        },
      });
      const result = await executeWithWorkload(executor, step);
      assert.equal(handlerInvoked, false);
      assert.equal(brokerInvoked, true);
      assert.deepEqual((result as { result: unknown }).result, { via: 'broker' });
    });
  });

  it('2. Forged echo localOnly without catalog entry routes via broker', async () => {
    let handlerInvoked = false;
    let brokerInvoked = false;
    const stubBroker = {
      execute: async () => {
        brokerInvoked = true;
        return { effectId: 'e2', replayed: false, response: { blocked: true } };
      },
    };
    await withEnv({ NODE_ENV: 'test', COMMANDER_REQUIRE_EFFECT_BROKER: '1' }, async () => {
      const issuer = makeCapabilityIssuer();
      const executor = new ToolStepExecutor(
        {
          get: (name) =>
            name === 'echo'
              ? {
                  execute: async () => {
                    handlerInvoked = true;
                    return { echo: 'leaked' };
                  },
                }
              : null,
        },
        stubBroker,
        issuer,
        DENY_ALL_TOOL_EFFECT_CATALOG,
      );
      const step = createMockStep({
        input: {
          toolName: 'echo',
          args: { message: 'hi' },
          localOnly: true,
          effectId: 'effect-2',
          idempotencyKey: 'idem-2',
          capabilityToken: 'tok',
        },
      });
      await executeWithWorkload(executor, step);
      assert.equal(handlerInvoked, false);
      assert.equal(brokerInvoked, true);
    });
  });

  it('3. Catalog-authorized echo + localOnly uses registry in production', async () => {
    let brokerInvoked = false;
    const catalog = createDefaultWorkerToolEffectCatalog();
    await withEnv({ NODE_ENV: 'test', COMMANDER_REQUIRE_EFFECT_BROKER: '1' }, async () => {
      const executor = new ToolStepExecutor(
        {
          get: (name) =>
            name === 'echo' ? { execute: async (args) => ({ echo: args.message }) } : null,
        },
        {
          execute: async () => {
            brokerInvoked = true;
            throw new Error('broker must not run');
          },
        },
        undefined,
        catalog,
      );
      const step = createMockStep({
        input: {
          toolName: 'echo',
          args: { message: 'ok' },
          localOnly: true,
          capabilityToken: issueLocalToolCapabilityToken({ toolName: 'echo', aud: 'tenant-a' }),
        },
      });
      const result = await executor.execute(step, {
        signal: ac.signal,
        worker: createMockWorker(),
      });
      assert.equal(brokerInvoked, false);
      assert.deepEqual((result as { result: unknown }).result, { echo: 'ok' });
    });
  });

  it('4. Forged connector localOnly on postgres routes via broker', async () => {
    let registryHit = false;
    let brokerHit = false;
    const catalog = new MapToolEffectCatalog(new Set(), new Set(['memory']));
    await withEnv({ NODE_ENV: 'test', COMMANDER_REQUIRE_EFFECT_BROKER: '1' }, async () => {
      const executor = new ConnectorStepExecutor(
        {
          get: () => {
            registryHit = true;
            return {
              initialize: async () => undefined,
              execute: async () => ({ leaked: true }),
              close: async () => undefined,
            };
          },
          register: () => undefined,
        },
        {
          execute: async () => {
            brokerHit = true;
            return { effectId: 'c1', replayed: false, response: { via: 'broker' } };
          },
        },
        makeCapabilityIssuer(),
        catalog,
      );
      const step = createMockStep({
        kind: 'connector',
        input: {
          connectorName: 'postgres',
          operation: 'query',
          args: { sql: 'select 1' },
          localOnly: true,
          effectId: 'eff-c',
          idempotencyKey: 'idem-c',
          capabilityToken: 'tok',
        },
      });
      await executeWithWorkload(executor, step);
      assert.equal(registryHit, false);
      assert.equal(brokerHit, true);
    });
  });

  it('5. Prod localOnly connector with connection forces broker even when catalog allows', async () => {
    let registryHit = false;
    let brokerHit = false;
    const catalog = createDefaultWorkerToolEffectCatalog();
    await withEnv({ NODE_ENV: 'test', COMMANDER_REQUIRE_EFFECT_BROKER: '1' }, async () => {
      const executor = new ConnectorStepExecutor(
        {
          get: (name) => {
            if (name !== 'memory') return null;
            return {
              initialize: async () => {
                registryHit = true;
              },
              execute: async () => ({ leaked: true }),
              close: async () => undefined,
            };
          },
          register: () => undefined,
        },
        {
          execute: async () => {
            brokerHit = true;
            return { effectId: 'c2', replayed: false, response: { gated: true } };
          },
        },
        makeCapabilityIssuer(),
        catalog,
      );
      const step = createMockStep({
        kind: 'connector',
        input: {
          connectorName: 'memory',
          operation: 'get',
          args: { key: 'k' },
          localOnly: true,
          connection: { uri: 'memory://local' },
          effectId: 'eff-m',
          idempotencyKey: 'idem-m',
          capabilityToken: 'tok',
        },
      });
      await executeWithWorkload(executor, step);
      assert.equal(registryHit, false);
      assert.equal(brokerHit, true);
    });
  });

  it('6. mustRouteExternalEffectThroughBroker rejects prod connection + localOnly bypass', async () => {
    const catalog = createDefaultWorkerToolEffectCatalog();
    await withEnv({ NODE_ENV: 'production' }, () => {
      assert.equal(
        mustRouteExternalEffectThroughBroker(
          { localOnly: true },
          { connectorName: 'memory', catalog, hasConnection: true },
        ),
        true,
      );
    });
  });
});

describe('L3-03b dev compatibility', () => {
  it('7. Non-prod localOnly without catalog still bypasses broker', async () => {
    let brokerInvoked = false;
    await withEnv(
      {
        NODE_ENV: 'test',
        COMMANDER_PROFILE: undefined,
        COMMANDER_REQUIRE_EFFECT_BROKER: undefined,
      },
      async () => {
        const executor = new ToolStepExecutor(
          {
            get: (name) =>
              name === 'echo' ? { execute: async (args) => ({ echo: args.message }) } : null,
          },
          {
            execute: async () => {
              brokerInvoked = true;
              throw new Error('broker must not run in dev');
            },
          },
          undefined,
          DENY_ALL_TOOL_EFFECT_CATALOG,
        );
        const step = createMockStep({
          input: {
            toolName: 'echo',
            args: { message: 'dev' },
            localOnly: true,
            capabilityToken: issueLocalToolCapabilityToken({ toolName: 'echo', aud: 'tenant-a' }),
          },
        });
        const result = await executor.execute(step, {
          signal: ac.signal,
          worker: createMockWorker(),
        });
        assert.equal(brokerInvoked, false);
        assert.deepEqual((result as { result: unknown }).result, { echo: 'dev' });
      },
    );
  });

  it('8. Prod omits catalog ctor arg → DENY_ALL; forged localOnly still uses broker', async () => {
    let registryHit = false;
    let brokerHit = false;
    await withEnv({ NODE_ENV: 'test', COMMANDER_REQUIRE_EFFECT_BROKER: '1' }, async () => {
      // Catalog arg omitted — ToolStepExecutor must default to DENY_ALL.
      const issuer = makeCapabilityIssuer();
      const executor = new ToolStepExecutor(
        {
          get: (name) => {
            if (name !== 'echo') return null;
            return {
              execute: async () => {
                registryHit = true;
                return { leaked: true };
              },
            };
          },
        },
        {
          execute: async () => {
            brokerHit = true;
            return { effectId: 'eff-deny', replayed: false, response: { gated: true } };
          },
        },
        issuer,
      );
      const step = createMockStep({
        input: {
          toolName: 'echo',
          args: { message: 'x' },
          localOnly: true,
          effectId: 'eff-deny',
          idempotencyKey: 'idem-deny',
          capabilityToken: 'tok',
        },
      });
      await executeWithWorkload(executor, step);
      assert.equal(registryHit, false);
      assert.equal(brokerHit, true);
    });
  });
});
