/**
 * Governance Checkpoint HTTP Endpoints
 * REST API for checkpoint management
 */

import express, { Request, Response, Router } from 'express';
import { CheckpointManager, RiskScoreCalculator } from './governanceCheckpoint';
import type { GovernanceCheckpoint, CheckpointStats, RiskFactor } from './governanceCheckpoint';
import { MissionGovernanceMode, MissionRiskLevel } from '@praetor/core';
import { hasRole } from './userStore';

function requestTenant(req: Request): string | undefined {
  const bound = req.tenantId;
  const claim = req.user?.tenantId;
  if (req.user) {
    if (!claim || (bound && bound !== claim)) return undefined;
    return claim;
  }
  return req.apiKeyId ? bound : undefined;
}

function canCreateCheckpoint(req: Request): boolean {
  const role = req.user?.role;
  const scopes = req.apiScopes ?? req.user?.scopes ?? [];
  return (
    (!!role && hasRole(role, 'operator')) ||
    scopes.includes('governance:create') ||
    scopes.includes('admin') ||
    scopes.includes('*')
  );
}

function requireGovernanceOperator(req: Request, res: Response): string | null {
  const principal = req.user?.id ?? req.apiKeyId;
  if (!principal) {
    res.status(401).json({ error: 'Authentication required.' });
    return null;
  }
  const tenantId = requestTenant(req);
  const role = req.user?.role;
  const scopes = req.apiScopes ?? req.user?.scopes ?? [];
  const allowed =
    (!!role && hasRole(role, 'operator')) ||
    scopes.includes('governance:admin') ||
    scopes.includes('admin') ||
    scopes.includes('*');
  if (!tenantId || !allowed) {
    res.status(403).json({ error: 'Tenant-bound governance operator authority is required.' });
    return null;
  }
  return tenantId;
}

/**
 * Create Governance Checkpoint Router
 */
export function createGovernanceRouter(checkpointManager: CheckpointManager): Router {
  const router = express.Router();
  // Security: express.json() with limit is applied globally in index.ts.

  // GOV-3: the approver/rejecter identity must be the authenticated principal
  // (never a client-supplied reviewerId), and the principal must hold explicit
  // approve authority (admin role or an 'approve'/'admin'/'*' API-key scope).
  // Returns the principal id, or null after sending a 401/403.
  function resolveApprover(req: Request, res: Response): string | null {
    const principalId = req.user?.id ?? req.apiKeyId;
    if (!principalId) {
      res.status(401).json({ error: 'Authentication required to approve or reject.' });
      return null;
    }
    if (!requestTenant(req)) {
      res.status(403).json({ error: 'Tenant-bound identity required.' });
      return null;
    }
    const scopes = req.apiScopes ?? req.user?.scopes ?? [];
    const role = req.user?.role;
    const canApprove =
      (!!role && hasRole(role, 'admin')) ||
      scopes.includes('approve') ||
      scopes.includes('admin') ||
      scopes.includes('*');
    if (!canApprove) {
      res
        .status(403)
        .json({ error: 'Approve authority (admin role or approve scope) is required.' });
      return null;
    }
    return principalId;
  }

  /** GOV-3 inbox: list/detail scoped to authenticated principal. */
  function resolvePrincipalForInbox(req: Request, res: Response): string | null {
    const principalId = req.user?.id ?? req.apiKeyId;
    if (!principalId) {
      res.status(401).json({ error: 'Authentication required.' });
      return null;
    }
    if (!requestTenant(req)) {
      res.status(403).json({ error: 'Tenant-bound identity required.' });
      return null;
    }
    return principalId;
  }

  function canViewCheckpoint(
    checkpoint: GovernanceCheckpoint,
    principalId: string,
    tenantId: string,
  ): boolean {
    return (
      checkpoint.tenantId === tenantId &&
      (checkpoint.requiredApprovals.includes(principalId) ||
        checkpoint.context.agentId === principalId ||
        checkpoint.currentApprovals.some((a) => a.reviewerId === principalId))
    );
  }

  /**
   * POST /checkpoints
   * Create a new checkpoint
   */
  router.post('/checkpoints', (req: Request, res: Response) => {
    const {
      missionId,
      taskId,
      agentId,
      agentRole,
      taskDescription,
      governanceMode,
      riskScore,
      riskLevel,
      riskFactors,
      approvers,
      timeout,
    } = req.body;

    if (!missionId || !taskId || !agentId || !taskDescription) {
      return res.status(400).json({
        error: 'Missing required fields: missionId, taskId, agentId, taskDescription',
      });
    }
    const principal = resolvePrincipalForInbox(req, res);
    const tenantId = requestTenant(req);
    if (!principal || !tenantId) return;
    if (!canCreateCheckpoint(req)) {
      return res
        .status(403)
        .json({ error: 'Not authorized to create a checkpoint for this agent.' });
    }

    // GOV-4: never let client-supplied inputs drive auto-approval. Reject unknown
    // governance modes, default a missing mode to the safest (MANUAL, which always
    // requires human approval), and default a missing/invalid risk score to HIGH so
    // the fail-safe direction is "require approval" rather than "auto-approve".
    const VALID_MODES: MissionGovernanceMode[] = ['MANUAL', 'GUARDED', 'AUTO'];
    if (governanceMode !== undefined && !VALID_MODES.includes(governanceMode)) {
      return res.status(400).json({
        error: `Invalid governanceMode: ${String(governanceMode)}. Must be one of ${VALID_MODES.join(', ')}.`,
      });
    }
    const mode: MissionGovernanceMode = VALID_MODES.includes(governanceMode)
      ? governanceMode
      : 'MANUAL';
    const safeRiskScore =
      typeof riskScore === 'number' && Number.isFinite(riskScore) && riskScore >= 0
        ? riskScore
        : 100;
    const safeRiskLevel: MissionRiskLevel = riskLevel || 'HIGH';

    try {
      const checkpoint = checkpointManager.create(
        missionId,
        taskId,
        agentId,
        agentRole || 'agent',
        taskDescription,
        mode,
        safeRiskScore,
        safeRiskLevel,
        riskFactors || [],
        approvers || [],
        timeout,
        tenantId,
      );

      res.status(201).json(checkpoint);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  /**
   * GET /checkpoints/stats
   * Get checkpoint statistics
   *
   * LM-24 / api-management#L22: this static route must be registered BEFORE the
   * dynamic `GET /checkpoints/:id`. When it sat after, `GET /checkpoints/stats`
   * matched `:id` with `id === 'stats'`, `checkpointManager.get('stats')`
   * returned nothing, and the statistics endpoint answered 404
   * "Checkpoint not found" — the route was unreachable.
   */
  router.get('/checkpoints/stats', (req: Request, res: Response) => {
    const principal = resolvePrincipalForInbox(req, res);
    if (!principal) return;
    const { missionId } = req.query;
    const stats = checkpointManager.getStats(missionId as string, requestTenant(req));
    res.json(stats);
  });

  /**
   * GET /checkpoints/:id
   * Get checkpoint details
   */
  router.get('/checkpoints/:id', (req: Request, res: Response) => {
    const principal = resolvePrincipalForInbox(req, res);
    if (!principal) return;

    const checkpoint = checkpointManager.get(String(req.params.id));
    if (!checkpoint) {
      return res.status(404).json({ error: 'Checkpoint not found' });
    }
    const tenantId = requestTenant(req);
    if (!tenantId || checkpoint.tenantId !== tenantId) {
      return res.status(404).json({ error: 'Checkpoint not found' });
    }
    if (!canViewCheckpoint(checkpoint, principal, tenantId)) {
      return res.status(403).json({ error: 'Not authorized to view this checkpoint.' });
    }
    res.json(checkpoint);
  });

  /**
   * GET /checkpoints
   * List checkpoints with filters
   */
  router.get('/checkpoints', (req: Request, res: Response) => {
    const principal = resolvePrincipalForInbox(req, res);
    if (!principal) return;

    const { missionId, approverId, status } = req.query;

    if (approverId !== undefined && String(approverId) !== principal) {
      return res.status(403).json({
        error:
          'Cannot list pending approvals for a principal other than the authenticated identity.',
      });
    }

    // Never expose getAll / cross-mission pending — inbox is principal-scoped (GOV-3).
    let checkpoints = checkpointManager.getPendingForApprover(principal, requestTenant(req));
    if (missionId) {
      checkpoints = checkpoints.filter((c) => c.missionId === String(missionId));
    }

    if (status) {
      checkpoints = checkpoints.filter((c) => c.status === status);
    }

    res.json({ checkpoints, count: checkpoints.length });
  });

  /**
   * POST /checkpoints/:id/approve
   * Approve a checkpoint
   */
  router.post('/checkpoints/:id/approve', (req: Request, res: Response) => {
    // GOV-3: approver is the authenticated principal, never a body reviewerId.
    const approver = resolveApprover(req, res);
    if (!approver) return;
    const { reason, conditions } = req.body;

    try {
      const existing = checkpointManager.get(String(req.params.id));
      if (!existing) {
        return res.status(404).json({ error: 'Checkpoint not found' });
      }
      if (existing.tenantId !== requestTenant(req)) {
        return res.status(404).json({ error: 'Checkpoint not found' });
      }
      if (existing.context.agentId === approver) {
        return res.status(403).json({ error: 'You cannot approve your own checkpoint.' });
      }
      // GOV-4: admin role is not enough — must be listed in requiredApprovals.
      if (existing.requiredApprovals.length > 0 && !existing.requiredApprovals.includes(approver)) {
        return res.status(403).json({
          error: 'Approver is not listed in requiredApprovals for this checkpoint.',
        });
      }
      const checkpoint = checkpointManager.approve(
        String(req.params.id),
        approver,
        reason,
        conditions,
      );
      res.json(checkpoint);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  /**
   * POST /checkpoints/:id/reject
   * Reject a checkpoint
   */
  router.post('/checkpoints/:id/reject', (req: Request, res: Response) => {
    // GOV-3: rejecter is the authenticated principal, never a body reviewerId.
    const approver = resolveApprover(req, res);
    if (!approver) return;
    const { reason } = req.body;

    if (!reason) {
      return res.status(400).json({ error: 'Missing reason' });
    }

    try {
      const existing = checkpointManager.get(String(req.params.id));
      if (!existing) {
        return res.status(404).json({ error: 'Checkpoint not found' });
      }
      if (existing.tenantId !== requestTenant(req)) {
        return res.status(404).json({ error: 'Checkpoint not found' });
      }
      if (existing.context.agentId === approver) {
        return res.status(403).json({ error: 'You cannot reject your own checkpoint.' });
      }
      // GOV-4: same binding as approve — admin role alone is not enough.
      if (existing.requiredApprovals.length > 0 && !existing.requiredApprovals.includes(approver)) {
        return res.status(403).json({
          error: 'Rejecter is not listed in requiredApprovals for this checkpoint.',
        });
      }
      const checkpoint = checkpointManager.reject(String(req.params.id), approver, reason);
      res.json(checkpoint);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  /**
   * POST /checkpoints/:id/evidence
   * Add evidence to a checkpoint
   */
  router.post('/checkpoints/:id/evidence', (req: Request, res: Response) => {
    // GOV-3/GOV-4: evidence mutation requires an authenticated principal.
    const principal = resolvePrincipalForInbox(req, res);
    if (!principal) return;

    const { type, timestamp, content, source } = req.body;

    if (!type || !content || !source) {
      return res.status(400).json({
        error: 'Missing required fields: type, content, source',
      });
    }

    try {
      const existing = checkpointManager.get(String(req.params.id));
      if (!existing) {
        return res.status(404).json({ error: 'Checkpoint not found' });
      }
      const tenantId = requestTenant(req);
      if (!tenantId || existing.tenantId !== tenantId) {
        return res.status(404).json({ error: 'Checkpoint not found' });
      }
      if (!canViewCheckpoint(existing, principal, tenantId)) {
        return res
          .status(403)
          .json({ error: 'Not authorized to add evidence to this checkpoint.' });
      }
      const checkpoint = checkpointManager.addEvidence(String(req.params.id), {
        type,
        timestamp: timestamp || new Date().toISOString(),
        content,
        source,
      });
      res.json(checkpoint);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  /**
   * POST /checkpoints/check-expirations
   * Check and process expired checkpoints
   */
  router.post('/checkpoints/check-expirations', (req: Request, res: Response) => {
    const tenantId = requireGovernanceOperator(req, res);
    if (!tenantId) return;
    const expired = checkpointManager.checkExpirations(tenantId);
    res.json({
      message: `Processed ${expired.length} expired checkpoints`,
      expired,
    });
  });

  /**
   * POST /risk-score/calculate
   * Calculate risk score for a task
   */
  router.post('/risk-score/calculate', (req: Request, res: Response) => {
    const { governanceMode, riskLevel, operations, dataSensitivity } = req.body;

    if (!riskLevel || !operations) {
      return res.status(400).json({
        error: 'Missing required fields: riskLevel, operations',
      });
    }

    const score = RiskScoreCalculator.calculate(
      governanceMode || 'SINGLE',
      riskLevel,
      operations,
      dataSensitivity || 'internal',
    );

    const level = RiskScoreCalculator.scoreToLevel(score);

    res.json({
      riskScore: score,
      riskLevel: level,
      governanceMode: governanceMode || 'SINGLE',
      operations,
      dataSensitivity: dataSensitivity || 'internal',
    });
  });

  /**
   * GET /pending-approvals
   * Get all pending approvals for a reviewer
   */
  router.get('/pending-approvals', (req: Request, res: Response) => {
    const principal = resolvePrincipalForInbox(req, res);
    if (!principal) return;

    const { reviewerId } = req.query;
    if (reviewerId !== undefined && String(reviewerId) !== principal) {
      return res.status(403).json({
        error:
          'Cannot list pending approvals for a principal other than the authenticated identity.',
      });
    }

    const pending = checkpointManager.getPendingForApprover(principal, requestTenant(req));
    res.json({ pending, count: pending.length });
  });

  return router;
}

/**
 * Export types for external use
 */
export type { GovernanceCheckpoint, CheckpointStats, RiskFactor };
