import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { KernelInvariantError } from './types.js';
import { assertRunTransition, assertStepTransition } from './transitionValidation.js';

describe('kernel transition validation', () => {
  it('accepts transitions declared by @praetor/contracts', () => {
    assert.doesNotThrow(() => assertRunTransition('PENDING', 'RUNNING'));
    assert.doesNotThrow(() => assertStepTransition('RUNNING', 'RETRY_WAIT'));
  });

  it('throws INVALID_TRANSITION for illegal state changes', () => {
    assert.throws(
      () => assertStepTransition('FAILED', 'RUNNING'),
      (error: unknown) =>
        error instanceof KernelInvariantError && error.code === 'INVALID_TRANSITION',
    );
    assert.throws(
      () => assertRunTransition('SUCCEEDED', 'PAUSED'),
      (error: unknown) =>
        error instanceof KernelInvariantError && error.code === 'INVALID_TRANSITION',
    );
  });
});
