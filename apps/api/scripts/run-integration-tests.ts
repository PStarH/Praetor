#!/usr/bin/env node
/**
 * API integration test runner.
 *
 * Builds the API, starts the server on a free port, runs the TypeScript
 * live-server integration tests in `apps/api/tests`, then shuts the server down.
 *
 * The tests themselves refuse to run without `TEST_API_URL` (see
 * `apps/api/test/_helpers/requireLiveServer.mjs`), so this runner is the only
 * supported way to execute them.
 *
 * Server environment this runner guarantees
 * ----------------------------------------
 * The suite targets the standard (non-enterprise) local profile and asserts it
 * end to end, so the runner sets the profile switch itself rather than leaving
 * it to the caller's shell:
 *   - `COMMANDER_LEGACY_EXECUTION=1` mounts the documented compatibility
 *     routers (`/api/quality/*`, `/v1` legacy execution bridge; see
 *     docs/v2-migration-guide.md). Without it the suite's positive cases for
 *     those routes observe the 410 freeze instead of the route.
 * The remaining preconditions are infrastructure, not switches:
 *   - `DATABASE_URL` for the `commander_app` role plus
 *     `COMMANDER_DATABASE_TLS_CA_FILE` /
 *     `COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256`; the API aborts
 *     startup without them (`AUTH_DATABASE_URL_REQUIRED`).
 *   - `JWT_SECRET` (>= 32 chars, non-public default).
 *   - `AUTH_DISABLED`/`COMMANDER_ALLOW_ANON` are actively removed: they are a
 *     non-production authentication bypass, and `AUTH_DISABLED=true` outranks
 *     the suite's own credential assertions in both the server and the test
 *     process (`apps/api/src/authMiddleware.ts:160-187`). The suite
 *     authenticates with a real principal minted by
 *     `apps/api/test/_helpers/liveServerCredential.ts`, so the bypass must not
 *     be inherited from the caller's shell.
 *
 * Why the port is allocated instead of assumed
 * --------------------------------------------
 * A fixed `PORT` made the runner silently test a *different* server: a stale
 * process already bound to that port keeps answering `/health`, the new child
 * dies with EADDRINUSE, and the health poll succeeds against the stale one.
 * The runner now asks the OS for a free port, fails if its own child reported a
 * bind error, and only then polls `/health` on that port.
 *
 * Why the test invocation no longer shells out to `npx tsx`
 * --------------------------------------------------------
 * `npx -p tsx tsx` resolved tsx to a doubled path in this workspace
 * (`<repo>/node_modules/node_modules/.pnpm/tsx@…/dist/cli.mjs`), so the runner
 * died with MODULE_NOT_FOUND before a single test ran. The runner now spawns
 * `process.execPath` with the locally resolved tsx loader — the same pattern
 * `packages/core/scripts/run-node-tests.mjs` uses, and the only loader path
 * that stays valid regardless of how the repo was installed.
 *
 * Fail-closed behaviour
 * ---------------------
 * This script exits non-zero unless the suite provably ran and passed:
 *   - the tsx loader cannot be resolved, or is missing on disk
 *   - `tests/` contains no `*.test.ts` files (an empty run must not look green)
 *   - the core or API build exits non-zero
 *   - the server entry is missing after the build
 *   - no free port can be allocated
 *   - the server fails to spawn, exits early, reports a bind error, or never
 *     answers `/health` within the timeout (the server's own output is printed
 *     to explain why)
 *   - the test child fails to spawn, is killed by a signal, or exits non-zero
 *   - the test child exits 0 without a test summary, or reports 0 passing tests
 *     (a nested `node --test` inherits NODE_TEST_CONTEXT and skips silently with
 *     exit 0, so the summary — not the exit code — is the evidence)
 */
import { reportSilentFailure } from '@praetor/core';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as net from 'node:net';
import * as path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

const API_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_ENTRY = path.join(API_ROOT, 'dist', 'index.js');
const TESTS_DIR = path.join(API_ROOT, 'tests');
const HEALTH_TIMEOUT_MS = 30_000;
const BIND_ERROR_PATTERN = /EADDRINUSE|EACCES|COMMANDER_API_STARTUP_FAILED/;

/** Print a precondition failure and exit non-zero. Only used before the server starts. */
function fail(message: string): never {
  console.error(`[run-integration-tests] ${message}`);
  process.exit(1);
}

/** Ask the OS for a free port. Allocating it here is what ends the stale-listener hazard. */
function allocateFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') {
        probe.close(() => reject(new Error('could not determine a free port')));
        return;
      }
      const { port } = address;
      probe.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

/**
 * Environment the server child must see. `COMMANDER_LEGACY_EXECUTION=1` is the
 * documented local-compatibility switch the suite's positive cases require; the
 * caller's value (if any) is preserved.
 */
function serverEnvironment(port: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    COMMANDER_LEGACY_EXECUTION: process.env.COMMANDER_LEGACY_EXECUTION ?? '1',
  };
  // The suite asserts real authentication; inheriting the bypass would make
  // every credential case vacuous.
  delete env.AUTH_DISABLED;
  delete env.COMMANDER_ALLOW_ANON;
  return env;
}

/** Resolve the workspace-local tsx loader; never route through npx. */
function resolveTsxLoaderUrl(): string {
  let resolved: string | undefined;
  try {
    resolved = require.resolve('tsx');
  } catch (cause) {
    fail(
      `could not resolve the local tsx loader — run \`pnpm install\`. ` +
        `(${cause instanceof Error ? cause.message : String(cause)})`,
    );
  }
  const url = pathToFileURL(resolved).href;
  if (!existsSync(new URL(url))) {
    fail(`resolved tsx loader does not exist on disk: ${url}`);
  }
  return url;
}

/** Every file this suite owns. An empty directory is a failure, not a green run. */
function discoverTestFiles(): string[] {
  if (!existsSync(TESTS_DIR)) {
    fail(`test directory does not exist: ${TESTS_DIR}`);
  }
  const files = readdirSync(TESTS_DIR)
    .filter((name) => name.endsWith('.test.ts'))
    .sort()
    .map((name) => path.join(TESTS_DIR, name));
  if (files.length === 0) {
    fail(`${TESTS_DIR} contains no *.test.ts files — refusing to report success for an empty run`);
  }
  return files;
}

function run(
  cmd: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
): Promise<number> {
  return new Promise<number>((resolve) => {
    const child = spawn(cmd, args, {
      stdio: 'inherit',
      shell: process.platform === 'win32',
      cwd: options?.cwd,
      env: { ...process.env, ...options?.env },
    });
    child.on('error', (err) => {
      console.error(`[run-integration-tests] failed to spawn ${cmd}: ${err.message}`);
      resolve(1);
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

type ServerExit = { code: number | null; signal: NodeJS.Signals | null };

async function waitForHealth(url: string, exit: () => ServerExit | undefined): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < HEALTH_TIMEOUT_MS) {
    const exited = exit();
    if (exited) {
      throw new Error(
        `API server exited before becoming healthy (code=${exited.code} signal=${exited.signal})`,
      );
    }
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return;
    } catch (err) {
      reportSilentFailure(err, 'run-integration-tests:health-poll');
      // server not ready yet
    }
    await sleep(250);
  }
  throw new Error(
    `API server did not become healthy at ${url}/health within ${HEALTH_TIMEOUT_MS}ms`,
  );
}

/**
 * Run the suite with the locally resolved tsx loader and return the exit code.
 * Exit 0 is only trusted when the run also emitted a summary with passing tests.
 */
async function runNodeTests(
  tsxLoaderUrl: string,
  files: string[],
  testApiUrl: string,
): Promise<number> {
  // A nested `node --test` inherits NODE_TEST_CONTEXT, prints
  // "skipping running files" and exits 0 having executed nothing. That is a
  // silent success for an empty run, so the variable is removed for the child
  // and the child's summary is verified below.
  const childEnv: NodeJS.ProcessEnv = { ...process.env, TEST_API_URL: testApiUrl };
  delete childEnv.NODE_TEST_CONTEXT;
  delete childEnv.AUTH_DISABLED;
  delete childEnv.COMMANDER_ALLOW_ANON;

  const child = spawn(
    process.execPath,
    ['--import', tsxLoaderUrl, '--test', '--test-concurrency=1', '--test-reporter=spec', ...files],
    { cwd: API_ROOT, env: childEnv, stdio: ['inherit', 'pipe', 'pipe'] },
  );

  let stdout = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    process.stdout.write(chunk);
  });
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));

  let spawnError: Error | undefined;
  let closeCode: number | null = null;
  let closeSignal: NodeJS.Signals | null = null;
  await new Promise<void>((resolve) => {
    child.on('error', (err) => {
      spawnError = err;
      resolve();
    });
    child.on('close', (code, signal) => {
      closeCode = code;
      closeSignal = signal;
      resolve();
    });
  });

  if (spawnError) {
    console.error(`[run-integration-tests] failed to spawn the test runner: ${spawnError.message}`);
    return 1;
  }
  if (closeSignal) {
    console.error(`[run-integration-tests] test runner terminated by signal ${closeSignal}`);
    return 1;
  }
  if (closeCode !== 0) {
    return closeCode ?? 1;
  }

  const passMatch = /^[#ℹ]\s*pass\s+(\d+)/m.exec(stdout);
  const failMatch = /^[#ℹ]\s*fail\s+(\d+)/m.exec(stdout);
  if (!passMatch || !failMatch) {
    console.error(
      '[run-integration-tests] the test runner exited 0 but produced no test summary — refusing ' +
        'to report success for a run that did not execute tests',
    );
    return 1;
  }
  if (Number(passMatch[1]) === 0) {
    console.error(
      '[run-integration-tests] the test runner reported 0 passing tests — refusing to report ' +
        'success for an empty run',
    );
    return 1;
  }
  return 0;
}

async function stopServer(server: ChildProcess): Promise<void> {
  if (server.exitCode !== null || server.signalCode !== null) return;
  const closed = new Promise<void>((resolve) => server.once('close', () => resolve()));
  server.kill('SIGTERM');
  await Promise.race([closed, sleep(2000)]);
  if (server.exitCode === null && server.signalCode === null) {
    server.kill('SIGKILL');
    await Promise.race([closed, sleep(1000)]);
  }
}

async function main(): Promise<void> {
  const tsxLoaderUrl = resolveTsxLoaderUrl();
  const files = discoverTestFiles();

  console.log('Building @praetor/core...');
  let code = await run('pnpm', ['--filter', '@praetor/core', 'build']);
  if (code !== 0) {
    fail('core build failed — see output above');
  }

  console.log('Building @praetor/api...');
  code = await run('pnpm', ['--filter', '@praetor/api', 'build']);
  if (code !== 0) {
    fail('API build failed — see output above');
  }
  if (!existsSync(SERVER_ENTRY)) {
    fail(`server entry not found after the build: ${SERVER_ENTRY}`);
  }

  const port = await allocateFreePort().catch((err: unknown) => {
    fail(`could not allocate a free port: ${err instanceof Error ? err.message : String(err)}`);
  });
  console.log(`Starting API server on port ${port} (allocated free)...`);
  const server = spawn(process.execPath, [SERVER_ENTRY], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: serverEnvironment(port),
  });

  let serverExit: ServerExit | undefined;
  let serverOutput = '';
  server.stdout?.on('data', (chunk: Buffer) => {
    serverOutput += chunk.toString();
    process.stdout.write(chunk);
  });
  server.stderr?.on('data', (chunk: Buffer) => {
    serverOutput += chunk.toString();
    process.stderr.write(chunk);
  });
  server.on('exit', (exitCode, signal) => {
    serverExit = { code: exitCode, signal };
  });

  let exitCode = 1;
  try {
    const testApiUrl = `http://localhost:${port}`;
    await waitForHealth(testApiUrl, () => serverExit);
    // A child that lost the race for the port prints a bind error on stderr and
    // then exits; either way this is not the server the suite asked for.
    if (BIND_ERROR_PATTERN.test(serverOutput)) {
      throw new Error(
        `API server could not bind port ${port} (bind error in its output — see below)`,
      );
    }
    console.log(`Server healthy at ${testApiUrl}, running integration tests...`);

    // Serial execution: the suite shares one server (and one PostgreSQL auth
    // authority), so parallel files race on shared state.
    exitCode = await runNodeTests(tsxLoaderUrl, files, testApiUrl);

    // Re-check after the run: the child's bind failure can land on stderr after
    // the health probe already succeeded against whatever else owns the port.
    if (BIND_ERROR_PATTERN.test(serverOutput)) {
      console.error(`[run-integration-tests] API server reported a bind error: ${serverOutput}`);
      exitCode = 1;
    }
  } catch (err) {
    console.error(`[run-integration-tests] ${err instanceof Error ? err.message : String(err)}`);
    if (serverOutput.trim()) {
      console.error(`[run-integration-tests] API server output:\n${serverOutput.trim()}`);
    }
    exitCode = 1;
  } finally {
    await stopServer(server);
  }

  process.exit(exitCode);
}

main();
