import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { load } from 'js-yaml';

type WorkflowStep = {
  name?: string;
  run?: string;
  uses?: string;
  if?: string;
  with?: Record<string, string | number>;
};

/**
 * Remote actions are pinned to an immutable 40-hex commit SHA with the
 * human-readable ref kept as a trailing comment. js-yaml strips that comment,
 * so the parsed value is `owner/repo@<40-hex>`; a bare tag is still accepted so
 * the check does not depend on the pinning style.
 */
function usesAction(step: WorkflowStep, action: string): boolean {
  return new RegExp(`^${action}@(?:[0-9a-f]{40}|v[0-9]+)$`).test(step.uses ?? '');
}

type Workflow = {
  jobs?: Record<
    string,
    {
      'runs-on'?: string;
      'timeout-minutes'?: number;
      env?: Record<string, string>;
      steps?: WorkflowStep[];
    }
  >;
};

function moduleAWorkflow(): Workflow {
  return load(
    readFileSync(join(process.cwd(), '.github/workflows/module-a-ci.yml'), 'utf8'),
  ) as Workflow;
}

function qualityWorkflow(): Workflow {
  return load(readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8')) as Workflow;
}

describe('Module A CI workflow', () => {
  it('declares architecture-gate runtime dependencies at the workspace root', () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      devDependencies?: Record<string, string>;
    };
    assert.ok(
      packageJson.devDependencies?.typescript,
      'workspace root must declare typescript because architecture-gate imports it directly',
    );
  });

  it('builds dependencies before the clean core and kernel typechecks', () => {
    const quality = qualityWorkflow().jobs?.quality;
    assert.ok(quality, 'Quality workflow must define its quality job');
    // Match on the step's *job*, not a frozen label: the step was renamed when it
    // grew to cover the kernel, and a name-based lookup made this gate fail on a
    // cosmetic edit while telling us nothing about the ordering it exists to
    // protect.
    const typecheck = quality.steps?.find((step) =>
      /TypeScript check \(core/.test(step.name ?? ''),
    );
    assert.ok(typecheck, 'Quality workflow must define the core TypeScript check step');
    assert.match(
      typecheck.run ?? '',
      /@(commander|praetor)\/postgres-runtime build[\s\S]*core exec tsc --noEmit/,
      'clean core typecheck must build postgres-runtime declarations first',
    );
    // The kernel sources import @praetor/effect-broker, so its build must also
    // precede the kernel typechecks, and the test-tsconfig check must actually run.
    assert.match(
      typecheck.run ?? '',
      /@(commander|praetor)\/effect-broker build[\s\S]*kernel exec tsc --noEmit/,
      'kernel source typecheck must build effect-broker declarations first',
    );
    assert.match(
      typecheck.run ?? '',
      /pnpm --dir packages\/kernel run typecheck:test/,
      'the kernel test-tsconfig typecheck must be part of the gate',
    );
  });

  it('uses a reproducible runner and preserves gate evidence on failure', () => {
    const workflow = moduleAWorkflow();
    const job = workflow.jobs?.['module-a-gates'];
    assert.ok(job, 'Module A workflow must define its gate job');
    assert.equal(job['runs-on'], 'ubuntu-latest');
    assert.equal(job['timeout-minutes'], 30);
    assert.equal(job.env?.COMMANDER_CI_EVIDENCE_DIR, '.internal/evidence/ci/module-a');

    const steps = job.steps ?? [];
    const setupPnpm = steps.find((step) => usesAction(step, 'pnpm/action-setup'));
    assert.equal(setupPnpm?.with?.version, '9.15.4');
    const setupNode = steps.find((step) => usesAction(step, 'actions/setup-node'));
    assert.equal(setupNode?.with?.['node-version'], '22');

    const install = steps.find((step) => step.name === 'Install locked dependencies');
    assert.equal(install?.run, 'pnpm install --frozen-lockfile');

    const gate = steps.find((step) => step.name === 'Run Module A gates');
    assert.equal(gate?.run, 'bash scripts/ci/module-a-gates.sh');

    const artifact = steps.find((step) => step.name === 'Upload Module A evidence');
    assert.equal(artifact?.if, 'always()');
    assert.equal(artifact !== undefined && usesAction(artifact, 'actions/upload-artifact'), true);
    assert.equal(artifact?.with?.path, '.internal/evidence/ci/module-a/');
  });

  it('keeps the gate runner executable and versioned in the repository', () => {
    const script = join(process.cwd(), 'scripts/ci/module-a-gates.sh');
    assert.equal(existsSync(script), true);
    assert.notEqual(statSync(script).mode & 0o111, 0);
    assert.match(readFileSync(script, 'utf8'), /overall_status=0/);
  });

  it('does not use the tsx IPC CLI for workflow test entrypoints', () => {
    for (const workflow of readdirSync(join(process.cwd(), '.github/workflows'))) {
      if (!workflow.endsWith('.yml') && !workflow.endsWith('.yaml')) continue;
      const source = readFileSync(join(process.cwd(), '.github/workflows', workflow), 'utf8');
      assert.doesNotMatch(
        source.replaceAll('node --import tsx --test', ''),
        /\btsx --test\b/,
        `${workflow} must use node --import tsx`,
      );
    }
  });

  it('uses pnpm for the pre-commit vitest smoke in pnpm workspaces', () => {
    const source = readFileSync(join(process.cwd(), 'scripts/precommitHook.ts'), 'utf8');
    assert.match(source, /execFileSync\(\s*'pnpm'/s);
    assert.doesNotMatch(source, /execFileSync\(\s*'npx'/s);
  });
});
