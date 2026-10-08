/**
 * hallucinationEndpoints — Express router that surfaces hallucination detection
 * results persisted in the on-disk trace files (`.commander_traces/<runId>.ndjson`).
 *
 * Endpoints:
 *   GET /api/hallucination/runs/:runId — list of hallucination reports for a run
 *
 * The Core `HallucinationDetector` (`packages/core/src/hallucinationDetector.ts`)
 * emits riskScore (0-1) + recommendation (pass/flag_for_review/reject) + 13 signal
 * types. The runtime enriches trace events with these signals (verification events,
 * llm_call metadata). This endpoint extracts whatever hallucination data is present
 * in the trace file; if none is found it returns an empty array — closing GAP-04
 * from the UX audit report without modifying Core.
 */
import { reportSilentFailure } from '@praetor/core';
import { Router } from 'express';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { resolveConfiguredTraceBase, resolveTraceDir } from '@praetor/core/runtime/traceStore';
import { toErrorMessage } from './routeHelpers';

// ── Types ─────────────────────────────────────────────────────────────────

/** A single hallucination signal detected in an LLM output. */
interface HallucinationSignalEntry {
  type: string;
  severity: 'low' | 'medium' | 'high';
  evidence: string;
  suggestion: string;
}

/** A hallucination report extracted from a single trace event. */
interface HallucinationReportEntry {
  eventId: string;
  spanId: string;
  timestamp: string;
  agentId: string;
  eventType: string;
  riskScore: number;
  recommendation: 'pass' | 'flag_for_review' | 'reject';
  signals: HallucinationSignalEntry[];
  summary: string;
}

interface HallucinationReportResponse {
  runId: string;
  reports: HallucinationReportEntry[];
  total: number;
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
  // Same single-owner rule as the trace writer — see traceStore.ts.
  return resolveTraceDir(resolveConfiguredTraceBase(), tenantId);
}

/**
 * Read a trace NDJSON file.
 *
 * Fail-closed: only a genuinely absent file yields an empty result. Any other
 * read failure (EACCES/EIO/…) propagates so the handler answers non-2xx — a
 * permission error must never be reported as "zero hallucination risk".
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
      reportSilentFailure(err, 'hallucinationEndpoints:readNdjson');
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

function isRecommendation(value: unknown): value is 'pass' | 'flag_for_review' | 'reject' {
  return value === 'pass' || value === 'flag_for_review' || value === 'reject';
}

function isSeverity(value: unknown): value is 'low' | 'medium' | 'high' {
  return value === 'low' || value === 'medium' || value === 'high';
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

/**
 * Coerce an arbitrary object into a hallucination signal entry.
 * Unknown fields are filled with safe defaults so the frontend always
 * receives a well-shaped object.
 */
function coerceSignal(raw: unknown): HallucinationSignalEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const type = typeof obj.type === 'string' ? obj.type : 'unknown';
  const severity = isSeverity(obj.severity) ? obj.severity : 'low';
  const evidence = typeof obj.evidence === 'string' ? obj.evidence : '';
  const suggestion = typeof obj.suggestion === 'string' ? obj.suggestion : '';
  return { type, severity, evidence, suggestion };
}

function coerceSignals(raw: unknown): HallucinationSignalEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: HallucinationSignalEntry[] = [];
  for (const item of raw) {
    const sig = coerceSignal(item);
    if (sig) out.push(sig);
  }
  return out;
}

/**
 * Map a raw risk score (0-1 or 0-100) into the normalized 0-1 range.
 */
function normalizeRiskScore(value: unknown): number {
  const n = toNumber(value);
  if (n === null) return 0;
  if (n <= 1) return n;
  if (n <= 100) return n / 100;
  return 1;
}

/**
 * Derive a recommendation from a risk score when the trace event does not
 * carry one explicitly. Mirrors the Core detector's thresholds.
 */
function recommendationFromScore(riskScore: number): 'pass' | 'flag_for_review' | 'reject' {
  if (riskScore >= 0.5) return 'reject';
  if (riskScore >= 0.2) return 'flag_for_review';
  return 'pass';
}

/**
 * Extract a hallucination report from a single trace event. Returns null if
 * the event carries no hallucination signal.
 *
 * Supported trace shapes:
 *   1. `data.hallucinationReport` — full report object (riskScore, recommendation, signals, summary)
 *   2. `data.metadata.hallucinationRiskScore` — llm_call enrichment from AgentRuntime
 *   3. `verification` events — confidence/signalCount from recordVerification()
 *   4. `data.riskScore` + `data.recommendation` — flat hallucination event
 */
function extractReport(event: TraceEvent): HallucinationReportEntry | null {
  const data = event.data ?? {};
  const metadata = (data.metadata ?? {}) as Record<string, unknown>;

  // Case 1: full hallucination report nested in data
  const nested = data.hallucinationReport ?? data.hallucination_report;
  if (nested && typeof nested === 'object') {
    const r = nested as Record<string, unknown>;
    const riskScore = normalizeRiskScore(r.riskScore);
    const recommendation = isRecommendation(r.recommendation)
      ? r.recommendation
      : recommendationFromScore(riskScore);
    const signals = coerceSignals(r.signals);
    const summary = typeof r.summary === 'string' ? r.summary : '';
    if (riskScore > 0 || signals.length > 0 || recommendation !== 'pass') {
      return {
        eventId: event.id,
        spanId: event.spanId,
        timestamp: event.timestamp,
        agentId: event.agentId,
        eventType: event.type,
        riskScore,
        recommendation,
        signals,
        summary,
      };
    }
  }

  // Case 2: llm_call metadata enrichment (hallucinationRiskScore + hallucinationDetected)
  const metaRisk = metadata.hallucinationRiskScore ?? data.hallucinationRiskScore;
  const metaDetected = metadata.hallucinationDetected ?? data.hallucinationDetected;
  if (toNumber(metaRisk) !== null || metaDetected === true) {
    const riskScore = normalizeRiskScore(metaRisk ?? 0);
    return {
      eventId: event.id,
      spanId: event.spanId,
      timestamp: event.timestamp,
      agentId: event.agentId,
      eventType: event.type,
      riskScore,
      recommendation: recommendationFromScore(riskScore),
      signals: coerceSignals(metadata.hallucinationSignals ?? data.hallucinationSignals),
      summary:
        typeof metadata.hallucinationSummary === 'string'
          ? (metadata.hallucinationSummary as string)
          : typeof data.hallucinationSummary === 'string'
            ? (data.hallucinationSummary as string)
            : '',
    };
  }

  // Case 3: verification events carry confidence/signalCount from the
  // hallucination-aware verification pass.
  if (event.type === 'verification') {
    const passed = data.evaluationPassed ?? (data.input as { passed?: unknown })?.passed;
    const confidence = toNumber(
      data.evaluationScore ?? (data.input as { confidence?: unknown })?.confidence,
    );
    const signalCount = toNumber((data.input as { signalCount?: unknown })?.signalCount);
    if (confidence !== null || signalCount !== null) {
      // Verification confidence is a "groundedness" score (higher = better).
      // Convert to a hallucination risk score (1 - confidence).
      const riskScore = confidence !== null ? Math.max(0, Math.min(1, 1 - confidence)) : 0;
      const recommendation: HallucinationReportEntry['recommendation'] =
        passed === false ? 'flag_for_review' : recommendationFromScore(riskScore);
      return {
        eventId: event.id,
        spanId: event.spanId,
        timestamp: event.timestamp,
        agentId: event.agentId,
        eventType: event.type,
        riskScore,
        recommendation,
        signals: [],
        summary:
          signalCount !== null
            ? `Verification reported ${signalCount} signal(s).`
            : 'Verification result recorded.',
      };
    }
  }

  // Case 4: flat hallucination event with riskScore + recommendation at the top level
  const flatRisk = toNumber(data.riskScore);
  if (flatRisk !== null || isRecommendation(data.recommendation)) {
    const riskScore = normalizeRiskScore(data.riskScore);
    const recommendation = isRecommendation(data.recommendation)
      ? data.recommendation
      : recommendationFromScore(riskScore);
    const signals = coerceSignals(data.signals);
    return {
      eventId: event.id,
      spanId: event.spanId,
      timestamp: event.timestamp,
      agentId: event.agentId,
      eventType: event.type,
      riskScore,
      recommendation,
      signals,
      summary: typeof data.summary === 'string' ? data.summary : '',
    };
  }

  return null;
}

// ── Router ────────────────────────────────────────────────────────────────

export function createHallucinationRouter(): Router {
  const router = Router();

  // ── GET /api/hallucination/runs/:runId — hallucination reports for a run ──
  router.get('/api/hallucination/runs/:runId', async (req, res) => {
    try {
      const { runId } = req.params;
      if (!isValidRunId(runId)) {
        return res.status(400).json({ error: 'Invalid runId format' });
      }

      const tenantId = (req as typeof req & { tenantId?: string }).tenantId;
      const tracesDir = findTracesDir(tenantId);
      const events = await readNdjsonFile(tracesDir, runId);

      const reports: HallucinationReportEntry[] = [];
      for (const event of events) {
        const report = extractReport(event);
        if (report) reports.push(report);
      }

      // Sort by timestamp ascending so the timeline reads chronologically
      reports.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

      const body: HallucinationReportResponse = {
        runId,
        reports,
        total: reports.length,
      };
      res.json(body);
    } catch (error) {
      reportSilentFailure(error, 'hallucinationEndpoints:readTrace');
      res.status(500).json({ error: toErrorMessage(error) });
    }
  });

  return router;
}
