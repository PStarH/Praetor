/**
 * Native/local startup contract.
 *
 * Regression guard for the two "startup environment" defects:
 *
 *   1. `loadEnvUp()` existed in `packages/core/src/cli/envLoader.ts` but was
 *      never called by the CLI, so a project `.env` was ignored entirely. The
 *      fix is a side-effect bootstrap module (`src/cli/bootstrapEnv.ts`) that
 *      `cliEntry.ts` imports FIRST, because ESM evaluates the static import
 *      list before the importing module's own statements.
 *   2. `apps/api` ran `ts-node-dev` under `"type": "module"` and never loaded
 *      the repo-root `.env`.
 *
 * Every subprocess here runs from an isolated temp cwd with an allow-listed
 * environment, so the developer's real repository `.env` is never read and no
 * provider endpoint is contacted. `commander doctor --offline` is the probe:
 * it prints `Tools configured — N tools` (derived from `COMMANDER_TOOLS`) and
 * `API key — Optional in offline mode`, and it never performs connectivity
 * checks.
 *
 * Run: node --import tsx --test scripts/native-startup-contract.test.ts
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const CLI_SRC = join(REPO_ROOT, 'packages', 'core', 'src', 'cliEntry.ts');
const CLI_DIST = join(REPO_ROOT, 'packages', 'core', 'dist', 'cliEntry.js');
const BOOTSTRAP_SRC = join(REPO_ROOT, 'packages', 'core', 'src', 'cli', 'bootstrapEnv.ts');
const BOOTSTRAP_DIST = join(REPO_ROOT, 'packages', 'core', 'dist', 'cli', 'bootstrapEnv.js');
const API_PACKAGE_JSON = join(REPO_ROOT, 'apps', 'api', 'package.json');
const ROOT_PACKAGE_JSON = join(REPO_ROOT, 'package.json');

const SUBPROCESS_TIMEOUT_MS = 180_000;
const SENTINEL_TOOLS = 'alpha,beta,gamma';
const ORDER_SENTINEL = 'COMMANDER_NATIVE_ORDER_SENTINEL';

const tempDirs: string[] = [];

after(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

/**
 * Allow-listed child environment. Nothing from the developer's shell is
 * forwarded except the bare necessities, so no provider credential — from the
 * shell or from the repository `.env` — can reach the subprocess.
 */
function isolatedEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    NO_COLOR: '1',
    ...extra,
  };
}

/** Create an isolated workspace containing a sentinel `.env`. */
function makeWorkspace(envContents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'commander-native-startup-'));
  tempDirs.push(dir);
  writeFileSync(join(dir, '.env'), envContents, 'utf8');
  return dir;
}

interface RunResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function runCli(
  entry: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  useTsx: boolean,
): RunResult {
  const argv = useTsx ? [TSX_CLI, entry, ...args] : [entry, ...args];
  const result = spawnSync(process.execPath, argv, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: SUBPROCESS_TIMEOUT_MS,
  });
  assert.equal(
    (result.error as NodeJS.ErrnoException | undefined)?.code,
    undefined,
    `CLI subprocess failed to complete: ${String(result.error)}`,
  );
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function importSpecifiers(source: string): string[] {
  const re = /^[ \t]*import\s+(?:[^'"\n]*?\sfrom\s+)?['"]([^'"]+)['"]/gm;
  const specifiers: string[] = [];
  for (const match of source.matchAll(re)) specifiers.push(match[1]);
  return specifiers;
}

describe('CLI .env bootstrap', () => {
  it('cliEntry imports the env bootstrap before any other module', () => {
    const source = readFileSync(CLI_SRC, 'utf8');
    const specifiers = importSpecifiers(source);
    assert.ok(specifiers.length > 5, 'cliEntry should have a static import graph');
    assert.equal(
      specifiers[0],
      './cli/bootstrapEnv',
      'the env bootstrap must be the first static import of cliEntry.ts — ' +
        'ESM evaluates the import list in source order, and any import ahead of ' +
        'it would initialize before .env is loaded',
    );
  });

  it('the bootstrap module loads the walk-up .env with an explicit test opt-out', () => {
    const source = readFileSync(BOOTSTRAP_SRC, 'utf8');
    assert.match(source, /from '\.\/envLoader'/, 'must reuse the existing loader');
    assert.match(source, /loadEnvUp\(\)/, 'must actually invoke loadEnvUp()');
    assert.match(source, /NODE_ENV !== 'test'/, 'must not ingest .env during tests');
    assert.match(source, /COMMANDER_SKIP_DOTENV/, 'must expose an explicit opt-out');
  });

  it('source CLI loads the sentinel .env from an isolated cwd without provider calls', () => {
    const cwd = makeWorkspace(
      `COMMANDER_TOOLS=${SENTINEL_TOOLS}\nCOMMANDER_NATIVE_STARTUP_SENTINEL=from_dotenv\n`,
    );

    const result = runCli(CLI_SRC, ['doctor', '--offline'], cwd, isolatedEnv(), true);

    assert.equal(result.signal, null, 'subprocess must not be killed by the timeout');
    assert.match(result.stdout, /Tools configured — 3 tools/);
    // No provider credential was inherited or picked up from the walk-up, and
    // the offline branch means no connectivity probe was attempted.
    assert.match(result.stdout, /API key — Optional in offline mode/);
    assert.match(result.stdout, /Skipped \(offline mode\)/);
    assert.doesNotMatch(result.stdout, /Testing /);
    assert.doesNotMatch(result.stderr, /Testing /);
  });

  it('inherited environment wins over the .env file', () => {
    const cwd = makeWorkspace(`COMMANDER_TOOLS=${SENTINEL_TOOLS}\n`);

    const result = runCli(
      CLI_SRC,
      ['doctor', '--offline'],
      cwd,
      isolatedEnv({ COMMANDER_TOOLS: 'solo' }),
      true,
    );

    assert.match(result.stdout, /Tools configured — 1 tools/);
    assert.doesNotMatch(result.stdout, /3 tools/);
  });

  it('NODE_ENV=test suppresses the automatic .env load', () => {
    const cwd = makeWorkspace(`COMMANDER_TOOLS=${SENTINEL_TOOLS}\n`);

    const result = runCli(
      CLI_SRC,
      ['doctor', '--offline'],
      cwd,
      isolatedEnv({ NODE_ENV: 'test' }),
      true,
    );

    assert.match(result.stdout, /Tools configured — 10 tools/);
  });

  it('bootstrap ordering is what makes module-scope env reads see .env', () => {
    const cwd = makeWorkspace(`${ORDER_SENTINEL}=from_dotenv\n`);
    const bootstrapHref = pathToFileURL(BOOTSTRAP_SRC).href;

    writeFileSync(
      join(cwd, 'probe-config.ts'),
      `process.stdout.write(\`PROBE_MODULE_SCOPE=\${process.env.${ORDER_SENTINEL} ?? '<unset>'}\\n\`);\n`,
      'utf8',
    );
    // Bootstrap first — mirrors cliEntry.ts.
    writeFileSync(
      join(cwd, 'probe-bootstrap-first.ts'),
      `import ${JSON.stringify(bootstrapHref)};\nimport './probe-config.ts';\n`,
      'utf8',
    );
    // Bootstrap last — the pre-fix ordering, kept as a falsification control.
    writeFileSync(
      join(cwd, 'probe-bootstrap-last.ts'),
      `import './probe-config.ts';\nimport ${JSON.stringify(bootstrapHref)};\n` +
        `process.stdout.write(\`PROBE_LATE_READ=\${process.env.${ORDER_SENTINEL} ?? '<unset>'}\\n\`);\n`,
      'utf8',
    );

    const bootstrapFirst = runCli(
      join(cwd, 'probe-bootstrap-first.ts'),
      [],
      cwd,
      isolatedEnv(),
      true,
    );
    assert.match(bootstrapFirst.stdout, /PROBE_MODULE_SCOPE=from_dotenv/);

    const bootstrapLast = runCli(
      join(cwd, 'probe-bootstrap-last.ts'),
      [],
      cwd,
      isolatedEnv(),
      true,
    );
    assert.match(bootstrapLast.stdout, /PROBE_MODULE_SCOPE=<unset>/);
    assert.match(bootstrapLast.stdout, /PROBE_LATE_READ=from_dotenv/);
  });

  it(
    'built CLI honours the same .env contract',
    {
      skip: existsSync(BOOTSTRAP_DIST)
        ? false
        : 'packages/core/dist/cli/bootstrapEnv.js not built — run pnpm --filter @praetor/core build',
    },
    () => {
      assert.ok(existsSync(CLI_DIST), 'dist/cliEntry.js must exist when dist is built');
      const source = readFileSync(CLI_DIST, 'utf8');
      assert.equal(importSpecifiers(source)[0], './cli/bootstrapEnv.js');

      const cwd = makeWorkspace(`COMMANDER_TOOLS=${SENTINEL_TOOLS}\n`);
      const result = runCli(CLI_DIST, ['doctor', '--offline'], cwd, isolatedEnv(), false);

      assert.equal(result.signal, null);
      assert.match(result.stdout, /Tools configured — 3 tools/);
      assert.match(result.stdout, /Skipped \(offline mode\)/);
    },
  );
});

describe('apps/api dev startup', () => {
  it('uses Node 22 + tsx watch instead of ts-node-dev', () => {
    const apiPkg = JSON.parse(readFileSync(API_PACKAGE_JSON, 'utf8')) as {
      type?: string;
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    assert.equal(apiPkg.type, 'module');

    const dev = apiPkg.scripts?.dev ?? '';
    assert.doesNotMatch(dev, /ts-node-dev/, 'ts-node-dev cannot run a "type": "module" entry');
    assert.match(dev, /--import tsx\b/, 'must use the workspace tsx loader');
    assert.match(dev, /--watch\b/, 'must keep the watch/reload behaviour');
    assert.match(dev, /src\/index\.ts/, 'must keep the same entry point');
    // Deliberate, non-fatal root .env load: absent file must not break `dev`.
    const envFlag = dev.match(/--env-file-if-exists=(\S+)/);
    assert.ok(envFlag, 'must point --env-file-if-exists at the repo-root .env');
    assert.equal(resolve(dirname(API_PACKAGE_JSON), envFlag[1]), join(REPO_ROOT, '.env'));

    // tsx comes from the workspace root; the API package must not re-declare it.
    const rootPkg = JSON.parse(readFileSync(ROOT_PACKAGE_JSON, 'utf8')) as {
      devDependencies?: Record<string, string>;
    };
    assert.ok(rootPkg.devDependencies?.tsx, 'tsx must be a root devDependency');
    assert.equal(apiPkg.dependencies?.tsx, undefined);
    assert.equal(apiPkg.devDependencies?.tsx, undefined);
    assert.ok(existsSync(TSX_CLI), 'root tsx must be installed');
  });
});
