#!/usr/bin/env tsx
/**
 * Rotation sign-off verifier — THIN ASYNC CLI WRAPPER around the library
 * surface published from `@praetor/core`.
 *
 * D3.2: this wrapper now drives the async surface (`runVerifierAsync`) so
 * CI runners batching N×SHAs concurrently do not block the event loop. The
 * sync `runVerifier` surface still exists for backward compatibility —
 * the CLI just no longer uses it.
 *
 * The pure library body (parsing, git verification, policy evaluation, exit-
 * code routing, result-shape contract) lives in
 * `packages/core/src/security/rotationSignoffVerifier.ts` and is reachable
 * as top-level exports from `@praetor/core` (see `packages/core/src/index.ts`).
 *
 * This wrapper's job is JUST:
 *   1. Compute its own REPO_ROOT (script dir → 1 level up = `<repo>/`).
 *   2. Parse CLI flags via the library's `parseArgs()` helper.
 *   3. Invoke the library's `runVerifierAsync(docPath, { repoRoot })`.
 *   4. Route the result to stdout / stderr based on the parsed flags.
 *   5. `process.exit(result.exitCode)` — this is the ONLY place in the
 *      chain where a process actually terminates.
 *
 * CLI usage (unchanged from D2.9 + D3.0):
 *   npx tsx scripts/verify-rotation-signoff.ts [--doc=<path>] [--json] [--quiet]
 *     --doc=<path>    Override the §6 doc path (default: docs/security/keys-rotation.md).
 *     --json          Emit a compact JSON status payload on stdout
 *                      (`{status, exitCode, reasons}`), for shell pipelines / jq.
 *                      Idempotent with --quiet. CI consumers should capture stdout
 *                      into a JSON log; stderr carries the human report by default.
 *     --quiet         Suppress the multi-line human report on stderr; print only
 *                      a one-line summary instead. Useful for CI logs that want
 *                      terse status without per-row diagnostics. Idempotent with
 *                      --json (stdout still emits JSON; stderr becomes terse).
 *
 * Exit codes (unchanged):
 *   0 — policy bound + no failed rows.
 *   1 — policy not bound OR any failed row.
 *   2 — file missing OR §6 missing.
 */

import {
  runVerifierAsync,
  parseArgs,
  POLICY_MIN_VERIFIED_ROWS,
  type CliArgs,
  type VerifyResult,
} from '../packages/core/src/security/rotationSignoffVerifier';
import * as path from 'node:path';

// ============================================================================
// REPO_ROOT resolution — anchored to process.argv[1] (the script path) so
// the wrapper works correctly regardless of `cwd`. Under npx tsx, argv[1]
// is the script's full path; we resolve its parent (the scripts/ dir)
// and step up one level to reach the repo root.
// ============================================================================

function resolveRepoRoot(): string {
  const scriptPath = process.argv[1] ?? '';
  const scriptsDir = scriptPath ? path.dirname(scriptPath) : process.cwd();
  return path.resolve(scriptsDir, '..');
}

const REPO_ROOT = resolveRepoRoot();

// ============================================================================
// formatSummaryLine — the ONE piece of display logic this wrapper owns. The
// library emits the full per-row human report via `result.report`; this
// composes the trailing one-line summary used by `--quiet` and as the
// always-emitted status line for shell `&&` / `||` pipelines.
// ============================================================================

function formatSummaryLine(result: VerifyResult): string {
  if (result.exitCode === 0) return 'Result: GREEN ✅';
  if (result.exitCode === 2) {
    return `Result: RED (PARSE FAILURE) ❌ — ${result.reasons[0] ?? 'parse error'}`;
  }
  // exit 1: derive counts from rows so the summary mirrors the same numbers
  // shown in `report`'s `Policy (D2.x):` body.
  const verified = result.rows.filter((r) => r.verified).length;
  const failed = result.rows.filter((r) => !r.verified && r.sha !== '').length;
  const pending = result.rows.filter((r) => !r.verified && r.sha === '').length;
  return `Result: RED ❌ — verified=${verified} (min=${POLICY_MIN_VERIFIED_ROWS}), ${failed} failed, ${pending} pending`;
}

// ============================================================================
// main — async IIFE so rejection on caller-side I/O surfaces clean exit-2
// (verifier POLICY logic never throws, but `fs.promises.readFile` can
// reject on out-of-band I/O conditions — handle defensively at the
// wrapper layer).
// ============================================================================

async function main(): Promise<void> {
  const args: CliArgs = parseArgs(process.argv.slice(2));
  const result: VerifyResult = await runVerifierAsync(args.docPath, { repoRoot: REPO_ROOT });

  // --json: compact payload on stdout (always emits when flag is set;
  // orthogonal to --quiet which only affects stderr).
  if (args.json) {
    process.stdout.write(
      JSON.stringify({
        status: result.exitCode === 0 ? 'GREEN' : 'RED',
        exitCode: result.exitCode,
        reasons: result.reasons,
      }) + '\n',
    );
  }

  // Default-stderr: full human-readable report. --quiet suppresses it
  // entirely (keeping only the trailing status line for CI log scanning).
  if (!args.quiet) {
    process.stderr.write(result.report + '\n');
  }

  // Always emit a trailing one-line status so `... && echo OK || echo FAIL`
  // pipelines work regardless of flag combinations. Under --quiet this is
  // the ONLY line on stderr; under --json + --quiet ALSO the only line
  // (with stdout carrying the structured payload for jq).
  process.stderr.write(formatSummaryLine(result) + '\n');

  process.exit(result.exitCode);
}

main().catch((err: unknown) => {
  // Out-of-band I/O rejection (e.g. fs.promises.readFile rejecting on
  // permission-denied / race conditions during the existence-check window).
  // The verifier's POLICY logic never throws its way here — this branch
  // exists purely to keep the wrapper future-proof.
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`ERROR (uncaught): ${msg}\n`);
  process.exit(2);
});
