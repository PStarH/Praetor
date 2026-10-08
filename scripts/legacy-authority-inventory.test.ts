import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  authoritySignals,
  buildInventory,
  isProductionSourcePath,
} from './legacy-authority-inventory.js';

function sha256(source: string): string {
  return createHash('sha256').update(source).digest('hex');
}

function callersSha256(callers: Readonly<Record<string, string>>): string {
  return sha256(
    JSON.stringify(
      Object.entries(callers)
        .map(([path, source]) => ({ path, sourceSha256: sha256(source) }))
        .sort((left, right) => left.path.localeCompare(right.path)),
    ),
  );
}

function fixtureRoot(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'legacy-authority-inventory-'));
  for (const [path, source] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, source);
  }
  return root;
}

describe('legacy authority inventory gate', () => {
  it('passes against the hash-bound repository approval fixture', () => {
    const result = buildInventory();
    assert.equal(result.passed, true, result.errors.join('\n'));
    assert.equal(result.unapprovedWriteAuthorities.length, 0);
    for (const path of [
      'packages/effect-broker/src/evidenceSink.ts',
      'apps/web/src/pages/ActionsPage.tsx',
      'scripts/l4-b-adapter-chaos.ts',
      'scripts/l4-b-cell-reconciliation-e2e.ts',
    ]) {
      const entry = result.entries.find((candidate) => candidate.path === path);
      assert.ok(entry, `missing inventory entry for ${path}`);
      assert.equal(entry.writesExternally, true);
      assert.ok(
        entry.authorityKind === 'canonical' || entry.authorityKind === 'canonical-client',
        `${path} must be canonical`,
      );
    }
  });

  it('is wired into the local and CI deployment gate command', () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const ci = readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
    assert.match(
      packageJson.scripts['authority:inventory'] ?? '',
      /legacy-authority-inventory\.ts/,
    );
    assert.match(
      packageJson.scripts['authority:inventory:test'] ?? '',
      /legacy-authority-inventory\.test\.ts/,
    );
    assert.match(packageJson.scripts['test:deploy-gates'] ?? '', /authority:inventory/);
    assert.match(ci, /run:\s*pnpm test:deploy-gates/);
  });

  it('excludes test support while retaining executable repository scripts', () => {
    assert.equal(isProductionSourcePath('packages/core/tests/runtime/e2eTestHelpers.ts'), false);
    assert.equal(
      isProductionSourcePath('packages/kernel/src/testing/repositoryContract.ts'),
      false,
    );
    assert.equal(isProductionSourcePath('packages/kernel/src/foo.integration.test.ts'), false);
    assert.equal(isProductionSourcePath('scripts/demo-qa/test-provider-fallback.ts'), true);
    assert.equal(isProductionSourcePath('scripts/authority-closure-proof.ts'), true);
    assert.equal(isProductionSourcePath('packages/python-sdk/src/commander/_client.py'), true);
  });

  it('matches authority route segments without treating runtime as run', () => {
    assert.deepEqual(
      authoritySignals('apps/api/src/pause.ts', 'router.post("/runtime/pause", handler);'),
      { writes: [], reads: [] },
    );
    assert.deepEqual(
      authoritySignals('apps/api/src/runs.ts', 'router.post("/v1/runs/:runId/reconcile", handler);')
        .writes,
      ['route:POST /v1/runs/:runId/reconcile'],
    );
  });

  it('tracks aliased and destructured authority methods', () => {
    const source = `
const create = repository.createRun;
const { approveMission, transitionRun: transition } = repository;
create({});
approveMission({});
transition({});
`;
    assert.deepEqual(authoritySignals('apps/api/src/aliases.ts', source).writes, [
      'call:approveMission',
      'call:createRun',
      'call:transitionRun',
    ]);
  });

  it('tracks const route bindings and route().post chains', () => {
    const source = `
const runPath = '/v1/runs';
router.post(runPath, handler);
router.route('/v1/missions/:missionId/approve').post(handler);
`;
    assert.deepEqual(authoritySignals('apps/api/src/routes.ts', source).writes, [
      'route:POST /v1/missions/:missionId/approve',
      'route:POST /v1/runs',
    ]);
  });

  it('tracks mutating fetch and apiFetch requests', () => {
    const source = `
apiFetch(\`/projects/\${PROJECT_ID}/missions\`, { method: 'POST' });
fetch(\`\${API_BASE}/missions/\${missionId}\`, { method: 'PATCH' });
`;
    assert.deepEqual(authoritySignals('apps/web/src/api.ts', source).writes, [
      'http:PATCH ${API_BASE}/missions/${missionId}',
      'http:POST /projects/${PROJECT_ID}/missions',
    ]);
  });

  it('tracks constructor aliases, computed properties, and composed route paths', () => {
    const source = `
import { AgentRuntime as Runtime } from '@praetor/core';
const base = '/v1';
const suffix = '/runs';
new Runtime();
repository['create' + 'Run']({});
router.post(base + suffix, handler);
`;
    assert.deepEqual(authoritySignals('apps/api/src/indirect.ts', source).writes, [
      'call:createRun',
      'construct:AgentRuntime',
      'route:POST /v1/runs',
    ]);
  });

  it('tracks fetch options variables and Request construction', () => {
    const source = `
const options = { method: 'POST' };
fetch('/v1/runs', options);
fetch(new Request('/v1/runs/abc/reconcile', { method: 'PATCH' }));
`;
    assert.deepEqual(authoritySignals('apps/web/src/indirect.ts', source).writes, [
      'http:PATCH /v1/runs/abc/reconcile',
      'http:POST /v1/runs',
    ]);
  });

  it('classifies API endpoint runtime execution as a write authority', () => {
    const source = `
import { getRuntime } from './sharedRuntime.js';
router.post('/api/chat', async () => (await getRuntime()).execute({}));
`;
    assert.deepEqual(authoritySignals('apps/api/src/chatEndpoints.ts', source).writes, [
      'call:executeRuntime',
    ]);
  });

  it('tracks mutating Python SDK requests', () => {
    const source = `
await self._request("POST", "/api/runtime/execute", json=body)
await self._request("GET", "/api/runtime/active")
`;
    assert.deepEqual(
      authoritySignals('packages/python-sdk/src/commander/_client.py', source).writes,
      ['http:POST /api/runtime/execute'],
    );
  });

  it('tracks direct SQL writes to lifecycle authority tables', () => {
    const source = `
const insertRun = 'INSERT INTO commander_runs (id) VALUES ($1)';
await pool.query(insertRun, [runId]);
db.prepare('UPDATE commander_effects SET state = ? WHERE id = ?').run(state, effectId);
await client.execute(\`DELETE FROM commander_tenant_cutover_rollout_proofs WHERE tenant_id = \${tenantId}\`);
await pool.query('SELECT * FROM commander_runs');
`;
    assert.deepEqual(authoritySignals('apps/api/src/directSql.ts', source).writes, [
      'sql-write:DELETE commander_tenant_cutover_rollout_proofs',
      'sql-write:INSERT commander_runs',
      'sql-write:UPDATE commander_effects',
    ]);
  });

  it('recognizes production Task1 authority entrypoints', () => {
    const root = process.cwd();
    const expected = new Map([
      ['apps/api/src/task1ReadinessRuntime.ts', 'sql:issue_app_tenant_context'],
      [
        'packages/kernel/src/task1LifecycleInitialize.ts',
        'authority:initializeTask1LifecycleBoundary',
      ],
      ['packages/kernel/src/task1LifecycleOwnerCommand.ts', 'authority:runTask1OwnerCommand'],
      ['packages/kernel/src/task1TenantContext.ts', 'sql:issue_app_tenant_context'],
    ]);
    for (const [path, signal] of expected) {
      const source = readFileSync(join(root, path), 'utf8');
      assert.ok(authoritySignals(path, source).writes.includes(signal), `${path}: ${signal}`);
    }
  });

  it('fails on an unclassified repository authority mutation', () => {
    const path = 'apps/api/src/bypass.ts';
    const root = fixtureRoot({
      [path]: 'export const write = (repository) => repository.createRun({});\n',
    });
    try {
      const result = buildInventory({ root, files: [path], allowlist: [] });
      assert.equal(result.passed, false);
      assert.deepEqual(
        result.unapprovedWriteAuthorities.map((entry) => entry.path),
        [path],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails on an unclassified direct SQL authority write', () => {
    const path = 'apps/api/src/sqlBypass.ts';
    const root = fixtureRoot({
      [path]:
        "export const write = (pool) => pool.query('INSERT INTO commander_runs (id) VALUES ($1)', ['run-1']);\n",
    });
    try {
      const result = buildInventory({ root, files: [path], allowlist: [] });
      assert.equal(result.passed, false);
      assert.deepEqual(result.entries[0]?.signals, ['sql-write:INSERT commander_runs']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('scans scripts and detects legacy runtime construction', () => {
    const path = 'scripts/bypass.ts';
    const root = fixtureRoot({
      [path]: 'export const runtime = new AgentRuntime();\n',
    });
    try {
      const result = buildInventory({ root, files: [path], allowlist: [] });
      assert.equal(result.passed, false);
      assert.equal(result.entries[0]?.authorityKind, 'write-capable-legacy');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not trust a second authority merely because it is under kernel', () => {
    const path = 'packages/kernel/src/secondAuthority.ts';
    const root = fixtureRoot({
      [path]: 'export const write = (repository) => repository.approveMission({});\n',
    });
    try {
      const result = buildInventory({ root, files: [path], allowlist: [] });
      assert.equal(result.passed, false);
      assert.equal(result.entries[0]?.authorityKind, 'write-capable-legacy');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects stale, expired, and source-drifted legacy approvals', () => {
    const path = 'apps/api/src/legacy.ts';
    const source = 'export const write = (store) => store.createMission({});\n';
    const root = fixtureRoot({ [path]: source });
    const approved = {
      path,
      sourceSha256: sha256(source),
      callersSha256: callersSha256({}),
      owner: '@praetor/api',
      reason: 'Known mission authority pending deletion',
      expiresAt: '2026-10-31',
      canonicalReplacement: 'POST /v1/runs',
      disposition: 'migrate-and-delete' as const,
    };
    try {
      assert.equal(
        buildInventory({ root, files: [path], allowlist: [approved], today: '2026-07-29' }).passed,
        true,
      );
      assert.equal(
        buildInventory({
          root,
          files: [path],
          allowlist: [{ ...approved, sourceSha256: '0'.repeat(64) }],
          today: '2026-07-29',
        }).passed,
        false,
      );
      assert.equal(
        buildInventory({
          root,
          files: [path],
          allowlist: [{ ...approved, expiresAt: '2020-01-01' }],
          today: '2026-07-29',
        }).passed,
        false,
      );
      assert.equal(
        buildInventory({ root, files: [], allowlist: [approved], today: '2026-07-29' }).passed,
        false,
      );
      const invalidCalendarDate = buildInventory({
        root,
        files: [path],
        allowlist: [{ ...approved, expiresAt: '9999-99-99' }],
      });
      assert.equal(invalidCalendarDate.passed, false);
      assert.ok(
        invalidCalendarDate.errors.some((error) =>
          error.includes('Invalid legacy authority approval'),
        ),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('retains allowlisted sources when generic signal extraction is empty', () => {
    const path = 'apps/api/src/legacy-without-signal.ts';
    const source = 'export const legacyBoundary = true;\n';
    const root = fixtureRoot({ [path]: source });
    const approval = {
      path,
      sourceSha256: sha256(source),
      callersSha256: callersSha256({}),
      owner: '@praetor/api',
      reason: 'Known legacy boundary pending authority migration',
      expiresAt: '2026-10-31',
      canonicalReplacement: 'POST /v1/runs',
      disposition: 'migrate-and-delete' as const,
    };
    try {
      const result = buildInventory({
        root,
        files: [path],
        allowlist: [approval],
        today: '2026-07-29',
      });
      assert.equal(result.passed, true, result.errors.join('\n'));
      assert.deepEqual(result.entries[0]?.signals, ['allowlist-only']);
      assert.equal(result.entries[0]?.authorityKind, 'write-capable-legacy');
      assert.equal(result.entries[0]?.writesExternally, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('binds approvals to the complete caller set and caller source hashes', () => {
    const authorityPath = 'apps/api/src/legacy.ts';
    const callerPath = 'apps/api/src/caller.ts';
    const secondCallerPath = 'apps/api/src/second-caller.ts';
    const authority = 'export const write = (store) => store.createMission({});\n';
    const caller = "import { write } from './legacy.js';\nwrite(store);\n";
    const changedCaller = `${caller}export const marker = true;\n`;
    const secondCaller = "import './legacy.js';\n";
    const root = fixtureRoot({
      [authorityPath]: authority,
      [callerPath]: caller,
      [secondCallerPath]: secondCaller,
    });
    const approved = {
      path: authorityPath,
      sourceSha256: sha256(authority),
      callersSha256: callersSha256({ [callerPath]: caller }),
      owner: '@praetor/api',
      reason: 'Known mission authority pending deletion',
      expiresAt: '2026-10-31',
      canonicalReplacement: 'POST /v1/runs',
      disposition: 'migrate-and-delete' as const,
    };
    try {
      assert.equal(
        buildInventory({
          root,
          files: [authorityPath, callerPath],
          allowlist: [approved],
          today: '2026-07-29',
        }).passed,
        true,
      );

      writeFileSync(join(root, callerPath), changedCaller);
      for (const files of [
        [authorityPath, callerPath],
        [authorityPath, callerPath, secondCallerPath],
        [authorityPath],
      ]) {
        const result = buildInventory({ root, files, allowlist: [approved], today: '2026-07-29' });
        assert.equal(result.passed, false, files.join(','));
        assert.ok(
          result.errors.some((error) => error.includes('Legacy authority callers changed')),
          result.errors.join('\n'),
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps only exact canonical entrypoints canonical', () => {
    const canonicalPath = 'apps/api/src/v1GatewayEndpoints.ts';
    const siblingPath = 'apps/api/src/notCanonical.ts';
    const root = fixtureRoot({
      [canonicalPath]:
        'router.post("/runs", handler); router.post(`/runs/:runId/${verb}`, handler);\n',
      [siblingPath]: 'export const write = (repository) => repository.createRun({});\n',
    });
    try {
      const result = buildInventory({
        root,
        files: [siblingPath, canonicalPath],
        allowlist: [],
      });
      assert.equal(
        result.entries.find((entry) => entry.path === canonicalPath)?.authorityKind,
        'canonical',
      );
      assert.equal(
        result.entries.find((entry) => entry.path === siblingPath)?.authorityKind,
        'write-capable-legacy',
      );
      assert.equal(result.passed, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects authority signals that are not approved for a canonical entrypoint', () => {
    const path = 'apps/api/src/v1GatewayEndpoints.ts';
    const root = fixtureRoot({
      [path]: 'export const write = (repository) => repository.approveMission({});\n',
    });
    try {
      const result = buildInventory({ root, files: [path], allowlist: [] });
      assert.equal(result.passed, false);
      assert.ok(
        result.errors.some((error) =>
          error.includes(`Canonical authority signals changed: ${path}`),
        ),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('recognizes the exact production authority wiring without trusting siblings', () => {
    const canonicalPaths = [
      'apps/api/src/v1GatewayKernel.ts',
      'packages/adapter-ops/src/wiring.ts',
      'packages/worker-plane/src/bootstrap.ts',
    ];
    const siblingPath = 'packages/worker-plane/src/bootstrapBypass.ts';
    const files = Object.fromEntries([
      [
        'apps/api/src/v1GatewayKernel.ts',
        'export const write = (repository) => repository.createRun({});\n',
      ],
      [
        'packages/adapter-ops/src/wiring.ts',
        'broker.admitEffect({}); broker.completeEffect({}); broker.failEffect({});\n',
      ],
      [
        'packages/worker-plane/src/bootstrap.ts',
        'broker.admitEffect({}); broker.completeEffect({});\n',
      ],
      [siblingPath, 'export const write = (repository) => repository.createRun({});\n'],
    ]);
    const root = fixtureRoot(files);
    try {
      const result = buildInventory({
        root,
        files: [...canonicalPaths, siblingPath],
        allowlist: [],
      });
      for (const path of canonicalPaths) {
        assert.equal(
          result.entries.find((entry) => entry.path === path)?.authorityKind,
          'canonical',
        );
      }
      assert.equal(
        result.entries.find((entry) => entry.path === siblingPath)?.authorityKind,
        'write-capable-legacy',
      );
      assert.equal(result.passed, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports deterministic sorted entries and findings', () => {
    const root = fixtureRoot({
      'apps/web/src/z.ts': 'export const z = (api) => api.approveMission({});\n',
      'apps/api/src/a.ts': 'export const a = (store) => store.createMission({});\n',
    });
    try {
      const result = buildInventory({
        root,
        files: ['apps/web/src/z.ts', 'apps/api/src/a.ts'],
        allowlist: [],
      });
      assert.deepEqual(
        result.entries.map((entry) => entry.path),
        ['apps/api/src/a.ts', 'apps/web/src/z.ts'],
      );
      assert.deepEqual(result.errors, [...result.errors].sort());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves TypeScript callers imported through emitted .js specifiers', () => {
    const authorityPath = 'apps/api/src/authority.ts';
    const callerPath = 'apps/api/src/caller.ts';
    const root = fixtureRoot({
      [authorityPath]: 'export const write = (repository) => repository.createRun({});\n',
      [callerPath]: "import './authority.js';\n",
    });
    try {
      const result = buildInventory({
        root,
        files: [authorityPath, callerPath],
        allowlist: [],
      });
      assert.deepEqual(result.entries.find((entry) => entry.path === authorityPath)?.callers, [
        callerPath,
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves require and dynamic-import callers', () => {
    const authorityPath = 'apps/api/src/authority.ts';
    const callers = ['apps/api/src/required.ts', 'apps/api/src/dynamic.ts'];
    const root = fixtureRoot({
      [authorityPath]: 'export const write = (repository) => repository.createRun({});\n',
      [callers[0]]: "require('./authority.js');\n",
      [callers[1]]: "await import('./authority.js');\n",
    });
    try {
      const result = buildInventory({
        root,
        files: [authorityPath, ...callers],
        allowlist: [],
      });
      assert.deepEqual(result.entries.find((entry) => entry.path === authorityPath)?.callers, [
        'apps/api/src/dynamic.ts',
        'apps/api/src/required.ts',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('distinguishes canonical clients from legacy write clients', () => {
    const canonicalPath = 'scripts/canonical-client.ts';
    const legacyPath = 'packages/python-sdk/src/commander/client.py';
    const files = {
      [canonicalPath]: "fetch('/v1/runs', { method: 'POST' });\n",
      [legacyPath]: 'await self._request("POST", "/api/runtime/execute", json=body)\n',
    };
    const root = fixtureRoot(files);
    try {
      const result = buildInventory({ root, files: Object.keys(files), allowlist: [] });
      assert.equal(
        result.entries.find((entry) => entry.path === canonicalPath)?.authorityKind,
        'canonical-client',
      );
      assert.equal(
        result.entries.find((entry) => entry.path === legacyPath)?.authorityKind,
        'write-capable-legacy-client',
      );
      assert.equal(result.passed, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects blank approval metadata and approvals beyond the review window', () => {
    const path = 'apps/api/src/legacy.ts';
    const source = 'repository.createRun({});\n';
    const root = fixtureRoot({ [path]: source });
    const base = {
      path,
      sourceSha256: sha256(source),
      callersSha256: callersSha256({}),
      owner: '@praetor/api',
      reason: 'Pending canonical gateway migration',
      expiresAt: '2026-10-31',
      canonicalReplacement: 'POST /v1/runs',
      disposition: 'migrate-and-delete' as const,
    };
    try {
      for (const approval of [
        { ...base, owner: ' ' },
        { ...base, reason: '          ' },
        { ...base, canonicalReplacement: ' ' },
        { ...base, expiresAt: '9999-12-31' },
      ]) {
        const result = buildInventory({
          root,
          files: [path],
          allowlist: [approval],
          today: '2026-07-29',
        });
        assert.equal(result.passed, false, JSON.stringify(approval));
        assert.ok(
          result.errors.some((error) => error.includes('Invalid legacy authority approval')),
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
