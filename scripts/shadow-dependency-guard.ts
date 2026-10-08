import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

export interface ShadowPackageManifest {
  name?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  resolvedDependencies?: Record<string, string>;
}

const SHADOW_PRODUCTION_ALLOWLIST = new Set([
  '@praetor/contracts',
  '@praetor/postgres-runtime',
  'json-canonicalize',
  'pg',
]);

const POSTGRES_PRODUCTION_ALLOWLIST = new Set([
  'pg-cloudflare',
  'pg-connection-string',
  'pg-pool',
  'pg-protocol',
  'pg-types',
  'pg-int8',
  'pgpass',
  'postgres-array',
  'postgres-bytea',
  'postgres-date',
  'postgres-interval',
  'xtend',
  'split2',
]);

function dependencies(manifest: ShadowPackageManifest): string[] {
  return [
    ...new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ]),
  ].sort();
}

function isOptionalDependency(manifest: ShadowPackageManifest, name: string): boolean {
  return (
    manifest.optionalDependencies?.[name] !== undefined ||
    manifest.peerDependenciesMeta?.[name]?.optional === true
  );
}

export function readShadowDependencyClosure(
  rootManifestPath: string,
): Record<string, ShadowPackageManifest> {
  const manifests: Record<string, ShadowPackageManifest> = {};
  const rootPath = realpathSync(rootManifestPath);
  const pending = [{ key: rootPath, path: rootPath }];
  while (pending.length > 0) {
    const current = pending.shift()!;
    if (manifests[current.key]) continue;
    const manifest = JSON.parse(readFileSync(current.path, 'utf8')) as ShadowPackageManifest;
    const resolvedDependencies: Record<string, string> = {};
    manifests[current.key] = { ...manifest, resolvedDependencies };
    const require = createRequire(current.path);
    for (const name of dependencies(manifest)) {
      // Resolve from the declaring package so pnpm's actual production graph is checked.
      const path = require.resolve
        .paths(name)
        ?.map((directory) => join(directory, name, 'package.json'))
        .find(existsSync);
      if (!path) {
        if (isOptionalDependency(manifest, name)) continue;
        throw new Error(`package manifest not found: ${name}`);
      }
      const resolvedPath = realpathSync(path);
      resolvedDependencies[name] = resolvedPath;
      pending.push({ key: resolvedPath, path: resolvedPath });
    }
  }
  return manifests;
}

export function validateShadowDependencyClosure(
  manifests: Record<string, ShadowPackageManifest>,
): string[] {
  const root = '@praetor/shadow-plane';
  const issues: string[] = [];
  const visited = new Set<string>();
  const rootKey =
    manifests[root] === undefined
      ? (Object.entries(manifests).find(([, manifest]) => manifest.name === root)?.[0] ?? root)
      : root;
  const pending: Array<{ key: string; path: string[] }> = [{ key: rootKey, path: [root] }];

  while (pending.length > 0) {
    const current = pending.shift()!;
    if (visited.has(current.key)) continue;
    visited.add(current.key);
    const manifest = manifests[current.key];
    if (!manifest) {
      issues.push(`missing package manifest: ${current.path.join(' -> ')}`);
      continue;
    }
    for (const dependency of dependencies(manifest)) {
      const path = [...current.path, dependency];
      const dependencyKey = manifest.resolvedDependencies?.[dependency] ?? dependency;
      if (!manifests[dependencyKey] && isOptionalDependency(manifest, dependency)) continue;
      const postgresDependency =
        current.path.includes('pg') && POSTGRES_PRODUCTION_ALLOWLIST.has(dependency);
      if (!SHADOW_PRODUCTION_ALLOWLIST.has(dependency) && !postgresDependency) {
        issues.push(`forbidden production dependency: ${path.join(' -> ')}`);
      }
      pending.push({ key: dependencyKey, path });
    }
  }
  return issues;
}
