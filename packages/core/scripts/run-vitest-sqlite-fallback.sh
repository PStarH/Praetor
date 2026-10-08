#!/usr/bin/env bash
# packages/core/scripts/run-vitest-sqlite-fallback.sh
#
# DEGRADED, DIAGNOSTIC-ONLY test entry point.
#
# Runs the @praetor/core vitest suite with the SQLite-dependent suites
# excluded. It exists so an operator can still exercise the non-SQLite half of
# the suite on a machine where the better-sqlite3 native binding cannot be built.
#
# ── This script can NOT produce a durability acceptance result ──────────────
#
# The excluded suites below are the ones that prove persistence: persist across
# reopen, atomic compare-and-swap, transaction rollback, lease management, crash
# recovery, run ledgers, work queues. Excluding them means durability was not
# measured. An unmeasured result must never be reported as a pass, so:
#
#   1. The script refuses to run unless the caller explicitly opts in with
#      COMMANDER_ALLOW_SQLITE_FALLBACK=1. Unset/empty/anything-else => exit 1.
#      (Absent configuration is treated as "do not degrade", not as "degrade".)
#   2. It probes the binding first. If the binding actually works, running the
#      reduced suite would silently drop coverage for no reason => exit 1.
#   3. It validates the exclusion list against vitest.config.ts, so a rotted or
#      no-op entry fails loudly instead of pretending to exclude something.
#   4. It writes a machine-readable report with `coverageComplete: false` and
#      `durabilityMeasured: false`, and prints a NOT-ACCEPTANCE banner.
#
# CI consequence (see the cross-workstream note in the workstream report): a
# required check must not be satisfied by this script. Either the binding probe
# job must fail, or the test job must treat this output as NOT_RUN rather than
# as success.
#
# Usage:
#   COMMANDER_ALLOW_SQLITE_FALLBACK=1 ./scripts/run-vitest-sqlite-fallback.sh
#   COMMANDER_ALLOW_SQLITE_FALLBACK=1 ./scripts/run-vitest-sqlite-fallback.sh --reporter=default

set -euo pipefail

# ── SQLite-dependent vitest suites ─────────────────────────────────────────
# Listed alphabetically by full path (relative to packages/core). Every entry is
# validated below: it must exist, end in `.test.ts`, and be enabled in
# vitest.config.ts. Additions therefore cannot rot into silent no-ops.
SUITES=(
  'tests/atr/executionScheduler.test.ts'
  'tests/checkpointStore.test.ts'
  'tests/e2e/sloMeasurement.test.ts'
  'tests/recovery/kill9.test.ts'
  'tests/runtime/determinismCapture.test.ts'
  'tests/runtime/runRecovery.test.ts'
  'tests/storage/persistentStore.test.ts'
  'tests/storage/sqliteDriver.test.ts'
  'tests/ultimate/tenantWorkCoordinatorRegistry.test.ts'
  'tests/ultimate/workCoordinator.test.ts'
  'tests/ultimate/workQueueStore.test.ts'
)

# ── SQLite-dependent node:test suites ──────────────────────────────────────
# These carry durability contracts too, but they run under `node:test`, so this
# vitest entry point cannot exclude them — it never runs them in the first
# place. They are listed so that nobody reads this file and concludes the
# contracts below are covered by a degraded run. They are executed by
# scripts/run-node-tests.mjs, which this script does NOT invoke; their
# durability is therefore unmeasured here as well.
NODE_SUITES=(
  'tests/atr/adapters/github.test.ts'
  'tests/atr/atrHttp.test.ts'
  'tests/atr/c6AgentRuntimeLease.test.ts'
  'tests/atr/checkpointLease.test.ts'
  'tests/atr/leaseManager.test.ts'
  'tests/atr/policy/e2e.test.ts'
  'tests/atr/policy/integration.test.ts'
  'tests/atr/runLedger.test.ts'
  'tests/runtime/processCrashSafety.test.ts'
  'tests/security/filePermissions.test.ts'
  'tests/tools/conversationSearchTool.test.ts'
)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

# ── 1. Explicit opt-in. Absent configuration means "do not degrade". ────────
if [ "${COMMANDER_ALLOW_SQLITE_FALLBACK:-}" != "1" ]; then
  cat >&2 <<'EOF'
[run-vitest-sqlite-fallback] REFUSING TO RUN — explicit opt-in missing.

This entry point excludes the SQLite persistence suites, so it cannot produce a
durability acceptance result. It is a diagnostic tool, not a release gate.

Set COMMANDER_ALLOW_SQLITE_FALLBACK=1 to acknowledge that durability will NOT be
measured by this run.
EOF
  exit 1
fi

# ── 2. Probe the binding. If it works, the fallback must not be used. ──────
if node -e '
  const { mkdtempSync, rmSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const { join } = require("node:path");
  const dir = mkdtempSync(join(tmpdir(), "sqlite-fallback-probe-"));
  let db;
  try {
    const Database = require("better-sqlite3");
    db = new Database(join(dir, "probe.db"));
    db.exec("CREATE TABLE t (a INTEGER NOT NULL)");
    db.exec("INSERT INTO t (a) VALUES (1)");
    const row = db.prepare("SELECT a FROM t").get();
    if (!row || row.a !== 1) process.exit(1);
  } catch {
    process.exit(1);
  } finally {
    try { db && db.close(); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
' 2>/dev/null; then
  cat >&2 <<'EOF'
[run-vitest-sqlite-fallback] REFUSING TO RUN — the SQLite binding works.

The whole point of this script is to cope with an unusable better-sqlite3
binding, but the functional probe (open/create/insert/select/close) succeeded.
Running it would silently drop durability coverage for no reason.

Run the full suite instead:
  pnpm --filter @praetor/core test
EOF
  exit 1
fi

# ── 3. Validate the exclusion list against the config ─────────────────────
LIST_PROBLEMS="$(node -e '
import("./scripts/test-manifest.mjs").then((m) => {
  const includeResult = m.readVitestInclude(m.CORE_ROOT);
  if (includeResult.status !== "ok") {
    console.log(`cannot read test.include (${includeResult.status}: ${includeResult.detail})`);
    return;
  }
  const include = new Set(includeResult.include);
  const problems = [];
  for (const suite of process.argv.slice(1)) {
    if (!suite.endsWith(".test.ts")) {
      problems.push(`${suite}: not a .test.ts file, so vitest would never run it anyway`);
      continue;
    }
    if (!m.readSource(suite, m.CORE_ROOT)) {
      problems.push(`${suite}: does not exist on disk`);
      continue;
    }
    if (!include.has(suite)) {
      problems.push(`${suite}: not enabled in vitest.config.ts, so excluding it is a no-op`);
    }
  }
  for (const problem of problems) console.log(problem);
});
' "${SUITES[@]}")"

if [ -n "$LIST_PROBLEMS" ]; then
  echo "[run-vitest-sqlite-fallback] REFUSING TO RUN — the exclusion list has rotted:" >&2
  echo "$LIST_PROBLEMS" | sed 's/^/  - /' >&2
  echo "  Fix packages/core/scripts/run-vitest-sqlite-fallback.sh SUITES." >&2
  exit 1
fi

# ── 4. Structured degraded report ──────────────────────────────────────────
REPORT_DIR="${COMMANDER_SQLITE_FALLBACK_REPORT_DIR:-.commander_benchmarks}"
mkdir -p "$REPORT_DIR"
REPORT_PATH="$REPORT_DIR/sqlite-fallback-report.json"
EXCLUDES_JSON="$(printf '%s\n' "${SUITES[@]}" | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const files = s.split("\n").map((l) => l.trim()).filter(Boolean);
    process.stdout.write(JSON.stringify(files));
  });
')"
NODE_SUITES_JSON="$(printf '%s\n' "${NODE_SUITES[@]}" | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const files = s.split("\n").map((l) => l.trim()).filter(Boolean);
    process.stdout.write(JSON.stringify(files));
  });
')"
cat > "$REPORT_PATH" <<EOF
{
  "entryPoint": "packages/core/scripts/run-vitest-sqlite-fallback.sh",
  "degraded": true,
  "coverageComplete": false,
  "durabilityMeasured": false,
  "acceptableAsReleaseEvidence": false,
  "sqliteBindingAvailable": false,
  "excludedSuiteCount": ${#SUITES[@]},
  "excludedSuites": ${EXCLUDES_JSON},
  "nodeTestSuitesNotRunByThisEntryPointCount": ${#NODE_SUITES[@]},
  "nodeTestSuitesNotRunByThisEntryPoint": ${NODE_SUITES_JSON},
  "note": "The SQLite persistence suites were excluded and the node:test SQLite suites were never run. This run is NOT durability acceptance evidence."
}
EOF

cat >&2 <<EOF
================================================================================
[run-vitest-sqlite-fallback] DEGRADED RUN — NOT DURABILITY ACCEPTANCE

  The better-sqlite3 binding is unusable on this machine, so ${#SUITES[@]} SQLite-dependent
  vitest suites are excluded, and ${#NODE_SUITES[@]} SQLite-dependent node:test suites are not
  run at all by this entry point. Durability was NOT measured.

  Do not cite this run as evidence that persistence works. Required release
  checks must run the full suite on a runner where the binding loads, or be
  reported as NOT_RUN.
================================================================================
EOF

# Build --exclude args once. Glob `**/<file>.test.ts` is intentional so
# vitest matches regardless of the cwd vitest is invoked from.
EXCLUDES=()
for s in "${SUITES[@]}"; do
  EXCLUDES+=(--exclude "**/$s")
done

echo "[run-vitest-sqlite-fallback] excluding ${#SUITES[@]} SQLite-dependent suites:" >&2
for s in "${SUITES[@]}"; do
  echo "  • $s" >&2
done
echo "[run-vitest-sqlite-fallback] report written to $REPORT_PATH" >&2

exec ./node_modules/.bin/vitest run --no-cache "${EXCLUDES[@]}" "$@"
