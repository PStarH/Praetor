/**
 * Cross-package OpenAPI contract consistency.
 *
 * Commander ships TWO independently maintained descriptions of the same HTTP
 * surface:
 *
 *   1. `@praetor/contracts` → `OPENAPI_V1_SPEC`
 *      (packages/contracts/src/openapi.ts). Its header claims to be "the
 *      canonical API contract — `apps/api` must implement every path defined
 *      here, and SDK code generators consume this spec".
 *   2. `generateOpenApiSpec()` (apps/api/src/openApiGenerator.ts), reflected
 *      from the registered routers and served at `GET /v1/openapi.json`.
 *
 * What this file covers — and, deliberately, what it does not:
 *
 *   - It IS a reflector contract test. Each case registers an explicit fixture
 *     router and asserts the exact generated document, so a change in how the
 *     reflector walks Express internals fails here.
 *   - It is NOT a measurement of the production surface. `buildServedSpec()`
 *     reflects whatever is in the registry, and this file never imports the app
 *     manifest (that lives inline in `index.ts` and boots a server on import).
 *     The `PINNED_*` lists below therefore pin the contract against a
 *     *deliberately empty* baseline registry, not against production.
 *   - The production drift — canonical contract vs the document actually served
 *     by a booted API — is measured out of band and recorded under `.internal/`
 *     (see `.internal/sub-review-09-13/`). At the time of writing it is 22
 *     contract-only operations and 290 served-only operations; the contract
 *     documents a /v1 surface the reflector largely does not implement.
 *
 * This is a test-only artifact. It changes no production behaviour.
 */
import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import express, { type Application } from 'express';
import { OPENAPI_V1_SPEC } from '@praetor/contracts';
import {
  registerRouter,
  listRegisteredRouters,
  resetRouterRegistry,
  mountNestedRouter,
} from '../src/routerRegistry.js';
import { generateOpenApiSpec } from '../src/openApiGenerator.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Build the served document exactly as `index.ts` serves it. */
function buildServedSpec() {
  const app: Application = express();
  for (const reg of listRegisteredRouters()) {
    app.use(reg.mountPath, reg.factory());
  }
  return generateOpenApiSpec({
    title: 'Commander Enterprise API',
    version: 'test',
    serverUrl: 'http://127.0.0.1:4000',
  });
}

interface PathSet {
  /** Normalised `METHOD /path` keys, ignoring path-level `parameters`. */
  operations: Set<string>;
  /** Declared component schema names. */
  schemas: Set<string>;
}

function canonicalPaths(): PathSet {
  const operations = new Set<string>();
  for (const [path, item] of Object.entries(OPENAPI_V1_SPEC.paths)) {
    for (const method of Object.keys(item as Record<string, unknown>)) {
      if (method === 'parameters') continue;
      // contracts declares `servers: [{url:'/v1'}]`, so its keys are relative.
      operations.add(`${method.toUpperCase()} /v1${path === '/' ? '' : path}`);
    }
  }
  const schemas = new Set(
    Object.keys((OPENAPI_V1_SPEC.components as { schemas?: object } | undefined)?.schemas ?? {}),
  );
  return { operations, schemas };
}

function servedPaths(spec: ReturnType<typeof buildServedSpec>): PathSet {
  const operations = new Set<string>();
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of Object.keys(item as Record<string, unknown>)) {
      if (method === 'parameters') continue;
      operations.add(`${method.toUpperCase()} ${path}`);
    }
  }
  const schemas = new Set(
    Object.keys((spec.components as { schemas?: object } | undefined)?.schemas ?? {}),
  );
  return { operations, schemas };
}

function difference(from: Set<string>, against: Set<string>): string[] {
  return [...from].filter((entry) => !against.has(entry)).sort();
}

/**
 * Order-insensitive set comparison. Pinned lists are hand-maintained, so their
 * ordering must not matter; only membership does.
 */
function assertSameSet(
  actual: readonly string[],
  pinned: readonly string[],
  message: string,
): void {
  assert.deepEqual(
    [...actual].sort(),
    [...pinned].sort(),
    `${message}\n--- observed ---\n${[...actual].sort().join('\n')}`,
  );
}

/**
 * Documented by the canonical contract but NOT present in the served document.
 *
 * Because the comparison runs against an EMPTY registry (see the file header),
 * this list is simply the canonical contract's whole operation inventory. It is
 * a pin on the contract's surface, not a claim that production serves these.
 *
 * It still fails on any new difference and on any stale entry, so adding an
 * operation to `packages/contracts/src/openapi.ts` requires recording it here.
 *
 * The `/actions` prefix loss that this list used to document is FIXED: the
 * reflector now recovers a nested mount prefix via `mountNestedRouter`, and
 * `POST /v1/actions` / `GET /v1/actions/kill-switches` and siblings are
 * generated (verified against a booted server, not against this fixture).
 */
const PINNED_CONTRACT_ONLY: readonly string[] = [
  // --- Action Gateway: declared by the contract; the reflector can now name
  // them correctly (mountNestedRouter records the /actions prefix), but they are
  // absent from this empty-baseline document by construction ---
  'DELETE /v1/actions/kill-switches/{scope}/{value}',
  'GET /v1/actions/kill-switches',
  'GET /v1/actions/{runId}',
  'GET /v1/actions/{runId}/evidence',
  'POST /v1/actions',
  'POST /v1/actions/simulate',
  'POST /v1/actions/{runId}/approve',
  'POST /v1/actions/{runId}/compensations',
  'POST /v1/actions/{runId}/compensations/{authorizationId}/approve',
  'POST /v1/actions/{runId}/reconcile',
  'POST /v1/actions/{runId}/reject',
  'PUT /v1/actions/kill-switches/{scope}/{value}',
  // --- Documented /v1 resource surface not reflected by the generator at all ---
  'GET /v1/agents',
  'GET /v1/agents/{agentId}',
  'GET /v1/connectors',
  'GET /v1/connectors/{connectorId}',
  'GET /v1/policy-bundles',
  'GET /v1/policy-bundles/{snapshotId}',
  'GET /v1/runs/{runId}',
  'GET /v1/runs/{runId}/artifacts',
  'GET /v1/runs/{runId}/artifacts/{artifactId}',
  'GET /v1/runs/{runId}/effects',
  'GET /v1/runs/{runId}/effects/{effectId}',
  'GET /v1/runs/{runId}/events',
  'GET /v1/runs/{runId}/interactions',
  'GET /v1/runs/{runId}/interactions/{interactionId}',
  'GET /v1/runs/{runId}/steps',
  'GET /v1/runs/{runId}/steps/{stepId}',
  'GET /v1/runs/{runId}/workgraph',
  'GET /v1/tools',
  'GET /v1/tools/{toolId}',
  'POST /v1/agents',
  'POST /v1/connectors',
  'POST /v1/runs',
  'POST /v1/runs/{runId}/interactions/{interactionId}',
  'POST /v1/tools',
];

/**
 * Present in the served document but NOT in the canonical contract.
 *
 * With an empty baseline registry the only served paths are the auto-injected
 * metadata ones, documented as such in `openApiGenerator.ts` ("Auto-injected
 * `/v1/openapi.json` and `/v1/health` metadata paths"). They are not product
 * resource surface, so the canonical contract legitimately omits them. Anything
 * ELSE appearing here means the reflector grew a path the contract does not
 * describe.
 */
const PINNED_SERVED_ONLY: readonly string[] = ['GET /v1/health', 'GET /v1/openapi.json'];

/**
 * Component schemas declared only by the canonical contract.
 *
 * Empty because the served document now publishes exactly the contract's
 * schemas: `generateOpenApiSpec` copies `OPENAPI_V1_SPEC.components.schemas`
 * into the document (route reflection cannot produce schemas — the factories
 * carry no schema metadata). Previously the served document declared none at
 * all, so a client generated from it could not resolve a single `$ref`.
 *
 * Residual, separately pinned gap: the reflected operations still do not
 * REFERENCE these schemas, so they are reachable but not wired per-operation.
 */
const PINNED_CONTRACT_ONLY_SCHEMAS: readonly string[] = [];

/**
 * Component schemas declared only by the served document.
 */
const PINNED_SERVED_ONLY_SCHEMAS: readonly string[] = [];

// ── Tests ───────────────────────────────────────────────────────────────────

describe('OpenAPI cross-package consistency (contracts ⇄ apps/api)', () => {
  beforeEach(() => resetRouterRegistry());

  it('preserves a mounted sub-router prefix in generated paths', () => {
    // Regression for the `/actions` prefix loss. Express 5's `router@2.x` sets
    // `layer.path = undefined` and keeps only `path-to-regexp` closures, so the
    // mount prefix is not recoverable from the layer — it must be recorded when
    // the mount happens. `mountNestedRouter` does that; a bare `router.use` does
    // not (see the fail-closed test below).
    const actions = express.Router();
    actions.get('/kill-switches', (_req, res) => res.json({ ok: true }));
    actions.post('/:runId/approve', (_req, res) => res.json({ ok: true }));
    const parent = express.Router();
    mountNestedRouter(parent, '/actions', actions);

    registerRouter({ name: 'actions', mountPath: '/v1', factory: () => parent });

    const spec = buildServedSpec();
    assert.ok(
      spec.paths['/v1/actions/kill-switches'],
      'expected GET /v1/actions/kill-switches to be generated; ' +
        `got ${JSON.stringify(Object.keys(spec.paths))}`,
    );
    assert.ok(
      spec.paths['/v1/actions/{runId}/approve'],
      'expected POST /v1/actions/{runId}/approve to be generated; ' +
        `got ${JSON.stringify(Object.keys(spec.paths))}`,
    );
    assert.equal(
      spec.paths['/v1/kill-switches'],
      undefined,
      'generated paths must not drop the mounted /actions prefix',
    );
    assert.equal(
      spec['x-reflection-warnings'],
      undefined,
      'a recorded mount must not produce a reflection warning',
    );
  });

  it('omits a sub-router whose mount prefix cannot be resolved (fails closed)', () => {
    // A bare `router.use('/actions', sub)` under Express 5 leaves no trace of
    // `/actions`. The reflector must NOT assume an empty prefix: doing so
    // published `/v1/actions/kill-switches` as `/v1/kill-switches`, which is a
    // plausible-looking URL that 404s. Omitting the subtree plus a warning keeps
    // the document honest, and the contract diff below surfaces the omission.
    const actions = express.Router();
    actions.get('/kill-switches', (_req, res) => res.json({ ok: true }));
    const parent = express.Router();
    parent.use('/actions', actions);

    registerRouter({ name: 'bare-actions', mountPath: '/v1', factory: () => parent });

    const spec = buildServedSpec();
    assert.equal(
      spec.paths['/v1/kill-switches'],
      undefined,
      'a wrong path (prefix silently dropped) must never be published',
    );
    assert.equal(
      spec.paths['/v1/actions/kill-switches'],
      undefined,
      'an unresolvable prefix must not be guessed into a real-looking path',
    );
    const warnings = spec['x-reflection-warnings'] ?? [];
    assert.equal(
      warnings.length,
      1,
      `expected exactly one reflection warning, got ${warnings.length}`,
    );
    assert.match(warnings[0], /unreflectable prefix/);
    assert.match(warnings[0], /mountNestedRouter/);
  });

  it('omits a RegExp-path route instead of publishing the regex as a path', () => {
    // `router.all(/.*/)` has no literal URL. The reflector used to stringify the
    // RegExp, publishing `/api/v1/observability/.*/` — a "path" no client can
    // call, and one that silently inflated the served-only drift set.
    const obs = express.Router();
    obs.all(/.*/, (_req, res) => res.json({ ok: true }));
    obs.get('/runs', (_req, res) => res.json({ ok: true }));

    registerRouter({
      name: 'observability',
      mountPath: '/api/v1/observability',
      factory: () => obs,
    });

    const spec = buildServedSpec();
    assert.equal(
      spec.paths['/api/v1/observability/.*/'],
      undefined,
      'a RegExp must never be published as an OpenAPI path',
    );
    assert.ok(
      spec.paths['/api/v1/observability/runs'],
      'sibling string paths must still be reflected',
    );
    const warnings = spec['x-reflection-warnings'] ?? [];
    assert.equal(warnings.length, 1, `expected one reflection warning, got ${warnings.length}`);
    assert.match(warnings[0], /RegExp/);
  });

  it('normalizes a trailing slash so mounted roots match the canonical spelling', () => {
    // `router.post('/')` mounted at /v1/actions is reachable at /v1/actions, not
    // /v1/actions/. The contract spells it `/actions`; publishing the slashed
    // form made a real operation look unimplemented in the drift comparison.
    const actions = express.Router();
    actions.post('/', (_req, res) => res.json({ ok: true }));
    actions.get('/kill-switches', (_req, res) => res.json({ ok: true }));
    const parent = express.Router();
    mountNestedRouter(parent, '/actions', actions);

    registerRouter({ name: 'actions', mountPath: '/v1', factory: () => parent });

    const spec = buildServedSpec();
    assert.ok(spec.paths['/v1/actions'], 'expected POST /v1/actions to be generated');
    assert.equal(
      spec.paths['/v1/actions/'],
      undefined,
      'a trailing slash must not be published as a distinct path',
    );
  });

  it('pins the canonical contract against an empty-baseline served document', () => {
    // The registry is intentionally empty here (reset in beforeEach, and this
    // case registers nothing), so the served document is exactly the two
    // auto-injected metadata paths. Assert that precondition explicitly: if a
    // registration ever leaks in, the pinned lists below would be compared
    // against a different document and the pins would silently mean something
    // else. See the file header for why production drift is measured elsewhere.
    assert.deepEqual(
      listRegisteredRouters().length,
      0,
      'this comparison assumes an empty registry; register fixtures in their own case',
    );

    const canonical = canonicalPaths();
    const served = servedPaths(buildServedSpec());
    assert.deepEqual(
      [...served.operations].sort(),
      [...PINNED_SERVED_ONLY].sort(),
      'the empty-baseline document must contain only the auto-injected metadata paths',
    );

    const contractOnly = difference(canonical.operations, served.operations);
    const servedOnly = difference(served.operations, canonical.operations);

    assertSameSet(
      contractOnly,
      PINNED_CONTRACT_ONLY,
      'Documented in packages/contracts/src/openapi.ts but absent from the spec served at ' +
        'GET /v1/openapi.json. Either implement/reflect the path or record it in ' +
        'PINNED_CONTRACT_ONLY with a reason.',
    );
    assertSameSet(
      servedOnly,
      PINNED_SERVED_ONLY,
      'Served at GET /v1/openapi.json but absent from the canonical contract. Either add it to ' +
        'packages/contracts/src/openapi.ts or record it in PINNED_SERVED_ONLY with a reason.',
    );
  });

  it('pins the difference between contract and served component schemas', () => {
    const canonical = canonicalPaths();
    const served = servedPaths(buildServedSpec());

    // The served document must declare schemas: without them a generated client
    // cannot resolve a single `#/components/schemas/...` reference.
    assert.notEqual(
      served.schemas.size,
      0,
      'the spec served at GET /v1/openapi.json declares no components.schemas; ' +
        `the canonical contract declares ${canonical.schemas.size}. A served document with no ` +
        'schema components cannot be used to generate typed clients.',
    );

    const contractOnly = difference(canonical.schemas, served.schemas);
    const servedOnly = difference(served.schemas, canonical.schemas);

    assertSameSet(
      contractOnly,
      PINNED_CONTRACT_ONLY_SCHEMAS,
      'Component schemas declared by the canonical contract but not by the served document.',
    );
    assertSameSet(
      servedOnly,
      PINNED_SERVED_ONLY_SCHEMAS,
      'Component schemas declared by the served document but not by the canonical contract.',
    );
  });

  it('canonical contract remains internally resolvable', () => {
    // Guards against a rewrite that "fixes" the drift by pointing the contract
    // at schemas it never defines. All of these are same-document refs; this
    // assertion is safe to keep even while the two documents are reconciled.
    const defined = new Set(Object.keys(OPENAPI_V1_SPEC.components.schemas ?? {}));
    const referenced = new Set<string>();
    JSON.stringify(OPENAPI_V1_SPEC, (_key, value) => {
      if (typeof value === 'string' && value.startsWith('#/components/schemas/')) {
        referenced.add(value.slice('#/components/schemas/'.length));
      }
      return value;
    });
    const dangling = [...referenced].filter((name) => !defined.has(name)).sort();
    assert.deepEqual(
      dangling,
      [],
      `OPENAPI_V1_SPEC references component schemas it does not define: ${dangling.join(', ')}`,
    );
  });
});
