/**
 * Rotation Sign-off Verifier — D2.6 + D2.7 + D2.8 + D2.9 + D3.0 + D3.1 + D3.2 hardening.
 * (Update this header line on each D-bump; runtime literals route through
 *  `POLICY_VERSION` interpolation. Keep the pedigree honest.)
 *
 * Why this exists
 * ───────────────
 * D2.6 §6.1 of `docs/security/keys-rotation.md` requires:
 *   "The effective date is NOT a free-form cell — it is the cryptographic
 *    timestamp of the GPG-signed commit and is derived as:
 *      git log -1 --format=%aI <Signed-Commit SHA>"
 *
 * The §6 table rows are human-edited markdown, but they MUST be backed by
 * GPG-signed commits. This module enforces that binding programmatically:
 *
 *   1. Parse the §6 table from `docs/security/keys-rotation.md` (or any path
      passed to `runVerifierAsync({ docPath })`).
 *   2. For every row whose Signed-Commit SHA cell is non-empty:
 *        a. Strictly validate the SHA against `/^[0-9a-f]{7,64}$/i` (no CRLF,
 *           no semicolons, no command injection — defense in depth).
 *        b. Run `git verify-commit <sha>` (must exit 0 for a valid GPG sig).
 *        c. Run `git log -1 --format=%aI <sha>` to extract the effective date.
 *   3. Apply the active policy rule (track via `POLICY_MIN_VERIFIED_ROWS` +
 *      `POLICY_VERSION`):
 *        - At least `POLICY_MIN_VERIFIED_ROWS` rows MUST hold a GPG-verified
 *          SHA for the policy to be BOUND.
 *        - Empty (placeholder) rows are NOT failures; they are "pending".
 *        - Any row whose SHA is unverified IS a failure.
 *   4. Emit a `VerifyResult` with the per-row surface, a structured
 *      `reasons[]` array, a human-readable `report`, and an `exitCode` that
 *      mirrors the CLI exit-code contract (0 / 1 / 2).
 *
 * Three layers, all exposed:
 *   • Library (this file): pure functions, no I/O at import time, no
 *     `process.exit`, no `require.main` machinations. Importable from any
 *     `@praetor/core` consumer.
 *   • CLI wrapper: `scripts/verify-rotation-signoff.ts` — thin async adapter
 *     that awaits `runVerifierAsync` and routes the result to JSON / human
 *     report based on the parsed CLI flags. (D3.2: CLI now uses async.)
 *   • vitest regression gates: the three `tests/security/d2?-*.test.ts`
 *     suites that pin the matrix + library API contract (D2.6 + D3.0 + D3.1
 *     + D3.2 coverage).
 *
 * ──────────────────────────────────────────────────────────────────────────
 * Worked Example — Library Consumer Pattern (async paths)
 * ──────────────────────────────────────────────────────────────────────────
 * ```ts
 * import {
 *   runVerifierAsync,
 *   verifyShasConcurrent,
 *   evaluateSignoffAsync,
 *   parseArgs,
 *   POLICY_VERSION,
 *   POLICY_MIN_VERIFIED_ROWS,
 *   VERIFY_CONCURRENCY_DEFAULT,
 *   type VerifyResult,
 *   type VerifyShaResult,
 *   type RunVerifierAsyncOptions,
 * } from '@praetor/core';
 *
 * // 1. CI gate — drive the policy evaluator directly on synthetic rows:
 * const result: VerifyResult = await evaluateSignoffAsync([
 *   { role: 'CISO',             name: '', handle: '', fingerprint: '', sha: 'abc1234', signedAt: null, signedBy: null, verified: true,  error: null },
 *   { role: 'Head of Security', name: '', handle: '', fingerprint: '', sha: 'def5678', signedAt: null, signedBy: null, verified: true,  error: null },
 *   { role: 'Engineering Lead', name: '', handle: '', fingerprint: '', sha: '9abcdef', signedAt: null, signedBy: null, verified: true,  error: null },
 *   { role: 'Compliance Lead',  name: '', handle: '', fingerprint: '', sha: 'cafe0000',signedAt: null, signedBy: null, verified: true,  error: null },
 * ]);
 * if (result.ok) {
 *   console.log(`${POLICY_VERSION} bound — every row verified.`);
 * } else {
 *   // result.reasons[] carries structured discrete signals. Iterate
 *   // rather than regex-parse `result.report`.
 *   for (const reason of result.reasons) {
 *     alertingPipeline.emit({ source: 'rotation-verifier', reason });
 *   }
 * }
 *
 * // 2. CI batch — concurrently verify N SHAs in-flight (D3.2's primary use case):
 * const shas: string[] = ['abc1234', 'def5678', '9abcdef', 'cafe0000'];
 * const results: VerifyShaResult[] = await verifyShasConcurrent(
 *   shas,
 *   process.cwd(),
 *   { concurrency: VERIFY_CONCURRENCY_DEFAULT },
 * );
 * for (const r of results) {
 *   if (!r.verified) {
 *     console.warn(`SHA failed: ${r.error}`);
 *   }
 * }
 *
 * // 3. CLI flag parsing — useful for any wrapper that wraps this lib:
 * const args = parseArgs(process.argv.slice(2));
 * const live: VerifyResult = await runVerifierAsync(args.docPath, {
 *   repoRoot: process.cwd(),
 * });
 * ```
 *
 * Exit-code contract (mirrors the CLI)
 * ────────────────────────────────────
 *   0 — policy is bound (≥ POLICY_MIN_VERIFIED_ROWS verified) AND every
 *       non-empty SHA verified.
 *   1 — policy not bound (no rows, all rows pending, any row unverified,
 *       or 0-row parsed §6 fallback).
 *   2 — file could not be parsed (file missing, §6 section missing entirely).
 *
 * Backwards-compat / migration
 * ────────────────────────────
 * Pre-D3.0 callers that used to regex-parse `result.report` for the AND-
 * stacked RED prose continue to work unchanged. New callers should
 * iterate `result.reasons[]` directly. The `formatReport(rows)` helper
 * is also exported for consumers building their own display formats.
 *
 * Async surface (D3.2)
 * ─────────────────────
 * For CI runners that batch N×git-verification calls across multiple SHAs,
 * the D3.2 async surface (`verifyShaAsync`, `evaluateSignoffAsync`,
 * `runVerifierAsync`) plus the bounded-concurrency batcher
 * (`verifyShasConcurrent`) keep the verifier event-loop-friendly under high
 * SHAs-per-doc ratios. The legacy sync surface was removed in the
 * structural-debt cleanup; all programmatic consumers should use the async
 * variants.
 *
 * Importing — canonical type names from the SECURITY barrel
 * ─────────────────────────────────────────────────────────
 * Most canonical type names (`SignoffRow`, `CliArgs`, `RunVerifierOptions`,
 * `VerifyShaResult`, `RunVerifierAsyncOptions`) resolve from
 * `@praetor/core/security` (security barrel) without any rename.
 * `VerifyResult` is intentionally NOT re-exported from the security barrel
 * because `@praetor/core/security` already exports a same-named (unrelated)
 * `VerifyResult` from the `capabilityToken` module — duplicate types are a
 * TypeScript error at the barrel surface, not just a runtime concern.
 *
 * Library consumers who need THIS module's `VerifyResult` should pick one
 * of three approaches:
 *
 *   ```ts
 *   // Approach 1 — type-inference brings it for free:
 *   import { evaluateSignoffAsync } from '@praetor/core/security';
 *   const r = await evaluateSignoffAsync(rows); // r: VerifyResult (inferred)
 *
 *   // Approach 2 — direct from the verifier file path:
 *   import type { VerifyResult } from
 *     '@praetor/core/security/rotationSignoffVerifier';
 *
 *   // Approach 3 — main-barrel alias (always resolves correctly):
 *   import type { RotationSignoffResult } from '@praetor/core';
 *   ```
 *
 * The MAIN barrel (`@praetor/core`) re-exports the async verifier VALUES
 * plus type-aliased forms (`RotationSignoffResult`, `RotationSignoffRow`,
 * `RotationSignoffCliArgs`, `RotationVerifyShaResult`,
 * `RotationRunVerifierAsyncOptions`). The rotate-prefixed names are the
 * bleed-free default for any consumer that wants a single unbroken type
 * chain from `@praetor/core`.
 */

// Removed `#!/usr/bin/env tsx` — this is now a library module, not a CLI.
// Removed the script's hardcoded `REPO_ROOT = path.resolve(__dirname, '..')`
// in favor of `process.cwd()` defaulting + per-call `options.repoRoot`.
// D3.2: also uses `execFile` (native Promise return) for async git-invocation
// instead of wrapping `spawnSync` — preserves arg-array (no shell interpretation).

import { reportSilentFailure } from '../silentFailureReporter';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ===========================================================================
// Public types
// ===========================================================================

/**
 * One §6 Sign-off table row, fully resolved.
 * Empty cells remain empty strings (NOT undefined) so callers don't have
 * to distinguish "missing" from "intentionally empty".
 */
export interface SignoffRow {
  /** Role label as it appears in the table (e.g. "CISO", "Engineering Lead"). */
  role: string;
  /** Human name. Empty string when not specified. */
  name: string;
  /** GitHub handle. Empty string when not specified. */
  handle: string;
  /** Short or full GPG fingerprint. Empty string when not specified. */
  fingerprint: string;
  /** Signed-Commit SHA. Empty string when the row has not yet been signed off. */
  sha: string;
  /** ISO8601 author date of the signed commit (`git log -1 --format=%aI`). */
  signedAt: string | null;
  /** Best-effort signer name parsed from `git verify-commit` output. */
  signedBy: string | null;
  /** Result of `git verify-commit <sha>`. False on any failure. */
  verified: boolean;
  /** Last-line git verification error. Null on success. */
  error: string | null;
}

/**
 * The final, exhaustive result of one verifier run.
 *
 * D3.0: `reasons` is ALWAYS populated (never undefined / null). Shape:
 *   • OK (exit 0)              → []  (empty; semantic "no actionable defects")
 *   • RED single-clause         → single-element array.
 *   • RED dual-clause           → array of 2 strings, each an independent
 *                                 DETAILED reason; the `report` field joins
 *                                 these with ' AND ' for human prose, but
 *                                 structured dashboards / alerts should iterate
 *                                 `reasons[]` directly to render bulleted lists
 *                                 or trigger per-clause actions.
 *   • exit 2 (parse failure)    → single-element carrying the error caption.
 *
 * Backwards-compatibility: `report` (human-readable string) is unchanged.
 * Callers that used to regex-parse `report` continue to work; new callers
 * use `reasons[]` for structured access.
 *
 * ALWAYS frozen via `Object.freeze([...])` on every return path so a
 * consumer that tries to mutate the array fails fast (TypeError) instead
 * of silently corrupting shared state.
 */
export interface VerifyResult {
  /** True iff policy is BOUND AND no row has failed verification. */
  ok: boolean;
  /** All parsed §6 rows, with their verification result populated. */
  rows: SignoffRow[];
  /** Discrete structured reasons — see interface-level doc above. */
  reasons: readonly string[];
  /** Multi-line human-readable report. AND-joins `reasons[]` on failure. */
  report: string;
  /** CLI exit code (0 / 1 / 2). Mirrors the contract for shell pipelines. */
  exitCode: number;
}

/**
 * Per-SHA verification result. Returned by `verifyShaAsync` (D3.2 async).
 * Extracted as a named type so consumers can type their own batchers /
 * dashboards without spelunking the source.
 */
export interface VerifyShaResult {
  /** Result of `git verify-commit <sha>`. False on any failure (incl. format). */
  verified: boolean;
  /** ISO8601 author date from `git log -1 --format=%aI <sha>`. */
  signedAt: string | null;
  /** Best-effort signer name parsed from `git verify-commit` output. */
  signedBy: string | null;
  /** Last-line git verification error. Null on success. */
  error: string | null;
}

/**
 * Parsed CLI flag surface returned by `parseArgs()`. Library consumers can
 * import this type to build their own flag-aware wrappers around the
 * verifier without re-implementing flag parsing.
 */
export interface CliArgs {
  /** Path to the §6 markdown doc. Default: `DEFAULT_DOC_PATH`. */
  docPath: string;
  /** `true` if `--json` was passed. */
  json: boolean;
  /** `true` if `--quiet` was passed. */
  quiet: boolean;
}

// ===========================================================================
// Constants — exported for policy-bump discoverability
// ===========================================================================

/**
 * Defense-in-depth: every SHA flowing into the verifier is matched against
 * this regex BEFORE it reaches `git verify-commit`. This prevents a malicious
 * doc edit from injecting CRLF, semicolons, argument-expander chars, etc.
 * into the spawned git invocation. Exported so consumers can perform the
 * same defense-in-depth validation in their own gate layers.
 */
export const SHA_RE = /^[0-9a-f]{7,64}$/i;

/**
 * Markdown table row shape (after D2.6):
 *   | Role                | Name | GitHub handle | GPG fingerprint | Signed-Commit SHA        |
 *   | **CISO**            |      |               |                 |  abc1234…                                                  |
 *
 * Captures 1..5: role (bold), name, handle, fingerprint, sha.
 */
const ROW_RE =
  /^\|\s*\*\*([^*]+)\*\*\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*$/;

/**
 * Default §6 doc path, resolved RELATIVE to a repo root. Consumers and
 * the CLI wrapper resolve this against their `repoRoot` (or
 * `process.cwd()`).
 */
export const DEFAULT_DOC_PATH = 'docs/security/keys-rotation.md';

/**
 * POLICY: at least this many role rows must hold a GPG-verified SHA
 * for the policy to be considered BOUND. Bump history:
 *   • D2.7 → 1: any single verified row binds policy.
 *   • D2.8 → 2: CISO + ≥1 other role.
 *   • D2.9 → 4: full 4-role gate, all required.
 */
export const POLICY_MIN_VERIFIED_ROWS = 4;

/**
 * Bump-tracking tag. Single source of truth for the live CLI's report
 * header line and `(D2.x):` policy-summary labels. Bump this constant
 * on every policy-version change; runtime strings sail through
 * `${POLICY_VERSION}` interpolation.
 */
export const POLICY_VERSION = 'D2.9';

/**
 * D3.2: Default concurrency bound for `verifyShasConcurrent` and
 * `runVerifierAsync`. 4 is a sensible default for typical CI runners —
 * faster than sequential on 16-row tables (4× wallclock savings),
 * bounded to prevent fork-bomb on misconfigured runs. Consumers can
 * override via `options.concurrency`.
 */
export const VERIFY_CONCURRENCY_DEFAULT = 4;

/**
 * D3.2: per-git-invocation timeout in milliseconds. Applies to
 * `verifyShaAsync` (via execFile). At 30s, an unusually slow
 * `git verify-commit` (large keyring, slow GPG agent) won't block CI forever.
 */
const GIT_INVOCATION_TIMEOUT_MS = 30_000;

// ===========================================================================
// §6 section extraction
// ===========================================================================

/**
 * Pull a `## <sectionTitle>` section out of the markdown document,
 * exclusive of the following `## ` heading. Returns null if the section is
 * missing.
 *
 * @example
 * ```ts
 * const text = fs.readFileSync('keys-rotation-fork.md', 'utf-8');
 * const section = extractSection(text, '§6 — Sign-off');
 * if (section === null) throw new Error('doc missing §6');
 * ```
 */
export function extractSection(docText: string, sectionTitle: string): string | null {
  const startMarker = new RegExp(`^## ${sectionTitle}\\b`, 'm');
  const startMatch = startMarker.exec(docText);
  if (!startMatch) return null;
  // Skip past the header LINE (including its trailing newline) BEFORE
  // searching for the next `## ` heading — otherwise the multiline-anchored
  // `^\s*##\s` regex below matches the §6 header ITSELF at index 0, so
  // `endIdx` ends up 0 and the function returns the empty string.
  const headerLineEnd = docText.indexOf('\n', startMatch.index);
  const afterStart =
    headerLineEnd >= 0 ? headerLineEnd + 1 : startMatch.index + startMatch[0].length;
  const after = docText.slice(afterStart);
  // Stop at the next `## ` heading line (regardless of section number).
  const nextHeading = /^\s*##\s/m.exec(after);
  const endIdx = nextHeading ? after.indexOf(nextHeading[0]) : after.length;
  return after.slice(0, endIdx);
}

// ===========================================================================
// Table parser
// ===========================================================================

/**
 * Parse §6 data rows from the section text. Returns an array of SignoffRow
 * objects; rows whose role cell is not bold-formatted are skipped (those
 * are the header row, the column separator, or prose that incidentally
 * starts with `|`).
 *
 * @example
 * ```ts
 * const rows: SignoffRow[] = parseSignoffTable(section);
 * // rows[0]?.role === 'CISO'
 * // rows[0]?.sha === ''   (when row is unfilled)
 * ```
 */
export function parseSignoffTable(section: string): SignoffRow[] {
  const rows: SignoffRow[] = [];
  for (const rawLine of section.split('\n')) {
    const line = rawLine.trim();
    const match = ROW_RE.exec(line);
    if (!match) continue;
    const [, role, name, handle, fingerprint, sha] = match;
    rows.push({
      role: role.trim(),
      name: name.trim(),
      handle: handle.trim(),
      fingerprint: fingerprint.trim(),
      sha: sha.trim(),
      signedAt: null,
      signedBy: null,
      verified: false,
      error: null,
    });
  }
  return rows;
}

/**
 * Validate column count from a representative data row.
 *
 * @example
 * ```ts
 * expect(countColumns('| Role | Name | Handle | FP | SHA |')).toBe(5);
 * ```
 */
export function countColumns(line: string): number {
  // First, strip the leading + trailing pipes, then split on pipes.
  const stripped = line.replace(/^\s*\|/, '').replace(/\|\s*$/, '');
  return stripped.split('|').length;
}

// ===========================================================================
// Git invocation — async surface
// ===========================================================================

/**
 * Compose the canonical "invalid SHA format" reason. The rejection
 * rationale is consistent across the async surface so callers can rely on
 * identical error strings.
 */
function invalidShaReason(sha: string): string {
  return `invalid SHA format: ${JSON.stringify(sha.slice(0, 64))}`;
}

/**
 * D3.2: Internal helper — wrap `child_process.execFile` to return a
 * `Promise` over the structured `{ stdout, stderr, status }` shape used
 * by all git-invocations in the verifier. `execFile` natively supports
 * `options.signal` (Node 17+) which propagates AbortSignal cancellation
 * to the spawned process — the resulting promise rejects with the
 * AbortError.
 */
function runGit(
  args: string[],
  cwd: string,
  options: { signal?: AbortSignal } = {},
): Promise<{ stdout: string; stderr: string; status: number }> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: { stdout: string; stderr: string; status: number }): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    execFile(
      'git',
      args,
      {
        cwd,
        encoding: 'utf-8',
        timeout: GIT_INVOCATION_TIMEOUT_MS,
        // Node 17+ supports execFile with options.signal directly. The
        // child process is killed if the signal aborts, and the callback
        // fires with an AbortError. We catch that and yield a status=-1
        // sentinel rather than rejecting, so `verifyShaAsync` returns
        // a structured VerifyShaResult.
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      },
      (err, stdout, stderr) => {
        if (err) {
          // Distinguish abort from other I/O failures by the err name.
          // Aborted consumers can re-throw upstream if they want the
          // promise to reject — for now we surface status=-1 so the
          // caller-side error string reflects the abort cleanly.
          settle({
            stdout: (stdout ?? '') as string,
            stderr: (stderr ?? '') as string,
            status: err.name === 'AbortError' ? -2 : -1,
          });
          return;
        }
        settle({
          stdout: (stdout ?? '') as string,
          stderr: (stderr ?? '') as string,
          status: 0,
        });
      },
    );
  });
}

/**
 * D3.2: Async SHA verifier. Uses `execFile` for native Promise delivery —
 * no event-loop block per SHA, no shell interpretation, args reach git
 * verbatim.
 *
 * SECURITY: arg-array mode preserved. SHA_RE pre-filter runs BEFORE the
 * execFile call, so a malicious SHA never reaches git at all.
 *
 * Error model:
 *   • Promise resolves with `{ verified: false, error: 'invalid SHA format…' }`
 *     for SHA_RE failures.
 *   • Promise resolves with `{ verified: false, error: <stderr snippet> }`
 *     when execFile exits non-zero.
 *   • When `options.signal` aborts: Promise resolves with
 *     `{ verified: false, error: 'aborted', signedAt: null, signedBy: null }`
 *     (status: -2 sentinel from `runGit`). Callers that want a strict
 *     abort-rejection should wrap with `signal.throwIfAborted()` first.
 *
 * @example
 * ```ts
 * const r = await verifyShaAsync('abc1234def567890', '/path/to/repo');
 * if (!r.verified) console.warn(`SHA failed: ${r.error}`);
 * ```
 *
 * @example
 * ```ts
 * // Cancellation-aware:
 * const controller = new AbortController();
 * setTimeout(() => controller.abort(), 5_000);
 * try {
 *   await verifyShaAsync('abc1234def567890', process.cwd(), {
 *     signal: controller.signal,
 *   });
 * } catch (e) {
 *   // AbortError or signal-bound — handle timeout.
 * }
 * ```
 */
export function verifyShaAsync(
  sha: string,
  cwd: string = process.cwd(),
  options: { signal?: AbortSignal } = {},
): Promise<VerifyShaResult> {
  if (!SHA_RE.test(sha)) {
    return Promise.resolve({
      verified: false,
      signedAt: null,
      signedBy: null,
      error: invalidShaReason(sha),
    });
  }
  // Allow CI/sandbox runners without a usable GPG keyring to skip the actual
  // signature verification while still exercising SHA validation and policy
  // evaluation. This must be opt-in via env var so production still verifies.
  if (process.env.ROTATION_SIGNOFF_NO_GPG_VERIFY === '1') {
    return Promise.resolve({
      verified: false,
      signedAt: null,
      signedBy: null,
      error: 'GPG verification skipped (ROTATION_SIGNOFF_NO_GPG_VERIFY=1)',
    });
  }
  return Promise.all([
    runGit(['verify-commit', sha], cwd, options),
    runGit(['log', '-1', '--format=%aI', sha], cwd, options),
  ]).then(([verifyOut, dateOut]) => {
    // Aborted path — short-circuit with a sentinel VerifyShaResult.
    if (verifyOut.status === -2) {
      return {
        verified: false,
        signedAt: null,
        signedBy: null,
        error: 'aborted',
      } satisfies VerifyShaResult;
    }
    // Compute `signedAt` ONCE outside the verified/unverified branches so
    // both shapes inherit identical metadata when `git log -1` succeeded.
    // The unverified-fallback path still surfaces the timestamp if the date
    // extraction worked. `dateOk` is the single shared predicate (DRY): both
    // `signedAt` and `verified` derive from the same `dateOut.status === 0`
    // check.
    const dateOk = dateOut.status === 0;
    const signedAt = dateOk ? (dateOut.stdout ?? '').trim() || null : null;
    const verified = verifyOut.status === 0 && dateOk;
    if (!verified) {
      const verifyStderr = verifyOut.stderr ?? '';
      const errLine =
        verifyStderr
          .split('\n')
          .map((l: string) => l.trim())
          .filter(Boolean)
          .slice(-3)
          .join(' • ') ?? `git verify-commit exited ${verifyOut.status || 'unknown'}`;
      return {
        verified: false,
        signedAt,
        signedBy: null,
        error: errLine,
      } satisfies VerifyShaResult;
    }
    const sigMatch = (verifyOut.stdout ?? '').match(/Good signature from "([^"]+)"/);
    return {
      verified: true,
      signedAt,
      signedBy: sigMatch?.[1] ?? '(unknown signer)',
      error: null,
    } satisfies VerifyShaResult;
  });
}

/**
 * D3.2: Concurrent batch — verify N×SHAs with bounded parallelism.
 * Returns an array of VerifyShaResult in the SAME order as the input
 * `shas` array (preserves input indexing for callers that want to map
 * by SHA). Uses `verifyShaAsync` internally.
 *
 * Concurrency model:
 *   • `options.concurrency` defaults to `VERIFY_CONCURRENCY_DEFAULT` (4).
 *   • At any time, at most `concurrency` git processes are in-flight.
 *   • Resolution order: each `verifyShaAsync` resolves independently;
 *     the wrapper collects them into the result array as they complete.
 *   • On signal abort, every in-flight `verifyShaAsync` is killed; the
 *     wrapper rejects the outer promise with the AbortError.
 *
 * @example
 * ```ts
 * const shas = parsedRows.filter((r) => r.sha !== '').map((r) => r.sha);
 * const results = await verifyShasConcurrent(shas, repoRoot, {
 *   concurrency: 8,
 *   signal: abortController.signal,
 * });
 * for (let i = 0; i < shas.length; i++) {
 *   if (!results[i]?.verified) console.warn(`${shas[i]} failed`);
 * }
 * ```
 */
export function verifyShasConcurrent(
  shas: readonly string[],
  cwd: string = process.cwd(),
  options: { concurrency?: number; signal?: AbortSignal } = {},
): Promise<VerifyShaResult[]> {
  const concurrency = Math.max(1, options.concurrency ?? VERIFY_CONCURRENCY_DEFAULT);
  // Bounded upper guard — typed int but not unbounded (a typo'd 1e6 would
  // effectively disable the bound — reject it loudly).
  if (concurrency > 256) {
    return Promise.reject(
      new RangeError(
        `verifyShasConcurrent: concurrency=${concurrency} exceeds the 256 safe bound. Pick a value in [1, 256].`,
      ),
    );
  }
  if (shas.length === 0) {
    return Promise.resolve([] as VerifyShaResult[]);
  }
  // Honor already-aborted signals up-front (matches `AbortController` semantics).
  if (options.signal?.aborted) {
    return Promise.reject(options.signal.reason ?? new Error('aborted'));
  }

  const results: VerifyShaResult[] = new Array(shas.length);
  return new Promise<VerifyShaResult[]>((resolve, reject) => {
    let nextIdx = 0;
    let activeCount = 0;
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      reject(options.signal?.reason ?? new Error('aborted'));
    };
    if (options.signal) {
      options.signal.addEventListener('abort', onAbort, { once: true });
    }
    const launchNext = (): void => {
      if (settled) return;
      while (activeCount < concurrency && nextIdx < shas.length) {
        const i = nextIdx++;
        activeCount++;
        verifyShaAsync(shas[i]!, cwd, { signal: options.signal })
          .then((r) => {
            if (!settled) results[i] = r;
          })
          .catch((err) => {
            if (!settled) {
              settled = true;
              if (options.signal) options.signal.removeEventListener('abort', onAbort);
              reject(err);
            }
          })
          .finally(() => {
            activeCount--;
            if (settled) return;
            if (nextIdx >= shas.length && activeCount === 0) {
              settled = true;
              if (options.signal) options.signal.removeEventListener('abort', onAbort);
              resolve(results as VerifyShaResult[]);
            } else if (nextIdx < shas.length) {
              launchNext();
            }
          });
      }
      // Edge case: zero SHAs (already handled above via early return);
      // or all launched and nothing pending → resolve immediately.
      if (nextIdx >= shas.length && activeCount === 0 && !settled) {
        settled = true;
        if (options.signal) options.signal.removeEventListener('abort', onAbort);
        resolve(results as VerifyShaResult[]);
      }
    };
    launchNext();
  });
}

// ===========================================================================
// POLICY evaluator — internal logic + async surface
// ===========================================================================

/**
 * Apply the policy versioned by `POLICY_VERSION` to a set of already-verified
 * `SignoffRow` objects.
 *
 * OK = (verifiedCount >= min) AND (failedCount === 0).
 *
 * D3.0: dual-failure cases surface EACH independent clause as a separate
 * element on `result.reasons[]`. The human-readable `report` joins them with
 * " AND " for prose readability, but structured consumers iterate
 * `reasons[]` directly.
 *
 * Internal implementation shared by `evaluateSignoffAsync` and
 * `runVerifierAsync`. Use the exported async surface for programmatic access.
 */
function evaluateSignoff(rows: readonly SignoffRow[]): VerifyResult {
  const verified = rows.filter((r) => r.verified).length;
  const failed = rows.filter((r) => !r.verified && r.sha !== '').length;
  const pending = rows.filter((r) => !r.verified && r.sha === '').length;

  const ok = verified >= POLICY_MIN_VERIFIED_ROWS && failed === 0;
  const reasons: string[] = [];
  if (verified < POLICY_MIN_VERIFIED_ROWS) {
    reasons.push(
      `policy NOT bound — at least ${POLICY_MIN_VERIFIED_ROWS} role(s) must hold a GPG-verified SHA`,
    );
  }
  if (failed > 0) {
    reasons.push(`${failed} unverified SHA(s) need to be fixed`);
  }
  const report =
    formatReport(rows) +
    '\n' +
    `Policy (${POLICY_VERSION}): verified=${verified} (min=${POLICY_MIN_VERIFIED_ROWS}), ` +
    `failed=${failed}, pending=${pending}. ` +
    (ok ? `OK: policy bound.` : `RED: ${reasons.join(' AND ')}.`);

  return {
    ok,
    rows: rows.map((r) => ({ ...r })),
    reasons: Object.freeze([...reasons]),
    report,
    exitCode: ok ? 0 : 1,
  };
}

/**
 * D3.2: Async policy evaluator. Wraps the internal `evaluateSignoff` pure
 * function in `Promise.resolve` for call-site symmetry with `verifyShaAsync`
 * / `runVerifierAsync`, so a uniform async pipeline reads consistently across
 * the surface.
 *
 * @example
 * ```ts
 * const r: VerifyResult = await evaluateSignoffAsync(rows);
 * for (const reason of r.reasons) alertingPipeline.emit(reason);
 * ```
 */
export function evaluateSignoffAsync(rows: readonly SignoffRow[]): Promise<VerifyResult> {
  return Promise.resolve(evaluateSignoff(rows));
}

// ===========================================================================
// Report formatting
// ===========================================================================

/**
 * Build a deterministic, line-friendly report including one row per parsed
 * §6 entry. Pure function — used internally by the policy evaluator to
 * compose `result.report`; can also be used standalone for partial outputs.
 *
 * @example
 * ```ts
 * const failed = rows.filter((r) => !r.verified && r.sha !== '');
 * console.log(formatReport(failed));
 * ```
 */
export function formatReport(rows: readonly SignoffRow[]): string {
  const lines: string[] = [];
  lines.push(`${POLICY_VERSION} rotation sign-off verification report`);
  lines.push('==========================================');
  let verified = 0;
  let pending = 0;
  let failed = 0;
  const ROLE_W = Math.max(20, ...rows.map((r) => r.role.length));
  const SHA_W = 14;
  for (const row of rows) {
    const rolePadded = row.role.padEnd(ROLE_W, ' ');
    if (row.sha === '') {
      pending++;
      lines.push(`  [pending ]  ${rolePadded}  (no Signed-Commit SHA yet)`);
      continue;
    }
    const shaDisplay =
      row.sha.length > SHA_W ? row.sha.slice(0, SHA_W - 1) + '…' : row.sha.padEnd(SHA_W, ' ');
    if (row.verified) {
      verified++;
      lines.push(
        `  [verified]  ${rolePadded}  ${shaDisplay}  signed_at=${row.signedAt ?? '?'}  signer=${row.signedBy ?? '?'}`,
      );
    } else {
      failed++;
      lines.push(`  [FAILED  ]  ${rolePadded}  ${shaDisplay}  error=${row.error ?? 'unverified'}`);
    }
  }
  lines.push('------------------------------------------');
  lines.push(`Summary: ${verified} verified, ${pending} pending, ${failed} FAILED`);
  return lines.join('\n');
}

// ===========================================================================
// Top-level run — async + options
// ===========================================================================

/**
 * Options accepted by the async verifier surface. All fields optional —
 * sensible defaults are applied for missing values.
 */
export interface RunVerifierOptions {
  /**
   * Repo root used as `cwd` for `git verify-commit` invocations and as
   * the base for resolving the default §6 doc path. Defaults to
   * `process.cwd()`.
   */
  repoRoot?: string;
}

/**
 * D3.2: Options accepted by `runVerifierAsync()`. Extends
 * `RunVerifierOptions` with concurrency + signal for batching efficiency
 * and cancellation support.
 */
export interface RunVerifierAsyncOptions extends RunVerifierOptions {
  /**
   * Concurrency limit for the SHA-verification phase. Defaults to
   * `VERIFY_CONCURRENCY_DEFAULT` (4). Ignored when no SHA rows need
   * verification (pure-pending or 0-row cases).
   */
  concurrency?: number;
  /**
   * Cancellation signal — propagated to every in-flight `verifyShaAsync`
   * call. On abort, the outer promise rejects with the signal's reason
   * (or a generic `Error('aborted')`). Each in-flight git process is
   * killed via the signal.
   */
  signal?: AbortSignal;
}

/**
 * D3.2: Async end-to-end verifier. Performs the orchestration steps
 * (parse, SHA-verify, policy evaluate, report) using `fs.promises.readFile`
 * + `verifyShasConcurrent` for non-blocking I/O. The Promise resolves with
 * the same `VerifyResult` shape as the legacy sync surface so callers can
 * swap implementations without changing result-handling code.
 *
 * Throw contract: POLICY LOGIC never throws (returns exitCode=2 for missing
 * doc / missing §6). However, OUTER I/O such as `fs.promises.readFile`
 * rejecting on ENOENT race / permission denied etc. CAN surface as Promise
 * rejection — defensively wrapping at the consumer layer is fine but not
 * required for the verifier's core correctness invariants.
 *
 * @example
 * ```ts
 * const result: VerifyResult = await runVerifierAsync();
 * if (!result.ok) process.exit(result.exitCode);
 * ```
 *
 * @example
 * ```ts
 * // Bounded-concurrency cancellation-aware invocation:
 * const controller = new AbortController();
 * setTimeout(() => controller.abort(), 30_000);
 * const result = await runVerifierAsync(undefined, {
 *   concurrency: 8,
 *   signal: controller.signal,
 * });
 * ```
 */
export async function runVerifierAsync(
  docPath: string = path.join(process.cwd(), DEFAULT_DOC_PATH),
  options: RunVerifierAsyncOptions = {},
): Promise<VerifyResult> {
  const repoRoot = options.repoRoot ?? process.cwd();
  const resolvedDocPath = path.isAbsolute(docPath) ? docPath : path.resolve(repoRoot, docPath);

  // Honor already-aborted signals up-front (matches AbortController
  // semantics) — exit 2 with abort-reason before reading the file.
  if (options.signal?.aborted) {
    const reason = options.signal.reason ?? new Error('aborted');
    const msg = `ERROR: aborted at doc-existence check for ${resolvedDocPath}: ${
      reason instanceof Error ? reason.message : String(reason)
    }`;
    return {
      ok: false,
      rows: [],
      reasons: Object.freeze([msg]),
      report: msg,
      exitCode: 2,
    };
  }

  // File-existence check + read in two stages (matches sync's pattern).
  // `fs.promises.access` is the canonical async replacement for
  // `fs.existsSync`; rejects on missing.
  let exists = true;
  try {
    await fs.promises.access(resolvedDocPath);
  } catch (err) {
    reportSilentFailure(err, 'rotationSignoffVerifier:1062');
    exists = false;
  }
  if (!exists) {
    const msg = `ERROR: doc not found at ${resolvedDocPath}`;
    return {
      ok: false,
      rows: [],
      reasons: Object.freeze([msg]),
      report: msg,
      exitCode: 2,
    };
  }

  // Read the doc — fs.promises.readFile may reject on outer I/O failures.
  // Verifier's policy logic doesn't catch these (caller decides), but file
  // missing vs permission-denied are handled the same way structurally:
  // missing → exitCode=2 path; permission-denied → propagate via rejection.
  const text = await fs.promises.readFile(resolvedDocPath, 'utf-8');
  const section = extractSection(text, '§6 — Sign-off');
  if (section === null) {
    const msg = `ERROR: §6 Sign-off section not found in ${resolvedDocPath}`;
    return {
      ok: false,
      rows: [],
      reasons: Object.freeze([msg]),
      report: msg,
      exitCode: 2,
    };
  }
  const parsed = parseSignoffTable(section);
  if (parsed.length === 0) {
    const reason = `policy NOT bound — at least ${POLICY_MIN_VERIFIED_ROWS} role(s) must hold a GPG-verified SHA`;
    return {
      ok: false,
      rows: [],
      reasons: Object.freeze([reason]),
      report:
        `${POLICY_VERSION} rotation sign-off verification report\n` +
        '==========================================\n' +
        '  (no role rows parsed from §6 table — policy not bound)\n' +
        '------------------------------------------\n' +
        `Policy (${POLICY_VERSION}): verified=0 (min=${POLICY_MIN_VERIFIED_ROWS}), failed=0, pending=0.\n` +
        `RED: ${reason}.`,
      exitCode: 1,
    };
  }

  // Concurrent SHA verification path — separates pending rows (sha === '')
  // from rows needing git verification, runs `verifyShasConcurrent` on
  // the populated-SHA subset, then re-attaches per-row metadata.
  const shaRows = parsed.filter((r) => r.sha !== '');
  let batchResults: VerifyShaResult[] = [];
  if (shaRows.length > 0) {
    batchResults = await verifyShasConcurrent(
      shaRows.map((r) => r.sha!),
      repoRoot,
      { concurrency: options.concurrency, signal: options.signal },
    );
  }
  for (let i = 0; i < shaRows.length; i++) {
    const row = shaRows[i]!;
    const v = batchResults[i]!;
    row.verified = v.verified;
    row.signedAt = v.signedAt;
    row.signedBy = v.signedBy;
    row.error = v.error;
  }

  // evaluateSignoffAsync is a Promise.resolve wrap; the await is for
  // call-site consistency with rest of the async surface.
  return evaluateSignoff(parsed);
}

// ===========================================================================
// CLI flag parsing — exposed for consumer wrappers
// ===========================================================================

/**
 * Parse the small flag surface exposed to the operator on the command line.
 * Pure function — does NOT call `process.exit` and does NOT write to
 * stdout/stderr. Caller is responsible for consuming `args` and acting
 * on them.
 *
 * @example
 * ```ts
 * const args = parseArgs(process.argv.slice(2));
 * const result = await runVerifierAsync(args.docPath, { repoRoot: REPO_ROOT });
 * if (args.json) process.stdout.write(JSON.stringify(result.reasons) + '\n');
 * if (!args.quiet) process.stderr.write(result.report + '\n');
 * process.exit(result.exitCode);
 * ```
 */
export function parseArgs(
  argv: readonly string[],
  defaultDocPath: string = DEFAULT_DOC_PATH,
): CliArgs {
  const docArg = argv.find((a) => a.startsWith('--doc='));
  const docPath = docArg ? docArg.slice('--doc='.length) : defaultDocPath;
  const json = argv.includes('--json');
  const quiet = argv.includes('--quiet');
  return { docPath, json, quiet };
}
