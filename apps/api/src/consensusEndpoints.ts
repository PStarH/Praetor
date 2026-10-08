/**
 * consensusEndpoints — REST API for the builtin-consensus plugin.
 *
 * Control plane:
 *   GET  /api/consensus/status   — plugin registration + enable state + TSM snapshot
 *   POST /api/consensus/enable   — enable the builtin-consensus plugin
 *   POST /api/consensus/disable  — disable the builtin-consensus plugin
 *
 * Data plane (works regardless of plugin enable state):
 *   GET  /api/consensus/topology          — get topology state machine snapshot
 *   POST /api/consensus/topology/force    — force topology state transition
 *   GET  /api/consensus/bpd/detect        — run BPD anomaly detection
 *   GET  /api/consensus/sac/reputation    — get SAC reputation board
 *   POST /api/consensus/sac/consensus     — compute SAC consensus
 *   POST /api/consensus/stopping/record   — record debate round for adaptive stopping
 *   GET  /api/consensus/stopping/summary  — get adaptive stopping summary
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { toErrorMessage } from './routeHelpers';
import { validateBody } from './validationMiddleware';
import { hasRole } from './userStore';
import {
  getHookManager,
  getTopologyStateMachine,
  getBPDDetector,
  getSACProtocol,
  getSharedAdaptiveStopping,
  getSharedCourtEval,
  type TopologyState,
} from '@praetor/core';

const CONSENSUS_PLUGIN_NAME = 'builtin-consensus';

const forceStateSchema = z.object({
  state: z.enum(['NORMAL', 'ALERT', 'LOCKDOWN', 'ESCALATE']),
  reason: z.string().min(1),
});

const sacConsensusSchema = z.object({
  // AUDIT-API14: bound compute inputs — unbounded passthrough arrays gave any
  // principal a CPU-DoS lever against computeConsensus.
  proposals: z.array(z.object({}).passthrough()).max(1000),
  evaluations: z.array(z.object({}).passthrough()).max(1000),
});

const stoppingRecordSchema = z.object({
  round: z.object({}).passthrough(),
});

/** Disabling process-global consensus requires an authenticated administrator. */
function requireConsensusAdmin(req: Request, res: Response, next: NextFunction): void {
  const principal = req.user?.id ?? req.apiKeyId;
  if (!principal) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const role = req.user?.role;
  const scopes = [...(req.apiScopes ?? []), ...(req.user?.scopes ?? [])];
  const hasConsensusScope =
    scopes.includes('consensus:admin') || scopes.includes('admin') || scopes.includes('*');
  if (!((role && hasRole(role, 'admin')) || hasConsensusScope)) {
    res.status(403).json({
      error: 'Consensus administration requires an admin role or consensus:admin scope',
    });
    return;
  }
  next();
}

function requireConsensusTenant(req: Request, res: Response, next: NextFunction): void {
  if (!req.tenantId) {
    res.status(403).json({ error: 'Tenant-bound authenticated identity required' });
    return;
  }
  next();
}

export function createConsensusRouter(): Router {
  const router = Router();

  // ── Control plane ────────────────────────────────────────────────────

  router.get('/api/consensus/status', (_req: Request, res: Response) => {
    try {
      const hm = getHookManager();
      const registered = hm.hasPlugin(CONSENSUS_PLUGIN_NAME);
      const enabled = hm.isEnabled(CONSENSUS_PLUGIN_NAME);
      const tsm = getTopologyStateMachine();
      res.json({
        plugin: CONSENSUS_PLUGIN_NAME,
        registered,
        enabled,
        topologyState: tsm.getState(),
        topologySnapshot: tsm.getSnapshot(),
      });
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error) });
    }
  });

  router.post('/api/consensus/enable', requireConsensusAdmin, (_req: Request, res: Response) => {
    try {
      const hm = getHookManager();
      if (!hm.hasPlugin(CONSENSUS_PLUGIN_NAME)) {
        res.status(404).json({ error: 'Consensus plugin is not registered' });
        return;
      }
      const ok = hm.enable(CONSENSUS_PLUGIN_NAME);
      res.json({ plugin: CONSENSUS_PLUGIN_NAME, enabled: true, ok });
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error) });
    }
  });

  router.post('/api/consensus/disable', requireConsensusAdmin, (_req: Request, res: Response) => {
    try {
      const hm = getHookManager();
      if (!hm.hasPlugin(CONSENSUS_PLUGIN_NAME)) {
        res.status(404).json({ error: 'Consensus plugin is not registered' });
        return;
      }
      const ok = hm.disable(CONSENSUS_PLUGIN_NAME);
      res.json({ plugin: CONSENSUS_PLUGIN_NAME, enabled: false, ok });
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error) });
    }
  });

  // ── Data plane ───────────────────────────────────────────────────────

  router.get('/api/consensus/topology', (_req: Request, res: Response) => {
    try {
      const tsm = getTopologyStateMachine();
      res.json(tsm.getSnapshot());
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error) });
    }
  });

  router.post(
    '/api/consensus/topology/force',
    requireConsensusAdmin,
    validateBody(forceStateSchema),
    (req: Request, res: Response) => {
      try {
        const tsm = getTopologyStateMachine();
        const state = req.body.state as TopologyState;
        tsm.forceState(state, req.body.reason);
        res.json({ ok: true, state: tsm.getState(), reason: req.body.reason });
      } catch (error) {
        res.status(500).json({ error: toErrorMessage(error) });
      }
    },
  );

  router.get('/api/consensus/bpd/detect', (_req: Request, res: Response) => {
    try {
      const bpd = getBPDDetector();
      const anomalies = bpd.detect();
      res.json({ anomalies, flaggedAgents: bpd.getFlaggedAgents() });
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error) });
    }
  });

  router.get('/api/consensus/sac/reputation', (_req: Request, res: Response) => {
    try {
      const sac = getSACProtocol();
      res.json({ reputationBoard: sac.getReputationBoard() });
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error) });
    }
  });

  router.post(
    '/api/consensus/sac/consensus',
    validateBody(sacConsensusSchema),
    (req: Request, res: Response) => {
      try {
        const sac = getSACProtocol();
        const result = sac.computeConsensus(req.body.proposals, req.body.evaluations);
        res.json(result);
      } catch (error) {
        res.status(500).json({ error: toErrorMessage(error) });
      }
    },
  );

  router.post(
    '/api/consensus/stopping/record',
    requireConsensusTenant,
    validateBody(stoppingRecordSchema),
    (req: Request, res: Response) => {
      try {
        const controller = getSharedAdaptiveStopping(req.tenantId);
        if (!controller) {
          res.status(503).json({ error: 'AdaptiveStopping controller not initialized' });
          return;
        }
        const result = controller.recordRound(req.body.round);
        res.json(result);
      } catch (error) {
        res.status(500).json({ error: toErrorMessage(error) });
      }
    },
  );

  router.get(
    '/api/consensus/stopping/summary',
    requireConsensusTenant,
    (req: Request, res: Response) => {
      try {
        const controller = getSharedAdaptiveStopping(req.tenantId);
        if (!controller) {
          res.status(503).json({ error: 'AdaptiveStopping controller not initialized' });
          return;
        }
        res.json(controller.getSummary());
      } catch (error) {
        res.status(500).json({ error: toErrorMessage(error) });
      }
    },
  );

  return router;
}
