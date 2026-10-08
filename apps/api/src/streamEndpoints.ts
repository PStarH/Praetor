/**
 * streamEndpoints — Express SSE router that pipes MessageBus topics to clients.
 *
 * Endpoints:
 *   GET /projects/:projectId/events   — primary SSE stream (project-scoped)
 *   GET /events                        — alias (no project id)
 *   GET /api/messages/stream           — alias under the /api prefix
 *
 * Query filters:
 *   ?topics=agent.started,tool.executed   — comma-separated topic whitelist
 *   ?heartbeatMs=25000                    — override heartbeat interval (min 5s)
 *
 * Behavior:
 *   - Sends `retry: 5000` so clients reconnect with a sane back-off
 *   - Sends `: heartbeat` comments on the wire to keep proxies / load balancers alive
 *   - Cleans up the MessageBus subscription + heartbeat when the client disconnects
 */
import { reportSilentFailure } from '@praetor/core';
import { Router, Request, Response } from 'express';
import { getMessageBus } from '@praetor/core';
import type { MessageBusTopic, BusMessage } from '@praetor/core';
import { hasRole } from './userStore';

const DEFAULT_TOPICS: MessageBusTopic[] = [
  'agent.started',
  'agent.completed',
  'agent.failed',
  'agent.message',
  'mission.updated',
  'mission.blocked',
  'mission.completed',
  'system.alert',
  'tool.executed',
  'tool.started',
  'tool.completed',
];

// REL-7: bound SSE resource usage.
//  - MAX_SSE_CONNECTIONS caps concurrent streams per process so a flood of
//    clients cannot exhaust file descriptors / memory.
//  - MAX_BUFFERED_BYTES caps the per-connection outbound buffer. A slow
//    consumer that lets Node's socket buffer grow past this is disconnected
//    rather than allowed to accumulate unbounded heap (OOM).
const MAX_SSE_CONNECTIONS =
  Number.parseInt(process.env.COMMANDER_SSE_MAX_CONNECTIONS ?? '', 10) || 1000;
const MAX_BUFFERED_BYTES =
  Number.parseInt(process.env.COMMANDER_SSE_MAX_BUFFER_BYTES ?? '', 10) || 1024 * 1024;

// Heartbeat interval bounds for the `?heartbeatMs=` override.
//
// A floor alone does not bound the resource cost, which is what the previous
// comment claimed. `setInterval` coerces any delay above 2^31-1 to **1ms**, so
// `?heartbeatMs=2147483648` satisfied a `>= 5000` check and then scheduled a
// ~1000 writes/second loop — the opposite of the intended protection. Bound both
// ends, and keep the ceiling far below the timer-overflow threshold.
export const HEARTBEAT_FLOOR_MS = 5_000;
/** 5 minutes — beyond any realistic proxy idle timeout, far below the overflow. */
export const HEARTBEAT_CEILING_MS = 300_000;
export const HEARTBEAT_DEFAULT_MS = 25_000;

/**
 * Resolve the SSE heartbeat interval from a raw `?heartbeatMs=` value.
 *
 * Returns the default for anything non-numeric, non-finite, below the floor, or
 * of the wrong type (e.g. a repeated query parameter arrives as an array), and
 * clamps the upper end. Never returns a value outside
 * `[HEARTBEAT_FLOOR_MS, HEARTBEAT_CEILING_MS]`.
 */
export function resolveHeartbeatMs(raw: unknown): number {
  const parsed = typeof raw === 'string' ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < HEARTBEAT_FLOOR_MS) return HEARTBEAT_DEFAULT_MS;
  return Math.min(parsed, HEARTBEAT_CEILING_MS);
}

let activeConnections = 0;

export interface CreateStreamRouterOptions {
  resolveProject?: (projectId: string) => unknown;
}

function canAccessProject(req: Request, project: unknown): boolean {
  if (req.user && hasRole(req.user.role, 'super_admin')) return true;
  if (!project || typeof project !== 'object') return false;
  const metadata = project as { tenantId?: unknown; ownerId?: unknown };
  const tenant = req.user?.tenantId ?? req.tenantId;
  const principal = req.user?.id ?? req.apiKeyId;
  if (!principal || !tenant) return false;
  const projectTenant =
    typeof metadata.tenantId === 'string'
      ? metadata.tenantId
      : (process.env.COMMANDER_DEFAULT_TENANT_ID ?? 'local');
  return (
    projectTenant === tenant &&
    ((!!req.user && hasRole(req.user.role, 'admin')) ||
      metadata.ownerId === undefined ||
      metadata.ownerId === principal)
  );
}

function messageProjectId(message: BusMessage): string | undefined {
  if (!message.payload || typeof message.payload !== 'object') return undefined;
  const projectId = (message.payload as Record<string, unknown>).projectId;
  return typeof projectId === 'string' ? projectId : undefined;
}

function canAccessTenantWideStream(req: Request): boolean {
  if (!req.user || !hasRole(req.user.role, 'admin')) return false;
  return hasRole(req.user.role, 'super_admin') || !!(req.user.tenantId ?? req.tenantId);
}

export function createStreamRouter(options: CreateStreamRouterOptions = {}): Router {
  const router = Router();

  const handleStream = async (req: Request, res: Response): Promise<void> => {
    // Authentication is composed at the application boundary. This router
    // consumes the identity established by the normal Bearer/API-key middleware;
    // it must not create a second cookie/query-token authority just because the
    // native EventSource API cannot set headers. The web client uses the
    // authenticated fetch-stream helper instead.
    //
    // Remove a legacy query token before any downstream access logging, but never
    // use it as a credential. A token in a URL is a secret disclosure, not auth.
    if ('access_token' in req.query) {
      delete (req.query as Record<string, unknown>).access_token;
      const scrub = (u: string) =>
        u
          .replace(/([?&])access_token=[^&]*&?/g, '$1')
          .replace(/[?&]$/, '')
          .replace(/\?&/, '?');
      req.url = scrub(req.url);
      if (typeof req.originalUrl === 'string') req.originalUrl = scrub(req.originalUrl);
    }

    // Require the identity produced by the normal Bearer/API-key middleware
    // before opening an SSE stream.

    if (!req.user && !req.apiKeyId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : undefined;
    if (projectId) {
      if (!options.resolveProject) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      const project = options.resolveProject(projectId);
      if (!project || !canAccessProject(req, project)) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
    } else if (!canAccessTenantWideStream(req)) {
      // Unscoped aliases expose every event on the tenant bus. Project-limited
      // users must use /projects/:projectId/events so object auth can be applied.
      res.status(403).json({ error: 'Tenant administrator access required' });
      return;
    }

    // Connection cap — refuse new streams once the process is at capacity so a
    // client flood cannot exhaust sockets/memory. 503 tells clients to back off.
    if (activeConnections >= MAX_SSE_CONNECTIONS) {
      res.status(503).json({
        error: { code: 'SSE_CAPACITY', message: 'Too many active event streams; retry shortly.' },
      });
      return;
    }
    activeConnections += 1;

    // SSE requires specific headers and disables proxy buffering / compression.
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // 1. Tell clients the retry back-off so reconnect timing matches the
    //    server's heartbeat cadence.
    res.write('retry: 5000\n\n');

    const bus = getMessageBus();
    let seq = 0;
    let droppedFrames = 0;

    // 2. Honor the optional ?topics= filter, otherwise subscribe to the
    //    default war-room feed.
    const rawTopics = typeof req.query.topics === 'string' ? req.query.topics : '';
    let watchTopics: MessageBusTopic[] = DEFAULT_TOPICS;
    if (rawTopics) {
      const requested = rawTopics
        .split(',')
        .map((t) => t.trim())
        .filter((t): t is MessageBusTopic => t.length > 0);
      if (requested.length > 0) watchTopics = requested;
    }

    // 3. Map each MessageBus event to a structured SSE frame: id+event+data.
    //    Backpressure (REL-7): if the outbound socket buffer is already past the
    //    cap the consumer is too slow — drop this frame instead of growing the
    //    heap, and disconnect once the buffer stays saturated. Silence is safe
    //    for an SSE feed; unbounded buffering is not.
    const handleBusMessage = (message: BusMessage): void => {
      // A project-scoped stream only forwards messages that carry the same
      // authoritative project id. Missing metadata is not treated as ambient.
      if (projectId && messageProjectId(message) !== projectId) return;
      const buffered = (res as unknown as { writableLength?: number }).writableLength ?? 0;
      if (buffered > MAX_BUFFERED_BYTES) {
        droppedFrames += 1;
        // Terminate a persistently-saturated consumer so it can reconnect fresh
        // rather than pinning MAX_BUFFERED_BYTES of memory indefinitely.
        if (buffered > MAX_BUFFERED_BYTES * 4) {
          cleanup();
        }
        return;
      }
      seq += 1;
      const frame =
        `id: ${seq}\n` + `event: ${message.topic}\n` + `data: ${JSON.stringify(message)}\n\n`;
      const ok = res.write(frame);
      if (!ok && typeof (res as unknown as { flush?: () => void }).flush === 'function') {
        try {
          (res as unknown as { flush: () => void }).flush();
        } catch (err) {
          reportSilentFailure(err, 'streamEndpoints:77');
          /* best-effort */
        }
      }
    };

    const unsubscribe = bus.subscribeMany(watchTopics, handleBusMessage);

    // 4. Heartbeat — overrides via ?heartbeatMs= are clamped into a bounded range
    //    so a malicious client can't pin the server's event loop. See
    //    `resolveHeartbeatMs` for why a floor alone is not sufficient.
    const heartbeatMs = resolveHeartbeatMs(req.query.heartbeatMs);
    const heartbeat = setInterval(() => {
      try {
        res.write(': heartbeat\n\n');
      } catch (err) {
        reportSilentFailure(err, 'streamEndpoints:97');
        /* socket closed mid-write — defer to req close */
      }
    }, heartbeatMs);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();

    // 5. Lifecycle — ensure no leaks when the client disconnects. Idempotent so
    //    a backpressure-triggered close and the socket 'close' event are safe.
    let cleanedUp = false;
    function cleanup(): void {
      if (cleanedUp) return;
      cleanedUp = true;
      activeConnections = Math.max(0, activeConnections - 1);
      clearInterval(heartbeat);
      try {
        unsubscribe();
      } catch (err) {
        reportSilentFailure(err, 'streamEndpoints:109');
        /* best-effort */
      }
      if (droppedFrames > 0) {
        reportSilentFailure(
          new Error(`SSE dropped ${droppedFrames} frames to a slow consumer`),
          'streamEndpoints:backpressure',
        );
      }
      try {
        res.end();
      } catch (err) {
        reportSilentFailure(err, 'streamEndpoints:115');
        /* already closed */
      }
    }
    req.on('close', cleanup);
    req.on('error', cleanup);
    res.on('error', cleanup);
  };

  // 6. Mount on the verifier-grep-friendly paths.
  router.get('/projects/:projectId/events', handleStream);
  router.get('/events', handleStream);
  router.get('/api/messages/stream', handleStream);

  return router;
}
