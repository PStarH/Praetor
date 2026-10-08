import {
  reportSilentFailure,
  SSEStream,
  getMessageBus,
  type MessageBusTopic,
} from '@praetor/core';
import { assertSameTenant, getCurrentTenantId } from '@praetor/core/runtime/tenantContext';
import { Router, type Request, type Response } from 'express';
import { isAbsolute, join, relative, resolve } from 'path';
import { existsSync, readdirSync, readFileSync } from 'fs';
import {
  CheckpointManager as SagaCheckpointManager,
  FileSagaStore,
  type SagaStateSnapshot,
  type SagaEvent,
} from '@praetor/core/saga';
import { hasRole } from './userStore';

const DATA_DIR = process.env.COMMANDER_SAGA_DATA ?? join(process.cwd(), '.commander', 'sagas');
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,126}$/;

function isValidRunId(runId: unknown): runId is string {
  return (
    typeof runId === 'string' &&
    runId.length > 0 &&
    runId.length < 128 &&
    RUN_ID_PATTERN.test(runId)
  );
}

function buildSagaProjection(): SagaCheckpointManager {
  return new SagaCheckpointManager(new FileSagaStore({ baseDir: DATA_DIR }));
}

function readSnapshot(runId: string): SagaStateSnapshot | undefined {
  if (!isValidRunId(runId)) return undefined;
  const root = resolve(DATA_DIR);
  const path = resolve(root, runId, 'snapshot.json');
  const fromRoot = relative(root, path);
  if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) return undefined;
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as SagaStateSnapshot;
  } catch (err) {
    reportSilentFailure(err, 'sagaEndpoints:38');
    return undefined;
  }
}

interface SagaPrincipal {
  id: string;
  tenantId: string;
  isAdmin: boolean;
}

type OwnedSagaSnapshot = SagaStateSnapshot & { ownerId?: string };

function requireSagaPrincipal(req: Request, res: Response): SagaPrincipal | null {
  const id = req.user?.id ?? req.apiKeyId;
  if (!id) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }
  const active = getCurrentTenantId();
  const bound = req.tenantId;
  const claim = req.user?.tenantId;
  if (req.user && (!claim || (bound && bound !== claim))) {
    res.status(403).json({ error: 'Tenant context mismatch' });
    return null;
  }
  const requested = req.user ? claim : bound;
  if (active && requested && active !== requested) {
    res.status(403).json({ error: 'Tenant context mismatch' });
    return null;
  }
  const tenantId = active ?? requested;
  if (!tenantId) {
    res.status(401).json({ error: 'Authenticated tenant context required' });
    return null;
  }
  try {
    if (active && requested) assertSameTenant(requested);
    const role = req.user?.role;
    return { id, tenantId, isAdmin: !!role && hasRole(role, 'admin') };
  } catch {
    res.status(403).json({ error: 'Tenant context mismatch' });
    return null;
  }
}

function canReadSnapshot(snapshot: OwnedSagaSnapshot, principal: SagaPrincipal): boolean {
  if (snapshot.tenantId !== principal.tenantId) return false;
  try {
    if (getCurrentTenantId()) assertSameTenant(snapshot.tenantId);
    return principal.isAdmin || (!!snapshot.ownerId && snapshot.ownerId === principal.id);
  } catch {
    return false;
  }
}

function executionRemoved(res: import('express').Response): void {
  res.status(410).json({
    error: {
      code: 'LEGACY_EXECUTION_DISABLED',
      message: 'Process-local saga execution has been removed from the API.',
      replacement: 'POST /v1/runs',
    },
  });
}

function buildTimeline(snapshot: SagaStateSnapshot, events: SagaEvent[]) {
  return events.map((ev) => ({
    kind: ev.kind,
    timestamp: ev.timestamp,
    nodeId: (ev.nodeId as string) ?? undefined,
    name: (ev.name as string) ?? undefined,
    state: snapshot.nodeStates[(ev.nodeId as string) ?? ''] ?? undefined,
    attempt: (ev.attempt as number) ?? undefined,
    error: (ev.error as string) ?? undefined,
  }));
}

export function createSagaRouter(): Router {
  const router = Router();

  router.get('/api/saga/runs', async (req, res) => {
    const principal = requireSagaPrincipal(req, res);
    if (!principal) return;
    if (!existsSync(DATA_DIR)) {
      return res.json({ runs: [] });
    }
    const entries = readdirSync(DATA_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => {
        const snap = readSnapshot(e.name);
        if (!snap || !canReadSnapshot(snap, principal)) return null;
        // `sagaName` is not part of the core SagaStateSnapshot type but is
        // persisted on disk by older saga writers. Read it as an optional
        // bag-of-record field via a narrow cast — keeps the endpoint
        // backwards-compatible without rewriting the snapshot schema.
        const enriched = snap as SagaStateSnapshot & { sagaName?: string };
        return {
          runId: e.name,
          state: snap.state,
          sagaName: enriched.sagaName,
          updatedAt: snap.updatedAt,
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    res.json({ runs: entries });
  });

  router.get('/api/saga/runs/:runId', async (req, res) => {
    const principal = requireSagaPrincipal(req, res);
    if (!principal) return;
    const { runId } = req.params;
    if (!isValidRunId(runId)) return res.status(400).json({ error: 'Invalid runId format' });
    const recovered = await buildSagaProjection().recover(runId);
    if (!recovered || !canReadSnapshot(recovered.snapshot, principal)) {
      return res.status(404).json({ error: 'Run not found' });
    }
    res.json({
      runId,
      snapshot: recovered.snapshot,
      events: recovered.allEvents,
      eventsAfterSnapshot: recovered.eventsAfterSnapshot,
    });
  });

  router.get('/api/saga/runs/:runId/timeline', async (req, res) => {
    const principal = requireSagaPrincipal(req, res);
    if (!principal) return;
    const { runId } = req.params;
    if (!isValidRunId(runId)) return res.status(400).json({ error: 'Invalid runId format' });
    const recovered = await buildSagaProjection().recover(runId);
    if (!recovered || !canReadSnapshot(recovered.snapshot, principal)) {
      return res.status(404).json({ error: 'Run not found' });
    }
    res.json({
      runId,
      snapshot: recovered.snapshot,
      timeline: buildTimeline(recovered.snapshot, recovered.allEvents),
    });
  });

  router.use('/api/saga/runs/:runId/resume', (_req, res) => {
    executionRemoved(res);
  });

  router.use('/api/saga/runs/:runId/fork', (_req, res) => {
    executionRemoved(res);
  });

  router.get('/api/saga/stream/:runId', async (req, res) => {
    const principal = requireSagaPrincipal(req, res);
    if (!principal) return;
    const { runId } = req.params;
    if (!isValidRunId(runId)) return res.status(400).json({ error: 'Invalid runId format' });
    const snapshot = readSnapshot(runId);
    if (!snapshot || !canReadSnapshot(snapshot, principal)) {
      return res.status(404).json({ error: 'Run not found' });
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const stream = new (
      SSEStream as unknown as new () => {
        pipe: (r: NodeJS.WritableStream) => void;
        emitStructured: (event: string, payload: unknown) => void;
        close: () => void;
      }
    )();
    stream.pipe(res);

    const bus = getMessageBus();
    const unsubCompleted = bus.subscribe('saga.completed' as MessageBusTopic, (msg) => {
      const payload = msg.payload as { runId?: string; status?: string } | undefined;
      if (payload?.runId === runId) {
        stream.emitStructured('saga.completed', payload);
      }
    });
    const unsubFailed = bus.subscribe('saga.failed' as MessageBusTopic, (msg) => {
      const payload = msg.payload as { runId?: string; error?: string } | undefined;
      if (payload?.runId === runId) {
        stream.emitStructured('saga.failed', payload);
      }
    });

    req.on('close', () => {
      unsubCompleted();
      unsubFailed();
      stream.close();
    });
  });

  return router;
}
