/**
 * SCIM 2.0 endpoints for enterprise user/group provisioning.
 *
 * Persists Users and Groups per tenant using ScimStore. Data survives
 * process restarts and is isolated under data/scim/<tenantId>.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { getCurrentTenantId } from '@praetor/core/runtime/tenantContext';
import {
  ScimStore,
  ScimConflictError,
  getDefaultScimStore,
  resetDefaultScimStore,
  type ScimUser,
  type ScimGroup,
  type ScimName,
  type ScimEmail,
  type ScimMember,
  type ScimUserPatch,
  type ScimGroupPatch,
} from './scimStore';

export type { ScimUser, ScimGroup, ScimName, ScimEmail, ScimMember };

interface ScimListResponse<T> {
  schemas: string[];
  totalResults: number;
  startIndex: number;
  itemsPerPage: number;
  Resources: T[];
}

function baseUrl(req: Request): string {
  const host = req.headers.host ?? 'localhost';
  const proto = req.headers['x-forwarded-proto'] ?? 'http';
  return `${proto}://${host}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function tenantId(): string {
  return getCurrentTenantId() ?? '__default__';
}

function paramId(req: Request): string {
  const id = req.params.id;
  return Array.isArray(id) ? id[0] : id;
}

function scimUserFromBody(body: unknown, base: string, id?: string): ScimUser {
  const b = (body ?? {}) as Record<string, unknown>;
  const userId = id ?? randomUUID();
  const userName = typeof b.userName === 'string' ? b.userName : `user-${userId.slice(0, 8)}`;
  const name = b.name as ScimName | undefined;
  const emails = Array.isArray(b.emails) ? (b.emails as ScimEmail[]) : undefined;
  const active = typeof b.active === 'boolean' ? b.active : true;
  const ts = nowIso();
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
    id: userId,
    userName,
    name,
    emails,
    active,
    meta: {
      resourceType: 'User',
      created: ts,
      lastModified: ts,
      location: `${base}/scim/v2/Users/${userId}`,
    },
  };
}

function scimGroupFromBody(body: unknown, base: string, id?: string): ScimGroup {
  const b = (body ?? {}) as Record<string, unknown>;
  const groupId = id ?? randomUUID();
  const displayName =
    typeof b.displayName === 'string' ? b.displayName : `group-${groupId.slice(0, 8)}`;
  const members = Array.isArray(b.members) ? (b.members as ScimMember[]) : undefined;
  const ts = nowIso();
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
    id: groupId,
    displayName,
    members,
    meta: {
      resourceType: 'Group',
      created: ts,
      lastModified: ts,
      location: `${base}/scim/v2/Groups/${groupId}`,
    },
  };
}

function toListResponse<T>(
  resources: T[],
  totalResults: number,
  startIndex: number,
  itemsPerPage: number,
): ScimListResponse<T> {
  return {
    schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
    totalResults,
    startIndex,
    itemsPerPage,
    Resources: resources,
  };
}

/**
 * SCIM pagination query params (RFC 7644 §3.4.2.4): `startIndex` defaults to 1,
 * `count` defaults to 100. Non-finite / negative input must never reach the
 * slice arithmetic (NaN silently yields an empty page); fall back to the spec
 * default instead.
 */
function paginationParam(raw: unknown, fallback: number): number {
  const parsed = Number.parseInt(typeof raw === 'string' ? raw : '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, parsed);
}

function scimError(detail: string, status: number): Record<string, unknown> {
  return {
    schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
    detail,
    status,
  };
}

function handleError(res: Response, err: unknown): void {
  if (err instanceof ScimConflictError) {
    res.status(409).json(scimError(err.message, 409));
    return;
  }
  res.status(400).json(scimError((err as Error)?.message ?? 'Invalid payload', 400));
}

// ============================================================================
// Router
// ============================================================================

export function createScimRouter(store?: ScimStore): Router {
  const scimStore = store ?? getDefaultScimStore();
  const router = Router();

  // B3: SCIM provisioning is an admin-only enterprise surface and MUST fail
  // closed. Require an authenticated admin user (JWT role) or an API key carrying
  // an admin/scim scope; otherwise 403. Without this gate the mounted
  // /scim/v2/* routes allowed anonymous provision / enumerate / delete of every
  // user (and, via the tenant fallback, of every tenant).
  router.use((req: Request, res: Response, next: NextFunction) => {
    const role = req.user?.role;
    const scopes = req.apiScopes ?? [];
    const isAdmin = role === 'admin' || role === 'super_admin';
    const hasScimScope =
      scopes.includes('scim') || scopes.includes('admin') || scopes.includes('*');
    if (!isAdmin && !hasScimScope) {
      res.status(403).json({
        schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
        status: '403',
        detail: 'SCIM provisioning requires an administrator identity.',
      });
      return;
    }
    next();
  });

  // ── Users ────────────────────────────────────────────────────────────────

  router.get('/Users', async (req: Request, res: Response) => {
    try {
      const all = await scimStore.listUsers(tenantId(), (req.query.filter as string) ?? undefined);
      const startIndex = paginationParam(req.query.startIndex, 1);
      const itemsPerPage = paginationParam(req.query.count, 100);
      const page = all.slice(startIndex - 1, startIndex - 1 + itemsPerPage);
      res.json(toListResponse(page, all.length, startIndex, itemsPerPage));
    } catch (err) {
      handleError(res, err);
    }
  });

  router.post('/Users', async (req: Request, res: Response) => {
    try {
      const user = scimUserFromBody(req.body, baseUrl(req));
      const created = await scimStore.createUser(tenantId(), user);
      res.status(201).json(created);
    } catch (err) {
      handleError(res, err);
    }
  });

  router.get('/Users/:id', async (req: Request, res: Response) => {
    try {
      const user = await scimStore.getUser(tenantId(), paramId(req));
      if (!user) {
        res.status(404).json(scimError('User not found', 404));
        return;
      }
      res.json(user);
    } catch (err) {
      handleError(res, err);
    }
  });

  router.put('/Users/:id', async (req: Request, res: Response) => {
    try {
      const patch: ScimUserPatch = {};
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (typeof b.userName === 'string') patch.userName = b.userName;
      if (b.name !== undefined) patch.name = b.name as ScimName;
      if (Array.isArray(b.emails)) patch.emails = b.emails as ScimEmail[];
      if (typeof b.active === 'boolean') patch.active = b.active;

      const updated = await scimStore.updateUser(tenantId(), paramId(req), patch);
      if (!updated) {
        res.status(404).json(scimError('User not found', 404));
        return;
      }
      res.json(updated);
    } catch (err) {
      handleError(res, err);
    }
  });

  // SCIM PatchOp (RFC 7644 §3.5.2). Supports a minimal but useful subset:
  // Replace with no path (value object), Replace on active/userName/name/emails.
  router.patch('/Users/:id', async (req: Request, res: Response) => {
    try {
      const patch = userPatchOpsToPatch(req.body);
      const updated = await scimStore.updateUser(tenantId(), paramId(req), patch);
      if (!updated) {
        res.status(404).json(scimError('User not found', 404));
        return;
      }
      res.json(updated);
    } catch (err) {
      handleError(res, err);
    }
  });

  router.delete('/Users/:id', async (req: Request, res: Response) => {
    try {
      const removed = await scimStore.deleteUser(tenantId(), paramId(req));
      if (!removed) {
        res.status(404).json(scimError('User not found', 404));
        return;
      }
      res.status(204).send();
    } catch (err) {
      handleError(res, err);
    }
  });

  // ── Groups ───────────────────────────────────────────────────────────────

  router.get('/Groups', async (req: Request, res: Response) => {
    try {
      const all = await scimStore.listGroups(tenantId(), (req.query.filter as string) ?? undefined);
      const startIndex = paginationParam(req.query.startIndex, 1);
      const itemsPerPage = paginationParam(req.query.count, 100);
      const page = all.slice(startIndex - 1, startIndex - 1 + itemsPerPage);
      res.json(toListResponse(page, all.length, startIndex, itemsPerPage));
    } catch (err) {
      handleError(res, err);
    }
  });

  router.post('/Groups', async (req: Request, res: Response) => {
    try {
      const group = scimGroupFromBody(req.body, baseUrl(req));
      const created = await scimStore.createGroup(tenantId(), group);
      res.status(201).json(created);
    } catch (err) {
      handleError(res, err);
    }
  });

  router.get('/Groups/:id', async (req: Request, res: Response) => {
    try {
      const group = await scimStore.getGroup(tenantId(), paramId(req));
      if (!group) {
        res.status(404).json(scimError('Group not found', 404));
        return;
      }
      res.json(group);
    } catch (err) {
      handleError(res, err);
    }
  });

  // Allow full replacement of group attributes (including members) via PUT.
  router.put('/Groups/:id', async (req: Request, res: Response) => {
    try {
      const existing = await scimStore.getGroup(tenantId(), paramId(req));
      if (!existing) {
        res.status(404).json(scimError('Group not found', 404));
        return;
      }
      const replacement = scimGroupFromBody(req.body, baseUrl(req), paramId(req));
      replacement.meta.created = existing.meta.created;
      replacement.meta.lastModified = nowIso();

      const patch: ScimGroupPatch = {
        displayName: replacement.displayName,
        members: replacement.members,
      };
      const updated = await scimStore.updateGroup(tenantId(), paramId(req), patch);
      if (!updated) {
        res.status(404).json(scimError('Group not found', 404));
        return;
      }
      res.json(updated);
    } catch (err) {
      handleError(res, err);
    }
  });

  router.delete('/Groups/:id', async (req: Request, res: Response) => {
    try {
      const removed = await scimStore.deleteGroup(tenantId(), paramId(req));
      if (!removed) {
        res.status(404).json(scimError('Group not found', 404));
        return;
      }
      res.status(204).send();
    } catch (err) {
      handleError(res, err);
    }
  });

  return router;
}

/** Reset SCIM stores (useful for tests). */
export async function resetScimStores(): Promise<void> {
  resetDefaultScimStore();
  try {
    await getDefaultScimStore().reset();
  } catch {
    // Ignore reset errors when the store directory does not exist yet.
  }
  resetDefaultScimStore();
}

// ── PatchOp helpers ─────────────────────────────────────────────────────────

interface ScimPatchOperation {
  op: string;
  path?: string;
  value?: unknown;
}

function userPatchOpsToPatch(body: unknown): ScimUserPatch {
  const b = (body ?? {}) as Record<string, unknown>;
  const schemas = Array.isArray(b.schemas) ? b.schemas : [];
  if (schemas.length > 0 && !schemas.includes('urn:ietf:params:scim:api:messages:2.0:PatchOp')) {
    throw new Error('Unsupported PATCH schema');
  }

  const ops = Array.isArray(b.Operations) ? (b.Operations as ScimPatchOperation[]) : [];
  const patch: ScimUserPatch = {};

  for (const op of ops) {
    const opName = typeof op.op === 'string' ? op.op.toLowerCase() : '';
    if (opName !== 'replace' && opName !== 'add') {
      throw new Error(`Unsupported PATCH op: ${op.op}`);
    }

    const pathName = typeof op.path === 'string' ? op.path.trim().toLowerCase() : '';

    if (pathName === '') {
      // Bulk replace via value object.
      const value = (op.value ?? {}) as Record<string, unknown>;
      if (typeof value.userName === 'string') patch.userName = value.userName;
      if (value.name !== undefined) patch.name = value.name as ScimName;
      if (Array.isArray(value.emails)) patch.emails = value.emails as ScimEmail[];
      if (typeof value.active === 'boolean') patch.active = value.active;
    } else if (pathName === 'active') {
      patch.active = op.value === true;
    } else if (pathName === 'username') {
      if (typeof op.value === 'string') patch.userName = op.value;
    } else if (pathName === 'name') {
      patch.name = op.value as ScimName;
    } else if (pathName === 'emails') {
      if (Array.isArray(op.value)) {
        patch.emails = op.value as ScimEmail[];
      } else if (typeof op.value === 'string') {
        patch.emails = [{ value: op.value, primary: true }];
      }
    } else {
      throw new Error(`Unsupported PATCH path: ${op.path}`);
    }
  }

  return patch;
}
