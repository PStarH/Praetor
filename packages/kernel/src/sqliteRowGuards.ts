/**
 * Lightweight runtime type guards for SQLite row adapters.
 *
 * The kernel historically used `as string` / `as number` casts when mapping raw
 * SQLite rows to typed domain objects. These helpers fail fast when a row does
 * not match the expected shape, which makes schema drift or corrupted data
 * obvious instead of propagating bad types through the rest of the system.
 *
 * We intentionally avoid a heavy validation library (e.g. zod) in this package to
 * keep the kernel's dependency surface small. The helpers below are explicit,
 * testable, and throw clear messages.
 */

function safeJsonParse<T = Record<string, unknown>>(
  value: unknown,
  column: string,
  fallback: T,
): T {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      process.stderr.write(
        `[kernel:sqlite] JSON parse error in column ${column}: corrupted data, using fallback\n`,
      );
      return fallback;
    }
  }
  if (value === null || value === undefined) return fallback;
  return value as T;
}

export class SqliteRowValidationError extends Error {
  constructor(
    readonly table: string,
    readonly field: string,
    readonly reason: string,
  ) {
    super(`[kernel:sqlite] Invalid row in ${table}: ${field} ${reason}`);
    this.name = 'SqliteRowValidationError';
  }
}

export function reqString(table: string, row: Record<string, unknown>, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') {
    throw new SqliteRowValidationError(table, column, 'must be a string');
  }
  return value;
}

function strictNumberFrom(value: unknown): number | null {
  // KB-02: SQLite INTEGER is 64-bit while JS numbers are only exact up to
  // 2^53-1. `Number(bigint)` silently rounds (9007199254740993n becomes
  // ...992), so a value that cannot be represented losslessly must be rejected
  // rather than accepted as a different integer. Generation/version/fencing
  // counters read through these guards must never drift.
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : null;
  if (typeof value === 'bigint') {
    if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      return null;
    }
    return Number(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const num = Number(trimmed);
    if (!Number.isSafeInteger(num)) return null;
    return num;
  }
  return null;
}

export function reqInteger(table: string, row: Record<string, unknown>, column: string): number {
  const num = strictNumberFrom(row[column]);
  if (num === null || !Number.isInteger(num)) {
    throw new SqliteRowValidationError(table, column, 'must be an integer');
  }
  return num;
}

export function reqOptionalString(
  table: string,
  row: Record<string, unknown>,
  column: string,
): string | undefined {
  const value = row[column];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new SqliteRowValidationError(table, column, 'must be a string or null/undefined');
  }
  return value;
}

export function reqOptionalInteger(
  table: string,
  row: Record<string, unknown>,
  column: string,
): number | undefined {
  const value = row[column];
  if (value === null || value === undefined) return undefined;
  const num = strictNumberFrom(value);
  if (num === null || !Number.isInteger(num)) {
    throw new SqliteRowValidationError(table, column, 'must be an integer or null/undefined');
  }
  return num;
}

export function reqJsonObject<T = Record<string, unknown>>(
  table: string,
  row: Record<string, unknown>,
  column: string,
): T {
  const value = row[column];
  const parsed = safeJsonParse(value, `${table}.${column}`, null);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SqliteRowValidationError(table, column, 'must be a JSON object');
  }
  return parsed as T;
}

export function reqOptionalJsonObject<T = Record<string, unknown>>(
  table: string,
  row: Record<string, unknown>,
  column: string,
): T | undefined {
  const value = row[column];
  if (value === null || value === undefined) return undefined;
  const parsed = safeJsonParse(value, `${table}.${column}`, null);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SqliteRowValidationError(table, column, 'must be a JSON object or null/undefined');
  }
  return parsed as T;
}

export function reqJsonArray<T>(table: string, row: Record<string, unknown>, column: string): T[] {
  const value = row[column];
  const parsed = safeJsonParse(value, `${table}.${column}`, null);
  if (!Array.isArray(parsed)) {
    throw new SqliteRowValidationError(table, column, 'must be a JSON array');
  }
  return parsed as T[];
}

export function reqStringArray(
  table: string,
  row: Record<string, unknown>,
  column: string,
): string[] {
  const parsed = reqJsonArray<unknown>(table, row, column);
  if (!parsed.every((item): item is string => typeof item === 'string')) {
    throw new SqliteRowValidationError(table, column, 'must be a JSON array of strings');
  }
  return parsed;
}

export function reqEnum<T extends string>(
  table: string,
  row: Record<string, unknown>,
  column: string,
  allowed: readonly T[],
): T {
  const value = reqString(table, row, column);
  if (!(allowed as readonly string[]).includes(value)) {
    throw new SqliteRowValidationError(table, column, `must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

/** Canonical enum allow-lists shared between adapters and guard callers. */
// Mirrors the canonical `STEP_STATES` in @praetor/contracts and the SQLite
// `commander_steps.state` CHECK constraint. Keep in sync with both.
export const STEP_STATES = [
  'PENDING',
  'RUNNING',
  'WAITING_FOR_HUMAN',
  'WAITING_FOR_RECONCILIATION',
  'RETRY_WAIT',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'SKIPPED',
] as const;
// Mirrors KernelEffect['state'] and the `commander_effects.state` CHECK constraint.
export const EFFECT_STATES = [
  'ADMITTED',
  'COMPLETION_UNKNOWN',
  'CONFIRMED_NOT_APPLIED',
  'COMPLETED',
  'FAILED',
] as const;
export const TIMER_TYPES = ['INTERACTION_TIMEOUT', 'RETRY_DELAY', 'STEP_DEADLINE'] as const;
export const TIMER_STATES = ['PENDING', 'PROCESSING', 'FIRED', 'CANCELLED'] as const;
