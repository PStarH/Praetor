#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

export type AuthorityKind =
  | 'canonical'
  | 'canonical-client'
  | 'read-only-legacy'
  | 'write-capable-legacy'
  | 'write-capable-legacy-client'
  | 'temporary-gate';
export type Disposition = 'retain' | 'migrate-and-delete' | 'migrate-to-readonly' | 'remove';

export interface LegacyAuthorityApproval {
  path: string;
  sourceSha256: string;
  callersSha256: string;
  owner: string;
  reason: string;
  expiresAt: string;
  canonicalReplacement: string;
  disposition: Exclude<Disposition, 'retain'>;
}

export interface InventoryEntry {
  path: string;
  authorityKind: AuthorityKind;
  signals: string[];
  callers: string[];
  sourceSha256: string;
  callersSha256: string;
  writesExternally: boolean;
  owner: string;
  expiresAt: string | null;
  canonicalReplacement: string | null;
  disposition: Disposition;
}

export interface InventoryResult {
  entries: InventoryEntry[];
  unapprovedWriteAuthorities: InventoryEntry[];
  errors: string[];
  passed: boolean;
}

export interface BuildInventoryInput {
  root?: string;
  files?: readonly string[];
  allowlist?: readonly LegacyAuthorityApproval[];
  today?: string;
}

const PRODUCTION_ROOTS = ['apps', 'packages', 'scripts'] as const;
const SOURCE_FILE = /(?:\.(?:c|m)?(?:ts|tsx|js|jsx)|\.py)$/;
const TEST_SUPPORT_DIRECTORY = /(?:^|\/)(?:__tests__|tests?|testing|fixtures)(?:\/|$)/;
const TEST_FILE = /\.(?:test|spec)(?:\.[^.]+)?$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_APPROVAL_DAYS = 180;

const CANONICAL_ENTRYPOINTS = new Map<string, string>([
  ['apps/api/src/v1GatewayEndpoints.ts', '@praetor/api'],
  ['apps/api/src/actionGatewayEndpoints.ts', '@praetor/api'],
  ['apps/api/src/task1ReadinessRuntime.ts', '@praetor/api'],
  ['apps/api/src/v1GatewayKernel.ts', '@praetor/api'],
  ['packages/kernel/src/postgres.ts', '@praetor/kernel'],
  ['packages/kernel/src/sqlite.ts', '@praetor/kernel'],
  ['packages/kernel/src/migrations.ts', '@praetor/kernel'],
  ['packages/kernel/src/capabilityStores.ts', '@praetor/kernel'],
  ['packages/kernel/src/drillWorkload.ts', '@praetor/kernel'],
  ['packages/kernel/src/ops/outbox/postgresOutboxDeliveryPort.ts', '@praetor/kernel'],
  ['packages/kernel/src/seedWorkerClaimSecret.ts', '@praetor/kernel'],
  ['packages/kernel/src/task1LifecycleLedger.ts', '@praetor/kernel'],
  ['packages/kernel/src/task1LifecycleInitialize.ts', '@praetor/kernel'],
  ['packages/kernel/src/task1LifecycleOwnerCommand.ts', '@praetor/kernel'],
  ['packages/kernel/src/task1RolloutProof.ts', '@praetor/kernel'],
  ['packages/kernel/src/task1RolloutProofPostgres.ts', '@praetor/kernel'],
  ['packages/kernel/src/task1TenantContext.ts', '@praetor/kernel'],
  ['packages/effect-broker/src/index.ts', '@praetor/effect-broker'],
  ['packages/effect-broker/src/evidenceSink.ts', '@praetor/effect-broker'],
  ['packages/worker-plane/src/workerService.ts', '@praetor/worker-plane'],
  ['packages/worker-plane/src/bootstrap.ts', '@praetor/worker-plane'],
  ['packages/worker-plane/src/registry.ts', '@praetor/worker-plane'],
  ['packages/adapter-ops/src/wiring.ts', '@praetor/adapter-ops'],
  ['packages/adapter-ops/src/reconciliationDaemon.ts', '@praetor/adapter-ops'],
  ['packages/adapter-ops/src/compensationDaemon.ts', '@praetor/adapter-ops'],
]);

const CANONICAL_SIGNALS = new Map<string, readonly string[]>([
  [
    'apps/api/src/actionGatewayEndpoints.ts',
    [
      'call:requestCompensation',
      'call:requestReconcile',
      'route:POST /:runId/compensations',
      'route:POST /:runId/compensations/:authorizationId/approve',
      'route:POST /:runId/reconcile',
    ],
  ],
  [
    'apps/api/src/task1ReadinessRuntime.ts',
    ['sql:bind_app_tenant_context', 'sql:close_app_tenant_context', 'sql:issue_app_tenant_context'],
  ],
  ['apps/api/src/v1GatewayEndpoints.ts', ['route:POST /runs', 'route:POST /runs/:runId/${verb}']],
  [
    'apps/api/src/v1GatewayKernel.ts',
    ['call:createRun', 'call:requestCompensation', 'call:requestReconcile'],
  ],
  [
    'packages/kernel/src/postgres.ts',
    [
      'call:appendEvent',
      'sql-write:DELETE commander_action_kill_switches',
      'sql-write:DELETE commander_outbox_dlq',
      'sql-write:INSERT commander_action_kill_switches',
      'sql-write:INSERT commander_capability_replays',
      'sql-write:INSERT commander_capability_revocations',
      'sql-write:INSERT commander_effect_allowlist',
      'sql-write:INSERT commander_effect_quota',
      'sql-write:INSERT commander_effects',
      'sql-write:INSERT commander_events',
      'sql-write:INSERT commander_interactions',
      'sql-write:INSERT commander_outbox',
      'sql-write:INSERT commander_outbox_dlq',
      'sql-write:INSERT commander_runs',
      'sql-write:INSERT commander_steps',
      'sql-write:INSERT commander_tenant_execution_control',
      'sql-write:INSERT commander_tenant_execution_limits',
      'sql-write:INSERT commander_tenant_execution_usage',
      'sql-write:INSERT commander_timers',
      'sql-write:UPDATE commander_effects',
      'sql-write:UPDATE commander_interactions',
      'sql-write:UPDATE commander_outbox',
      'sql-write:UPDATE commander_runs',
      'sql-write:UPDATE commander_steps',
      'sql-write:UPDATE commander_tenant_execution_usage',
      'sql-write:UPDATE commander_timers',
    ],
  ],
  [
    'packages/kernel/src/sqlite.ts',
    [
      'call:admitEffect',
      'call:appendEvent',
      'sql-write:INSERT commander_effects',
      'sql-write:INSERT commander_events',
      'sql-write:INSERT commander_outbox',
      'sql-write:INSERT commander_runs',
      'sql-write:INSERT commander_steps',
      'sql-write:INSERT commander_worker_claim_secrets',
      'sql-write:INSERT commander_workers',
      'sql-write:UPDATE commander_effects',
      'sql-write:UPDATE commander_outbox',
      'sql-write:UPDATE commander_runs',
      'sql-write:UPDATE commander_steps',
      'sql-write:UPDATE commander_tenant_execution_usage',
      'sql-write:UPDATE commander_timers',
    ],
  ],
  ['packages/kernel/src/migrations.ts', ['sql-write:INSERT commander_kernel_migrations']],
  ['packages/kernel/src/capabilityStores.ts', ['call:revokeCapability']],
  ['packages/kernel/src/drillWorkload.ts', ['call:createRun']],
  [
    'packages/kernel/src/ops/outbox/postgresOutboxDeliveryPort.ts',
    [
      'sql-write:INSERT commander_outbox_deliveries',
      'sql-write:UPDATE commander_outbox_deliveries',
    ],
  ],
  [
    'packages/kernel/src/seedWorkerClaimSecret.ts',
    [
      'sql-write:INSERT commander_effect_allowlist',
      'sql-write:INSERT commander_worker_allowed_tenants',
      'sql-write:INSERT commander_worker_claim_secrets',
    ],
  ],
  [
    'packages/kernel/src/task1LifecycleInitialize.ts',
    [
      'authority:initializeTask1LifecycleBoundary',
      'sql-write:INSERT commander_kernel_migrations',
      'sql-write:INSERT commander_tenant_cutover_state',
    ],
  ],
  [
    'packages/kernel/src/task1LifecycleLedger.ts',
    [
      'call:appendOperation',
      'sql-write:INSERT commander_tenant_cutover_operations',
      'sql-write:UPDATE commander_tenant_cutover_state',
    ],
  ],
  ['packages/kernel/src/task1LifecycleOwnerCommand.ts', ['authority:runTask1OwnerCommand']],
  ['packages/kernel/src/task1RolloutProof.ts', ['call:appendProof']],
  [
    'packages/kernel/src/task1RolloutProofPostgres.ts',
    ['sql-write:INSERT commander_tenant_cutover_rollout_proofs'],
  ],
  [
    'packages/kernel/src/task1TenantContext.ts',
    ['sql:bind_app_tenant_context', 'sql:close_app_tenant_context', 'sql:issue_app_tenant_context'],
  ],
  [
    'packages/effect-broker/src/index.ts',
    ['call:admitEffect', 'call:completeEffect', 'call:failEffect'],
  ],
  ['packages/effect-broker/src/evidenceSink.ts', ['call:appendEvidence']],
  ['packages/worker-plane/src/workerService.ts', []],
  ['packages/worker-plane/src/bootstrap.ts', ['call:admitEffect', 'call:completeEffect']],
  ['packages/worker-plane/src/registry.ts', ['sql-write:UPDATE commander_workers']],
  [
    'packages/adapter-ops/src/wiring.ts',
    ['call:admitEffect', 'call:completeEffect', 'call:failEffect'],
  ],
  ['packages/adapter-ops/src/reconciliationDaemon.ts', ['call:claimReconcileEffects']],
  ['packages/adapter-ops/src/compensationDaemon.ts', []],
]);

const CANONICAL_CLIENT_ENTRYPOINTS = new Map<string, string>([
  ['apps/web/src/pages/ActionsPage.tsx', '@praetor/web'],
  ['scripts/l4-b-adapter-chaos.ts', 'repository-proofs'],
  ['scripts/l4-b-cell-reconciliation-e2e.ts', 'repository-proofs'],
]);

const CANONICAL_CLIENT_SIGNALS = new Map<string, readonly string[]>([
  ['apps/web/src/pages/ActionsPage.tsx', ['call:requestCompensation']],
  ['scripts/l4-b-adapter-chaos.ts', ['call:createRun', 'call:requestReconcile']],
  [
    'scripts/l4-b-cell-reconciliation-e2e.ts',
    ['call:admitEffect', 'call:claimReconcileEffects', 'call:createRun', 'call:requestReconcile'],
  ],
]);

const TEMPORARY_GATES = new Map<string, string>([
  ['apps/api/src/legacyExecutionGuard.ts', '@praetor/api'],
  ['scripts/architecture-gate.ts', 'repository'],
  ['scripts/legacy-authority-inventory.ts', 'repository'],
]);

const READ_ONLY_ENTRYPOINTS = new Map<string, string>([
  ['apps/web/src/hooks/useWarRoom.ts', '@praetor/web'],
]);

const CONSTRUCTORS = new Set([
  'AgentRuntime',
  'UltimateOrchestrator',
  'TELOSOrchestrator',
  'RunLedger',
  'WarRoomStore',
  'SqliteWarRoomStore',
]);

const MUTATION_METHODS = new Set([
  'admitEffect',
  'appendEvidence',
  'appendEvent',
  'appendOperation',
  'appendProof',
  'approveMission',
  'claimCompensations',
  'claimReconcileEffects',
  'claimRunnableRun',
  'completeCompensation',
  'completeEffect',
  'completeRun',
  'createApproval',
  'createEffect',
  'createMission',
  'createRun',
  'failEffect',
  'markEffectUnknown',
  'requestCompensation',
  'requestReconcile',
  'revokeCapability',
  'scheduleAction',
  'transitionRun',
  'updateMissionStatus',
]);

const READ_METHODS = new Set([
  'fetchWarRoomSnapshot',
  'getRuntimeStats',
  'getTenantRunDurations',
  'listModels',
]);

const AUTHORITY_ROUTE =
  /(?:^|\/)(?:v\d+\/)?(?:runs?|missions?|effects?|approvals?|evidence|reconcile|compensations?)(?:\/|$)/i;
const MUTATING_HTTP_METHODS = new Set(['post', 'put', 'patch', 'delete']);
const SQL_EXECUTION_METHODS = new Set(['exec', 'execute', 'prepare', 'query']);
const LEGACY_AUTHORITY_TABLES = new Set([
  'approvals',
  'effects',
  'evidence',
  'interactions',
  'missions',
  'runs',
  'steps',
]);
const COMMANDER_AUTHORITY_TABLES = new Set([
  'commander_action_kill_switches',
  'commander_capability_replays',
  'commander_capability_revocations',
  'commander_effect_allowlist',
  'commander_effect_quota',
  'commander_effects',
  'commander_events',
  'commander_interactions',
  'commander_kernel_migrations',
  'commander_outbox',
  'commander_outbox_deliveries',
  'commander_outbox_dlq',
  'commander_runs',
  'commander_steps',
  'commander_tenant_execution_control',
  'commander_tenant_execution_limits',
  'commander_tenant_execution_usage',
  'commander_timers',
  'commander_worker_allowed_tenants',
  'commander_worker_claim_secrets',
  'commander_workers',
]);
const AUTHORITY_FUNCTIONS = new Set(['initializeTask1LifecycleBoundary', 'runTask1OwnerCommand']);
const AUTHORITY_SQL_FUNCTIONS = [
  'bind_app_tenant_context',
  'close_app_tenant_context',
  'issue_app_tenant_context',
  'set_legacy_tenant_scope',
] as const;

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '');
}

export function isProductionSourcePath(path: string): boolean {
  const normalized = normalizePath(path);
  return (
    PRODUCTION_ROOTS.some((root) => normalized.startsWith(`${root}/`)) &&
    SOURCE_FILE.test(normalized) &&
    !TEST_SUPPORT_DIRECTORY.test(normalized) &&
    !TEST_FILE.test(normalized)
  );
}

function hash(source: string): string {
  return createHash('sha256').update(source).digest('hex');
}

function hashCallers(callers: readonly string[], sources: ReadonlyMap<string, string>): string {
  return hash(
    JSON.stringify(
      callers.map((path) => ({
        path,
        sourceSha256: hash(sources.get(path) ?? ''),
      })),
    ),
  );
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function propertyName(
  expression: ts.Expression,
  file?: ts.SourceFile,
  constStrings: ReadonlyMap<string, string> = new Map(),
): string | undefined {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression) && expression.argumentExpression) {
    return file
      ? expressionText(expression.argumentExpression, file, constStrings)
      : ts.isStringLiteralLike(expression.argumentExpression)
        ? expression.argumentExpression.text
        : undefined;
  }
  return undefined;
}

function expressionText(
  expression: ts.Expression | undefined,
  file: ts.SourceFile,
  constStrings: ReadonlyMap<string, string>,
): string | undefined {
  if (!expression) return undefined;
  if (ts.isStringLiteralLike(expression)) return expression.text;
  if (ts.isParenthesizedExpression(expression)) {
    return expressionText(expression.expression, file, constStrings);
  }
  if (ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)) {
    return expressionText(expression.expression, file, constStrings);
  }
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = expressionText(expression.left, file, constStrings);
    const right = expressionText(expression.right, file, constStrings);
    return left === undefined || right === undefined ? undefined : `${left}${right}`;
  }
  if (ts.isTemplateExpression(expression)) {
    return (
      expression.head.text +
      expression.templateSpans
        .map((span) => `\${${span.expression.getText(file)}}${span.literal.text}`)
        .join('')
    );
  }
  if (ts.isIdentifier(expression)) return constStrings.get(expression.text);
  return undefined;
}

function routePath(
  node: ts.CallExpression,
  file: ts.SourceFile,
  constStrings: ReadonlyMap<string, string>,
): string | undefined {
  if (
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isCallExpression(node.expression.expression) &&
    propertyName(node.expression.expression.expression) === 'route'
  ) {
    return expressionText(node.expression.expression.arguments[0], file, constStrings);
  }
  return expressionText(node.arguments[0], file, constStrings);
}

function requestMethod(
  expression: ts.Expression | undefined,
  file: ts.SourceFile,
  constStrings: ReadonlyMap<string, string>,
  constExpressions: ReadonlyMap<string, ts.Expression>,
): string | undefined {
  if (expression && ts.isIdentifier(expression)) {
    return requestMethod(
      constExpressions.get(expression.text),
      file,
      constStrings,
      constExpressions,
    );
  }
  if (!expression || !ts.isObjectLiteralExpression(expression)) return undefined;
  for (const property of expression.properties) {
    if (
      ts.isPropertyAssignment(property) &&
      ((ts.isIdentifier(property.name) && property.name.text === 'method') ||
        (ts.isStringLiteralLike(property.name) && property.name.text === 'method'))
    ) {
      return expressionText(property.initializer, file, constStrings)?.toLowerCase();
    }
  }
  return undefined;
}

function pythonAuthoritySignals(source: string): { writes: string[]; reads: string[] } {
  const writes = new Set<string>();
  const request =
    /\b(?:self\.)?_request\s*\(\s*[furbFURB]*(['"])(POST|PUT|PATCH|DELETE)\1\s*,\s*[furbFURB]*(['"])(.*?)\3/gs;
  for (const match of source.matchAll(request)) {
    const method = match[2]?.toUpperCase();
    const path = match[4];
    if (method && path) writes.add(`http:${method} ${path}`);
  }
  return { writes: [...writes].sort(), reads: [] };
}

function sqlWriteSignals(sql: string): string[] {
  const signals = new Set<string>();
  const mutation =
    /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:ONLY\s+)?(?:(?:"?[A-Za-z_][\w$]*"?)\.)?"?([A-Za-z_][\w$]*)"?/gi;
  for (const match of sql.matchAll(mutation)) {
    const operation = match[1]?.replace(/\s+/g, ' ').split(' ')[0]?.toUpperCase();
    const table = match[2]?.toLowerCase();
    if (!operation || !table) continue;
    if (
      COMMANDER_AUTHORITY_TABLES.has(table) ||
      table.startsWith('commander_tenant_cutover_') ||
      LEGACY_AUTHORITY_TABLES.has(table)
    ) {
      signals.add(`sql-write:${operation} ${table}`);
    }
  }
  return [...signals];
}

function isConstDeclaration(node: ts.VariableDeclaration): boolean {
  return (
    ts.isVariableDeclarationList(node.parent) && (node.parent.flags & ts.NodeFlags.Const) !== 0
  );
}

function recordAuthorityAliases(node: ts.VariableDeclaration, aliases: Map<string, string>): void {
  if (!isConstDeclaration(node)) return;
  if (ts.isIdentifier(node.name) && node.initializer) {
    const name = propertyName(node.initializer);
    if (name && MUTATION_METHODS.has(name)) aliases.set(node.name.text, name);
    return;
  }
  if (!ts.isObjectBindingPattern(node.name)) return;
  for (const element of node.name.elements) {
    if (!ts.isIdentifier(element.name)) continue;
    const sourceName = element.propertyName
      ? ts.isIdentifier(element.propertyName) || ts.isStringLiteralLike(element.propertyName)
        ? element.propertyName.text
        : undefined
      : element.name.text;
    if (sourceName && MUTATION_METHODS.has(sourceName)) aliases.set(element.name.text, sourceName);
  }
}

export function authoritySignals(
  path: string,
  source: string,
): { writes: string[]; reads: string[] } {
  if (path.endsWith('.py')) return pythonAuthoritySignals(source);
  const scriptKind = path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKind);
  const writes = new Set<string>();
  const reads = new Set<string>();
  const aliases = new Map<string, string>();
  const constStrings = new Map<string, string>();
  const constExpressions = new Map<string, ts.Expression>();
  const constructorAliases = new Map<string, string>();

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && isConstDeclaration(node)) {
      recordAuthorityAliases(node, aliases);
      if (ts.isIdentifier(node.name)) {
        if (node.initializer) constExpressions.set(node.name.text, node.initializer);
        const value = expressionText(node.initializer, file, constStrings);
        if (value !== undefined) constStrings.set(node.name.text, value);
      }
    }
    if (ts.isImportDeclaration(node) && node.importClause?.namedBindings) {
      const bindings = node.importClause.namedBindings;
      if (ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const importedName = element.propertyName?.text ?? element.name.text;
          if (CONSTRUCTORS.has(importedName))
            constructorAliases.set(element.name.text, importedName);
        }
      }
    }
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      (CONSTRUCTORS.has(node.expression.text) || constructorAliases.has(node.expression.text))
    ) {
      writes.add(
        `construct:${constructorAliases.get(node.expression.text) ?? node.expression.text}`,
      );
    }
    if (ts.isFunctionDeclaration(node) && node.name && AUTHORITY_FUNCTIONS.has(node.name.text)) {
      writes.add(`authority:${node.name.text}`);
    }
    if (
      path !== 'scripts/legacy-authority-inventory.ts' &&
      (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node))
    ) {
      const value = expressionText(node, file, constStrings);
      if (value) {
        for (const functionName of AUTHORITY_SQL_FUNCTIONS) {
          if (value.includes(functionName)) writes.add(`sql:${functionName}`);
        }
      }
    }
    if (ts.isCallExpression(node)) {
      const directName = propertyName(node.expression, file, constStrings);
      const name =
        directName ??
        (ts.isIdentifier(node.expression) ? aliases.get(node.expression.text) : undefined);
      if (name && MUTATION_METHODS.has(name)) writes.add(`call:${name}`);
      if (name === 'execute' && /^apps\/api\/src\/[^/]*Endpoints\.tsx?$/.test(path)) {
        writes.add('call:executeRuntime');
      }
      if (name && READ_METHODS.has(name)) reads.add(`call:${name}`);
      if (name && MUTATING_HTTP_METHODS.has(name)) {
        const pathValue = routePath(node, file, constStrings);
        if (pathValue && AUTHORITY_ROUTE.test(pathValue))
          writes.add(`route:${name.toUpperCase()} ${pathValue}`);
      }
      if (name && SQL_EXECUTION_METHODS.has(name)) {
        const sql = expressionText(node.arguments[0], file, constStrings);
        if (sql) {
          for (const signal of sqlWriteSignals(sql)) writes.add(signal);
        }
      }
      const callee = ts.isIdentifier(node.expression) ? node.expression.text : directName;
      if (callee === 'fetch' || callee === 'apiFetch') {
        const requestExpression = node.arguments[0];
        const requestConstructor =
          requestExpression &&
          ts.isNewExpression(requestExpression) &&
          ts.isIdentifier(requestExpression.expression) &&
          requestExpression.expression.text === 'Request'
            ? requestExpression
            : undefined;
        const method = requestMethod(
          requestConstructor?.arguments?.[1] ?? node.arguments[1],
          file,
          constStrings,
          constExpressions,
        );
        const pathValue = expressionText(
          requestConstructor?.arguments?.[0] ?? requestExpression,
          file,
          constStrings,
        );
        if (
          method &&
          MUTATING_HTTP_METHODS.has(method) &&
          pathValue &&
          AUTHORITY_ROUTE.test(pathValue)
        ) {
          writes.add(`http:${method.toUpperCase()} ${pathValue}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { writes: [...writes].sort(), reads: [...reads].sort() };
}

function productionFiles(root: string): string[] {
  const output = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ...PRODUCTION_ROOTS],
    { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  return output
    .split('\0')
    .filter(Boolean)
    .map(normalizePath)
    .filter(isProductionSourcePath)
    .filter((path) => existsSync(join(root, path)))
    .sort();
}

function relativeImports(path: string, source: string, candidates: ReadonlySet<string>): string[] {
  if (path.endsWith('.py')) return [];
  const callers: string[] = [];
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const directory = dirname(path);
  const visit = (node: ts.Node): void => {
    let specifier: string | undefined;
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifier = node.moduleSpecifier.text;
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      ((ts.isIdentifier(node.expression) && node.expression.text === 'require') ||
        node.expression.kind === ts.SyntaxKind.ImportKeyword)
    ) {
      specifier = node.arguments[0].text;
    }
    if (specifier?.startsWith('.')) {
      const base = normalizePath(join(directory, specifier));
      const sourceBase = base.replace(/\.(?:c|m)?js$/, '');
      for (const prefix of new Set([base, sourceBase])) {
        for (const suffix of ['', '.ts', '.tsx', '.js', '.mjs', '/index.ts', '/index.tsx']) {
          const candidate = normalizePath(`${prefix}${suffix}`);
          if (candidates.has(candidate)) callers.push(candidate);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...new Set(callers)].sort();
}

function isIsoCalendarDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function validApproval(approval: LegacyAuthorityApproval, today: string): boolean {
  const approvalDate = new Date(`${approval?.expiresAt}T00:00:00.000Z`);
  const todayDate = new Date(`${today}T00:00:00.000Z`);
  const reviewWindowMs = MAX_APPROVAL_DAYS * 24 * 60 * 60 * 1000;
  return Boolean(
    approval &&
    typeof approval.path === 'string' &&
    approval.path.trim() === approval.path &&
    approval.path.length > 0 &&
    SHA256.test(approval.sourceSha256) &&
    SHA256.test(approval.callersSha256) &&
    typeof approval.owner === 'string' &&
    approval.owner.trim() === approval.owner &&
    approval.owner.length > 0 &&
    typeof approval.reason === 'string' &&
    approval.reason.trim() === approval.reason &&
    approval.reason.length >= 10 &&
    isIsoCalendarDate(approval.expiresAt) &&
    isIsoCalendarDate(today) &&
    approvalDate.valueOf() >= todayDate.valueOf() &&
    approvalDate.valueOf() - todayDate.valueOf() <= reviewWindowMs &&
    typeof approval.canonicalReplacement === 'string' &&
    approval.canonicalReplacement.trim() === approval.canonicalReplacement &&
    approval.canonicalReplacement.length > 0 &&
    ['migrate-and-delete', 'migrate-to-readonly', 'remove'].includes(approval.disposition),
  );
}

function loadAllowlist(root: string): LegacyAuthorityApproval[] {
  const parsed = JSON.parse(
    readFileSync(join(root, 'scripts/fixtures/legacy-authorities.json'), 'utf8'),
  ) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('LEGACY_AUTHORITY_ALLOWLIST_INVALID');
  }
  const value = parsed as { schema?: unknown; entries?: unknown };
  if (value.schema !== 'legacy-authority-allowlist/v2' || !Array.isArray(value.entries)) {
    throw new Error('LEGACY_AUTHORITY_ALLOWLIST_INVALID');
  }
  return value.entries as LegacyAuthorityApproval[];
}

function isCanonicalClientSignal(signal: string): boolean {
  if (!signal.startsWith('http:')) return false;
  const separator = signal.indexOf(' ');
  if (separator < 0) return false;
  const path = signal.slice(separator + 1);
  return /(?:^|\})\/v1\/(?:runs|actions)(?:\/|$)/.test(path);
}

export function buildInventory(input: BuildInventoryInput = {}): InventoryResult {
  const root = resolve(input.root ?? process.cwd());
  const files = [...new Set((input.files ?? productionFiles(root)).map(normalizePath))].sort();
  const fileSet = new Set(files);
  const allowlist = [...(input.allowlist ?? loadAllowlist(root))];
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  const errors = new Set<string>();
  const approvalByPath = new Map<string, LegacyAuthorityApproval>();

  for (const approval of allowlist) {
    if (!validApproval(approval, today)) {
      errors.add(`Invalid legacy authority approval: ${String(approval?.path ?? '(unknown)')}`);
      continue;
    }
    const path = normalizePath(approval.path);
    if (approvalByPath.has(path)) errors.add(`Duplicate legacy authority approval: ${path}`);
    if (CANONICAL_ENTRYPOINTS.has(path))
      errors.add(`Canonical authority cannot be allowlisted: ${path}`);
    if (CANONICAL_CLIENT_ENTRYPOINTS.has(path))
      errors.add(`Canonical client cannot be allowlisted: ${path}`);
    if (approval.expiresAt < today) errors.add(`Expired legacy authority approval: ${path}`);
    approvalByPath.set(path, { ...approval, path });
  }

  const sources = new Map<string, string>();
  for (const path of files) {
    try {
      sources.set(path, readFileSync(join(root, path), 'utf8'));
    } catch {
      errors.add(`Unreadable production source: ${path}`);
    }
  }

  const importers = new Map<string, string[]>();
  for (const [path, source] of sources) {
    for (const imported of relativeImports(path, source, fileSet)) {
      const callers = importers.get(imported) ?? [];
      callers.push(path);
      importers.set(imported, callers);
    }
  }

  const entries: InventoryEntry[] = [];
  for (const [path, source] of sources) {
    const signals = authoritySignals(path, source);
    const canonicalOwner = CANONICAL_ENTRYPOINTS.get(path);
    const canonicalClientOwner = CANONICAL_CLIENT_ENTRYPOINTS.get(path);
    const approval = approvalByPath.get(path);
    let authorityKind: AuthorityKind | undefined;
    let owner = '';
    let expiresAt: string | null = null;
    let replacement: string | null = null;
    let disposition: Disposition = 'retain';
    let relevantSignals = signals.writes;

    if (canonicalOwner) {
      authorityKind = 'canonical';
      owner = canonicalOwner;
      const expectedSignals = CANONICAL_SIGNALS.get(path);
      if (!expectedSignals || !sameStrings(signals.writes, expectedSignals)) {
        errors.add(`Canonical authority signals changed: ${path}`);
      }
    } else if (canonicalClientOwner) {
      authorityKind = 'canonical-client';
      owner = canonicalClientOwner;
      const expectedSignals = CANONICAL_CLIENT_SIGNALS.get(path);
      if (!expectedSignals || !sameStrings(signals.writes, expectedSignals)) {
        errors.add(`Canonical client signals changed: ${path}`);
      }
    } else if (
      signals.writes.length > 0 &&
      signals.writes.every((signal) => isCanonicalClientSignal(signal))
    ) {
      authorityKind = 'canonical-client';
      owner = 'canonical product client';
    } else if (signals.writes.length > 0) {
      const clientOnly = signals.writes.every((signal) => signal.startsWith('http:'));
      authorityKind = clientOnly ? 'write-capable-legacy-client' : 'write-capable-legacy';
      owner = approval?.owner ?? 'unapproved';
      expiresAt = approval?.expiresAt ?? null;
      replacement = approval?.canonicalReplacement ?? null;
      disposition = approval?.disposition ?? 'migrate-and-delete';
    } else if (TEMPORARY_GATES.has(path)) {
      authorityKind = 'temporary-gate';
      owner = TEMPORARY_GATES.get(path)!;
      disposition = 'remove';
      relevantSignals = ['gate'];
    } else if (approval) {
      // Keep hash-bound legacy approvals visible even when static signal
      // extraction cannot recognize the source's write mechanism.
      authorityKind = 'write-capable-legacy';
      owner = approval.owner;
      expiresAt = approval.expiresAt;
      replacement = approval.canonicalReplacement;
      disposition = approval.disposition;
      relevantSignals = ['allowlist-only'];
    } else if (signals.reads.length > 0 || READ_ONLY_ENTRYPOINTS.has(path)) {
      authorityKind = 'read-only-legacy';
      owner = READ_ONLY_ENTRYPOINTS.get(path) ?? 'legacy projection';
      disposition = 'migrate-to-readonly';
      relevantSignals = signals.reads.length > 0 ? signals.reads : ['projection'];
    } else {
      continue;
    }

    const callers = [...new Set(importers.get(path) ?? [])].sort();
    const entry: InventoryEntry = {
      path,
      authorityKind,
      signals: relevantSignals,
      callers,
      sourceSha256: hash(source),
      callersSha256: hashCallers(callers, sources),
      writesExternally:
        signals.writes.length > 0 ||
        (Boolean(approval) && authorityKind === 'write-capable-legacy'),
      owner,
      expiresAt,
      canonicalReplacement: replacement,
      disposition,
    };
    entries.push(entry);

    if (approval) {
      if (authorityKind === 'canonical-client') {
        errors.add(`Canonical client cannot be allowlisted: ${path}`);
      }
      if (approval.sourceSha256 !== entry.sourceSha256) {
        errors.add(`Legacy authority source changed: ${path}`);
      }
      if (approval.callersSha256 !== entry.callersSha256) {
        errors.add(`Legacy authority callers changed: ${path}`);
      }
    }
  }

  for (const path of approvalByPath.keys()) {
    if (!sources.has(path)) errors.add(`Stale legacy authority approval: ${path}`);
  }

  entries.sort((left, right) => left.path.localeCompare(right.path));
  const unapprovedWriteAuthorities = entries.filter(
    (entry) =>
      (entry.authorityKind === 'write-capable-legacy' ||
        entry.authorityKind === 'write-capable-legacy-client') &&
      !approvalByPath.has(entry.path),
  );
  for (const entry of unapprovedWriteAuthorities) {
    errors.add(`Unapproved write-capable legacy authority: ${entry.path}`);
  }
  const sortedErrors = [...errors].sort();
  return {
    entries,
    unapprovedWriteAuthorities,
    errors: sortedErrors,
    passed: sortedErrors.length === 0,
  };
}

function formatText(result: InventoryResult): string {
  const lines = [
    `Legacy Authority Inventory - ${result.passed ? 'PASS' : 'FAIL'}`,
    `Entries: ${result.entries.length}`,
  ];
  for (const error of result.errors) lines.push(`ERROR ${error}`);
  for (const entry of result.entries) {
    lines.push(`${entry.authorityKind}\t${entry.path}\t${entry.sourceSha256}`);
  }
  return lines.join('\n');
}

function main(): void {
  try {
    const result = buildInventory();
    const json =
      process.argv.includes('--format=json') ||
      process.argv[process.argv.indexOf('--format') + 1] === 'json';
    process.stdout.write(`${json ? JSON.stringify(result, null, 2) : formatText(result)}\n`);
    if (!result.passed) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'LEGACY_AUTHORITY_GATE_FAILED'}\n`,
    );
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
