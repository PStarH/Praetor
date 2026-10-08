import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as Record<
  string,
  unknown
>;

void describe('@praetor/sdk publication contract', () => {
  void it('publishes its generated JavaScript as ESM', () => {
    assert.equal(manifest.type, 'module');
  });

  void it('runs the canonical build before publishing', () => {
    const scripts = manifest.scripts as Record<string, string>;
    assert.equal(scripts.prepublishOnly, 'pnpm run build');
  });

  void it('ships the documented README', () => {
    assert.equal(existsSync(join(packageRoot, 'README.md')), true);
  });
});
