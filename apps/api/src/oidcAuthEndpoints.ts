import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  OIDCAuthPlugin,
  createOIDCPluginFromEnv,
  type AuthPluginResult,
  type AuthRole,
} from '@praetor/core';
import {
  findUserByEmail,
  findUserByOidcIdentity,
  createUser,
  bindUserToOidcIdentity,
  updateLastLogin,
  updateUser,
  toSafeUserPublic,
  hasRole,
  type UserRole,
} from './userStore';
import { signAccessToken, signRefreshToken } from './jwtMiddleware';
import { atomicWriteFileSync, readJsonFileSafe, isPlainObjectJson } from './atomicWrite';
import { isMultiTenantEnabled, validateTenantId } from '@praetor/core/runtime/tenantContext';

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  next();
}

function requireRole(requiredRole: UserRole = 'admin') {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user || !hasRole(req.user.role, requiredRole)) {
      res.status(403).json({ error: 'Insufficient privileges' });
      return;
    }
    next();
  };
}

/**
 * Validate OIDC issuer: must be https URL; optional host allowlist via
 * OIDC_ISSUER_HOST_ALLOWLIST (comma-separated).
 */
export function validateOidcIssuer(issuer: string): string | undefined {
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    return 'issuer must be a valid URL';
  }
  if (url.protocol !== 'https:') {
    return 'issuer must use https';
  }
  const allowlist =
    process.env.OIDC_ISSUER_HOST_ALLOWLIST?.split(',')
      .map((s) => s.trim())
      .filter(Boolean) ?? [];
  if (allowlist.length > 0 && !allowlist.includes(url.hostname)) {
    return 'issuer hostname must be one of: ' + allowlist.join(', ');
  }
  return undefined;
}

// ============================================================================
// OIDC Configuration persistence
// ============================================================================

const CONFIG_DIR = path.resolve(process.cwd(), '.commander');
const CONFIG_FILE = path.join(CONFIG_DIR, 'oidc-config.json');

export interface OIDCRuntimeConfig {
  enabled: boolean;
  issuer: string;
  clientId: string;
  roleClaim: string;
  adminRoles: string[];
  operatorRoles: string[];
  tenantClaim: string;
  defaultTenantId?: string;
  redirectUri: string;
}

function loadConfigFromFile(): Partial<OIDCRuntimeConfig> | null {
  // REL-4: 损坏或错形隔离，禁止 silent null → 下次 save 抹掉 OIDC 配置。
  return readJsonFileSafe<Partial<OIDCRuntimeConfig> | null>(CONFIG_FILE, null, isPlainObjectJson);
}

function saveConfigToFile(config: OIDCRuntimeConfig): void {
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    atomicWriteFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  } catch (err) {
    process.stderr.write(
      '[oidcAuthEndpoints] Failed to write ' + CONFIG_FILE + ': ' + String(err) + '\n',
    );
  }
}

function buildWebOrigin(): string {
  const webPort = process.env.WEB_PORT ?? '5173';
  return process.env.WEB_ORIGIN ?? 'http://localhost:' + webPort;
}

/**
 * Resolve effective OIDC configuration. Environment variables take precedence
 * over the persisted file, so operators can override settings without touching
 * the UI-managed config.
 */
export function getOIDCConfig(): OIDCRuntimeConfig | null {
  const envPlugin = createOIDCPluginFromEnv();
  const file = loadConfigFromFile();
  const effective = file ?? {};

  const issuer = process.env.OIDC_ISSUER ?? effective.issuer;
  const clientId = process.env.OIDC_CLIENT_ID ?? effective.clientId;
  if (!issuer || !clientId) return null;

  return {
    enabled:
      process.env.OIDC_ENABLED === 'true'
        ? true
        : process.env.OIDC_ENABLED === 'false'
          ? false
          : (effective.enabled ?? true),
    issuer,
    clientId,
    roleClaim: process.env.OIDC_ROLE_CLAIM ?? effective.roleClaim ?? 'roles',
    adminRoles: process.env.OIDC_ADMIN_ROLES
      ? process.env.OIDC_ADMIN_ROLES.split(',').map((s) => s.trim())
      : (effective.adminRoles ?? ['admin']),
    operatorRoles: process.env.OIDC_OPERATOR_ROLES
      ? process.env.OIDC_OPERATOR_ROLES.split(',').map((s) => s.trim())
      : (effective.operatorRoles ?? ['operator', 'developer']),
    tenantClaim: process.env.OIDC_TENANT_CLAIM ?? effective.tenantClaim ?? 'tenant_id',
    defaultTenantId:
      process.env.OIDC_DEFAULT_TENANT_ID ??
      process.env.COMMANDER_DEFAULT_TENANT_ID ??
      effective.defaultTenantId,
    redirectUri: effective.redirectUri ?? buildWebOrigin() + '/login',
  };
}

function buildPublicConfig(config: OIDCRuntimeConfig) {
  return {
    enabled: config.enabled,
    issuer: config.issuer,
    clientId: config.clientId,
    roleClaim: config.roleClaim,
    adminRoles: config.adminRoles,
    operatorRoles: config.operatorRoles,
    tenantClaim: config.tenantClaim,
    redirectUri: config.redirectUri,
  };
}

function buildSettingsConfig(config: OIDCRuntimeConfig) {
  return {
    ...buildPublicConfig(config),
    defaultTenantId: config.defaultTenantId,
  };
}

// ============================================================================
// Validation schemas
// ============================================================================

const exchangeSchema = z.object({
  idToken: z.string().min(1, 'idToken is required'),
});

const settingsSchema = z.object({
  enabled: z.boolean(),
  issuer: z
    .string()
    .url()
    .max(512)
    .superRefine((issuer, ctx) => {
      const err = validateOidcIssuer(issuer);
      if (err) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: err });
      }
    }),
  clientId: z.string().min(1).max(512),
  roleClaim: z.string().min(1).max(128).default('roles'),
  adminRoles: z.array(z.string().min(1)).default(['admin']),
  operatorRoles: z.array(z.string().min(1)).default(['operator', 'developer']),
  tenantClaim: z.string().min(1).max(128).default('tenant_id'),
  defaultTenantId: z
    .string()
    .min(1)
    .max(128)
    .superRefine((tenantId, ctx) => {
      try {
        validateTenantId(tenantId);
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'defaultTenantId is invalid' });
      }
    })
    .optional(),
  redirectUri: z.string().min(1).max(512),
});

function resolveOIDCTenantId(
  result: AuthPluginResult,
  config: OIDCRuntimeConfig,
): string | undefined {
  const claimedTenant = result.claims?.[config.tenantClaim];
  if (claimedTenant !== undefined) {
    return typeof claimedTenant === 'string' && claimedTenant.length > 0
      ? claimedTenant
      : undefined;
  }
  if (isMultiTenantEnabled()) return undefined;
  return config.defaultTenantId;
}

// ============================================================================
// Router
// ============================================================================

export interface OIDCAuthRouterOptions {
  authenticate?: (idToken: string, config: OIDCRuntimeConfig) => Promise<AuthPluginResult | null>;
}

export function createOIDCAuthRouter(options: OIDCAuthRouterOptions = {}): Router {
  const router = Router();

  /**
   * GET /api/auth/oidc/config
   *
   * Public endpoint that advertises whether OIDC SSO is enabled and the
   * non-sensitive provider details the UI needs to initiate login.
   */
  router.get('/api/auth/oidc/config', (_req: Request, res: Response) => {
    const config = getOIDCConfig();
    if (!config) {
      res.json({ enabled: false, issuer: null, clientId: null, redirectUri: null });
      return;
    }
    res.json(buildPublicConfig(config));
  });

  /**
   * POST /api/auth/oidc/exchange
   *
   * Exchanges a verified OIDC ID token for Commander JWT credentials.
   * Creates a local account on first login if the email does not exist.
   */
  router.post('/api/auth/oidc/exchange', async (req: Request, res: Response) => {
    const parsed = exchangeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', details: parsed.error.issues });
      return;
    }

    const config = getOIDCConfig();
    if (!config || !config.enabled) {
      res.status(400).json({ error: 'OIDC is not configured or disabled' });
      return;
    }

    let result;
    try {
      if (options.authenticate) {
        result = await options.authenticate(parsed.data.idToken, config);
      } else {
        const plugin = new OIDCAuthPlugin({
          issuer: config.issuer,
          clientId: config.clientId,
          roleClaim: config.roleClaim,
          adminRoles: config.adminRoles,
          operatorRoles: config.operatorRoles,
        });
        result = await plugin.authenticate(parsed.data.idToken);
      }
    } catch (err) {
      process.stderr.write('[oidcAuthEndpoints] OIDC exchange error: ' + String(err) + '\n');
      res.status(401).json({ error: 'OIDC token validation failed' });
      return;
    }

    if (!result) {
      res.status(401).json({ error: 'Invalid OIDC token' });
      return;
    }

    const issuer = result.claims?.iss;
    const subject = result.userId;
    const claimedSubject = result.claims?.sub;
    if (
      typeof issuer !== 'string' ||
      issuer !== config.issuer ||
      !subject ||
      claimedSubject !== subject
    ) {
      res.status(401).json({ error: 'OIDC identity claims are invalid' });
      return;
    }

    const tenantId = resolveOIDCTenantId(result, config);
    try {
      if (!tenantId || tenantId === '__default__') throw new Error('missing or reserved tenant id');
      validateTenantId(tenantId);
    } catch {
      res.status(401).json({ error: 'OIDC tenant claim is invalid' });
      return;
    }

    // Resolve by the durable IdP identity. A verified email may bootstrap a
    // one-time link for an existing local account, but is never the login key.
    let localUser = await findUserByOidcIdentity(issuer, subject);
    if (!localUser) {
      const oidcEmail = result.claims?.email;
      const emailVerified = result.claims?.email_verified === true;
      const emailUser =
        typeof oidcEmail === 'string' && oidcEmail.length > 0
          ? await findUserByEmail(oidcEmail)
          : undefined;

      if (emailUser) {
        if (!emailVerified) {
          res.status(409).json({ error: 'OIDC email must be verified before account linking' });
          return;
        }
        const linked = await bindUserToOidcIdentity(emailUser.id, issuer, subject);
        if ('error' in linked) {
          res.status(409).json({ error: linked.error });
          return;
        }
        localUser = await findUserByOidcIdentity(issuer, subject);
      } else {
        const created = await createUser({
          username: result.username,
          email: result.username,
          // Random local password; authentication always happens via OIDC.
          password: randomUUID(),
          role: result.role as UserRole,
          oidcIssuer: issuer,
          oidcSubject: subject,
        });
        if ('error' in created) {
          res.status(409).json({ error: created.error });
          return;
        }
        localUser = await findUserByOidcIdentity(issuer, subject);
      }
    }

    // If the OIDC provider changed the linked user's role, keep it in sync.
    if (localUser && localUser.role !== result.role) {
      await updateUser(localUser.id, { role: result.role as UserRole });
      localUser = await findUserByOidcIdentity(issuer, subject);
    }

    if (!localUser) {
      res.status(500).json({ error: 'Failed to resolve local user' });
      return;
    }

    await updateLastLogin(localUser.id);

    const authUser = {
      id: localUser.id,
      username: localUser.username,
      role: localUser.role as AuthRole,
      authVersion: localUser.authVersion,
      tenantId,
    };

    res.json({
      token: signAccessToken(authUser),
      refreshToken: await signRefreshToken(authUser),
      user: toSafeUserPublic(localUser),
    });
  });

  /**
   * GET /api/auth/oidc/settings
   *
   * Returns the persisted OIDC configuration (admin only).
   */
  router.get(
    '/api/auth/oidc/settings',
    requireAuth,
    requireRole('admin'),
    (_req: Request, res: Response) => {
      const config = getOIDCConfig();
      if (!config) {
        res.json({
          enabled: false,
          issuer: '',
          clientId: '',
          roleClaim: 'roles',
          adminRoles: ['admin'],
          operatorRoles: ['operator', 'developer'],
          tenantClaim: 'tenant_id',
          redirectUri: buildWebOrigin() + '/login',
        });
        return;
      }
      res.json(buildSettingsConfig(config));
    },
  );

  /**
   * PUT /api/auth/oidc/settings
   *
   * Persists OIDC configuration from the admin UI. Environment variables still
   * take precedence at runtime, but the saved file is used when env vars are
   * not set.
   */
  router.put(
    '/api/auth/oidc/settings',
    requireAuth,
    requireRole('admin'),
    (req: Request, res: Response) => {
      const parsed = settingsSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Validation error', details: parsed.error.issues });
        return;
      }

      const toSave = { ...parsed.data };
      // Env is authoritative for adminRoles when set.
      if (process.env.OIDC_ADMIN_ROLES) {
        toSave.adminRoles = process.env.OIDC_ADMIN_ROLES.split(',')
          .map((s) => s.trim())
          .filter(Boolean);
      }

      saveConfigToFile(toSave);
      res.json({ status: 'saved', config: buildSettingsConfig(toSave) });
    },
  );

  return router;
}
