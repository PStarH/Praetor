import { reportSilentFailure } from '@praetor/core';
import {
  assertSameTenant,
  getCurrentTenantId,
  tenantPathSegment,
} from '@praetor/core/runtime/tenantContext';
import { Router, type Request } from 'express';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';

// ── Types ──────────────────────────────────────────────────────────────────

interface TokenUsage {
  totalTokens: number;
}

interface ReplayRunSummary {
  runId: string;
  agentId: string;
  missionId?: string;
  goal?: string;
  model?: string;
  status: 'completed' | 'failed';
  phase: string;
  startedAt: string;
  completedAt?: string;
  totalEvents: number;
  totalTokens: number;
  durationMs: number;
  stepCount: number;
}

interface TraceEvent {
  id: string;
  spanId: string;
  traceId: string;
  runId: string;
  agentId: string;
  type: string;
  timestamp: string;
  durationMs: number;
  data: Record<string, unknown>;
  parentSpanId?: string;
}

interface TokenUsage {
  totalTokens: number;
}

interface CheckpointFile {
  agentId?: string;
  missionId?: string;
  context?: { goal?: string };
  phase: string;
  timestamp: string;
  totalDurationMs?: number;
  stepNumber?: number;
  [key: string]: unknown;
}

interface RunManifest {
  agentId?: string;
  missionId?: string;
  goal?: string;
  model?: string;
  timestamp?: string;
  [key: string]: unknown;
}

// ── Helpers ────────────────────────────────────────────────────────────────

interface ReplayDir {
  stateDir: string;
  tracesDir: string;
  samplesDir: string;
}

interface LocatedCheckpoint {
  checkpoint: CheckpointFile;
  dirs: ReplayDir;
}

function requireTenant(req: Request): string | null {
  const active = getCurrentTenantId();
  const requested = req.tenantId;
  if (active && requested && active !== requested) return null;
  const tenantId = active ?? requested;
  if (!tenantId) return null;
  try {
    if (active && requested) assertSameTenant(requested);
    return tenantId;
  } catch {
    return null;
  }
}

function findBaseDirs(req: Request): ReplayDir[] {
  const cwd = process.cwd();
  const root = {
    stateDir: path.join(cwd, '.commander_state'),
    tracesDir: path.join(cwd, '.commander_traces'),
    samplesDir: path.join(cwd, '.commander_samples'),
  };
  const tenantId = requireTenant(req);
  if (!tenantId) return [];

  const segment = tenantPathSegment(tenantId);
  return [
    {
      stateDir: path.join(root.stateDir, segment),
      tracesDir: path.join(root.tracesDir, segment),
      samplesDir: path.join(root.samplesDir, segment),
    },
  ];
}

function requireTenantResponse(req: Request, res: { status: (code: number) => any }): boolean {
  if (requireTenant(req)) return true;
  const active = getCurrentTenantId();
  const mismatched = active && req.tenantId && active !== req.tenantId;
  res.status(mismatched ? 403 : 401).json({
    error: mismatched ? 'Tenant context mismatch' : 'Authenticated tenant context required',
  });
  return false;
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(process.cwd()) + path.sep)) return null;
  try {
    await fsp.access(resolved);
    return JSON.parse(await fsp.readFile(resolved, 'utf-8')) as T;
  } catch (err) {
    reportSilentFailure(err, 'replayEndpoints:readJsonFile');
    return null;
  }
}

async function readCheckpointFile(filePath: string): Promise<CheckpointFile | null> {
  return readJsonFile<CheckpointFile>(filePath);
}

async function readManifestFile(filePath: string): Promise<RunManifest | null> {
  return readJsonFile<RunManifest>(filePath);
}

async function readNdjsonFile(filePath: string): Promise<TraceEvent[]> {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(process.cwd()) + path.sep)) return [];
  try {
    await fsp.access(resolved);
    const raw = (await fsp.readFile(resolved, 'utf-8')).trim();
    if (!raw) return [];
    const events: TraceEvent[] = [];
    for (const line of raw.split('\n')) {
      try {
        events.push(JSON.parse(line));
      } catch (err) {
        reportSilentFailure(err, 'replayEndpoints:68');
        /* skip corrupt lines */
      }
    }
    return events;
  } catch (err) {
    reportSilentFailure(err, 'replayEndpoints:74');
    return [];
  }
}

async function locateCheckpoint(req: Request, runId: string): Promise<LocatedCheckpoint | null> {
  for (const dirs of findBaseDirs(req)) {
    for (const filePath of [
      path.join(dirs.stateDir, 'completed', `${runId}.json`),
      path.join(dirs.stateDir, `${runId}.checkpoint`),
    ]) {
      const checkpoint = await readCheckpointFile(filePath);
      if (checkpoint) {
        return { checkpoint, dirs };
      }
    }
  }
  return null;
}

// ── Validation ─────────────────────────────────────────────────────────────

const RUN_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
function isValidRunId(runId: string): boolean {
  return (
    typeof runId === 'string' &&
    runId.length > 0 &&
    runId.length < 128 &&
    RUN_ID_PATTERN.test(runId)
  );
}

// ── Router ─────────────────────────────────────────────────────────────────

export function createReplayRouter(): Router {
  const router = Router();

  // ── List all completed runs ────────────────────────────────────────────
  router.get('/api/replay/runs', async (req, res) => {
    if (!requireTenantResponse(req, res)) return;
    const runs: ReplayRunSummary[] = [];

    for (const dirs of findBaseDirs(req)) {
      // Scan completed checkpoints
      try {
        let files: string[] = [];
        const completedDir = path.join(dirs.stateDir, 'completed');
        try {
          files = (await fsp.readdir(completedDir)).filter((f) => f.endsWith('.json'));
        } catch (err) {
          reportSilentFailure(err, 'replayEndpoints:109');
          /* dir may not exist */
        }
        for (const file of files) {
          const runId = file.replace(/\.json$/, '');
          if (runs.some((run) => run.runId === runId)) continue;
          const checkpoint = await readCheckpointFile(path.join(completedDir, file));
          if (!checkpoint) continue;

          const [events, manifest] = await Promise.all([
            readNdjsonFile(path.join(dirs.tracesDir, `${runId}.ndjson`)),
            readManifestFile(path.join(dirs.samplesDir, 'runs', `${runId}.json`)),
          ]);

          const totalTokens = events.reduce((sum, event) => {
            const usage = event.data?.tokenUsage as TokenUsage | undefined;
            return sum + (usage?.totalTokens ?? 0);
          }, 0);

          runs.push({
            runId,
            agentId: checkpoint.agentId ?? manifest?.agentId ?? 'unknown',
            missionId: checkpoint.missionId ?? manifest?.missionId,
            goal: checkpoint.context?.goal ?? manifest?.goal,
            model: manifest?.model,
            status: checkpoint.phase === 'completed' ? 'completed' : 'failed',
            phase: checkpoint.phase,
            startedAt: manifest?.timestamp ?? checkpoint.timestamp,
            completedAt:
              checkpoint.phase === 'completed' || checkpoint.phase === 'failed'
                ? checkpoint.timestamp
                : undefined,
            totalEvents: events.length,
            totalTokens,
            durationMs: checkpoint.totalDurationMs ?? 0,
            stepCount: checkpoint.stepNumber ?? 0,
          });
        }
      } catch (err) {
        reportSilentFailure(err, 'replayEndpoints:147');
        /* ignore scan errors */
      }

      // Also scan in-flight checkpoints (not yet completed)
      try {
        let files: string[] = [];
        try {
          files = (await fsp.readdir(dirs.stateDir)).filter((f) => f.endsWith('.checkpoint'));
        } catch (err) {
          reportSilentFailure(err, 'replayEndpoints:157');
          /* dir may not exist */
        }
        for (const file of files) {
          const runId = file.replace(/\.checkpoint$/, '');
          if (runs.some((run) => run.runId === runId)) continue;

          const [checkpoint, events] = await Promise.all([
            readCheckpointFile(path.join(dirs.stateDir, file)),
            readNdjsonFile(path.join(dirs.tracesDir, `${runId}.ndjson`)),
          ]);
          if (!checkpoint) continue;

          runs.push({
            runId,
            agentId: checkpoint.agentId ?? 'unknown',
            missionId: checkpoint.missionId,
            goal: checkpoint.context?.goal,
            status: checkpoint.phase === 'failed' ? 'failed' : 'completed',
            phase: checkpoint.phase,
            startedAt: checkpoint.timestamp,
            totalEvents: events.length,
            totalTokens: 0,
            durationMs: checkpoint.totalDurationMs ?? 0,
            stepCount: checkpoint.stepNumber ?? 0,
          });
        }
      } catch (err) {
        reportSilentFailure(err, 'replayEndpoints:185');
        /* ignore */
      }
    }

    // Sort by timestamp descending
    runs.sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));

    res.json({ runs, total: runs.length });
  });

  // ── Get single run detail ──────────────────────────────────────────────
  router.get('/api/replay/runs/:runId', async (req, res) => {
    if (!requireTenantResponse(req, res)) return;
    const { runId } = req.params;
    if (!isValidRunId(runId)) return res.status(400).json({ error: 'Invalid runId format' });

    const located = await locateCheckpoint(req, runId);
    const checkpoint = located?.checkpoint;
    let status: 'completed' | 'failed' = 'completed';
    if (checkpoint && checkpoint.phase === 'failed') status = 'failed';

    if (!checkpoint) {
      return res.status(404).json({ error: 'Run not found' });
    }

    const [manifest, events] = await Promise.all([
      readManifestFile(path.join(located!.dirs.samplesDir, 'runs', `${runId}.json`)),
      readNdjsonFile(path.join(located!.dirs.tracesDir, `${runId}.ndjson`)),
    ]);

    const totalTokens = events.reduce((sum, e) => {
      const usage = e.data?.tokenUsage as TokenUsage | undefined;
      return sum + (usage?.totalTokens ?? 0);
    }, 0);

    const run: ReplayRunSummary = {
      runId,
      agentId: checkpoint.agentId ?? manifest?.agentId ?? 'unknown',
      missionId: checkpoint.missionId ?? manifest?.missionId,
      goal: checkpoint.context?.goal ?? manifest?.goal,
      model: manifest?.model,
      status,
      phase: checkpoint.phase,
      startedAt: manifest?.timestamp ?? checkpoint.timestamp,
      completedAt:
        checkpoint.phase === 'completed' || checkpoint.phase === 'failed'
          ? checkpoint.timestamp
          : undefined,
      totalEvents: events.length,
      totalTokens,
      durationMs: checkpoint.totalDurationMs ?? 0,
      stepCount: checkpoint.stepNumber ?? 0,
    };

    res.json({ run, checkpoint: { ...checkpoint, messages: undefined } });
  });

  // ── Get trace events for a run ─────────────────────────────────────────
  router.get('/api/replay/runs/:runId/events', async (req, res) => {
    if (!requireTenantResponse(req, res)) return;
    const { runId } = req.params;
    if (!isValidRunId(runId)) return res.status(400).json({ error: 'Invalid runId format' });

    const located = await locateCheckpoint(req, runId);
    if (!located) return res.status(404).json({ error: 'Run not found' });
    const events = await readNdjsonFile(path.join(located.dirs.tracesDir, `${runId}.ndjson`));

    const typeFilter = req.query.type as string | undefined;
    const filtered = typeFilter ? events.filter((e) => e.type === typeFilter) : events;

    res.json({ events: filtered, total: filtered.length });
  });

  // ── Get checkpoint (full conversation history) ─────────────────────────
  router.get('/api/replay/runs/:runId/checkpoint', async (req, res) => {
    if (!requireTenantResponse(req, res)) return;
    const { runId } = req.params;
    if (!isValidRunId(runId)) return res.status(400).json({ error: 'Invalid runId format' });

    const located = await locateCheckpoint(req, runId);
    const checkpoint = located?.checkpoint;

    if (!checkpoint) {
      return res.status(404).json({ error: 'Checkpoint not found' });
    }

    res.json(checkpoint);
  });

  return router;
}
