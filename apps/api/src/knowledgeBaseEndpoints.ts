/**
 * knowledgeBaseEndpoints — REST API for the enterprise knowledge base / RAG.
 *
 * Enterprise users' #1 need: let Agents retrieve internal company documents.
 * These endpoints expose the KnowledgeStore (chunking + embedding + cosine
 * search) so an Agent — or a human operator — can upload docs and run
 * semantic retrieval before an LLM call.
 *
 * Endpoints (all under /api/knowledge):
 *   POST   /api/knowledge/documents        — upload a doc (chunk + embed + index)
 *   GET    /api/knowledge/documents         — list documents (page/limit)
 *   GET    /api/knowledge/documents/:id     — get a single document
 *   DELETE /api/knowledge/documents/:id     — delete a document + its chunks
 *   POST   /api/knowledge/search            — semantic search (cosine top-K)
 *   POST   /api/knowledge/query             — RAG query (search + context string)
 *   GET    /api/knowledge/stats             — aggregate stats
 *
 * Validation uses zod (via validateBody/validateQuery) to match the pattern
 * used by chatEndpoints / approvalConfigEndpoints. Errors are funneled
 * through toErrorMessage so internal details are never leaked to clients.
 */
import { Router, type Request, type Response } from 'express';
import type { NextFunction } from 'express';
import { z } from 'zod';
import { hasRole } from './userStore';
import { toErrorMessage } from './routeHelpers';
import { validateBody, validateQuery } from './validationMiddleware';
import {
  getKnowledgeStore,
  isKnowledgeStoreError,
  normalizeContentType,
  SUPPORTED_CONTENT_TYPES,
  type KnowledgeDocument,
  type KnowledgeRagContext,
  type KnowledgeSearchResult,
  type KnowledgeStats,
  type KnowledgeListResult,
  type SupportedContentType,
  type KnowledgeStore,
} from './knowledgeStore';
// RAG plugin integration (core layer) — plugin enable/disable + shared KB store
import {
  getHookManager,
  getSharedKnowledgeBaseStore,
  type KbDocumentMeta,
  type KbSearchResult,
} from '@praetor/core';

// ── Validation schemas ───────────────────────────────────────────────────

const MAX_CONTENT_LENGTH = 5_000_000; // 5 MB raw text payload cap
const MAX_NAME_LENGTH = 256;

const uploadDocumentSchema = z.object({
  content: z.string().min(1).max(MAX_CONTENT_LENGTH),
  name: z.string().min(1).max(MAX_NAME_LENGTH),
  type: z.string().min(1),
  tags: z.array(z.string().max(64)).max(20).optional(),
});

const listDocumentsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const searchSchema = z.object({
  query: z.string().min(1).max(4000),
  topK: z.number().int().min(1).max(50).optional(),
  docIds: z.array(z.string().max(128)).max(100).optional(),
});

const ragQuerySchema = z.object({
  query: z.string().min(1).max(4000),
  topK: z.number().int().min(1).max(50).optional(),
  docIds: z.array(z.string().max(128)).max(100).optional(),
});

// ── RAG Plugin (builtin-rag) validation schemas ──────────────────────────
//
// These back the /api/knowledge-base/* surface that is wired to the core-layer
// KnowledgeBaseStore (the data plane) and the HookManager (the plugin control
// plane). They are intentionally separate from the /api/knowledge/* schemas so
// the two surfaces can evolve independently.

const RAG_PLUGIN_NAME = 'builtin-rag';

const kbUploadSchema = z.object({
  filename: z.string().min(1).max(MAX_NAME_LENGTH),
  content: z.string().min(1).max(MAX_CONTENT_LENGTH),
  source: z.string().min(1).max(512).optional(),
});

const kbSearchSchema = z.object({
  query: z.string().min(1).max(4000),
  topK: z.number().int().min(1).max(50).optional(),
});

/**
 * Safely coerce an Express 5 route param (which may be `string | string[]`)
 * into a single string. Returns undefined for missing/empty values.
 */
function paramToString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value.length > 0 ? value[0] : undefined;
  return value && value.length > 0 ? value : undefined;
}

/** Knowledge data is tenant-scoped; never fall back to a process-wide store at the HTTP boundary. */
function requireKnowledgeTenant(req: Request, res: Response, next: NextFunction): void {
  if (!req.tenantId) {
    res.status(403).json({
      error: 'Tenant-bound authenticated identity required',
    });
    return;
  }
  next();
}

function requestTenantId(req: Request): string {
  if (!req.tenantId) {
    throw new Error('Tenant-bound authenticated identity required');
  }
  return req.tenantId;
}

function requestKnowledgeStore(req: Request): KnowledgeStore {
  return getKnowledgeStore(requestTenantId(req));
}

/**
 * LM-22: map store failures onto non-2xx responses with a stable, redacted code.
 *
 * A read/parse failure must never be answered with an empty success payload, and
 * the raw filesystem error (which contains absolute paths) must not be echoed.
 */
function sendKnowledgeError(res: Response, error: unknown): void {
  if (isKnowledgeStoreError(error)) {
    if (error.code === 'KNOWLEDGE_INGEST_FAILED') {
      res.status(422).json({ error: 'KNOWLEDGE_INGEST_FAILED' });
      return;
    }
    res.status(503).json({ error: 'KNOWLEDGE_STORE_UNAVAILABLE' });
    return;
  }
  res.status(500).json({ error: toErrorMessage(error) });
}

/**
 * AUDIT-API4: JWT writers need a role floor — previously ANY JWT role
 * (including viewer) could upload and delete tenant knowledge documents.
 * developer+ may write; admins and above always pass.
 */
function requireKnowledgeWriter(req: Request, res: Response, next: NextFunction): void {
  if (req.user) {
    if (!hasRole(req.user.role, 'developer')) {
      res.status(403).json({ error: 'Knowledge-base write authority is required' });
      return;
    }
    next();
    return;
  }
  if (!req.apiKeyId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const scopes = req.apiScopes ?? [];
  const authorized =
    scopes.includes('knowledge:write') ||
    scopes.includes('write') ||
    scopes.includes('knowledge:admin') ||
    scopes.includes('admin') ||
    scopes.includes('*');
  if (!authorized) {
    res.status(403).json({ error: 'Knowledge-base write authority is required' });
    return;
  }
  next();
}

/** Global plugin controls require an admin JWT role or an equivalent API-key scope. */
function requireKnowledgeAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.user) {
    if (hasRole(req.user.role, 'admin')) {
      next();
      return;
    }
    res.status(403).json({ error: 'Insufficient privileges' });
    return;
  }

  const scopes = req.apiScopes ?? [];
  if (
    req.apiKeyId &&
    (scopes.includes('knowledge:admin') || scopes.includes('admin') || scopes.includes('*'))
  ) {
    next();
    return;
  }
  res.status(401).json({ error: 'Authentication required' });
}

// ── Router factory ───────────────────────────────────────────────────────

/**
 * Create the Express router for the knowledge base API.
 *
 * Mirrors the `createXxxRouter()` factory pattern used by every other router
 * in this app (see chatEndpoints, costDashboardEndpoints, webhookEndpoints).
 * The router is mounted at the app root; all routes are prefixed with
 * `/api/knowledge`.
 */
export function createKnowledgeBaseRouter(): Router {
  const router = Router();
  router.use(requireKnowledgeTenant);

  // ── POST /api/knowledge/documents — upload + index a document ─────────
  router.post(
    '/api/knowledge/documents',
    requireKnowledgeWriter,
    validateBody(uploadDocumentSchema),
    async (req: Request, res: Response) => {
      try {
        const { content, name, type, tags } = req.body as {
          content: string;
          name: string;
          type: string;
          tags?: string[];
        };
        const normalizedType = normalizeContentType(type) as SupportedContentType;
        const doc = await requestKnowledgeStore(req).addDocument({
          name,
          type: normalizedType,
          content,
          tags,
        });
        res.status(201).json({ document: doc });
      } catch (error) {
        sendKnowledgeError(res, error);
      }
    },
  );

  // ── GET /api/knowledge/documents — list documents (paginated) ─────────
  router.get(
    '/api/knowledge/documents',
    validateQuery(listDocumentsQuerySchema),
    async (req: Request, res: Response) => {
      try {
        const query = (req as unknown as { validatedQuery: { page: number; limit: number } })
          .validatedQuery;
        const result: KnowledgeListResult = await requestKnowledgeStore(req).listDocuments({
          page: query.page,
          limit: query.limit,
        });
        res.json(result);
      } catch (error) {
        sendKnowledgeError(res, error);
      }
    },
  );

  // ── GET /api/knowledge/documents/:id — get a single document ─────────
  router.get('/api/knowledge/documents/:id', async (req: Request, res: Response) => {
    try {
      const id = paramToString(req.params.id);
      if (!id) {
        res.status(400).json({ error: 'Document id is required' });
        return;
      }
      const doc: KnowledgeDocument | null = await requestKnowledgeStore(req).getDocument(id);
      if (!doc) {
        res.status(404).json({ error: 'Document not found' });
        return;
      }
      res.json({ document: doc });
    } catch (error) {
      sendKnowledgeError(res, error);
    }
  });

  // ── DELETE /api/knowledge/documents/:id — delete a document ──────────
  router.delete(
    '/api/knowledge/documents/:id',
    requireKnowledgeWriter,
    async (req: Request, res: Response) => {
      try {
        const id = paramToString(req.params.id);
        if (!id) {
          res.status(400).json({ error: 'Document id is required' });
          return;
        }
        const deleted = await requestKnowledgeStore(req).deleteDocument(id);
        if (!deleted) {
          res.status(404).json({ error: 'Document not found' });
          return;
        }
        res.json({ status: 'deleted', id });
      } catch (error) {
        sendKnowledgeError(res, error);
      }
    },
  );

  // ── POST /api/knowledge/search — semantic search ─────────────────────
  router.post(
    '/api/knowledge/search',
    validateBody(searchSchema),
    async (req: Request, res: Response) => {
      try {
        const { query, topK, docIds } = req.body as {
          query: string;
          topK?: number;
          docIds?: string[];
        };
        const results: KnowledgeSearchResult[] = await requestKnowledgeStore(req).search({
          query,
          topK,
          docIds,
        });
        res.json({ query, results, count: results.length });
      } catch (error) {
        sendKnowledgeError(res, error);
      }
    },
  );

  // ── POST /api/knowledge/query — RAG query (search + context string) ──
  router.post(
    '/api/knowledge/query',
    validateBody(ragQuerySchema),
    async (req: Request, res: Response) => {
      try {
        const { query, topK, docIds } = req.body as {
          query: string;
          topK?: number;
          docIds?: string[];
        };
        const rag: KnowledgeRagContext = await requestKnowledgeStore(req).query({
          query,
          topK,
          docIds,
        });
        res.json(rag);
      } catch (error) {
        sendKnowledgeError(res, error);
      }
    },
  );

  // ── GET /api/knowledge/stats — aggregate statistics ──────────────────
  router.get('/api/knowledge/stats', async (req: Request, res: Response) => {
    try {
      const stats: KnowledgeStats = await requestKnowledgeStore(req).stats();
      res.json(stats);
    } catch (error) {
      sendKnowledgeError(res, error);
    }
  });

  // ── GET /api/knowledge/types — supported content types (discoverability)
  router.get('/api/knowledge/types', (_req: Request, res: Response) => {
    res.json({ types: SUPPORTED_CONTENT_TYPES });
  });

  // ==========================================================================
  // RAG Plugin surface (/api/knowledge-base/*)
  // --------------------------------------------------------------------------
  // These routes are wired to the built-in `builtin-rag` CommanderPlugin:
  //   - Data plane  (upload/list/delete/search) → core KnowledgeBaseStore
  //     (shared process-wide via getSharedKnowledgeBaseStore()).
  //   - Control plane (status/enable/disable)   → HookManager.
  // The data plane works whether or not the plugin is *enabled* — enabling the
  // plugin only activates the beforeLLMCall auto-inject hook + tool exposure.
  // ==========================================================================

  // ── GET /api/knowledge-base/status — plugin + store status ───────────
  router.get('/api/knowledge-base/status', async (req: Request, res: Response) => {
    try {
      const hm = getHookManager();
      const registered = hm.hasPlugin(RAG_PLUGIN_NAME);
      const enabled = hm.isEnabled(RAG_PLUGIN_NAME);
      const store = getSharedKnowledgeBaseStore(requestTenantId(req));
      // Ensure the store has loaded any persisted index so counts are accurate.
      await store.init();
      res.json({
        plugin: RAG_PLUGIN_NAME,
        registered,
        enabled,
        documentCount: store.documentCount,
        vectorCount: store.vectorCount,
        embedding: store.embeddingName,
        embeddingDimension: store.embeddingDimension,
        documents: store.listDocuments(),
      });
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error) });
    }
  });

  // ── POST /api/knowledge-base/enable — enable the RAG plugin ──────────
  router.post(
    '/api/knowledge-base/enable',
    requireKnowledgeAdmin,
    async (_req: Request, res: Response) => {
      try {
        const hm = getHookManager();
        if (!hm.hasPlugin(RAG_PLUGIN_NAME)) {
          res.status(404).json({ error: 'RAG plugin is not registered' });
          return;
        }
        const ok = hm.enable(RAG_PLUGIN_NAME);
        res.json({ plugin: RAG_PLUGIN_NAME, enabled: true, ok });
      } catch (error) {
        res.status(500).json({ error: toErrorMessage(error) });
      }
    },
  );

  // ── POST /api/knowledge-base/disable — disable the RAG plugin ────────
  router.post(
    '/api/knowledge-base/disable',
    requireKnowledgeAdmin,
    async (_req: Request, res: Response) => {
      try {
        const hm = getHookManager();
        if (!hm.hasPlugin(RAG_PLUGIN_NAME)) {
          res.status(404).json({ error: 'RAG plugin is not registered' });
          return;
        }
        const ok = hm.disable(RAG_PLUGIN_NAME);
        res.json({ plugin: RAG_PLUGIN_NAME, enabled: false, ok });
      } catch (error) {
        res.status(500).json({ error: toErrorMessage(error) });
      }
    },
  );

  // ── POST /api/knowledge-base/upload — ingest a document into the KB ──
  router.post(
    '/api/knowledge-base/upload',
    requireKnowledgeWriter,
    validateBody(kbUploadSchema),
    async (req: Request, res: Response) => {
      try {
        const { filename, content, source } = req.body as {
          filename: string;
          content: string;
          source?: string;
        };
        const store = getSharedKnowledgeBaseStore(requestTenantId(req));
        const result = await store.ingestDocument(filename, content, source);
        res.status(201).json({
          documentId: result.documentId,
          chunksIndexed: result.chunksIndexed,
        });
      } catch (error) {
        res.status(500).json({ error: toErrorMessage(error) });
      }
    },
  );

  // ── GET /api/knowledge-base/documents — list KB documents ────────────
  router.get('/api/knowledge-base/documents', async (req: Request, res: Response) => {
    try {
      const store = getSharedKnowledgeBaseStore(requestTenantId(req));
      await store.init();
      const documents: KbDocumentMeta[] = store.listDocuments();
      res.json({ documents, count: documents.length });
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error) });
    }
  });

  // ── DELETE /api/knowledge-base/documents/:id — delete a KB document ─
  router.delete(
    '/api/knowledge-base/documents/:id',
    requireKnowledgeWriter,
    async (req: Request, res: Response) => {
      try {
        const id = paramToString(req.params.id);
        if (!id) {
          res.status(400).json({ error: 'Document id is required' });
          return;
        }
        const store = getSharedKnowledgeBaseStore(requestTenantId(req));
        const deleted = await store.deleteDocument(id);
        if (!deleted) {
          res.status(404).json({ error: 'Document not found' });
          return;
        }
        res.json({ status: 'deleted', id });
      } catch (error) {
        res.status(500).json({ error: toErrorMessage(error) });
      }
    },
  );

  // ── POST /api/knowledge-base/search — manual retrieval test ──────────
  router.post(
    '/api/knowledge-base/search',
    validateBody(kbSearchSchema),
    async (req: Request, res: Response) => {
      try {
        const { query, topK } = req.body as { query: string; topK?: number };
        const store = getSharedKnowledgeBaseStore(requestTenantId(req));
        const results: KbSearchResult[] = await store.search(query, topK);
        res.json({ query, results, count: results.length });
      } catch (error) {
        res.status(500).json({ error: toErrorMessage(error) });
      }
    },
  );

  return router;
}
