import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GITHUB_PULL_REQUEST_CREATE_DESCRIPTOR } from '@praetor/contracts';
import { ActionAdapterRegistry } from './registry.js';
import { FIXED_ACTION_ADAPTER_MANIFESTS } from '@praetor/contracts';
import type { ActionAdapter } from './types.js';

function stubAdapter(effectType: string): ActionAdapter {
  return {
    descriptor: { ...GITHUB_PULL_REQUEST_CREATE_DESCRIPTOR, effectType },
    async execute() {
      return {};
    },
    async queryOutcome() {
      return {
        status: 'UNKNOWN',
        error: {
          code: 'RECONCILE_OUTCOME_NOT_YET_VISIBLE',
          message: 'Remote outcome is not yet provable',
        },
      };
    },
    async compensate() {
      return {};
    },
    async queryCompensationOutcome() {
      return {
        status: 'UNKNOWN',
        error: {
          code: 'RECONCILE_OUTCOME_NOT_YET_VISIBLE',
          message: 'Remote outcome is not yet provable',
        },
      };
    },
  };
}

describe('ActionAdapterRegistry', () => {
  it('production registers Kubernetes rollback for both effect directions', () => {
    const descriptor = FIXED_ACTION_ADAPTER_MANIFESTS.find(
      (manifest) => manifest.adapterId === 'kubernetes.deployment.rollback',
    )!;
    const credentials = {
      getGitHubToken: async () => 'github',
      getServiceNowCredentials: async () => ({ instance: 'dev', username: 'u', password: 'p' }),
      getKubernetesCredentials: async () => ({
        cluster: 'cluster-a',
        server: 'https://kubernetes.example',
        token: 'token',
      }),
      getToken: async () => 'token',
      getServer: () => new URL('https://kubernetes.example'),
    };
    const registry = ActionAdapterRegistry.production(credentials);
    assert.equal(
      registry.resolve(descriptor.effectType)?.descriptor.adapterId,
      descriptor.adapterId,
    );
    assert.equal(
      registry.resolve(descriptor.compensationEffectType)?.descriptor.adapterId,
      descriptor.adapterId,
    );
  });
  it('resolve returns adapter by effect type', () => {
    const adapter = stubAdapter('connector.github.pull-request.create');
    const registry = new ActionAdapterRegistry([adapter]);
    assert.equal(registry.resolve('connector.github.pull-request.create'), adapter);
  });

  it('resolve returns adapter by compensation effect type', () => {
    const adapter = stubAdapter('connector.github.pull-request.create');
    const registry = new ActionAdapterRegistry([adapter]);
    assert.equal(registry.resolve('compensate.github.pull-request.create'), adapter);
  });

  it('empty registry resolve returns null', () => {
    assert.equal(
      ActionAdapterRegistry.empty().resolve('connector.github.pull-request.create'),
      null,
    );
  });

  it('outcomeQuerierFor bridges adapter queryOutcome', async () => {
    const adapter = stubAdapter('connector.github.pull-request.create');
    adapter.queryOutcome = async () => ({
      status: 'APPLIED',
      response: { prNumber: 42 },
    });
    const registry = new ActionAdapterRegistry([adapter]);
    const querier = registry.outcomeQuerierFor('connector.github.pull-request.create');
    assert.ok(querier);
    const outcome = await querier!.queryOutcome({
      effectId: 'eff-1',
      idempotencyKey: 'idem-1',
      type: 'connector.github.pull-request.create',
      request: { destination: 'github://octo/repo/pulls' },
      tenantId: 'tenant-a',
    });
    assert.deepEqual(outcome, { status: 'APPLIED', response: { prNumber: 42 } });
  });

  it('outcomeQuerierFor forwards abort signal to adapter', async () => {
    const controller = new AbortController();
    const adapter = stubAdapter('connector.github.pull-request.create');
    adapter.queryOutcome = async (input) => {
      assert.equal(input.signal, controller.signal);
      return {
        status: 'UNKNOWN',
        error: {
          code: 'RECONCILE_OUTCOME_NOT_YET_VISIBLE',
          message: 'Remote outcome is not yet provable',
        },
      };
    };
    const registry = new ActionAdapterRegistry([adapter]);
    const querier = registry.outcomeQuerierFor('connector.github.pull-request.create');
    assert.ok(querier);
    await querier!.queryOutcome({
      effectId: 'eff-1',
      idempotencyKey: 'idem-1',
      type: 'connector.github.pull-request.create',
      request: { destination: 'github://octo/repo/pulls' },
      tenantId: 'tenant-a',
      signal: controller.signal,
    });
  });

  it('outcomeQuerierFor routes compensation effects to compensation queries', async () => {
    const adapter = stubAdapter('connector.github.pull-request.create');
    let forwardQueries = 0;
    let compensationQueries = 0;
    adapter.queryOutcome = async () => {
      forwardQueries += 1;
      return {
        status: 'UNKNOWN',
        error: {
          code: 'RECONCILE_OUTCOME_NOT_YET_VISIBLE',
          message: 'Remote outcome is not yet provable',
        },
      };
    };
    adapter.queryCompensationOutcome = async () => {
      compensationQueries += 1;
      return { status: 'APPLIED', response: { state: 'closed' } };
    };
    const registry = new ActionAdapterRegistry([adapter]);
    const querier = registry.outcomeQuerierFor('compensate.github.pull-request.create');
    assert.ok(querier);
    const outcome = await querier.queryOutcome({
      effectId: 'cmp-effect-1',
      idempotencyKey: 'cmp:effect-1:1.0.0',
      type: 'compensate.github.pull-request.create',
      request: { destination: 'github://octo/repo/pulls' },
      tenantId: 'tenant-a',
    });
    assert.equal(outcome.status, 'APPLIED');
    assert.equal(forwardQueries, 0);
    assert.equal(compensationQueries, 1);
  });

  it('listDescriptors returns registered descriptor list', () => {
    const adapter = stubAdapter('connector.github.pull-request.create');
    const registry = new ActionAdapterRegistry([adapter]);
    assert.equal(registry.listDescriptors().length, 1);
    assert.equal(registry.listDescriptors()[0]?.effectType, 'connector.github.pull-request.create');
  });

  it('refuses a compensation effect type that collides with another adapter key', () => {
    const forward = stubAdapter('connector.a.create');
    const collides: ActionAdapter = {
      ...stubAdapter('connector.b.create'),
      descriptor: {
        ...GITHUB_PULL_REQUEST_CREATE_DESCRIPTOR,
        effectType: 'connector.b.create',
        compensationEffectType: 'connector.a.create',
      },
    };
    assert.throws(
      () => new ActionAdapterRegistry([forward, collides]),
      /Duplicate action adapter effect type registration: connector\.a\.create/,
    );
  });

  it('refuses a duplicate forward effect type registration', () => {
    assert.throws(
      () =>
        new ActionAdapterRegistry([
          stubAdapter('connector.a.create'),
          stubAdapter('connector.a.create'),
        ]),
      /Duplicate action adapter effect type registration: connector\.a\.create/,
    );
  });
});
