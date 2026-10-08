#!/usr/bin/env node
/**
 * Contract snapshot baseline check.
 *
 * Snapshots the current public contract surface area (resources, run/step
 * states, error codes, schema names) from @praetor/contracts and compares
 * it against a committed baseline.
 *
 * Modes:
 *   - default            : detect breaking changes vs. baseline. Exits with
 *                          code 1 if any breaking change (removed resource,
 *                          state, error code, or schema) is found.
 *   - --update-baseline  : write the current snapshot as the new baseline.
 *
 * Run:
 *   npx tsx scripts/contract-snapshot-check.ts                     # check
 *   npx tsx scripts/contract-snapshot-check.ts --update-baseline   # refresh
 *
 * The baseline lives at:
 *   packages/contracts/snapshots/contract-snapshot.baseline.json
 *
 * Note: only REMOVALS are breaking. Additions are non-breaking and do not
 * fail the check — they are silently absorbed the next time the baseline is
 * refreshed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  snapshotContracts,
  detectBreakingChanges,
  type ContractSnapshot,
} from '../packages/contracts/src/compatibility.js';

const ROOT = process.cwd();
const BASELINE_PATH = resolve(ROOT, 'packages/contracts/snapshots/contract-snapshot.baseline.json');
const UPDATE_FLAG = '--update-baseline';

/** Deterministic serialization so baseline diffs stay reviewable. */
function serialize(snapshot: ContractSnapshot): string {
  return JSON.stringify(snapshot, null, 2) + '\n';
}

function summarize(snapshot: ContractSnapshot): string {
  return (
    `version=${snapshot.version} ` +
    `resources=${snapshot.resources.length} ` +
    `runStates=${snapshot.runStates.length} ` +
    `stepStates=${snapshot.stepStates.length} ` +
    `errorCodes=${snapshot.errorCodes.length} ` +
    `schemaNames=${snapshot.schemaNames.length}`
  );
}

function readBaseline(): ContractSnapshot {
  if (!existsSync(BASELINE_PATH)) {
    console.error(`[contract:check] No baseline found at ${BASELINE_PATH}.`);
    console.error(
      '[contract:check] Create one with: npx tsx scripts/contract-snapshot-check.ts --update-baseline',
    );
    process.exit(1);
  }
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf-8')) as ContractSnapshot;
  } catch (err) {
    console.error(
      `[contract:check] Failed to parse baseline at ${BASELINE_PATH}: ${(err as Error).message}`,
    );
    process.exit(1);
  }
}

function writeBaseline(snapshot: ContractSnapshot): void {
  mkdirSync(dirname(BASELINE_PATH), { recursive: true });
  writeFileSync(BASELINE_PATH, serialize(snapshot));
}

function main(): void {
  const updateBaseline = process.argv.slice(2).includes(UPDATE_FLAG);
  const current = snapshotContracts();

  if (updateBaseline) {
    writeBaseline(current);
    console.log(`[contract:snapshot] Baseline written to ${BASELINE_PATH}`);
    console.log(`[contract:snapshot] ${summarize(current)}`);
    return;
  }

  const baseline = readBaseline();
  const breaking = detectBreakingChanges(baseline, current);

  if (breaking.length > 0) {
    console.error('[contract:check] Breaking contract changes detected:');
    for (const change of breaking) {
      console.error(`  - ${change}`);
    }
    console.error('');
    console.error('[contract:check] If these changes are intentional, refresh the baseline:');
    console.error(
      '[contract:check]   npx tsx scripts/contract-snapshot-check.ts --update-baseline',
    );
    process.exit(1);
  }

  console.log(`[contract:check] No breaking changes detected (${summarize(current)}).`);
}

main();
