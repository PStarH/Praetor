/**
 * Observability HTTP endpoints for the War Room.
 *
 * Mounted at /api/v1/observability. Delegates to the shared handler in
 * packages/core/src/observability/httpApi.ts so the War Room and the core
 * runtime HTTP server expose the same data model (TimelineView, CostReport,
 * DecisionNode, ReplayResult, span tree).
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import type { IncomingMessage } from 'http';
import {
  handleObservabilityRequest,
  type ObservabilityDeps,
  OBSERVABILITY_HTTP_ROUTES,
} from '@praetor/core/observability';
import { getTraceRecorder, PersistentTraceStore } from '@praetor/core/runtime';
import { resolveConfiguredTraceBase } from '@praetor/core/runtime/traceStore';

/**
 * Resolve the trace base directory for this process.
 *
 * Delegates to the single owner of the trace-directory rule in
 * `@praetor/core/runtime/traceStore` so the observability reader can never
 * disagree with the trace writer (or with the lineage/hallucination/cost
 * readers) about where traces live.
 */
export function resolveTraceDirectory(
  env: {
    COMMANDER_TRACE_DIR?: string | undefined;
    COMMANDER_TRACES_DIR?: string | undefined;
  } = process.env,
  cwd: string = process.cwd(),
): string {
  return resolveConfiguredTraceBase(env, cwd);
}

const tracesDir = resolveTraceDirectory();
const traceStore = new PersistentTraceStore(tracesDir);
const tenantTraceStores = new Map<string, PersistentTraceStore>();
// In-memory recorder is empty in a pure observability process; the handler
// falls back to reading the on-disk NDJSON via PersistentTraceStore.
const recorder = getTraceRecorder(traceStore);
const resolveTenant = (req: IncomingMessage): string | undefined =>
  (req as IncomingMessage & { tenantId?: string }).tenantId;
const resolveTraceStore = (tenantId: string | undefined): PersistentTraceStore => {
  if (!tenantId) return traceStore;
  let store = tenantTraceStores.get(tenantId);
  if (!store) {
    store = new PersistentTraceStore(tracesDir, tenantId);
    tenantTraceStores.set(tenantId, store);
  }
  return store;
};

const deps: ObservabilityDeps = { recorder, traceStore, resolveTenant, resolveTraceStore };

const RUN_ID_PATTERN = /^[a-zA-Z0-9_.-]+$/;
function isValidRunId(runId: string): boolean {
  return (
    typeof runId === 'string' &&
    runId.length > 0 &&
    runId.length < 200 &&
    RUN_ID_PATTERN.test(runId)
  );
}

export function createObservabilityRouter(): Router {
  const router = Router();

  router.all(/.*/, async (req: Request, res: Response, _next: NextFunction) => {
    const rel = req.path.replace(/^\/+/, '');
    const segments = rel.length === 0 ? [] : rel.split('/').filter(Boolean);

    // Defense in depth: handler does not validate runId, so reject traversal-style values here.
    if (segments[0] === 'runs' && segments.length >= 2 && !isValidRunId(segments[1]!)) {
      res.status(400).json({ error: 'Invalid runId format' });
      return;
    }

    try {
      const result = await handleObservabilityRequest(
        req,
        deps,
        segments,
        req.url.split('?')[1] ?? '',
      );
      if (result.handled) {
        if (result.body !== undefined) {
          res.status(result.status).json(result.body);
        } else {
          res.sendStatus(result.status);
        }
      } else if (!res.headersSent) {
        res.status(404).json({ error: 'Not found' });
      }
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error', detail: (err as Error)?.message });
      }
    }
  });

  return router;
}

export { OBSERVABILITY_HTTP_ROUTES };
