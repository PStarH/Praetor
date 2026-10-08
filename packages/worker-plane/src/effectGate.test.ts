import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EffectBrokerError } from '@praetor/effect-broker';
import { WorkerExecutionError } from './types.js';
import { workerExecutionErrorFromEffectFailure } from './effectGate.js';

describe('workerExecutionErrorFromEffectFailure', () => {
  it('preserves EffectBrokerError codes for retry classification', () => {
    const err = workerExecutionErrorFromEffectFailure(
      new EffectBrokerError('COMPLETION_UNKNOWN', { effectId: 'e1' }),
      { toolName: 'http.get', stepId: 's1' },
    );
    assert.ok(err instanceof WorkerExecutionError);
    assert.equal(err.options.code, 'COMPLETION_UNKNOWN');
    assert.equal(err.options.retryable, true);
    assert.equal(err.options.details?.effectId, 'e1');
  });

  it('preserves evidence persistence ownership without making it retryable', () => {
    const err = workerExecutionErrorFromEffectFailure(
      new EffectBrokerError('EVIDENCE_PERSIST_FAILED', { effectId: 'e1' }),
      { toolName: 'http.get', stepId: 's1' },
    );
    assert.equal(err.options.code, 'EVIDENCE_PERSIST_FAILED');
    assert.equal(err.options.retryable, false);
  });

  it('falls back to EFFECT_EXECUTION_FAILED for unknown errors', () => {
    const err = workerExecutionErrorFromEffectFailure(new Error('boom'), {
      stepId: 's1',
      toolName: 'x',
    });
    assert.equal(err.options.code, 'EFFECT_EXECUTION_FAILED');
    assert.equal(err.options.retryable, false);
  });
});
