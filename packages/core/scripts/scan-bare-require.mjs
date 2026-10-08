#!/usr/bin/env node
/**
 * Static gate: no bare `require(...)` in an ES-module package's source trees.
 *
 * Scope
 * -----
 * Both `src/` and `tests/` are scanned. `tests/` is *not* optional: a test file
 * lives under the same nearest `package.json` as `src/`, so it is the same
 * module system. A bare `require` there raises the same `ReferenceError`, and
 * because `node --test` reports a file-level failure the whole suite goes red
 * with an error that names the missing binding rather than the real defect.
 *
 * Scanning only `src/` made this gate fail *open*: it printed
 * "0 violations across 1293 source files" while
 * `packages/core/tests/advanced-integration.test.ts` alone contained 18 bare
 * `require` calls, breaking 7 `node:test` suites (2026-09-17). A gate that
 * cannot see a whole tree reports safety it has not verified.
 *
 * Why this exists
 * ---------------
 * Every package in this repo except `@praetor/contracts` declares
 * `"type": "module"`. In an ES module the CommonJS `require` binding does not
 * exist, so a bare `require('x')` raises `ReferenceError: require is not
 * defined` — it never resolves a module.
 *
 * That failure mode is dangerous precisely because it is *not* a loud crash:
 * most such calls sit inside `try { ... } catch { ... }` blocks that are meant
 * to tolerate an *absent optional dependency*. A ReferenceError is
 * indistinguishable from a real absence there, so the capability is silently
 * disabled while the code reports something unrelated — e.g. `probePostgres()`
 * returned `{ available: false, reason: 'pg require failed: require is not
 * defined' }` even though `pg` was installed and importable.
 *
 * Confirmed real-world impact before this gate existed (2026-09-16): 35 sites
 * in `packages/core/src`, silently disabling the Postgres backend, the
 * OIDC/SAML/SIEM HTTP auth plugins, capability-token cascade revocation,
 * three-layer memory persistence, and the `isolated-vm` sandbox tier.
 *
 * What to use instead
 * -------------------
 *   - `nodeRequire` from `packages/core/src/optionalImport.ts`
 *     (throws on failure, like CJS `require`)
 *   - `optionalRequire` from the same module (returns `null` when absent)
 *   - `createRequire(import.meta.url)` bound to a local name — the pattern
 *     `apps/api` uses via `esmCompat.getRequire()`
 *
 * A file that binds its own `require` (e.g. `const require =
 * createRequire(import.meta.url)`) is exempt, because that binding is real.
 *
 * Suppressing a finding
 * ---------------------
 * A site that is *correct on purpose* can be annotated with a reason, written
 * as a **comment** (a marker inside a string literal is not a suppression):
 *
 *     optionalRequire('./redTeamFramework'), // scan-bare-require-allow: specifier is the subject under test
 *
 * A marker trailing code suppresses only its own line. A marker alone on its
 * line annotates the line beneath it. It must be followed by at least 12
 * characters of reason; a reasonless marker is reported as an
 * `invalid-suppression` violation, because a suppression channel that opens on a
 * bare word is just a way to switch the gate off.
 *
 * Usage
 * -----
 *   node scripts/scan-bare-require.mjs            # scan the repo default set
 *   node scripts/scan-bare-require.mjs --json     # machine-readable output
 *
 * Exits 1 when any violation is found, so it is usable directly as a CI gate.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');

export const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/**
 * Callees that behave like `require`: they take a module specifier and load it
 * synchronously. A *relative* specifier passed to any of these is resolved
 * against the module that created the binding, so it must be checked.
 */
const REQUIRE_LIKE_CALLEES = new Set([
  'require',
  'nodeRequire',
  'requireModule',
  'optionalRequire',
  'esmRequire',
  'getRequire',
]);

/**
 * CommonJS globals that do not exist in an ES module. `require` is handled
 * separately (it has its own call-expression checks). `module` is deliberately
 * excluded: it is far too common as an ordinary variable name to flag without
 * unacceptable false-positive noise.
 */
const CJS_GLOBALS = ['__dirname', '__filename'];

/** Candidate on-disk forms a TS/ESM relative specifier may take. */
const RESOLUTION_SUFFIXES = ['', '.ts', '.tsx', '.js', '.mjs', '.cjs', '/index.ts', '/index.js'];

/**
 * Line-level suppression marker.
 *
 * A *small* number of sites must call a require-like helper with a specifier
 * that deliberately does not resolve from the caller — `esmRequire.test.ts`
 * pins the documented mis-resolution caveat of the shared helper, so its
 * "unresolvable" specifiers are the subject under test, not a defect.
 *
 * The marker must carry a reason of at least `MIN_SUPPRESSION_REASON` chars.
 * A reasonless marker is itself reported as a violation: a suppression channel
 * that can be opened by a bare word is just a way to turn the gate off.
 */
const SUPPRESSION_MARKER = 'scan-bare-require-allow';
const MIN_SUPPRESSION_REASON = 12;

/**
 * Parse suppression markers out of a file's **comments**.
 *
 * Comment-aware on purpose. An earlier version matched the marker anywhere in
 * the raw line text, so the string literal in this gate's own test fixture
 * (`"… require('pg'); // scan-bare-require-allow:\n"`) registered as a
 * reasonless suppression and failed the gate it was written to test. A marker
 * only means something when a human wrote it as a comment.
 *
 * A marker suppresses violations on the last line of its comment. When the
 * comment is the only thing on its line — the natural way to annotate the code
 * beneath it — the following line is suppressed too. A marker trailing code on
 * the same line suppresses **only** that line, so it cannot silently silence the
 * next statement as well.
 *
 * Returns `{ allowed, invalid }` where `allowed` is a `Set<number>` of
 * 1-based line numbers and `invalid` lists reasonless markers.
 */
export function parseSuppressions(text) {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) lineStarts.push(i + 1);
  }
  /** 1-based line number containing `pos`. */
  const lineAt = (pos) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };

  const allowed = new Set();
  const invalid = [];
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    /* skipTrivia */ false,
    ts.LanguageVariant.Standard,
    text,
  );

  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (
      token !== ts.SyntaxKind.SingleLineCommentTrivia &&
      token !== ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      continue;
    }
    const start = scanner.getTokenPos();
    const body = text.slice(start, scanner.getTextPos());
    const at = body.indexOf(SUPPRESSION_MARKER);
    if (at === -1) continue;

    const reason = body
      .slice(at + SUPPRESSION_MARKER.length)
      .replace(/^[\s:—–-]+/, '')
      .trim();
    if (reason.length < MIN_SUPPRESSION_REASON) {
      invalid.push({
        line: lineAt(start + at),
        text: body.trim().slice(0, 120),
        reason,
      });
      continue;
    }

    const endLine = lineAt(scanner.getTextPos() - 1);
    allowed.add(endLine);
    // Only an annotation that owns its line also covers the line beneath it.
    const codeBeforeComment = text.slice(lineStarts[lineAt(start) - 1], start).trim().length > 0;
    if (!codeBeforeComment) allowed.add(endLine + 1);
  }
  return { allowed, invalid };
}

/** True when `spec` (a `./` or `../` specifier) resolves from directory `dir`. */
function resolvesFrom(dir, spec) {
  const base = join(dir, spec);
  return RESOLUTION_SUFFIXES.some((suffix) => {
    try {
      return existsSync(base + suffix);
    } catch {
      return false;
    }
  });
}

/** Directories skipped everywhere: build output, deps, coverage. */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git', '.turbo']);

/**
 * Source trees scanned inside each ESM package, in scan order.
 *
 * `tests/` is listed deliberately — see the module header. Adding a tree here
 * widens the gate; leaving one out is what made it fail open before.
 */
export const PACKAGE_TREES = ['src', 'tests'];

/** Workspace directories whose children may be their own module boundary. */
const WORKSPACE_GROUPS = ['packages', 'apps'];

/** The `"type"` field of a package's manifest, or `null` when unreadable. */
function readPackageType(pkgDir) {
  try {
    return JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).type ?? null;
  } catch {
    return null;
  }
}

/**
 * ESM packages to scan, **derived** from each `package.json`'s `"type"` field.
 *
 * Derived rather than hardcoded on purpose: the same `.ts` extension means
 * different things depending on the nearest manifest. Root `scripts/*.ts` is
 * CommonJS (the root manifest has no `"type"`), so `require` and `__dirname`
 * are legitimate there — verified, not assumed — and `packages/contracts` is
 * the same. A hardcoded list would silently drift the moment a package's
 * `type` changed: either flagging CommonJS code as broken, or — worse — quietly
 * skipping a newly-added ESM package and reporting a clean scan.
 */
export function discoverEsmTargets({ repoRoot = REPO_ROOT } = {}) {
  const targets = [];
  for (const group of WORKSPACE_GROUPS) {
    let entries;
    try {
      entries = readdirSync(join(repoRoot, group), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const rel = `${group}/${entry.name}`;
      if (readPackageType(join(repoRoot, rel)) === 'module') targets.push(rel);
    }
  }
  return targets.sort();
}

/** The ESM targets of this repository, resolved once at module load. */
export const DEFAULT_TARGETS = discoverEsmTargets();

/** Names that are ESM-safe replacements for the global `require`. */
function collectTsFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collectTsFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** True when the file declares its own binding for `name`. */
function bindsName(sourceFile, name) {
  let bound = false;
  const visit = (node) => {
    if (bound) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      bound = true;
      return;
    }
    if (ts.isParameter(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      bound = true;
      return;
    }
    if (ts.isImportSpecifier(node) || ts.isImportClause(node)) {
      const local = ts.isImportClause(node) ? node.name : node.name;
      if (local && ts.isIdentifier(local) && local.text === name) {
        bound = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return bound;
}

/** True when the file declares its own `require` binding, making it legitimate. */
function bindsLocalRequire(sourceFile) {
  return bindsName(sourceFile, 'require');
}

/** True when `node` is a *reference* to a name, not a declaration or member name. */
function isReferencePosition(node) {
  const parent = node.parent;
  if (!parent) return false;
  // `obj.__dirname`, `{ __dirname: x }`, `interface X { __dirname: T }`
  if (
    (ts.isPropertyAccessExpression(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isEnumMember(parent) ||
      ts.isBindingElement(parent)) &&
    parent.name === node
  ) {
    return false;
  }
  // `const __dirname = ...`, `let __dirname`, destructuring, parameters
  if (ts.isVariableDeclaration(parent) && parent.name === node) return false;
  if (ts.isParameter(parent) && parent.name === node) return false;
  if ((ts.isImportSpecifier(parent) || ts.isImportClause(parent)) && parent.name === node) {
    return false;
  }
  if (ts.isQualifiedName(parent) || ts.isTypeReferenceNode(parent)) return false;
  return true;
}

/**
 * Scan one package directory.
 *
 * Returns `{ violations, fileCount, trees }`. `fileCount` is reported so
 * callers can prove the scan was not vacuous — a scan that reads zero files
 * trivially finds zero violations. `trees` names the source trees that actually
 * existed and were read, so a package that silently lost its `tests/` tree is
 * visible in the output instead of looking like a clean scan.
 *
 * Three checks are performed:
 *   `bare-require`      — a call to the undefined global `require`
 *   `bare-require-prop` — `require.resolve(...)` / `require.cache` on the global
 *   `unresolvable-relative` — a relative specifier handed to a require-like
 *                         helper, checked against the *containing* file. A
 *                         module-scoped `createRequire` resolves relative
 *                         specifiers against its own URL, so a shared helper
 *                         silently mis-resolves `./sibling` from a nested dir.
 */
export function scanPackage(pkgDir, { repoRoot = REPO_ROOT, trees = PACKAGE_TREES } = {}) {
  const files = [];
  const scannedTrees = [];
  for (const tree of trees) {
    const dir = join(pkgDir, tree);
    let isDir = false;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) continue;
    scannedTrees.push(tree);
    collectTsFiles(dir, files);
  }
  if (files.length === 0) return { violations: [], fileCount: 0, trees: [], suppressions: [] };

  const violations = [];
  const suppressions = [];

  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const lines = text.split('\n');
    const localRequire = bindsLocalRequire(sf);
    const unboundCjsGlobals = CJS_GLOBALS.filter((name) => !bindsName(sf, name));
    const dir = dirname(file);
    const relFile = relative(repoRoot, file).split(sep).join('/');
    const { allowed, invalid } = parseSuppressions(text);

    const report = (node, kind, message) => {
      const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      const lineNo = line + 1;
      if (allowed.has(lineNo)) {
        suppressions.push({ file: relFile, line: lineNo, kind, snippet: lines[line].trim().slice(0, 120) });
        return;
      }
      violations.push({
        kind,
        message,
        file: relFile,
        line: lineNo,
        column: character + 1,
        snippet: lines[line].trim().slice(0, 120),
      });
    };

    // A suppression marker without a reason is a violation in its own right —
    // otherwise the marker is just a way to switch the gate off.
    for (const bad of invalid) {
      violations.push({
        kind: 'invalid-suppression',
        message:
          `\`${SUPPRESSION_MARKER}\` needs a reason of at least ` +
          `${MIN_SUPPRESSION_REASON} characters explaining why this site is correct`,
        file: relFile,
        line: bad.line,
        column: 1,
        snippet: bad.text,
      });
    }

    /** First argument, when it is a plain string literal. */
    const literalArg = (call) => {
      const arg = call.arguments[0];
      if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
        return arg.text;
      }
      return null;
    };

    const visit = (node) => {
      // 4. bare CommonJS globals (`__dirname`, `__filename`)
      if (
        ts.isIdentifier(node) &&
        unboundCjsGlobals.includes(node.text) &&
        isReferencePosition(node)
      ) {
        report(node, 'cjs-global', `\`${node.text}\` does not exist in an ES module`);
      }

      if (ts.isCallExpression(node)) {
        const callee = node.expression;

        // 1. bare `require(...)`
        if (ts.isIdentifier(callee) && callee.text === 'require' && !localRequire) {
          report(callee, 'bare-require', 'the global `require` is undefined in an ES module');
        }

        // 2. `require.resolve(...)`, `require.cache`, ... on the global
        if (
          ts.isPropertyAccessExpression(callee) &&
          ts.isIdentifier(callee.expression) &&
          callee.expression.text === 'require' &&
          !localRequire
        ) {
          report(
            callee,
            'bare-require-prop',
            `\`require.${callee.name.text}\` on the undefined global \`require\``,
          );
        }

        // 3. relative specifier handed to a require-like helper
        if (
          (ts.isIdentifier(callee) && REQUIRE_LIKE_CALLEES.has(callee.text)) ||
          (ts.isPropertyAccessExpression(callee) &&
            ts.isIdentifier(callee.expression) &&
            REQUIRE_LIKE_CALLEES.has(callee.expression.text) &&
            callee.name.text === 'resolve')
        ) {
          const spec = literalArg(node);
          if (spec && (spec.startsWith('./') || spec.startsWith('../'))) {
            if (!resolvesFrom(dir, spec)) {
              report(
                node,
                'unresolvable-relative',
                `'${spec}' does not resolve relative to this file — a module-scoped ` +
                  'require resolves relative specifiers against its OWN URL, not the caller\'s',
              );
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { violations, fileCount: files.length, trees: scannedTrees, suppressions };
}

export function scanAll({ repoRoot = REPO_ROOT, targets } = {}) {
  const resolvedTargets = targets ?? discoverEsmTargets({ repoRoot });
  const violations = [];
  const suppressions = [];
  let fileCount = 0;
  const perPackage = {};
  for (const t of resolvedTargets) {
    const result = scanPackage(join(repoRoot, t), { repoRoot });
    violations.push(...result.violations);
    suppressions.push(...result.suppressions);
    fileCount += result.fileCount;
    perPackage[t] = result.fileCount;
  }
  return {
    violations,
    fileCount,
    perPackage,
    targets: resolvedTargets,
    suppressions,
    trees: PACKAGE_TREES,
  };
}

function main() {
  const asJson = process.argv.includes('--json');
  const { violations, fileCount, targets, suppressions } = scanAll();
  const trees = PACKAGE_TREES.join(' + ');

  if (asJson) {
    process.stdout.write(
      JSON.stringify(
        {
          violations,
          count: violations.length,
          scannedFiles: fileCount,
          targets,
          trees: PACKAGE_TREES,
          suppressions,
        },
        null,
        2,
      ) + '\n',
    );
  } else if (violations.length === 0) {
    console.log(
      `[scan-bare-require] OK — 0 require-boundary violations across ${fileCount} files ` +
        `(${trees}) in ${targets.length} ESM packages` +
        (suppressions.length ? `; ${suppressions.length} justified suppression(s).` : '.'),
    );
  } else {
    console.error(
      `[scan-bare-require] FAIL — ${violations.length} require-boundary violation(s) in ESM package ` +
        `sources (scanned ${fileCount} files [${trees}] in ${targets.length} packages).`,
    );
    console.error(
      '  The global `require` is undefined in an ES module, so these fail at runtime.\n' +
        '  Bind a per-module require and use that:\n' +
        "      import { createRequire } from 'node:module';\n" +
        '      const nodeRequire = createRequire(import.meta.url);\n' +
        '  Do NOT route a relative specifier through a shared helper — it resolves\n' +
        "  against the helper's own module URL, not the caller's.\n",
    );
    for (const v of violations) {
      console.error(`  [${v.kind}] ${v.file}:${v.line}:${v.column}\n      ${v.snippet}`);
      if (v.message) console.error(`      -> ${v.message}`);
    }
  }

  process.exit(violations.length === 0 ? 0 : 1);
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === (await import('node:fs')).realpathSync(process.argv[1]);
if (invokedDirectly) main();
