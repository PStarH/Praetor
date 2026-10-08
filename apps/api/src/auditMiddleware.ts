/**
 * auditMiddleware — Records mutating HTTP requests to the unified audit trail.
 *
 * Rather than threading audit calls into every endpoint (high blast radius),
 * this single middleware observes all POST/PUT/PATCH/DELETE requests and
 * appends a `user_action` entry to `.commander/audit/user-actions.ndjson` once
 * the response finishes. The recorded status code lets operators see whether a
 * write succeeded or failed.
 *
 * Safety:
 *   - Sensitive request-body fields (password, apiKey, token, secret, …) are
 *     stripped recursively before persistence — see `sanitizeBody`.
 *   - Request bodies are size-capped so a huge upload cannot balloon the log.
 *   - Recording never throws: `UnifiedAuditLog.log()` swallows persistence
 *     errors, and the `finish` listener is detached after firing.
 *   - The audit-log query endpoints themselves are skipped to avoid feedback.
 */
import type { Request, Response, NextFunction } from 'express';
import {
  type UnifiedAuditLog,
  type UnifiedAuditSeverity,
  SENSITIVE_BODY_KEYS,
} from '@praetor/core/security';

/** Maximum number of characters of the sanitized body retained in the log. */
const MAX_BODY_CHARS = 8_000;

/** HTTP methods considered "writes" and therefore worth auditing. */
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Path prefixes excluded from auditing. The audit-log endpoints are read-only
 * GETs so this is mostly defensive, but it also keeps noisy self-referential
 * traffic out of the trail if write variants are ever added.
 */
const SKIP_PREFIXES = ['/api/audit-logs', '/api/audit/'];

/**
 * Deep-clone a request body and strip any field whose key matches a known
 * sensitive name (case-insensitive). Non-object bodies are returned as-is
 * (size-capped) since they carry no nested secrets to redact.
 */
export function sanitizeBody(body: unknown): unknown {
  if (body === null || body === undefined) return body;
  if (typeof body !== 'object') {
    // Primitive body (string/number/…) — cap its length.
    const s = String(body);
    return s.length > MAX_BODY_CHARS ? s.slice(0, MAX_BODY_CHARS) + '…[truncated]' : s;
  }

  if (Array.isArray(body)) {
    return body.slice(0, 200).map(sanitizeBody);
  }

  const entries: Array<[string, unknown]> = [];
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    entries.push([
      key,
      SENSITIVE_BODY_KEYS.has(key.toLowerCase()) ? '[REDACTED]' : sanitizeBody(value),
    ]);
  }
  return Object.fromEntries(entries);
}

/** Derive a unified severity from the final HTTP status code. */
function severityForStatus(status: number): UnifiedAuditSeverity {
  if (status >= 500) return 'error';
  if (status >= 400) return 'warn';
  return 'info';
}

/** Human-readable label for the audited action. */
function describeAction(method: string, path: string, status: number): string {
  const verb = method.toUpperCase();
  if (status >= 500) return `${verb} ${path} → ${status} (server error)`;
  if (status >= 400) return `${verb} ${path} → ${status} (client error)`;
  return `${verb} ${path} → ${status}`;
}

/**
 * Build an Express middleware that records mutating requests to the unified
 * audit log. Pass the process-wide `UnifiedAuditLog` singleton (or a test
 * instance). The middleware never blocks the request — logging happens on the
 * `finish` event, after the response is sent.
 */
export function createAuditMiddleware(auditLog: UnifiedAuditLog) {
  return function auditMiddleware(req: Request, _res: Response, next: NextFunction): void {
    const method = req.method.toUpperCase();
    const shouldAudit =
      WRITE_METHODS.has(method) && !SKIP_PREFIXES.some((p) => req.path.startsWith(p));

    if (!shouldAudit) {
      next();
      return;
    }

    // Snapshot the sanitized body now — req.body may be mutated downstream.
    const sanitizedBody = sanitizeBody(req.body);

    // Record once the response has finished so we can capture the status code.
    // The whole callback is defensive: audit recording must never throw into
    // the response lifecycle (the listener fires off the request path).
    const onFinish = (): void => {
      try {
        if (typeof _res.removeListener === 'function') {
          _res.removeListener('finish', onFinish);
        }
      } catch {
        /* detach is best-effort — finish only fires once anyway */
      }
      const status = _res.statusCode;
      void auditLog
        .log({
          category: 'user_action',
          eventType: `http.${method.toLowerCase()}`,
          severity: severityForStatus(status),
          userId: req.user?.id ?? req.apiKeyId,
          message: describeAction(method, req.path, status),
          details: {
            method,
            path: req.path,
            statusCode: status,
            body: sanitizedBody,
            ...(req.apiKeyId ? { apiKeyId: req.apiKeyId } : {}),
            ...(req.ip ? { ip: req.ip } : {}),
          },
          source: 'api',
        })
        .catch(() => {
          /* UnifiedAuditLog.log already swallows errors; this is belt+suspenders */
        });
    };

    _res.on('finish', onFinish);
    next();
  };
}
