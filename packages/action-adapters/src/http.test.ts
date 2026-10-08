import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AdapterExecutionError } from '@praetor/effect-broker';
import {
  adapterFetch,
  readJsonResponse,
  requireArrayResponse,
  requireObjectResponse,
} from './http.js';

describe('adapterFetch', () => {
  it('does not follow redirects', async () => {
    let callCount = 0;
    const fetchImpl = async () => {
      callCount += 1;
      return new Response('', { status: 302, headers: { location: 'https://evil.example' } });
    };
    await assert.rejects(() => adapterFetch(fetchImpl, 'https://api.example/resource'));
    assert.equal(callCount, 1);
  });

  it('passes through abort signal', async () => {
    const controller = new AbortController();
    const fetchImpl = async (_url: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(init?.signal, controller.signal);
      assert.equal(init?.redirect, 'manual');
      return new Response('{}', { status: 200 });
    };
    await adapterFetch(fetchImpl, 'https://api.example/resource', { signal: controller.signal });
  });
});

describe('adapter response body classification', () => {
  it('classifies an unparseable 2xx body as UNKNOWN/QUERY_FIRST', async () => {
    for (const body of ['', 'not json', '{']) {
      await assert.rejects(
        () => readJsonResponse(new Response(body, { status: 201 })),
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

  it('rejects non-object and non-array 2xx bodies with a classified error', async () => {
    for (const value of [null, 1, 'text', true, []]) {
      assert.throws(
        () => requireObjectResponse(value, 'probe'),
        (error: unknown) => {
          assert.ok(error instanceof AdapterExecutionError);
          assert.equal(error.commitState, 'UNKNOWN');
          assert.equal(error.retryMode, 'QUERY_FIRST');
          return true;
        },
      );
    }
    for (const value of [null, {}, 'text']) {
      assert.throws(
        () => requireArrayResponse(value, 'probe'),
        (error: unknown) => {
          assert.ok(error instanceof AdapterExecutionError);
          assert.equal(error.code, 'ADAPTER_RESPONSE_BODY_INVALID');
          return true;
        },
      );
    }
    assert.deepEqual(requireObjectResponse({ ok: true }, 'probe'), { ok: true });
    assert.deepEqual(requireArrayResponse([1, 2], 'probe'), [1, 2]);
  });
});
