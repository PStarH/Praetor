/**
 * auditLogEndpoints — Unified audit log query API.
 *
 * Closes the "scattered audit logs" gap. Commander has three independent
 * audit producers, each persisted in a different location/format:
 *   - Security events   → .commander_security/*.ndjson, .commander/security/*.ndjson
 *   - Approval decisions→ .commander/approval-audit.json (+ .ndjson fallback)
 *   - Action rationale  → .commander/action-rationale/*.ndjson, apps/api/data/action-rationales.json
 *
 * This router provides a single read-only query interface that merges,
 * filters, sorts (newest first), and paginates across all sources so
 * operators can answer "who did what, when, and why" from one place.
 *
 * Endpoints:
 *   GET /api/audit/logs         — unified query (filter + paginate)
 *   GET /api/audit/logs/export  — JSON file download (same filters, no pagination)
 *   GET /api/audit/stats        — aggregate counts by source/severity/eventType
 *   GET /api/audit/sources      — per-source availability + recency
 *
 * Missing log files yield empty arrays — they never raise errors, so a fresh
 * install with no audit activity yet returns a valid empty result.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { z } from 'zod';
import { toErrorMessage } from './routeHelpers';
import { getDirname, getRequire } from './esmCompat';
import { hasRole } from './userStore';
const __dirname = getDirname(import.meta.url);
const require = getRequire(import.meta.url);

import {
  getUnifiedAuditLog,
  type UnifiedAuditCategory,
  type UnifiedAuditSeverity,
  type AuditQueryFilters,
  type AuditExportFormat,
} from '@praetor/core/security';

// ── Types ────────────────────────────────────────────────────────────────

export type AuditSource = 'security' | 'approval' | 'action';
export type AuditSeverity = 'info' | 'warning' | 'error' | 'critical';

export interface AuditLogEntry {
  id: string;
  timestamp: string; // ISO
  source: AuditSource;
  eventType: string;
  severity: AuditSeverity;
  userId?: string;
  tenantId?: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface AuditStats {
  totalEvents: number;
  bySource: Record<string, number>;
  bySeverity: Record<string, number>;
  byEventType: Record<string, number>;
  timeRange: { earliest: string | null; latest: string | null };
}

export interface AuditSourceInfo {
  source: AuditSource;
  description: string;
  eventCount: number;
  lastEvent: string | null;
}

interface AuditQuery {
  source?: string;
  severity?: string;
  eventType?: string;
  startTime?: string;
  endTime?: string;
  userId?: string;
  tenantId?: string;
  limit: number;
  offset: number;
}

interface LogsResponse {
  logs: AuditLogEntry[];
  total: number;
  sources: AuditSource[];
}

// ── Paths & limits ───────────────────────────────────────────────────────

const COMMANDER_DIR = path.join(process.cwd(), '.commander');
const SECURITY_DIR = path.join(process.cwd(), '.commander_security');
const ACTION_RATIONALE_DIR = path.join(COMMANDER_DIR, 'action-rationale');
// Mirror ActionRationaleStore's env-overridable default. Env MUST be set
// before the module is required; we read it at load time like the store does.
const ACTION_RATIONALE_FILE_DEFAULT =
  process.env['COMMANDER_ACTION_RATIONALE_FILE'] ??
  path.resolve(__dirname, '..', 'data', 'action-rationales.json');

/** Cap lines read per ndjson file to bound memory on very large logs. */
const MAX_LINES_PER_FILE = 200_000;
/** Cap total entries materialized per source to bound query latency. */
const MAX_TOTAL_ENTRIES = 100_000;

const SOURCE_DESCRIPTIONS: Record<AuditSource, string> = {
  security:
    'Security events (sandbox violations, auth failures, threat detections, policy breaches)',
  approval: 'Approval decisions (tool approval granted/denied, sandbox mode changes)',
  action: 'Action rationale (explainability trail for agent decisions and outcomes)',
};

// ── Low-level file readers ───────────────────────────────────────────────

/**
 * Read an ndjson/jsonl file, preserving the distinction between absent data and
 * unreadable/corrupt data. Missing files are optional sources and yield `[]`;
 * permission/I/O/parse failures throw so an audit endpoint cannot answer a
 * partial, apparently successful report.
 */
async function readNdjsonFile(filePath: string): Promise<unknown[]> {
  let raw: string;
  try {
    raw = await fsp.readFile(filePath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(`AUDIT_SOURCE_UNAVAILABLE: ${path.basename(filePath)}`);
  }
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const lines = trimmed.split('\n');
  const out: unknown[] = [];
  const cap = Math.min(lines.length, MAX_LINES_PER_FILE);
  for (let i = 0; i < cap; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      throw new Error(`AUDIT_SOURCE_INVALID: malformed NDJSON in ${path.basename(filePath)}`);
    }
  }
  return out;
}

/** Missing JSON is optional; unreadable or malformed JSON is a hard failure. */
async function readJsonFile<T = unknown>(filePath: string): Promise<T | null> {
  let raw: string;
  try {
    raw = await fsp.readFile(filePath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`AUDIT_SOURCE_UNAVAILABLE: ${path.basename(filePath)}`);
  }
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    throw new Error(`AUDIT_SOURCE_INVALID: malformed JSON in ${path.basename(filePath)}`);
  }
}

/** Missing directories are optional; other failures are not hidden. */
async function listFiles(dir: string, predicate: (name: string) => boolean): Promise<string[]> {
  try {
    const entries = await fsp.readdir(dir);
    return entries.filter(predicate).map((f) => path.join(dir, f));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(`AUDIT_SOURCE_UNAVAILABLE: ${path.basename(dir)}`);
  }
}

// ── Severity mapping ─────────────────────────────────────────────────────

/**
 * Map the security logger's low/medium/high/critical scale onto the unified
 * info/warning/error/critical scale used by this API.
 */
function mapSecuritySeverity(sev: string | undefined): AuditSeverity {
  switch (sev) {
    case 'critical':
      return 'critical';
    case 'high':
      return 'error';
    case 'medium':
      return 'warning';
    case 'low':
    case 'info':
    default:
      return 'info';
  }
}

/** Approval severity derives from the decision outcome. */
function mapApprovalSeverity(decision: string | undefined): AuditSeverity {
  switch (decision) {
    case 'denied':
    case 'rejected':
    case 'blocked':
      return 'warning';
    case 'approved':
    case 'granted':
    case 'allowed':
      return 'info';
    default:
      return 'info';
  }
}

// ── Source readers ───────────────────────────────────────────────────────

interface RawSecurityEvent {
  id?: string;
  timestamp?: string;
  type?: string;
  event?: string;
  severity?: string;
  source?: string;
  message?: string;
  details?: Record<string, unknown>;
  context?: { userId?: string; agentId?: string; runId?: string; tenantId?: string };
  // `config_change` records written by approvalConfigEndpoints use flat,
  // top-level fields rather than a `context` object.
  action?: string;
  actor?: string;
  tenantId?: string;
  detail?: Record<string, unknown>;
  ip?: string;
}

/**
 * Map one raw security-log line onto the unified entry shape.
 *
 * LM-24 / AUDIT api-completion#API-C04: the configuration producer writes
 * `type / action / actor / tenantId / detail` at the top level, but this reader
 * only looked at `context.userId` / `context.tenantId`. Every config change was
 * therefore read with `tenantId: undefined` and immediately dropped by the
 * server-side tenant filter — the events were on disk but unqueryable.
 *
 * Records that carry two different tenant claims are quarantined (return null)
 * rather than attributed to either tenant or to the caller's tenant.
 */
function toSecurityEntry(e: RawSecurityEvent, fallbackIdx: number): AuditLogEntry | null {
  const ts = e.timestamp;
  if (!ts) return null;

  const contextTenant = e.context?.tenantId;
  const topLevelTenant = e.tenantId;
  if (contextTenant && topLevelTenant && contextTenant !== topLevelTenant) return null;

  return {
    id: e.id ?? `sec_${ts}_${fallbackIdx}`,
    timestamp: ts,
    source: 'security',
    eventType: e.type ?? e.event ?? 'security_event',
    severity: mapSecuritySeverity(e.severity),
    userId: e.context?.userId ?? e.actor,
    tenantId: contextTenant ?? topLevelTenant,
    message: e.message ?? e.type ?? 'Security event',
    details: {
      ...e.details,
      ...(e.context ? { context: e.context } : {}),
      ...(e.source ? { emitter: e.source } : {}),
      ...(typeof e.action === 'string' ? { action: e.action } : {}),
      ...(e.detail ? { detail: e.detail } : {}),
    },
  };
}

async function readSecurityLogs(): Promise<AuditLogEntry[]> {
  // Candidate directories — support both the task-spec layout and the actual
  // SecurityAuditLogger layout so logs are found regardless of deployment.
  const candidateDirs = [path.join(COMMANDER_DIR, 'security'), SECURITY_DIR];
  const files = new Set<string>();
  for (const dir of candidateDirs) {
    const matches = await listFiles(dir, (n) => n.endsWith('.ndjson') || n.endsWith('.jsonl'));
    for (const f of matches) files.add(f);
  }
  // Legacy single-file location (used by approvalConfigEndpoints).
  const legacy = path.join(COMMANDER_DIR, 'security-audit.jsonl');
  if (fs.existsSync(legacy)) files.add(legacy);

  if (files.size === 0) return [];

  const fileArr = Array.from(files);
  const batches = await Promise.all(fileArr.map((f) => readNdjsonFile(f)));
  const entries: AuditLogEntry[] = [];
  const seenIds = new Set<string>();
  for (const batch of batches) {
    for (const raw of batch) {
      const entry = toSecurityEntry(raw as RawSecurityEvent, entries.length);
      if (!entry) continue;
      if (seenIds.has(entry.id)) continue;
      seenIds.add(entry.id);
      entries.push(entry);
      if (entries.length >= MAX_TOTAL_ENTRIES) return entries;
    }
  }
  return entries;
}

interface RawApprovalEntry {
  id?: string;
  timestamp?: string;
  event?: string;
  eventType?: string;
  decision?: string;
  userId?: string;
  user?: string;
  toolName?: string;
  reason?: string;
  message?: string;
  riskLevel?: string;
  tenantId?: string;
  context?: { tenantId?: string };
}

function toApprovalEntry(e: RawApprovalEntry, fallbackIdx: number): AuditLogEntry {
  const ts = e.timestamp ?? new Date().toISOString();
  return {
    id: e.id ?? `apr_${ts}_${fallbackIdx}`,
    timestamp: ts,
    source: 'approval',
    eventType: e.eventType ?? e.event ?? 'approval_decision',
    severity: mapApprovalSeverity(e.decision),
    userId: e.userId ?? e.user,
    tenantId: e.tenantId ?? e.context?.tenantId,
    message:
      e.message ??
      e.reason ??
      `Approval ${e.decision ?? 'decision'}${e.toolName ? ` for ${e.toolName}` : ''}`,
    details: {
      decision: e.decision,
      toolName: e.toolName,
      reason: e.reason,
      riskLevel: e.riskLevel,
    },
  };
}

async function readApprovalLogs(): Promise<AuditLogEntry[]> {
  const jsonFile = path.join(COMMANDER_DIR, 'approval-audit.json');
  const ndjsonFile = path.join(COMMANDER_DIR, 'approval-audit.ndjson');

  const entries: AuditLogEntry[] = [];

  // JSON array form (primary, per task spec).
  const arr = await readJsonFile<unknown[]>(jsonFile);
  if (Array.isArray(arr)) {
    for (let i = 0; i < arr.length; i++) {
      const e = arr[i] as RawApprovalEntry;
      if (!e.timestamp) continue;
      entries.push(toApprovalEntry(e, i));
      if (entries.length >= MAX_TOTAL_ENTRIES) return entries;
    }
  }

  // NDJSON form (fallback).
  const ndEntries = await readNdjsonFile(ndjsonFile);
  for (let i = 0; i < ndEntries.length; i++) {
    const e = ndEntries[i] as RawApprovalEntry;
    if (!e.timestamp) continue;
    entries.push(toApprovalEntry(e, i));
    if (entries.length >= MAX_TOTAL_ENTRIES) return entries;
  }

  return entries;
}

interface RawActionRationale {
  id?: string;
  timestamp?: string;
  projectId?: string;
  missionId?: string;
  agentId?: string;
  tenantId?: string;
  context?: { tenantId?: string };
  actionType?: string;
  rationale?: string;
  confidence?: { score?: number; level?: string };
  triggerSource?: string;
  goalContext?: string;
  alternatives?: unknown[];
  dataSources?: string[];
  reasoningChain?: unknown[];
  outcome?: { success?: boolean; result?: string; sideEffects?: string[] };
}

function toActionEntry(e: RawActionRationale, id: string): AuditLogEntry {
  return {
    id,
    timestamp: e.timestamp!,
    source: 'action',
    eventType: e.actionType ?? 'action',
    severity: 'info',
    userId: e.agentId,
    tenantId: e.tenantId ?? e.context?.tenantId,
    message: e.rationale ?? e.goalContext ?? `Action ${e.actionType ?? ''}`.trim(),
    details: {
      projectId: e.projectId,
      missionId: e.missionId,
      agentId: e.agentId,
      confidence: e.confidence,
      triggerSource: e.triggerSource,
      goalContext: e.goalContext,
      alternatives: e.alternatives,
      dataSources: e.dataSources,
      reasoningChain: e.reasoningChain,
      outcome: e.outcome,
    },
  };
}

async function readActionLogs(): Promise<AuditLogEntry[]> {
  const entries: AuditLogEntry[] = [];
  const seenIds = new Set<string>();

  // NDJSON files under .commander/action-rationale/ (per task spec).
  const ndFiles = await listFiles(ACTION_RATIONALE_DIR, (n) => n.endsWith('.ndjson'));
  for (const f of ndFiles) {
    const rows = await readNdjsonFile(f);
    for (const raw of rows) {
      const e = raw as RawActionRationale;
      if (!e.timestamp) continue;
      const id = e.id ?? `act_${e.timestamp}_${entries.length}`;
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      entries.push(toActionEntry(e, id));
      if (entries.length >= MAX_TOTAL_ENTRIES) return entries;
    }
  }

  // JSON array file (ActionRationaleStore default). Check several candidate
  // locations and stop at the first that exists.
  const jsonCandidates = [
    ACTION_RATIONALE_FILE_DEFAULT,
    path.join(process.cwd(), 'apps', 'api', 'data', 'action-rationales.json'),
    path.join(process.cwd(), 'data', 'action-rationales.json'),
  ];
  for (const cand of jsonCandidates) {
    if (entries.length >= MAX_TOTAL_ENTRIES) break;
    const arr = await readJsonFile<unknown[]>(cand);
    if (!Array.isArray(arr)) continue;
    for (const raw of arr) {
      const e = raw as RawActionRationale;
      if (!e.timestamp) continue;
      const id = e.id ?? `act_${e.timestamp}_${entries.length}`;
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      entries.push(toActionEntry(e, id));
      if (entries.length >= MAX_TOTAL_ENTRIES) break;
    }
    break; // found the file — stop checking candidates
  }

  return entries;
}

// ── Merge + cache ────────────────────────────────────────────────────────

async function loadAllLogs(): Promise<AuditLogEntry[]> {
  const [sec, apr, act] = await Promise.all([
    readSecurityLogs(),
    readApprovalLogs(),
    readActionLogs(),
  ]);
  return [...sec, ...apr, ...act];
}

/**
 * Short-TTL in-memory cache so the frontend's parallel /logs + /stats +
 * /sources calls share a single disk read. Audit files are append-only and
 * near-real-time freshness is not required for a viewer.
 */
const CACHE_TTL_MS = 5_000;
let cache: { ts: number; entries: AuditLogEntry[] } | null = null;

async function loadAllLogsCached(): Promise<AuditLogEntry[]> {
  if (cache && Date.now() - cache.ts < CACHE_TTL_MS) {
    return cache.entries;
  }
  const entries = await loadAllLogs();
  cache = { ts: Date.now(), entries };
  return entries;
}

/**
 * Drop the short-TTL read cache.
 *
 * LM-24: an audit producer that has just appended a record calls this so its own
 * change is visible immediately instead of being hidden for up to CACHE_TTL_MS.
 * The TTL remains the upper bound for changes made by other processes.
 */
export function invalidateAuditLogCache(): void {
  cache = null;
}

// ── Filter + sort + paginate ─────────────────────────────────────────────

function applyFilters(entries: AuditLogEntry[], q: AuditQuery): AuditLogEntry[] {
  let out = entries;
  if (q.source && q.source !== 'all') {
    out = out.filter((e) => e.source === q.source);
  }
  if (q.severity) {
    out = out.filter((e) => e.severity === q.severity);
  }
  if (q.eventType) {
    const needle = q.eventType.toLowerCase();
    out = out.filter((e) => e.eventType.toLowerCase().includes(needle));
  }
  if (q.userId) {
    const needle = q.userId.toLowerCase();
    out = out.filter((e) => (e.userId ?? '').toLowerCase().includes(needle));
  }
  if (q.startTime) {
    out = out.filter((e) => e.timestamp >= q.startTime!);
  }
  if (q.endTime) {
    out = out.filter((e) => e.timestamp <= q.endTime!);
  }
  if (q.tenantId) {
    out = out.filter((e) => e.tenantId === q.tenantId);
  }
  // Sort by timestamp descending (newest first). ISO string comparison is
  // valid for same-timezone UTC timestamps — see actionRationale.ts.
  out = out.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
  return out;
}

function computeStats(entries: AuditLogEntry[]): AuditStats {
  const bySource: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  const byEventType: Record<string, number> = {};
  let earliest: string | null = null;
  let latest: string | null = null;
  for (const e of entries) {
    bySource[e.source] = (bySource[e.source] ?? 0) + 1;
    bySeverity[e.severity] = (bySeverity[e.severity] ?? 0) + 1;
    byEventType[e.eventType] = (byEventType[e.eventType] ?? 0) + 1;
    if (earliest === null || e.timestamp < earliest) earliest = e.timestamp;
    if (latest === null || e.timestamp > latest) latest = e.timestamp;
  }
  return {
    totalEvents: entries.length,
    bySource,
    bySeverity,
    byEventType,
    timeRange: { earliest, latest },
  };
}

// ── Query parsing (zod) ──────────────────────────────────────────────────

const auditQuerySchema = z.object({
  source: z.enum(['security', 'approval', 'action', 'all']).optional(),
  severity: z.enum(['info', 'warning', 'error', 'critical']).optional(),
  eventType: z.string().max(128).optional(),
  startTime: z.string().max(64).optional(),
  endTime: z.string().max(64).optional(),
  userId: z.string().max(256).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

type ParsedQuery = AuditQuery | { error: string; details: unknown };

function parseQuery(req: Request): ParsedQuery {
  const parsed = auditQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return {
      error: 'Validation error',
      details: parsed.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    };
  }
  return {
    source: parsed.data.source,
    severity: parsed.data.severity,
    eventType: parsed.data.eventType,
    startTime: parsed.data.startTime,
    endTime: parsed.data.endTime,
    userId: parsed.data.userId,
    limit: parsed.data.limit ?? 100,
    offset: parsed.data.offset ?? 0,
  };
}

function requestTenant(req: Request): string | undefined {
  const bound = req.tenantId;
  const claim = req.user?.tenantId;
  if (bound && claim && bound !== claim) return undefined;
  return bound ?? claim;
}

/** Audit data is sensitive: require an audit-capable role and an authenticated tenant. */
function requireAuditReader(req: Request, res: Response, next: NextFunction): void {
  if (!req.user && !req.apiKeyId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  const tenantId = requestTenant(req);
  const role = req.user?.role;
  const scopes = req.apiScopes ?? req.user?.scopes ?? [];
  const roleAllowed = !!role && hasRole(role, 'auditor');
  const scopeAllowed =
    scopes.includes('audit:read') || scopes.includes('admin') || scopes.includes('*');
  if (!tenantId || (!roleAllowed && !scopeAllowed)) {
    res.status(403).json({ error: 'Tenant-bound audit authority is required' });
    return;
  }
  next();
}

function isValidationError(q: ParsedQuery): q is { error: string; details: unknown } {
  return typeof (q as { error?: unknown }).error === 'string';
}

// ── Unified audit-log query parsing (/api/audit-logs*) ──────────────────
//
// The unified endpoints accept array-valued filters either as repeated query
// params (category=security&category=approval) or as a comma-separated list
// (category=security,approval). `parseStringArray` normalizes both forms.

function parseStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    return value
      .flatMap((v) => String(v).split(','))
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  if (typeof value === 'string') {
    const arr = value
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return arr.length > 0 ? arr : undefined;
  }
  return undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** Build an `AuditQueryFilters` object from Express query params. */
function parseUnifiedFilters(req: Request): AuditQueryFilters {
  const q = req.query;
  const startTime = optionalString(q.startTime);
  const endTime = optionalString(q.endTime);
  const timeRange = startTime || endTime ? { start: startTime, end: endTime } : undefined;
  const category = parseStringArray(q.category) as UnifiedAuditCategory[] | undefined;
  const severity = parseStringArray(q.severity) as UnifiedAuditSeverity[] | undefined;
  return {
    tenantId: requestTenant(req),
    timeRange,
    category,
    eventType: parseStringArray(q.eventType),
    severity,
    userId: optionalString(q.userId),
    runId: optionalString(q.runId),
    agentId: optionalString(q.agentId),
    toolName: optionalString(q.toolName),
    limit: optionalNumber(q.limit),
    offset: optionalNumber(q.offset),
  };
}

// ── Router ───────────────────────────────────────────────────────────────

export function createAuditLogRouter(): Router {
  const router = Router();

  // LM-24 / AUDIT api-completion#API-C05: this router is mounted at '/' ahead of
  // onboarding/saga, so a root-level `router.use(requireAuditReader)` ran on
  // EVERY request that reached the mount point and 403'd unrelated routes for
  // non-auditors. The guard is now attached to each audit handler individually —
  // an exact list, so a future handler added here must opt in explicitly (and
  // the composition test asserts all eight are covered).

  // GET /api/audit/logs — unified query (filter + paginate)
  router.get('/api/audit/logs', requireAuditReader, async (req: Request, res: Response) => {
    try {
      const q = parseQuery(req);
      if (isValidationError(q)) {
        return res.status(400).json(q);
      }
      q.tenantId = requestTenant(req);
      const all = await loadAllLogsCached();
      const filtered = applyFilters(all, q);
      const total = filtered.length;
      const logs = filtered.slice(q.offset, q.offset + q.limit);
      const sourcesPresent = Array.from(new Set(filtered.map((e) => e.source))) as AuditSource[];
      const response: LogsResponse = { logs, total, sources: sourcesPresent };
      res.json(response);
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error) });
    }
  });

  // GET /api/audit/logs/export — JSON file download (same filters, no pagination)
  router.get('/api/audit/logs/export', requireAuditReader, async (req: Request, res: Response) => {
    try {
      const q = parseQuery(req);
      if (isValidationError(q)) {
        return res.status(400).json(q);
      }
      q.tenantId = requestTenant(req);
      const all = await loadAllLogsCached();
      const filtered = applyFilters(all, q);
      // Export ignores pagination but caps total volume to protect clients.
      const capped = filtered.slice(0, MAX_TOTAL_ENTRIES);
      const payload = {
        exportedAt: new Date().toISOString(),
        filters: {
          source: q.source,
          severity: q.severity,
          eventType: q.eventType,
          startTime: q.startTime,
          endTime: q.endTime,
          userId: q.userId,
        },
        total: capped.length,
        logs: capped,
      };
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="audit-logs-${Date.now()}.json"`);
      res.json(payload);
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error) });
    }
  });

  // GET /api/audit/stats — aggregate counts
  router.get('/api/audit/stats', requireAuditReader, async (req: Request, res: Response) => {
    try {
      const all = (await loadAllLogsCached()).filter((e) => e.tenantId === requestTenant(req));
      res.json(computeStats(all));
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error) });
    }
  });

  // GET /api/audit/sources — per-source availability + recency
  router.get('/api/audit/sources', requireAuditReader, async (req: Request, res: Response) => {
    try {
      const all = (await loadAllLogsCached()).filter((e) => e.tenantId === requestTenant(req));
      const sources: AuditSource[] = ['security', 'approval', 'action'];
      const result: AuditSourceInfo[] = sources.map((src) => {
        const subset = all.filter((e) => e.source === src);
        const lastEvent =
          subset.length > 0
            ? subset.reduce(
                (max, e) => (e.timestamp > max ? e.timestamp : max),
                subset[0]!.timestamp,
              )
            : null;
        return {
          source: src,
          description: SOURCE_DESCRIPTIONS[src],
          eventCount: subset.length,
          lastEvent,
        };
      });
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error) });
    }
  });

  // ── Unified audit-log endpoints (/api/audit-logs*) ─────────────────────
  //
  // These back the redesigned Audit Log page and aggregate every audit
  // producer (security / approval / execution / user-action / configuration)
  // via the shared UnifiedAuditLog. They expose query, stats, export, and a
  // catalog for the frontend filter UI.
  const auditLog = getUnifiedAuditLog();

  // GET /api/audit-logs/categories — catalog for the frontend filter UI.
  router.get(
    '/api/audit-logs/categories',
    requireAuditReader,
    async (req: Request, res: Response) => {
      try {
        const catalog = await auditLog.getCatalog(requestTenant(req));
        res.json(catalog);
      } catch (error) {
        res.status(500).json({ error: toErrorMessage(error) });
      }
    },
  );

  // GET /api/audit-logs/stats — aggregate stats with timeline + top-N.
  router.get('/api/audit-logs/stats', requireAuditReader, async (req: Request, res: Response) => {
    try {
      const startTime = optionalString(req.query.startTime);
      const endTime = optionalString(req.query.endTime);
      const stats = await auditLog.getStats({ start: startTime, end: endTime }, requestTenant(req));
      res.json(stats);
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error) });
    }
  });

  // GET /api/audit-logs/export — file download (JSON or CSV).
  router.get('/api/audit-logs/export', requireAuditReader, async (req: Request, res: Response) => {
    try {
      const filters = parseUnifiedFilters(req);
      const format: AuditExportFormat = req.query.format === 'csv' ? 'csv' : 'json';
      const body = await auditLog.exportLogs(filters, format);
      const ext = format === 'csv' ? 'csv' : 'json';
      const contentType =
        format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8';
      res.setHeader('Content-Type', contentType);
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="audit-logs-${Date.now()}.${ext}"`,
      );
      res.send(body);
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error) });
    }
  });

  // GET /api/audit-logs — unified query (filter + paginate).
  router.get('/api/audit-logs', requireAuditReader, async (req: Request, res: Response) => {
    try {
      const filters = parseUnifiedFilters(req);
      const entries = await auditLog.query(filters);
      const total = await auditLog.count(filters);
      const limit = filters.limit ?? 100;
      const offset = filters.offset ?? 0;
      res.json({ entries, total, hasMore: offset + entries.length < total });
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error) });
    }
  });

  return router;
}
