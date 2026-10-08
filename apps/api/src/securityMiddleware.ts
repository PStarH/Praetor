/**
 * Security Middleware for Commander API Server
 *
 * Provides:
 * - Request ID tracking (X-Request-ID)
 * - Rate limiting (per-tenant / per-user / per-IP) — PostgreSQL authoritative
 * - Security headers (X-Content-Type-Options, X-Frame-Options, etc.)
 * - Error sanitization (don't leak internal details)
 * - Request body validation
 * - Input sanitization
 */

import type { Request, Response, NextFunction } from 'express';
import type { SqlPool } from '@praetor/kernel';
import { createVerifiedPostgresPool } from '@praetor/postgres-runtime';
import { createAuthPool, type VerifiedPoolFactory } from './authDb';
import { resolvePositiveSafeInteger } from './startupConfig';

// ============================================================================
// PostgreSQL-authoritative rate limiting
//
// Per-identity counters live in `commander_auth_rate_limits` and are consumed
// with a single atomic upsert per request, so a process restart can never reset
// an attacker's counters and concurrent replicas share the same window. No
// SQLite / Map fallback exists.
// ============================================================================

export interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export interface RateLimitBucket {
  key: string;
  windowMs: number;
}

export interface RateLimitStore {
  consume(buckets: readonly RateLimitBucket[]): Promise<RateLimitEntry[]>;
  cleanup(now: number): Promise<number>;
}

const CONSUME_RATE_LIMIT_SQL = [
  'INSERT INTO commander_auth_rate_limits (bucket_key, count, reset_at)',
  "VALUES ($1, 1, clock_timestamp() + ($2 * interval '1 millisecond'))",
  'ON CONFLICT (bucket_key) DO UPDATE SET',
  'count = CASE WHEN commander_auth_rate_limits.reset_at <= clock_timestamp() THEN 1 ELSE commander_auth_rate_limits.count + 1 END,',
  "reset_at = CASE WHEN commander_auth_rate_limits.reset_at <= clock_timestamp() THEN clock_timestamp() + ($2 * interval '1 millisecond') ELSE commander_auth_rate_limits.reset_at END",
  'RETURNING count, EXTRACT(EPOCH FROM reset_at) * 1000 AS "resetAt"',
].join('\n');

export class PostgresRateLimitStore implements RateLimitStore {
  constructor(private readonly pool: SqlPool) {}

  async consume(buckets: readonly RateLimitBucket[]): Promise<RateLimitEntry[]> {
    if (buckets.length === 0) return [];
    const client = await this.pool.connect();
    let transactionStarted = false;
    let releaseError: Error | boolean | undefined;
    try {
      await client.query('BEGIN');
      transactionStarted = true;
      const entries: RateLimitEntry[] = [];
      for (const bucket of buckets) {
        const result = await client.query<RateLimitEntry>(CONSUME_RATE_LIMIT_SQL, [
          bucket.key,
          bucket.windowMs,
        ]);
        const row = result.rows[0];
        if (!row) throw new Error('RATE_LIMIT_RECORD_MISSING');
        entries.push({ count: Number(row.count), resetAt: Number(row.resetAt) });
      }
      await client.query('COMMIT');
      return entries;
    } catch (error) {
      releaseError = error instanceof Error ? error : true;
      if (transactionStarted) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          releaseError = rollbackError instanceof Error ? rollbackError : true;
        }
      }
      throw error;
    } finally {
      await client.release(releaseError);
    }
  }

  async cleanup(now: number): Promise<number> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<{ count: string }>(
        'DELETE FROM commander_auth_rate_limits WHERE reset_at <= to_timestamp($1 / 1000.0) RETURNING bucket_key',
        [now],
      );
      return result.rowCount ?? 0;
    } finally {
      await client.release();
    }
  }
}

export function createRateLimitStoreFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  createPool: VerifiedPoolFactory = createVerifiedPostgresPool,
): RateLimitStore {
  return new PostgresRateLimitStore(createAuthPool(environment, createPool));
}

let sharedRateLimitStore: RateLimitStore | undefined;

function getRateLimitStore(): RateLimitStore {
  sharedRateLimitStore ??= createRateLimitStoreFromEnvironment();
  return sharedRateLimitStore;
}

export function setRateLimitStoreForTesting(store: RateLimitStore): void {
  sharedRateLimitStore = store;
}

export async function initRateLimitStore(): Promise<void> {
  getRateLimitStore();
}

export function closeRateLimitStore(): void {
  sharedRateLimitStore = undefined;
}

export function _resetRateLimitStoreForTesting(): void {
  sharedRateLimitStore = undefined;
}

// ============================================================================
// Request ID Tracking
// ============================================================================

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
      startTime?: number;
    }
  }
}

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  req.requestId = (req.headers['x-request-id'] as string) ?? crypto.randomUUID();
  req.startTime = Date.now();
  // AUDIT F-B-4: the middleware generated the id but never emitted it, so
  // callers could not correlate a response with server logs. Echo it back.
  res.setHeader('X-Request-ID', req.requestId);
  next();
}

// ============================================================================
// Security Headers
// ============================================================================

export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  // Security: X-XSS-Protection is deprecated and can introduce vulnerabilities
  // in older browsers. Per OWASP: set to 0 and rely on CSP instead.
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
  );
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}

// ============================================================================
// Rate Limiting (per-identity: tenant → user → IP, PostgreSQL authority)
// ============================================================================

interface RateLimitIdentity {
  ip: string;
  userId?: string;
  tenantId?: string;
}

/**
 * AUTH-02: identity resolved by `apiKeyIdentityMiddleware` from the canonical
 * API-key validation, before this limiter runs. It is deliberately a dedicated
 * field rather than `req.apiKeyId` / `req.tenantId`: those are authorization
 * identity and must stay unset until `authMiddleware` has validated the key.
 */
export interface ResolvedRateLimitApiKey {
  /** Stable key id (`ak_…`) — never the caller-supplied key name. */
  id: string;
  tenantId?: string;
}

declare global {
  namespace Express {
    interface Request {
      rateLimitApiKey?: ResolvedRateLimitApiKey;
    }
  }
}

// Mirrors the tenant-id validation in core/runtime/tenantContext.ts.
const TENANT_ID_RE = /^[a-zA-Z0-9._:-]{1,128}$/;

type RateLimitTier = 'health' | 'read' | 'write';

const TIER_MULTIPLIER: Record<RateLimitTier, number> = {
  health: 10,
  read: 1,
  write: 0.25,
};

/**
 * Paths that legitimately deserve the relaxed 'health' budget. Exact matches on
 * the canonical pathname only — enumerated from the real mounts in index.ts
 * (`/health`, `/ready`, `/metrics`, `/v1/health`, `/health/detailed`).
 */
const HEALTH_PATHS = new Set([
  '/health',
  '/health/detailed',
  '/ready',
  '/metrics',
  '/v1/health',
  '/system/status',
]);

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Classify a request into a rate-limit tier.
 *
 * AUTH-01: this used to test a non-anchored pattern against `req.url`, the raw
 * request target *including the query string*. `POST /api/v1/execute?next=/health`
 * therefore matched `health` and was granted the 10x budget instead of the 0.25x
 * write budget — a caller could pick their own limit.
 *
 * It also mis-classified the write tier: the only pattern was
 * `/api/v1/(execute|plan|memory)`, while the real service mounts dozens of
 * mutating routes (`/orchestrator/execute`, `/api/pipeline/execute`,
 * `/api/workflows/:id/execute`, …), so almost every write was billed as a read.
 *
 * Fixed on both counts: the tier is derived from the **canonical pathname** plus
 * the HTTP **method**, which is exact by construction and cannot be influenced by
 * a query string. Every mutating method is a write, so the tighter 0.25x budget
 * now applies to the whole mutating surface rather than to three legacy paths.
 */
function classifyTier(pathname: string, method: string = 'GET'): RateLimitTier {
  if (HEALTH_PATHS.has(pathname)) return 'health';
  if (MUTATING_METHODS.has(method.toUpperCase())) return 'write';
  return 'read';
}

const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
// AUTH-05: validate each quota as a finite positive safe integer. `parseInt`
// turned "" / "abc" / "1.5" / "-1" / "5x" / overflow into NaN or a truncated
// value, and `count > NaN` is always false — a typo silently disabled the
// limit. An invalid value now throws at module load, so the process refuses to
// start instead of serving unlimited traffic.
const RATE_LIMIT_MAX = resolvePositiveSafeInteger(process.env, 'API_RATE_LIMIT', 120);
const RATE_LIMIT_USER_MAX = resolvePositiveSafeInteger(
  process.env,
  'API_RATE_LIMIT_USER',
  RATE_LIMIT_MAX,
);
const RATE_LIMIT_TENANT_MAX = resolvePositiveSafeInteger(
  process.env,
  'API_RATE_LIMIT_TENANT',
  RATE_LIMIT_MAX,
);

// Expired rows are swept periodically; PostgreSQL owns storage so the Map
// eviction machinery from the legacy in-memory implementation is gone.
setInterval(() => {
  const now = Date.now();
  try {
    const store = sharedRateLimitStore;
    if (store) void store.cleanup(now).catch(() => undefined);
  } catch (e) {
    process.stderr.write(`[RateLimit] Cleanup failed: ${(e as Error).message}\n`);
  }
}, 300_000).unref();

function getClientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

function extractTenantId(req: Request): string | undefined {
  // AUDIT-B: only an authenticated principal may feed the tenant bucket. The
  // raw X-Tenant-ID header must NEVER be used — this middleware runs before
  // authMiddleware/tenantContextMiddleware, so an unauthenticated (or
  // cross-tenant) caller could otherwise exhaust another tenant's quota by
  // spoofing the header. `req.user.tenantId` is the verified JWT claim parsed
  // earlier; `req.rateLimitApiKey.tenantId` comes from the canonical API-key
  // lookup (AUTH-02); `req.tenantId` is bound by authMiddleware after this
  // limiter, so it is only ever set by the API-key anon default.
  const resolved =
    req.user?.tenantId ??
    req.rateLimitApiKey?.tenantId ??
    (req as Request & { tenantId?: string }).tenantId;
  if (typeof resolved !== 'string') return undefined;
  if (!TENANT_ID_RE.test(resolved)) return undefined;
  return resolved;
}

function buildRateLimitIdentity(req: Request): RateLimitIdentity {
  return {
    ip: getClientIp(req),
    // AUTH-02: the API-key principal bucket is keyed on the stable key id, so
    // the same key from many IPs shares one bucket and two keys that reuse a
    // name do not.
    userId: req.user?.id ?? req.rateLimitApiKey?.id ?? req.apiKeyId,
    tenantId: extractTenantId(req),
  };
}

interface RateLimitScope {
  key: string;
  prefix: 'tenant' | 'user' | 'ip';
  max: number;
}

function buildScopes(identity: RateLimitIdentity, tier: RateLimitTier): RateLimitScope[] {
  const scopes: RateLimitScope[] = [];
  if (identity.tenantId) {
    scopes.push({
      key: `tenant:${identity.tenantId}`,
      prefix: 'tenant',
      max: Math.max(1, Math.floor(RATE_LIMIT_TENANT_MAX * TIER_MULTIPLIER[tier])),
    });
  }
  if (identity.userId) {
    scopes.push({
      key: `user:${identity.userId}`,
      prefix: 'user',
      max: Math.max(1, Math.floor(RATE_LIMIT_USER_MAX * TIER_MULTIPLIER[tier])),
    });
  }
  if (scopes.length === 0) {
    scopes.push({
      key: `ip:${identity.ip}`,
      prefix: 'ip',
      max: Math.max(1, Math.floor(RATE_LIMIT_MAX * TIER_MULTIPLIER[tier])),
    });
  }
  return scopes;
}

export async function rateLimitMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const identity = buildRateLimitIdentity(req);
  const now = Date.now();

  // Per-tier per-identity, atomically consumed in PostgreSQL.
  // `req.path` is the canonical pathname (no query string); `req.url` is not, and
  // using it let a query parameter choose the tier. See classifyTier.
  const tier = classifyTier(req.path ?? '/', req.method ?? 'GET');
  const scopes = buildScopes(identity, tier);

  let entries: RateLimitEntry[];
  try {
    entries = await getRateLimitStore().consume(
      scopes.map((scope) => ({ key: scope.key, windowMs: RATE_LIMIT_WINDOW_MS })),
    );
  } catch (error) {
    // Fail closed: an unavailable rate-limit authority must not silently allow
    // unlimited traffic. Reject the request rather than degrade to local state.
    process.stderr.write(
      `[RateLimit] PostgreSQL authority unavailable: ${(error as Error).message}\n`,
    );
    res.setHeader('Retry-After', '60');
    res.status(503).json({
      error: 'Rate limit authority unavailable. Retry later.',
      retryAfter: 60,
    });
    return;
  }

  let blockingScope:
    { prefix: 'tenant' | 'user' | 'ip'; entry: RateLimitEntry; max: number } | undefined;
  let primaryScope: RateLimitScope | undefined;
  let primaryEntry: RateLimitEntry | undefined;

  scopes.forEach((scope, index) => {
    const entry = entries[index]!;
    if (!blockingScope && entry.count > scope.max) {
      blockingScope = { prefix: scope.prefix, entry, max: scope.max };
    }
    if (
      !primaryScope ||
      (scope.prefix === 'user' && primaryScope.prefix !== 'user') ||
      (scope.prefix === 'tenant' && primaryScope.prefix === 'ip')
    ) {
      primaryScope = scope;
      primaryEntry = entry;
    }
  });

  const finalScope = primaryScope!;
  const finalEntry = primaryEntry!;

  res.setHeader('X-RateLimit-Limit', finalScope.max);
  res.setHeader('X-RateLimit-Tier', tier);
  res.setHeader('X-RateLimit-Remaining', Math.max(0, finalScope.max - finalEntry.count));
  res.setHeader('X-RateLimit-Reset', Math.ceil(finalEntry.resetAt / 1000));

  if (blockingScope) {
    res.setHeader('X-RateLimit-Reason', `per-${blockingScope.prefix}-tier-${tier}`);
    process.stderr.write(
      `[RateLimit] prefix=${blockingScope.prefix} identity=${
        blockingScope.prefix === 'ip'
          ? identity.ip
          : blockingScope.prefix === 'user'
            ? identity.userId
            : identity.tenantId
      } tier=${tier} count=${blockingScope.entry.count} max=${blockingScope.max} url=${req.url ?? '/'}\n`,
    );
    res.status(429).json({
      error: 'Too many requests',
      retryAfter: Math.ceil((blockingScope.entry.resetAt - now) / 1000),
      tier,
      limit: blockingScope.max,
    });
    return;
  }

  next();
}

// ============================================================================
// Error Sanitization
// ============================================================================

interface SanitizedError {
  status: number;
  message: string;
  requestId?: string;
}

export function sanitizeError(err: Error, requestId?: string): SanitizedError {
  if (err.name === 'ValifyError') {
    return { status: 400, message: 'Validation error', requestId };
  }
  if (err.message?.includes('JSON')) {
    return { status: 400, message: 'Invalid JSON in request body', requestId };
  }
  if (
    err.message?.includes('too large') ||
    (err as Error & { type?: string }).type === 'entity.too.large'
  ) {
    return { status: 413, message: 'Request body too large', requestId };
  }
  return {
    status: 500,
    message: 'Internal server error',
    requestId,
  };
}

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  const sanitized = sanitizeError(err, req.requestId);
  process.stderr.write(`[API Error] ${req.method} ${req.path} — ${err.message}\n${err.stack}\n`);
  res.status(sanitized.status).json({
    error: sanitized.message,
    requestId: sanitized.requestId,
  });
}

// ============================================================================
// Input Sanitization
// ============================================================================

/**
 * Sanitize string input — strip control characters and limit length.
 */
export function sanitizeString(input: unknown, maxLength = 10000): string {
  if (typeof input !== 'string') return '';
  return input.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').slice(0, maxLength);
}

/**
 * Validate that a value is a non-empty string.
 */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Validate that a value is a valid UUID.
 */
export function isValidUUID(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Validate that a value is a valid project ID (alphanumeric + hyphens).
 */
export function isValidProjectId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  return /^[a-zA-Z0-9_-]{1,100}$/.test(value);
}
