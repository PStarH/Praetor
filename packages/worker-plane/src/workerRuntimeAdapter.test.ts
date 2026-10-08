import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createAgentStepExecutor,
  createExecutorManifest,
  toLlmBrokerLease,
} from './workerRuntimeAdapter.js';
import type { EffectBroker } from '@praetor/effect-broker';

describe('workerRuntimeAdapter', () => {
  it('creates an agent step executor without dynamic require', () => {
    const executor = createAgentStepExecutor({ defaultMaxSteps: 3 });
    assert.equal(typeof executor.execute, 'function');
  });

  it('requires EffectBroker in production and issuer whenever broker is set (WS2 §1)', () => {
    const prev = process.env.NODE_ENV;
    const broker = {
      execute: async () => ({ effectId: 'e', replayed: false }),
    } as unknown as EffectBroker;
    const issuer = {
      issue: () => 'tok',
    } as unknown as import('@praetor/effect-broker').CapabilityTokenIssuer;

    process.env.NODE_ENV = 'production';
    try {
      assert.throws(
        () => createAgentStepExecutor({ defaultMaxSteps: 1 }),
        /EFFECT_BROKER_UNAVAILABLE/,
      );
      assert.throws(
        () => createAgentStepExecutor({ effectBroker: broker }),
        /EFFECT_CAPABILITY_ISSUER_REQUIRED/,
      );
      assert.doesNotThrow(() =>
        createAgentStepExecutor({ effectBroker: broker, capabilityIssuer: issuer }),
      );
    } finally {
      process.env.NODE_ENV = prev;
    }

    // Non-production: broker without issuer must also refuse (avoid wrap-without-ALS footgun).
    process.env.NODE_ENV = 'test';
    try {
      assert.throws(
        () => createAgentStepExecutor({ effectBroker: broker }),
        /EFFECT_CAPABILITY_ISSUER_REQUIRED/,
      );
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it('validates executor manifest against declared capabilities', () => {
    const manifest = createExecutorManifest({
      agent: () => createAgentStepExecutor(),
      tool: () => ({ execute: async () => ({}) }),
    });

    assert.doesNotThrow(() => manifest.validate(['agent']));
    assert.throws(
      () => manifest.validate(['agent', 'connector']),
      /missing required capabilities: connector/,
    );
  });

  it('accepts wildcard capabilities as all manifest entries', () => {
    const manifest = createExecutorManifest({
      agent: () => createAgentStepExecutor(),
      tool: () => ({ execute: async () => ({}) }),
    });

    assert.doesNotThrow(() => manifest.validate(['*']));
  });

  it('toLlmBrokerLease preserves workerGeneration (kernel fencing)', () => {
    const lease = toLlmBrokerLease({
      workerId: 'w1',
      workerGeneration: 3,
      token: 'tok',
      fencingEpoch: 2,
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    assert.equal(lease.workerGeneration, 3);
    assert.deepEqual(lease, {
      workerId: 'w1',
      workerGeneration: 3,
      token: 'tok',
      fencingEpoch: 2,
    });
    // generation 0 must not be dropped (?? -1 would LEASE_LOST against claimed leases)
    assert.equal(
      toLlmBrokerLease({
        workerId: 'w1',
        workerGeneration: 0,
        token: 'tok',
        fencingEpoch: 1,
        expiresAt: '2099-01-01T00:00:00.000Z',
      }).workerGeneration,
      0,
    );
  });
});
