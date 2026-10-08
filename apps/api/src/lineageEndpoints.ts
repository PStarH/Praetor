/**
 * lineageEndpoints — Express router that reconstructs the Agent Lineage tree
 * for a run from on-disk trace files (`.commander_traces/<runId>.ndjson`).
 *
 * Endpoint:
 *   GET /api/lineage/runs/:runId — parent→child agent lineage for a run
 *
 * `AgentLineage` (`packages/core/src/security/agentLineage.ts`) is a runtime
 * in-memory object; its `LineageSummary` API (root/nodes/totalNodes/maxDepth/
 * activeNodes) is not directly queryable across processes. This endpoint walks
 * the persisted trace events for `agent.spawn` / `agent.handoff` records and
 * rebuilds an equivalent summary. If no lineage events are found it returns an
 * empty structure — closing GAP-05 from the UX audit report without modifying
 * Core or relying on in-memory state.
 */
import { reportSilentFailure } from '@praetor/core';
import { Router } from 'express';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { resolveConfiguredTraceBase, resolveTraceDir } from '@praetor/core/runtime/traceStore';
import { toErrorMessage } from './routeHelpers';

// ── Types ─────────────────────────────────────────────────────────────────

/** A single agent instance reconstructed from trace events. */
interface LineageNodeEntry {
  instanceId: string;
  parentInstanceId: string | null;
  agentId: string;
  role?: string;
  runId?: string;
  spawnedAt: string;
  revokedAt?: string;
  depth: number;
  /** Number of tool_execution events attributed to this agent in the run. */
  toolCallCount: number;
  /** Arbitrary metadata captured from the spawn event (goal snippet, etc.). */
  metadata?: Record<string, unknown>;
}

interface LineageSummaryResponse {
  runId: string;
  root: LineageNodeEntry | null;
  nodes: LineageNodeEntry[];
  totalNodes: number;
  maxDepth: number;
  activeNodes: number;
}

/** Minimal shape of a trace event written to `.commander_traces/<runId>.ndjson`. */
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

// ── Helpers ───────────────────────────────────────────────────────────────

function findTracesDir(tenantId?: string): string {
  // Single-owner resolution: the same rule the trace writer uses. Reading a
  // hard-coded cwd path here while the writer honoured COMMANDER_TRACE_DIR made
  // the lineage tree silently empty (or, worse, served a stale local directory)
  // in any deployment that configured a trace directory.
  return resolveTraceDir(resolveConfiguredTraceBase(), tenantId);
}

/**
 * Read a trace NDJSON file.
 *
 * Fail-closed: only a genuinely absent file yields an empty result. A read that
 * fails for any other reason (EACCES/EIO/…) propagates so the handler can
 * answer non-2xx — a permission error must never be reported as "this run has
 * no lineage".
 */
async function readNdjsonFile(tracesDir: string, runId: string): Promise<TraceEvent[]> {
  const root = path.resolve(tracesDir);
  const filePath = path.resolve(root, `${runId}.ndjson`);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (!filePath.startsWith(prefix)) {
    throw new Error('TRACE_PATH_ESCAPE');
  }
  let raw: string;
  try {
    raw = await fsp.readFile(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const events: TraceEvent[] = [];
  for (const line of trimmed.split('\n')) {
    try {
      events.push(JSON.parse(line) as TraceEvent);
    } catch (err) {
      reportSilentFailure(err, 'lineageEndpoints:readNdjson');
      throw new Error(`TRACE_DATA_INVALID: malformed NDJSON in ${filePath}`);
    }
  }
  return events;
}

const RUN_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
function isValidRunId(runId: string): boolean {
  return (
    typeof runId === 'string' &&
    runId.length > 0 &&
    runId.length < 128 &&
    RUN_ID_PATTERN.test(runId)
  );
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function asString(value: unknown): string | undefined {
  return isString(value) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

/** Event types that signal a child agent was spawned. */
const SPAWN_TYPES = new Set([
  'agent.spawn',
  'agent_spawn',
  'agent.spawned',
  'agent_spawned',
  'agent.subspawn',
  'subagent_spawn',
]);

/** Event types that signal an agent handoff (delegation of authority). */
const HANDOFF_TYPES = new Set(['agent.handoff', 'agent_handoff', 'handoff']);

function isSpawnType(type: string): boolean {
  return SPAWN_TYPES.has(type);
}

function isHandoffType(type: string): boolean {
  return HANDOFF_TYPES.has(type);
}

function emptySummary(runId: string): LineageSummaryResponse {
  return {
    runId,
    root: null,
    nodes: [],
    totalNodes: 0,
    maxDepth: 0,
    activeNodes: 0,
  };
}

/**
 * Reconstruct the lineage tree from spawn + handoff trace events.
 *
 * Spawn events carry parentInstanceId/childInstanceId (or fromInstanceId/
 * toInstanceId for handoffs). When explicit instance IDs are missing we fall
 * back to agentId-based linkage so partial traces still render a useful tree.
 */
function buildLineageSummary(runId: string, events: TraceEvent[]): LineageSummaryResponse {
  // First pass: count tool_execution events per agent so each node carries
  // a toolCallCount.
  const toolCallCounts = new Map<string, number>();
  for (const event of events) {
    if (event.type === 'tool_execution') {
      const agent = event.agentId;
      toolCallCounts.set(agent, (toolCallCounts.get(agent) ?? 0) + 1);
    }
  }

  // nodeByKey resolves to a LineageNodeEntry. Keyed by instanceId when present,
  // otherwise by agentId (so a single agent without explicit instance IDs is
  // represented once).
  const nodesByKey = new Map<string, LineageNodeEntry>();
  // Track which agentId maps to which node key, for agentId-based fallback.
  const keyByAgentId = new Map<string, string>();

  function getOrCreateNode(params: {
    instanceId?: string;
    agentId?: string;
    parentInstanceId?: string | null;
    role?: string;
    spawnedAt?: string;
    depth?: number;
    metadata?: Record<string, unknown>;
  }): LineageNodeEntry | null {
    const instanceId = params.instanceId ?? params.agentId;
    if (!instanceId) return null;
    const key = params.instanceId ?? `agent:${params.agentId}`;

    const existing = nodesByKey.get(key);
    if (existing) {
      // Merge in any richer data from this sighting.
      if (params.parentInstanceId !== undefined && existing.parentInstanceId === null) {
        existing.parentInstanceId = params.parentInstanceId ?? null;
      }
      if (params.role && !existing.role) existing.role = params.role;
      if (params.metadata && !existing.metadata) existing.metadata = params.metadata;
      if (params.spawnedAt && existing.spawnedAt === '') existing.spawnedAt = params.spawnedAt;
      return existing;
    }

    const agentId = params.agentId ?? instanceId;
    const node: LineageNodeEntry = {
      instanceId,
      parentInstanceId: params.parentInstanceId ?? null,
      agentId,
      role: params.role,
      runId,
      spawnedAt: params.spawnedAt ?? '',
      depth: params.depth ?? 0,
      toolCallCount: toolCallCounts.get(agentId) ?? 0,
      metadata: params.metadata,
    };
    nodesByKey.set(key, node);
    if (params.instanceId) {
      keyByAgentId.set(agentId, key);
    } else if (!keyByAgentId.has(agentId)) {
      keyByAgentId.set(agentId, key);
    }
    return node;
  }

  function resolveParentKey(parentInstanceId?: string, parentAgentId?: string): string | null {
    if (parentInstanceId) {
      if (nodesByKey.has(parentInstanceId)) return parentInstanceId;
    }
    if (parentAgentId && keyByAgentId.has(parentAgentId)) {
      return keyByAgentId.get(parentAgentId) ?? null;
    }
    return null;
  }

  // Second pass: process spawn + handoff events in chronological order so
  // parent depths propagate correctly.
  const ordered = [...events].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  for (const event of ordered) {
    const data = asRecord(event.data) ?? {};
    const metadata = asRecord(data.metadata) ?? {};

    if (isSpawnType(event.type)) {
      // Preferred shape: explicit instance IDs from AgentLineage.spawnChild.
      const childInstanceId =
        asString(data.instanceId) ??
        asString(data.childInstanceId) ??
        asString(metadata.instanceId) ??
        asString(metadata.childInstanceId);
      const parentInstanceId =
        asString(data.parentInstanceId) ?? asString(metadata.parentInstanceId) ?? null;
      const childAgentId =
        asString(data.agentId) ??
        asString(data.childAgentId) ??
        asString(metadata.agentId) ??
        asString(metadata.childAgentId) ??
        event.agentId;
      const parentAgentId =
        asString(data.parentAgentId) ?? asString(metadata.parentAgentId) ?? undefined;
      const role = asString(data.role) ?? asString(metadata.role) ?? undefined;

      if (!childInstanceId && !childAgentId) continue;

      // Ensure the parent exists (so its depth is available) — but only if
      // we can identify it.
      if (parentInstanceId) {
        getOrCreateNode({
          instanceId: parentInstanceId,
          agentId: parentAgentId ?? parentInstanceId,
          spawnedAt: event.timestamp,
        });
      } else if (parentAgentId) {
        getOrCreateNode({
          agentId: parentAgentId,
          spawnedAt: event.timestamp,
        });
      }

      const parentKey = resolveParentKey(parentInstanceId ?? undefined, parentAgentId);
      const parent = parentKey ? nodesByKey.get(parentKey) : undefined;
      const depth = parent ? parent.depth + 1 : 0;

      getOrCreateNode({
        instanceId: childInstanceId,
        agentId: childAgentId,
        parentInstanceId: parentInstanceId ?? parentKey ?? null,
        role,
        spawnedAt: event.timestamp,
        depth,
        metadata: metadata.metadata ? asRecord(metadata.metadata) : metadata,
      });
    } else if (isHandoffType(event.type)) {
      const fromInstanceId =
        asString(data.fromInstanceId) ?? asString(metadata.fromInstanceId) ?? null;
      const toInstanceId = asString(data.toInstanceId) ?? asString(metadata.toInstanceId) ?? null;
      const fromAgentId =
        asString(data.fromAgentId) ?? asString(metadata.fromAgentId) ?? event.agentId;
      const toAgentId = asString(data.toAgentId) ?? asString(metadata.toAgentId) ?? undefined;
      const goal = asString(data.goal) ?? asString(metadata.goal) ?? undefined;

      // Ensure both endpoints exist; the "to" side becomes a child of "from".
      if (fromInstanceId || fromAgentId) {
        getOrCreateNode({
          instanceId: fromInstanceId ?? undefined,
          agentId: fromAgentId,
          spawnedAt: event.timestamp,
        });
      }
      if (toInstanceId || toAgentId) {
        const parentKey = resolveParentKey(fromInstanceId ?? undefined, fromAgentId);
        const parent = parentKey ? nodesByKey.get(parentKey) : undefined;
        const depth = parent ? parent.depth + 1 : 0;
        getOrCreateNode({
          instanceId: toInstanceId ?? undefined,
          agentId: toAgentId,
          parentInstanceId: fromInstanceId ?? parentKey ?? null,
          role: goal ? 'handoff' : undefined,
          spawnedAt: event.timestamp,
          depth,
          metadata: goal ? { handoffGoal: goal } : undefined,
        });
      }
    }
  }

  // If we found no spawn/handoff events at all, return an empty summary so
  // the frontend renders the "no lineage data" state cleanly.
  if (nodesByKey.size === 0) {
    return emptySummary(runId);
  }

  // Ensure every agent that executed tools has at least a node, so the tree
  // is not missing leaf agents that never emitted a spawn event. The node's
  // toolCallCount is populated from the toolCallCounts map inside
  // getOrCreateNode.
  for (const agentId of toolCallCounts.keys()) {
    if (!keyByAgentId.has(agentId) && !nodesByKey.has(agentId)) {
      getOrCreateNode({ agentId, spawnedAt: '' });
    }
  }

  const nodes = [...nodesByKey.values()];

  // Compute depths from parent links (in case some came in out of order).
  function depthOf(node: LineageNodeEntry, seen: Set<string> = new Set()): number {
    if (node.parentInstanceId === null || seen.has(node.instanceId)) return 0;
    seen.add(node.instanceId);
    const parent = nodesByKey.get(node.parentInstanceId);
    if (!parent) return 0;
    return 1 + depthOf(parent, seen);
  }
  let maxDepth = 0;
  for (const node of nodes) {
    node.depth = depthOf(node);
    if (node.depth > maxDepth) maxDepth = node.depth;
  }

  // Root = first node with no parent (earliest spawnedAt wins on ties).
  const roots = nodes
    .filter((n) => n.parentInstanceId === null)
    .sort((a, b) => (a.spawnedAt || '').localeCompare(b.spawnedAt || ''));
  const root = roots[0] ?? null;

  // Active = no revokedAt recorded.
  const activeNodes = nodes.filter((n) => !n.revokedAt).length;

  // Sort nodes by depth then spawnedAt for stable rendering.
  nodes.sort((a, b) => a.depth - b.depth || (a.spawnedAt || '').localeCompare(b.spawnedAt || ''));

  return {
    runId,
    root,
    nodes,
    totalNodes: nodes.length,
    maxDepth,
    activeNodes,
  };
}

// ── Router ────────────────────────────────────────────────────────────────

export function createLineageRouter(): Router {
  const router = Router();

  // ── GET /api/lineage/runs/:runId — lineage tree for a run ──────────────
  router.get('/api/lineage/runs/:runId', async (req, res) => {
    try {
      const { runId } = req.params;
      if (!isValidRunId(runId)) {
        return res.status(400).json({ error: 'Invalid runId format' });
      }

      const tenantId = (req as typeof req & { tenantId?: string }).tenantId;
      const tracesDir = findTracesDir(tenantId);
      const events = await readNdjsonFile(tracesDir, runId);
      const summary = buildLineageSummary(runId, events);
      res.json(summary);
    } catch (error) {
      reportSilentFailure(error, 'lineageEndpoints:readTrace');
      res.status(500).json({ error: toErrorMessage(error) });
    }
  });

  return router;
}
