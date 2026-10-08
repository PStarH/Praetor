#!/usr/bin/env node
/**
 * fix-esm-imports.mjs
 *
 * TypeScript's `tsc` with `moduleResolution: "Bundler"` emits ESM imports
 * without the `.js` extension that Node.js ESM requires at runtime. This
 * script walks a target directory and rewrites relative import/export
 * specifiers so the output can be run directly with Node.js.
 *
 * Usage:
 *   node scripts/fix-esm-imports.mjs <dist-dir>
 *
 * Example:
 *   node scripts/fix-esm-imports.mjs apps/api/dist
 */

import { readdir, readFile, writeFile, stat, realpath } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';

const TARGET_EXTENSIONS = ['.js', '.mjs'];

async function* walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(path);
    } else if (entry.isFile() && TARGET_EXTENSIONS.includes(extname(entry.name))) {
      yield path;
    }
  }
}

async function resolveSpecifier(specifier, sourceDir) {
  // Only touch relative specifiers and workspace package specifiers
  if (!specifier.startsWith('.') && !specifier.startsWith('..') && !specifier.startsWith('@praetor/')) {
    return specifier;
  }

  // Already has an extension we recognize
  const ext = extname(specifier);
  if (ext && TARGET_EXTENSIONS.includes(ext)) {
    return specifier;
  }

  if (specifier.startsWith('@praetor/')) {
    return resolveWorkspaceSpecifier(specifier, sourceDir);
  }

  // If it ends with a slash, it's likely a directory index import
  if (specifier.endsWith('/')) {
    return `${specifier}index.js`;
  }

  const resolved = join(sourceDir, specifier);

  // Prefer a sibling .js file over a directory index. This mirrors TypeScript's
  // resolution (e.g. './memory' resolves to memory.ts even if a memory/
  // directory also exists) and avoids runtime ESM ambiguity.
  try {
    await stat(`${resolved}.js`);
    return `${specifier}.js`;
  } catch {
    // fall through
  }

  // Directory index import
  try {
    const s = await stat(resolved);
    if (s.isDirectory()) {
      return `${specifier}/index.js`;
    }
  } catch {
    // fall through
  }

  // Default: append .js
  return `${specifier}.js`;
}

async function resolveWorkspaceSpecifier(specifier, sourceDir) {
  // Only rewrite deep imports that point to a real file/directory inside a
  // workspace package. Export subpaths defined in package.json (e.g.
  // `@praetor/core/runtime`) are left untouched so Node resolves them
  // through the "exports" map.
  const parts = specifier.split('/');
  const packageName = parts[0] + '/' + parts[1];
  const subpath = parts.slice(2).join('/');

  const candidates = [
    join(sourceDir, 'node_modules', packageName),
    join(sourceDir, '..', 'node_modules', packageName),
    join(sourceDir, '..', '..', 'node_modules', packageName),
  ];

  for (const candidate of candidates) {
    let packageRoot;
    try {
      packageRoot = await realpath(candidate);
    } catch {
      continue;
    }

    const resolved = subpath ? join(packageRoot, subpath) : packageRoot;

    try {
      const s = await stat(resolved);
      if (s.isDirectory()) {
        // Only rewrite if an index.js file actually exists inside the directory.
        try {
          await stat(join(resolved, 'index.js'));
          return `${specifier}/index.js`;
        } catch {
          return specifier;
        }
      }
    } catch {
      // fall through
    }

    // If the file (with .js) exists, append .js
    try {
      await stat(`${resolved}.js`);
      return `${specifier}.js`;
    } catch {
      // fall through
    }
  }

  // Not a real file/directory inside the package — likely an export subpath.
  // Leave it untouched so Node resolves it through the package.json exports map.
  return specifier;
}

const REQUIRE_SHIM = `import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
`;

async function fixFile(path) {
  let content = await readFile(path, 'utf8');
  const sourceDir = dirname(path);

  // Node.js ESM files cannot use `require()` unless it is created with
  // createRequire. Source files often use `require()` for optional native
  // dependencies (e.g. better-sqlite3). Inject a local require shim so the
  // emitted ESM artifacts can load those dependencies at runtime.
  if (
    /\brequire\s*\(/.test(content) &&
    !/createRequire/.test(content) &&
    !/const require\s*=/.test(content)
  ) {
    content = REQUIRE_SHIM + content;
    console.log(`[fix-esm-imports] injected require shim: ${path}`);
  }

  // Match actual import/export declarations with a string specifier.
  // import ... from 'specifier'
  // export { ... } from 'specifier'
  // export * from 'specifier'
  // import 'specifier'
  // Anchor to start of line (after optional whitespace) to avoid matching
  // the words "import"/"export" inside comments or unrelated export
  // declarations such as "export class".
  const importRe = /^(\s*import\b[\s\S]*?(?:from\s+)?['"])([^'"]+)(['"])/gm;
  const exportRe = /^(\s*export\s+(?:\{[\s\S]*?\}|\*)\s+from\s+['"])([^'"]+)(['"])/gm;

  const matches = [
    ...content.matchAll(importRe),
    ...content.matchAll(exportRe),
  ].sort((a, b) => a.index - b.index);

  let newContent = content;

  if (matches.length > 0) {
    const resolved = await Promise.all(
      matches.map((m) => resolveSpecifier(m[2], sourceDir))
    );

    // Replace from end to start to preserve indices
    for (let i = matches.length - 1; i >= 0; i--) {
      const m = matches[i];
      const r = resolved[i];
      if (r !== m[2]) {
        const prefixEnd = m.index + m[1].length;
        newContent =
          newContent.slice(0, prefixEnd) +
          r +
          newContent.slice(prefixEnd + m[2].length);
      }
    }
  }

  // Dynamic import() specifiers also need an explicit extension in Node ESM.
  const dynamicImportRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  const dynamicMatches = [...newContent.matchAll(dynamicImportRe)];
  if (dynamicMatches.length > 0) {
    const resolvedDynamic = await Promise.all(
      dynamicMatches.map((m) => resolveSpecifier(m[1], sourceDir))
    );
    for (let i = dynamicMatches.length - 1; i >= 0; i--) {
      const m = dynamicMatches[i];
      const r = resolvedDynamic[i];
      if (r !== m[1]) {
        const prefixEnd = m.index + m[0].indexOf(m[1], 7); // after `import('
        newContent =
          newContent.slice(0, prefixEnd) +
          r +
          newContent.slice(prefixEnd + m[1].length);
      }
    }
  }

  if (newContent !== content) {
    await writeFile(path, newContent, 'utf8');
    console.log(`[fix-esm-imports] ${path}`);
  }
}

async function main() {
  const dirs = process.argv.slice(2);
  if (dirs.length === 0) {
    console.error('Usage: node fix-esm-imports.mjs <dist-dir> [<dist-dir> ...]');
    process.exit(1);
  }

  for (const dir of dirs) {
    for await (const path of walk(dir)) {
      await fixFile(path);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
