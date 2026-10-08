import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { getWebhookDispatcher, type WebhookConfig } from '@praetor/core';
import { runWithTenant } from '@praetor/core/runtime/tenantContext';
import { toErrorMessage } from './routeHelpers';
import { hasRole, type UserRole } from './userStore';

/**
 * Outgoing webhook management endpoints.
 *
 * Wraps the core WebhookDispatcher to expose CRUD for outbound HTTP
 * webhooks, plus delivery logs and stats. Created secrets are returned once
 * and then redacted from all list/get responses.
 */

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user && !req.apiKeyId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  next();
}

/**
 * Returns middleware that requires the authenticated user to meet or exceed
 * `requiredRole` in the role hierarchy (defaults to 'admin', so both
 * 'super_admin' and 'admin' satisfy an unparameterised check). Must be
 * mounted after requireAuth.
 */
function requireRole(requiredRole: UserRole = 'admin') {
  return (req: Request, res: Response, next: NextFunction): void => {
    const scopes = req.apiScopes ?? [];
    const allowed =
      (!!req.user && hasRole(req.user.role, requiredRole)) ||
      (!!req.apiKeyId &&
        requiredRole === 'admin' &&
        (scopes.includes('admin') || scopes.includes('*')));
    if (!allowed) {
      res.status(403).json({ error: 'Insufficient privileges' });
      return;
    }
    next();
  };
}

function requireTenantBinding(req: Request, res: Response, next: NextFunction): void {
  const tenantId = req.tenantId;
  const jwtTenant = req.user?.tenantId;
  if (!tenantId || (jwtTenant && jwtTenant !== tenantId)) {
    res.status(403).json({ error: 'Tenant-bound identity required' });
    return;
  }
  next();
}

function redact(webhook: WebhookConfig): Omit<WebhookConfig, 'secret' | 'headers'> {
  const { secret: _secret, headers: _headers, ...rest } = webhook;
  return rest;
}

function parseLimit(value: unknown, fallback = 50, max = 1000): number {
  const parsed = parseInt(String(value), 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.max(1, Math.min(max, parsed));
}

function getStringParam(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

function dispatcherForRequest(req: Request) {
  const tenantId = req.tenantId;
  if (!tenantId) {
    throw new Error('Tenant-bound identity required');
  }
  return runWithTenant(tenantId, () => {
    const dispatcher = getWebhookDispatcher();
    dispatcher.start();
    return dispatcher;
  });
}

// ── Security: SSRF prevention ────────────────────────────────────────────────
// Reject private/loopback/link-local/metadata hosts at the API boundary
// (defense-in-depth; WebhookDispatcher also validates at register time).
const BLOCKED_WEBHOOK_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '0.0.0.0',
  '169.254.169.254', // AWS / OpenStack / Azure instance metadata
  'metadata.google.internal', // GCP metadata
  'metadata',
]);

const PRIVATE_IP_PATTERNS = [
  /^127\./, // Loopback
  /^10\./, // RFC 1918
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./, // RFC 1918
  /^192\.168\./, // RFC 1918
  /^169\.254\./, // Link-local / cloud metadata
  /^0\./, // Current network
  /^::1$/, // IPv6 loopback
  /^0:0:0:0:0:0:0:1$/,
  /^fc[0-9a-f]{2}:/i, // IPv6 ULA
  /^fd[0-9a-f]{2}:/i,
  /^fe80:/i, // IPv6 link-local
];

/**
 * Validate an outgoing webhook URL against SSRF targets.
 * Only allows http/https to non-private hosts.
 */
export function isSafeOutgoingWebhookUrl(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    let hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    // IPv4-mapped IPv6 (::ffff:127.0.0.1 or ::ffff:7f00:1) → extract IPv4
    if (hostname.startsWith('::ffff:')) {
      const rest = hostname.slice('::ffff:'.length);
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(rest)) {
        hostname = rest;
      } else {
        const parts = rest.split(':');
        if (parts.length === 2) {
          const hi = Number.parseInt(parts[0], 16);
          const lo = Number.parseInt(parts[1], 16);
          if (Number.isFinite(hi) && Number.isFinite(lo)) {
            hostname = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
          } else {
            return false;
          }
        } else {
          return false;
        }
      }
    }
    if (hostname.endsWith('.')) hostname = hostname.slice(0, -1);
    if (BLOCKED_WEBHOOK_HOSTS.has(hostname) || hostname.endsWith('.localhost')) {
      return false;
    }
    for (const pattern of PRIVATE_IP_PATTERNS) {
      if (pattern.test(hostname)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function validateCreate(
  body: unknown,
): { config: Omit<WebhookConfig, 'id' | 'createdAt'> } | { error: string } {
  if (!body || typeof body !== 'object') {
    return { error: 'Request body must be an object' };
  }
  const input = body as Record<string, unknown>;

  if (typeof input.url !== 'string' || !input.url.trim()) {
    return { error: 'url is required' };
  }
  const url = input.url.trim();
  if (url.length > 2048) {
    return { error: 'url must be at most 2048 characters' };
  }
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return { error: 'url must use http or https' };
  }
  if (!isSafeOutgoingWebhookUrl(url)) {
    return {
      error: 'url must not point to private, loopback, link-local, or metadata addresses',
    };
  }

  if (!Array.isArray(input.events) || input.events.length === 0) {
    return { error: 'events must be a non-empty array' };
  }
  const events = input.events.filter((e): e is string => typeof e === 'string');
  if (events.length === 0) {
    return { error: 'events must contain strings' };
  }

  const config: Omit<WebhookConfig, 'id' | 'createdAt'> = {
    url,
    events,
    enabled: input.enabled !== false,
  };

  if (typeof input.name === 'string') config.name = input.name.trim().slice(0, 128);
  if (typeof input.description === 'string') {
    config.description = input.description.trim().slice(0, 512);
  }
  if (typeof input.secret === 'string') config.secret = input.secret;
  if (typeof input.retryMax === 'number') {
    config.retryMax = Math.max(0, Math.min(10, Math.floor(input.retryMax)));
  }
  if (input.headers && typeof input.headers === 'object') {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(input.headers as Record<string, unknown>)) {
      if (typeof v !== 'string' || !/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(k)) continue;
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      headers[k] = v;
    }
    if (Object.keys(headers).length > 0) config.headers = headers;
  }

  return { config };
}

export function createOutgoingWebhookRouter(): Router {
  const router = Router();
  router.use(requireAuth, requireTenantBinding);

  // GET /api/outgoing-webhooks — list configured outgoing webhooks
  router.get('/api/outgoing-webhooks', (req: Request, res: Response) => {
    try {
      const dispatcher = dispatcherForRequest(req);
      res.json({ webhooks: dispatcher.listWebhooks().map(redact) });
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error) });
    }
  });

  // POST /api/outgoing-webhooks — create a new outgoing webhook
  router.post('/api/outgoing-webhooks', requireRole(), (req: Request, res: Response) => {
    const validation = validateCreate(req.body);
    if ('error' in validation) {
      res.status(400).json({ error: validation.error });
      return;
    }

    try {
      const dispatcher = dispatcherForRequest(req);
      const webhook = dispatcher.registerWebhook(validation.config);
      res.status(201).json({ webhook: redact(webhook) });
    } catch (error) {
      res.status(400).json({ error: toErrorMessage(error) });
    }
  });

  // GET /api/outgoing-webhooks/stats — dispatcher statistics
  router.get('/api/outgoing-webhooks/stats', (req: Request, res: Response) => {
    try {
      const dispatcher = dispatcherForRequest(req);
      res.json(dispatcher.getStats());
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error) });
    }
  });

  // GET /api/outgoing-webhooks/:id — get a single webhook
  router.get('/api/outgoing-webhooks/:id', (req: Request, res: Response) => {
    try {
      const dispatcher = dispatcherForRequest(req);
      const id = getStringParam(req.params.id);
      const webhook = id ? dispatcher.getWebhook(id) : undefined;
      if (!webhook) {
        res.status(404).json({ error: 'Webhook not found' });
        return;
      }
      res.json({ webhook: redact(webhook) });
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error) });
    }
  });

  // DELETE /api/outgoing-webhooks/:id — remove a webhook
  router.delete('/api/outgoing-webhooks/:id', requireRole(), (req: Request, res: Response) => {
    try {
      const dispatcher = dispatcherForRequest(req);
      const id = getStringParam(req.params.id);
      const removed = id ? dispatcher.deregisterWebhook(id) : false;
      if (!removed || !id) {
        res.status(404).json({ error: 'Webhook not found' });
        return;
      }
      res.json({ status: 'deleted', id });
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error) });
    }
  });

  // GET /api/outgoing-webhooks/:id/deliveries — delivery log for a webhook
  router.get('/api/outgoing-webhooks/:id/deliveries', (req: Request, res: Response) => {
    try {
      const dispatcher = dispatcherForRequest(req);
      const id = getStringParam(req.params.id);
      const webhook = id ? dispatcher.getWebhook(id) : undefined;
      if (!webhook) {
        res.status(404).json({ error: 'Webhook not found' });
        return;
      }
      const limit = parseLimit(req.query.limit, 50);
      const all = dispatcher.getDeliveryLog(1000);
      const deliveries = all.filter((d) => d.webhookId === id).slice(-limit);
      res.json({ deliveries, total: deliveries.length });
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error) });
    }
  });

  // GET /api/outgoing-webhooks/deliveries/recent — recent deliveries across all webhooks
  router.get('/api/outgoing-webhooks/deliveries/recent', (req: Request, res: Response) => {
    try {
      const dispatcher = dispatcherForRequest(req);
      const limit = parseLimit(req.query.limit, 50);
      res.json({ deliveries: dispatcher.getDeliveryLog(limit) });
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error) });
    }
  });

  return router;
}
