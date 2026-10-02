/**
 * ESM compatibility helpers.
 *
 * `packages/core` is `"type": "module"`, so the CommonJS globals `require` and
 * `__dirname` do not exist. Referencing them raises
 * `ReferenceError: <name> is not defined` — and because such references usually
 * sit inside a `try`/`catch` meant to tolerate something else, the failure is
 * silently swallowed and the capability is disabled while the code reports an
 * unrelated reason.
 *
 * Bind them per module:
 *
 * ```ts
 * import { getDirname, getRequire } from './esmCompat';
 * const __dirname = getDirname(import.meta.url);
 * const nodeRequire = getRequire(import.meta.url);
 * ```
 *
 * **Both helpers take the caller's `import.meta.url` on purpose.**
 * `createRequire` and `fileURLToPath` resolve relative paths against the URL
 * they are handed, so a single shared instance would resolve a relative
 * specifier like `./sibling` against *this* file's directory rather than the
 * caller's — converting a loud `ReferenceError` into a confusing
 * `MODULE_NOT_FOUND`. Passing the URL explicitly makes the dependency visible
 * and impossible to get wrong by accident.
 *
 * Mirrors `apps/api/src/esmCompat.ts`, which does the same for the API app.
 *
 * Prefer `import.meta.dirname` (Node >= 20.11) if the supported range is ever
 * raised; `packages/core` currently declares `engines.node >= 20.0.0`, which
 * does not guarantee it.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The directory containing the module identified by `metaUrl`. */
export function getDirname(metaUrl?: string): string {
  if (typeof metaUrl === 'string' && metaUrl.length > 0) {
    try {
      return dirname(fileURLToPath(metaUrl));
    } catch {
      // Ignore URL parsing error and fall through
    }
  }
  if (typeof __dirname !== 'undefined' && __dirname) {
    return __dirname;
  }
  return process.cwd();
}

/** An ESM-safe `require` whose relative specifiers resolve from `metaUrl`. */
export function getRequire(metaUrl?: string) {
  if (typeof metaUrl === 'string' && metaUrl.length > 0) {
    try {
      return createRequire(metaUrl);
    } catch {
      // Ignore URL parsing error and fall through
    }
  }
  if (typeof import.meta !== 'undefined' && import.meta?.url) {
    return createRequire(import.meta.url);
  }
  return createRequire(join(process.cwd(), 'package.json'));
}
