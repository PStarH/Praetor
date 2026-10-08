import {
  validateRunTransition,
  validateStepTransition,
  type RunState,
  type StepState,
} from '@praetor/contracts';
import { KernelInvariantError } from './types.js';

export function assertRunTransition(from: RunState, to: RunState): void {
  const result = validateRunTransition(from, to);
  if (!result.ok) {
    throw new KernelInvariantError(
      'INVALID_TRANSITION',
      `run transition ${from} -> ${to} rejected by @praetor/contracts`,
    );
  }
}

export function assertStepTransition(from: StepState, to: StepState): void {
  const result = validateStepTransition(from, to);
  if (!result.ok) {
    throw new KernelInvariantError(
      'INVALID_TRANSITION',
      `step transition ${from} -> ${to} rejected by @praetor/contracts`,
    );
  }
}
