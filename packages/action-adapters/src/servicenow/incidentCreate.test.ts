import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { servicenowCorrelationId } from '@praetor/contracts';
import { AdapterExecutionError } from '@praetor/effect-broker';
import { createServiceNowIncidentCreateAdapter } from './incidentCreate.js';
import { ActionAdapterRegistry } from '../registry.js';
import type { AdapterCredentialProvider } from '../types.js';
import { parseServiceNowDestination } from '../types.js';

const tenantId = 'tenant-a';
const destination = 'servicenow://dev12345/incident';
const idempotencyKey = 'idem-1';

function mockCredentials(): AdapterCredentialProvider {
  return {
    async getGitHubToken() {
      throw new Error('not used');
    },
    async getServiceNowCredentials() {
      return {
        instance: 'dev12345',
        username: 'admin',
        password: 'secret',
      };
    },
  };
}

interface MockState {
  incidents: Array<{
    sys_id: string;
    number: string;
    state: string;
    correlation_id: string;
    short_description: string;
    description: string;
  }>;
  createCount: number;
  writeCount: number;
}

function createMockFetch(state: MockState) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method === 'GET' && url.includes('/api/now/table/incident?')) {
      return new Response(JSON.stringify({ result: state.incidents }), { status: 200 });
    }
    if (method === 'POST' && url.endsWith('/api/now/table/incident')) {
      state.createCount += 1;
      state.writeCount += 1;
      const body = JSON.parse(String(init?.body)) as {
        short_description: string;
        description: string;
        correlation_id: string;
      };
      const created = {
        sys_id: `sys-${state.incidents.length + 1}`,
        number: `INC${state.incidents.length + 1}`,
        state: '1',
        correlation_id: body.correlation_id,
        short_description: body.short_description,
        description: body.description,
      };
      state.incidents.push(created);
      return new Response(JSON.stringify({ result: created }), { status: 201 });
    }
    if (method === 'GET' && /\/incident\/sys-/.test(url)) {
      const sysId = url.split('/').pop()!;
      const incident = state.incidents.find((entry) => entry.sys_id === sysId);
      if (!incident) return new Response('not found', { status: 404 });
      return new Response(JSON.stringify({ result: incident }), { status: 200 });
    }
    if (method === 'PATCH' && /\/incident\/sys-/.test(url)) {
      state.writeCount += 1;
      const sysId = url.split('/').pop()!;
      const incident = state.incidents.find((entry) => entry.sys_id === sysId);
      if (!incident) return new Response('not found', { status: 404 });
      const patch = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (typeof patch.state === 'string') incident.state = patch.state;
      return new Response(JSON.stringify({ result: incident }), { status: 200 });
    }
    return new Response('unexpected', { status: 500 });
  };
}

function baseInput() {
  return {
    tenantId,
    effectId: 'eff-1',
    idempotencyKey,
    destination,
    args: { short_description: 'Test incident', description: 'details' },
    signal: AbortSignal.timeout(5_000),
  };
}

describe('servicenow.incidentCreate adapter', () => {
  it('writes correlation_id on incident create', async () => {
    const state: MockState = { incidents: [], createCount: 0, writeCount: 0 };
    const adapter = createServiceNowIncidentCreateAdapter({
      credentials: mockCredentials(),
      fetch: createMockFetch(state),
    });
    await adapter.execute(baseInput());
    assert.equal(
      state.incidents[0]!.correlation_id,
      servicenowCorrelationId(tenantId, idempotencyKey),
    );
  });

  it('double execute with same idempotency creates only one remote incident', async () => {
    const state: MockState = { incidents: [], createCount: 0, writeCount: 0 };
    const adapter = createServiceNowIncidentCreateAdapter({
      credentials: mockCredentials(),
      fetch: createMockFetch(state),
    });
    const input = baseInput();
    await adapter.execute(input);
    await adapter.execute(input);
    assert.equal(state.createCount, 1);
    assert.equal(state.incidents.length, 1);
  });

  it('compensate uses compensationPatch not agent args', async () => {
    const state: MockState = { incidents: [], createCount: 0, writeCount: 0 };
    const adapter = createServiceNowIncidentCreateAdapter({
      credentials: mockCredentials(),
      fetch: createMockFetch(state),
    });
    const forward = await adapter.execute(baseInput());
    const compensated = await adapter.compensate({
      tenantId,
      effectId: 'eff-cmp-1',
      originalEffectId: 'eff-1',
      idempotencyKey: 'cmp:eff-1:1.0.0',
      destination,
      forwardResponse: forward,
      compensationPatch: { state: '7', close_code: 'Resolved', close_notes: 'done' },
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(compensated.state, '7');
    assert.equal(state.incidents[0]!.state, '7');
  });

  it('rejects compensationPatch keys outside descriptor allowlist', async () => {
    const state: MockState = { incidents: [], createCount: 0, writeCount: 0 };
    const adapter = createServiceNowIncidentCreateAdapter({
      credentials: mockCredentials(),
      fetch: createMockFetch(state),
    });
    const forward = await adapter.execute(baseInput());
    await assert.rejects(
      () =>
        adapter.compensate({
          tenantId,
          effectId: 'eff-cmp-1',
          originalEffectId: 'eff-1',
          idempotencyKey: 'cmp:eff-1:1.0.0',
          destination,
          forwardResponse: forward,
          compensationPatch: { malicious_field: 'x' },
          signal: AbortSignal.timeout(5_000),
        }),
      (error: unknown) => {
        assert.ok(error instanceof AdapterExecutionError);
        assert.equal(error.code, 'SERVICENOW_COMPENSATE_PATCH_DENIED');
        return true;
      },
    );
  });

  it('queryCompensationOutcome queries by sysId not cmp idempotency correlation', async () => {
    const state: MockState = { incidents: [], createCount: 0, writeCount: 0 };
    const adapter = createServiceNowIncidentCreateAdapter({
      credentials: mockCredentials(),
      fetch: createMockFetch(state),
    });
    const forward = await adapter.execute(baseInput());
    const compensationIdempotencyKey = 'cmp:eff-1:1.0.0';
    const compensated = await adapter.compensate({
      tenantId,
      effectId: 'eff-cmp-1',
      originalEffectId: 'eff-1',
      idempotencyKey: compensationIdempotencyKey,
      destination,
      forwardResponse: forward,
      compensationPatch: { state: '7' },
      signal: AbortSignal.timeout(5_000),
    });
    const compensationOutcome = await adapter.queryCompensationOutcome({
      tenantId,
      effectId: 'eff-cmp-1',
      idempotencyKey: compensationIdempotencyKey,
      destination,
      request: { expectedState: '7' },
      compensationResponse: compensated,
    });
    assert.equal(compensationOutcome.status, 'APPLIED');
    assert.equal(compensationOutcome.response?.sysId, forward.sysId);
    assert.equal(
      servicenowCorrelationId(tenantId, compensationIdempotencyKey),
      servicenowCorrelationId(tenantId, 'cmp:eff-1:1.0.0'),
    );
    assert.notEqual(
      state.incidents[0]!.correlation_id,
      servicenowCorrelationId(tenantId, compensationIdempotencyKey),
    );
  });

  it('queryOutcome and queryCompensationOutcome resolve incident state', async () => {
    const state: MockState = { incidents: [], createCount: 0, writeCount: 0 };
    const adapter = createServiceNowIncidentCreateAdapter({
      credentials: mockCredentials(),
      fetch: createMockFetch(state),
    });
    await adapter.execute(baseInput());
    const writesBefore = state.writeCount;
    const outcome = await adapter.queryOutcome({
      tenantId,
      effectId: 'eff-1',
      idempotencyKey,
      destination,
      request: {},
    });
    assert.equal(state.writeCount, writesBefore);
    assert.equal(outcome.status, 'APPLIED');

    await adapter.compensate({
      tenantId,
      effectId: 'eff-cmp-1',
      originalEffectId: 'eff-1',
      idempotencyKey: 'cmp:eff-1:1.0.0',
      destination,
      forwardResponse: { sysId: state.incidents[0]!.sys_id },
      compensationPatch: { state: '7' },
      signal: AbortSignal.timeout(5_000),
    });
    const compensationOutcome = await adapter.queryCompensationOutcome({
      tenantId,
      effectId: 'eff-cmp-1',
      idempotencyKey: 'cmp:eff-1:1.0.0',
      destination,
      request: { expectedState: '7' },
      compensationResponse: { sysId: state.incidents[0]!.sys_id, state: '7' },
    });
    assert.equal(compensationOutcome.status, 'APPLIED');
  });

  it('rejects malicious ServiceNow instance names', () => {
    assert.throws(() => parseServiceNowDestination('servicenow://evil.com@attacker/incident'));
    assert.throws(() => parseServiceNowDestination('servicenow://foo#bar/incident'));
    assert.throws(() => parseServiceNowDestination('servicenow://bad instance/incident'));
    assert.doesNotThrow(() => parseServiceNowDestination('servicenow://dev12345/incident'));
  });

  it('maps 401/403 to NOT_COMMITTED NEVER', async () => {
    const adapter = createServiceNowIncidentCreateAdapter({
      credentials: mockCredentials(),
      fetch: async () => new Response('forbidden', { status: 401 }),
    });
    await assert.rejects(
      () => adapter.execute(baseInput()),
      (error: unknown) => {
        assert.ok(error instanceof AdapterExecutionError);
        assert.equal(error.commitState, 'NOT_COMMITTED');
        assert.equal(error.retryMode, 'NEVER');
        return true;
      },
    );
  });

  it('classifies empty and non-object 2xx create bodies instead of throwing untyped errors', async () => {
    for (const body of [
      new Response('{}', { status: 201 }),
      new Response('', { status: 201 }),
      new Response('null', { status: 200 }),
    ]) {
      const adapter = createServiceNowIncidentCreateAdapter({
        credentials: mockCredentials(),
        fetch: async (_input, init) =>
          (init?.method ?? 'GET') === 'GET'
            ? new Response(JSON.stringify({ result: [] }), { status: 200 })
            : body,
      });
      await assert.rejects(
        () => adapter.execute(baseInput()),
        (error: unknown) => {
          assert.ok(error instanceof AdapterExecutionError);
          assert.equal(error.code, 'ADAPTER_RESPONSE_BODY_INVALID');
          assert.equal(error.commitState, 'UNKNOWN');
          assert.equal(error.retryMode, 'QUERY_FIRST');
          return true;
        },
      );
    }
  });

  it('reconciles a governed compensation through the registry using forwardResponse', async () => {
    const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
      if (/\/incident\/sys-1$/.test(String(input))) {
        return new Response(
          JSON.stringify({ result: { sys_id: 'sys-1', number: 'INC1', state: '7' } }),
          { status: 200 },
        );
      }
      return new Response('unexpected', { status: 500 });
    };
    const adapter = createServiceNowIncidentCreateAdapter({
      credentials: mockCredentials(),
      fetch: fetchImpl,
    });
    const registry = new ActionAdapterRegistry([adapter]);
    const querier = registry.outcomeQuerierFor('compensate.servicenow.incident.create');
    assert.ok(querier);
    const outcome = await querier.queryOutcome({
      effectId: 'eff-cmp-1',
      idempotencyKey: 'cmp:eff-1:1.0.0',
      type: 'compensate.servicenow.incident.create',
      tenantId,
      request: {
        originalEffectId: 'eff-1',
        destination,
        // The kernel constructs exactly this shape for governed compensations.
        forwardResponse: { sysId: 'sys-1', number: 'INC1', state: '1' },
        compensationPatch: { state: '7' },
      },
    });
    assert.equal(outcome.status, 'APPLIED');
    assert.equal(outcome.response?.sysId, 'sys-1');
  });
});
