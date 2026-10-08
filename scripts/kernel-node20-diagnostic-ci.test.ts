import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { load } from 'js-yaml';

type WorkflowStep = {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, string | boolean | number>;
  if?: string;
};

type Workflow = {
  permissions?: Record<string, string>;
  jobs?: Record<
    string,
    {
      'runs-on'?: string;
      'timeout-minutes'?: number;
      steps?: WorkflowStep[];
    }
  >;
};

const workflowPath = join(process.cwd(), '.github/workflows/kernel-node20-diagnostics.yml');

describe('kernel Node 20 hang diagnostics workflow', () => {
  it('runs only on dispatch and retains bounded per-file evidence', () => {
    assert.ok(existsSync(workflowPath), 'manual diagnostic workflow must exist');

    const source = readFileSync(workflowPath, 'utf8');
    const workflow = load(source) as Workflow;

    assert.match(source, /^on:\s*\n\s+workflow_dispatch:/m);
    assert.doesNotMatch(source, /^\s+(pull_request|push):/m);
    assert.deepEqual(workflow.permissions, { contents: 'read' });

    const job = workflow.jobs?.diagnose;
    assert.ok(job, 'workflow must define one diagnostic job');
    assert.equal(job['runs-on'], 'ubuntu-latest');
    assert.equal(job['timeout-minutes'], 30);

    const steps = job.steps ?? [];
    assert.equal(
      steps.find((step) => step.uses?.startsWith('actions/checkout@'))?.uses,
      'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803',
    );
    assert.equal(
      steps.find((step) => step.uses?.startsWith('actions/setup-node@'))?.with?.['node-version'],
      20,
    );
    assert.match(
      steps.find((step) => step.name === 'Install dependencies')?.run ?? '',
      /pnpm install --frozen-lockfile/,
    );

    const diagnose = steps.find((step) => step.name === 'Capture per-file kernel test boundaries');
    const diagnosticScript = diagnose?.run ?? '';
    const contractsBuild = 'pnpm --filter @praetor/contracts build';
    const effectBrokerBuild = 'pnpm --filter @praetor/effect-broker build';
    assert.match(diagnosticScript, /pnpm --filter @(commander|praetor)\/contracts build/);
    assert.match(diagnosticScript, /pnpm --filter @(commander|praetor)\/effect-broker build/);
    assert.ok(
      diagnosticScript.indexOf(contractsBuild) < diagnosticScript.indexOf(effectBrokerBuild),
      'contracts must be built before effect-broker and individual kernel tests',
    );
    assert.match(diagnosticScript, /packages\/kernel\/package\.json/);
    assert.match(diagnosticScript, /timeout --signal=TERM/);
    assert.match(diagnosticScript, /kernel-test-events\.ndjson/);
    assert.match(diagnosticScript, /\"event\":\"start\"/);
    assert.match(diagnosticScript, /\"event\":\"end\"/);
    assert.doesNotThrow(() => {
      execFileSync('bash', ['-n'], { input: diagnosticScript, stdio: 'pipe' });
    }, 'diagnostic shell must remain syntactically valid');

    const artifact = steps.find((step) => step.name === 'Upload sanitized kernel diagnostics');
    assert.equal(
      artifact?.uses,
      'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
    );
    assert.equal(artifact?.if, 'always()');
    assert.equal(artifact?.with?.name, 'kernel-node20-diagnostics');
    assert.match(String(artifact?.with?.path), /kernel-test-events\.ndjson/);

    assert.doesNotMatch(source, /\bkubectl\b|\bkind\b|\bdocker\b/i);
  });
});
