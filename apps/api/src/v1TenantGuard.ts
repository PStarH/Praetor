/**
 * WS3 §3.2 — /v1 fail-closed tenant guard.
 *
 * Enforces the tenant-identity table on /v1 product paths in the enterprise
 * profile. Mounted AFTER authMiddleware (so req.apiKeyId / req.tenantId are
 * already bound for the API-key path) and AFTER jwtMiddleware (which populates
 * req.user, and which — on enterprise /v1 — has already rejected invalid
 * Bearer tokens with 401 INVALID_TOKEN before this guard runs).
 *
 * fail-closed table (spec §3.2):
 *   | no credentials                                   | 401 AUTHENTICATION_REQUIRED |
 *   | invalid / expired / non-access Bearer JWT        | 401 INVALID_TOKEN           |  (jwtMiddleware)
 *   | valid JWT but no tenant_id claim                 | 401 TENANT_CLAIM_REQUIRED   |
 *   | tenant_id not provisioned in TenantProvider      | 403 TENANT_NOT_FOUND        |
 *   | X-Tenant-ID differs from authenticated tenant    | 403 TENANT_MISMATCH         |
 *   | cross-tenant run access                          | 404 RUN_NOT_FOUND           |  (route handler)
 *
 * In the standard profile this guard is a no-op: the existing
 * tenantContextMiddleware + requiredTenant flow handles /v1 tenant resolution
 * for local/dev ergonomics. Row 6 (cross-tenant 404) is enforced by the route
 * handlers via kernel.getRun(runId, tenantId) returning null — the guard sets
 * req.tenantId authoritatively so handlers never re-read the client header.
 *
 * Single-tenant escape hatch: when the operator runs the enterprise profile
 * with NullTenantProvider (no tenants configured), COMMANDER_DEFAULT_TENANT_ID
 * permits the one allowed tenant. This keeps single-tenant enterprise deploys
 * working without a tenant config file.
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { getGlobalTenantProvider } from '@praetor/core/runtime';
import { isEnterpriseProfile } from './profileSignal';

/** Tenant id format — mirrors tenantContextMiddleware (AUTH-8). */
const TENANT_ID_RE = /^(?!.*\.\.)[a-zA-Z0-9._:-]{1,128}$/;

/** /v1 sub-paths that are public metadata/health and skip tenant enforcement. */
const V1_PUBLIC_PATHS = new Set<string>(['/v1/openapi.json', '/v1/health']);

function isV1ProductPath(reqPath: string): boolean {
  if (reqPath !== '/v1' && !reqPath.startsWith('/v1/')) return false;
  return !V1_PUBLIC_PATHS.has(reqPath);
}

function readHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Whether a tenant id is known to the configured TenantProvider, OR matches the
 * operator-set single-tenant default. The default-tenant escape hatch keeps
 * single-tenant enterprise deploys (NullTenantProvider) working without a
 * tenant config file.
 */
function isTenantKnown(tenantId: string): boolean {
  const provider = getGlobalTenantProvider();
  if (provider.getTenantConfig(tenantId)) return true;
  const defaultTenant = process.env.COMMANDER_DEFAULT_TENANT_ID;
  return (
    typeof defaultTenant === 'string' && defaultTenant.length > 0 && defaultTenant === tenantId
  );
}

function reject(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

/**
 * Enterprise-profile /v1 tenant guard. No-op outside the enterprise profile or
 * on non-/v1 / public-/v1 paths.
 */
export function v1TenantGuard(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!isEnterpriseProfile()) return next();
    if (!isV1ProductPath(req.path)) return next();

    const mutableReq = req as Request & { tenantId?: string; apiKeyId?: string };

    // ── JWT access-token path ──────────────────────────────────────────────
    // jwtMiddleware populated req.user. On enterprise /v1 it has already
    // rejected invalid/expired/non-access Bearer tokens, so a present req.user
    // implies a verified access token.
    if (req.user) {
      const tenantId = req.user.tenantId;
      // Row 3: enterprise access tokens must carry a valid tenant_id claim.
      if (typeof tenantId !== 'string' || tenantId.length === 0 || !TENANT_ID_RE.test(tenantId)) {
        return reject(
          res,
          401,
          'TENANT_CLAIM_REQUIRED',
          'Enterprise /v1 access tokens must carry a valid tenant_id claim.',
        );
      }
      // Row 4: the tenant must be provisioned (or match the single-tenant default).
      if (!isTenantKnown(tenantId)) {
        return reject(res, 403, 'TENANT_NOT_FOUND', `Tenant '${tenantId}' is not provisioned.`);
      }
      // Row 5: X-Tenant-ID may only match, never widen.
      const headerTenant = readHeader(req.headers['x-tenant-id']);
      if (
        typeof headerTenant === 'string' &&
        headerTenant.length > 0 &&
        headerTenant !== tenantId
      ) {
        return reject(
          res,
          403,
          'TENANT_MISMATCH',
          'X-Tenant-ID does not match the authenticated tenant binding.',
        );
      }
      // Authoritative — downstream handlers trust req.tenantId without
      // re-reading the header (AUTH-2 / B4).
      mutableReq.tenantId = tenantId;
      return next();
    }

    // ── API-key path ───────────────────────────────────────────────────────
    // authMiddleware validated the key and bound req.apiKeyId + req.tenantId.
    if (mutableReq.apiKeyId) {
      const tenantId = mutableReq.tenantId;
      if (typeof tenantId !== 'string' || tenantId.length === 0) {
        return reject(
          res,
          401,
          'AUTHENTICATION_REQUIRED',
          'API keys used on /v1 must be tenant-bound.',
        );
      }
      if (!TENANT_ID_RE.test(tenantId) || !isTenantKnown(tenantId)) {
        return reject(res, 403, 'TENANT_NOT_FOUND', `Tenant '${tenantId}' is not provisioned.`);
      }
      const headerTenant = readHeader(req.headers['x-tenant-id']);
      if (
        typeof headerTenant === 'string' &&
        headerTenant.length > 0 &&
        headerTenant !== tenantId
      ) {
        return reject(
          res,
          403,
          'TENANT_MISMATCH',
          'X-Tenant-ID does not match the authenticated tenant binding.',
        );
      }
      return next();
    }

    // ── No authenticated principal ─────────────────────────────────────────
    // Row 1. In the real stack authMiddleware usually default-denies first;
    // this fires when auth is disabled or no keys are configured.
    return reject(
      res,
      401,
      'AUTHENTICATION_REQUIRED',
      'Authentication is required for /v1 resources (Authorization: Bearer <jwt> or X-API-Key).',
    );
  };
}
