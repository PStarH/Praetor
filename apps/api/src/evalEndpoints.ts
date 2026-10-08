/**
 * evalEndpoints — REST API for the builtin-eval plugin (LLM-as-Judge, datasets,
 * A/B experiment comparison).
 *
 * Control plane:
 *   GET  /api/eval/status   — plugin registration + enable state
 *   POST /api/eval/enable   — enable the builtin-eval plugin
 *   POST /api/eval/disable  — disable the builtin-eval plugin
 *
 * Data plane (works regardless of plugin enable state):
 *   POST /api/eval/judge           — run LLM-as-Judge on a single target
 *   GET  /api/eval/datasets        — list versioned datasets
 *   POST /api/eval/datasets        — create a new dataset
 *   GET  /api/eval/datasets/:id    — get a dataset
 *   POST /api/eval/compare-ab      — run A/B comparison
 *   POST /api/eval/wilcoxon        — pure Wilcoxon signed-rank test
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { toErrorMessage } from './routeHelpers';
import { validateBody } from './validationMiddleware';
import { hasRole } from './userStore';
import {
  getHookManager,
  getSharedJudgeEngine,
  getSharedDatasetManager,
  getSharedABComparator,
  wilcoxonSignedRankTest,
  getGlobalLLMJudgeEngine,
  getGlobalDatasetManager,
  getGlobalABComparator,
  type JudgeTarget,
  type JudgeProvider,
} from '@praetor/core';

const EVAL_PLUGIN_NAME = 'builtin-eval';

function requireEvalAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user && !req.apiKeyId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const scopes = [...(req.apiScopes ?? []), ...(req.user?.scopes ?? [])];
  const authorized =
    (!!req.user?.role && hasRole(req.user.role, 'admin')) ||
    scopes.includes('eval:admin') ||
    scopes.includes('admin') ||
    scopes.includes('*');
  if (!authorized) {
    res.status(403).json({
      error: 'Evaluation administration requires an admin role or eval:admin scope',
    });
    return;
  }
  next();
}

function requireEvalTenant(req: Request, res: Response, next: NextFunction): void {
  if (!req.tenantId) {
    res.status(403).json({ error: 'Tenant-bound authenticated identity required' });
    return;
  }
  next();
}

// ── Validation schemas ───────────────────────────────────────────────────

const judgeSchema = z.object({
  input: z.string().min(1),
  output: z.string().min(1),
  expected: z.string().optional(),
  evaluatedModel: z.string().optional(),
});

const createDatasetSchema = z.object({
  name: z.string().min(1).max(256),
  cases: z
    .array(
      z.object({
        input: z.string(),
        output: z.string(),
        expected: z.string().optional(),
      }),
    )
    .min(1)
    // AUDIT-API9: bound compute inputs against CPU-DoS.
    .max(1000),
});

const compareABSchema = z.object({
  experimentId: z.string().min(1),
  config: z.object({
    metric: z.string(),
    direction: z.enum(['higher', 'lower']),
    alpha: z.number().min(0).max(1).optional(),
  }),
  pairs: z
    .array(
      z.object({
        a: z.object({ score: z.number() }),
        b: z.object({ score: z.number() }),
      }),
    )
    .min(1)
    .max(10000),
});

const wilcoxonSchema = z.object({
  deltas: z.array(z.number()).min(1).max(10000),
  alpha: z.number().min(0).max(1).optional(),
});

// ── Router factory ───────────────────────────────────────────────────────

export function createEvalRouter(): Router {
  const router = Router();

  // ── Control plane ────────────────────────────────────────────────────

  router.get('/api/eval/status', (req: Request, res: Response) => {
    try {
      const hm = getHookManager();
      const registered = hm.hasPlugin(EVAL_PLUGIN_NAME);
      const enabled = hm.isEnabled(EVAL_PLUGIN_NAME);
      const judgeEngine = getSharedJudgeEngine() ?? getGlobalLLMJudgeEngine();
      const datasetManager = getSharedDatasetManager() ?? getGlobalDatasetManager();
      const abComparator = getSharedABComparator() ?? getGlobalABComparator();
      res.json({
        plugin: EVAL_PLUGIN_NAME,
        registered,
        enabled,
        judgeStats: judgeEngine?.getStats() ?? null,
        datasetCount: datasetManager?.list(req.tenantId).length ?? 0,
        abResultCount: abComparator?.listResults().length ?? 0,
      });
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error) });
    }
  });

  router.post('/api/eval/enable', requireEvalAdmin, (_req: Request, res: Response) => {
    try {
      const hm = getHookManager();
      if (!hm.hasPlugin(EVAL_PLUGIN_NAME)) {
        res.status(404).json({ error: 'Eval plugin is not registered' });
        return;
      }
      const ok = hm.enable(EVAL_PLUGIN_NAME);
      res.json({ plugin: EVAL_PLUGIN_NAME, enabled: true, ok });
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error) });
    }
  });

  router.post('/api/eval/disable', requireEvalAdmin, (_req: Request, res: Response) => {
    try {
      const hm = getHookManager();
      if (!hm.hasPlugin(EVAL_PLUGIN_NAME)) {
        res.status(404).json({ error: 'Eval plugin is not registered' });
        return;
      }
      const ok = hm.disable(EVAL_PLUGIN_NAME);
      res.json({ plugin: EVAL_PLUGIN_NAME, enabled: false, ok });
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error) });
    }
  });

  // ── Data plane ───────────────────────────────────────────────────────

  // AUDIT-API9: judge spends provider budget — require a tenant-bound
  // principal like the rest of the eval data plane.
  router.post(
    '/api/eval/judge',
    requireEvalTenant,
    validateBody(judgeSchema),
    async (req: Request, res: Response) => {
      try {
        const engine = getSharedJudgeEngine() ?? getGlobalLLMJudgeEngine();
        if (!engine) {
          res.status(503).json({ error: 'JudgeEngine not initialized (plugin may be disabled)' });
          return;
        }
        const target: JudgeTarget = {
          input: req.body.input,
          output: req.body.output,
          expected: req.body.expected,
          evaluatedModel: req.body.evaluatedModel,
        };
        const result = await engine.judge(target);
        res.json(result);
      } catch (error) {
        res.status(500).json({ error: toErrorMessage(error) });
      }
    },
  );

  router.get('/api/eval/datasets', requireEvalTenant, (req: Request, res: Response) => {
    try {
      const dm = getSharedDatasetManager() ?? getGlobalDatasetManager();
      if (!dm) {
        res.status(503).json({ error: 'DatasetManager not initialized' });
        return;
      }
      res.json({ datasets: dm.list(req.tenantId) });
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error) });
    }
  });

  router.post(
    '/api/eval/datasets',
    requireEvalTenant,
    validateBody(createDatasetSchema),
    (req: Request, res: Response) => {
      try {
        const dm = getSharedDatasetManager() ?? getGlobalDatasetManager();
        if (!dm) {
          res.status(503).json({ error: 'DatasetManager not initialized' });
          return;
        }
        const dataset = dm.create(
          {
            name: req.body.name,
            cases: req.body.cases,
          },
          req.tenantId,
        );
        res.status(201).json(dataset);
      } catch (error) {
        res.status(500).json({ error: toErrorMessage(error) });
      }
    },
  );

  router.post(
    '/api/eval/compare-ab',
    validateBody(compareABSchema),
    (req: Request, res: Response) => {
      try {
        const comparator = getSharedABComparator() ?? getGlobalABComparator();
        if (!comparator) {
          res.status(503).json({ error: 'ABComparator not initialized' });
          return;
        }
        const result = comparator.compare(req.body.config, req.body.pairs);
        res.json({ experimentId: req.body.experimentId, result });
      } catch (error) {
        res.status(500).json({ error: toErrorMessage(error) });
      }
    },
  );

  router.post('/api/eval/wilcoxon', validateBody(wilcoxonSchema), (req: Request, res: Response) => {
    try {
      const result = wilcoxonSignedRankTest(req.body.deltas, req.body.alpha ?? 0.05);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error) });
    }
  });

  return router;
}
