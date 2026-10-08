import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { scanPostgresPoolBypasses } from './postgres-pool-bypass.js';

function write(root: string, relativePath: string, source: string): void {
  const file = join(root, relativePath);
  mkdirSync(resolve(file, '..'), { recursive: true });
  writeFileSync(file, source);
}

describe('PostgreSQL pool bypass AST gate', () => {
  it('detects imported, required, and dynamic-import pg.Pool construction', () => {
    const root = mkdtempSync(join(tmpdir(), 'commander-pg-bypass-'));
    write(root, 'apps/a/src/imported.ts', "import { Pool as PgPool } from 'pg'; new PgPool();\n");
    write(
      root,
      'packages/b/src/required.ts',
      "function open() { let Pool; Pool = require('pg').Pool; return new Pool(); }\n",
    );
    write(
      root,
      'packages/c/src/dynamic.ts',
      "async function open() { const { Pool } = await import('pg'); return new Pool(); }\n",
    );
    write(
      root,
      'packages/d/src/safe.ts',
      "import { createVerifiedPostgresPool } from '@praetor/postgres-runtime'; createVerifiedPostgresPool({ connectionString: 'x' });\n",
    );

    assert.deepEqual(
      scanPostgresPoolBypasses(root).map(({ relativePath }) => relativePath),
      ['apps/a/src/imported.ts', 'packages/b/src/required.ts', 'packages/c/src/dynamic.ts'],
    );
  });

  it('exempts only tracked tests and the shared factory implementation', () => {
    const root = mkdtempSync(join(tmpdir(), 'commander-pg-bypass-exempt-'));
    const source = "import { Pool } from 'pg'; new Pool();\n";
    write(root, 'apps/a/src/example.test.ts', source);
    write(root, 'packages/postgres-runtime/src/index.ts', source);
    write(root, 'apps/a/src/example.ts', source);

    assert.deepEqual(
      scanPostgresPoolBypasses(root).map(({ relativePath }) => relativePath),
      ['apps/a/src/example.ts'],
    );
  });

  it('finds no direct production pool construction in the repository', () => {
    const root = resolve(import.meta.dirname, '..');
    assert.deepEqual(scanPostgresPoolBypasses(root), []);
  });
});
