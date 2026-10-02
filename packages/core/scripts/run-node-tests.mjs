#!/usr/bin/env node
/**
 * Run the `node:test` half of the `packages/core` suite.
 *
 * Usage
 * -----
 *   node scripts/run-node-tests.mjs                      # every node:test file under tests/
 *   node scripts/run-node-tests.mjs tests/tools          # a directory
 *   node scripts/run-node-tests.mjs tests/tools/gitTool.test.ts   # one file
 *
 * Why this script no longer shells out to `npx tsx`
 * -------------------------------------------------
 * `npx` resolved tsx to a doubled path in this workspace
 * (`<repo>/node_modules/node_modules/.pnpm/tsx@…/dist/cli.mjs`), so *every*
 * invocation died with MODULE_NOT_FOUND before a single test ran. The runner
 * now spawns `process.execPath` with the locally resolved tsx loader, which is
 * the only loader path that is valid regardless of how the repo was installed.
 *
 * Fail-closed behaviour
 * ---------------------
 * The script exits non-zero when it cannot prove the suite ran:
 *   - no files matched
 *   - a selected file is not a `node:test` file (vitest files belong to vitest;
 *     running them here would report 0 tests and exit 0)
 *   - a selected file is outside `tests/`, which the inventory gate treats as
 *     unreachable
 *   - a candidate file cannot be read at all, so it cannot be proven to be a
 *     `node:test` file (silently skipping it would let a blocked file escape the
 *     run while the suite still reported success)
 *   - a selected file declares no test/suite, so it would silently run 0 cases
 *   - the tsx loader cannot be resolved
 *   - the child process was killed by a signal, or could not be spawned
 *   - the child exited non-zero
 *   - the child exited 0 without emitting a test summary, or reported 0 passing
 *     tests. Node exits 0 after printing "skipping running files" when a nested
 *     `node --test` inherits NODE_TEST_CONTEXT, so exit code 0 alone is not
 *     evidence that anything ran; the summary is checked instead.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  CORE_ROOT,
  classifyRunner,
  declaresAnyTest,
  discoverTestFiles,
  isEnvironmentReadFailure,
  isNodeRunnerFile,
  readSource,
  readSourceDetailed,
  toPosix,
} from './test-manifest.mjs';

const require = createRequire(import.meta.url);

const fail = (message) => {
  console.error(`[run-node-tests] ${message}`);
  process.exit(1);
};

// ── Resolve the tsx loader from this package, never through npx ─────────────
let tsxLoaderUrl;
try {
  tsxLoaderUrl = pathToFileURL(require.resolve('tsx')).href;
} catch (cause) {
  fail(
    `could not resolve the local tsx loader from ${CORE_ROOT} — run \`pnpm install\`. ` +
      `(${cause instanceof Error ? cause.message : String(cause)})`,
  );
}
if (!existsSync(new URL(tsxLoaderUrl))) {
  fail(`resolved tsx loader does not exist on disk: ${tsxLoaderUrl}`);
}

// ── Select the files to run ─────────────────────────────────────────────────
const args = process.argv.slice(2);

/** @type {string[]} */
let selected;
/** Files named explicitly on the command line — these are validated strictly. */
const explicitFiles = new Set();
if (args.length === 0) {
  selected = discoverTestFiles(CORE_ROOT).filter((file) => file.startsWith('tests/'));
} else {
  const explicit = [];
  for (const arg of args) {
    const absolute = join(CORE_ROOT, arg);
    if (!existsSync(absolute)) {
      fail(`path does not exist relative to ${CORE_ROOT}: ${arg}`);
    }
    if (statSync(absolute).isDirectory()) {
      const prefix = toPosix(relative(CORE_ROOT, absolute));
      explicit.push(...discoverTestFiles(CORE_ROOT).filter((file) => file.startsWith(`${prefix}/`)));
    } else {
      const rel = toPosix(relative(CORE_ROOT, absolute));
      explicit.push(rel);
      explicitFiles.add(rel);
    }
  }
  selected = explicit;
}

// Directory selections contain vitest files too — those belong to the other
// runner and are simply not this runner's business. Only an explicitly named
// file is an error when it turns out to be a vitest file.
//
// An UNREADABLE file is a different matter: silently dropping it would let a
// blocked file skip the run while the suite still reports success. We cannot
// prove such a file is *not* a node:test file, so fail closed instead.
const unreadable = [];
const files = [...new Set(selected)]
  .filter((file) => {
    if (explicitFiles.has(file)) return true;
    const read = readSourceDetailed(file, CORE_ROOT);
    if (!read.ok) {
      unreadable.push(read);
      return false;
    }
    return isNodeRunnerFile(file, read.source);
  })
  .sort();

if (unreadable.length > 0) {
  const detail = unreadable
    .map((r) =>
      isEnvironmentReadFailure(r.code)
        ? `${r.message} — environment/ACL block, not a missing file`
        : `${r.message} — listed by discovery but absent on disk`,
    )
    .join('\n  ');
  fail(
    `${unreadable.length} candidate file(s) could not be read, so the run cannot be proven ` +
      `complete:\n  ${detail}`,
  );
}

if (files.length === 0) {
  fail('no node:test files found — refusing to report success for an empty run');
}

// ── Validate every selected file before spawning anything ───────────────────
const rejected = [];
for (const file of files) {
  const source = readSource(file, CORE_ROOT);
  if (source === undefined) {
    rejected.push(`${file}: unreadable`);
    continue;
  }
  const runner = classifyRunner(source);
  if (runner !== 'node') {
    rejected.push(
      `${file}: imports ${runner === 'vitest' ? 'vitest' : runner === 'mixed' ? 'both vitest and node:test' : 'no test framework'} — it belongs to the vitest runner`,
    );
    continue;
  }
  if (!isNodeRunnerFile(file, source)) {
    rejected.push(`${file}: node:test file outside tests/ is not discoverable by this runner`);
    continue;
  }
  if (!declaresAnyTest(source)) {
    rejected.push(`${file}: declares no test/suite, so it would silently run 0 cases`);
  }
}

if (rejected.length > 0) {
  console.error('[run-node-tests] refusing to run — the following files cannot be trusted to run:');
  for (const line of rejected) console.error(`  - ${line}`);
  process.exit(1);
}

// ── Run them ────────────────────────────────────────────────────────────────
console.error(
  `[run-node-tests] running ${files.length} node:test file(s) with ${process.execPath} (concurrency=1)`,
);

// Node refuses to run a nested `node --test` when NODE_TEST_CONTEXT is set:
// it prints "run() is being called recursively within a test file. skipping
// running files." and exits 0 having executed nothing. That is a silent
// success for an empty run, so the variable is removed for the child and the
// child's summary is verified below.
const childEnv = { ...process.env };
delete childEnv.NODE_TEST_CONTEXT;
if (childEnv.COMMANDER_EVENT_SOURCING_WAL === undefined) {
  childEnv.COMMANDER_EVENT_SOURCING_WAL = '';
}
if (childEnv.COMMANDER_OTEL_ENABLED === undefined) {
  childEnv.COMMANDER_OTEL_ENABLED = 'false';
}

const child = spawn(
  process.execPath,
  ['--import', tsxLoaderUrl, '--test', '--test-concurrency=1', '--test-reporter=spec', ...files],
  { cwd: CORE_ROOT, env: childEnv, stdio: ['inherit', 'pipe', 'pipe'] },
);

// Stream output through while accumulating stdout, so the run is still
// observable live and the summary can be checked afterwards.
let stdout = '';
child.stdout.on('data', (chunk) => {
  stdout += chunk;
  process.stdout.write(chunk);
});
child.stderr.on('data', (chunk) => process.stderr.write(chunk));

const outcome = await new Promise((resolve) => {
  child.on('error', (err) => resolve({ error: err }));
  child.on('close', (code, signal) => resolve({ code, signal }));
});

if (outcome.error) {
  fail(`failed to spawn the test runner: ${outcome.error.message}`);
}
if (outcome.signal) {
  fail(`test runner terminated by signal ${outcome.signal}`);
}
if (outcome.code !== 0) {
  process.exit(outcome.code ?? 1);
}

// Exit code 0 is not proof that tests ran — a skipped or empty run also exits 0.
const passMatch = /^[#ℹ]\s*pass\s+(\d+)/m.exec(stdout);
const failMatch = /^[#ℹ]\s*fail\s+(\d+)/m.exec(stdout);
if (!passMatch || !failMatch) {
  fail(
    'the runner exited 0 but produced no test summary — refusing to report success for a run ' +
      'that did not execute tests (a nested `node --test` skips silently in this case)',
  );
}
if (Number(passMatch[1]) === 0) {
  fail('the runner reported 0 passing tests — refusing to report success for an empty run');
}

process.exit(0);
