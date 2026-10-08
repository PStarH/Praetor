/**
 * Crash-safe file persistence helpers (REL-3 / REL-4).
 *
 * `writeFileSync(path, data)` truncates the target and streams bytes in place, so
 * a crash mid-write leaves a half-written / truncated file that later fails to
 * parse — crash-looping boot paths (`WarRoomStore.load`) or silently losing all
 * state (`AgentStateStore`). These helpers make writes atomic and reads
 * corruption-tolerant.
 *
 * NOTE: kept in sync with `packages/core/src/runtime/atomicWrite.ts`; the two
 * copies avoid a cross-package build-order dependency. Dedupe when a shared
 * `@praetor/*` fs utility exists.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

function exclusiveTempPath(dir: string, base: string): string {
  return path.join(dir, `.${base}.${crypto.randomBytes(8).toString('hex')}.tmp`);
}

/**
 * Atomically write a file: write to a temp file in the same directory, fsync the
 * contents to disk, rename over the target (atomic on a POSIX same-filesystem
 * rename), then fsync the directory so the rename itself survives power loss.
 * A crash can never observe a half-written or truncated target.
 */
export function atomicWriteFileSync(filePath: string, data: string | Buffer, mode?: number): void {
  const resolved = path.resolve(filePath);
  const dir = path.dirname(resolved);
  const base = path.basename(resolved);
  const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
  const target = path.resolve(dir, base);
  const tmp = path.resolve(exclusiveTempPath(dir, base));
  if (!target.startsWith(prefix) || !tmp.startsWith(prefix)) {
    throw new Error('ATOMIC_WRITE_PATH_ESCAPE');
  }
  fs.mkdirSync(dir, { recursive: true });
  const fd = fs.openSync(tmp, 'wx', mode);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, target);
  try {
    const dfd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(dfd);
    } finally {
      fs.closeSync(dfd);
    }
  } catch {
    /* directory fsync is best-effort */
  }
}

/** Optional top-level shape guard; fail → same `.corrupt-*` quarantine as parse errors. */
export type JsonShapeGuard = (value: unknown) => boolean;

/** 顶层应为普通对象（非 null / 非数组）。 */
export function isPlainObjectJson(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function quarantineAside(filePath: string, reason: 'parse' | 'shape' = 'parse'): void {
  const aside = `${filePath}.corrupt-${Date.now()}`;
  try {
    fs.renameSync(filePath, aside);
    process.stderr.write(`[atomicWrite] quarantined ${filePath} → ${aside} (reason=${reason})\n`);
  } catch {
    /* quarantine is best-effort — never throw from a load path */
  }
}

/**
 * Read and JSON.parse a file, quarantining corrupt **or wrong-shape** payloads
 * instead of letting parse throw (crash-loop) or silently discarding (next write
 * permanently wipes recoverable state). On parse / shape failure the file is
 * moved aside to `<file>.corrupt-<ts>` and `fallback` is returned so the caller
 * can reseed. Returns `fallback` when the file is absent.
 *
 * `isExpectedShape`：解析成功后校验顶层形态（数组 vs 已知键对象）；错形与损坏同级隔离。
 */
export function readJsonFileSafe<T>(
  filePath: string,
  fallback: T,
  isExpectedShape?: JsonShapeGuard,
): T {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return fallback;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isExpectedShape && !isExpectedShape(parsed)) {
      quarantineAside(filePath, 'shape');
      return fallback;
    }
    return parsed as T;
  } catch {
    quarantineAside(filePath, 'parse');
    return fallback;
  }
}
