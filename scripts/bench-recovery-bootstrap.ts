#!/usr/bin/env tsx
/**
 * bench-recovery-bootstrap.ts — RecoveryBootstrapper 恢复时间 benchmark
 *
 * 构造 10/100/1000 个僵尸 run，测量 RecoveryBootstrapper.bootstrap() 的
 * 扫描耗时、恢复/abort 数量、DLQ 写入延迟。
 *
 * Usage:
 *   npx tsx scripts/bench-recovery-bootstrap.ts
 *   npx tsx scripts/bench-recovery-bootstrap.ts --output=docs/baselines/recovery-baseline.json
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { withBenchmarkEnv } from './benchmarkEnv';

interface BenchResult {
  scale: number;
  scanMs: number;
  recovered: number;
  aborted: number;
  skipped: number;
  totalScanned: number;
  perRunMs: number;
}

const SCALES = [10, 100, 1000];

async function main() {
  const args = process.argv.slice(2);
  const outputArg = args.find((a) => a.startsWith('--output='));
  const outputPath = outputArg
    ? outputArg.slice('--output='.length)
    : `docs/baselines/recovery-baseline.${new Date().toISOString().slice(0, 10)}.json`;

  console.log('RecoveryBootstrapper Benchmark');
  console.log('═'.repeat(70));

  // Dynamically import to avoid circular deps at module load
  const { RecoveryBootstrapper } = await import('../packages/core/src/atr/recoveryBootstrapper');
  const { getExecutionScheduler, resetExecutionScheduler } =
    await import('../packages/core/src/atr/scheduler');
  const { resetRunLedgerBundle, getRunLedgerBundle } =
    await import('../packages/core/src/atr/runLedger');
  const { resetDeadLetterQueue } =
    await import('../packages/core/src/runtime/deadLetterQueueSingleton');
  const { resetMessageBus } = await import('../packages/core/src/runtime/messageBus');
  const { resetIdempotencyStore } = await import('../packages/core/src/atr/idempotencyStore');

  const results: BenchResult[] = [];

  try {
    for (const scale of SCALES) {
      // Reset all singletons for clean state
      process.env.COMMANDER_ATR_MEMORY = '1';
      process.env.COMMANDER_ATR_IDEMPOTENCY_PATH = ':memory:';
      resetRunLedgerBundle();
      resetExecutionScheduler();
      resetDeadLetterQueue();
      resetMessageBus();
      resetIdempotencyStore();

      // Create zombie runs
      const sched = getExecutionScheduler();
      const bundle = getRunLedgerBundle();

      for (let i = 0; i < scale; i++) {
        const runId = `zombie-${scale}-${i}`;
        const handle = sched.beginRun({
          runId,
          goal: `benchmark zombie run ${i}`,
        });
        bundle.lease.heartbeat(runId, handle.leaseToken, { ttlSeconds: -1 });
        const live = bundle.lease.get(runId);
        if (live) {
          bundle.ledger.syncLeaseCredentials(runId, live.token, live.fencingEpoch, {
            expiresAt: live.expiresAt,
          });
        }
      }

      // Measure bootstrap
      const start = Date.now();
      const result = await RecoveryBootstrapper.bootstrap({
        forceAbort: true,
        holder: `bench-recovery-${process.pid}`,
      });
      const scanMs = Date.now() - start;

      const benchResult: BenchResult = {
        scale,
        scanMs,
        recovered: result.recovered,
        aborted: result.aborted,
        skipped: result.skipped,
        totalScanned: result.scanned,
        perRunMs: scale > 0 ? scanMs / scale : 0,
      };

      results.push(benchResult);
      console.log(
        `  Scale ${scale.toString().padStart(4)}: ${scanMs.toString().padStart(6)}ms  ` +
          `scanned=${result.scanned}  aborted=${result.aborted}  ` +
          `recovered=${result.recovered}  skipped=${result.skipped}  ` +
          `(${(scanMs / scale).toFixed(2)}ms/run)`,
      );
    }
  } catch (err) {
    // Handle environment constraints (e.g., better-sqlite3 native module mismatch)
    const errMsg = err instanceof Error ? err.message : String(err);
    if (
      errMsg.includes('NODE_MODULE_VERSION') ||
      errMsg.includes('better_sqlite3') ||
      errMsg.includes('better-sqlite3')
    ) {
      console.log(`  ⚠ SKIP: better-sqlite3 native module unavailable in this environment`);
      console.log(`    (${errMsg.split('\n')[0]})`);
      console.log('  Baseline will be written with placeholder values.');
    } else {
      throw err; // Re-throw unexpected errors
    }
  }

  console.log('═'.repeat(70));

  // Save baseline
  const passed = results.length > 0 && (results.find((r) => r.scale === 1000)?.scanMs ?? 0) <= 5000;
  const summary =
    results.length > 0
      ? { passed, errors: 0, failed: 0, skipped: 0 }
      : { passed: false, errors: 0, failed: 0, skipped: 1 };
  const baselinePayload =
    results.length > 0
      ? {
          benchmark: 'recovery-bootstrap',
          results,
          summary,
          scale10: results[0],
          scale100: results[1],
          scale1000: results[2],
        }
      : {
          benchmark: 'recovery-bootstrap',
          results,
          summary,
          reason: 'better-sqlite3 native module unavailable',
        };
  const baselineDoc = withBenchmarkEnv(baselinePayload, {
    evidence: 'simulated',
    datasetVersion: 'recovery-bootstrap-v1',
  });

  const fullPath = resolve(outputPath);
  const dir = dirname(fullPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(fullPath, JSON.stringify(baselineDoc, null, 2), { mode: 0o644 });
  console.log(`Baseline saved to ${fullPath}`);

  if (results.length === 0) {
    console.log('❌ FAIL: No recovery measurements available (better-sqlite3 unavailable?)');
    process.exit(1);
  }

  // Regression check: 1000 zombies should complete in < 5s
  const largeScaleResult = results.find((r) => r.scale === 1000);
  if (largeScaleResult && largeScaleResult.scanMs > 5000) {
    console.log(
      `❌ FAIL: 1000-zombie recovery took ${largeScaleResult.scanMs}ms (> 5000ms threshold)`,
    );
    process.exit(1);
  }
  console.log('✅ PASS: Recovery benchmark within thresholds');
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(2);
});
