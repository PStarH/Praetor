/**
 * _evidence.ts — Shared WS9 live-fire helpers (spec §3.2, §9).
 *
 * Provides:
 *   - Infrastructure probes (Postgres / Vault / gVisor / /v1 gateway).
 *   - `describeIf` — conditional `describe` that uses `describe.skip` when the
 *     probe is unavailable. Skipped tests emit NO evidence (spec §9.2 honesty).
 *   - `writeEvidence` / `writePass` / `writeBreach` / `writeFail` — structured
 *     JSON artifact writers into *this run's own output root*, plus the binding
 *     metadata (runId, candidate gitSha, start/end, environment fingerprint and
 *     hash-bound child artifacts) consumed by `scripts/ws9-livefire.ts`.
 *   - `toChildArtifact` — record a produced child artifact, run-root relative.
 *   - `TENANT_A` / `TENANT_B` — the two real tenant identifiers (spec §3.1).
 *
 * Binding contract (LM-16 / audit WS9-02): case artifacts live under a
 * per-execution owned directory (`WS9_OUTPUT_ROOT`, set by the orchestrator to
 * an empty run directory), never in a shared `docs/baselines/ws9` top level.
 * Writers fail closed when no run root is configured so evidence can never be
 * emitted unbound.
 *
 * Evidence artifact format (spec §9):
 *   { testCaseId, runId, verdict, evidenceLevel, breach, details, gitSha,
 *     startedAt, endedAt, environment, artifacts[] }
 *
 * Honesty rules (spec §9.2):
 *   - Skipped tests MUST NOT write evidence (no artifact = "missing" in summary).
 *   - `evidenceLevel=ci-worm-sim` CANNOT fill live/SOC slots.
 *   - `evidenceLevel=live` requires real backend (PG + non-owner role + multi-process).
 */

import { describe, it as vitestIt } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  RUN_ROOT_ENV,
  beginRun,
  describeChildArtifact,
  markRunFailed,
  writeCaseArtifact,
  type ChildArtifact,
  type EvidenceLevel,
  type Verdict,
} from '../../../scripts/ws9-livefire';

// ─── Constants ──────────────────────────────────────────────────────────

export const TENANT_A = 'tenant-a';
export const TENANT_B = 'tenant-b';

/**
 * Evidence root for the current execution.
 *
 * The orchestrator (`scripts/ws9-livefire.ts`) owns the directory and passes it
 * via `WS9_OUTPUT_ROOT`.
 */
export function requireRunRoot(): string {
  const root = process.env[RUN_ROOT_ENV];
  if (!root || !root.trim()) {
    throw new Error(
      `${RUN_ROOT_ENV} is not set — run WS9 through scripts/ws9-livefire.ts so evidence is bound to this run`,
    );
  }
  if (!path.isAbsolute(root)) {
    throw new Error(`${RUN_ROOT_ENV} must be an absolute path, got "${root}"`);
  }
  return root;
}

/**
 * A bare runner (e.g. `pnpm --filter @praetor/core test`) must not write into
 * the shared published `docs/baselines/ws9` tree, but it also must not crash on
 * import. Such an execution gets its own private, owned run directory, left
 * unsealed (`status='running'`): the evidence it produces can never be consumed
 * by `verifyRun`, so it cannot fill a WS9 slot.
 */
function resolveRunRootForThisExecution(): string {
  const configured = process.env[RUN_ROOT_ENV];
  if (configured && configured.trim()) return requireRunRoot();
  const fallback = fs.mkdtempSync(path.join(os.tmpdir(), 'ws9-unorchestrated-'));
  process.env[RUN_ROOT_ENV] = fallback;
  beginRun(fallback);
  console.warn(
    `[ws9] ${RUN_ROOT_ENV} is not set; this unorchestrated run writes evidence to ${fallback} and can never fill a WS9 slot.`,
  );
  return fallback;
}

/**
 * WS9 evidence directory for this execution. Tests that shell out to auxiliary
 * producers use this instead of a shared `docs/baselines/ws9` path.
 */
export const WS9_BASELINE_DIR = resolveRunRootForThisExecution();

// ─── Types ──────────────────────────────────────────────────────────────

export type { Verdict, EvidenceLevel, ChildArtifact };

export interface EvidenceArtifact {
  testCaseId: string;
  runId: string;
  verdict: Verdict;
  evidenceLevel: EvidenceLevel;
  breach: boolean;
  details: string;
  gitSha: string;
  startedAt: string;
  endedAt: string;
  environment: string;
  artifacts: ChildArtifact[];
}

export interface ProbeResult {
  available: boolean;
  reason: string;
}

// ─── Infrastructure probes (spec §3.1) ──────────────────────────────────

/** True if a binary is resolvable on PATH (POSIX `command -v`). */
function hasBinary(name: string): boolean {
  const result = spawnSync('sh', ['-c', `command -v ${name}`], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'ignore'],
    timeout: 3_000,
  });
  return result.status === 0 && !!result.stdout?.trim();
}

/** Check Postgres availability: psql binary + COMMANDER_DB_HOST/NAME/USER set. */
export const probePostgres: ProbeResult = (() => {
  if (!hasBinary('psql')) {
    return { available: false, reason: 'psql binary not found on PATH' };
  }
  const host = process.env.COMMANDER_DB_HOST;
  const db = process.env.COMMANDER_DB_NAME;
  const user = process.env.COMMANDER_DB_USER;
  if (!host || !db || !user) {
    return { available: false, reason: 'COMMANDER_DB_HOST/NAME/USER not set' };
  }
  return { available: true, reason: 'psql + COMMANDER_DB_* configured' };
})();

/** Check Vault availability: COMMANDER_VAULT_ADDR + COMMANDER_VAULT_TOKEN set. */
export const probeVault: ProbeResult = (() => {
  const addr = process.env.COMMANDER_VAULT_ADDR;
  const token = process.env.COMMANDER_VAULT_TOKEN;
  if (!addr || !token) {
    return { available: false, reason: 'COMMANDER_VAULT_ADDR/TOKEN not set' };
  }
  return { available: true, reason: `Vault at ${addr}` };
})();

/**
 * Check gVisor availability: runsc on PATH, or docker with `runsc` runtime
 * configured (matches GVisorSB — Colima often exposes runsc only inside the VM).
 */
export const probeGvisor: ProbeResult = (() => {
  if (hasBinary('runsc')) {
    return { available: true, reason: 'runsc binary present' };
  }
  if (hasBinary('docker')) {
    const info = spawnSync('docker', ['info', '--format', '{{.Runtimes}}'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 8_000,
    });
    if (info.status === 0 && (info.stdout ?? '').includes('runsc')) {
      return {
        available: true,
        reason: 'docker runtime runsc configured (runsc not on PATH)',
      };
    }
  }
  return {
    available: false,
    reason: 'runsc binary not found on PATH and docker runsc runtime not configured',
  };
})();

/** Check /v1 gateway availability: COMMANDER_API_HOST/PORT set. */
export const probeV1Gateway: ProbeResult = (() => {
  const host = process.env.COMMANDER_API_HOST;
  const port = process.env.COMMANDER_API_PORT;
  if (!host || !port) {
    return { available: false, reason: 'COMMANDER_API_HOST/PORT not set' };
  }
  return { available: true, reason: `gateway at ${host}:${port}` };
})();

// ─── describeIf — conditional test execution ────────────────────────────

/**
 * Run a `describe` block only when `probe.available` is true; otherwise
 * `describe.skip`. Skipped tests produce NO evidence (spec §9.2 honesty).
 *
 * Usage:
 *   describeIf(probePostgres)('DATA-1: ...', () => { ... });
 *   describeIf(!probePostgres)('DATA-1 (skipped): ...', () => { ... });
 */
export function describeIf(probe: ProbeResult | boolean): typeof describe {
  const available = typeof probe === 'boolean' ? probe : probe.available;
  return available ? describe : describe.skip;
}

// ─── Evidence writers ───────────────────────────────────────────────────

/**
 * Hash-bind a child artifact produced by a case (bench output, scan dump, …).
 *
 * The stored path is relative to this run's output root whenever the artifact
 * lives inside it; anything outside the root is recorded as an absolute
 * `external` reference so the consumer can still re-verify its hash without
 * ever resolving it relative to the run.
 */
export function toChildArtifact(artifactPath: string | ChildArtifact): ChildArtifact {
  if (typeof artifactPath !== 'string') return artifactPath;
  return describeChildArtifact(artifactPath, requireRunRoot());
}

function normalizeChildren(artifacts: Array<string | ChildArtifact>): ChildArtifact[] {
  return artifacts.map((a) => toChildArtifact(a));
}

/**
 * Write a structured evidence JSON artifact into this run's output root.
 * Returns the artifact file path (for inclusion in test output).
 *
 * Fail-closed: if the run root is missing or the write fails, the run manifest
 * is marked `failed` (so an interrupted run can never be consumed as a
 * previous summary) and the error propagates to fail the test.
 */
export function writeEvidence(
  artifact: Omit<EvidenceArtifact, 'gitSha' | 'startedAt' | 'endedAt' | 'environment' | 'runId'> & {
    startedAt?: string;
    endedAt?: string;
  },
): string {
  const runRoot = requireRunRoot();
  const children = normalizeChildren(artifact.artifacts ?? []);
  try {
    const full = writeCaseArtifact(runRoot, {
      testCaseId: artifact.testCaseId,
      verdict: artifact.verdict,
      evidenceLevel: artifact.evidenceLevel,
      breach: artifact.breach,
      details: artifact.details,
      artifacts: children,
      startedAt: artifact.startedAt,
      endedAt: artifact.endedAt,
    });
    return path.join(runRoot, `${full.testCaseId}.json`);
  } catch (err) {
    try {
      markRunFailed(
        runRoot,
        `evidence write failed for ${artifact.testCaseId}: ${(err as Error).message}`,
      );
    } catch {
      // The incomplete marker remains; the run stays unconsumable either way.
    }
    throw err;
  }
}

/**
 * Write a PASS evidence artifact.
 * Default evidenceLevel is `simulated` so unit/mock paths cannot silently
 * fill live/SOC slots. Pass `live` only after a real backend probe succeeded.
 */
export function writePass(
  testCaseId: string,
  details: string,
  artifacts: Array<string | ChildArtifact> = [],
  evidenceLevel: EvidenceLevel = 'simulated',
  timing?: { startedAt?: string; endedAt?: string },
): string {
  const filePath = writeEvidence({
    testCaseId,
    verdict: 'PASS',
    evidenceLevel,
    breach: false,
    details,
    artifacts: normalizeChildren(artifacts),
    startedAt: timing?.startedAt,
    endedAt: timing?.endedAt,
  });
  return filePath;
}

/**
 * Write a BREACH evidence artifact — a cross-tenant isolation breach was
 * detected. This always sets verdict=FAIL in the summary (spec §9.2).
 */
export function writeBreach(
  testCaseId: string,
  details: string,
  artifacts: Array<string | ChildArtifact> = [],
  evidenceLevel: EvidenceLevel = 'simulated',
): string {
  const filePath = writeEvidence({
    testCaseId,
    verdict: 'BREACH',
    evidenceLevel,
    breach: true,
    details,
    artifacts: normalizeChildren(artifacts),
  });
  return filePath;
}

/**
 * Write a FAIL evidence artifact — a test assertion failed (not necessarily a
 * breach, but the expected fail-closed behavior did not hold).
 */
export function writeFail(
  testCaseId: string,
  details: string,
  artifacts: Array<string | ChildArtifact> = [],
  evidenceLevel: EvidenceLevel = 'simulated',
): string {
  const filePath = writeEvidence({
    testCaseId,
    verdict: 'FAIL',
    evidenceLevel,
    breach: false,
    details,
    artifacts: normalizeChildren(artifacts),
  });
  return filePath;
}
