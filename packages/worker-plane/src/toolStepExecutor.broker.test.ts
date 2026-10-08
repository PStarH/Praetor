import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EffectBrokerError } from '@praetor/effect-broker';
import { ToolStepExecutor } from './toolStepExecutor.js';
import { ConnectorStepExecutor } from './connectorStepExecutor.js';
import type { ClaimedStep } from './types.js';
import { WorkerExecutionError } from './types.js';

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

describe('tool/connector broker fail-closed', () => {
  it('requires broker mediation even when hasExternalEffects is omitted', async () => {
    let executed = false;
    const broker = {
      execute: async () => {
        executed = true;
        return { effectId: 'e1', replayed: false, response: { ok: true } };
      },
    };
    const executor = new ToolStepExecutor(
      { get: () => ({ execute: async () => ({ bypassed: true }) }) },
      broker,
    );
    await assert.rejects(
      () =>
        executor.execute(step({ toolName: 'http.get', args: {} }), {
          signal: AbortSignal.timeout(5_000),
          worker: { id: 'w1' } as never,
        }),
      (err: unknown) =>
        err instanceof WorkerExecutionError && err.options.code === 'EFFECT_AUTHORIZATION_REQUIRED',
    );
    assert.equal(executed, false);
  });

  it('routes through broker when credentials are present (ignores hasExternalEffects=false)', async () => {
    let executed = false;
    const broker = {
      execute: async () => {
        executed = true;
        return { effectId: 'e1', replayed: false, response: { ok: true } };
      },
    };
    const executor = new ToolStepExecutor(
      { get: () => ({ execute: async () => ({ bypassed: true }) }) },
      broker,
    );
    const out = await executor.execute(
      step({
        toolName: 'http.get',
        args: { url: 'https://example.com' },
        hasExternalEffects: false,
        effectId: 'e1',
        idempotencyKey: 'k1',
        capabilityToken: 'tok',
      }),
      { signal: AbortSignal.timeout(5_000), worker: { id: 'w1' } as never },
    );
    assert.equal(executed, true);
    assert.equal((out as { result?: { ok?: boolean } }).result?.ok, true);
  });

  it('connector path also refuses input-flag bypass when broker is wired', async () => {
    const broker = {
      execute: async () => ({ effectId: 'e1', replayed: false, response: { ok: true } }),
    };
    const executor = new ConnectorStepExecutor(
      {
        get: () => ({
          initialize: async () => {},
          execute: async () => ({ bypassed: true }),
          close: async () => {},
        }),
        register: () => {},
      },
      broker,
    );
    await assert.rejects(
      () =>
        executor.execute(
          step({
            connectorName: 'crm',
            operation: 'write',
            args: {},
            hasExternalEffects: false,
          }),
          { signal: AbortSignal.timeout(5_000), worker: { id: 'w1' } as never },
        ),
      (err: unknown) =>
        err instanceof WorkerExecutionError && err.options.code === 'EFFECT_AUTHORIZATION_REQUIRED',
    );
  });

  it('preserves reconciliation-owned broker errors across tool and connector executors', async () => {
    const broker = {
      execute: async () => {
        throw new EffectBrokerError('EVIDENCE_PERSIST_FAILED', { effectId: 'e1' });
      },
    };
    const executors = [
      {
        executor: new ToolStepExecutor(undefined, broker),
        input: {
          toolName: 'http.get',
          args: {},
          effectId: 'e1',
          idempotencyKey: 'k1',
          capabilityToken: 'tok',
        },
      },
      {
        executor: new ConnectorStepExecutor(undefined, broker),
        input: {
          connectorName: 'crm',
          operation: 'write',
          args: {},
          effectId: 'e1',
          idempotencyKey: 'k1',
          capabilityToken: 'tok',
        },
      },
    ];

    for (const { executor, input } of executors) {
      await assert.rejects(
        () =>
          executor.execute(step(input), {
            signal: AbortSignal.timeout(5_000),
            worker: { id: 'w1' } as never,
          }),
        (error: unknown) =>
          error instanceof WorkerExecutionError &&
          error.options.code === 'EVIDENCE_PERSIST_FAILED' &&
          error.options.retryable === false,
      );
    }
  });
});
