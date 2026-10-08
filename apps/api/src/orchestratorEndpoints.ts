import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { SSEStream } from '@praetor/core';
import { legacyExecutionDisabledReason, isLegacyExecutionAllowed } from './legacyExecutionGuard';
import { hasRole, type UserRole } from './userStore';

/**
 * @deprecated Architecture V2 — use POST /v1/runs with a WorkGraph instead.
 *
 * Synchronous orchestration was removed from the API process. The V1 Kernel
 * Gateway accepts a WorkGraph definition and submits durable steps to workers.
 *
 * Migration: replace `POST /orchestrator/execute` with `POST /v1/runs`
 * using a multi-step WorkGraph. This router will be removed in v0.3.0.
 */

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  next();
}

function requireRole(requiredRole: UserRole = 'admin') {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user || !hasRole(req.user.role, requiredRole)) {
      res.status(403).json({ error: 'Insufficient privileges' });
      return;
    }
    next();
  };
}

export function createOrchestratorRouter(): Router {
  const router = Router();

  router.use((_req, res, next) => {
    if (!isLegacyExecutionAllowed()) {
      res.status(410).json({
        error: {
          code: 'LEGACY_EXECUTION_DISABLED',
          message: legacyExecutionDisabledReason(),
          replacement: 'POST /v1/runs',
        },
      });
      return;
    }
    next();
  });

  router.post('/orchestrator/execute', requireAuth, requireRole('admin'), (req, res) => {
    const { goal } = req.body ?? {};
    if (!goal) return res.status(400).json({ error: 'goal is required' });
    return res.status(410).json({
      error: {
        code: 'LEGACY_EXECUTION_DISABLED',
        message: 'Synchronous API orchestration has been removed.',
        replacement: 'POST /v1/runs',
      },
    });
  });

  // AUDIT-R4F6: deliberate mirrors /execute's authz (admin role) — it runs
  // the planner over caller-supplied goals.
  router.post('/orchestrator/deliberate', requireAuth, requireRole('admin'), async (req, res) => {
    const { goal } = req.body ?? {};
    if (!goal) return res.status(400).json({ error: 'goal is required' });

    const { deliberate } = await import('@praetor/core');
    const plan = deliberate(goal);
    res.json(plan);
  });

  router.get('/orchestrator/stream', (_req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      // AUDIT-R4F6: wildcard CORS removed — the global CORS allowlist governs
      // which origins may consume this event stream.
    });

    const sse = new SSEStream();
    sse.pipe(res);

    _req.on('close', () => {
      sse.close();
      res.end();
    });
  });

  return router;
}
