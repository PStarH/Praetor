#!/usr/bin/env node
/**
 * Architecture V2 gate.
 *
 * Enforces package boundaries and versioning rules from docs/architecture/ ADRs.
 *
 * Run: npx tsx scripts/architecture-gate.ts
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { authoritySignals } from './legacy-authority-inventory';
import { GateConfigError, loadGateConfig, type GateConfig } from './architecture-gate-config';

const ROOT = process.cwd();
const CONFIG_PATH = join(ROOT, 'scripts', 'architecture-gate.config.json');

/**
 * LM-18 step 4: validate the configuration before consuming any of it.
 *
 * The previous `JSON.parse(readFileSync(...)) as GateConfig` accepted any shape.
 * A typo'd key therefore removed a whole gate family while the gate still
 * reported success; an unknown key was accepted in silence.
 */
function loadValidatedConfig(): GateConfig {
  try {
    return loadGateConfig(CONFIG_PATH);
  } catch (err) {
    const detail = err instanceof GateConfigError ? err.message : String(err);
    console.error('Architecture V2 gate configuration invalid:');
    console.error(`  - ${detail}`);
    process.exit(1);
  }
}

const config = loadValidatedConfig();

const failures: string[] = [];

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.turbo', 'coverage']);

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const st = statSync(path);
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(entry)) yield* walk(path);
    } else if (path.endsWith('.ts')) yield path;
  }
}

/**
 * Collect the `.ts` files under `dir`, failing closed when the directory cannot
 * be read.
 *
 * LM-18 step 5. The previous loops wrapped `walk()` in a bare `catch {}` whose
 * only effect was to skip the whole package, so a configured package that did
 * not exist — or one whose tree could not be read — passed the gate in silence.
 * That was reproducible: appending `packages/does-not-exist-xyz` to
 * `v2Packages` still printed "Architecture V2 gate passed." with exit 0.
 *
 * "The directory is not there" is still tolerated as a named outcome, but it is
 * *reported*: a package listed in the config that has no tree means the gate is
 * checking less than the config claims. Every other failure (EACCES, EIO, …)
 * is a hard failure.
 */
function scanDirectory(dir: string, label: string): string[] {
  if (!existsSync(dir)) {
    failures.push(`${label}: ${relative(ROOT, dir) || dir} does not exist — nothing was scanned`);
    return [];
  }
  try {
    return [...walk(dir)];
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? (err as Error).name;
    failures.push(`${label}: could not be scanned (${code}): ${(err as Error).message}`);
    return [];
  }
}

/** Read a source file, reporting an unreadable file instead of throwing. */
function readSource(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? (err as Error).name;
    failures.push(
      `${relative(ROOT, file)}: could not be read (${code}): ${(err as Error).message}`,
    );
    return undefined;
  }
}

/**
 * Every module specifier a file statically references, plus the count of
 * dynamic imports whose specifier is not a string literal.
 */
interface SpecifierScan {
  specifiers: string[];
  unresolvedDynamicImports: number;
}

/**
 * Collect module specifiers from the real syntax tree.
 *
 * LM-18 / MOD-02: the previous implementation was a single regex,
 * `\bfrom\s+['"]<imp>['"]`, which had two defects:
 *   1. It required the specifier to be *exactly* the forbidden string, so
 *      `import '@praetor/core/runtime/agentRuntime'` — a real subpath — passed
 *      the gate even though `@praetor/core/runtime` is on the forbidden list.
 *   2. It matched text in comments and ordinary string literals, so a comment
 *      mentioning a forbidden import was reported as a violation.
 *
 * Reading the AST fixes both and additionally covers `export ... from`,
 * `import x = require(...)`, literal `require(...)` and literal dynamic
 * `import(...)`, none of which the regex covered.
 */
function collectModuleSpecifiers(path: string, content: string): SpecifierScan {
  const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
  const specifiers: string[] = [];
  let unresolvedDynamicImports = 0;

  const addLiteral = (node: ts.Node | undefined): void => {
    if (node && ts.isStringLiteralLike(node)) specifiers.push(node.text);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      addLiteral(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (ts.isExternalModuleReference(node.moduleReference)) {
        addLiteral(node.moduleReference.expression);
      }
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
      const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      if (isRequire || isDynamicImport) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteralLike(arg)) specifiers.push(arg.text);
        else if (isDynamicImport) unresolvedDynamicImports += 1;
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return { specifiers, unresolvedDynamicImports };
}

/**
 * A specifier is forbidden when it *is* the forbidden module or a true
 * subpath of it. A bare string prefix must not match, so that
 * `@praetor/core-extra` is not treated as `@praetor/core`.
 */
function isForbiddenSpecifier(specifier: string, forbidden: string): boolean {
  return specifier === forbidden || specifier.startsWith(`${forbidden}/`);
}

function checkFile(path: string, forbiddenImports: string[]): string[] {
  const content = readFileSync(path, 'utf-8');
  const { specifiers } = collectModuleSpecifiers(path, content);
  const found = new Set<string>();
  for (const specifier of specifiers) {
    for (const forbidden of forbiddenImports) {
      if (isForbiddenSpecifier(specifier, forbidden)) found.add(forbidden);
    }
  }
  return [...found];
}

// Legacy execution is quarantined during the strangler migration. Every file
// that can construct or expose the old AgentRuntime must pass through the
// single guard; otherwise a new route can silently recreate a second
// execution authority.
const legacyExecutionFiles = [
  'apps/api/src/orchestratorEndpoints.ts',
  'apps/api/src/pipelineEndpoints.ts',
];
for (const relativePath of legacyExecutionFiles) {
  const path = join(ROOT, relativePath);
  try {
    const content = readFileSync(path, 'utf-8');
    if (!content.includes('legacyExecutionGuard')) {
      failures.push(`${relativePath} is a legacy execution boundary without legacyExecutionGuard`);
    }
  } catch {
    // A deleted legacy file is acceptable; the route registry must be updated
    // separately if a replacement is introduced.
  }
}

// 1. V2 packages must not import @praetor/core at all.
for (const pkg of config.v2Packages) {
  const pkgDir = join(ROOT, pkg, 'src');
  for (const file of scanDirectory(pkgDir, `v2 package ${pkg}`)) {
    const rel = relative(ROOT, file).replace(/\\/g, '/');
    if (config.v2ImportExceptions.some((ex) => rel === ex || rel.endsWith(`/${ex}`))) continue;
    const bad = checkFile(file, config.forbiddenCoreImports);
    if (bad.length > 0) {
      failures.push(`${rel} imports forbidden @praetor/core modules: ${bad.join(', ')}`);
    }
  }
}

// 2. apps/api legacy files are exempt, but new files must not import core execution/runtime modules.
const apiDir = join(ROOT, config.api.path);
const apiFiles = scanDirectory(apiDir, 'apps/api source tree');

for (const file of apiFiles) {
  const base = relative(apiDir, file).replace(/\\/g, '/');
  const content = readSource(file);
  if (content === undefined) continue;
  const runtimeSignals = authoritySignals(`apps/api/src/${base}`, content).writes;
  if (runtimeSignals.includes('construct:AgentRuntime')) {
    failures.push(`apps/api source ${base} constructs forbidden in-process AgentRuntime`);
  }
  if (config.api.legacyImportExceptions.includes(base)) continue;
  const bad = checkFile(file, config.forbiddenCoreImports);
  if (bad.length > 0) {
    failures.push(
      `apps/api new file ${base} imports forbidden @praetor/core modules: ${bad.join(', ')}`,
    );
  }
}

// 3. Public API routes must be versioned (/v1/* or /v2/*), except legacy exemptions.
for (const file of apiFiles) {
  const base = relative(apiDir, file).replace(/\\/g, '/');
  if (!base.endsWith('.ts')) continue;
  if (base.includes('/') || base.startsWith('v1')) continue;
  if (config.api.unversionedRouteExceptions.includes(base)) continue;
  const content = readSource(file);
  if (content === undefined) continue;
  if (!/\b(?:router|app)\s*\.\s*(?:get|post|put|patch|delete|use|all)\s*\(/.test(content)) {
    continue;
  }
  failures.push(`apps/api public route file ${base} is not versioned under /v1/*`);
}

// 4. New code must not use in-process Map/SQLite as production authority.
function hasInProcessAuthorityMap(path: string, content: string): boolean {
  if (/^\/\*\* Ephemeral[\s\S]*durable[\s\S]*belongs to the kernel/i.test(content)) return false;
  const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'Map'
    ) {
      let parent: ts.Node | undefined = node.parent;
      while (parent) {
        if (ts.isFunctionLike(parent)) return;
        if (ts.isClassLike(parent)) {
          if (parent.name?.text.startsWith('InMemory')) return;
          break;
        }
        parent = parent.parent;
      }
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * True when any *directory* segment of a repo-relative POSIX path is a test
 * directory. The file name itself is excluded, so `src/contest.ts` is not
 * treated as a test file while `test/helpers.ts` is.
 */
function hasTestDirSegment(rel: string): boolean {
  const TEST_DIRS = new Set(['test', 'tests', 'testing', '__tests__', '__test__']);
  return rel
    .split('/')
    .slice(0, -1)
    .some((segment) => TEST_DIRS.has(segment));
}

for (const pkg of [...config.v2Packages, 'apps/api']) {
  const dir = join(ROOT, pkg);
  for (const file of scanDirectory(dir, `in-process authority scan ${pkg}`)) {
    const rel = relative(ROOT, file).replace(/\\/g, '/');
    // Test-only files and trees carry no production authority and are skipped.
    // The original check covered `*.test.*` and `/testing/` but missed sibling
    // conventions, so `apps/api/test/` — a ~100-file test tree — was scanned as
    // production and its explicitly-labelled test double
    // (`test/authRepositories.ts`) was reported as "in-process Map as
    // authority". Match on the *path segment* so every test convention is
    // covered without matching a production file that merely contains the
    // letters, e.g. `contest.ts` or `latest.ts`.
    if (rel.includes('.test.') || rel.includes('.spec.') || hasTestDirSegment(rel)) continue;
    if (config.authorityExceptions.some((ex) => rel === ex || rel.endsWith(`/${ex}`))) continue;
    const apiBase = rel.startsWith('apps/api/src/') ? rel.slice('apps/api/src/'.length) : null;
    const isExistingMigrationException =
      (apiBase !== null && config.api.legacyImportExceptions.includes(apiBase)) ||
      config.v2ImportExceptions.some((ex) => rel === ex || rel.endsWith(`/${ex}`));
    if (isExistingMigrationException) continue;
    const content = readSource(file);
    if (content === undefined) continue;
    if (hasInProcessAuthorityMap(rel, content)) {
      failures.push(`${rel} appears to use in-process Map as authority`);
    }
    if (/better-sqlite3(?!\s*test)/.test(content)) {
      failures.push(`${rel} appears to use better-sqlite3 dependency in production package`);
    }
  }
}

if (failures.length > 0) {
  console.error('Architecture V2 gate failed:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log('Architecture V2 gate passed.');
