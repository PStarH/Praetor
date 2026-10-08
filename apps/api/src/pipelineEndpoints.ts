import { Router } from 'express';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import { SequentialPipeline } from '@praetor/core';
import { PatternStateMachineFactory, PatternStateMachine } from './patternStateMachine';
import {
  SequentialExecutor,
  createRealAgentExecutor,
  type AgentExecutor,
} from './sequentialExecutor';
import { legacyExecutionDisabledReason, isLegacyExecutionAllowed } from './legacyExecutionGuard';
import { hasRole, type UserRole } from './userStore';

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

type OwnedResource<T> = { resource: T; tenantId?: string; ownerId?: string };

function principalId(req: Request): string | undefined {
  return req.user?.id ?? req.apiKeyId;
}

function principalTenant(req: Request): string | undefined {
  return req.user?.tenantId ?? req.tenantId;
}

function isSuperAdmin(req: Request): boolean {
  return !!req.user && hasRole(req.user.role, 'super_admin');
}

function canAccessResource(req: Request, resource: OwnedResource<unknown>): boolean {
  if (isSuperAdmin(req)) return true;
  const principal = principalId(req);
  const tenant = principalTenant(req);
  if (!principal || !tenant || !resource.tenantId) return false;
  return (
    resource.tenantId === tenant &&
    ((!!req.user && hasRole(req.user.role, 'admin')) || resource.ownerId === principal)
  );
}

export interface CreatePipelineRouterOptions {
  agentExecutor?: AgentExecutor;
}

/**
 * Path prefixes owned by this router.
 *
 * The legacy-execution guard below is scoped to exactly these prefixes, and
 * that scoping is load-bearing rather than cosmetic. This router is mounted at
 * `'/'` (`index.ts` registers `{ name: 'pipeline', mountPath: '/' }`), *before*
 * workflow, namespaced-memory, a2a, a2a-v2, mcp, mcp-client, stream, cost,
 * replay, team, dlq, approval-config, hallucination and everything registered
 * after them. An unscoped `router.use` therefore answered **410 for every one
 * of those routes** whenever legacy execution was disabled — which is the
 * default, since `isLegacyExecutionAllowed()` requires an explicit
 * `COMMANDER_LEGACY_EXECUTION=1`. The guard must reject only the legacy
 * pipeline/state-machine surface it exists to replace.
 */
const LEGACY_PIPELINE_PATHS = ['/api/state-machine', '/api/pipeline'] as const;

export function createPipelineRouter(options: CreatePipelineRouterOptions = {}): Router {
  const router = Router();

  // The old pipeline and in-memory state-machine routes are not a second
  // execution authority. They remain available only in explicit local
  // compatibility mode; V2/production callers must use /v1/runs.
  //
  // Registered once per owned prefix (not as a bare `router.use`) so the guard
  // cannot answer for routes this router does not own — see
  // LEGACY_PIPELINE_PATHS.
  const legacyGuard: RequestHandler = (_req, res, next) => {
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
  };
  for (const prefix of LEGACY_PIPELINE_PATHS) {
    router.use(prefix, legacyGuard);
  }

  // Pattern State Machine
  const activeMachines = new Map<string, OwnedResource<PatternStateMachine>>();

  router.post('/api/state-machine/create', (req, res) => {
    const { pattern } = req.body ?? {};
    if (!pattern) {
      return res.status(400).json({
        error: 'pattern is required (orchestrator-worker, hierarchical, swarm, pipeline)',
      });
    }
    try {
      const machine = PatternStateMachineFactory.create(pattern);
      const machineId = `sm-${randomUUID()}`;
      activeMachines.set(machineId, {
        resource: machine,
        tenantId: principalTenant(req),
        ownerId: principalId(req),
      });
      res.json({
        machineId,
        pattern,
        currentState: machine.getCurrentState().currentStep,
      });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.post('/api/state-machine/:machineId/transition', async (req, res) => {
    const { machineId } = req.params;
    const { targetState } = req.body ?? {};
    const entry = activeMachines.get(machineId);
    if (!entry || !canAccessResource(req, entry)) {
      return res.status(404).json({ error: 'Machine not found' });
    }
    const machine = entry.resource;
    if (!targetState) {
      return res.status(400).json({ error: 'targetState is required' });
    }
    try {
      const result = await machine.transition(targetState);
      res.json({ result, currentState: machine.getCurrentState() });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.get('/api/state-machine/:machineId', (req, res) => {
    const { machineId } = req.params;
    const entry = activeMachines.get(machineId);
    if (!entry || !canAccessResource(req, entry)) {
      return res.status(404).json({ error: 'Machine not found' });
    }
    res.json({ machineId, currentState: entry.resource.getCurrentState() });
  });

  // Sequential Executor
  const pipelineRuns = new Map<string, OwnedResource<any>>();
  const sequentialExecutor = new SequentialExecutor({
    agentExecutor: options.agentExecutor ?? createRealAgentExecutor(),
    runContextProvider: async (ctx: { projectId?: string }) => ({
      projectId: ctx?.projectId ?? 'default',
      run: { runId: 'run', issuedAt: new Date().toISOString() },
      slimSnapshot: {
        project: {
          id: 'default',
          codename: 'default',
          objective: '',
          status: 'ACTIVE',
          updatedAt: new Date().toISOString(),
        },
        missionBoard: { running: [], blocked: [], planned: [], done: [] },
        battleMetrics: {
          health: 'GREEN',
          runningMissionCount: 0,
          blockedMissionCount: 0,
          completedMissionCount: 0,
          highRiskMissionCount: 0,
          manualGovernanceMissionCount: 0,
          logVolume24h: 0,
          completionRate: 0,
        },
      },
      recentMemory: [],
      recommendedMemory: { items: [] },
      agentRoster: [],
    }),
  });

  router.post('/api/pipeline/execute', requireAuth, requireRole('admin'), async (req, res) => {
    const { id, name, projectId, steps, input } = req.body ?? {};
    if (!id || !Array.isArray(steps) || steps.length === 0) {
      return res.status(400).json({ error: 'id and steps[] are required' });
    }
    const now = new Date().toISOString();
    const pipeline = {
      id,
      name: name ?? id,
      projectId: projectId ?? 'default',
      steps: steps.map((s: Record<string, unknown>, i: number) => ({
        id: s.id ?? `step-${i}`,
        agentId: s.agentId ?? 'agent-default',
        name: s.name ?? `Step ${i + 1}`,
        input: s.input,
        timeoutMs: s.timeoutMs,
        retries: s.retries,
      })),
      createdAt: now,
      updatedAt: now,
    };
    try {
      const run = await sequentialExecutor.execute(pipeline as unknown as SequentialPipeline, {
        input,
      });
      pipelineRuns.set(run.id, {
        resource: run,
        tenantId: principalTenant(req),
        ownerId: principalId(req),
      });
      res.json(run);
    } catch (err: unknown) {
      process.stderr.write(
        `[Pipeline] Execute error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      res.status(500).json({ error: 'Pipeline execution failed. Check server logs for details.' });
    }
  });

  router.get('/api/pipeline/runs/:runId', requireAuth, requireRole('admin'), (req, res) => {
    const entry = pipelineRuns.get(String(req.params.runId));
    if (!entry || !canAccessResource(req, entry))
      return res.status(404).json({ error: 'Run not found' });
    res.json(entry.resource);
  });

  router.get('/api/pipeline/runs', requireAuth, requireRole('admin'), (req, res) => {
    res.json(
      Array.from(pipelineRuns.values())
        .filter((entry) => canAccessResource(req, entry))
        .map((entry) => entry.resource),
    );
  });

  return router;
}
