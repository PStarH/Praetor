/**
 * LM-18 / MOD-02 contract test for the Architecture V2 gate.
 *
 * The gate's import check used to be a single regex requiring the specifier to
 * be *exactly* a forbidden string, so a real subpath import —
 * `import '@praetor/core/runtime/agentRuntime'` — passed even though
 * `@praetor/core/runtime` is on the forbidden list. It also matched prose in
 * comments, reporting a violation for a comment that merely *mentioned* an
 * import.
 *
 * Each case builds a throwaway project (config + source) and runs the real gate
 * against it, so the test exercises the shipped script rather than a copy.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..');
const gateScript = path.join(repoRoot, 'scripts/architecture-gate.ts');

const CONFIG = {
  v2Packages: ['packages/kernel'],
  forbiddenCoreImports: ['@praetor/core', '@praetor/core/runtime', '@praetor/core/security'],
  v2ImportExceptions: [],
  api: { path: 'apps/api/src', legacyImportExceptions: [], unversionedRouteExceptions: [] },
  authorityExceptions: [],
};

/** Build a throwaway project and return the gate's combined output. */
function runGateInProject(
  config: unknown,
  setup: (tmp: string) => void,
): { status: number; output: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-gate-'));
  try {
    fs.mkdirSync(path.join(tmp, 'scripts'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'scripts/architecture-gate.config.json'),
      JSON.stringify(config, null, 2),
    );
    setup(tmp);

    try {
      const output = execFileSync(path.join(repoRoot, 'node_modules/.bin/tsx'), [gateScript], {
        cwd: tmp,
        encoding: 'utf-8',
        env: { ...process.env, NODE_OPTIONS: '' },
      });
      return { status: 0, output };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { status: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function runGate(source: string): { status: number; output: string } {
  return runGateInProject(CONFIG, (tmp) => {
    fs.mkdirSync(path.join(tmp, 'packages/kernel/src'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'apps/api/src'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'packages/kernel/src/subject.ts'), source);
  });
}

describe('LM-18: architecture gate resolves real module specifiers', () => {
  it('fails on an exact forbidden import', () => {
    const { status, output } = runGate(
      `import { x } from '@praetor/core';\nexport const y = x;\n`,
    );
    assert.equal(status, 1, output);
    assert.match(output, /imports forbidden @(commander|praetor)\/core modules/);
  });

  it('fails on a DEEP subpath of a forbidden module (previously missed)', () => {
    const { status, output } = runGate(
      `import { AgentRuntime } from '@praetor/core/runtime/agentRuntime';\nexport const r = AgentRuntime;\n`,
    );
    assert.equal(status, 1, `deep subpath import must be rejected\n${output}`);
    assert.match(output, /@(commander|praetor)\/core\/runtime/);
  });

  it('fails on a re-export from a forbidden module', () => {
    const { status, output } = runGate(
      `export { redact } from '@praetor/core/security/secrets';\n`,
    );
    assert.equal(status, 1, `re-export must be rejected\n${output}`);
    assert.match(output, /@(commander|praetor)\/core\/security/);
  });

  it('fails on a literal require() of a forbidden module', () => {
    const { status, output } = runGate(
      `const core = require('@praetor/core/runtime/tenantContext');\nexport const t = core;\n`,
    );
    assert.equal(status, 1, `literal require must be rejected\n${output}`);
    assert.match(output, /@(commander|praetor)\/core\/runtime/);
  });

  it('fails on a literal dynamic import() of a forbidden module', () => {
    const { status, output } = runGate(
      `export async function load() {\n  return await import('@praetor/core/observability');\n}\n`,
    );
    assert.equal(status, 1, `literal dynamic import must be rejected\n${output}`);
    assert.match(output, /@(commander|praetor)\/core/);
  });

  it('passes on a near-miss package name (no bare string prefix matching)', () => {
    const { status, output } = runGate(
      `import { x } from '@praetor/core-extra';\nexport const y = x;\n`,
    );
    assert.equal(status, 0, `@praetor/core-extra must NOT match @praetor/core\n${output}`);
  });

  it('passes when a forbidden import appears only in a comment', () => {
    const { status, output } = runGate(
      `// Historically this file did: import { AgentRuntime } from '@praetor/core/runtime/agentRuntime';\n` +
        `/** And the doc block also mentions from '@praetor/core' */\nexport const y = 1;\n`,
    );
    assert.equal(status, 0, `prose mentioning an import is not a violation\n${output}`);
  });

  it('passes when a forbidden specifier appears only in a string literal', () => {
    const { status, output } = runGate(
      `export const DOC = "import { x } from '@praetor/core'";\nexport const y = 1;\n`,
    );
    assert.equal(status, 0, `a string literal is not an import\n${output}`);
  });

  it('passes on a clean file that imports only node builtins', () => {
    const { status, output } = runGate(
      `import { readFileSync } from 'node:fs';\nexport const r = readFileSync;\n`,
    );
    assert.equal(status, 0, output);
  });
});

/**
 * LM-18 steps 4 and 5: the gate must validate its own configuration, and must
 * never treat "I could not look" as "I looked and found nothing".
 *
 * Before this was fixed the config was only cast to its TypeScript interface —
 * `JSON.parse(readFileSync(...)) as GateConfig` — and each package walk was
 * wrapped in a bare `catch {}` that skipped the whole package. Both defects
 * were fail-open: a typo'd key removed a check, and a package that was not on
 * disk was reported as clean. Each case below is a RED-before case.
 */
describe('LM-18: the gate validates its configuration and fails closed', () => {
  const CLEAN_SOURCE = `export const y = 1;\n`;

  /** A project whose tree matches CONFIG, so only the config can fail it. */
  const setupCleanTree = (tmp: string): void => {
    fs.mkdirSync(path.join(tmp, 'packages/kernel/src'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'apps/api/src'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'packages/kernel/src/subject.ts'), CLEAN_SOURCE);
  };

  it('rejects a typo that would otherwise disable a whole check', () => {
    const { forbiddenCoreImports, ...rest } = CONFIG;
    const { status, output } = runGateInProject(
      { ...rest, forbiddenCoreImportZZZ: forbiddenCoreImports },
      setupCleanTree,
    );
    assert.equal(status, 1, `a typo'd key must not be accepted in silence\n${output}`);
    assert.match(output, /unknown key/);
    assert.match(output, /forbiddenCoreImportZZZ/);
  });

  it('rejects a missing required key', () => {
    const { authorityExceptions, ...rest } = CONFIG;
    const { status, output } = runGateInProject(rest, setupCleanTree);
    assert.equal(status, 1, output);
    assert.match(output, /missing required key "authorityExceptions"/);
  });

  it('rejects an exception list of the wrong type', () => {
    const { status, output } = runGateInProject(
      { ...CONFIG, v2ImportExceptions: 'not-an-array' },
      setupCleanTree,
    );
    assert.equal(status, 1, output);
    assert.match(output, /"v2ImportExceptions" must be an array/);
  });

  it('rejects an empty list that would silently disable its check', () => {
    const { status, output } = runGateInProject({ ...CONFIG, v2Packages: [] }, setupCleanTree);
    assert.equal(status, 1, output);
    assert.match(output, /"v2Packages" must not be empty/);
  });

  it('rejects a $schema reference that points at nothing', () => {
    const { status, output } = runGateInProject(
      { ...CONFIG, $schema: './no-such-schema.json' },
      setupCleanTree,
    );
    assert.equal(status, 1, output);
    assert.match(output, /points at a file that does not exist/);
  });

  it('accepts the shipped $schema reference', () => {
    const { status, output } = runGateInProject(
      { ...CONFIG, $schema: './architecture-gate.schema.json' },
      (tmp) => {
        setupCleanTree(tmp);
        // The real schema lives next to the real config, not in the fixture.
        fs.copyFileSync(
          path.join(repoRoot, 'scripts/architecture-gate.schema.json'),
          path.join(tmp, 'scripts/architecture-gate.schema.json'),
        );
      },
    );
    assert.equal(status, 0, output);
  });

  it('fails closed when a configured package does not exist', () => {
    // RED before the fix: the walk was wrapped in a bare `catch {}`, so the
    // missing package was skipped and the gate still printed "passed".
    const { status, output } = runGateInProject(
      { ...CONFIG, v2Packages: ['packages/kernel', 'packages/does-not-exist'] },
      setupCleanTree,
    );
    assert.equal(status, 1, `a package that is not there must not pass silently\n${output}`);
    assert.match(output, /packages\/does-not-exist\/src does not exist/);
  });

  it('still passes when the configuration and the tree agree', () => {
    const { status, output } = runGateInProject(CONFIG, setupCleanTree);
    assert.equal(status, 0, output);
    assert.match(output, /Architecture V2 gate passed/);
  });
});
