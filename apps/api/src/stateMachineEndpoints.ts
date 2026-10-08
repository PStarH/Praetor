/**
 * State Machine API Endpoints
 * REST API for managing agent state machines
 *
 * PERSISTENCE NOTE (audit MED item 2): the module-level Map<taskId, StateMachine>
 * below loses every in-flight task on API process restart. The migration to a
 * PersistentDriver-backed table (ess-001 Phase-1 storage) was attempted but
 * blocked by the workspace package-build boundary: apps/api resolves
 * `@praetor/core` from packages/core/dist/ (the precompiled declarations)
 * rather than packages/core/src/, so new methods added to the in-package
 * StateMachine class don't propagate until the package is rebuilt AND the
 * new PersistentDriver symbols are re-exported from src/index.ts.
 *
 * Until that rebuild lands, this endpoint keeps the original Map semantics.
 * Restart-safety item is tracked separately; ship path requires either
 *   (a) `pnpm --filter @praetor/core build` to regenerate dist,
 *   (b) flip apps/api/tsconfig `paths` to point at source, or
 *   (c) declare module '@praetor/core' augmentation in apps/api.
 */

import express, { type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { hasRole } from './userStore';
import { v4 as uuidv4 } from 'uuid';
import {
  StateMachine,
  StateMachineFactory,
  AgentState,
  GovernanceCheckpoint,
} from './stateMachine';
import { validateBody } from './validationMiddleware';
import { stateMachineCreateBody, resumeFromCheckpointBody } from './schemas';
import { isLegacyExecutionAllowed, legacyExecutionDisabledReason } from './legacyExecutionGuard';
import { readJsonFileSafe } from './atomicWrite';
import { getDirname } from './esmCompat';

const router: express.Router = express.Router();
const STATE_MACHINE_DIR = path.resolve(getDirname(import.meta.url), '../data/state-machines');
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

function refuseIfLegacyDisabled(res: Response): boolean {
  if (isLegacyExecutionAllowed()) return false;
  res.status(410).json({
    error: {
      code: 'LEGACY_EXECUTION_DISABLED',
      message: legacyExecutionDisabledReason(),
      replacement: 'POST /v1/runs',
    },
  });
  return true;
}

// In-memory task state machines are not the V2 run/step authority (contracts +
// kernel). Same choke point as pipelineEndpoints: only local compatibility mode.
// GOV-3 approve/reject skip this gate so auth fails closed with 401/403 before
// advertising Gone (410); those handlers call refuseIfLegacyDisabled after auth.
router.use((req, res, next) => {
  if (req.method === 'POST' && /^\/[^/]+\/(approve|reject)\/?$/.test(req.path)) {
    next();
    return;
  }
  if (refuseIfLegacyDisabled(res)) return;
  next();
});

// In-memory state machine instances (for demo; production should use proper storage)
type StateMachineEntry = { machine: StateMachine; tenantId?: string; ownerId?: string };
const stateMachines: Map<string, StateMachineEntry> = new Map();

function principalId(req: Request): string | undefined {
  return req.user?.id ?? req.apiKeyId;
}

function principalTenant(req: Request): string | undefined {
  return req.user?.tenantId ?? req.tenantId;
}

function canAccessMachine(
  req: Request,
  entry: Pick<StateMachineEntry, 'tenantId' | 'ownerId'>,
): boolean {
  if (req.user && hasRole(req.user.role, 'super_admin')) return true;
  const principal = principalId(req);
  const tenant = principalTenant(req);
  if (!principal || !tenant || !entry.tenantId) return false;
  return (
    entry.tenantId === tenant &&
    ((!!req.user && hasRole(req.user.role, 'admin')) || entry.ownerId === principal)
  );
}

function getMachine(req: Request, res: Response): StateMachine | null {
  const entry = stateMachines.get(String(req.params.taskId));
  if (!entry || !canAccessMachine(req, entry)) {
    res.status(404).json({ error: 'State machine not found' });
    return null;
  }
  return entry.machine;
}

function refuseDuplicateDestination(req: Request, res: Response, taskId: string): boolean {
  if (!TASK_ID_RE.test(taskId)) {
    res.status(400).json({ error: 'Invalid taskId format' });
    return true;
  }
  const inMemory = stateMachines.get(taskId);
  const root = path.resolve(STATE_MACHINE_DIR);
  const stateFile = path.resolve(root, `${taskId}.json`);
  const fromRoot = path.relative(root, stateFile);
  if (fromRoot.startsWith('..') || path.isAbsolute(fromRoot)) {
    res.status(400).json({ error: 'Invalid taskId format' });
    return true;
  }
  const persisted =
    !inMemory && fs.existsSync(stateFile)
      ? readJsonFileSafe<AgentState | null>(stateFile, null)
      : null;
  const existing =
    inMemory ??
    (persisted
      ? { tenantId: persisted.ownership?.tenantId, ownerId: persisted.ownership?.ownerId }
      : undefined);
  if (!existing) return false;
  if (!canAccessMachine(req, existing)) {
    res.status(404).json({ error: 'State machine not found' });
  } else {
    res.status(409).json({ error: 'State machine already exists' });
  }
  return true;
}

function resolveApprover(req: Request, res: Response): string | null {
  const principalId = req.user?.id ?? req.apiKeyId;
  if (!principalId) {
    res.status(401).json({ error: 'Authentication required to approve or reject.' });
    return null;
  }
  const scopes = req.apiScopes ?? [];
  const role = req.user?.role;
  const canApprove =
    role === 'admin' ||
    role === 'super_admin' ||
    scopes.includes('approve') ||
    scopes.includes('admin') ||
    scopes.includes('*');
  if (!canApprove) {
    res.status(403).json({ error: 'Approve authority (admin role or approve scope) is required.' });
    return null;
  }
  return principalId;
}

/**
 * POST /api/state-machine/create
 * Create a new state machine for a task
 * Security: Validate input with Zod schema to prevent type confusion.
 */
router.post('/create', validateBody(stateMachineCreateBody), (req, res) => {
  try {
    const { taskId, projectId, agentId, type = 'standard' } = req.body;

    if (!taskId || !projectId || !agentId) {
      return res.status(400).json({
        error: 'Missing required fields: taskId, projectId, agentId',
      });
    }
    if (refuseDuplicateDestination(req, res, taskId)) return;

    const sm = StateMachineFactory.create(type as 'standard' | 'research');
    const tenantId = principalTenant(req);
    const ownerId = principalId(req);
    const state = sm.initialize(
      taskId,
      projectId,
      agentId,
      tenantId ? { tenantId, ownerId } : undefined,
    );

    stateMachines.set(taskId, {
      machine: sm,
      tenantId,
      ownerId,
    });

    res.json({
      success: true,
      taskId,
      state: {
        currentStep: state.currentStep,
        governanceMode: state.governanceMode,
        metadata: state.metadata,
      },
    });
  } catch (error) {
    process.stderr.write(
      `[StateMachineEndpoints] Error creating state machine: ${(error as Error)?.message ?? String(error)}\n`,
    );
    res.status(500).json({ error: 'Failed to create state machine' });
  }
});

/**
 * GET /api/state-machine/types
 * Get available state machine types
 *
 * LM-23 / API-C03: this must be registered BEFORE the dynamic `/:taskId` route.
 * When it sat after, `GET /types` matched `/:taskId` with `taskId === 'types'`,
 * `getMachine()` found no such machine, and the catalogue was answered with a
 * 404 "State machine not found" — the static route was unreachable.
 */
router.get('/types', (req, res) => {
  res.json({
    success: true,
    types: StateMachineFactory.getAvailableTypes(),
  });
});

/**
 * GET /api/state-machine/:taskId
 * Get current state of a state machine
 */
router.get('/:taskId', (req, res) => {
  try {
    const { taskId } = req.params;
    const sm = getMachine(req, res);
    if (!sm) return;

    const state = sm.getState();
    res.json({
      success: true,
      state: state
        ? {
            currentStep: state.currentStep,
            governanceMode: state.governanceMode,
            memory: {
              taskId: state.memory.taskId,
              projectId: state.memory.projectId,
              historyCount: state.memory.history.length,
            },
            metadata: state.metadata,
          }
        : null,
      availableTransitions: sm.getAvailableTransitions().map((t) => ({
        id: t.id,
        to: t.to,
        governanceRequired: t.governanceRequired,
      })),
      isTerminal: sm.isTerminal(),
    });
  } catch (error) {
    process.stderr.write(
      `[StateMachineEndpoints] Error getting state: ${(error as Error)?.message ?? String(error)}\n`,
    );
    res.status(500).json({ error: 'Failed to get state' });
  }
});

/**
 * POST /api/state-machine/:taskId/transition
 * Execute a state transition
 */
router.post('/:taskId/transition', async (req, res) => {
  try {
    const { taskId } = req.params;
    const { toState, context } = req.body;

    const sm = getMachine(req, res);
    if (!sm) return;

    if (!toState) {
      return res.status(400).json({ error: 'Missing required field: toState' });
    }

    const result = await sm.transition(toState, context);

    if (result.success) {
      res.json({
        success: true,
        state: {
          currentStep: result.state!.currentStep,
          governanceMode: result.state!.governanceMode,
          metadata: result.state!.metadata,
        },
      });
    } else {
      if (result.error?.includes('Governance checkpoint pending')) {
        const pendingCheckpoints = sm.getPendingCheckpoints();
        res.json({
          success: false,
          pendingApproval: true,
          checkpoint:
            pendingCheckpoints.length > 0
              ? {
                  id: pendingCheckpoints[0].id,
                  mode: pendingCheckpoints[0].mode,
                  riskScore: pendingCheckpoints[0].riskScore,
                }
              : null,
          error: result.error,
        });
      } else {
        res.status(400).json({
          success: false,
          error: result.error,
        });
      }
    }
  } catch (error) {
    process.stderr.write(
      `[StateMachineEndpoints] Error executing transition: ${(error as Error)?.message ?? String(error)}\n`,
    );
    res.status(500).json({ error: 'Failed to execute transition' });
  }
});

/**
 * POST /api/state-machine/:taskId/approve
 * Approve a governance checkpoint
 */
router.post('/:taskId/approve', (req, res) => {
  try {
    // GOV-3: auth before legacy Gone — unauth/forbidden must not be masked as 410.
    const approver = resolveApprover(req, res);
    if (!approver) return;
    if (refuseIfLegacyDisabled(res)) return;

    const { taskId } = req.params;
    const { checkpointId, comment } = req.body;

    const sm = getMachine(req, res);
    if (!sm) return;

    if (!checkpointId) {
      return res.status(400).json({ error: 'Missing required field: checkpointId' });
    }

    const approved = sm.approveCheckpoint(checkpointId, approver, comment);
    res.json({
      success: approved,
      message: approved ? 'Checkpoint approved' : 'Checkpoint not found or already resolved',
    });
  } catch (error) {
    process.stderr.write(
      `[StateMachineEndpoints] Error approving checkpoint: ${(error as Error)?.message ?? String(error)}\n`,
    );
    res.status(500).json({ error: 'Failed to approve checkpoint' });
  }
});

/**
 * POST /api/state-machine/:taskId/reject
 * Reject a governance checkpoint
 */
router.post('/:taskId/reject', (req, res) => {
  try {
    // GOV-3: auth before legacy Gone — unauth/forbidden must not be masked as 410.
    const approver = resolveApprover(req, res);
    if (!approver) return;
    if (refuseIfLegacyDisabled(res)) return;

    const { taskId } = req.params;
    const { checkpointId, comment } = req.body;

    const sm = getMachine(req, res);
    if (!sm) return;

    if (!checkpointId) {
      return res.status(400).json({ error: 'Missing required field: checkpointId' });
    }

    const rejected = sm.rejectCheckpoint(checkpointId, approver, comment);
    res.json({
      success: rejected,
      message: rejected ? 'Checkpoint rejected' : 'Checkpoint not found or already resolved',
    });
  } catch (error) {
    process.stderr.write(
      `[StateMachineEndpoints] Error rejecting checkpoint: ${(error as Error)?.message ?? String(error)}\n`,
    );
    res.status(500).json({ error: 'Failed to reject checkpoint' });
  }
});

/**
 * GET /api/state-machine/:taskId/memory
 * Get memory entries for a state machine
 */
router.get('/:taskId/memory', (req, res) => {
  try {
    const { taskId } = req.params;
    const { type } = req.query;

    const sm = getMachine(req, res);
    if (!sm) return;

    const state = sm.getState();
    if (!state) {
      return res.status(404).json({ error: 'No active state' });
    }

    let entries = state.memory.history;
    if (type && typeof type === 'string') {
      entries = entries.filter((e) => e.type === type);
    }

    res.json({
      success: true,
      taskId,
      memory: {
        projectId: state.memory.projectId,
        agentId: state.memory.agentId,
        summary: state.memory.summary,
        entries: entries.map((e) => ({
          timestamp: e.timestamp,
          type: e.type,
          content: e.content,
        })),
      },
    });
  } catch (error) {
    process.stderr.write(
      `[StateMachineEndpoints] Error getting memory: ${(error as Error)?.message ?? String(error)}\n`,
    );
    res.status(500).json({ error: 'Failed to get memory' });
  }
});

/**
 * POST /api/state-machine/:taskId/memory
 * Add a memory entry
 */
router.post('/:taskId/memory', (req, res) => {
  try {
    const { type, content, metadata } = req.body;

    const sm = getMachine(req, res);
    if (!sm) return;

    if (!type || !content) {
      return res.status(400).json({ error: 'Missing required fields: type, content' });
    }

    sm.addMemoryEntry(type, content, metadata);

    res.json({
      success: true,
      message: 'Memory entry added',
    });
  } catch (error) {
    process.stderr.write(
      `[StateMachineEndpoints] Error adding memory: ${(error as Error)?.message ?? String(error)}\n`,
    );
    res.status(500).json({ error: 'Failed to add memory' });
  }
});

/**
 * POST /api/state-machine/:taskId/resume
 * Resume from a checkpoint
 * Security: Validate input with Zod schema — checkpointId format prevents path traversal.
 */
router.post('/:taskId/resume', validateBody(resumeFromCheckpointBody), (req, res) => {
  try {
    const taskId = String(req.params.taskId);
    const { checkpointId } = req.body;
    if (refuseDuplicateDestination(req, res, taskId)) return;

    // checkpointId format already validated by Zod schema (resumeFromCheckpointBody)

    // Create new state machine and resume
    const sm = StateMachineFactory.create('standard');
    const state = sm.resumeFromCheckpoint(checkpointId, (candidate) =>
      canAccessMachine(req, {
        tenantId: candidate.ownership?.tenantId,
        ownerId: candidate.ownership?.ownerId,
      }),
    );

    if (!state) {
      return res.status(404).json({ error: 'Checkpoint not found' });
    }

    stateMachines.set(taskId, {
      machine: sm,
      tenantId: state.ownership?.tenantId,
      ownerId: state.ownership?.ownerId,
    });

    res.json({
      success: true,
      taskId,
      state: {
        currentStep: state.currentStep,
        governanceMode: state.governanceMode,
        metadata: state.metadata,
      },
    });
  } catch (error) {
    process.stderr.write(
      `[StateMachineEndpoints] Error resuming from checkpoint: ${(error as Error)?.message ?? String(error)}\n`,
    );
    res.status(500).json({ error: 'Failed to resume from checkpoint' });
  }
});

/**
 * GET /api/state-machine/:taskId/summary
 * Get state machine summary
 */
router.get('/:taskId/summary', (req, res) => {
  try {
    const sm = getMachine(req, res);
    if (!sm) return;

    res.json({
      success: true,
      summary: sm.generateSummary(),
    });
  } catch (error) {
    process.stderr.write(
      `[StateMachineEndpoints] Error getting summary: ${(error as Error)?.message ?? String(error)}\n`,
    );
    res.status(500).json({ error: 'Failed to get summary' });
  }
});

export default router;
