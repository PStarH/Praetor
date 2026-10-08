import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONTRACT_SCHEMAS, KERNEL_ERROR_CODES } from '@praetor/contracts';
import type { KernelErrorDetails, KernelEvent } from './index.js';

// F-K1-1: this file previously constructed the event/error literals and then
// asserted on those same literals — a tautology that survived deleting every
// contract in `@praetor/contracts`. It now checks the literals against the
// canonical runtime schemas, so canonical contract drift fails the test.

const event: KernelEvent = {
  eventId: 'event-1',
  aggregateType: 'run',
  aggregateId: 'run-1',
  sequence: 1,
  type: 'run.created',
  tenantId: 'tenant-1',
  runId: 'run-1',
  actor: 'kernel',
  schemaVersion: 'v2',
  payload: {},
  occurredAt: '2026-07-15T00:00:00.000Z',
};

const error: KernelErrorDetails = {
  code: 'RUN_NOT_FOUND',
  message: 'test error',
  retryable: false,
};

interface JsonSchemaFragment {
  $id: string;
  required: readonly string[];
  properties: Record<string, { type?: string; enum?: readonly unknown[] }>;
  additionalProperties: boolean;
}

const kernelEventSchema = CONTRACT_SCHEMAS.kernelEvent as unknown as JsonSchemaFragment;
const kernelErrorSchema = CONTRACT_SCHEMAS.kernelError as unknown as JsonSchemaFragment;

const jsonType = (value: unknown): string =>
  Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;

test('kernel event literal conforms to the canonical kernel-event contract', () => {
  assert.deepEqual(
    Object.keys(event).sort(),
    [...kernelEventSchema.required].sort(),
    'kernel event fields must be exactly the canonical required envelope fields',
  );
  for (const [field, schema] of Object.entries(kernelEventSchema.properties)) {
    if (!(field in event)) continue;
    const value = (event as unknown as Record<string, unknown>)[field];
    if (schema.type) {
      const expected = schema.type === 'integer' ? 'number' : schema.type;
      assert.equal(
        jsonType(value),
        expected,
        `kernel event field ${field} must be ${schema.type} per the canonical schema`,
      );
      if (schema.type === 'integer') {
        assert.ok(Number.isInteger(value), `kernel event field ${field} must be an integer`);
      }
    }
    if (schema.enum) {
      assert.ok(
        schema.enum.includes(value),
        `kernel event field ${field} value ${String(value)} is outside the canonical enum`,
      );
    }
  }
  assert.equal(
    kernelEventSchema.additionalProperties,
    false,
    'canonical kernel-event envelope must stay closed',
  );
});

test('kernel error literal uses the canonical error-code vocabulary', () => {
  assert.ok(KERNEL_ERROR_CODES.length > 0, 'canonical error vocabulary must not be empty');
  assert.equal(
    (kernelErrorSchema.properties.code?.enum ?? []).length,
    KERNEL_ERROR_CODES.length,
    'canonical error schema must enumerate the canonical codes',
  );
  assert.ok(
    KERNEL_ERROR_CODES.includes(error.code as (typeof KERNEL_ERROR_CODES)[number]),
    `kernel error code ${error.code} is not part of the canonical vocabulary`,
  );
  assert.deepEqual(
    Object.keys(error).sort(),
    [...kernelErrorSchema.required].sort(),
    'kernel error fields must be exactly the canonical required fields',
  );
});
