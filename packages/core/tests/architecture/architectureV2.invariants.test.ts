/**
 * Architecture V2 invariant gates — CI blockers.
 *
 * These tests encode the due-diligence invariants. Failing them means the
 * architecture has regressed toward the pre-V2 accidental design.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '../../../..');
const CORE_SRC = join(ROOT, 'packages/core/src');

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

function walkTsFiles(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkTsFiles(p, acc);
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) acc.push(p);
  }
  return acc;
}

describe('Architecture V2 invariants', () => {
  it('declares apps/api as the sole Gateway in runbook', () => {
    const doc = read('docs/runbooks/architecture-v2-gateway.md');
    assert.match(doc, /sole Gateway|single Gateway|Canonical control-plane/i);
    assert.match(doc, /CommanderHttpServer/);
  });

  it('CommanderHttpServer is marked deprecated for product Gateway use', () => {
    const src = read('packages/core/src/runtime/httpServer.ts');
    assert.match(src, /@deprecated[\s\S]*Architecture V2/);
    assert.match(src, /apps\/api/);
  });

  it('createDriverSoft fail-closes in production', () => {
    const src = read('packages/core/src/storage/factory.ts');
    assert.match(src, /fail-closed in production|failClosed/);
    assert.match(src, /COMMANDER_ALLOW_SOFT_STORAGE/);
  });

  it('SideEffectGate exists and is wired into ToolExecutionService', () => {
    assert.ok(existsSync(join(CORE_SRC, 'runtime/sideEffectGate.ts')));
    const tes = read('packages/core/src/runtime/toolExecutionService.ts');
    assert.match(tes, /getSideEffectGate|SideEffectGate/);
    assert.doesNotMatch(
      tes,
      /running without ATR ledger/,
      'legacy soft scheduleAction bypass message must be removed',
    );
  });

  it('ATR scheduler exposes pauseRun and claimRunnableRun', () => {
    const src = read('packages/core/src/atr/scheduler.ts');
    assert.match(src, /pauseRun\(/);
    assert.match(src, /claimRunnableRun\(/);
    assert.match(src, /scheduleResume\(/);
  });

  it('waiting_for_human is a first-class execution status and checkpoint phase', () => {
    const exec = read('packages/core/src/runtime/types/execution.ts');
    const phase = read('packages/core/src/runtime/phases/AgentExecutionState.ts');
    assert.match(exec, /waiting_for_human/);
    assert.match(phase, /waiting_for_human/);
  });

  it('WorkGraph planner profiles cover legacy CLI verbs', () => {
    const src = read('packages/core/src/planner/workGraphPlanner.ts');
    for (const profile of ['run', 'swarm', 'drive', 'goal', 'company']) {
      assert.match(src, new RegExp(`'${profile}'`));
    }
    assert.match(src, /profileFromCliVerb/);
  });

  it('V2 contracts package exists and deleted shells stay absent', () => {
    assert.ok(existsSync(join(ROOT, 'packages/contracts/package.json')));
    assert.equal(existsSync(join(ROOT, 'packages/control-plane')), false);
    assert.equal(existsSync(join(ROOT, 'packages/orchestration')), false);
  });

  it('InMemoryKernelRepository is not re-exported from @praetor/kernel main barrel', () => {
    const barrel = read('packages/kernel/src/index.ts');
    assert.doesNotMatch(
      barrel,
      /export\s*\{[^}]*InMemoryKernelRepository/,
      'InMemory must stay on @praetor/kernel/testing/inMemoryRepository only',
    );
    const pkg = JSON.parse(read('packages/kernel/package.json')) as {
      exports?: Record<string, unknown>;
    };
    assert.ok(
      pkg.exports?.['./testing/inMemoryRepository'],
      'subpath export ./testing/inMemoryRepository must exist',
    );
  });

  it('package and CI wiring expose the architecture guard', () => {
    const packageJson = JSON.parse(read('package.json')) as {
      scripts?: Record<string, string>;
    };
    assert.equal(packageJson.scripts?.['arch:guard'], 'bash scripts/arch-guard.sh');
    assert.equal(
      packageJson.scripts?.['arch:guard:test'],
      'pnpm exec node --import tsx --test scripts/arch-guard.test.ts',
    );
    assert.match(read('.github/workflows/ci.yml'), /run: pnpm arch:guard/);
    assert.match(read('.github/workflows/ci.yml'), /run: pnpm arch:guard:test/);
    assert.match(read('.github/workflows/ci.yml'), /run: pnpm contract:check/);
    assert.match(read('.github/workflows/ci.yml'), /pnpm --filter @commander\/contracts test/);
    assert.match(
      read('.github/workflows/ci.yml'),
      /Architecture V2 invariant gates[\s\S]*run: pnpm test:arch/,
    );
    assert.match(
      read('.github/workflows/ci.yml'),
      /Architecture constitution guard \(repository\)[\s\S]*run: pnpm arch:guard/,
    );
  });

  it('contract snapshot baseline exists and matches current surface', () => {
    const baselinePath = join(ROOT, 'packages/contracts/snapshots/contract-snapshot.baseline.json');
    assert.ok(existsSync(baselinePath), 'contract snapshot baseline must be committed');
    const baseline = JSON.parse(
      read('packages/contracts/snapshots/contract-snapshot.baseline.json'),
    ) as {
      version: string;
      resources: string[];
    };
    assert.equal(baseline.version, 'v2');
    assert.ok(baseline.resources.length >= 15);
  });

  it('core reuses shared control-plane contract types', () => {
    const controlPlane = read('packages/core/src/controlPlane/index.ts');
    const policyTypes = read('packages/core/src/atr/policy/types.ts');
    const pluginSandbox = read('packages/core/src/plugins/pluginSandbox.ts');
    assert.match(controlPlane, /from ['"]@commander\/contracts['"]/);
    assert.match(policyTypes, /from ['"]@commander\/contracts['"]/);
    assert.match(pluginSandbox, /from ['"]@commander\/contracts['"]/);
    assert.doesNotMatch(controlPlane, /export interface WorkloadIdentity/);
    assert.doesNotMatch(policyTypes, /export type PolicyEffect\s*=/);
    assert.doesNotMatch(pluginSandbox, /export type PluginSandboxMode\s*=/);
  });

  it('SDK exports versioned v1 resources', () => {
    const idx = read('packages/sdk/src/index.ts');
    assert.match(idx, /SDK_API_VERSION|v1\/resources/);
    const res = read('packages/sdk/src/v1/resources.ts');
    assert.match(res, /RunV1/);
    assert.match(res, /WorkGraphV1/);
    assert.match(res, /InteractionV1/);
    assert.match(res, /PolicyBundleV1/);
  });

  it('DR backup/restore runbook exists', () => {
    assert.ok(existsSync(join(ROOT, 'docs/runbooks/dr-backup-restore.md')));
    const doc = read('docs/runbooks/dr-backup-restore.md');
    assert.match(doc, /RPO|RTO|Point-in-Time|pg_basebackup|atr_ledger/i);
  });

  it('CheckpointingPhase dual-writes pause to ATR', () => {
    const src = read('packages/core/src/runtime/phases/checkpointing.ts');
    assert.match(src, /pauseForHuman/);
    assert.match(src, /getExecutionScheduler\(\)\.pauseRun/);
  });

  it('does not reintroduce silent scheduleAction bypass in runtime tool path', () => {
    const files = walkTsFiles(join(CORE_SRC, 'runtime'));
    const offenders = files.filter((f) => {
      const text = readFileSync(f, 'utf8');
      return /running without ATR ledger/.test(text);
    });
    assert.deepStrictEqual(
      offenders.map((f) => relative(ROOT, f)),
      [],
      'found legacy ATR bypass strings',
    );
  });
});
