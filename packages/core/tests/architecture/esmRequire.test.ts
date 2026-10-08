/**
 * Runtime regression for the ESM `require` boundary.
 *
 * Companion to `noBareRequire.test.ts`, which is a *static* gate. This file
 * checks the *runtime* contract on a module graph that does not depend on the
 * vitest transform — which matters, because vitest supplies its own `require`
 * binding and therefore masks this entire bug class. Only a plain `node:test`
 * run (or the built `dist/` output) exercises the real ES-module semantics.
 *
 * Two defects are guarded here (both found 2026-09-16):
 *
 * 1. **Bare global `require`.** 36 sites in this `"type": "module"` repo called
 *    it. Each raised `ReferenceError: require is not defined`; inside a
 *    `try`/`catch` meant to tolerate an absent optional dependency, that is
 *    indistinguishable from a real absence. `probePostgres()` reported
 *    `pg require failed: require is not defined` while `pg` was installed and
 *    importable.
 *
 * 2. **A shared `nodeRequire` helper.** The first fix exported one
 *    `createRequire(import.meta.url)` from `optionalImport.ts`. That resolves
 *    *relative* specifiers against `optionalImport.ts`'s directory, not the
 *    caller's — so `nodeRequire('./redTeamFramework')` in `src/security/` became
 *    `MODULE_NOT_FOUND` instead of `ReferenceError`. One broken thing traded for
 *    another. Every module must now bind its own require; the last two tests
 *    pin that rule so it cannot silently come back.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { optionalRequire } from '../../src/optionalImport';
import { probePostgres } from '../../src/storage/postgresDriver';

/** A per-module require, exactly as production code binds it. */
const nodeRequire = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

test('a module-local require resolves a node builtin', () => {
  const fs = nodeRequire('node:fs');
  assert.equal(typeof fs.readFileSync, 'function');
  const path = nodeRequire('node:path');
  assert.equal(typeof path.join, 'function');
});

test('a module-local require resolves a relative specifier against the caller', () => {
  // `../../src/optionalImport` is relative to THIS file. It only resolves if the
  // require was bound with this file's URL.
  const mod = nodeRequire('../../src/optionalImport');
  assert.equal(typeof mod.optionalRequire, 'function');
  assert.equal(typeof mod.optionalImport, 'function');
});

test('a module-local require resolves a relative specifier from a nested directory', () => {
  // Mirrors src/security/agentLineage.ts -> './capabilityToken'. Resolution must
  // follow the *bound* module, not some shared helper.
  const nested = createRequire(join(here, '..', '..', 'src', 'security', 'probe.js'));
  const mod = nested('./capabilityToken');
  assert.ok(mod, 'expected src/security/capabilityToken to resolve');
});

test('nodeRequire throws for a missing module, like CommonJS require', () => {
  assert.throws(
    () => nodeRequire('@praetor/definitely-not-a-real-module'),
    (err) => err instanceof Error,
  );
});

test('optionalRequire returns null instead of throwing for a missing module', () => {
  assert.equal(optionalRequire('@praetor/definitely-not-a-real-module'), null);
});

test('optionalRequire resolves a bare specifier', () => {
  const pg = optionalRequire('pg');
  assert.ok(pg, 'expected the `pg` peer dependency to be installed in this workspace');
});

test('optionalRequire resolves relative specifiers against src/, not the caller', () => {
  // Pins the caveat documented in optionalImport.ts. The shared helper's
  // `createRequire` was built from `src/optionalImport.ts`, so `./x` means
  // `src/x` — NOT `src/<caller's dir>/x`.
  //
  //   - './optionalImport' lives in src/ itself, so it resolves;
  //   - './redTeamFramework' would only be right from src/security/, so from
  //     here it silently returns null even though the file exists.
  //
  // That silent null is exactly why there is no shared `nodeRequire` export:
  // it turns a loud failure into an empty result. If someone "fixes" either
  // assertion below, they have changed that decision on purpose.
  assert.ok(
    // scan-bare-require-allow: the specifier is deliberately relative to src/, not to this file
    optionalRequire('./optionalImport'),
    'expected src/optionalImport to resolve',
  );
  assert.equal(
    // scan-bare-require-allow: failing to resolve from here IS the behaviour under test
    optionalRequire('./redTeamFramework'),
    null,
    'src/security/redTeamFramework.ts exists, but the shared helper looks in src/',
  );
});

test('probePostgres never fails with a ReferenceError', () => {
  const result = probePostgres();
  const reason = String(result.reason ?? '');
  assert.ok(
    !reason.includes('require is not defined'),
    `probePostgres() reported an ESM require failure: ${reason}`,
  );
  assert.equal(typeof result.available, 'boolean');
});
