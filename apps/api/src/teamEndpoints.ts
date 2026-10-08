import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { getWorkCoordinator, type TeamStatus, type WorkItem } from '@praetor/core';
import { hasRole } from './userStore';

const RUN_ID_PATTERN = /^[a-zA-Z0-9_.-]+$/;

function isValidRunId(runId: unknown): runId is string {
  return (
    typeof runId === 'string' &&
    runId.length > 0 &&
    runId.length < 128 &&
    RUN_ID_PATTERN.test(runId)
  );
}

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user && !req.apiKeyId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  next();
}

function canAccessRun(req: Request, items: WorkItem[]): boolean {
  const principal = req.user?.id ?? req.apiKeyId;
  const tenant = req.user?.tenantId ?? req.tenantId;
  if (!principal || !tenant || items.length === 0) return false;
  return items.every((item) => {
    return (
      item.tenantId === tenant &&
      typeof item.ownerId === 'string' &&
      item.ownerId.length > 0 &&
      ((!!req.user && hasRole(req.user.role, 'admin')) || item.ownerId === principal)
    );
  });
}

function runItems(req: Request, res: Response): WorkItem[] | undefined {
  const runId = req.params.runId;
  if (!isValidRunId(runId)) {
    res.status(400).json({ error: 'runId is required and must be alphanumeric' });
    return undefined;
  }
  const items = getWorkCoordinator().list({ runId });
  if (!canAccessRun(req, items)) {
    res.status(404).json({ error: 'Team run not found' });
    return undefined;
  }
  return items;
}

export function createTeamRouter(): Router {
  const router = Router();
  router.use(requireAuth);

  router.get('/api/teams/:runId/status', (req, res) => {
    const { runId } = req.params;
    if (!isValidRunId(runId)) {
      return res.status(400).json({ error: 'runId is required and must be alphanumeric' });
    }
    const items = runItems(req, res);
    if (!items) return;
    const status: TeamStatus = getWorkCoordinator().getTeamStatus(runId);
    res.json(status);
  });

  router.get('/api/teams/:runId/work', (req, res) => {
    const { runId } = req.params;
    if (!isValidRunId(runId)) {
      return res.status(400).json({ error: 'runId is required and must be alphanumeric' });
    }
    const items = runItems(req, res);
    if (!items) return;
    res.json({ runId, items, total: items.length });
  });

  router.get('/api/teams/:runId/agents', (req, res) => {
    const { runId } = req.params;
    if (!isValidRunId(runId)) {
      return res.status(400).json({ error: 'runId is required and must be alphanumeric' });
    }
    const items = runItems(req, res);
    if (!items) return;
    const byAgent = new Map<
      string,
      { claimed: number; completed: number; failed: number; pending: number; totalTokens: number }
    >();
    for (const it of items) {
      const agentId = it.claimedBy ?? it.parentNodeId;
      const slot = byAgent.get(agentId) ?? {
        claimed: 0,
        completed: 0,
        failed: 0,
        pending: 0,
        totalTokens: 0,
      };
      if (it.status === 'PENDING') slot.pending++;
      else if (it.status === 'CLAIMED' || it.status === 'RUNNING') slot.claimed++;
      else if (it.status === 'COMPLETED') slot.completed++;
      else if (it.status === 'FAILED') slot.failed++;
      slot.totalTokens += it.tokenBudget;
      byAgent.set(agentId, slot);
    }
    const agents = Array.from(byAgent.entries()).map(([agentId, counts]) => ({
      agentId,
      ...counts,
      currentGoal: items.find(
        (i) =>
          (i.claimedBy ?? i.parentNodeId) === agentId &&
          (i.status === 'CLAIMED' || i.status === 'RUNNING'),
      )?.goal,
    }));
    res.json({ runId, agents, total: agents.length });
  });

  router.post('/api/teams/:runId/reassign', (req, res) => {
    const { runId } = req.params;
    if (!isValidRunId(runId)) {
      return res.status(400).json({ error: 'runId is required and must be alphanumeric' });
    }
    const workId = (req.body ?? {}).workId;
    if (typeof workId !== 'string' || workId.length === 0) {
      return res.status(400).json({ error: 'workId is required' });
    }
    const items = runItems(req, res);
    if (!items) return;
    const coord = getWorkCoordinator();
    const item = items.find((candidate) => candidate.id === workId);
    if (!item) {
      return res.status(404).json({ error: 'Work item not found or not in reassignable state' });
    }
    const reassigned = coord.reassign(workId, 'manual reassign from API');
    if (!reassigned) {
      return res.status(404).json({ error: 'Work item not found or not in reassignable state' });
    }
    res.json({ status: 'reassigned', workId });
  });

  return router;
}
