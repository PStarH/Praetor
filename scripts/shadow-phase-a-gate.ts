#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_CHILD_OUTPUT_BYTES = 16 * 1024;
const TOTAL_SUITES = 13;
const PACKAGE_NAME = 'commander-shadow-plane';

/**
 * Repository root, derived from this module's own URL.
 *
 * The evidence file below must land in the same place no matter which directory
 * the gate was invoked from. A bare relative path (`writeFile('…')`) resolves
 * against `process.cwd()`, so running the gate from a workspace package — or
 * from any other subdirectory — would scatter evidence files into the source
 * tree instead of the repository root the CI upload step expects.
 */
const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

export const SHADOW_PHASE_A_DATABASE_PREREQUISITE_CODE = 'COMMANDER_SHADOW_PG_ADMIN_URL_REQUIRED';

export interface ShadowPhaseACommand {
  id:
    | 'contracts'
    | 'architecture'
    | 'shadow-tests'
    | 'shadow-typecheck'
    | 'contracts-build'
    | 'postgres-runtime-build'
    | 'shadow-clean'
    | 'shadow-build'
    | 'shadow-package'
    | 'shadow-package-contents'
    | 'shadow-package-import'
    | 'customer-pack'
    | 'postgres-live';
  file: string;
  args: string[];
  cwd?: string;
}

export interface ShadowPhaseAChildResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ShadowPhaseAGateOptions {
  ci?: boolean;
  githubActions?: boolean;
  databaseUrl?: string;
  sourceRevision?: string;
  run?: (command: ShadowPhaseACommand) => Promise<ShadowPhaseAChildResult>;
}

export interface ShadowPhaseAGateResult {
  diagnostics?: string[];
  exitCode: 0 | 1;
  code: string;
  sourceRevision: string;
  passed: number;
  total: number;
}

function failureDiagnostics(result: ShadowPhaseAChildResult): { diagnostics?: string[] } {
  const output = `${result.stdout}\n${result.stderr}`;
  const signatures: [string, RegExp][] = [
    ['SQLSTATE_42501', /code: ['"]42501['"]/],
    ['SQLSTATE_42883', /code: ['"]42883['"]/],
    ['SQLSTATE_42601', /code: ['"]42601['"]/],
    ['SQLSTATE_42P01', /code: ['"]42P01['"]/],
    ['PERMISSION_DENIED', /permission denied/],
    ['MODULE_NOT_FOUND', /ERR_MODULE_NOT_FOUND|Cannot find module/],
    ['PNPM_OFFLINE_MISSING', /ERR_PNPM_NO_OFFLINE_TARBALL/],
    ['PNPM_OFFLINE_METADATA_MISSING', /ERR_PNPM_NO_OFFLINE_META/],
    ['PNPM_NO_MATCHING_VERSION', /ERR_PNPM_NO_MATCHING_VERSION/],
    ['PNPM_LOCKFILE_CONFIGURATION', /ERR_PNPM_LOCKFILE_CONFIG_MISMATCH/],
    ['PACKAGE_ENTRY_UNRESOLVED', /Failed to resolve entry for package/],
    ['FILE_NOT_FOUND', /ENOENT/],
    ['ATTESTATION_INVALID', /SHADOW_INGESTION_ATTESTATION_INVALID/],
    ['ASSERTION_FAILED', /ERR_ASSERTION/],
    ['SYNTAX_ERROR', /syntax error/],
  ];
  const diagnostics = signatures
    .filter(([, pattern]) => pattern.test(output))
    .map(([code]) => code);
  return diagnostics.length ? { diagnostics } : {};
}

function suiteFailureCode(id: ShadowPhaseACommand['id']): string {
  return `SHADOW_PHASE_A_${id.replace(/-/g, '_').toUpperCase()}_FAILED`;
}

export function runBoundedShadowPhaseAChild(
  command: ShadowPhaseACommand,
): Promise<ShadowPhaseAChildResult> {
  return new Promise((resolveResult) => {
    const child = spawn(command.file, command.args, {
      cwd: command.cwd ?? process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    const append = (value: Buffer, destination: 'stdout' | 'stderr') => {
      const previous = destination === 'stdout' ? stdout : stderr;
      const bytes = Buffer.concat([Buffer.from(previous), value]);
      const captured = bytes.subarray(-MAX_CHILD_OUTPUT_BYTES / 2).toString('utf8');
      if (destination === 'stdout') stdout = captured;
      else stderr = captured;
    };

    child.stdout.on('data', (value: Buffer) => append(value, 'stdout'));
    child.stderr.on('data', (value: Buffer) => append(value, 'stderr'));
    child.once('error', () => resolveResult({ exitCode: 1, stdout, stderr }));
    child.once('close', (code) => resolveResult({ exitCode: code ?? 1, stdout, stderr }));
  });
}

function isCommitRevision(value: string): boolean {
  return /^[0-9a-f]{40}$/i.test(value);
}

export function sourceRevisionFromGithubSha(configured: string | undefined): string {
  const revision = configured?.trim();
  return revision && isCommitRevision(revision) ? revision : 'unavailable';
}

function currentRevision(): string {
  if (process.env.GITHUB_SHA !== undefined) {
    return sourceRevisionFromGithubSha(process.env.GITHUB_SHA);
  }
  try {
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return isCommitRevision(revision) ? revision : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

async function packageVersion(): Promise<string> {
  const manifest = JSON.parse(
    await readFile(resolve(process.cwd(), 'packages/shadow-plane/package.json'), 'utf8'),
  ) as { version?: unknown };
  if (
    typeof manifest.version !== 'string' ||
    !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(manifest.version)
  ) {
    throw new Error('SHADOW_PHASE_A_PACKAGE_VERSION_INVALID');
  }
  return manifest.version;
}

function baseCommands(packageDirectory: string, packageFile: string): ShadowPhaseACommand[] {
  const extracted = join(packageDirectory, 'extracted');
  return [
    { id: 'contracts', file: 'pnpm', args: ['--filter', '@praetor/contracts', 'test'] },
    { id: 'contracts-build', file: 'pnpm', args: ['--filter', '@praetor/contracts', 'build'] },
    {
      id: 'postgres-runtime-build',
      file: 'pnpm',
      args: ['--filter', '@praetor/postgres-runtime', 'build'],
    },
    {
      id: 'architecture',
      file: 'pnpm',
      args: [
        '--dir',
        'packages/core',
        'exec',
        'vitest',
        'run',
        'tests/architecture/shadow-replay-removal.test.ts',
      ],
    },
    {
      id: 'shadow-tests',
      file: 'pnpm',
      args: ['--filter', '@praetor/shadow-plane', 'test'],
    },
    {
      id: 'shadow-typecheck',
      file: 'pnpm',
      args: ['--filter', '@praetor/shadow-plane', 'typecheck'],
    },
    {
      id: 'shadow-clean',
      file: 'node',
      args: [
        '--input-type=module',
        '--eval',
        "import { rm } from 'node:fs/promises'; await rm('dist', { recursive: true, force: true });",
      ],
      cwd: resolve(process.cwd(), 'packages/shadow-plane'),
    },
    { id: 'shadow-build', file: 'pnpm', args: ['--filter', '@praetor/shadow-plane', 'build'] },
    {
      id: 'shadow-package',
      file: 'pnpm',
      args: ['pack', '--pack-destination', packageDirectory],
      cwd: resolve(process.cwd(), 'packages/shadow-plane'),
    },
    { id: 'shadow-package-contents', file: 'tar', args: ['-tzf', packageFile] },
    {
      id: 'shadow-package-import',
      file: 'sh',
      args: [
        '-ec',
        `pnpm --filter @praetor/shadow-plane deploy --prod "$2/deployed" && mkdir -p "$2/package" && mv "$2/deployed/node_modules" "$2/package/node_modules" && tar -xzf "$1" -C "$2" && cd "$2/package" && node --input-type=module --eval 'import { readFile } from "node:fs/promises"; const manifest = JSON.parse(await readFile("package.json", "utf8")); const dependencies = manifest.dependencies; if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies) || Object.entries(dependencies).some(([name, version]) => !name || typeof version !== "string" || !version.trim())) process.exit(1);' && node --input-type=module --eval 'import { readFile } from "node:fs/promises"; const manifest = JSON.parse(await readFile("package.json", "utf8")); for (const dependency of Object.keys(manifest.dependencies)) await import(dependency); await import("./dist/index.js");'`,
        'shadow-phase-a-gate',
        packageFile,
        extracted,
      ],
    },
    {
      id: 'customer-pack',
      file: 'pnpm',
      args: ['exec', 'node', '--import', 'tsx', '--test', 'scripts/shadow-customer-pack.test.ts'],
    },
  ];
}

function hasRequiredPackageContents(output: string): boolean {
  return output.includes('package/dist/index.js') && output.includes('package/dist/cli.js');
}

export async function runShadowPhaseAGate(
  options: ShadowPhaseAGateOptions = {},
): Promise<ShadowPhaseAGateResult> {
  const sourceRevision = options.sourceRevision
    ? sourceRevisionFromGithubSha(options.sourceRevision)
    : currentRevision();
  const run = options.run ?? runBoundedShadowPhaseAChild;
  const packageDirectory = await mkdtemp(join(process.cwd(), '.commander-shadow-phase-a-'));
  let passed = 0;

  try {
    const version = await packageVersion();
    const packageFile = join(packageDirectory, `${PACKAGE_NAME}-${version}.tgz`);
    for (const command of baseCommands(packageDirectory, packageFile)) {
      const result = await run(command);
      if (result.exitCode !== 0) {
        return {
          ...failureDiagnostics(result),
          exitCode: 1,
          code: suiteFailureCode(command.id),
          sourceRevision,
          passed,
          total: TOTAL_SUITES,
        };
      }
      if (command.id === 'shadow-package-contents' && !hasRequiredPackageContents(result.stdout)) {
        return {
          exitCode: 1,
          code: suiteFailureCode(command.id),
          sourceRevision,
          passed,
          total: TOTAL_SUITES,
        };
      }
      passed += 1;
    }

    if (options.ci !== true || options.githubActions !== true || !options.databaseUrl) {
      return {
        exitCode: 1,
        code: SHADOW_PHASE_A_DATABASE_PREREQUISITE_CODE,
        sourceRevision,
        passed,
        total: TOTAL_SUITES,
      };
    }

    const databaseResult = await run({
      id: 'postgres-live',
      file: 'pnpm',
      args: ['--filter', '@praetor/shadow-plane', 'test:postgres-live'],
    });
    if (databaseResult.exitCode !== 0) {
      return {
        ...failureDiagnostics(databaseResult),
        exitCode: 1,
        code: suiteFailureCode('postgres-live'),
        sourceRevision,
        passed,
        total: TOTAL_SUITES,
      };
    }
    return {
      exitCode: 0,
      code: 'SHADOW_PHASE_A_GATE_PASSED',
      sourceRevision,
      passed: passed + 1,
      total: TOTAL_SUITES,
    };
  } catch {
    return {
      exitCode: 1,
      code: 'SHADOW_PHASE_A_GATE_CONFIGURATION_FAILED',
      sourceRevision,
      passed,
      total: TOTAL_SUITES,
    };
  } finally {
    await rm(packageDirectory, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const result = await runShadowPhaseAGate({
    ci: process.env.CI === 'true',
    githubActions: process.env.GITHUB_ACTIONS === 'true',
    databaseUrl: process.env.COMMANDER_SHADOW_PG_ADMIN_URL,
  });
  process.stdout.write(
    `shadow_phase_a_gate status=${result.exitCode === 0 ? 'passed' : 'failed'} code=${result.code} source_revision=${result.sourceRevision} suites_passed=${result.passed} suites_total=${result.total}\n`,
  );
  if (process.env.GITHUB_ACTIONS === 'true') {
    await writeFile(
      join(REPO_ROOT, 'shadow-phase-a-evidence.json'),
      `${JSON.stringify(result)}\n`,
      {
        mode: 0o600,
      },
    );
  }
  process.exitCode = result.exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
