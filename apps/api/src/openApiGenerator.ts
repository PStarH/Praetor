/**
 * OpenAPI Generator — generates the OpenAPI 3.1 document from the actual
 * mounted routes (WS3 §4).
 *
 * Authenticity invariant (§4.2):
 *   - The generator ONLY reads routes from `listRegisteredRouters()` factory
 *     outputs (Express Router.stack introspection) + auto-injected metadata
 *     paths. No handwritten paths.
 *   - Any route registered on a router MUST appear in the spec; any route NOT
 *     registered MUST NOT appear. The Phase 3 test verifies this by comparing
 *     the symmetric difference.
 *
 * Strategy:
 *   1. Iterate `listRegisteredRouters()`.
 *   2. For each registration, call `factory()` to get the RequestHandler.
 *   3. If the handler is an Express Router, walk `router.stack` to extract
 *      { path, method } pairs. Express 4 layers have `.route` with `.path`
 *      and `.methods`; Express 5 layers may have `.path` + `.method` directly.
 *      Sub-routers (mounted via `router.use(prefix, subRouter)`) are walked
 *      recursively with the prefix prepended.
 *   4. Combine `mountPath + route path` → full OpenAPI path, converting
 *      `:param` to `{param}`.
 *   5. Apply registration-level `openapi` metadata as defaults. Non-/v1,
 *      non-ops paths are automatically marked `deprecated: true` +
 *      `x-legacy: true` (§8.1).
 *   6. Auto-inject `/v1/openapi.json` and `/v1/health` as self-describing
 *      metadata paths so the spec is discoverable.
 */

import type { RequestHandler } from 'express';
import { OPENAPI_V1_SPEC } from '@praetor/contracts';
import {
  listRegisteredRouters,
  nestedMountPrefixOf,
  type OpenApiMeta,
  type RouterRegistration,
} from './routerRegistry';

// ── Types ───────────────────────────────────────────────────────────────────

export type { OpenApiMeta };

export interface OpenApiDocument {
  openapi: '3.1.0';
  info: {
    title: string;
    version: string;
    description: string;
  };
  servers: Array<{ url: string; description: string }>;
  tags: Array<{ name: string; description: string }>;
  paths: Record<string, Record<string, OpenApiOperation>>;
  components?: {
    schemas?: Record<string, unknown>;
    securitySchemes?: Record<string, unknown>;
  };
  security?: Array<Record<string, string[]>>;
  /**
   * Mounts the reflector could not resolve, so their routes are omitted rather
   * than published at a wrong path. Present only when non-empty. An OpenAPI
   * extension (`x-`) so a strict consumer still validates the document.
   */
  'x-reflection-warnings'?: string[];
}

export interface OpenApiOperation {
  tags?: string[];
  summary?: string;
  description?: string;
  operationId?: string;
  deprecated?: boolean;
  'x-legacy'?: boolean;
  parameters?: unknown[];
  requestBody?: unknown;
  responses?: Record<string, { description: string }>;
  security?: Array<Record<string, string[]>>;
}

interface ExtractedRoute {
  /** Full path (mountPath + route path), with :param converted to {param}. */
  openApiPath: string;
  /** HTTP method (lowercase). */
  method: string;
}

interface GenerateOptions {
  title: string;
  version: string;
  description?: string;
  serverUrl?: string;
}

// ── Route extraction ────────────────────────────────────────────────────────

/**
 * Resolves the prefix a sub-router was mounted at.
 *
 * Express 4 stored the mount path on the layer, so `layer.path` is authoritative
 * there (`'/'` means a root mount, which contributes nothing).
 *
 * Express 5 does NOT: `router@2.x` sets `this.path = undefined` and keeps only
 * the `path-to-regexp` closures, so `layer.path` and `layer.regexp` are both
 * unusable (verified against express@5.2.1 / router@2.2.0). The only reliable
 * source is the prefix recorded by `mountNestedRouter` at mount time.
 *
 * Returns `undefined` when the prefix is genuinely unknown. Callers must treat
 * that as "omit the subtree" — guessing `''` is what silently published
 * `/v1/actions/kill-switches` as `/v1/kill-switches`.
 */
function resolveNestedPrefix(layer: { path?: unknown; handle?: unknown }): string | undefined {
  const normalize = (prefix: string): string => (prefix === '/' ? '' : prefix.replace(/\/+$/, ''));

  if (typeof layer.path === 'string') {
    return normalize(layer.path);
  }
  const recorded = nestedMountPrefixOf(layer.handle);
  if (recorded !== undefined) {
    return normalize(recorded);
  }
  return undefined;
}

/**
 * Walks an Express Router's `stack` to extract { path, method } pairs.
 *
 * Express Router internals are not part of the public API, but the `stack`
 * property has been stable across Express 4 and 5. We handle both layer
 * shapes:
 *  - Express 4: `layer.route` is a Route with `.path` (string) and `.methods`
 *    ({ get: true, post: true, ... }).
 *  - Express 5: layers may carry `.path` and `.method` directly on the layer.
 *
 * Sub-routers (mounted via `router.use('/prefix', subRouter)`) are walked
 * recursively with the prefix prepended. A sub-router whose prefix cannot be
 * resolved is SKIPPED and reported through `warnings` — never walked with an
 * assumed-empty prefix, because that emits paths that look plausible but point
 * at the wrong URL. Middleware-only layers (no route, no method, no sub-router)
 * are skipped — they are not HTTP routes.
 */
function extractRoutesFromRouter(
  handler: RequestHandler | any,
  prefix: string,
  warnings: string[] = [],
): Array<{ rawPath: string; method: string }> {
  const routes: Array<{ rawPath: string; method: string }> = [];

  // An Express Router is a FUNCTION with a `.stack` array property. A bare
  // middleware function has no `.stack`. Check for the array directly rather
  // than checking `typeof` — Express Routers are callable functions, not
  // plain objects, so `typeof handler === 'object'` would wrongly reject them.
  if (!handler || !Array.isArray(handler.stack)) {
    return routes;
  }

  for (const layer of handler.stack) {
    // Express 4: layer.route is a Route with .path and .methods
    if (layer.route && layer.route.methods) {
      const routePath = layer.route.path;
      if (typeof routePath !== 'string') {
        // `router.all(/regex/)` (and path arrays) have no literal URL, so there
        // is no honest OpenAPI path to publish. Coercing the RegExp produced
        // `/api/v1/observability/.*/` — a "path" no client can ever call.
        warnings.push(
          `omitted a route whose path is ${routePath instanceof RegExp ? 'a RegExp' : typeof routePath} ` +
            `rather than a string (under '${prefix || '/'}')`,
        );
        continue;
      }
      const methods = layer.route.methods as Record<string, boolean>;
      for (const method of Object.keys(methods)) {
        if (methods[method]) {
          routes.push({ rawPath: prefix + routePath, method });
        }
      }
      continue;
    }

    // Express 5: layer may carry .path and .method directly
    if (layer.method && typeof layer.path === 'string') {
      routes.push({ rawPath: prefix + layer.path, method: layer.method });
      continue;
    }

    // Sub-router: layer.handle is another Router with its own .stack
    if (layer.handle && Array.isArray(layer.handle.stack)) {
      const subPrefix = resolveNestedPrefix(layer);
      if (subPrefix === undefined) {
        // Fail closed. Express 5 discarded the mount path, so the real prefix is
        // unknowable; recursing with '' would publish every nested route at a
        // URL that does not exist. Omit the subtree and say so instead.
        warnings.push(
          `omitted a sub-router mounted at an unreflectable prefix (under '${prefix || '/'}'); ` +
            'mount it with mountNestedRouter() so its prefix is recorded',
        );
        continue;
      }
      const subRoutes = extractRoutesFromRouter(layer.handle, prefix + subPrefix, warnings);
      routes.push(...subRoutes);
      continue;
    }
  }

  return routes;
}

/**
 * Converts an Express path (`/runs/:runId`) to an OpenAPI path
 * (`/runs/{runId}`). Express path parameters start with `:`.
 */
function toOpenApiPath(expressPath: string): string {
  // Replace :param with {param}. Handle multiple params in one segment.
  return expressPath.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}');
}

/**
 * Normalizes a mount path + route path into a single clean path.
 * Handles edge cases:
 *   - mountPath '/' + route '/projects' → '/projects' (not '//projects')
 *   - mountPath '/v1' + route '/runs' → '/v1/runs'
 *   - mountPath '/v1' + route '' → '/v1'
 *   - mountPath '/v1' + route '/actions/' → '/v1/actions' (a trailing slash is
 *     never significant: Express 5 defaults to non-strict routing, so `/x` and
 *     `/x/` are the same route, and the canonical contract spells it `/x`).
 */
function joinPaths(mountPath: string, routePath: string): string {
  const mount = mountPath === '/' ? '' : mountPath.replace(/\/$/, '');
  const route = routePath === '/' ? '' : routePath;
  const joined = mount + route;
  if (joined === '') return '/';
  return joined.length > 1 ? joined.replace(/\/+$/, '') : joined;
}

// ── Metadata defaults ───────────────────────────────────────────────────────

/**
 * Ops path prefixes that are NOT marked as x-legacy even though they're
 * not under /v1. These are infrastructure/operational endpoints that exist
 * outside the /v1 product surface by design (§8.1).
 */
const OPS_PREFIXES = ['/health', '/ready', '/metrics', '/system'];

function isOpsPath(path: string): boolean {
  return OPS_PREFIXES.some((p) => path === p || path.startsWith(p + '/') || path.startsWith(p));
}

/**
 * Whether this path is a /v1 product path (not the auto-injected metadata
 * paths, which are handled separately).
 */
function isV1ProductPath(path: string): boolean {
  return path === '/v1' || path.startsWith('/v1/');
}

// ── Generator ───────────────────────────────────────────────────────────────

/**
 * Generates the OpenAPI 3.1 document from the registered routers.
 *
 * The document includes:
 *   - All routes extracted from registered router factories
 *   - Auto-injected `/v1/openapi.json` and `/v1/health` metadata paths
 *   - Registration-level `openapi` metadata applied as defaults
 *   - Non-/v1, non-ops routes marked `deprecated: true` + `x-legacy: true`
 *   - Bearer JWT security scheme
 */
export function generateOpenApiSpec(options: GenerateOptions): OpenApiDocument {
  const registrations = listRegisteredRouters();
  const paths: Record<string, Record<string, OpenApiOperation>> = {};
  const warnings: string[] = [];

  // ── Auto-injected metadata paths ──────────────────────────────────────────
  // /v1/openapi.json — self-describing
  paths['/v1/openapi.json'] = {
    get: {
      tags: ['System'],
      summary: 'OpenAPI specification (auto-generated from routes)',
      description:
        'Returns the OpenAPI 3.1 document generated from the actual mounted routes. ' +
        'This document is always in sync with the code — it is never hand-maintained.',
      responses: {
        '200': { description: 'OpenAPI 3.1 JSON document' },
      },
    },
  };

  // /v1/health — /v1 subtree health (§6.1)
  paths['/v1/health'] = {
    get: {
      tags: ['System'],
      summary: '/v1 subtree health (real dependency probes)',
      description:
        'Returns the health of /v1 Gateway dependencies (kernel hard-gate). ' +
        'Does not report EffectBroker / PEP readiness — that monopoly lives in ' +
        'worker-plane `@praetor/effect-broker` (bootstrap + production assert; ' +
        'L4-B worker GET /ready). Ops loop readiness is kernel-ops GET /ready ' +
        '(COMMANDER_OPS_HEALTH_PORT). EffectBroker-backed compensation drain / ' +
        'UNKNOWN reconcile readiness is the future adapter-ops deploy unit ' +
        '(absent on master). Unlike a fake READY, unwired deps are omitted or unknown.',
      responses: {
        '200': { description: 'All /v1 dependencies healthy' },
        '503': { description: 'One or more hard-gate dependencies are down' },
      },
    },
  };

  // ── Routes from registered routers ────────────────────────────────────────
  for (const reg of registrations) {
    const extracted = extractRoutesFromRegistration(reg, warnings);
    for (const route of extracted) {
      const pathKey = route.openApiPath;
      if (!paths[pathKey]) {
        paths[pathKey] = {};
      }

      // If this method is already registered (e.g. by a previous registration
      // or the auto-injected metadata), the first registration wins. This
      // prevents duplicate operations when multiple registrations cover the
      // same path (e.g. /api/v1/ aliases).
      if (paths[pathKey][route.method]) {
        continue;
      }

      paths[pathKey][route.method] = buildOperation(reg, route.openApiPath);
    }
  }

  // ── Assemble document ─────────────────────────────────────────────────────
  const serverUrl = options.serverUrl ?? `http://localhost:${process.env.PORT ?? '4000'}`;

  const document: OpenApiDocument = {
    openapi: '3.1.0',
    info: {
      title: options.title,
      version: options.version,
      description:
        options.description ??
        'Commander enterprise API surface. Generated from actual route code — never hand-maintained.',
    },
    servers: [{ url: serverUrl, description: 'API server' }],
    tags: collectTags(paths),
    paths,
    components: {
      // Component schemas are published from the canonical contract
      // (`@praetor/contracts` OPENAPI_V1_SPEC), NOT reflected from route code:
      // the route factories carry no schema metadata, so reflection can only
      // ever produce paths. Without these, a client generated from this
      // document cannot resolve any `#/components/schemas/...` reference.
      //
      // Known residual gap: the reflected operations do not yet reference these
      // schemas, so they are reachable but not wired to individual operations.
      // That gap is pinned by openApiContractConsistency.test.ts.
      schemas: { ...canonicalComponentSchemas() },
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description:
            'Enterprise access token carrying tenant_id + scopes claims (WS3 §3.1). ' +
            'Required for all /v1 product paths in enterprise profile.',
        },
      },
    },
    security: [{ bearerAuth: [] }],
  };

  if (warnings.length > 0) {
    document['x-reflection-warnings'] = [...new Set(warnings)].sort();
  }

  return document;
}

/**
 * Component schemas declared by the canonical contract, used to populate the
 * served document's `components.schemas`. Returns an empty object if the
 * contract ever stops declaring schemas, so the document stays valid.
 */
function canonicalComponentSchemas(): Record<string, unknown> {
  const components = (OPENAPI_V1_SPEC as { components?: { schemas?: Record<string, unknown> } })
    .components;
  return components?.schemas ?? {};
}

/**
 * Extracts routes from a single registration, returning OpenAPI-formatted
 * paths with metadata applied.
 */
function extractRoutesFromRegistration(
  reg: RouterRegistration,
  warnings: string[],
): ExtractedRoute[] {
  let handler: RequestHandler;
  try {
    handler = reg.factory();
  } catch {
    // If the factory throws (e.g. missing dependency in test), skip silently.
    return [];
  }

  const rawRoutes = extractRoutesFromRouter(handler, '', warnings);
  const routes: ExtractedRoute[] = [];

  for (const raw of rawRoutes) {
    const fullPath = joinPaths(reg.mountPath, raw.rawPath);
    const openApiPath = toOpenApiPath(fullPath);
    routes.push({ openApiPath, method: raw.method });
  }

  return routes;
}

/**
 * Builds an OpenAPI operation object for a route, applying registration-level
 * metadata and auto-legacy marking.
 */
function buildOperation(reg: RouterRegistration, openApiPath: string): OpenApiOperation {
  const meta = reg.openapi;
  const op: OpenApiOperation = {};

  if (meta?.tags) {
    op.tags = meta.tags;
  }
  if (meta?.summary) {
    op.summary = meta.summary;
  }
  if (meta?.description) {
    op.description = meta.description;
  }
  if (meta?.parameters) {
    op.parameters = meta.parameters;
  }
  if (meta?.requestBody) {
    op.requestBody = meta.requestBody;
  }
  if (meta?.responses) {
    op.responses = meta.responses;
  }

  // Auto-mark non-/v1, non-ops routes as legacy (§8.1).
  // The `openapi.xLegacy` / `openapi.deprecated` fields override the auto
  // marking, so a registration can explicitly keep a non-/v1 route unmarked.
  const isV1 = isV1ProductPath(openApiPath);
  const isOps = isOpsPath(openApiPath);

  if (meta?.xLegacy === true || (!isV1 && !isOps && meta?.xLegacy !== false)) {
    op['x-legacy'] = true;
  }
  if (meta?.deprecated === true || (!isV1 && !isOps && meta?.deprecated !== false)) {
    op.deprecated = true;
  }

  // Default responses if none provided
  if (!op.responses) {
    op.responses = { '200': { description: 'OK' } };
  }

  return op;
}

/**
 * Collects unique tags from all operations for the document-level `tags` array.
 */
function collectTags(
  paths: Record<string, Record<string, OpenApiOperation>>,
): Array<{ name: string; description: string }> {
  const tagSet = new Set<string>();
  for (const pathOps of Object.values(paths)) {
    for (const op of Object.values(pathOps)) {
      if (op.tags) {
        for (const t of op.tags) tagSet.add(t);
      }
    }
  }
  return Array.from(tagSet)
    .sort()
    .map((name) => ({
      name,
      description: tagDescription(name),
    }));
}

function tagDescription(name: string): string {
  const descriptions: Record<string, string> = {
    Runs: 'Durable execution kernel runs',
    Projects: 'Project and agent management',
    Missions: 'Mission lifecycle (legacy — use /v1/runs)',
    Memory: 'Memory stores (standard, namespaced, RBAC)',
    Quality: 'Quality gates: hallucination, consensus, handoff',
    Governance: 'Governance monitoring and alerts',
    Evaluation: 'Agent evaluation and grading',
    A2A: 'Google Agent-to-Agent protocol',
    System: 'Health and status',
    Observability: 'Observability queries',
  };
  return descriptions[name] ?? name;
}
