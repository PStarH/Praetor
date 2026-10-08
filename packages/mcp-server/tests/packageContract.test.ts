import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as Record<
  string,
  unknown
>;

describe('@praetor/mcp-server publication contract', () => {
  it('publishes its generated JavaScript as ESM', () => {
    expect(manifest.type).toBe('module');
  });

  it('runs the canonical build before publishing', () => {
    const scripts = manifest.scripts as Record<string, string>;
    expect(scripts.prepublishOnly).toBe('pnpm run build');
  });
});
