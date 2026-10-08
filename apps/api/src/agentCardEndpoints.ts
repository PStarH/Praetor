import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { TenantIsolationError } from '@praetor/core/runtime/tenantContext';
import { AgentCardRegistry } from './agentCard';
import { hasRole } from './userStore';

/**
 * AUDIT-API3: the registry is served to other agents for discovery — a
 * viewer/read-only principal must not be able to register or overwrite
 * agent cards (discovery poisoning with attacker-controlled capability
 * descriptions and endpoint URLs).
 */
function requireCardRegistrar(req: Request, res: Response, next: NextFunction): void {
  if (req.user) {
    if (!hasRole(req.user.role, 'developer')) {
      res.status(403).json({ error: 'Agent-card registration requires developer role' });
      return;
    }
    next();
    return;
  }
  const scopes = req.apiScopes ?? [];
  if (!scopes.some((s) => ['write', 'agents:write', 'admin', '*'].includes(s))) {
    res.status(403).json({ error: 'Agent-card registration authority required' });
    return;
  }
  next();
}

export function createAgentCardRouter(registry?: AgentCardRegistry): Router {
  const router = Router();
  const reg = registry ?? new AgentCardRegistry();

  router.get('/agent-cards', (_req, res) => {
    res.json(reg.listAll());
  });

  router.get('/agent-cards/:id', (req, res) => {
    const card = reg.get(req.params.id);
    if (!card) return res.status(404).json({ error: 'Agent card not found' });
    res.json(card);
  });

  router.post('/agent-cards', requireCardRegistrar, (req, res) => {
    const card = req.body;
    if (!card?.id || !card?.name) {
      return res.status(400).json({ error: 'id and name are required' });
    }
    try {
      reg.register(card);
      res.status(201).json(card);
    } catch (error) {
      if (error instanceof TenantIsolationError) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      return res
        .status(400)
        .json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}
