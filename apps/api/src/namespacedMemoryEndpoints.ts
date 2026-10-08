import { Router } from 'express';
import { writeProductMemory, type MemoryStore } from '@praetor/core';
import type { AuthUser } from './jwtMiddleware';
import type { UserRole } from './userStore';

type MemoryAclRole = 'reader' | 'writer' | 'admin';
type MemoryPermission = 'read' | 'write' | 'delete' | 'admin';

interface ACLEntry {
  role: MemoryAclRole;
  permissions: MemoryPermission[];
  /** Allowed namespaces; `*` grants all. */
  namespaces: string[];
}

/**
 * Namespace ACL for HTTP auth only (API-key scopes + JWT UserRole →
 * reader|writer|admin). Agent topology roles are not part of this surface.
 */
const DEFAULT_ACL: ACLEntry[] = [
  { role: 'reader', permissions: ['read'], namespaces: ['*'] },
  { role: 'writer', permissions: ['read', 'write'], namespaces: ['*'] },
  { role: 'admin', permissions: ['read', 'write', 'delete', 'admin'], namespaces: ['*'] },
];

/** Official API-key scopes → ACL roles. Agent role names are never accepted bare. */
const SCOPE_TO_ACL: Record<string, MemoryAclRole> = {
  read: 'reader',
  write: 'writer',
  admin: 'admin',
  'role:read': 'reader',
  'role:reader': 'reader',
  'role:write': 'writer',
  'role:writer': 'writer',
  'role:admin': 'admin',
};

interface AuditEntry {
  at: string;
  action: string;
  namespace: string;
  role: string;
  agentId: string;
  id?: string;
  ok: boolean;
}

type AuthedRequest = {
  apiKeyId?: string;
  apiScopes?: string[];
  user?: AuthUser | null;
};

function isAuthenticated(req: AuthedRequest): boolean {
  return Boolean(req.apiKeyId) || Boolean(req.user);
}

/** Map JWT UserRole → memory ACL role. */
function userRoleToAcl(role: UserRole): MemoryAclRole {
  if (role === 'super_admin' || role === 'admin') return 'admin';
  if (role === 'developer' || role === 'operator') return 'writer';
  return 'reader'; // auditor, viewer
}

/**
 * Resolve ACL role from server-side auth only (JWT user and/or API-key scopes).
 * Returns null when unauthenticated or when no mappable role/scope is present.
 */
function getAuthenticatedRole(req: AuthedRequest): MemoryAclRole | null {
  if (!isAuthenticated(req)) return null;

  const candidates: MemoryAclRole[] = [];
  if (req.user?.role) {
    candidates.push(userRoleToAcl(req.user.role));
  }
  for (const scope of req.apiScopes ?? []) {
    const mapped = SCOPE_TO_ACL[scope];
    if (mapped) candidates.push(mapped);
  }
  // Prefer higher privilege when both JWT and scopes are present.
  for (const preferred of ['admin', 'writer', 'reader'] as const) {
    if (candidates.includes(preferred)) return preferred;
  }
  // Authenticated but no mappable role/scopes (e.g. only bare agent names) → deny.
  return null;
}

function findAcl(role: string): ACLEntry | undefined {
  return DEFAULT_ACL.find((entry) => entry.role === role);
}

function hasPermission(role: string, permission: MemoryPermission, namespace: string): boolean {
  const acl = findAcl(role);
  if (!acl) return false;
  if (!acl.permissions.includes(permission)) return false;
  return acl.namespaces.includes('*') || acl.namespaces.includes(namespace);
}

export function createNamespacedMemoryRouter(memoryStore: MemoryStore): Router {
  return createCanonicalNamespacedMemoryRouter(memoryStore);
}

function createCanonicalNamespacedMemoryRouter(memoryStore: MemoryStore): Router {
  const router = Router();
  const namespaceTag = (namespace: string) => `namespace:${namespace}`;
  const auditLog: AuditEntry[] = [];
  const pushAudit = (entry: Omit<AuditEntry, 'at'>) => {
    auditLog.push({ ...entry, at: new Date().toISOString() });
    if (auditLog.length > 500) auditLog.shift();
  };

  router.post('/api/namespaced-memory/:namespace/write', async (req, res) => {
    const { namespace } = req.params;
    const {
      key,
      value,
      agentId,
      projectId,
      kind,
      title,
      content: memContent,
      tags,
    } = req.body ?? {};
    if (!key || value === undefined)
      return res.status(400).json({ error: 'key and value are required' });
    const role = getAuthenticatedRole(req);
    if (!role) return res.status(403).json({ error: 'Authentication required' });
    if (!hasPermission(role, 'write', namespace)) {
      pushAudit({ action: 'write', namespace, role, agentId: agentId ?? 'api', ok: false });
      return res.status(403).json({ error: 'Permission denied' });
    }
    const project = projectId ?? 'default';
    const allowedKinds = new Set(['DECISION', 'ISSUE', 'LESSON', 'SUMMARY']);
    const memoryKind = allowedKinds.has(kind) ? kind : 'SUMMARY';
    try {
      const item = await writeProductMemory(memoryStore, {
        projectId: project,
        agentId: agentId ?? 'api',
        kind: memoryKind as 'DECISION' | 'ISSUE' | 'LESSON' | 'SUMMARY',
        title: title ?? key,
        content: memContent ?? String(value),
        tags: [...(Array.isArray(tags) ? tags : []), namespaceTag(namespace)],
        meta: { namespace, createdBy: { agentId: agentId ?? 'api', role } },
        // Server-injected after RBAC — never accept namespaceAcl from request body.
        namespaceAcl: { role, namespaces: [namespace] },
      });
      pushAudit({
        action: 'write',
        namespace,
        role,
        agentId: agentId ?? 'api',
        id: item.id,
        ok: true,
      });
      res.json({ status: 'ok', namespace, id: item.id });
    } catch (error) {
      pushAudit({ action: 'write', namespace, role, agentId: agentId ?? 'api', ok: false });
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/api/namespaced-memory/:namespace/read/:id', async (req, res) => {
    const { namespace, id } = req.params;
    const role = getAuthenticatedRole(req);
    if (!role) return res.status(403).json({ error: 'Authentication required' });
    if (!hasPermission(role, 'read', namespace)) {
      pushAudit({ action: 'read', namespace, role, agentId: 'api', id, ok: false });
      return res.status(403).json({ error: 'Permission denied' });
    }
    const projectId = (req.query.projectId as string) ?? 'default';
    try {
      const item = await memoryStore.read(id, projectId);
      if (!item || item.meta?.namespace !== namespace) {
        pushAudit({ action: 'read', namespace, role, agentId: 'api', id, ok: false });
        return res.status(404).json({ error: 'Not found or permission denied' });
      }
      pushAudit({ action: 'read', namespace, role, agentId: 'api', id, ok: true });
      res.json({ ...item, namespace });
    } catch (error) {
      pushAudit({ action: 'read', namespace, role, agentId: 'api', id, ok: false });
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/api/namespaced-memory/:namespace/search', async (req, res) => {
    const { namespace } = req.params;
    const q = (req.query.q as string) ?? '';
    const role = getAuthenticatedRole(req);
    if (!role) return res.status(403).json({ error: 'Authentication required' });
    if (!hasPermission(role, 'read', namespace)) {
      pushAudit({ action: 'search', namespace, role, agentId: 'api', ok: false });
      return res.status(403).json({ error: 'Permission denied' });
    }
    const projectId = (req.query.projectId as string) ?? 'default';
    try {
      const results = await memoryStore.search({
        projectId,
        query: q,
        tags: [namespaceTag(namespace)],
        // AUDIT-API16: clamp — unvalidated limits (1e9 / NaN) passed through.
        limit: Math.min(
          Math.max(Number.parseInt(String(req.query.limit ?? '50'), 10) || 50, 1),
          200,
        ),
      });
      pushAudit({ action: 'search', namespace, role, agentId: 'api', ok: true });
      res.json({ namespace, query: q, items: results.items, total: results.total });
    } catch (error) {
      pushAudit({ action: 'search', namespace, role, agentId: 'api', ok: false });
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/api/namespaced-memory/:namespace/stats', async (req, res) => {
    const { namespace } = req.params;
    const role = getAuthenticatedRole(req);
    if (!role) return res.status(403).json({ error: 'Authentication required' });
    if (!hasPermission(role, 'read', namespace)) {
      return res.status(403).json({ error: 'Permission denied' });
    }
    const projectId = (req.query.projectId as string) ?? 'default';
    try {
      const results = await memoryStore.search({
        projectId,
        tags: [namespaceTag(namespace)],
        limit: 500,
      });
      const byKind = { DECISION: 0, ISSUE: 0, LESSON: 0, SUMMARY: 0 };
      for (const item of results.items) byKind[item.kind]++;
      res.json({ namespace, totalItems: results.total, byKind });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // Prefer durable MemoryService.queryAudit when available; fall back to the
  // process-local ring for stores that do not implement persistence yet.
  router.get('/api/namespaced-memory/:namespace/audit', async (req, res) => {
    const { namespace } = req.params;
    const role = getAuthenticatedRole(req);
    if (!role) return res.status(403).json({ error: 'Authentication required' });
    if (!hasPermission(role, 'read', namespace)) {
      return res.status(403).json({ error: 'Permission denied' });
    }
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
    const store = memoryStore as MemoryStore & {
      queryAudit?: (q: {
        projectId: string;
        namespace?: string;
        limit?: number;
      }) => Promise<{ entries: unknown[]; count: number; unavailable?: boolean }>;
    };
    if (typeof store.queryAudit === 'function') {
      try {
        // Non-admin callers cannot pick an arbitrary projectId (cross-project audit).
        const requestedProject =
          typeof req.query.projectId === 'string' ? req.query.projectId : 'default';
        const projectId = role === 'admin' ? requestedProject : 'default';
        if (role !== 'admin' && requestedProject !== 'default') {
          return res.status(403).json({
            error: 'Permission denied: projectId override requires admin',
          });
        }
        const page = await store.queryAudit({
          projectId,
          namespace,
          limit,
        });
        if (page.unavailable) {
          const entries = auditLog.filter((e) => e.namespace === namespace).slice(-limit);
          return res.json({
            namespace,
            entries,
            count: entries.length,
            source: 'api-local',
          });
        }
        return res.json({
          namespace,
          entries: page.entries,
          count: page.count,
          source: 'store',
        });
      } catch (error) {
        return res.status(400).json({
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const entries = auditLog.filter((e) => e.namespace === namespace).slice(-limit);
    res.json({
      namespace,
      entries,
      count: entries.length,
      source: 'api-local',
    });
  });

  // Full HTTP ACL is admin-only; other authenticated roles see only their rule.
  router.get('/api/namespaced-memory/acl', (req, res) => {
    const role = getAuthenticatedRole(req);
    if (!role) return res.status(403).json({ error: 'Authentication required' });
    const rules = role === 'admin' ? DEFAULT_ACL : DEFAULT_ACL.filter((rule) => rule.role === role);
    res.json({
      rules: rules.map((rule) => ({
        role: rule.role,
        permissions: rule.permissions,
        namespaces: rule.namespaces,
      })),
    });
  });

  return router;
}
