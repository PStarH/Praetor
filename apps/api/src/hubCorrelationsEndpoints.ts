/**
 * Hub Glue / Tier-0 correlation events — admin observability endpoint.
 *
 * Surfaces the three Tier-0 unified correlation bus topics:
 *   - runtime.cycle_correlated         (cycle_detected / cycle_detected)
 *   - runtime.retry_block_correlated   (retry_loop_detected / hook_denied)
 *   - runtime.circuit_correlated       (semantic_circuit_trip / circuit_broken)
 *
 * Two modes:
 *   - GET /v1/hub/correlations         REST summary with filtering
 *   - GET /v1/hub/correlations/stream  Server-Sent Events live tail
 *
 * Design notes (June 2026):
 *   - State: dedicated in-memory ring buffer (5000 events) NOT
 *     bus.topicHistory — the bus's history cap is too small (~100)
 *     to be a useful admin tail. Each runtime.*_correlated event is
 *     pushed on subscribe; ring-rotate FIFO when full.
 *   - Subscription: MessageBus.subscribe is per-topic; we subscribe
 *     once to each of the three topics at createHubCorrelationsRouter()
 *     call time. The single listener pattern is shared (no separate
 *     SSE listener — SSE clients receive every event via direct fan-out).
 *   - Auth: admin-scope gate (req.apiScopes.includes('admin')) inside
 *     the router middleware. Non-admin callers get 403. The path is
 *     registered AFTER the global authMiddleware (see routes.ts) so
 *     `req.apiKeyId` + `req.apiScopes` are populated.
 *   - Type safety: payload type derived from BusPayloadMap at the
 *     handler boundary — `payload: BusPayloadMap[T]`. Unknown topics
 *     (defense in depth) surface as 500 with `topic is not in
 *     BusPayloadMap`.
 *
 * Tenant scoping: this admin endpoint is intentionally cross-tenant.
 * Bus payloads don't currently carry a tenantId, and the admin-scope
 * gate is the explicit authorization boundary.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import {
  getMessageBus,
  type BusMessage,
  type BusPayloadMap,
  type MessageBusTopic,
} from '@praetor/core/runtime';
import { isProductionEnv, describeProdSignal } from './envSignal';

const CORRELATION_TOPICS = [
  'runtime.cycle_correlated',
  'runtime.retry_block_correlated',
  'runtime.circuit_correlated',
] as const satisfies readonly MessageBusTopic[];

type CorrelationTopic = (typeof CORRELATION_TOPICS)[number];

interface StoredCorrelationEvent<T extends CorrelationTopic = CorrelationTopic> {
  /** Bus message id (uuid) — used for cursor-based pagination. */
  busId: string;
  /** Topic — keys discriminating between cycle/retry_block/circuit. */
  topic: T;
  /** Typed payload shape (per BusPayloadMap). */
  payload: BusPayloadMap[T];
  /** BusMessage.timestamp ISO string — when the correlator emitted. */
  emittedAt: string;
  /** Local receive time (used by ring buffer eviction + since/until filters). */
  receivedAt: string;
}

const RING_CAP = 5000;
const SSE_HEARTBEAT_MS = 15_000;
const DEFAULT_REST_LIMIT = 100;
const MAX_REST_LIMIT = 1000;

/**
 * Singleton ring buffer holding the last RING_CAP correlation events.
 * Module-level so router creation is idempotent across hot reloads in
 * dev. In a production restart, the ring rebuilds from the next
 * emitted correlation event (acceptable for an admin tail — operators
 * accept that a freshly-restarted server has an empty tail).
 */
const ring: StoredCorrelationEvent[] = [];
let ringWriteIdx = 0;
let ringFilled = false;

/** Open SSE streams — fan-out targets for new correlation events. */
const sseClients = new Set<Response>();

function pushToRing(evt: StoredCorrelationEvent): void {
  if (ring.length < RING_CAP) {
    ring.push(evt);
    ringWriteIdx = ring.length;
    return;
  }
  ring[ringWriteIdx] = evt;
  ringWriteIdx = (ringWriteIdx + 1) % RING_CAP;
  ringFilled = true;
}

/**
 * Materialize the ring into chronological order (oldest → newest),
 * accounting for FIFO rotation once full. Used by the REST read path.
 */
function readRingChronological(): StoredCorrelationEvent[] {
  if (!ringFilled) {
    return ring.slice();
  }
  return ring.slice(ringWriteIdx).concat(ring.slice(0, ringWriteIdx));
}

let installedSubscriptions: (() => void)[] = [];
let heartbeatInstalled = false;

function installSubscriptionsOnce(): void {
  if (installedSubscriptions.length > 0) return;
  const bus = getMessageBus();
  const validTopics = new Set<string>(CORRELATION_TOPICS);
  for (const topic of CORRELATION_TOPICS) {
    const off = bus.subscribe(topic, (msg: BusMessage) => {
      if (!validTopics.has(msg.topic)) return;
      const evt: StoredCorrelationEvent = {
        busId: msg.id,
        topic: msg.topic as CorrelationTopic,
        payload: msg.payload as BusPayloadMap[typeof topic],
        emittedAt: msg.timestamp,
        receivedAt: new Date().toISOString(),
      };
      pushToRing(evt);
      // Defer SSE fan-out via setImmediate so a slow or paused client
      // cannot block the bus dispatcher on subsequent subscribers.
      // The cloned frame array closes over `evt` (no race with the
      // ring buffer's writeIdx advancing before the handler returns).
      const frame = `event: ${evt.topic}\ndata: ${JSON.stringify(evt)}\n\n`;
      setImmediate(() => {
        for (const client of sseClients) {
          try {
            client.write(frame);
          } catch {
            // Client likely disconnected; cleanup happens via req 'close'.
            sseClients.delete(client);
          }
        }
      });
    });
    installedSubscriptions.push(off);
  }
  if (!heartbeatInstalled) {
    const ping = setInterval(() => {
      for (const client of sseClients) {
        try {
          client.write(': heartbeat\n\n');
        } catch {
          sseClients.delete(client);
        }
      }
    }, SSE_HEARTBEAT_MS);
    // unref so a hung SSE doesn't block process exit
    if (typeof ping.unref === 'function') ping.unref();
    heartbeatInstalled = true;
  }
}

function adminGate(req: Request, res: Response, next: NextFunction): void {
  // AUDIT-API10: global authMiddleware already fail-closes on AUTH_DISABLED in
  // production; honoring it here as a bypass was inconsistent. JWT admins were
  // also locked out (their roles never appear in apiScopes) — accept either
  // an admin/super_admin JWT or an admin-scoped API key.
  if (req.user && (req.user.role === 'admin' || req.user.role === 'super_admin')) {
    next();
    return;
  }
  const scopes = req.apiScopes ?? [];
  if (!scopes.includes('admin')) {
    res.status(403).json({
      error: 'Admin authority required',
      detail: 'Pass an admin JWT or an API key with scope=admin.',
    });
    return;
  }
  next();
}

function asPositiveInt(value: unknown, fallback: number, ceiling?: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  if (ceiling !== undefined && parsed > ceiling) return ceiling;
  return Math.floor(parsed);
}

function asIsoDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return undefined;
  return new Date(parsed).toISOString();
}

function isCorrelationTopic(t: unknown): t is CorrelationTopic {
  return typeof t === 'string' && (CORRELATION_TOPICS as readonly string[]).includes(t);
}

export function createHubCorrelationsRouter(): Router {
  installSubscriptionsOnce();
  const router = Router();

  router.use(adminGate);

  // SSE live tail — registered BEFORE the REST summary so the fan-out
  // path is ready before any subscribing clients connect.
  router.get('/stream', (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    res.write(`: connected ${new Date().toISOString()}\n\n`);
    sseClients.add(res);
    req.on('close', () => {
      sseClients.delete(res);
    });
  });

  // REST summary with optional filtering.
  router.get('/', (req: Request, res: Response) => {
    const { runId, topic, toolName, since, until, limit, cursor } = req.query;

    // LM-25 / AUDIT api-remaining#L14: read the ring exactly once. Filtering and
    // cursor resolution must operate on the same snapshot — re-reading the ring
    // after resolving the cursor let a concurrent append shift positions and
    // skip or duplicate rows.
    const snapshot = readRingChronological();

    // The cursor is a position in this snapshot, and is resolved before any
    // filter is applied, so a cursor that does not itself match the filters is
    // still a valid time position.
    let timeline = snapshot;
    const hasCursor = typeof cursor === 'string' && cursor.length > 0;
    if (hasCursor) {
      const cursorIdx = snapshot.findIndex((e) => e.busId === cursor);
      if (cursorIdx === -1) {
        res.status(400).json({ error: 'Invalid cursor', detail: 'busId not found in ring' });
        return;
      }
      timeline = snapshot.slice(cursorIdx + 1);
    }

    if (typeof runId === 'string' && runId.length > 0) {
      timeline = timeline.filter((e) => e.payload?.runId === runId);
    }
    // AUDIT: this compared the query value against the literal string 'string',
    // so the toolName filter never applied. Keep the existing `includes`
    // semantics (substring match), only the type guard changes.
    if (typeof toolName === 'string' && toolName.length > 0) {
      const needle = toolName;
      timeline = timeline.filter((e) => {
        const tn = (e.payload as { toolName?: string }).toolName;
        return typeof tn === 'string' && tn.includes(needle);
      });
    }
    if (typeof topic === 'string' && topic.length > 0 && topic !== 'all') {
      if (!isCorrelationTopic(topic)) {
        res.status(400).json({
          error: 'Invalid topic filter',
          allowed: [...CORRELATION_TOPICS, 'all'],
        });
        return;
      }
      timeline = timeline.filter((e) => e.topic === topic);
    }
    const sinceIso = asIsoDate(since);
    if (sinceIso) {
      const cutoff = Date.parse(sinceIso);
      timeline = timeline.filter((e) => Date.parse(e.receivedAt) >= cutoff);
    }
    const untilIso = asIsoDate(until);
    if (untilIso) {
      const cutoff = Date.parse(untilIso);
      timeline = timeline.filter((e) => Date.parse(e.receivedAt) <= cutoff);
    }

    const limitN = asPositiveInt(limit, DEFAULT_REST_LIMIT, MAX_REST_LIMIT);
    // Page direction depends on whether this is a first read or a continuation:
    //   - no cursor: the most recent N matching events (admin "tail" view);
    //   - with cursor: the OLDEST N matching events after the cursor, so paging
    //     consumes the stream in order instead of re-reading the newest window
    //     and skipping everything in between.
    const visible = hasCursor ? timeline.slice(0, limitN) : timeline.slice(-limitN);
    const nextCursor = visible.length > 0 ? visible[visible.length - 1]!.busId : undefined;

    res.json({
      items: visible,
      nextCursor,
      count: visible.length,
      total: timeline.length,
      ringCap: RING_CAP,
      ringFilled,
      generatedAt: new Date().toISOString(),
    });
  });

  return router;
}

/** Test-only: clear the ring buffer + evict active SSE listeners. */
export function _resetHubCorrelationsForTests(): void {
  if (isProductionEnv()) {
    // Matches the safer no-op-then-warn convention used by sibling reset
    // helpers (resetMessageBus, resetModelRouter) in packages/core — no-op
    // rather than throw so any future SRE escape-hatch invocation surfaces a
    // log line instead of an uncaught stack trace. Uses console.error (not
    // warn) so security-audit tests that legitimately set NODE_ENV=production
    // see this loudly and can opt out of clearing module-level state.
    // eslint-disable-next-line no-console
    console.error(
      `[hubCorrelations] _resetHubCorrelationsForTests invoked in production (signal=${describeProdSignal()}) — clearing module-level ring + SSE fan-out state. This helper is intended for test fixtures only.`,
    );
    return;
  }
  ring.length = 0;
  ringWriteIdx = 0;
  ringFilled = false;
  for (const off of installedSubscriptions) off();
  installedSubscriptions = [];
  for (const client of sseClients) {
    try {
      client.end();
    } catch {
      /* best-effort */
    }
  }
  sseClients.clear();
  heartbeatInstalled = false;
}
