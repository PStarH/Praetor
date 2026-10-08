import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { describe, it } from 'node:test';
import { githubPrBodyMarker } from '@praetor/contracts';
import { AdapterExecutionError } from '@praetor/effect-broker';
import { createGitHubPullRequestCreateAdapter } from './pullRequestCreate.js';
import { ActionAdapterRegistry } from '../registry.js';
import type { AdapterCredentialProvider } from '../types.js';
import type { FetchFn } from '../http.js';

const tenantId = 'tenant-a';
const destination = 'github://octo/repo/pulls';
const idempotencyKey = 'idem-1';

function mockCredentials(): AdapterCredentialProvider {
  return {
    async getGitHubToken() {
      return 'gh-test-token';
    },
    async getServiceNowCredentials() {
      throw new Error('not used');
    },
  };
}

interface MockState {
  pulls: Array<{
    number: number;
    html_url: string;
    state: string;
    body: string;
    head: { ref: string; sha: string; repo: { full_name: string } };
    base: { ref: string; repo: { full_name: string } };
    merged: boolean;
    merged_at: string | null;
    title?: string;
    user?: { login: string };
  }>;
  createCount: number;
  writeCount: number;
  /** Error injection: force this HTTP status on the next create request. */
  injectCreateStatus?: number;
}

function githubActorResponse(): Response {
  return new Response(JSON.stringify({ login: 'octocat' }), { status: 200 });
}

function isGitHubActorRequest(input: RequestInfo | URL, init?: RequestInit): boolean {
  return (init?.method ?? 'GET') === 'GET' && String(input) === 'https://api.github.com/user';
}

function createMockFetch(state: MockState) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (isGitHubActorRequest(input, init)) return githubActorResponse();
    // Error injection must be evaluated before the success handlers, otherwise
    // the branch is unreachable (the previous `X-Mock-Status` check sat after the
    // catch-all POST handler, and the adapter never sends that header anyway).
    if (method === 'POST' && url.endsWith('/pulls') && state.injectCreateStatus !== undefined) {
      return new Response('injected failure', { status: state.injectCreateStatus });
    }
    if (method === 'GET' && url.includes('/pulls?')) {
      return new Response(JSON.stringify(state.pulls), { status: 200 });
    }
    if (method === 'POST' && url.endsWith('/pulls')) {
      state.createCount += 1;
      state.writeCount += 1;
      const body = JSON.parse(String(init?.body)) as {
        title: string;
        body: string;
        head: string;
        base: string;
      };
      const created = {
        number: state.pulls.length + 1,
        html_url: `https://github.com/octo/repo/pull/${state.pulls.length + 1}`,
        state: 'open',
        title: body.title,
        body: body.body,
        head: { ref: body.head, sha: 'a'.repeat(40), repo: { full_name: 'octo/repo' } },
        base: { ref: body.base, repo: { full_name: 'octo/repo' } },
        merged: false,
        merged_at: null,
        user: { login: 'octocat' },
      };
      state.pulls.push(created);
      return new Response(JSON.stringify(created), { status: 201 });
    }
    if (method === 'PATCH' && /\/pulls\/\d+$/.test(url)) {
      state.writeCount += 1;
      const number = Number(url.split('/').pop());
      const pull = state.pulls.find((entry) => entry.number === number);
      if (!pull) return new Response('not found', { status: 404 });
      pull.state = 'closed';
      return new Response(JSON.stringify(pull), { status: 200 });
    }
    if (method === 'GET' && /\/pulls\/\d+$/.test(url)) {
      const number = Number(url.split('/').pop());
      const pull = state.pulls.find((entry) => entry.number === number);
      if (!pull) return new Response('not found', { status: 404 });
      return new Response(JSON.stringify(pull), { status: 200 });
    }
    return new Response('unexpected', { status: 500 });
  };
}

function storedReceipt(prNumber: number): Record<string, unknown> {
  return {
    prNumber,
    url: `https://github.com/octo/repo/pull/${prNumber}`,
    state: 'open',
    idempotencyKey,
    destination,
    head: 'feature',
    base: 'main',
    headSha: 'a'.repeat(40),
  };
}

function baseInput() {
  return {
    tenantId,
    effectId: 'eff-1',
    idempotencyKey,
    destination,
    args: { title: 'Test PR', body: 'body', head: 'feature', base: 'main' },
    signal: AbortSignal.timeout(5_000),
  };
}

describe('github.pullRequestCreate adapter', () => {
  it('injects marker into PR body on create', async () => {
    const state: MockState = { pulls: [], createCount: 0, writeCount: 0 };
    const adapter = createGitHubPullRequestCreateAdapter({
      credentials: mockCredentials(),
      fetch: createMockFetch(state),
    });
    const response = await adapter.execute(baseInput());
    assert.equal(state.createCount, 1);
    assert.match(state.pulls[0]!.body, /<!-- commander-action:/);
    assert.equal(response.prNumber, 1);
    assert.equal(
      state.pulls[0]!.body.includes(githubPrBodyMarker(tenantId, idempotencyKey, 'gh-test-token')),
      true,
    );
  });

  it('double execute with same idempotency creates only one remote PR', async () => {
    const state: MockState = { pulls: [], createCount: 0, writeCount: 0 };
    const adapter = createGitHubPullRequestCreateAdapter({
      credentials: mockCredentials(),
      fetch: createMockFetch(state),
    });
    const input = baseInput();
    await adapter.execute(input);
    await adapter.execute(input);
    assert.equal(state.createCount, 1);
    assert.equal(state.pulls.length, 1);
  });

  it('rejects same-key execution when title or body changes', async () => {
    const state: MockState = { pulls: [], createCount: 0, writeCount: 0 };
    const adapter = createGitHubPullRequestCreateAdapter({
      credentials: mockCredentials(),
      fetch: createMockFetch(state),
    });
    await adapter.execute(baseInput());

    await assert.rejects(
      () =>
        adapter.execute({
          ...baseInput(),
          args: { title: 'Changed PR', body: 'changed body', head: 'feature', base: 'main' },
        }),
      (error: unknown) => {
        assert.ok(error instanceof AdapterExecutionError);
        assert.equal(error.code, 'GITHUB_IDEMPOTENCY_CONFLICT');
        assert.equal(error.commitState, 'UNKNOWN');
        assert.equal(error.retryMode, 'QUERY_FIRST');
        return true;
      },
    );
    assert.equal(state.createCount, 1);
  });

  it('rejects a marker candidate outside the requested head/base', async () => {
    const state: MockState = { pulls: [], createCount: 0, writeCount: 0 };
    const adapter = createGitHubPullRequestCreateAdapter({
      credentials: mockCredentials(),
      fetch: createMockFetch(state),
    });
    await adapter.execute(baseInput());

    for (const args of [
      { title: 'Test PR', body: 'body', head: 'other-feature', base: 'main' },
      { title: 'Test PR', body: 'body', head: 'feature', base: 'other-main' },
    ]) {
      await assert.rejects(
        () => adapter.execute({ ...baseInput(), args }),
        (error: unknown) => {
          assert.ok(error instanceof AdapterExecutionError);
          assert.equal(error.code, 'GITHUB_IDEMPOTENCY_CONFLICT');
          assert.equal(error.commitState, 'UNKNOWN');
          assert.equal(error.retryMode, 'QUERY_FIRST');
          return true;
        },
      );
    }
    assert.equal(state.createCount, 1);
  });

  it('creates the approved pull request when an existing PR only has the public marker', async () => {
    const publicMarker = githubPrBodyMarker(tenantId, idempotencyKey);
    const state: MockState = {
      pulls: [
        {
          number: 1,
          html_url: 'https://github.com/octo/repo/pull/1',
          state: 'open',
          body: `unapproved\n\n${publicMarker}`,
          head: { ref: 'feature', sha: 'b'.repeat(40), repo: { full_name: 'octo/repo' } },
          base: { ref: 'main', repo: { full_name: 'octo/repo' } },
          merged: false,
          merged_at: null,
        },
      ],
      createCount: 0,
      writeCount: 0,
    };
    const adapter = createGitHubPullRequestCreateAdapter({
      credentials: mockCredentials(),
      fetch: createMockFetch(state),
    });
    const receipt = await adapter.execute(baseInput());
    assert.equal(state.createCount, 1);
    assert.equal(receipt.prNumber, 2);
  });

  it('does not claim a marker match opened by a different GitHub user', async () => {
    const marker = githubPrBodyMarker(tenantId, idempotencyKey, 'gh-test-token');
    const state: MockState = {
      pulls: [
        {
          number: 1,
          html_url: 'https://github.com/octo/repo/pull/1',
          state: 'open',
          title: 'Test PR',
          body: `body\n\n${marker}`,
          head: { ref: 'feature', sha: 'a'.repeat(40), repo: { full_name: 'octo/repo' } },
          base: { ref: 'main', repo: { full_name: 'octo/repo' } },
          merged: false,
          merged_at: null,
          user: { login: 'intruder' },
        },
      ],
      createCount: 0,
      writeCount: 0,
    };
    const adapter = createGitHubPullRequestCreateAdapter({
      credentials: mockCredentials(),
      fetch: createMockFetch(state),
    });
    const receipt = await adapter.execute(baseInput());
    assert.equal(state.createCount, 1);
    assert.equal(receipt.prNumber, 2);
    assert.equal(state.pulls[1]?.user?.login, 'octocat');
  });

  it('rejects same-key replay when the remote title is missing', async () => {
    const marker = githubPrBodyMarker(tenantId, idempotencyKey, 'gh-test-token');
    const state: MockState = {
      pulls: [
        {
          number: 1,
          html_url: 'https://github.com/octo/repo/pull/1',
          state: 'open',
          body: `body\n\n${marker}`,
          head: { ref: 'feature', sha: 'a'.repeat(40), repo: { full_name: 'octo/repo' } },
          base: { ref: 'main', repo: { full_name: 'octo/repo' } },
          merged: false,
          merged_at: null,
          user: { login: 'octocat' },
        },
      ],
      createCount: 0,
      writeCount: 0,
    };
    const adapter = createGitHubPullRequestCreateAdapter({
      credentials: mockCredentials(),
      fetch: createMockFetch(state),
    });

    await assert.rejects(
      () => adapter.execute(baseInput()),
      (error: unknown) => {
        assert.ok(error instanceof AdapterExecutionError);
        assert.equal(error.code, 'GITHUB_IDEMPOTENCY_CONFLICT');
        assert.equal(error.commitState, 'UNKNOWN');
        assert.equal(error.retryMode, 'QUERY_FIRST');
        return true;
      },
    );
    assert.equal(state.createCount, 0);
  });

  it('queryOutcome lists by marker without write', async () => {
    const state: MockState = { pulls: [], createCount: 0, writeCount: 0 };
    const fetch = createMockFetch(state);
    const adapter = createGitHubPullRequestCreateAdapter({
      credentials: mockCredentials(),
      fetch,
    });
    await adapter.execute(baseInput());
    const writesBefore = state.writeCount;
    const outcome = await adapter.queryOutcome({
      tenantId,
      effectId: 'eff-1',
      idempotencyKey,
      destination,
      request: { args: baseInput().args },
    });
    assert.equal(state.writeCount, writesBefore);
    assert.equal(outcome.status, 'APPLIED');
    if (outcome.status === 'APPLIED') {
      assert.equal(outcome.response.prNumber, 1);
    }
  });

  it('compensate closes PR and queryCompensationOutcome observes closed state', async () => {
    const state: MockState = { pulls: [], createCount: 0, writeCount: 0 };
    const adapter = createGitHubPullRequestCreateAdapter({
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
      compensationPatch: {},
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(compensated.state, 'closed');
    const outcome = await adapter.queryCompensationOutcome({
      tenantId,
      effectId: 'eff-cmp-1',
      idempotencyKey: 'cmp:eff-1:1.0.0',
      destination,
      request: { forwardResponse: forward },
      compensationResponse: compensated,
    });
    assert.equal(outcome.status, 'APPLIED');
  });

  it('maps 401/403 to NOT_COMMITTED NEVER', async () => {
    const adapter = createGitHubPullRequestCreateAdapter({
      credentials: mockCredentials(),
      fetch: async () => new Response('forbidden', { status: 403 }),
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

  it('maps 429/5xx to UNKNOWN QUERY_FIRST', async () => {
    const adapter = createGitHubPullRequestCreateAdapter({
      credentials: mockCredentials(),
      fetch: async (_url, init) => {
        if (init?.method === 'POST') {
          return new Response('rate limited', { status: 429 });
        }
        return new Response('[]', { status: 200 });
      },
    });
    await assert.rejects(
      () => adapter.execute(baseInput()),
      (error: unknown) => {
        assert.ok(error instanceof AdapterExecutionError);
        assert.equal(error.commitState, 'UNKNOWN');
        assert.equal(error.retryMode, 'QUERY_FIRST');
        return true;
      },
    );
  });

  it('does not record a write when the create request is rejected (mock error injection)', async () => {
    const state: MockState = {
      pulls: [],
      createCount: 0,
      writeCount: 0,
      injectCreateStatus: 500,
    };
    const adapter = createGitHubPullRequestCreateAdapter({
      credentials: mockCredentials(),
      fetch: createMockFetch(state),
    });
    await assert.rejects(
      () => adapter.execute(baseInput()),
      (error: unknown) => {
        assert.ok(error instanceof AdapterExecutionError);
        assert.equal(error.commitState, 'UNKNOWN');
        assert.equal(error.retryMode, 'QUERY_FIRST');
        return true;
      },
    );
    // The injected failure must actually have been reached, and a failed create
    // must never be counted as a remote write.
    assert.equal(state.createCount, 0);
    assert.equal(state.writeCount, 0);
    assert.equal(state.pulls.length, 0);
  });

  it('queryOutcome returns UNKNOWN with MULTI_MARKER_MATCH when multiple PRs share marker', async () => {
    const marker = githubPrBodyMarker(tenantId, idempotencyKey, 'gh-test-token');
    const state: MockState = {
      pulls: [
        {
          number: 1,
          html_url: 'https://github.com/octo/repo/pull/1',
          state: 'open',
          body: marker,
          head: { ref: 'feature', sha: 'a'.repeat(40), repo: { full_name: 'octo/repo' } },
          base: { ref: 'main', repo: { full_name: 'octo/repo' } },
          merged: false,
          merged_at: null,
          user: { login: 'octocat' },
        },
        {
          number: 2,
          html_url: 'https://github.com/octo/repo/pull/2',
          state: 'open',
          body: marker,
          head: { ref: 'feature', sha: 'a'.repeat(40), repo: { full_name: 'octo/repo' } },
          base: { ref: 'main', repo: { full_name: 'octo/repo' } },
          merged: false,
          merged_at: null,
          user: { login: 'octocat' },
        },
      ],
      createCount: 0,
      writeCount: 0,
    };
    const adapter = createGitHubPullRequestCreateAdapter({
      credentials: mockCredentials(),
      fetch: createMockFetch(state),
    });
    const outcome = await adapter.queryOutcome({
      tenantId,
      effectId: 'eff-1',
      idempotencyKey,
      destination,
      request: { args: baseInput().args },
    });
    assert.equal(outcome.status, 'UNKNOWN');
  });

  it('rejects GitHub destinations outside manifest charset', async () => {
    const adapter = createGitHubPullRequestCreateAdapter({
      credentials: mockCredentials(),
      fetch: createMockFetch({ pulls: [], createCount: 0, writeCount: 0 }),
    });
    await assert.rejects(
      () =>
        adapter.execute({
          ...baseInput(),
          destination: 'github://octo/repo with space/pulls',
        }),
      /Invalid GitHub destination/,
    );
  });

  it('compensate refuses PR without Commander marker', async () => {
    const state: MockState = {
      pulls: [
        {
          number: 99,
          html_url: 'https://github.com/octo/repo/pull/99',
          state: 'open',
          body: 'unrelated human PR',
          user: { login: 'octocat' },
          head: { ref: 'feature', sha: 'a'.repeat(40), repo: { full_name: 'octo/repo' } },
          base: { ref: 'main', repo: { full_name: 'octo/repo' } },
          merged: false,
          merged_at: null,
        },
      ],
      createCount: 0,
      writeCount: 0,
    };
    const adapter = createGitHubPullRequestCreateAdapter({
      credentials: mockCredentials(),
      fetch: createMockFetch(state),
    });
    await assert.rejects(
      () =>
        adapter.compensate({
          tenantId,
          effectId: 'eff-cmp-1',
          originalEffectId: 'eff-1',
          idempotencyKey: 'cmp:eff-1:1.0.0',
          destination,
          forwardResponse: storedReceipt(99),
          compensationPatch: {},
          signal: AbortSignal.timeout(5_000),
        }),
      (error: unknown) => {
        assert.ok(error instanceof AdapterExecutionError);
        assert.equal(error.code, 'GITHUB_COMPENSATE_MARKER_MISMATCH');
        assert.equal(error.retryMode, 'NEVER');
        return true;
      },
    );
    assert.equal(state.pulls[0]!.state, 'open');
    assert.equal(state.writeCount, 0);
  });

  it('compensate enforces exact marker when forwardResponse carries idempotencyKey', async () => {
    const state: MockState = {
      pulls: [
        {
          number: 7,
          html_url: 'https://github.com/octo/repo/pull/7',
          state: 'open',
          body: githubPrBodyMarker(tenantId, 'other-key', 'gh-test-token'),
          user: { login: 'octocat' },
          head: { ref: 'feature', sha: 'a'.repeat(40), repo: { full_name: 'octo/repo' } },
          base: { ref: 'main', repo: { full_name: 'octo/repo' } },
          merged: false,
          merged_at: null,
        },
      ],
      createCount: 0,
      writeCount: 0,
    };
    const adapter = createGitHubPullRequestCreateAdapter({
      credentials: mockCredentials(),
      fetch: createMockFetch(state),
    });
    await assert.rejects(
      () =>
        adapter.compensate({
          tenantId,
          effectId: 'eff-cmp-1',
          originalEffectId: 'eff-1',
          idempotencyKey: 'cmp:eff-1:1.0.0',
          destination,
          forwardResponse: storedReceipt(7),
          compensationPatch: {},
          signal: AbortSignal.timeout(5_000),
        }),
      (error: unknown) => {
        assert.ok(error instanceof AdapterExecutionError);
        assert.equal(error.code, 'GITHUB_COMPENSATE_MARKER_MISMATCH');
        return true;
      },
    );
    assert.equal(state.pulls[0]!.state, 'open');
  });

  it('classifies empty and non-object 2xx create bodies instead of throwing untyped errors', async () => {
    for (const body of [
      new Response('{}', { status: 201 }),
      new Response('', { status: 201 }),
      new Response('null', { status: 201 }),
    ]) {
      const adapter = createGitHubPullRequestCreateAdapter({
        credentials: mockCredentials(),
        fetch: async (input, init) => {
          if (isGitHubActorRequest(input, init)) return githubActorResponse();
          return (init?.method ?? 'GET') === 'GET' && String(input).includes('/pulls?')
            ? new Response(JSON.stringify([]), { status: 200 })
            : body;
        },
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
});

/**
 * The broker installs its effect deadline by aborting a controller and forwards
 * that signal through the adapter. `findByMarker`'s pre-flight GET previously
 * dropped it, so a delayed lookup outlived the deadline and the broker could not
 * settle or park the effect until the request finished on its own.
 */
describe('github.pullRequestCreate adapter — cancellation propagation', () => {
  /** Records the exact signal handed to each fetch call, and hangs GETs. */
  function createSignalRecordingFetch(seen: Array<AbortSignal | undefined>) {
    return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      seen.push(init?.signal ?? undefined);
      if (isGitHubActorRequest(input, init)) return githubActorResponse();
      if (method === 'GET' && url.includes('/pulls?')) {
        const signal = init?.signal;
        // No signal => the request would hang forever; return promptly so a
        // regression shows up as a failed assertion, not a hung test.
        if (!signal) return new Response(JSON.stringify([]), { status: 200 });
        return new Promise<Response>((_resolve, reject) => {
          const abort = (): void => reject(signal.reason ?? new Error('aborted'));
          if (signal.aborted) {
            abort();
            return;
          }
          signal.addEventListener('abort', abort, { once: true });
        });
      }
      if (method === 'POST' && url.endsWith('/pulls')) {
        return new Response(
          JSON.stringify({
            number: 1,
            html_url: 'https://github.com/octo/repo/pull/1',
            state: 'open',
          }),
          { status: 201 },
        );
      }
      return new Response('unexpected', { status: 500 });
    };
  }

  it('the marker pre-flight GET carries the broker signal', async () => {
    const seen: Array<AbortSignal | undefined> = [];
    const adapter = createGitHubPullRequestCreateAdapter({
      credentials: mockCredentials(),
      fetch: createSignalRecordingFetch(seen),
    });

    const controller = new AbortController();
    const pending = adapter.execute({ ...baseInput(), signal: controller.signal });
    // Let the pre-flight GET reach fetch, then fire the effect deadline.
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort(new Error('effect deadline'));

    await assert.rejects(pending, 'the aborted pre-flight must settle the effect');
    assert.ok(seen.length > 0, 'the pre-flight GET must reach fetch');
    assert.equal(seen[0]?.aborted, true);
    assert.equal(seen[0]?.reason, controller.signal.reason);
  });

  it('queryOutcome settles UNKNOWN when the caller cancels', async () => {
    const seen: Array<AbortSignal | undefined> = [];
    const adapter = createGitHubPullRequestCreateAdapter({
      credentials: mockCredentials(),
      fetch: createSignalRecordingFetch(seen),
    });

    const controller = new AbortController();
    const pending = adapter.queryOutcome({
      tenantId,
      effectId: 'eff-1',
      idempotencyKey,
      destination,
      request: { args: baseInput().args },
      signal: controller.signal,
    });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort(new Error('reconcile deadline'));

    const outcome = await pending;
    assert.equal(outcome.status, 'UNKNOWN');
    assert.equal(outcome.error?.code, 'GITHUB_QUERY_ABORTED');
    assert.ok(seen.length > 0, 'the query must reach fetch');
    assert.equal(seen[0]?.aborted, true);
    assert.equal(seen[0]?.reason, controller.signal.reason);
  });

  it('does not open a PR when the pre-flight is cancelled', async () => {
    const seen: Array<AbortSignal | undefined> = [];
    const adapter = createGitHubPullRequestCreateAdapter({
      credentials: mockCredentials(),
      fetch: createSignalRecordingFetch(seen),
    });

    const controller = new AbortController();
    const pending = adapter.execute({ ...baseInput(), signal: controller.signal });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort(new Error('effect deadline'));
    await assert.rejects(pending);

    assert.equal(
      seen.some((s) => s === undefined),
      false,
      'no fetch call may run without the caller’s signal',
    );
  });
});

describe('github compensation reconciliation via the registry', () => {
  it('reads the governed forwardResponse so compensation can converge', async () => {
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (isGitHubActorRequest(input, init)) return githubActorResponse();
      if ((init?.method ?? 'GET') === 'GET' && /\/pulls\/42$/.test(String(input))) {
        return new Response(
          JSON.stringify({
            number: 42,
            html_url: 'https://github.com/octo/repo/pull/42',
            state: 'closed',
            body: githubPrBodyMarker(tenantId, idempotencyKey, 'gh-test-token'),
            head: { ref: 'feature', sha: 'a'.repeat(40), repo: { full_name: 'octo/repo' } },
            base: { ref: 'main', repo: { full_name: 'octo/repo' } },
            merged: false,
            merged_at: null,
            user: { login: 'octocat' },
          }),
          { status: 200 },
        );
      }
      return new Response('unexpected', { status: 500 });
    };
    const adapter = createGitHubPullRequestCreateAdapter({
      credentials: mockCredentials(),
      fetch: fetchImpl,
    });
    const registry = new ActionAdapterRegistry([adapter]);
    const querier = registry.outcomeQuerierFor('compensate.github.pull-request.create');
    assert.ok(querier);
    const outcome = await querier.queryOutcome({
      effectId: 'eff-cmp-1',
      idempotencyKey: 'cmp:eff-1:1.0.0',
      type: 'compensate.github.pull-request.create',
      tenantId,
      request: {
        originalEffectId: 'eff-1',
        destination,
        // The kernel constructs exactly this shape for governed compensations.
        forwardResponse: storedReceipt(42),
        compensationPatch: {},
      },
    });
    assert.equal(outcome.status, 'APPLIED');
    assert.equal(outcome.response?.prNumber, 42);
  });
});

describe('github.pullRequestCreate adapter — launch contract boundaries', () => {
  function pull(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      number: 1,
      html_url: 'https://github.com/octo/repo/pull/1',
      state: 'open',
      title: 'Approved title',
      body: `Approved body\n\n${githubPrBodyMarker(tenantId, idempotencyKey, 'gh-test-token')}`,
      head: { ref: 'approved-branch', sha: 'a'.repeat(40), repo: { full_name: 'octo/repo' } },
      base: { ref: 'main', repo: { full_name: 'octo/repo' } },
      merged: false,
      merged_at: null,
      user: { login: 'octocat' },
      ...overrides,
    };
  }

  function receipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      prNumber: 1,
      url: 'https://github.com/octo/repo/pull/1',
      state: 'open',
      idempotencyKey,
      destination,
      head: 'approved-branch',
      base: 'main',
      headSha: 'a'.repeat(40),
      ...overrides,
    };
  }

  const args = {
    title: 'Approved title',
    body: 'Approved body',
    head: 'approved-branch',
    base: 'main',
  };
  function queryInput() {
    return { tenantId, effectId: 'eff-1', idempotencyKey, destination, request: { args } };
  }
  function compensationInput() {
    return {
      tenantId,
      effectId: 'cmp-1',
      originalEffectId: 'eff-1',
      idempotencyKey: 'cmp:eff-1:1.1.0',
      destination,
      forwardResponse: receipt(),
      compensationPatch: {},
      signal: AbortSignal.timeout(5_000),
    };
  }

  it('execute and recovery return the same complete receipt', async () => {
    const adapter = createGitHubPullRequestCreateAdapter({
      credentials: mockCredentials(),
      fetch: listFetch([{ pulls: [pull()] }]),
    });
    const executed = await adapter.execute({ ...baseInput(), args });
    const outcome = await adapter.queryOutcome(queryInput());
    assert.deepEqual(executed, receipt());
    assert.equal(outcome.status, 'APPLIED');
    assert.deepEqual(outcome.response, executed);
  });

  for (const invalidArgs of [
    {},
    { ...args, head: undefined },
    { ...args, base: undefined },
    { ...args, body: null },
    { ...args, title: '' },
    { ...args, head: 'fork:branch' },
    { ...args, head: 'main' },
    { ...args, body: githubPrBodyMarker(tenantId, 'injected', 'gh-test-token') },
  ]) {
    it(`refuses invalid create args before any I/O: ${JSON.stringify(invalidArgs)}`, async () => {
      let requests = 0;
      const adapter = createGitHubPullRequestCreateAdapter({
        credentials: mockCredentials(),
        fetch: listFetch([{ pulls: [] }], () => {
          requests += 1;
        }),
      });
      await assert.rejects(
        () => adapter.execute({ ...baseInput(), args: invalidArgs }),
        (error: unknown) =>
          error instanceof AdapterExecutionError && error.code === 'GITHUB_CREATE_ARGS_INVALID',
      );
      assert.equal(requests, 0);
    });
  }

  it('missing request.args is UNKNOWN without querying or falling back to top-level fields', async () => {
    let requests = 0;
    const adapter = createGitHubPullRequestCreateAdapter({
      credentials: mockCredentials(),
      fetch: listFetch([{ pulls: [pull()] }], () => {
        requests += 1;
      }),
    });
    const outcome = await adapter.queryOutcome({ ...queryInput(), request: args });
    assert.equal(outcome.status, 'UNKNOWN');
    assert.equal(outcome.error?.code, 'GITHUB_CREATE_ARGS_INVALID');
    assert.equal(requests, 0);
  });

  for (const changed of [
    { head: { ref: 'approved-branch', sha: 'a'.repeat(40), repo: { full_name: 'fork/repo' } } },
    { head: { ref: 'approved-branch', sha: 'not-a-commit', repo: { full_name: 'octo/repo' } } },
    { html_url: 'https://evil.example/pr/1' },
    { number: -1 },
    { body: null },
  ]) {
    it(`does not reconcile an invalid or foreign remote PR: ${JSON.stringify(changed)}`, async () => {
      const adapter = createGitHubPullRequestCreateAdapter({
        credentials: mockCredentials(),
        fetch: listFetch([{ pulls: [pull(changed)] }]),
      });
      const outcome = await adapter.queryOutcome(queryInput());
      assert.equal(outcome.status, 'UNKNOWN');
    });
  }

  it('refuses to close a merged PR even with a valid receipt', async () => {
    let writes = 0;
    const adapter = createGitHubPullRequestCreateAdapter({
      credentials: mockCredentials(),
      fetch: async (input, init) => {
        if (isGitHubActorRequest(input, init)) return githubActorResponse();
        if (init?.method === 'PATCH') writes += 1;
        return new Response(
          JSON.stringify(
            pull({ state: 'closed', merged: true, merged_at: '2026-09-23T00:00:00Z' }),
          ),
          { status: 200 },
        );
      },
    });
    await assert.rejects(
      () => adapter.compensate(compensationInput()),
      (error: unknown) =>
        error instanceof AdapterExecutionError && error.code === 'GITHUB_COMPENSATE_MERGED',
    );
    assert.equal(writes, 0);
  });

  it('releases the PATCH response body before verifying the closed PR', async () => {
    let patched = false;
    let released = false;
    const adapter = createGitHubPullRequestCreateAdapter({
      credentials: mockCredentials(),
      fetch: async (input, init) => {
        if (isGitHubActorRequest(input, init)) return githubActorResponse();
        if (init?.method === 'PATCH') {
          patched = true;
          return new Response(
            new ReadableStream({
              cancel() {
                released = true;
              },
            }),
            { status: 200 },
          );
        }
        if (patched) assert.equal(released, true, 'PATCH must release its connection before GET');
        return Response.json(pull({ state: patched ? 'closed' : 'open' }));
      },
    });
    const result = await adapter.compensate(compensationInput());
    assert.equal(result.state, 'closed');
    assert.equal(released, true);
  });

  it('rechecks after PATCH and refuses success if the PR was concurrently merged', async () => {
    const methods: string[] = [];
    const adapter = createGitHubPullRequestCreateAdapter({
      credentials: mockCredentials(),
      fetch: async (input, init) => {
        if (isGitHubActorRequest(input, init)) return githubActorResponse();
        methods.push(init?.method ?? 'GET');
        return new Response(
          JSON.stringify(
            methods.length === 1
              ? pull()
              : pull({ state: 'closed', merged: true, merged_at: '2026-09-23T00:00:00Z' }),
          ),
          { status: 200 },
        );
      },
    });
    await assert.rejects(
      () => adapter.compensate(compensationInput()),
      (error: unknown) => error instanceof AdapterExecutionError && error.commitState === 'UNKNOWN',
    );
    assert.deepEqual(methods, ['GET', 'PATCH', 'GET']);
  });

  for (const status of [403, 404, 429, 500]) {
    it(`query preserves UNKNOWN on HTTP ${status}`, async () => {
      const adapter = createGitHubPullRequestCreateAdapter({
        credentials: mockCredentials(),
        fetch: async () => new Response('unavailable', { status }),
      });
      const outcome = await adapter.queryOutcome(queryInput());
      assert.equal(outcome.status, 'UNKNOWN');
    });
  }

  it('bounds execute and recovery to the approved branches and preserves filters across pages', async () => {
    const urls: URL[] = [];
    const adapter = createGitHubPullRequestCreateAdapter({
      credentials: mockCredentials(),
      fetch: async (input, init) => {
        if (isGitHubActorRequest(input, init)) return githubActorResponse();
        const url = new URL(String(input));
        urls.push(url);
        assert.equal(url.searchParams.get('head'), 'octo:approved-branch');
        assert.equal(url.searchParams.get('base'), 'main');
        assert.equal(url.searchParams.get('state'), 'all');
        return url.searchParams.has('page')
          ? new Response(JSON.stringify([pull()]), { status: 200 })
          : new Response('[]', {
              status: 200,
              headers: {
                Link: '<https://api.github.com/repos/octo/repo/pulls?page=2&head=octo%3Aapproved-branch&base=main&state=all&per_page=100>; rel="next"',
              },
            });
      },
    });
    assert.deepEqual(await adapter.execute({ ...baseInput(), args }), receipt());
    assert.equal((await adapter.queryOutcome(queryInput())).status, 'APPLIED');
    assert.equal(urls.length, 4);
  });

  it('refuses a next link that changes an approved branch', async () => {
    let calls = 0;
    const adapter = createGitHubPullRequestCreateAdapter({
      credentials: mockCredentials(),
      fetch: listFetch(
        [
          {
            pulls: [pull()],
            link: '<https://api.github.com/repos/octo/repo/pulls?page=2&head=octo%3Aother>; rel="next"',
          },
        ],
        () => {
          calls += 1;
        },
      ),
    });
    const outcome = await adapter.queryOutcome(queryInput());
    assert.equal(outcome.status, 'UNKNOWN');
    assert.equal(outcome.error?.code, 'GITHUB_PAGINATION_INVALID');
    assert.equal(calls, 1);
  });

  it('accepts an unquoted rel=next link and checks the following page', async () => {
    let calls = 0;
    const adapter = createGitHubPullRequestCreateAdapter({
      credentials: mockCredentials(),
      fetch: listFetch(
        [
          {
            pulls: [pull()],
            link: '<https://api.github.com/repos/octo/repo/pulls?page=2>; rel=next',
          },
          { pulls: [pull({ number: 2, html_url: 'https://github.com/octo/repo/pull/2' })] },
        ],
        () => {
          calls += 1;
        },
      ),
    });
    assert.equal((await adapter.queryOutcome(queryInput())).status, 'UNKNOWN');
    assert.equal(calls, 2);
  });

  for (const link of [
    '<https://api.github.com/repos/octo/repo/pulls?page=2>; rel="next',
    'garbage',
    '<https://evil.example/pulls?page=2>; rel=next',
  ]) {
    it(`refuses incomplete pagination with malformed or unsafe Link: ${link}`, async () => {
      const adapter = createGitHubPullRequestCreateAdapter({
        credentials: mockCredentials(),
        fetch: listFetch([{ pulls: [pull()], link }]),
      });
      const outcome = await adapter.queryOutcome(queryInput());
      assert.equal(outcome.status, 'UNKNOWN');
      assert.equal(outcome.error?.code, 'GITHUB_PAGINATION_INVALID');
    });
  }

  for (const changes of [
    { merged: undefined, merged_at: undefined },
    { head: { ref: 'other-branch', sha: 'a'.repeat(40), repo: { full_name: 'octo/repo' } } },
    { number: 2, html_url: 'https://github.com/octo/repo/pull/2' },
    { body: githubPrBodyMarker(tenantId, 'other-key', 'gh-test-token') },
  ]) {
    it(`compensation never closes or confirms an unproven receipt: ${JSON.stringify(changes)}`, async () => {
      let writes = 0;
      const adapter = createGitHubPullRequestCreateAdapter({
        credentials: mockCredentials(),
        fetch: async (_url, init) => {
          if (init?.method === 'PATCH') writes += 1;
          return new Response(JSON.stringify(pull({ state: 'closed', ...changes })), {
            status: 200,
          });
        },
      });
      await assert.rejects(
        () => adapter.compensate(compensationInput()),
        (error: unknown) => error instanceof AdapterExecutionError,
      );
      const outcome = await adapter.queryCompensationOutcome({
        ...queryInput(),
        request: { forwardResponse: receipt() },
      });
      assert.equal(outcome.status, 'UNKNOWN');
      assert.equal(writes, 0);
    });
  }

  it('accepts an empty approved body with only the server-generated marker', async () => {
    const adapter = createGitHubPullRequestCreateAdapter({
      credentials: mockCredentials(),
      fetch: listFetch([
        { pulls: [pull({ body: githubPrBodyMarker(tenantId, idempotencyKey, 'gh-test-token') })] },
      ]),
    });
    const outcome = await adapter.queryOutcome({
      ...queryInput(),
      request: { args: { ...args, body: '' } },
    });
    assert.equal(outcome.status, 'APPLIED');
  });

  it('does not create after an incomplete or malicious preflight', async () => {
    let writes = 0;
    const adapter = createGitHubPullRequestCreateAdapter({
      credentials: mockCredentials(),
      fetch: listFetch(
        [{ pulls: [], link: '<https://evil.example/pulls?page=2>; rel="next"' }],
        (_url, init) => {
          if (init?.method === 'POST') writes += 1;
        },
      ),
    });
    await assert.rejects(
      () => adapter.execute({ ...baseInput(), args }),
      (error: unknown) =>
        error instanceof AdapterExecutionError && error.code === 'GITHUB_PAGINATION_INVALID',
    );
    assert.equal(writes, 0);
  });

  it('cyclic pagination is UNKNOWN and bounded', async () => {
    let calls = 0;
    const adapter = createGitHubPullRequestCreateAdapter({
      credentials: mockCredentials(),
      fetch: listFetch(
        [
          {
            pulls: [pull()],
            link: '<https://api.github.com/repos/octo/repo/pulls?page=2>; rel="next"',
          },
        ],
        () => {
          calls += 1;
        },
      ),
    });
    const outcome = await adapter.queryOutcome(queryInput());
    assert.equal(outcome.status, 'UNKNOWN');
    assert.equal(outcome.error?.code, 'GITHUB_PAGINATION_INVALID');
    assert.equal(calls, 2);
  });

  it('stops after ten pages without claiming a partial match', async () => {
    let calls = 0;
    const adapter = createGitHubPullRequestCreateAdapter({
      credentials: mockCredentials(),
      fetch: async (input, init) => {
        if (isGitHubActorRequest(input, init)) return githubActorResponse();
        calls += 1;
        return new Response(JSON.stringify(calls === 1 ? [pull()] : []), {
          status: 200,
          headers: {
            Link: `<https://api.github.com/repos/octo/repo/pulls?page=${calls + 1}>; rel="next"`,
          },
        });
      },
    });
    const outcome = await adapter.queryOutcome(queryInput());
    assert.equal(outcome.status, 'UNKNOWN');
    assert.equal(outcome.error?.code, 'GITHUB_PAGINATION_LIMIT');
    assert.equal(calls, 10);
  });

  it('aborting a page prevents the next page and POST even when fetch ignores cancellation', async () => {
    const controller = new AbortController();
    let calls = 0;
    const adapter = createGitHubPullRequestCreateAdapter({
      credentials: mockCredentials(),
      fetch: async () => {
        calls += 1;
        controller.abort();
        return new Response('[]', {
          status: 200,
          headers: { Link: '<https://api.github.com/repos/octo/repo/pulls?page=2>; rel="next"' },
        });
      },
    });
    await assert.rejects(() =>
      adapter.execute({ ...baseInput(), args, signal: controller.signal }),
    );
    assert.equal(calls, 1);
  });

  function listFetch(
    pages: Array<{ pulls: unknown[]; link?: string }>,
    onRequest?: (url: string, init?: RequestInit) => void,
  ): FetchFn {
    let page = 0;
    return async (input, init) => {
      const url = String(input);
      if (isGitHubActorRequest(input, init)) return githubActorResponse();
      onRequest?.(url, init);
      if ((init?.method ?? 'GET') === 'GET' && url.includes('/pulls?')) {
        const current = pages[Math.min(page++, pages.length - 1)]!;
        return new Response(JSON.stringify(current.pulls), {
          status: 200,
          headers: current.link ? { Link: current.link } : {},
        });
      }
      if (init?.method === 'GET' && /\/pulls\/\d+$/.test(url)) {
        return new Response(JSON.stringify(pull({ state: 'closed' })), { status: 200 });
      }
      if (init?.method === 'PATCH')
        return new Response(JSON.stringify(pull({ state: 'closed' })), { status: 200 });
      return new Response('unexpected', { status: 500 });
    };
  }

  it('registry query uses request.args and rejects a different branch', async () => {
    const adapter = createGitHubPullRequestCreateAdapter({
      credentials: mockCredentials(),
      fetch: listFetch([{ pulls: [pull()] }]),
    });
    const registry = new ActionAdapterRegistry([adapter]);
    const querier = registry.outcomeQuerierFor(adapter.descriptor.effectType);
    assert.ok(querier);
    const outcome = await querier.queryOutcome({
      tenantId,
      effectId: 'eff-1',
      idempotencyKey,
      type: adapter.descriptor.effectType,
      request: {
        destination,
        args: {
          title: 'Approved title',
          body: 'Approved body',
          head: 'other-branch',
          base: 'main',
        },
      },
    });
    assert.equal(outcome.status, 'UNKNOWN');
  });

  it('query rejects a marker match whose title or body changed', async () => {
    const adapter = createGitHubPullRequestCreateAdapter({
      credentials: mockCredentials(),
      fetch: listFetch([{ pulls: [pull()] }]),
    });
    const outcome = await adapter.queryOutcome({
      tenantId,
      effectId: 'eff-1',
      idempotencyKey,
      destination,
      request: {
        args: {
          title: 'Changed title',
          body: 'Changed body',
          head: 'approved-branch',
          base: 'main',
        },
      },
    });
    assert.equal(outcome.status, 'UNKNOWN');
  });

  it('compensation without the original idempotency key refuses before PATCH', async () => {
    let writes = 0;
    const adapter = createGitHubPullRequestCreateAdapter({
      credentials: mockCredentials(),
      fetch: async (input, init) => {
        if (isGitHubActorRequest(input, init)) return githubActorResponse();
        if (init?.method === 'PATCH') {
          writes += 1;
          return new Response(JSON.stringify(pull({ state: 'closed' })), { status: 200 });
        }
        if ((init?.method ?? 'GET') === 'GET' && /\/pulls\/1$/.test(String(input))) {
          return new Response(JSON.stringify(pull()), { status: 200 });
        }
        return new Response('unexpected', { status: 500 });
      },
    });
    await assert.rejects(
      () =>
        adapter.compensate({
          tenantId,
          effectId: 'cmp-1',
          originalEffectId: 'eff-1',
          idempotencyKey: 'cmp:eff-1:1.1.0',
          destination,
          forwardResponse: { prNumber: 1 },
          compensationPatch: {},
          signal: AbortSignal.timeout(5_000),
        }),
      (error: unknown) => {
        assert.ok(error instanceof AdapterExecutionError);
        assert.equal(error.code, 'GITHUB_COMPENSATE_MISSING_ORIGINAL_KEY');
        return true;
      },
    );
    assert.equal(writes, 0);
  });

  it('merged PR is never reported as compensated', async () => {
    const adapter = createGitHubPullRequestCreateAdapter({
      credentials: mockCredentials(),
      fetch: async (input, init) => {
        if (isGitHubActorRequest(input, init)) return githubActorResponse();
        return new Response(
          JSON.stringify(
            pull({ state: 'closed', merged: true, merged_at: '2026-09-23T00:00:00Z' }),
          ),
          { status: 200 },
        );
      },
    });
    const outcome = await adapter.queryCompensationOutcome({
      tenantId,
      effectId: 'cmp-1',
      idempotencyKey: 'cmp:eff-1:1.1.0',
      destination,
      request: { forwardResponse: receipt() },
    });
    assert.equal(outcome.status, 'UNKNOWN');
  });

  it('follows a same-repository next link and finds a unique second-page match', async () => {
    let listCalls = 0;
    const adapter = createGitHubPullRequestCreateAdapter({
      credentials: mockCredentials(),
      fetch: listFetch(
        [
          { pulls: [], link: '<https://api.github.com/repos/octo/repo/pulls?page=2>; rel="next"' },
          { pulls: [pull()] },
        ],
        (url) => {
          if (url.includes('/pulls?')) listCalls += 1;
        },
      ),
    });
    const outcome = await adapter.queryOutcome({
      tenantId,
      effectId: 'eff-1',
      idempotencyKey,
      destination,
      request: {
        args: {
          title: 'Approved title',
          body: 'Approved body',
          head: 'approved-branch',
          base: 'main',
        },
      },
    });
    assert.equal(listCalls, 2);
    assert.equal(outcome.status, 'APPLIED');
  });

  it('returns UNKNOWN when pagination finds a second matching PR', async () => {
    const adapter = createGitHubPullRequestCreateAdapter({
      credentials: mockCredentials(),
      fetch: listFetch([
        {
          pulls: [pull()],
          link: '<https://api.github.com/repos/octo/repo/pulls?page=2>; rel="next"',
        },
        { pulls: [pull({ number: 2, html_url: 'https://github.com/octo/repo/pull/2' })] },
      ]),
    });
    const outcome = await adapter.queryOutcome({
      tenantId,
      effectId: 'eff-1',
      idempotencyKey,
      destination,
      request: {
        args: {
          title: 'Approved title',
          body: 'Approved body',
          head: 'approved-branch',
          base: 'main',
        },
      },
    });
    assert.equal(outcome.status, 'UNKNOWN');
  });

  it('rejects a cross-repository next link without fetching it', async () => {
    let requests = 0;
    const adapter = createGitHubPullRequestCreateAdapter({
      credentials: mockCredentials(),
      fetch: listFetch(
        [
          {
            pulls: [pull()],
            link: '<https://api.github.com/repos/other/repo/pulls?page=2>; rel="next"',
          },
        ],
        () => {
          requests += 1;
        },
      ),
    });
    const outcome = await adapter.queryOutcome({
      tenantId,
      effectId: 'eff-1',
      idempotencyKey,
      destination,
      request: {
        args: {
          title: 'Approved title',
          body: 'Approved body',
          head: 'approved-branch',
          base: 'main',
        },
      },
    });
    assert.equal(outcome.status, 'UNKNOWN');
    assert.equal(requests, 1);
  });
});

describe('GitHub adapter real HTTP deadline', () => {
  it(
    'aborts a stalled response body without a caller signal within the internal deadline',
    { timeout: 15_000 },
    async (t) => {
      let remoteClosed = false;
      let calls = 0;
      let closeObserved: () => void = () => {
        throw new Error('close observer not installed');
      };
      const closed = new Promise<void>((resolve) => {
        closeObserved = resolve;
      });
      const server = createServer((_request, response) => {
        calls += 1;
        response.on('close', () => {
          remoteClosed = true;
          closeObserved();
        });
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.write('[');
        // Intentionally never finish the body: reading it must share the same budget.
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      t.after(() => {
        server.closeAllConnections();
        server.close();
      });
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      let observedSignal: AbortSignal | null | undefined;
      const adapter = createGitHubPullRequestCreateAdapter({
        credentials: mockCredentials(),
        fetch: async (_url, init) => {
          observedSignal = init?.signal;
          return fetch(`http://127.0.0.1:${address.port}/pulls`, init);
        },
      });
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const pending = adapter.queryOutcome({
        tenantId,
        effectId: 'deadline',
        idempotencyKey,
        destination,
        request: { args: baseInput().args },
      });
      try {
        const outcome = await Promise.race([
          pending,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(
              () => reject(new Error('Adapter did not cancel its stalled HTTP body')),
              12_000,
            );
          }),
        ]);
        assert.equal(outcome.status, 'UNKNOWN');
        assert.equal(outcome.error?.code, 'GITHUB_QUERY_ABORTED');
        assert.equal(observedSignal?.aborted, true);
        await closed;
        assert.equal(remoteClosed, true);
        assert.equal(calls, 1);
      } finally {
        clearTimeout(timeout);
        server.closeAllConnections();
        await pending;
      }
    },
  );
});
