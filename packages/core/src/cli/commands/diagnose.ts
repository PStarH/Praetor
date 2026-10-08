/**
 * diagnose.ts — CLI diagnostic command for the Commander V2 distributed stack.
 *
 * Checks four subsystems and prints a PASS/FAIL/WARN summary table:
 *   1. V2 kernel health   — database connectivity, schema version, run/step counts, workers
 *   2. Worker plane health — required env vars, V2 mode, legacy execution flag
 *   3. Storage backend     — backend type, production fail-closed posture
 *   4. Security posture    — OutboundNetworkPolicy, ReversibilityGate, SecurityAnomalyDetector
 *
 * Exits with code 1 if any *critical* check fails, so this can be wired into
 * CI readiness gates and `commander up --check`.
 *
 * Usage:
 *   commander diagnose            # run all checks
 *   commander diagnose --json     # machine-readable JSON output
 *   npx tsx packages/core/src/cli/commands/diagnose.ts [--json]
 */

import { fileURLToPath } from 'node:url';
import { createVerifiedPostgresPool } from '@praetor/postgres-runtime';
import { reportSilentFailure } from '../../silentFailureReporter';
import { getGlobalLogger } from '../../logging';
import { $, section, kv } from './_shared';
import { getOutboundNetworkPolicy } from '../../security/outboundNetworkPolicy';
import { getReversibilityGate } from '../../security/reversibilityGate';
import { getSecurityAnomalyDetector } from '../../security/securityAnomalyDetector';

// ── Check result types ─────────────────────────────────────────────────────

type CheckStatus = 'PASS' | 'FAIL' | 'WARN';

interface CheckResult {
  label: string;
  status: CheckStatus;
  message: string;
  /** When true, a FAIL status causes the process to exit with code 1. */
  critical: boolean;
}

// ── Minimal pg-compatible types (no hard runtime dependency) ────────────────

interface PgQueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number | null;
}
interface PgClient {
  query<T = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<PgQueryResult<T>>;
  release(): void;
}
interface PgPool {
  connect(): Promise<PgClient>;
  end(): Promise<void>;
}

/**
 * Lazily create a pg.Pool from the `pg` package.
 * Returns null if `pg` is not installed or the connection string is missing.
 */
function createPool(connectionString: string): PgPool | null {
  if (!connectionString) return null;
  try {
    return createVerifiedPostgresPool({ connectionString, max: 3 });
  } catch (err) {
    reportSilentFailure(err, 'diagnose:createPool');
    return null;
  }
}

/** Parse a boolean env var: truthy values are 1/true/yes/on (case-insensitive). */
function envBool(name: string): boolean {
  const v = process.env[name];
  if (!v) return false;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

// ════════════════════════════════════════════════════════════════════════════
// 1. V2 KERNEL HEALTH
// ════════════════════════════════════════════════════════════════════════════

async function checkKernelHealth(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const dbUrl = process.env.DATABASE_URL ?? '';

  if (!dbUrl) {
    results.push({
      label: 'DATABASE_URL',
      status: 'FAIL',
      message: 'not set — required for V2 kernel',
      critical: true,
    });
    // Skip remaining kernel checks — no DB to query
    results.push({
      label: 'Database connectivity',
      status: 'WARN',
      message: 'skipped (no DATABASE_URL)',
      critical: false,
    });
    results.push({
      label: 'Schema version',
      status: 'WARN',
      message: 'skipped (no DATABASE_URL)',
      critical: false,
    });
    results.push({
      label: 'Pending runs',
      status: 'WARN',
      message: 'skipped (no DATABASE_URL)',
      critical: false,
    });
    results.push({
      label: 'Executing steps',
      status: 'WARN',
      message: 'skipped (no DATABASE_URL)',
      critical: false,
    });
    results.push({
      label: 'Worker registration',
      status: 'WARN',
      message: 'skipped (no DATABASE_URL)',
      critical: false,
    });
    return results;
  }

  const pool = createPool(dbUrl);
  if (!pool) {
    results.push({
      label: 'Database connectivity',
      status: 'FAIL',
      message: 'pg package not installed — run: pnpm add pg',
      critical: true,
    });
    return results;
  }

  // ── Database connectivity ──
  let client: PgClient | null = null;
  try {
    client = await pool.connect();
    const res = await client.query<{ ok: number }>('SELECT 1 AS ok');
    if (res.rows.length > 0 && Number(res.rows[0]!.ok) === 1) {
      results.push({
        label: 'Database connectivity',
        status: 'PASS',
        message: 'connected to PostgreSQL',
        critical: true,
      });
    } else {
      results.push({
        label: 'Database connectivity',
        status: 'FAIL',
        message: 'SELECT 1 returned unexpected result',
        critical: true,
      });
    }
  } catch (err) {
    results.push({
      label: 'Database connectivity',
      status: 'FAIL',
      message: `connection failed: ${(err as Error).message}`,
      critical: true,
    });
    // Cannot proceed with table queries
    results.push({
      label: 'Schema version',
      status: 'WARN',
      message: 'skipped (no DB connection)',
      critical: false,
    });
    results.push({
      label: 'Pending runs',
      status: 'WARN',
      message: 'skipped (no DB connection)',
      critical: false,
    });
    results.push({
      label: 'Executing steps',
      status: 'WARN',
      message: 'skipped (no DB connection)',
      critical: false,
    });
    results.push({
      label: 'Worker registration',
      status: 'WARN',
      message: 'skipped (no DB connection)',
      critical: false,
    });
    try {
      await pool.end();
    } catch (e) {
      reportSilentFailure(e, 'diagnose:pool.end.connectivity');
    }
    return results;
  }

  // ── Schema version ──
  try {
    const res = await client.query<{ version: string }>(
      'SELECT version FROM commander_kernel_schema ORDER BY applied_at DESC LIMIT 1',
    );
    if (res.rows.length > 0) {
      results.push({
        label: 'Schema version',
        status: 'PASS',
        message: `applied: ${res.rows[0]!.version}`,
        critical: false,
      });
    } else {
      results.push({
        label: 'Schema version',
        status: 'FAIL',
        message: 'commander_kernel_schema table is empty — run migrations',
        critical: false,
      });
    }
  } catch (err) {
    results.push({
      label: 'Schema version',
      status: 'FAIL',
      message: `commander_kernel_schema not queryable: ${(err as Error).message.slice(0, 80)}`,
      critical: false,
    });
  }

  // ── Pending runs count ──
  try {
    const res = await client.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM commander_runs WHERE state = 'PENDING'",
    );
    const count = res.rows[0]?.count ?? 0;
    results.push({
      label: 'Pending runs',
      status: count > 0 ? 'WARN' : 'PASS',
      message: `${count} pending run(s)`,
      critical: false,
    });
  } catch (err) {
    results.push({
      label: 'Pending runs',
      status: 'WARN',
      message: `commander_runs not queryable: ${(err as Error).message.slice(0, 80)}`,
      critical: false,
    });
  }

  // ── Executing steps count ──
  try {
    const res = await client.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM commander_steps WHERE state = 'RUNNING'",
    );
    const count = res.rows[0]?.count ?? 0;
    results.push({
      label: 'Executing steps',
      status: 'PASS',
      message: `${count} step(s) currently executing`,
      critical: false,
    });
  } catch (err) {
    results.push({
      label: 'Executing steps',
      status: 'WARN',
      message: `commander_steps not queryable: ${(err as Error).message.slice(0, 80)}`,
      critical: false,
    });
  }

  // ── Worker registration & heartbeat ──
  try {
    const res = await client.query<{
      count: number;
    }>("SELECT COUNT(*)::int AS count FROM commander_workers WHERE status = 'ACTIVE'");
    const activeCount = res.rows[0]?.count ?? 0;

    if (activeCount === 0) {
      results.push({
        label: 'Worker registration',
        status: 'WARN',
        message: 'no active workers registered — start a worker process',
        critical: false,
      });
    } else {
      // Check heartbeat freshness — workers with heartbeat older than 30s are stale
      const heartbeatRes = await client.query<{
        id: string;
        age_seconds: number;
      }>(
        'SELECT id, EXTRACT(EPOCH FROM (now() - last_heartbeat_at))::int AS age_seconds ' +
          "FROM commander_workers WHERE status = 'ACTIVE'",
      );
      const staleWorkers = heartbeatRes.rows.filter((r) => (r.age_seconds ?? 0) > 30);
      if (staleWorkers.length > 0) {
        results.push({
          label: 'Worker registration',
          status: 'WARN',
          message: `${activeCount} active worker(s), ${staleWorkers.length} stale heartbeat(s)`,
          critical: false,
        });
      } else {
        results.push({
          label: 'Worker registration',
          status: 'PASS',
          message: `${activeCount} active worker(s), all heartbeats fresh`,
          critical: false,
        });
      }
    }
  } catch (err) {
    results.push({
      label: 'Worker registration',
      status: 'WARN',
      message: `commander_workers not queryable: ${(err as Error).message.slice(0, 80)}`,
      critical: false,
    });
  }

  // Release and close pool
  try {
    client?.release();
  } catch (e) {
    reportSilentFailure(e, 'diagnose:client.release');
  }
  try {
    await pool.end();
  } catch (e) {
    reportSilentFailure(e, 'diagnose:pool.end');
  }

  return results;
}

// ════════════════════════════════════════════════════════════════════════════
// 2. WORKER PLANE HEALTH
// ════════════════════════════════════════════════════════════════════════════

export function checkWorkerPlaneHealth(): CheckResult[] {
  const results: CheckResult[] = [];

  // ── Required environment variables ──
  const requiredEnvs: ReadonlyArray<{ name: string; critical: boolean; defaultVal?: string }> = [
    { name: 'DATABASE_URL', critical: true },
    { name: 'COMMANDER_WORKER_AUTH_TOKEN', critical: true },
    { name: 'COMMANDER_WORKER_KIND', critical: false, defaultVal: 'agent' },
  ];

  for (const env of requiredEnvs) {
    const value = process.env[env.name];
    if (value) {
      // Same redaction policy the header uses at cmdDiagnose: strip the
      // credentials a connection URL embeds instead of printing them.
      const display =
        env.name === 'COMMANDER_WORKER_AUTH_TOKEN'
          ? `${value.slice(0, 4)}****${value.slice(-2)}`
          : env.name === 'DATABASE_URL'
            ? value.replace(/\/\/.*@/, '//****@')
            : value;
      results.push({
        label: env.name,
        status: 'PASS',
        message: `set (${display})`,
        critical: env.critical,
      });
    } else if (env.defaultVal) {
      results.push({
        label: env.name,
        status: 'WARN',
        message: `not set — will default to "${env.defaultVal}"`,
        critical: env.critical,
      });
    } else {
      results.push({
        label: env.name,
        status: 'FAIL',
        message: 'not set — required for worker bootstrap',
        critical: env.critical,
      });
    }
  }

  // ── V2 mode status ──
  const v2Mode = envBool('COMMANDER_V2_MODE');
  results.push({
    label: 'COMMANDER_V2_MODE',
    status: v2Mode ? 'PASS' : 'WARN',
    message: v2Mode ? 'enabled' : 'not set — V2 distributed mode inactive',
    critical: true,
  });

  const nodeEnv = process.env.NODE_ENV ?? 'undefined';
  results.push({
    label: 'NODE_ENV',
    status: 'PASS',
    message: nodeEnv,
    critical: false,
  });

  // ── Legacy execution mode ──
  const legacyExec = envBool('COMMANDER_LEGACY_EXECUTION');
  if (legacyExec) {
    results.push({
      label: 'COMMANDER_LEGACY_EXECUTION',
      status: 'WARN',
      message: 'enabled — legacy execution path active, V2 kernel bypassed',
      critical: false,
    });
  } else {
    results.push({
      label: 'COMMANDER_LEGACY_EXECUTION',
      status: 'PASS',
      message: 'disabled (V2 kernel is the execution path)',
      critical: false,
    });
  }

  return results;
}

// ════════════════════════════════════════════════════════════════════════════
// 3. STORAGE BACKEND
// ════════════════════════════════════════════════════════════════════════════

function checkStorageBackend(): CheckResult[] {
  const results: CheckResult[] = [];

  // Determine backend type from environment
  const envBackend = (
    process.env.API_STORE_BACKEND ??
    process.env.COMMANDER_STORE_BACKEND ??
    ''
  ).toLowerCase();
  const dbUrl = process.env.DATABASE_URL ?? '';

  let backend: string;
  if (envBackend === 'postgres' || (!envBackend && dbUrl)) {
    backend = 'postgres';
  } else if (envBackend) {
    backend = envBackend;
  } else {
    backend = 'sqlite'; // default per docker-compose.yml
  }

  const validBackends = ['postgres', 'sqlite', 'json', 'memory', 'cache-sqlite'];
  if (validBackends.includes(backend)) {
    results.push({
      label: 'Storage backend',
      status: 'PASS',
      message: backend,
      critical: false,
    });
  } else {
    results.push({
      label: 'Storage backend',
      status: 'WARN',
      message: `unknown backend "${backend}"`,
      critical: false,
    });
  }

  // ── Production fail-closed check ──
  const isProduction = process.env.NODE_ENV === 'production';
  const nonDurableBackends = ['memory', 'json'];

  if (isProduction) {
    if (nonDurableBackends.includes(backend)) {
      results.push({
        label: 'Production fail-closed',
        status: 'FAIL',
        message: `NODE_ENV=production but backend is "${backend}" — use postgres or sqlite`,
        critical: true,
      });
    } else {
      results.push({
        label: 'Production fail-closed',
        status: 'PASS',
        message: `production with durable backend (${backend})`,
        critical: false,
      });
    }
  } else {
    results.push({
      label: 'Production fail-closed',
      status: 'PASS',
      message: `not production (NODE_ENV=${nodeEnvSafe()}) — durability check skipped`,
      critical: false,
    });
  }

  return results;
}

function nodeEnvSafe(): string {
  return process.env.NODE_ENV ?? 'undefined';
}

// ════════════════════════════════════════════════════════════════════════════
// 4. SECURITY POSTURE
// ════════════════════════════════════════════════════════════════════════════

async function checkSecurityPosture(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // ── OutboundNetworkPolicy ──
  try {
    const policy = getOutboundNetworkPolicy();
    const config = policy.getConfig();
    const installed = policy.isInstalled();

    if (!config.enabled) {
      results.push({
        label: 'OutboundNetworkPolicy',
        status: 'FAIL',
        message: 'disabled — egress firewall is OFF (data exfiltration risk)',
        critical: true,
      });
    } else if (!installed) {
      results.push({
        label: 'OutboundNetworkPolicy',
        status: 'WARN',
        message: 'enabled in config but not installed (starts with API server)',
        critical: false,
      });
    } else {
      results.push({
        label: 'OutboundNetworkPolicy',
        status: 'PASS',
        message: `active — ${config.allowlist.length} domains allowlisted`,
        critical: false,
      });
    }
  } catch (err) {
    results.push({
      label: 'OutboundNetworkPolicy',
      status: 'FAIL',
      message: `error: ${(err as Error).message.slice(0, 80)}`,
      critical: true,
    });
  }

  // ── ReversibilityGate blockWithoutCallback ──
  // The `blockWithoutCallback` flag is private with no public getter, so we
  // probe it behaviourally: evaluate an irreversible tool (shell_execute) with
  // no approval callback. If the gate blocks the call, blockWithoutCallback is
  // true (fail-closed = secure). If it allows the call, blockWithoutCallback
  // is false (dangerous — irreversible actions proceed without human approval).
  try {
    const gate = getReversibilityGate();
    const decision = await gate.evaluate('shell_execute', {
      command: 'echo commander-diagnose-probe',
    });
    if (!decision.allowed) {
      results.push({
        label: 'ReversibilityGate (blockWithoutCallback)',
        status: 'PASS',
        message: 'fail-closed — irreversible tools blocked without approval callback',
        critical: false,
      });
    } else {
      results.push({
        label: 'ReversibilityGate (blockWithoutCallback)',
        status: 'WARN',
        message: 'blockWithoutCallback=false — irreversible tools allowed without human approval',
        critical: false,
      });
    }
  } catch (err) {
    results.push({
      label: 'ReversibilityGate (blockWithoutCallback)',
      status: 'FAIL',
      message: `error: ${(err as Error).message.slice(0, 80)}`,
      critical: true,
    });
  }

  // ── SecurityAnomalyDetector running status ──
  // The detector exposes no public isRunning() method. In a standalone CLI
  // process the detector has not been started (it is started by the API
  // server / worker bootstrap via startSecurityAnomalyDetector()). We check
  // whether the singleton is obtainable and report the process-local state.
  try {
    const detector = getSecurityAnomalyDetector();
    const anomalies = detector.getAnomalies();

    // In a CLI process the detector is never started, so it is not "running".
    // This is expected — the detector runs inside the API server process.
    results.push({
      label: 'SecurityAnomalyDetector',
      status: 'WARN',
      message:
        'singleton available — started by API server/worker bootstrap, not this CLI process' +
        (anomalies.length > 0 ? ` (${anomalies.length} anomalies recorded)` : ''),
      critical: false,
    });
  } catch (err) {
    results.push({
      label: 'SecurityAnomalyDetector',
      status: 'FAIL',
      message: `error: ${(err as Error).message.slice(0, 80)}`,
      critical: false,
    });
  }

  return results;
}

// ════════════════════════════════════════════════════════════════════════════
// Summary rendering
// ════════════════════════════════════════════════════════════════════════════

function statusIcon(status: CheckStatus): string {
  switch (status) {
    case 'PASS':
      return `${$.green}✓${$.reset}`;
    case 'FAIL':
      return `${$.red}✗${$.reset}`;
    case 'WARN':
      return `${$.yellow}!${$.reset}`;
  }
}

function statusLabel(status: CheckStatus): string {
  switch (status) {
    case 'PASS':
      return `${$.green}PASS${$.reset}`;
    case 'FAIL':
      return `${$.red}FAIL${$.reset}`;
    case 'WARN':
      return `${$.yellow}WARN${$.reset}`;
  }
}

function printResults(sectionTitle: string, results: CheckResult[]): void {
  console.log(`\n  ${$.dim}${sectionTitle}${$.reset}`);
  for (const r of results) {
    const criticalTag = r.critical ? `${$.red}[critical]${$.reset} ` : '';
    const msgColor = r.status === 'FAIL' ? $.red : r.status === 'WARN' ? $.yellow : $.dim;
    console.log(
      `  ${statusIcon(r.status)} ${r.label} ${$.dim}—${$.reset} ${criticalTag}${msgColor}${r.message}${$.reset}`,
    );
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Main command
// ════════════════════════════════════════════════════════════════════════════

export async function cmdDiagnose(args: string[]): Promise<void> {
  const jsonMode = args.includes('--json');

  section('COMMANDER DIAGNOSE — V2 Distributed Stack Health');

  // Print environment context
  kv('Node', process.version);
  kv('Platform', process.platform);
  kv(
    'DATABASE_URL',
    process.env.DATABASE_URL
      ? `${process.env.DATABASE_URL.replace(/\/\/.*@/, '//****@')}`
      : 'not set',
  );
  kv('NODE_ENV', process.env.NODE_ENV ?? 'undefined');
  kv('COMMANDER_V2_MODE', envBool('COMMANDER_V2_MODE') ? '1' : '0');

  // ── Run all checks ──
  const kernelResults = await checkKernelHealth();
  const workerResults = checkWorkerPlaneHealth();
  const storageResults = checkStorageBackend();
  const securityResults = await checkSecurityPosture();

  // ── Group results by section (Record, not Map) ──
  const sections: Record<string, CheckResult[]> = {
    'V2 KERNEL': kernelResults,
    'WORKER PLANE': workerResults,
    STORAGE: storageResults,
    SECURITY: securityResults,
  };

  if (jsonMode) {
    // Machine-readable output
    const allResults = [...kernelResults, ...workerResults, ...storageResults, ...securityResults];
    const hasCriticalFail = allResults.some((r) => r.critical && r.status === 'FAIL');
    console.log(
      JSON.stringify({ results: allResults, exitCode: hasCriticalFail ? 1 : 0 }, null, 2),
    );
    if (hasCriticalFail) process.exitCode = 1;
    return;
  }

  // ── Print grouped results ──
  for (const [title, results] of Object.entries(sections)) {
    printResults(title, results);
  }

  // ── Summary ──
  const allResults = [...kernelResults, ...workerResults, ...storageResults, ...securityResults];
  let passCount = 0;
  let failCount = 0;
  let warnCount = 0;
  let criticalFails = 0;

  for (const r of allResults) {
    if (r.status === 'PASS') passCount++;
    else if (r.status === 'FAIL') {
      failCount++;
      if (r.critical) criticalFails++;
    } else if (r.status === 'WARN') warnCount++;
  }

  console.log();
  console.log(
    `  ${$.bold}Summary:${$.reset}  ${$.green}${passCount} PASS${$.reset}  ${$.red}${failCount} FAIL${$.reset}  ${$.yellow}${warnCount} WARN${$.reset}`,
  );

  if (criticalFails > 0) {
    console.log(`  ${$.red}${$.bold}${criticalFails} critical check(s) failed.${$.reset}`);
    console.log(
      `  ${$.dim}Fix the issues above, then re-run: ${$.cyan}commander diagnose${$.reset}`,
    );
    process.exitCode = 1;
  } else if (failCount > 0) {
    console.log(`  ${$.yellow}Non-critical failure(s) detected — review above.${$.reset}`);
  } else if (warnCount > 0) {
    console.log(
      `  ${$.yellow}All critical checks passed; ${warnCount} warning(s) to review.${$.reset}`,
    );
  } else {
    console.log(`  ${$.green}${$.bold}All checks passed.${$.reset}`);
  }
  console.log();

  // Log completion for observability
  getGlobalLogger().info('CLI', 'diagnose completed', {
    pass: passCount,
    fail: failCount,
    warn: warnCount,
    criticalFails,
  });
}

// ════════════════════════════════════════════════════════════════════════════
// Standalone execution support
// Allows: npx tsx packages/core/src/cli/commands/diagnose.ts [--json] [--help]
// ════════════════════════════════════════════════════════════════════════════

function printDiagnoseHelp(): void {
  console.log(`
  ${$.bold}commander diagnose${$.reset} — V2 distributed stack health diagnostics

  ${$.bold}Usage:${$.reset}
    commander diagnose              Run all health checks
    commander diagnose --json       Machine-readable JSON output
    npx tsx packages/core/src/cli/commands/diagnose.ts [--json]

  ${$.bold}Checks:${$.reset}
    1. V2 kernel health    — DB connectivity, schema version, run/step counts
    2. Worker plane health — env vars, V2 mode, worker registration & heartbeats
    3. Storage backend     — backend type, production fail-closed posture
    4. Security posture    — OutboundNetworkPolicy, ReversibilityGate, AnomalyDetector

  ${$.bold}Exit codes:${$.reset}
    0  All critical checks passed
    1  One or more critical checks failed
`);
}

const isDirectExecution = !!process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectExecution) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printDiagnoseHelp();
    process.exit(0);
  }
  void cmdDiagnose(args);
}
