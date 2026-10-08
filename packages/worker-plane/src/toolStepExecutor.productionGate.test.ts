/**
 * WP-09: the production effect gate inside ToolStepExecutor re-derived the production
 * predicate locally and omitted `COMMANDER_REQUIRE_EFFECT_BROKER`, while the shared
 * gate (effectGate.isProductionEffectGate) includes it. With only that variable set,
 * a step-supplied `capabilityToken` was accepted instead of requiring the step-bound
 * mint, so a production effect executed on a caller-supplied token.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ToolStepExecutor } from './toolStepExecutor.js';
import type { ClaimedStep } from './types.js';
import { WorkerExecutionError } from './types.js';
import { deriveEffectIdempotencyKey } from '@praetor/effect-broker';

const GATE_ENV_KEYS = [
  'NODE_ENV',
  'COMMANDER_PROFILE',
  'COMMANDER_REQUIRE_EFFECT_BROKER',
  'COMMANDER_REQUIRE_WORKLOAD_BINDING',
] as const;

async function withEnv(
  values: Partial<Record<(typeof GATE_ENV_KEYS)[number], string | undefined>>,
  fn: () => Promise<void>,
): Promise<void> {
  const saved = new Map<string, string | undefined>();
  for (const key of GATE_ENV_KEYS) saved.set(key, process.env[key]);
  try {
    for (const key of GATE_ENV_KEYS) {
      const value = values[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function step(input: Record<string, unknown>): ClaimedStep {
  return {
    id: 'step-1',
    runId: 'run-1',
    tenantId: 'tenant-a',
    kind: 'tool',
    state: 'RUNNING',
    attempt: 1,
    version: 1,
    input,
    lease: {
      workerId: 'w1',
      workerGeneration: 1,
      token: 'lease',
      fencingEpoch: 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  } as ClaimedStep;
}

const externalInput = {
  toolName: 'http.get',
  args: { url: 'https://example.com' },
  hasExternalEffects: true,
  effectId: 'e1',
  idempotencyKey: 'k1',
  capabilityToken: 'caller-supplied-token',
};

describe('ToolStepExecutor production effect gate (WP-09)', () => {
  it('refuses a caller-supplied capabilityToken when only COMMANDER_REQUIRE_EFFECT_BROKER=1 is set', async () => {
    await withEnv({ NODE_ENV: 'test', COMMANDER_REQUIRE_EFFECT_BROKER: '1' }, async () => {
      let brokerExecuted = false;
      const broker = {
        execute: async () => {
          brokerExecuted = true;
          return { effectId: 'e1', replayed: false, response: { ok: true } };
        },
      };
      const executor = new ToolStepExecutor({ get: () => null }, broker);
      await assert.rejects(
        () =>
          executor.execute(step(externalInput), {
            signal: AbortSignal.timeout(5_000),
            worker: { id: 'w1' } as never,
          }),
        (err: unknown) =>
          err instanceof WorkerExecutionError &&
          err.options.code === 'EFFECT_CAPABILITY_ISSUER_REQUIRED',
      );
      assert.equal(brokerExecuted, false);
    });
  });

  it('refuses a caller-supplied capabilityToken when only COMMANDER_REQUIRE_WORKLOAD_BINDING=1 is set', async () => {
    // This flag used to be part of the executor's local predicate; replacing the local
    // copy with the shared gate dropped it, which silently re-opened the fallback.
    await withEnv({ NODE_ENV: 'test', COMMANDER_REQUIRE_WORKLOAD_BINDING: '1' }, async () => {
      let brokerExecuted = false;
      const broker = {
        execute: async () => {
          brokerExecuted = true;
          return { effectId: 'e1', replayed: false, response: { ok: true } };
        },
      };
      const executor = new ToolStepExecutor({ get: () => null }, broker);
      await assert.rejects(
        () =>
          executor.execute(step(externalInput), {
            signal: AbortSignal.timeout(5_000),
            worker: { id: 'w1' } as never,
          }),
        (err: unknown) =>
          err instanceof WorkerExecutionError &&
          err.options.code === 'EFFECT_CAPABILITY_ISSUER_REQUIRED',
      );
      assert.equal(brokerExecuted, false);
    });
  });

  it('still allows the caller-supplied token outside the production gate', async () => {
    await withEnv(
      {
        NODE_ENV: 'test',
        COMMANDER_PROFILE: undefined,
        COMMANDER_REQUIRE_EFFECT_BROKER: undefined,
      },
      async () => {
        const broker = {
          execute: async () => ({ effectId: 'e1', replayed: false, response: { ok: true } }),
        };
        const executor = new ToolStepExecutor({ get: () => null }, broker);
        const out = await executor.execute(step(externalInput), {
          signal: AbortSignal.timeout(5_000),
          worker: { id: 'w1' } as never,
        });
        assert.equal((out as { result?: { ok?: boolean } }).result?.ok, true);
      },
    );
  });

  it('derives the broker idempotency key from the verified step identity', async () => {
    await withEnv({ NODE_ENV: 'test' }, async () => {
      let brokerInput: { idempotencyKey?: string } | undefined;
      const broker = {
        execute: async (input: { idempotencyKey?: string }) => {
          brokerInput = input;
          return { effectId: 'e1', replayed: false, response: { ok: true } };
        },
      };
      const executor = new ToolStepExecutor({ get: () => null }, broker);
      const input = { ...externalInput };
      delete (input as { idempotencyKey?: string }).idempotencyKey;
      await executor.execute(step(input), {
        signal: AbortSignal.timeout(5_000),
        worker: { id: 'w1' } as never,
      });
      assert.equal(
        brokerInput?.idempotencyKey,
        deriveEffectIdempotencyKey({
          tenantId: 'tenant-a',
          runId: 'run-1',
          stepId: 'step-1',
          effectId: 'e1',
          request: input.args,
        }),
      );
    });
  });
});
