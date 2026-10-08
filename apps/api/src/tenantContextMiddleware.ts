import type { Request, Response, NextFunction } from 'express';
import { runWithTenant, TenantIsolationError } from '@praetor/core/runtime/tenantContext';
import { isProductionEnv } from './envSignal';
import { isEnterpriseProfile } from './profileSignal';

/**
 * Tenant ID format: alphanumeric, hyphen, underscore, dot, colon. Must not be
 * empty and must not contain `..` (negative lookahead) so a tenant id can never
 * be used for path traversal in per-tenant storage backends (AUTH-8).
 */
const TENANT_ID_RE = /^(?!.*\.\.)[a-zA-Z0-9._:-]{1,128}$/;

function readHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Production or enterprise profile — ambient X-Tenant-ID must not establish identity. */
function rejectsAmbientTenantHeader(): boolean {
  return isProductionEnv() || isEnterpriseProfile();
}

/**
 * Express middleware that resolves the authoritative tenant for the request and
 * binds the async tenant context for the remainder of the pipeline.
 *
 * Security model (AUTH-2 / B4 — the KC-1 tenant leg):
 *   - The tenant binding set by authMiddleware from an authenticated API key
 *     or JWT (`req.tenantId`) is authoritative.
 *   - A client-supplied `X-Tenant-ID` header may only *match* that binding; it
 *     can never widen it. A mismatch is rejected with 403.
 *   - When there is no authenticated tenant binding (an unauthenticated caller,
 *     or a JWT identity that carries no tenant claim), a client `X-Tenant-ID` is
 *     NOT trusted to establish tenant identity in production or the enterprise
 *     profile — that is the header-spoofing cross-tenant hole. Such requests
 *     proceed with no tenant (tenant-scoped resources then fail closed). In
 *     non-production standard profile the header is honored for local/test
 *     ergonomics.
 *
 * On success `req.tenantId` is set to the resolved tenant so downstream handlers
 * can trust it without ever re-reading the header. Malformed ids are rejected 400.
 */
export function tenantContextMiddleware(req: Request, res: Response, next: NextFunction): void {
  const mutableReq = req as Request & { tenantId?: string };
  const principalTenant = mutableReq.tenantId;
  const headerTenant = readHeader(req.headers['x-tenant-id']);

  // Format-validate any id we might act on before it can reach a storage path.
  for (const value of [principalTenant, headerTenant]) {
    if (typeof value === 'string' && value.length > 0 && !TENANT_ID_RE.test(value)) {
      const err = new TenantIsolationError(
        `Invalid tenant id: must be 1-128 chars matching ${TENANT_ID_RE.source}`,
      );
      res.status(400).json({ error: err.name, message: err.message });
      return;
    }
  }

  // Case 1 — an authenticated tenant binding is authoritative.
  if (typeof principalTenant === 'string' && principalTenant.length > 0) {
    if (
      typeof headerTenant === 'string' &&
      headerTenant.length > 0 &&
      headerTenant !== principalTenant
    ) {
      res.status(403).json({
        error: 'TenantIsolationError',
        message: 'X-Tenant-ID does not match the authenticated tenant binding.',
      });
      return;
    }
    mutableReq.tenantId = principalTenant;
    runWithTenant(principalTenant, () => next());
    return;
  }

  // Case 2 — no authenticated tenant binding: never trust a client header to
  // establish tenant identity in production / enterprise (header-spoof hole).
  if (typeof headerTenant === 'string' && headerTenant.length > 0) {
    if (rejectsAmbientTenantHeader()) {
      res.status(403).json({
        error: 'TenantIsolationError',
        message:
          'A tenant-bound authenticated identity is required; X-Tenant-ID alone is not accepted in production or enterprise profile.',
      });
      return;
    }
    mutableReq.tenantId = headerTenant;
    runWithTenant(headerTenant, () => next());
    return;
  }

  // Case 3 — no tenant at all → single-tenant / downstream default.
  next();
}
