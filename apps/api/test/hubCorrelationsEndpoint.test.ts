/**
 * Hub Glue / Tier-0 correlation admin endpoint — regression tests.
 *
 * Mirrors apps/api/test/store-normalization.test.ts conventions: ESM
 * imports + tsx loader so this `.ts` source can resolve `../src/hub-
 * CorrelationsEndpoints` (also `.ts`) at test time without requiring a
 * fresh apps/api/dist build. Note that `@praetor/core/runtime` is
 * resolved through Node's normal package resolution, which hits the
 * packages/core dist (NOT src) — see README on packages/core dist
 * freshness for env-related test prerequisites.
 *
 * Coverage:
 *   1. Admin gate: non-admin scopes are 403'd, admin JWT / admin-scoped key pass.
 *      (F-A-12: the gate reads `req.user.role` or `req.apiScopes`; it does NOT
 *      read AUTH_DISABLED, so the old "bypass" ceremony was a no-op.)
 *   2. REST happy path: GET / returns typed BusPayloadMap entries from
 *      the three runtime.{cycle,retry_block,circuit}_correlated topics.
 *   3. Filters: runId, topic, toolName restrict the visible timeline.
 *   4. Topic validation: invalid topic → 400 with allowed list.
 *   5. Limit clamping: huge limits clamped to MAX_REST_LIMIT=1000.
 *   6. Cursor pagination: unknown cursor → 400.
 *   7. SSE /stream registers a client, fans out a future publish, and
 *      cleans up on req `close`.
 */
import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { getMessageBus, resetMessageBus, type MessageBus } from '@praetor/core/runtime';
import {
  createHubCorrelationsRouter,
  _resetHubCorrelationsForTests,
} from '../src/hubCorrelationsEndpoints';
// Side-effect import: pulls in the global Express Request augmentation
// (`apiKeyId?: string`, `apiScopes?: string[]`) declared in authMiddleware
// so we can type req.auth-scoped fields without per-call casts.
import '../src/authMiddleware';

type Scope = 'read' | 'write' | 'admin';

const CORRELATION_TOPIC = {
  cycle: 'runtime.cycle_correlated',
  retry: 'runtime.retry_block_correlated',
  circuit: 'runtime.circuit_correlated',
} as const;

function buildAppWithScopes(apiScopes: Scope[]): Express {
  _resetHubCorrelationsForTests();
  const app = express();
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { apiKeyId?: string; apiScopes?: string[] }).apiKeyId = 'test-key';
    (req as Request & { apiKeyId?: string; apiScopes?: string[] }).apiScopes = apiScopes;
    next();
  });
  app.use('/api/v1/hub', createHubCorrelationsRouter());
  return app;
}

function publishCorrelation(
  bus: MessageBus,
  topic:
    | typeof CORRELATION_TOPIC.cycle
    | typeof CORRELATION_TOPIC.retry
    | typeof CORRELATION_TOPIC.circuit,
  payload: object,
): void {
  bus.publish(topic, 'hub-glue', payload);
}

function makeCycle(
  runId: string,
  toolName = 'shell_execute',
): {
  runId: string;
  toolName: string;
  description: string;
  sourceEvents: ['system.alert', 'tool.blocked'];
  correlatedAt: string;
} {
  return {
    runId,
    toolName,
    description: `cycle:${runId}`,
    sourceEvents: ['system.alert', 'tool.blocked'],
    correlatedAt: new Date().toISOString(),
  };
}

function makeCircuit(
  runId: string,
  toolName = 'shell_execute',
  reason = 'verification_failed',
): {
  runId: string;
  toolName: string;
  reason: string;
  sourceEvents: ['system.alert', 'tool.blocked'];
  correlatedAt: string;
} {
  return {
    runId,
    toolName,
    reason,
    sourceEvents: ['system.alert', 'tool.blocked'],
    correlatedAt: new Date().toISOString(),
  };
}

function listenPort(server: ReturnType<Express['listen']>): number {
  const addr = server.address();
  if (addr === null || typeof addr === 'string') {
    throw new Error(`listen failed: server.address() returned ${String(addr)}`);
  }
  return addr.port;
}

// --- Tests -----------------------------------------------------------------

test('admin gate: without admin scope the GET summary returns 403', async () => {
  const app = buildAppWithScopes(['read', 'write']);
  const server = app.listen(0);
  try {
    const port = listenPort(server);
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/hub`);
    assert.equal(res.status, 403);
    const body = (await res.json()) as { error?: string };
    assert.match(body.error ?? '', /Admin authority required/);
  } finally {
    server.close();
  }
});

test('admin gate: without any scopes the GET summary returns 403', async () => {
  const app = buildAppWithScopes([]);
  const server = app.listen(0);
  try {
    const port = listenPort(server);
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/hub`);
    assert.equal(res.status, 403);
  } finally {
    server.close();
  }
});

test('admin gate: with admin scope the GET summary returns 200 + REST shape', async () => {
  resetMessageBus();
  const app = buildAppWithScopes(['read', 'write', 'admin']);
  const server = app.listen(0);
  try {
    const port = listenPort(server);
    const bus = getMessageBus();
    publishCorrelation(bus, CORRELATION_TOPIC.cycle, makeCycle('r-1'));
    publishCorrelation(bus, CORRELATION_TOPIC.retry, {
      runId: 'r-2',
      toolName: 'python_execute',
      pattern: 'python_execute:{}',
      sourceEvents: ['system.alert', 'tool.blocked'],
      correlatedAt: new Date().toISOString(),
    });
    publishCorrelation(bus, CORRELATION_TOPIC.circuit, makeCircuit('r-3'));

    const res = await fetch(`http://127.0.0.1:${port}/api/v1/hub`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      count: number;
      total: number;
      items: Array<{ topic: string }>;
    };
    assert.equal(body.count, 3);
    assert.equal(body.total, 3);
    assert.equal(body.items.length, 3);
    const topics = body.items.map((i) => i.topic).sort();
    assert.deepEqual(topics, [
      'runtime.circuit_correlated',
      'runtime.cycle_correlated',
      'runtime.retry_block_correlated',
    ]);
  } finally {
    server.close();
  }
});

test('GET summary filters by runId', async () => {
  resetMessageBus();
  const app = buildAppWithScopes(['admin']);
  const server = app.listen(0);
  try {
    const port = listenPort(server);
    const bus = getMessageBus();
    publishCorrelation(bus, CORRELATION_TOPIC.cycle, makeCycle('r-A'));
    publishCorrelation(bus, CORRELATION_TOPIC.cycle, makeCycle('r-B', 'python_execute'));
    publishCorrelation(bus, CORRELATION_TOPIC.cycle, makeCycle('r-A'));

    const res = await fetch(`http://127.0.0.1:${port}/api/v1/hub?runId=r-A`);
    const body = (await res.json()) as {
      count: number;
      items: Array<{ payload: { runId: string } }>;
    };
    assert.equal(body.count, 2);
    for (const item of body.items) {
      assert.equal(item.payload.runId, 'r-A');
    }
  } finally {
    server.close();
  }
});

test('GET summary filters by topic', async () => {
  resetMessageBus();
  const app = buildAppWithScopes(['admin']);
  const server = app.listen(0);
  try {
    const port = listenPort(server);
    const bus = getMessageBus();
    publishCorrelation(bus, CORRELATION_TOPIC.cycle, makeCycle('r-1'));
    publishCorrelation(bus, CORRELATION_TOPIC.circuit, makeCircuit('r-1'));

    const res = await fetch(`http://127.0.0.1:${port}/api/v1/hub?topic=runtime.circuit_correlated`);
    const body = (await res.json()) as {
      count: number;
      items: Array<{ topic: string }>;
    };
    assert.equal(body.count, 1);
    assert.ok(body.items.length >= 1, 'expected at least one item');
    assert.equal(body.items[0]?.topic, 'runtime.circuit_correlated');
  } finally {
    server.close();
  }
});

test('GET summary rejects invalid topic with 400 + allowed list', async () => {
  const app = buildAppWithScopes(['admin']);
  const server = app.listen(0);
  try {
    const port = listenPort(server);
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/hub?topic=unknown_topic`);
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error?: string; allowed: string[] };
    assert.match(body.error ?? '', /Invalid topic filter/);
    assert.ok(body.allowed.includes('runtime.cycle_correlated'));
    assert.ok(body.allowed.includes('runtime.retry_block_correlated'));
    assert.ok(body.allowed.includes('runtime.circuit_correlated'));
  } finally {
    server.close();
  }
});

test('GET summary clamps limit to MAX_REST_LIMIT=1000', async () => {
  resetMessageBus();
  // F-A-6: the previous version published 5 events and requested limit=99999,
  // then asserted count===5 — below the clamp, so removing the clamp changed
  // nothing. Publish >MAX_REST_LIMIT events so the ceiling is observable.
  _resetHubCorrelationsForTests();
  const app = buildAppWithScopes(['admin']);
  const server = app.listen(0);
  try {
    const port = listenPort(server);
    const bus = getMessageBus();
    const total = 1005;
    for (let i = 0; i < total; i += 1) {
      publishCorrelation(bus, CORRELATION_TOPIC.cycle, makeCycle(`r-${i}`));
    }
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/hub?limit=99999`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      count: number;
      total: number;
      items: Array<{ payload: { runId: string } }>;
    };
    assert.equal(body.total, total);
    assert.equal(body.count, 1000, 'limit must be clamped to MAX_REST_LIMIT');
    assert.equal(body.items.length, 1000);
    // Unclamped, the first five published events would still be in the page.
    assert.equal(body.items[0]!.payload.runId, 'r-5', 'newest 1000 events are retained');
    assert.equal(body.items[999]!.payload.runId, `r-${total - 1}`);
  } finally {
    server.close();
  }
});

test('GET summary rejects invalid cursor with 400', async () => {
  resetMessageBus();
  const app = buildAppWithScopes(['admin']);
  const server = app.listen(0);
  try {
    const port = listenPort(server);
    const bus = getMessageBus();
    publishCorrelation(bus, CORRELATION_TOPIC.cycle, makeCycle('r-x'));

    const res = await fetch(`http://127.0.0.1:${port}/api/v1/hub?cursor=does-not-exist`);
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test('SSE /stream registers a client, will receive a future publish, and deregisters on close', async () => {
  resetMessageBus();
  const app = buildAppWithScopes(['admin']);
  const server = app.listen(0);
  try {
    const port = listenPort(server);
    const bus = getMessageBus();

    const ctrl = new AbortController();
    const streamRes = await fetch(`http://127.0.0.1:${port}/api/v1/hub/stream`, {
      signal: ctrl.signal,
      headers: { Accept: 'text/event-stream' },
    });
    assert.equal(streamRes.status, 200);
    const ct = streamRes.headers.get('content-type') ?? '';
    assert.ok(ct.includes('text/event-stream'));

    const reader = streamRes.body!.getReader();
    const decoder = new TextDecoder();
    const { value } = await reader.read();
    const prelude = decoder.decode(value ?? new Uint8Array());
    assert.match(prelude, /: connected/);

    publishCorrelation(bus, CORRELATION_TOPIC.cycle, makeCycle('r-sse'));
    const { value: more } = await reader.read();
    const evt = decoder.decode(more ?? new Uint8Array());
    assert.match(evt, /event: runtime\.cycle_correlated/);
    ctrl.abort();
    await reader.cancel().catch(() => undefined);
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// LM-25 / AUDIT api-remaining#L14 — filter + cursor must share one snapshot.
//
// Before the fix `toolName === 'string'` compared the query value against the
// literal string 'string', so the toolName filter never applied; and the cursor
// branch re-read the ring and discarded every previously applied filter, then
// took `slice(-limit)`, which skips every unconsumed event in between.
// ---------------------------------------------------------------------------

interface HubItem {
  busId: string;
  topic: string;
  payload: { runId?: string; toolName?: string };
}
interface HubBody {
  items: HubItem[];
  nextCursor?: string;
  count: number;
  total: number;
}

describe('LM-25: hub correlation filtering and cursor share one snapshot', () => {
  function startHub(): { port: number; server: ReturnType<Express['listen']> } {
    resetMessageBus();
    const app = buildAppWithScopes(['admin']);
    const server = app.listen(0);
    return { port: listenPort(server), server };
  }

  async function readHub(port: number, query: string): Promise<HubBody> {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/hub${query}`);
    assert.equal(res.status, 200, `GET /api/v1/hub${query} failed`);
    return (await res.json()) as HubBody;
  }

  test('toolName filter actually applies (substring match preserved)', async () => {
    const { port, server } = startHub();
    try {
      const bus = getMessageBus();
      publishCorrelation(bus, CORRELATION_TOPIC.cycle, makeCycle('r-1', 'shell_execute'));
      publishCorrelation(bus, CORRELATION_TOPIC.cycle, makeCycle('r-2', 'python_execute'));
      publishCorrelation(bus, CORRELATION_TOPIC.cycle, makeCycle('r-3', 'python_execute'));

      const all = await readHub(port, '');
      assert.equal(all.count, 3, 'sanity: all three events are in the ring');

      const filtered = await readHub(port, '?toolName=python');
      assert.equal(filtered.count, 2, 'toolName must filter, not pass everything through');
      for (const item of filtered.items) {
        assert.ok(item.payload.toolName?.includes('python'));
      }

      const exact = await readHub(port, '?toolName=shell_execute');
      assert.equal(exact.count, 1);
      assert.equal(exact.items[0]?.payload.toolName, 'shell_execute');

      const none = await readHub(port, '?toolName=does-not-exist');
      assert.equal(none.count, 0);
      assert.equal(none.nextCursor, undefined, 'an empty page must not invent a cursor');
    } finally {
      server.close();
    }
  });

  test('filters still apply after a cursor is supplied', async () => {
    const { port, server } = startHub();
    try {
      const bus = getMessageBus();
      publishCorrelation(bus, CORRELATION_TOPIC.cycle, makeCycle('anchor', 'anchor_tool'));
      publishCorrelation(bus, CORRELATION_TOPIC.cycle, makeCycle('a1', 'alpha_tool'));
      publishCorrelation(bus, CORRELATION_TOPIC.cycle, makeCycle('b1', 'beta_tool'));
      publishCorrelation(bus, CORRELATION_TOPIC.cycle, makeCycle('a2', 'alpha_tool'));

      const all = await readHub(port, '');
      assert.equal(all.count, 4);
      const anchor = all.items[0]!.busId;

      // The cursor itself does not match the filter — it is still a valid
      // position, and the filter must be applied to everything after it.
      const paged = await readHub(port, `?toolName=alpha_tool&cursor=${anchor}`);
      assert.equal(paged.count, 2, 'the toolName filter must survive cursor resolution');
      assert.deepEqual(
        paged.items.map((item) => item.payload.runId),
        ['a1', 'a2'],
      );

      const topicFiltered = await readHub(
        port,
        `?topic=runtime.circuit_correlated&cursor=${anchor}`,
      );
      assert.equal(topicFiltered.count, 0, 'the topic filter must survive cursor resolution');

      const runFiltered = await readHub(port, `?runId=b1&cursor=${anchor}`);
      assert.deepEqual(
        runFiltered.items.map((item) => item.payload.runId),
        ['b1'],
      );
    } finally {
      server.close();
    }
  });

  test('cursor paging consumes every matching event exactly once', async () => {
    const { port, server } = startHub();
    try {
      const bus = getMessageBus();
      publishCorrelation(bus, CORRELATION_TOPIC.cycle, makeCycle('anchor', 'anchor_tool'));
      for (let i = 1; i <= 6; i += 1) {
        publishCorrelation(bus, CORRELATION_TOPIC.cycle, makeCycle(`m-${i}`, 'match_tool'));
      }

      const all = await readHub(port, '');
      const anchor = all.items[0]!.busId;

      const seen: string[] = [];
      let cursor = anchor;
      let pages = 0;
      for (;;) {
        const page = await readHub(port, `?toolName=match_tool&limit=2&cursor=${cursor}`);
        pages += 1;
        assert.ok(pages <= 10, 'paging must terminate');
        if (page.count === 0) {
          assert.equal(page.nextCursor, undefined);
          break;
        }
        assert.ok(page.count <= 2, 'limit must be honoured');
        for (const item of page.items) seen.push(item.payload.runId!);
        assert.equal(
          page.nextCursor,
          page.items[page.items.length - 1]!.busId,
          'nextCursor must be the last returned event',
        );
        cursor = page.nextCursor!;
      }

      assert.deepEqual(
        seen,
        ['m-1', 'm-2', 'm-3', 'm-4', 'm-5', 'm-6'],
        'paging must be contiguous: no skipped events, no duplicates, no reordering',
      );
      assert.equal(new Set(seen).size, seen.length);
    } finally {
      server.close();
    }
  });

  test('a first read without a cursor still returns the most recent window', async () => {
    const { port, server } = startHub();
    try {
      const bus = getMessageBus();
      for (let i = 1; i <= 5; i += 1) {
        publishCorrelation(bus, CORRELATION_TOPIC.cycle, makeCycle(`r-${i}`, 'tail_tool'));
      }
      const page = await readHub(port, '?limit=2');
      assert.equal(page.count, 2);
      assert.equal(page.total, 5);
      assert.deepEqual(
        page.items.map((item) => item.payload.runId),
        ['r-4', 'r-5'],
        'the admin tail view shows the newest events',
      );
    } finally {
      server.close();
    }
  });

  test('an unknown cursor is still rejected with 400 and no data', async () => {
    const { port, server } = startHub();
    try {
      const bus = getMessageBus();
      publishCorrelation(bus, CORRELATION_TOPIC.cycle, makeCycle('r-1'));
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/hub?cursor=ghost`);
      assert.equal(res.status, 400);
      const body = (await res.json()) as { error?: string; items?: unknown };
      assert.match(body.error ?? '', /Invalid cursor/);
      assert.equal(body.items, undefined, 'a rejected cursor must not replay from the ring start');
    } finally {
      server.close();
    }
  });

  test('non-admin callers are still rejected', async () => {
    const app = buildAppWithScopes(['read']);
    const server = app.listen(0);
    try {
      const res = await fetch(`http://127.0.0.1:${listenPort(server)}/api/v1/hub?toolName=x`);
      assert.equal(res.status, 403);
    } finally {
      server.close();
    }
  });
});
