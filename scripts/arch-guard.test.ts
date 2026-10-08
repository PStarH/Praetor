import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const SCRIPT = fileURLToPath(new URL('./arch-guard.sh', import.meta.url));

interface FixturePackage {
  name: string;
  deps?: Record<string, string>;
  source?: string;
  sourcePath?: string;
}

interface FixtureOptions {
  packages: Record<string, FixturePackage>;
  rootFiles?: Record<string, string>;
}

function fixture(options: FixtureOptions): string {
  const root = mkdtempSync(join(tmpdir(), 'commander-arch-guard-'));
  try {
    for (const [directory, pkg] of Object.entries(options.packages)) {
      const packageDir = join(root, 'packages', directory);
      mkdirSync(join(packageDir, 'src'), { recursive: true });
      writeFileSync(
        join(packageDir, 'package.json'),
        JSON.stringify({
          name: pkg.name,
          version: '0.0.0',
          dependencies: pkg.deps ?? {},
        }),
      );
      const sourcePath = pkg.sourcePath ?? 'index.ts';
      writeFileSync(join(packageDir, 'src', sourcePath), pkg.source ?? 'export {}\n');
    }
    for (const [file, contents] of Object.entries(options.rootFiles ?? {})) {
      writeFileSync(join(root, file), contents);
    }
    return root;
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function runGuard(root: string): string {
  try {
    return execFileSync('bash', [SCRIPT], {
      env: { ...process.env, COMMANDER_ARCH_ROOT: root },
      encoding: 'utf8',
      stdio: 'pipe',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('passes the minimal allowed package graph', () => {
  const root = fixture({
    packages: {
      contracts: { name: '@praetor/contracts' },
      kernel: {
        name: '@praetor/kernel',
        deps: { '@praetor/contracts': 'workspace:*' },
      },
    },
  });
  assert.doesNotThrow(() => runGuard(root));
});

test('rejects a new orchestrator package', () => {
  const root = fixture({
    packages: {
      contracts: { name: '@praetor/contracts' },
      orchestrator: { name: '@praetor/orchestrator' },
    },
  });
  assert.throws(() => runGuard(root), /forbidden package/i);
});

test('rejects a reintroduced orchestration package', () => {
  const root = fixture({
    packages: {
      contracts: { name: '@praetor/contracts' },
      orchestration: { name: '@praetor/orchestration' },
    },
  });
  assert.throws(() => runGuard(root), /forbidden package/i);
});

test('rejects a reintroduced security package role', () => {
  const root = fixture({
    packages: {
      contracts: { name: '@praetor/contracts' },
      security: { name: '@praetor/security' },
    },
  });
  assert.throws(() => runGuard(root), /forbidden package/i);
});

test('rejects imports of deleted control-plane package', () => {
  const root = fixture({
    packages: {
      contracts: { name: '@praetor/contracts' },
      kernel: {
        name: '@praetor/kernel',
        deps: { '@praetor/contracts': 'workspace:*' },
        source: "import '@praetor/control-plane';\n",
      },
    },
  });
  assert.throws(() => runGuard(root), /deleted package/i);
});

test('rejects reintroduced operations package (ghost plane banned)', () => {
  const root = fixture({
    packages: {
      contracts: { name: '@praetor/contracts' },
      kernel: {
        name: '@praetor/kernel',
        deps: { '@praetor/contracts': 'workspace:*' },
      },
      operations: {
        name: '@praetor/operations',
        deps: {
          '@praetor/kernel': 'workspace:*',
          '@praetor/contracts': 'workspace:*',
        },
      },
    },
  });
  assert.throws(
    () => runGuard(root),
    /no dependency policy exists for workspace package @(commander|praetor)\/operations/i,
  );
});

test('rejects imports of deleted operations package', () => {
  const root = fixture({
    packages: {
      contracts: { name: '@praetor/contracts' },
      kernel: {
        name: '@praetor/kernel',
        deps: { '@praetor/contracts': 'workspace:*' },
        source: "import '@praetor/operations';\n",
      },
    },
  });
  assert.throws(() => runGuard(root), /deleted package/i);
});

test('rejects root package.json references to deleted packages', () => {
  const root = fixture({
    packages: {
      contracts: { name: '@praetor/contracts' },
    },
    rootFiles: {
      'package.json': JSON.stringify({
        name: 'commander-monorepo',
        dependencies: {
          '@praetor/orchestration': 'workspace:*',
        },
      }),
    },
  });
  assert.throws(() => runGuard(root), /deleted package/i);
});

test('rejects worker-plane core imports outside configured bridge files', () => {
  const root = fixture({
    packages: {
      contracts: { name: '@praetor/contracts' },
      core: { name: '@praetor/core', deps: { '@praetor/contracts': 'workspace:*' } },
      'worker-plane': {
        name: '@praetor/worker-plane',
        deps: {
          '@praetor/contracts': 'workspace:*',
          '@praetor/core': 'workspace:*',
        },
        sourcePath: 'rogueBridge.ts',
        source: "import '@praetor/core';\n",
      },
    },
  });
  assert.throws(() => runGuard(root), /illegal source dependency/i);
});

test('rejects a reintroduced control-plane package', () => {
  const root = fixture({
    packages: {
      contracts: { name: '@praetor/contracts' },
      'control-plane': { name: '@praetor/control-plane' },
    },
  });
  assert.throws(() => runGuard(root), /forbidden package/i);
});

test('rejects reintroduced operations package (ghost plane banned)', () => {
  const root = fixture({
    packages: {
      contracts: { name: '@praetor/contracts' },
      kernel: {
        name: '@praetor/kernel',
        deps: { '@praetor/contracts': 'workspace:*' },
      },
      operations: {
        name: '@praetor/operations',
        deps: {
          '@praetor/kernel': 'workspace:*',
          '@praetor/contracts': 'workspace:*',
        },
      },
    },
  });
  assert.throws(
    () => runGuard(root),
    /no dependency policy exists for workspace package @(commander|praetor)\/operations/i,
  );
});

test('rejects imports of deleted operations package', () => {
  const root = fixture({
    packages: {
      contracts: { name: '@praetor/contracts' },
      kernel: {
        name: '@praetor/kernel',
        deps: { '@praetor/contracts': 'workspace:*' },
        source: "import '@praetor/operations';\n",
      },
    },
  });
  assert.throws(() => runGuard(root), /deleted package/i);
});

test('rejects kernel importing core', () => {
  const root = fixture({
    packages: {
      contracts: { name: '@praetor/contracts' },
      kernel: {
        name: '@praetor/kernel',
        deps: { '@praetor/core': 'workspace:*' },
        source: "import '@praetor/core';\n",
      },
    },
  });
  assert.throws(() => runGuard(root), /kernel.*core|illegal.*dependency/i);
});

test('rejects contracts importing an implementation package', () => {
  const root = fixture({
    packages: {
      contracts: {
        name: '@praetor/contracts',
        deps: { '@praetor/kernel': 'workspace:*' },
        source: "import '@praetor/kernel';\n",
      },
      kernel: { name: '@praetor/kernel' },
    },
  });
  assert.throws(() => runGuard(root), /contracts.*leaf|illegal.*dependency/i);
});

test('rejects a cycle in internal package dependencies', () => {
  const root = fixture({
    packages: {
      contracts: {
        name: '@praetor/contracts',
        deps: { '@praetor/kernel': 'workspace:*' },
      },
      kernel: {
        name: '@praetor/kernel',
        deps: { '@praetor/contracts': 'workspace:*' },
      },
    },
  });
  assert.throws(() => runGuard(root), /cycle/i);
});

test('rejects a relative import that escapes its package boundary', () => {
  const root = fixture({
    packages: {
      contracts: {
        name: '@praetor/contracts',
        source: "import '../../kernel/src/index.js';\n",
      },
      kernel: { name: '@praetor/kernel' },
    },
  });
  assert.throws(() => runGuard(root), /relative import escapes package boundary/i);
});

test('rejects action-adapters importing core', () => {
  const root = fixture({
    packages: {
      contracts: { name: '@praetor/contracts' },
      'effect-broker': { name: '@praetor/effect-broker' },
      'action-adapters': {
        name: '@praetor/action-adapters',
        deps: {
          '@praetor/contracts': 'workspace:*',
          '@praetor/effect-broker': 'workspace:*',
          '@praetor/core': 'workspace:*',
        },
        source: "import '@praetor/core';\n",
      },
    },
  });
  assert.throws(() => runGuard(root), /illegal.*dependency|action-adapters.*core/i);
});

test('rejects adapter-ops importing @praetor/core', () => {
  const root = fixture({
    packages: {
      contracts: { name: '@praetor/contracts' },
      kernel: {
        name: '@praetor/kernel',
        deps: { '@praetor/contracts': 'workspace:*' },
      },
      'effect-broker': {
        name: '@praetor/effect-broker',
        deps: { '@praetor/contracts': 'workspace:*' },
      },
      'action-adapters': {
        name: '@praetor/action-adapters',
        deps: {
          '@praetor/contracts': 'workspace:*',
          '@praetor/effect-broker': 'workspace:*',
        },
      },
      'adapter-ops': {
        name: '@praetor/adapter-ops',
        deps: {
          '@praetor/kernel': 'workspace:*',
          '@praetor/contracts': 'workspace:*',
          '@praetor/effect-broker': 'workspace:*',
          '@praetor/action-adapters': 'workspace:*',
          '@praetor/core': 'workspace:*',
        },
        source: "import '@praetor/core';\n",
      },
    },
  });
  assert.throws(
    () => runGuard(root),
    /illegal.*dependency|adapter-ops.*core|forbidden @commander\/core/i,
  );
});

test('rejects adapter-ops importing apps/api', () => {
  const root = fixture({
    packages: {
      contracts: { name: '@praetor/contracts' },
      kernel: {
        name: '@praetor/kernel',
        deps: { '@praetor/contracts': 'workspace:*' },
      },
      'effect-broker': {
        name: '@praetor/effect-broker',
        deps: { '@praetor/contracts': 'workspace:*' },
      },
      'action-adapters': {
        name: '@praetor/action-adapters',
        deps: {
          '@praetor/contracts': 'workspace:*',
          '@praetor/effect-broker': 'workspace:*',
        },
      },
      'adapter-ops': {
        name: '@praetor/adapter-ops',
        deps: {
          '@praetor/kernel': 'workspace:*',
          '@praetor/contracts': 'workspace:*',
          '@praetor/effect-broker': 'workspace:*',
          '@praetor/action-adapters': 'workspace:*',
        },
        source: "import '../../../apps/api/src/index.js';\n",
      },
    },
  });
  assert.throws(() => runGuard(root), /relative import escapes package boundary/i);
});

test('rejects action-adapters importing core via source', () => {
  const root = fixture({
    packages: {
      contracts: { name: '@praetor/contracts' },
      core: { name: '@praetor/core', deps: { '@praetor/contracts': 'workspace:*' } },
      'effect-broker': {
        name: '@praetor/effect-broker',
        deps: { '@praetor/contracts': 'workspace:*' },
      },
      'action-adapters': {
        name: '@praetor/action-adapters',
        deps: {
          '@praetor/contracts': 'workspace:*',
          '@praetor/effect-broker': 'workspace:*',
        },
        source: "import '@praetor/core';\n",
      },
    },
  });
  assert.throws(() => runGuard(root), /illegal source dependency|illegal dependency/i);
});

test('rejects commander dev importing @praetor/kernel', () => {
  const root = fixture({
    packages: {
      contracts: { name: '@praetor/contracts' },
      core: {
        name: '@praetor/core',
        deps: { '@praetor/contracts': 'workspace:*', '@praetor/kernel': 'workspace:*' },
        source: "import '@praetor/kernel';\nexport async function cmdDev() {}\n",
      },
    },
  });
  assert.throws(() => runGuard(root), /illegal source dependency|kernel/i);
});

test('rejects commander dev importing apps/api paths', () => {
  const root = fixture({
    packages: {
      contracts: { name: '@praetor/contracts' },
      core: {
        name: '@praetor/core',
        source: "import '../../../apps/api/src/index.js';\nexport async function cmdDev() {}\n",
      },
    },
  });
  assert.throws(() => runGuard(root), /relative import escapes package boundary/i);
});

test('rejects commander dev importing @praetor/worker-plane', () => {
  const root = fixture({
    packages: {
      contracts: { name: '@praetor/contracts' },
      kernel: { name: '@praetor/kernel', deps: { '@praetor/contracts': 'workspace:*' } },
      'worker-plane': {
        name: '@praetor/worker-plane',
        deps: { '@praetor/kernel': 'workspace:*' },
      },
      core: {
        name: '@praetor/core',
        deps: { '@praetor/worker-plane': 'workspace:*' },
        source: "import '@praetor/worker-plane';\nexport async function cmdDev() {}\n",
      },
    },
  });
  assert.throws(() => runGuard(root), /illegal source dependency|worker-plane/i);
});

test('rejects ad-hoc CapabilityGrant interface in worker-plane', () => {
  const root = fixture({
    packages: {
      contracts: { name: '@praetor/contracts' },
      kernel: {
        name: '@praetor/kernel',
        deps: { '@praetor/contracts': 'workspace:*' },
      },
      'worker-plane': {
        name: '@praetor/worker-plane',
        deps: {
          '@praetor/contracts': 'workspace:*',
          '@praetor/kernel': 'workspace:*',
        },
        source: 'export interface CapabilityGrant { jti: string }\n',
      },
    },
  });
  assert.throws(() => runGuard(root), /Ad-hoc grant interface/i);
});
