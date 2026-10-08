import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as Record<
  string,
  unknown
>;

void describe('@praetor/core publication contract', () => {
  void it('runs the canonical ESM build before packing and publishing', () => {
    const scripts = manifest.scripts as Record<string, string>;
    assert.equal(scripts.prepack, 'pnpm run build');
    assert.equal(scripts.prepublishOnly, 'pnpm run build');
  });

  void it('requires the runtime version used by current dependencies', () => {
    assert.equal((manifest.engines as Record<string, string>).node, '>=20.0.0');
  });
});
