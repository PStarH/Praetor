import {
  reportSilentFailure,
  getGlobalLogger,
  getMetricsCollector,
  HealthCollector,
  buildHealthSources,
  getPluginLoader,
  getWebhookDispatcher,
  getIMProviderRegistry,
  registerBuiltinPlugins,
  zeroTrustMiddleware,
  type MemoryStore,
  createMemoryStore,
  resolveMemoryStoreType,
  installOutboundNetworkPolicy,
  resetOutboundNetworkPolicy,
} from '@praetor/core';
import express from 'express';
import { createWarRoomStore, apiStore } from './store';
import { AgentStateStore } from './agentStateStore';
import { MemoryIndexManager, DEFAULT_DOMAINS } from './memoryIndexManager';
import { ProjectMemoryStoreAdapter } from './memoryStoreAdapter';
import { ActionRationaleStore } from './actionRationale';
import { ConfidenceReporter } from './confidenceReporter';
import { createProjectRouter } from './projectEndpoints';
import { createConflictRouter } from './conflictEndpoints';
import { createSecurityRouter } from './securityEndpoints';
import { createQualityRouter } from './qualityEndpoints';
import { createMemoryIndexRouter } from './memoryIndexEndpoints';
import { createConfidenceRouter } from './confidenceEndpoints';
import { createNamespacedMemoryRouter } from './namespacedMemoryEndpoints';
import { createPipelineRouter } from './pipelineEndpoints';
import { createEvaluationRouter, createProductionLLMCall } from './evaluationEndpoints';
import { LLMEvaluator, ScoreSmoother } from './evaluation';
import { CheckpointManager } from './governanceCheckpoint';
import { createGovernanceRouter } from './governanceEndpoints';
import stateMachineRouter from './stateMachineEndpoints';
import { AgentCardRegistry } from './agentCard';
import { createA2ARouter } from './a2aEndpoints';
import { TaskManager, ArtifactManager } from './a2aTask';
import { createA2AV2Router } from './a2aV2Endpoints';
import { createMCPRouter, createMCPClientRouter } from './mcpEndpoints';
import { createV2BenchRouter } from './v2/v2BenchEndpoints';
import { createCostRouter } from './costEndpoints';
import { createReplayRouter } from './replayEndpoints';
import { createTeamRouter } from './teamEndpoints';
import { createSelfAssessmentRouter } from './selfAssessmentEndpoints';
import { createAgentCardRouter } from './agentCardEndpoints';
import { createReasoningConfigRouter } from './reasoningConfigEndpoints';
import {
  requestIdMiddleware,
  securityHeaders,
  rateLimitMiddleware,
  errorHandler,
  initRateLimitStore,
  closeRateLimitStore,
} from './securityMiddleware';
import { bootstrapDefaultAdminAccount } from './userStore';
import { authMiddleware, apiKeyIdentityMiddleware } from './authMiddleware';
import { initAuthFailureStore } from './authFailureStore';
import { tenantContextMiddleware } from './tenantContextMiddleware';
import { loadTenantProvider } from './tenantProviderLoader';
import { jwtMiddleware } from './jwtMiddleware';
import { createUserAuthRouter } from './userAuthEndpoints';
import { createOIDCAuthRouter } from './oidcAuthEndpoints';
import { createEvaluationRunnerRouter } from './evaluationRunnerEndpoints';
import { createOrchestratorRouter } from './orchestratorEndpoints';
import { createObservabilityRouter } from './observabilityEndpoints';
import { createStreamRouter } from './streamEndpoints';
import { createDlqRouter } from './dlqEndpoints';
import { createApprovalConfigRouter } from './approvalConfigEndpoints';
import { createHallucinationRouter } from './hallucinationEndpoints';
import { createLineageRouter } from './lineageEndpoints';
import { createSecurityPostureRouter } from './securityPostureEndpoints';
import dingtalkPlugin from '@praetor/core/plugins/im/dingtalk';
import feishuPlugin from '@praetor/core/plugins/im/feishu';
import wecomPlugin from '@praetor/core/plugins/im/wecom';
import slackPlugin from '@praetor/core/plugins/im/slack';
import teamsPlugin from '@praetor/core/plugins/im/teams';
import discordPlugin from '@praetor/core/plugins/im/discord';
import { createApiKeyRouter } from './apiKeyEndpoints';
import { createSettingsRouter } from './settingsEndpoints';
import { createOutgoingWebhookRouter } from './outgoingWebhookEndpoints';
import { createCostDashboardRouter } from './costDashboardEndpoints';
import { exportTenantMetrics } from './tenantMetricsExporter';
import { createScimRouter } from './scimEndpoints';
import { getDefaultScimStore } from './scimStore';
import { createKnowledgeBaseRouter } from './knowledgeBaseEndpoints';
import { createEvalRouter } from './evalEndpoints';
import { createReportingRouter } from './reportingEndpoints';
import { createConsensusRouter } from './consensusEndpoints';
import { createOnboardingRouter } from './onboardingEndpoints';
import { createWorkflowRouter } from './workflowEndpoints';
import { createAuditLogRouter } from './auditLogEndpoints';
import { createAuditMiddleware } from './auditMiddleware';
import { createSagaRouter } from './sagaEndpoints';
import { createHubCorrelationsRouter } from './hubCorrelationsEndpoints';
import { getUnifiedAuditLog, dlpResponseMiddleware } from '@praetor/core/security';
import { getGlobalTenantProvider, SimpleTenantProvider } from '@praetor/core/runtime';
import { registerRouter, mountRegisteredRouters, listRegisteredRouters } from './routerRegistry';
import { generateOpenApiSpec } from './openApiGenerator';
import { enterpriseRouteFreeze, legacyHeader } from './enterpriseGateway';
import { v1TenantGuard } from './v1TenantGuard';
import { probeReadiness } from './healthProbes';
import { createV1GatewayRouter } from './v1GatewayEndpoints';
import {
  closeV1KernelGateway,
  getKernelDatabaseUrl,
  getV1KernelGateway,
  initializeV1KernelGateway,
  isCommanderKernelEnabled,
  isCommanderKernelExplicitlyDisabled,
} from './v1GatewayKernel';
import { isLegacyExecutionAllowed } from './legacyExecutionGuard';
import { isEnterpriseProfile } from './profileSignal';
import { isProductionEnv } from './envSignal';
import { resolveApiStartupConfig, assertRateLimitConfiguration } from './startupConfig';
import { resolveTrustProxySetting, TrustProxyConfigError } from './trustProxyConfig';
import { assertDurableStoreConfigured } from './storeBackendGate';
import { startTask1ReadinessService, type Task1ReadinessService } from './task1ReadinessRuntime';

import { getDirname, getRequire } from './esmCompat';
const __dirname = getDirname(import.meta.url);
const require = getRequire(import.meta.url);

const PROJECT_ID = process.env.COMMANDER_PROJECT_ID ?? 'project-war-room';
const app = express();

let API_VERSION = '0.0.0';
try {
  API_VERSION = require('../package.json').version;
} catch (err) {
  reportSilentFailure(err, 'index:56');
  /* use default */
}

// ── Environment validation ──────────────────────────────────────────────────
/**
 * Validate required/recommended environment variables. In production mode,
 * missing critical secrets cause a fast failure with an actionable message.
 * In development/test mode, warnings are emitted and sensible defaults are used.
 */
function validateEnvironment(): void {
  const isProduction = isProductionEnv();

  const criticalSecrets = [
    { name: 'COMMANDER_MASTER_KEY', purpose: 'encryption of sensitive tenant data' },
    { name: 'JWT_SECRET', purpose: 'JWT signing for user/auth tokens' },
    { name: 'COMMANDER_API_KEY', purpose: 'authentication for API requests' },
    { name: 'COMMANDER_CAPABILITY_TOKEN_KEY', purpose: 'signing capability tokens' },
    { name: 'COMMANDER_INTEGRITY_KEY', purpose: 'HMAC integrity verification for persisted data' },
  ];

  const missingCritical: string[] = [];
  for (const { name, purpose } of criticalSecrets) {
    if (!process.env[name]) {
      const message = `[env] ${name} is not set; it is required for ${purpose}.`;
      if (isProduction) {
        console.error(message);
        missingCritical.push(name);
      } else {
        getGlobalLogger().warn('Startup', message, { envVar: name });
      }
    }
  }

  if (missingCritical.length > 0) {
    getGlobalLogger().error('Startup', `Aborting startup: missing ${missingCritical.join(', ')}`);
    process.stderr.write('COMMANDER_API_STARTUP_FAILED: missing required environment variables\n');
    process.exit(1);
  }

  try {
    resolveApiStartupConfig(process.env);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    getGlobalLogger().error('Startup', `Aborting startup: ${message}`);
    process.stderr.write(`COMMANDER_API_STARTUP_FAILED: ${message}\n`);
    process.exit(1);
  }

  if (!process.env.CORS_ORIGINS) {
    getGlobalLogger().warn(
      'Startup',
      `[env] CORS_ORIGINS not set — only localhost origins are allowed. ` +
        `For production/browser access from other hosts, set CORS_ORIGINS=https://your-ui-host.example.com`,
    );
  }

  const storeBackend = process.env.API_STORE_BACKEND;
  if (!storeBackend && !process.env.DATABASE_URL) {
    // AUDIT-K2 (api leg): fail closed in production — an ephemeral in-memory
    // store must never be a silent fallback for a production deployment.
    assertDurableStoreConfigured(process.env);
    getGlobalLogger().warn(
      'Startup',
      'Neither API_STORE_BACKEND nor DATABASE_URL is set. The API will fall back to an in-memory store, which is ephemeral and only suitable for single-node development/testing. Set DATABASE_URL for production persistence.',
    );
  }
}

validateEnvironment();
const apiStartupConfig = resolveApiStartupConfig(process.env);
// AUTH-05: refuse to start on a mistyped quota / window / lockout instead of
// letting NaN comparisons silently disable rate limiting and lockout.
assertRateLimitConfiguration(process.env);

// ── Shared state ────────────────────────────────────────────────────────────
// Missions/UI store — not the /v1 run authority (kernel owns durable runs).
const store = createWarRoomStore();
// Wired when API_STORE_BACKEND=postgres (or sqlite/memory fallback)
const apiStoreInstance = apiStore;
let memoryStore: ProjectMemoryStoreAdapter | undefined;
let canonicalMemoryStore: MemoryStore | undefined;
const agentStateStore = new AgentStateStore();
let memoryIndexManager: MemoryIndexManager | null = null;
let projectMemoryAdapter: ProjectMemoryStoreAdapter | undefined;
const actionRationaleStore = new ActionRationaleStore();
const confidenceReporter = new ConfidenceReporter(actionRationaleStore);
const agentCardRegistry = new AgentCardRegistry();
const evaluator = new LLMEvaluator();
const smoother = new ScoreSmoother();
// LM-28: no governed judge adapter is wired, so the evaluation execution path
// is retired here. `createProductionLLMCall()` fails closed with
// EVALUATION_NOT_AVAILABLE and performs zero network I/O, rather than calling a
// paid provider directly with no deadline and no cost authority. Wiring a
// governed adapter (provider + cost reservation + settlement) is a separate,
// product-owner-approved change.
const productionLLMCall = createProductionLLMCall();
const evaluationRouter = createEvaluationRouter(evaluator, smoother, productionLLMCall);
const checkpointManager = new CheckpointManager();
const governanceRouter = createGovernanceRouter(checkpointManager);
const a2aTaskManager = new TaskManager();
const a2aArtifactManager = new ArtifactManager();
const a2aRouter = createA2ARouter(a2aTaskManager, a2aArtifactManager, agentCardRegistry);
const scimStore = getDefaultScimStore();

// ── Security middleware stack ────────────────────────────────────────────────
// Security: Disable X-Powered-By header to reduce fingerprinting.
// Per Express production security best practices: hide framework identity.
app.disable('x-powered-by');

// Security: Configure trust proxy for reverse proxy deployments.
// AUDIT-E2: no proxy is trusted by default. A default of '1' trusted one hop
// even when the API is directly exposed, making req.ip (auth-failure lockout,
// per-IP rate bucket) spoofable via client-controlled X-Forwarded-For.
// Deployments behind a proxy MUST set TRUST_PROXY_HOPS explicitly; malformed
// values abort startup instead of silently meaning something else.
try {
  app.set('trust proxy', resolveTrustProxySetting(process.env));
} catch (err) {
  if (err instanceof TrustProxyConfigError) {
    process.stderr.write(`[startup] ${err.message}\n`);
    throw err;
  }
  throw err;
}
if (process.env.TRUST_PROXY_HOPS === undefined && isProductionEnv()) {
  process.stderr.write(
    '[startup] TRUST_PROXY_HOPS is unset — no proxy trusted (client X-Forwarded-For is ignored). ' +
      'Set it to your proxy hop count when deploying behind a reverse proxy, or auth-failure ' +
      'lockout and per-IP rate limits will key on the proxy address.\n',
  );
}

// 1. Request ID tracking
app.use(requestIdMiddleware);

// 2. Security headers
app.use(securityHeaders);

// 3. API version header
app.use((_req, res, next) => {
  res.header('X-API-Version', '1.0.0');
  next();
});

// 4. JWT parsing (non-blocking) — must run before rate limiting so
// per-user / per-tenant buckets can be derived from the authenticated
// identity. Public paths (health, login, register) are skipped.
app.use(jwtMiddleware);

// 4a. API-key rate-limit identity (AUTH-02). authMiddleware runs *after* the
// limiter, so API-key callers previously had no key/tenant identity at
// limiting time and got only the anonymous-IP bucket. This runs the canonical
// API-key validation and publishes `req.rateLimitApiKey` only; authorization
// identity stays unset until authMiddleware validates the key again.
app.use(apiKeyIdentityMiddleware);

// 5. Rate limiting — now aware of tenant → user → IP identity.
app.use(rateLimitMiddleware);

// 6. CORS whitelist (not wildcard)
const API_PORT = parseInt(process.env.PORT ?? '4000', 10);
const WEB_PORT = parseInt(process.env.WEB_PORT ?? '5173', 10);

const ALLOWED_ORIGINS = new Set([
  `http://localhost:${WEB_PORT}`,
  `http://localhost:${API_PORT}`,
  `http://127.0.0.1:${WEB_PORT}`,
  ...(process.env.CORS_ORIGINS?.split(',').map((s) => s.trim()) ?? []),
]);

// Local-first default: only localhost origins are allowed when CORS_ORIGINS
// is unset. Surface this at startup so production deployments know to set it.
if (!process.env.CORS_ORIGINS) {
  getGlobalLogger().warn(
    'Startup',
    'CORS_ORIGINS not set — only localhost origins are allowed. For production/browser access from other hosts, set CORS_ORIGINS=https://your-ui-host.example.com',
  );
}

app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  const origin = req.headers.origin;
  // Security: Per OWASP CORS guidance — only set Allow-Credentials when origin
  // matches the allowlist. Never combine wildcard origin with credentials.
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Vary', 'Origin');
  }
  res.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
  res.header(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-Request-ID, X-API-Key, X-Tenant-ID',
  );
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

// Legacy /api/runs must advertise Gone when V2/production disables in-process
// execution — before authMiddleware, otherwise unauthenticated probes get 401
// and look like a still-mounted legacy surface (WS9 env-check).
app.use('/api/runs', (req, res, next) => {
  if (isLegacyExecutionAllowed()) {
    next();
    return;
  }
  // Mounted before enterpriseRouteFreeze/legacyHeader — set freeze headers here.
  res.set('x-legacy', 'true');
  res.set('Deprecation', 'true');
  res.status(410).json({
    error: {
      code: 'LEGACY_EXECUTION_GONE',
      message: 'Legacy /api/runs is not available; use /v1/runs.',
    },
  });
});

// 7. Authentication (skipped only by the explicit non-production anonymous mode)
// JWT was already parsed in step 4 for rate-limit identity. API-key auth runs
// here and skips requests already authenticated via JWT (req.user set).
app.use(authMiddleware);

// 7a. Tenant context propagation. After auth has resolved the tenant identity
// (API key / JWT mapping), bind the async tenant context so that all downstream
// core singletons return tenant-scoped instances. Requests without a tenant
// continue in single-tenant mode.
app.use(tenantContextMiddleware);

// 7b. Zero-trust request-signature validation. When no keys are registered it
// passes through (skipIfNoKeys), so existing deployments keep working. Once
// keys are registered via the security endpoints, every mutating request must
// carry a valid X-Signature header.
app.use(
  zeroTrustMiddleware({
    skipPaths: ['/health', '/ready', '/metrics', '/openapi.json'],
    skipIfNoKeys: true,
  }),
);

// 8. Audit middleware — records all mutating (POST/PUT/PATCH/DELETE) requests
// to the unified audit trail (.commander/audit/user-actions.ndjson). Mounted
// after auth so req.user / req.apiKeyId are populated, and before routers so
// the response `finish` listener is attached before handlers run. Sensitive
// body fields are stripped by createAuditMiddleware before persistence.
app.use(createAuditMiddleware(getUnifiedAuditLog()));

// 9. DLP response middleware — scans all HTTP responses (JSON/text/HTML/XML)
// for sensitive data (API keys, private keys, JWTs, etc.) and redacts/masks
// before sending to client. Excludes event-stream to avoid buffering SSE.
// If DLP is disabled, the middleware passes through with zero overhead.
// blockOnCritical returns 403 for critical-severity data leakage.
app.use(
  dlpResponseMiddleware({
    contentTypes: ['json', 'text', 'xml', 'html'],
    blockOnCritical: true,
  }),
);

// ── System ──────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  const memUsage = process.memoryUsage();
  const heapUsedMB = Math.floor(memUsage.heapUsed / 1024 / 1024);
  const heapTotalMB = Math.floor(memUsage.heapTotal / 1024 / 1024);

  // Degraded only when absolute heap is large AND ratio is high — a young
  // process with a tiny heapTotal (e.g. 49MB) often sits at >80% and is not
  // actually memory-exhausted.
  const heapHealthy = heapUsedMB < 256 || heapUsedMB / Math.max(heapTotalMB, 1) < 0.9;
  const status = heapHealthy ? 'healthy' : 'degraded';

  res.status(heapHealthy ? 200 : 503).json({
    status,
    projectId: PROJECT_ID,
    uptime: Math.floor(process.uptime()),
    memory: {
      heapUsed: `${heapUsedMB}MB`,
      heapTotal: `${heapTotalMB}MB`,
      heapPercent: Math.round((heapUsedMB / heapTotalMB) * 100),
    },
    version: API_VERSION,
    timestamp: new Date().toISOString(),
  });
});

// Readiness probe — WS3 §6.1 honesty: real probes replace fake-READY.
// Hard gates (database/kernel) fail → 503. Soft indicators
// (warRoomStore/memoryHeap) surface honestly but never gate.
// Effect monopoly / PEP is NOT on this surface — observe worker-plane
// EffectBroker bootstrap/assert, kernel-ops GET /ready (ops loops), and
// (L4-B) adapter-ops GET /ready for compensation drain. Do not probe the
// always-null core registry (direction audit 2026-07-20-effect-broker-health-registry).
app.get('/ready', async (_req, res) => {
  const result = await probeReadiness({
    kernel: () => getV1KernelGateway(),
    evidenceRepository: async () => {
      const gateway = getV1KernelGateway();
      if (!gateway?.getEvidenceRepositoryAvailability) throw new Error('unavailable');
      if (!(await gateway.getEvidenceRepositoryAvailability()).ready)
        throw new Error('unavailable');
      return 'ok';
    },
    warRoomStore: () => store !== null,
    memoryHeap: () => {
      const mem = process.memoryUsage();
      const total = mem.heapTotal || 1;
      return mem.heapUsed / total;
    },
  });
  res.status(result.status === 'ready' ? 200 : 503).json(result);
});

// /v1/health — WS3 §6.1: /v1 subtree deps (kernel). DB failure surfaces via kernel.
app.get('/v1/health', async (_req, res) => {
  const result = await probeReadiness({
    kernel: () => getV1KernelGateway(),
    evidenceRepository: async () => {
      const gateway = getV1KernelGateway();
      if (!gateway?.getEvidenceRepositoryAvailability) throw new Error('unavailable');
      if (!(await gateway.getEvidenceRepositoryAvailability()).ready)
        throw new Error('unavailable');
      return 'ok';
    },
  });
  res.status(result.status === 'ready' ? 200 : 503).json({
    status: result.status,
    checks: {
      kernel: result.checks.kernel,
      evidenceRepository: result.checks.evidenceRepository,
    },
    timestamp: result.timestamp,
  });
});

// Detailed health — delegates component-level diagnostics to the shared core
// HealthCollector (memory / disk / circuit-breaker / DLQ / …) so the API layer
// does not dual-track the same checks that CommanderHttpServer already runs.
// API-specific module availability is layered on top.
//
// Audit-fix (C-P0-2): previously `new HealthCollector()` was constructed
// without sources, so 5 of the 8 internal checks (circuit breaker, DLQ,
// compensation, event bus, providers) silently returned
// `{ status: 'healthy', message: '... not wired' }` regardless of the
// underlying component state. This made the probe unverifiable: a DLQ that
// had crashed OR a toppled circuit breaker would still report green, and
// k8s/PaaS readiness gates would keep forwarding traffic to a doomed node.
// Fixed: all unwired checks now return 'degraded' (fail-closed). The
// shared buildHealthSources() wires event bus, DLQ, and compensation queue
// from global singletons. Circuit-breaker and provider checks require an
// active AgentRuntime session (see CommanderHttpServer.buildHealthSources).
app.get('/health/detailed', async (_req, res) => {
  const collector = new HealthCollector({ sources: buildHealthSources() });
  const result = await collector.collect();
  const memUsage = process.memoryUsage();
  const heapUsedMB = Math.floor(memUsage.heapUsed / 1024 / 1024);
  const heapTotalMB = Math.floor(memUsage.heapTotal / 1024 / 1024);
  const rssMB = Math.floor(memUsage.rss / 1024 / 1024);

  res.status(result.status === 'unhealthy' ? 503 : 200).json({
    status: result.status,
    projectId: PROJECT_ID,
    uptime: Math.floor(process.uptime()),
    version: API_VERSION,
    memory: {
      rss: `${rssMB}MB`,
      heapUsed: `${heapUsedMB}MB`,
      heapTotal: `${heapTotalMB}MB`,
      heapPercent: Math.round((heapUsedMB / heapTotalMB) * 100),
    },
    components: result.checks,
    modules: {
      warRoom: store ? 'active' : 'inactive',
      apiStore: apiStoreInstance ? 'active' : 'inactive',
      memoryStore: memoryStore ? 'active' : 'inactive',
      agentStateStore: agentStateStore ? 'active' : 'inactive',
      memoryIndexManager: memoryIndexManager ? 'active' : 'inactive',
      confidenceReporter: confidenceReporter ? 'active' : 'inactive',
      governance: checkpointManager
        ? checkpointManager.getStats().expired > 0
          ? 'degraded'
          : 'active'
        : 'inactive',
      checkpointManager: checkpointManager ? 'active' : 'inactive',
    },
    timestamp: new Date().toISOString(),
  });
});

// Prometheus metrics endpoint — exports all business metrics via the unified
// MetricsCollector (counters/gauges/histograms) plus supplementary process-level
// gauges (heap/rss/uptime/event-loop-lag) that the business collector does not
// track. Prometheus scrapes both in a single pull.
app.get('/metrics', (_req, res) => {
  const memUsage = process.memoryUsage();
  const heapUsed = memUsage.heapUsed;
  const heapTotal = memUsage.heapTotal;
  const rss = memUsage.rss;
  const uptime = process.uptime();

  const businessMetrics = getMetricsCollector().exportOpenMetrics();
  const tenantMetrics = exportTenantMetrics(process.env.METRICS_TENANT_LABELS === 'true');

  const processMetrics = [
    '# HELP commander_heap_used_bytes Heap memory used in bytes',
    '# TYPE commander_heap_used_bytes gauge',
    `commander_heap_used_bytes ${heapUsed}`,
    '',
    '# HELP commander_heap_total_bytes Total heap size in bytes',
    '# TYPE commander_heap_total_bytes gauge',
    `commander_heap_total_bytes ${heapTotal}`,
    '',
    '# HELP commander_rss_bytes Resident set size in bytes',
    '# TYPE commander_rss_bytes gauge',
    `commander_rss_bytes ${rss}`,
    '',
    '# HELP commander_uptime_seconds Server uptime in seconds',
    '# TYPE commander_uptime_seconds gauge',
    `commander_uptime_seconds ${uptime}`,
    '',
    '# HELP commander_heap_percent Heap usage percentage',
    '# TYPE commander_heap_percent gauge',
    `commander_heap_percent ${Math.round((heapUsed / heapTotal) * 100)}`,
    '',
  ].join('\n');

  res.type('text/plain; version=0.0.4').send(businessMetrics + tenantMetrics + processMetrics);
});

app.get('/system/status', (_req, res) => {
  const uptime = process.uptime();
  const memUsage = process.memoryUsage();
  res.json({
    status: 'ok',
    uptime: Math.floor(uptime),
    memory: {
      rss: Math.floor(memUsage.rss / 1024 / 1024) + 'MB',
      heapUsed: Math.floor(memUsage.heapUsed / 1024 / 1024) + 'MB',
      heapTotal: Math.floor(memUsage.heapTotal / 1024 / 1024) + 'MB',
    },
    modules: {
      core: 'loaded',
      warRoom: store ? 'active' : 'inactive',
      apiStore: apiStoreInstance ? 'active' : 'inactive',
      memoryStore: memoryStore ? 'active' : 'inactive',
      agentStateStore: agentStateStore ? 'active' : 'inactive',
      memoryIndexManager: memoryIndexManager ? 'active' : 'inactive',
      confidenceReporter: confidenceReporter ? 'active' : 'inactive',
    },
    timestamp: new Date().toISOString(),
  });
});

// ── Routers ─────────────────────────────────────────────────────────────────
// All routers are registered via the endpoint registry (routerRegistry.ts) as a
// single declarative manifest. Adding an endpoint is now ONE registerRouter()
// line here — no separate import+app.use scattered across the file. Factories
// capture shared state (store/memoryStore/etc.) via closure. Registration order
// = mount order, which preserves the auth-before-routers invariant.
//
// User authentication (register/login/me/refresh/users) is mounted first so the
// auth endpoints are available before any feature routers.
registerRouter({ name: 'user-auth', mountPath: '/', factory: () => createUserAuthRouter() });
registerRouter({ name: 'oidc-auth', mountPath: '/', factory: () => createOIDCAuthRouter() });

// Architecture V2 public control-plane resources. Unlike legacy /api/runtime
// endpoints, these routes submit/query durable kernel state and never execute
// an AgentRuntime in the Gateway process.
registerRouter({
  name: 'v1-runs',
  mountPath: '/v1',
  factory: () => createV1GatewayRouter(getV1KernelGateway),
  openapi: {
    tags: ['Runs'],
    description:
      'Durable execution kernel run surface (Architecture V2). Async submission with Idempotency-Key + tenant identity.',
  },
});

// WS3 §5.1 — WarRoom demoted to read-only ops panel under /v1.
// Only GET endpoints are mounted (readOnly: true). The legacy write endpoints
// (missions/approve/logs/agent-state/memory) are frozen: 410 in enterprise,
// x-legacy in standard. They never appear under /v1.
registerRouter({
  name: 'v1-projects',
  mountPath: '/v1',
  factory: () => createProjectRouter(store, memoryStore!, agentStateStore, { readOnly: true }),
  openapi: {
    tags: ['Projects', 'WarRoom', 'Memory', 'Governance'],
    description: 'Read-only WarRoom / project / memory / governance surface (WS3 §5.1 demotion).',
  },
});

// V2 live benchmark harness routes (in-memory ledger for Layer B topology tests).
// AUDIT-R4F1: opt-in only — the harness ledger is tenant-spoofable,
// unauthenticated-role-accessible and in-memory; it must never be mounted in a
// production topology by default.
if (process.env.COMMANDER_V2_BENCH_HARNESS === '1') {
  registerRouter({
    name: 'v2-bench',
    mountPath: '/v2',
    factory: () => createV2BenchRouter(),
  });
}

// Observability routes must be mounted before the legacy execution routers
// (pipeline/orchestrator) because those routers' compatibility middleware
// returns 410 for every path when legacy execution is disabled, which would
// otherwise shadow /api/v1/observability.
registerRouter({
  name: 'v1-observability',
  mountPath: '/api/v1/observability',
  factory: () => createObservabilityRouter(),
});

registerRouter({
  name: 'project',
  mountPath: '/',
  factory: () => createProjectRouter(store, memoryStore!, agentStateStore),
});
registerRouter({
  name: 'memory-index',
  mountPath: '/',
  factory: () => createMemoryIndexRouter(memoryIndexManager!, store),
});
registerRouter({ name: 'conflict', mountPath: '/', factory: () => createConflictRouter(store) });
registerRouter({ name: 'security', mountPath: '/', factory: () => createSecurityRouter() });
registerRouter({
  name: 'confidence',
  mountPath: '/',
  factory: () => createConfidenceRouter(store, confidenceReporter),
});
registerRouter({ name: 'quality', mountPath: '/', factory: () => createQualityRouter() });
registerRouter({
  name: 'self-assessment',
  mountPath: '/api',
  factory: () => createSelfAssessmentRouter(),
});
registerRouter({
  name: 'evaluation',
  mountPath: '/api/evaluation',
  factory: () => evaluationRouter,
});
registerRouter({
  name: 'governance',
  mountPath: '/api/governance',
  factory: () => governanceRouter,
});
registerRouter({
  name: 'state-machine',
  mountPath: '/api/state-machine',
  factory: () => stateMachineRouter,
});
registerRouter({
  name: 'agent-card',
  mountPath: '/api',
  factory: () => createAgentCardRouter(agentCardRegistry),
});
registerRouter({
  name: 'reasoning-config',
  mountPath: '/api',
  factory: () => createReasoningConfigRouter(),
});
registerRouter({
  name: 'evaluation-runner',
  mountPath: '/api',
  factory: () => createEvaluationRunnerRouter(),
});
registerRouter({ name: 'pipeline', mountPath: '/', factory: () => createPipelineRouter() });
registerRouter({
  name: 'workflow',
  mountPath: '/',
  factory: () => createWorkflowRouter(),
});
registerRouter({
  name: 'namespaced-memory',
  mountPath: '/',
  factory: () => createNamespacedMemoryRouter(canonicalMemoryStore!),
});
registerRouter({ name: 'a2a', mountPath: '/a2a', factory: () => a2aRouter });
registerRouter({ name: 'a2a-v2', mountPath: '/a2a/v2', factory: () => createA2AV2Router() });
registerRouter({ name: 'mcp', mountPath: '/mcp', factory: () => createMCPRouter() });
registerRouter({
  name: 'mcp-client',
  mountPath: '/mcp/client',
  factory: () => createMCPClientRouter(),
});
registerRouter({
  name: 'stream',
  mountPath: '/',
  factory: () =>
    createStreamRouter({
      resolveProject: (projectId) => store.getProjectSnapshot(projectId)?.project,
    }),
});
// ── Legacy execution routes ─────────────────────────────────────────────────
// These routes create AgentRuntime directly in the Gateway process, which
// violates the V2 execution separation principle (WP3). They are disabled
// in V2 mode (COMMANDER_V2_MODE=1 or NODE_ENV=production).
if (isLegacyExecutionAllowed()) {
  registerRouter({
    name: 'orchestrator',
    mountPath: '/api',
    factory: () => createOrchestratorRouter(),
  });
  registerRouter({
    name: 'v1-orchestrator',
    mountPath: '/api/v1',
    factory: () => createOrchestratorRouter(),
  });
}
registerRouter({ name: 'cost', mountPath: '/', factory: () => createCostRouter() });
registerRouter({ name: 'replay', mountPath: '/', factory: () => createReplayRouter() });
registerRouter({ name: 'team', mountPath: '/', factory: () => createTeamRouter() });

registerRouter({ name: 'dlq', mountPath: '/', factory: () => createDlqRouter() });
registerRouter({
  name: 'approval-config',
  mountPath: '/',
  factory: () => createApprovalConfigRouter(),
});
registerRouter({
  name: 'hallucination',
  mountPath: '/',
  factory: () => createHallucinationRouter(),
});
registerRouter({ name: 'lineage', mountPath: '/', factory: () => createLineageRouter() });
registerRouter({
  name: 'security-posture',
  mountPath: '/',
  factory: () => createSecurityPostureRouter(),
});

// ── API Key management (admin only) ─────────────────────────────────────────
registerRouter({ name: 'api-keys', mountPath: '/', factory: () => createApiKeyRouter() });

// ── Global settings (model / feature flags / notifications) ─────────────────
registerRouter({ name: 'settings', mountPath: '/', factory: () => createSettingsRouter() });

// ── Outgoing webhook dispatcher (delivery tracking + retry) ─────────────────
registerRouter({
  name: 'outgoing-webhooks',
  mountPath: '/',
  factory: () => createOutgoingWebhookRouter(),
});

// ── Cost Dashboard (enterprise cost analytics) ─────────────────────────────
registerRouter({
  name: 'cost-dashboard',
  mountPath: '/',
  factory: () => createCostDashboardRouter(),
});

// ── SCIM 2.0 provisioning (enterprise SSO / IdP integration skeleton) ──────
registerRouter({
  name: 'scim',
  mountPath: '/scim/v2',
  factory: () => createScimRouter(scimStore),
});

// Built-in plugins (RAG/RASP/gap/observability + IM SPI) are registered in
// startServer() before listen so webhook routes never race an empty registry.

// ── External plugin discovery ──────────────────────────────────────────────
// Discover and load externally-installed plugins from .commander/plugins/
// (project-local) and ~/.commander/plugins/ (user-global). Disabled plugins
// are skipped per the persisted enabled-state map. Failures are non-fatal —
// a broken third-party plugin must never block API startup.
getPluginLoader()
  .loadAll()
  .then((loaded) => {
    if (loaded.length > 0) {
      getGlobalLogger().info('PluginLoader', `Loaded ${loaded.length} external plugin(s)`);
    }
  })
  .catch((err: unknown) => reportSilentFailure(err, 'index:pluginLoader.loadAll'));

registerRouter({
  name: 'knowledge-base',
  mountPath: '/',
  factory: () => createKnowledgeBaseRouter(),
});

// ── Eval / Reporting / Consensus plugin routers (control + data plane) ────
registerRouter({ name: 'eval', mountPath: '/', factory: () => createEvalRouter() });
registerRouter({ name: 'reporting', mountPath: '/', factory: () => createReportingRouter() });
registerRouter({ name: 'consensus', mountPath: '/', factory: () => createConsensusRouter() });

// ── Unified Audit Log (cross-source query/export/stats) ────────────────────
registerRouter({ name: 'audit-log', mountPath: '/', factory: () => createAuditLogRouter() });

// ── Onboarding Wizard (Web 端上手引导) ──────────────────────────────────────
// 解决 POC→生产鸿沟：为新用户提供首次登录后的多步骤引导向导后端能力。
registerRouter({ name: 'onboarding', mountPath: '/', factory: () => createOnboardingRouter() });

// ── Saga Compensation (分布式事务补偿) ───────────────────────────────────────
// Saga 模式长运行事务的管理与补偿：列出运行中事务、查看时间线、
// 恢复中断事务、分叉新执行路径、实时流传输状态变更。
registerRouter({ name: 'saga', mountPath: '/', factory: () => createSagaRouter() });

// ── Hub Correlations (Tier-0 关联事件可观测性) ──────────────────────────────
// 跨运行时关联事件的管理员观测端点：循环检测关联、重试阻断关联、
// 语义断路器关联。支持 REST 摘要查询和 SSE 实时流。
registerRouter({
  name: 'hub-correlations',
  mountPath: '/api/v1/hub/correlations',
  factory: () => createHubCorrelationsRouter(),
});

// ── API v1 versioned aliases (backward-compatible) ──────────────────────────
// All routes are accessible under /api/v1/ prefix in addition to their original paths.
// This provides explicit API versioning without breaking existing clients.
registerRouter({
  name: 'v1-evaluation',
  mountPath: '/api/v1/evaluation',
  factory: () => evaluationRouter,
});
registerRouter({
  name: 'v1-governance',
  mountPath: '/api/v1/governance',
  factory: () => governanceRouter,
});
// Intentionally not mounted under /api/v1/* — in-memory StateMachine is not
// durable run authority. Legacy path remains /api/state-machine behind
// COMMANDER_LEGACY_EXECUTION=1 (see stateMachineEndpoints + pipelineEndpoints).
registerRouter({
  name: 'v1-self-assessment',
  mountPath: '/api/v1',
  factory: () => createSelfAssessmentRouter(),
});
registerRouter({
  name: 'v1-agent-card',
  mountPath: '/api/v1',
  factory: () => createAgentCardRouter(agentCardRegistry),
});
registerRouter({
  name: 'v1-reasoning-config',
  mountPath: '/api/v1',
  factory: () => createReasoningConfigRouter(),
});
registerRouter({
  name: 'v1-evaluation-runner',
  mountPath: '/api/v1',
  factory: () => createEvaluationRunnerRouter(),
});

// ── OpenAPI (auto-generated from registered routes — WS3 §4) ────────────────
// The spec is generated at request time from listRegisteredRouters() so it is
// always in sync with the actual mounted routes. No handwritten paths.
//   /v1/openapi.json — enterprise canonical (WS3 §4.1)
//   /api/openapi.json  — standard-profile alias (marked x-legacy; enterprise
//                        profile 410s it in-handler — mounted before freeze)
app.get('/v1/openapi.json', (_req, res) => {
  res.json(
    generateOpenApiSpec({
      title: 'Commander Enterprise API',
      version: API_VERSION,
      serverUrl: `http://localhost:${API_PORT}`,
    }),
  );
});
app.get('/api/openapi.json', (_req, res) => {
  // Mounted before enterpriseRouteFreeze/legacyHeader — tag + freeze in-handler.
  res.set('x-legacy', 'true');
  res.set('Deprecation', 'true');
  if (isEnterpriseProfile()) {
    res.status(410).json({
      error: {
        code: 'GONE',
        message: 'This route is frozen in the enterprise profile. Use GET /v1/openapi.json.',
      },
    });
    return;
  }
  res.json(
    generateOpenApiSpec({
      title: 'Commander Enterprise API',
      version: API_VERSION,
      serverUrl: `http://localhost:${API_PORT}`,
    }),
  );
});

// ── Startup + Graceful Shutdown ──────────────────────────────────────────────
const port = Number(process.env.PORT || 4000);

// Auth authorities are initialized before listen. They require PostgreSQL and
// fail closed instead of allowing a process-local fallback. Server reference
// is captured so gracefulShutdown can drain it.
let httpServer: { close: (cb?: () => void) => void } | null = null;
let task1ReadinessService: Task1ReadinessService | undefined;

async function closeTask1ReadinessService(): Promise<void> {
  const service = task1ReadinessService;
  task1ReadinessService = undefined;
  await service?.close();
}

async function startServer(): Promise<void> {
  // Load tenant configuration before any routers or shared singletons are
  // created. Missing config falls back to single-tenant mode (NullTenantProvider).
  loadTenantProvider();

  // Initialize the shared execution kernel before V1 resource routes are used.
  // Auto-on when production / V2 mode / DSN present (see isCommanderKernelEnabled).
  // /v1 never falls back to WarRoomStore; missing kernel → KERNEL_UNAVAILABLE.
  await initializeV1KernelGateway();

  // Context-aware releases expose compatibility proof on a separate TLS 1.3
  // listener. The request never traverses generic API middleware.
  task1ReadinessService = await startTask1ReadinessService();

  if (process.env.NODE_ENV === 'production') {
    // Fail closed at startup rather than booting a production replica that would
    // 503 every /v1/runs request and has no durable, single-writer execution
    // substrate. Multi-replica production without the shared kernel is unsafe
    // (split-brain, per-replica in-memory state). See audit REL-5.
    // COMMANDER_KERNEL_ENABLED=0 is a non-prod escape hatch only.
    if (isCommanderKernelExplicitlyDisabled()) {
      throw new Error(
        '[kernel] Refusing to start: NODE_ENV=production rejects COMMANDER_KERNEL_ENABLED=0. ' +
          'Production requires the durable shared kernel. Unset COMMANDER_KERNEL_ENABLED ' +
          '(or set =1) and provide COMMANDER_KERNEL_DATABASE_URL or DATABASE_URL.',
      );
    }
    if (!isCommanderKernelEnabled() || !getKernelDatabaseUrl() || getV1KernelGateway() === null) {
      throw new Error(
        '[kernel] Refusing to start: NODE_ENV=production requires an initialized durable kernel. ' +
          'Provide COMMANDER_KERNEL_DATABASE_URL or DATABASE_URL so V1 resource routes run on ' +
          'the shared durable kernel instead of failing closed.',
      );
    }
  }

  await initRateLimitStore();
  initAuthFailureStore();
  await bootstrapDefaultAdminAccount();

  // Memory backend selection:
  // - Non-production: Local-First via resolveMemoryStoreType (in-memory without DSN).
  // - Production: require a Postgres DSN or explicit COMMANDER_MEMORY_STORE=in-memory
  //   (never silently drop durability on the Enterprise Gateway path).
  const explicitMemory = process.env.COMMANDER_MEMORY_STORE;
  const hasPostgresDsn = Boolean(process.env.COMMANDER_POSTGRES_URL || process.env.DATABASE_URL);
  let memoryType: 'postgres' | 'in-memory';
  if (process.env.NODE_ENV === 'production') {
    if (explicitMemory === 'in-memory') {
      memoryType = 'in-memory';
    } else if (explicitMemory === 'postgres' || hasPostgresDsn) {
      memoryType = 'postgres';
    } else {
      throw new Error(
        '[Memory] Refusing to start: NODE_ENV=production requires COMMANDER_POSTGRES_URL ' +
          'or DATABASE_URL for durable memory, or explicit COMMANDER_MEMORY_STORE=in-memory.',
      );
    }
  } else {
    memoryType = resolveMemoryStoreType({
      memoryStoreType:
        explicitMemory === 'postgres' || explicitMemory === 'in-memory'
          ? explicitMemory
          : undefined,
    });
  }
  try {
    const canonicalStore = await createMemoryStore(memoryType, {
      connectionString: process.env.COMMANDER_POSTGRES_URL ?? process.env.DATABASE_URL,
      manageSchema:
        memoryType === 'postgres' && process.env.NODE_ENV === 'production' ? false : undefined,
    });
    canonicalMemoryStore = canonicalStore;
    projectMemoryAdapter = new ProjectMemoryStoreAdapter(canonicalStore);
    memoryStore = projectMemoryAdapter;
    process.stdout.write(`[Memory] Canonical service enabled (${memoryType})\n`);
  } catch (err) {
    reportSilentFailure(err, 'index:startServer:memory');
    throw err;
  }

  memoryIndexManager = new MemoryIndexManager(PROJECT_ID, projectMemoryAdapter, DEFAULT_DOMAINS);

  // Built-in plugins before listen: IM providers must be resolvable for webhooks.
  getIMProviderRegistry().reset();
  const builtinResult = await registerBuiltinPlugins({
    rasp: true,
    taint: true,
    rag: true,
    ragDisabled: true,
    gap: true,
    observability: true,
    extraPlugins: [
      dingtalkPlugin,
      feishuPlugin,
      wecomPlugin,
      slackPlugin,
      teamsPlugin,
      discordPlugin,
    ],
  });
  if (builtinResult.errors.length > 0) {
    process.stderr.write(
      `[startup] Built-in plugin registration errors: ${JSON.stringify(builtinResult.errors)}\n`,
    );
  }

  // Mount routers after shared state (including memoryIndexManager) is initialized.
  getGlobalLogger().info('Mount', 'registered routers', {
    routers: listRegisteredRouters().map((r) => `${r.name}@${r.mountPath}`),
  });

  // WS3 §2/§3/§8 — Enterprise gateway middleware (mounted BEFORE product
  // routers so non-/v1 paths are blocked/tagged before any handler runs):
  //   1. v1TenantGuard — fail-closed tenant identity gate on /v1 (§3.2)
  //   2. enterpriseRouteFreeze — 410 Gone for non-/v1 product paths (§2.1)
  //   3. legacyHeader — x-legacy: true tag for non-/v1 paths in standard (§8.1)
  app.use(v1TenantGuard());
  app.use(enterpriseRouteFreeze());
  app.use(legacyHeader());

  mountRegisteredRouters(app);

  // Unmatched routes — keep shape stable after errorHandler moved behind routers.
  app.use((req, res) => {
    res.status(404).json({
      error: 'Not found',
      path: req.path,
      requestId: req.requestId,
    });
  });

  // Error handler must be registered after all routers so Express 5 can
  // forward route errors into this middleware (registering earlier skips it).
  app.use(errorHandler);

  // Start the outgoing webhook dispatcher so registered webhooks receive
  // system events as soon as the server is ready.
  getWebhookDispatcher().start();

  // Egress firewall + SSRF defense for all process-wide fetch (MCP HTTP, webhooks, …).
  try {
    resetOutboundNetworkPolicy();
    installOutboundNetworkPolicy();
    process.stdout.write('[startup] OutboundNetworkPolicy installed\n');
  } catch (err) {
    process.stderr.write(
      `[startup] OutboundNetworkPolicy failed: ${(err as Error)?.message ?? String(err)}\n`,
    );
    if (process.env.NODE_ENV === 'production') throw err;
  }

  // WS9: opt-in audit chain manifest + verify timer (COMMANDER_AUDIT_MANIFEST_DIR).
  if (process.env.COMMANDER_AUDIT_MANIFEST_DIR) {
    try {
      const { getAuditChainLedger, installAuditChainIntegrity } = await import('@praetor/core');
      installAuditChainIntegrity(getAuditChainLedger());
      process.stdout.write('[startup] AuditChainIntegrity installed (manifest + verify timer)\n');
    } catch (err) {
      process.stderr.write(
        `[startup] AuditChainIntegrity failed: ${(err as Error)?.message ?? String(err)}\n`,
      );
      if (process.env.NODE_ENV === 'production') throw err;
    }
  }

  httpServer = app.listen(port, apiStartupConfig.host, () => {
    process.stdout.write(`API listening on http://${apiStartupConfig.host}:${port}\n`);
    process.stdout.write(
      `[Architecture V2] apps/api is the sole Gateway — do not expose core CommanderHttpServer in production\n`,
    );
    process.stdout.write(`War room project ready at GET /projects/${PROJECT_ID}/war-room\n`);
  });
}

startServer().catch(async (err: Error) => {
  process.stderr.write('COMMANDER_API_STARTUP_FAILED: ' + err.message + '\n');
  try {
    await closeTask1ReadinessService();
  } catch (closeErr) {
    process.stderr.write(`[startup] Failed to close tenant-authority proof service: ${closeErr}\n`);
  }
  try {
    await closeV1KernelGateway();
  } catch (closeErr) {
    process.stderr.write(`[startup] Failed to close kernel gateway: ${closeErr}\n`);
  }
  process.exit(1);
});

// P1: Graceful shutdown — drain connections, flush state, then exit
let shuttingDown = false;
async function finishGracefulShutdown(): Promise<void> {
  try {
    getWebhookDispatcher().stop();
  } catch (dispatcherErr) {
    process.stderr.write(`[shutdown] Failed to stop webhook dispatcher: ${dispatcherErr}\n`);
  }

  try {
    await closeTask1ReadinessService();
  } catch (closeErr) {
    process.stderr.write(
      `[shutdown] Failed to close tenant-authority proof service: ${closeErr}\n`,
    );
  }

  try {
    await closeV1KernelGateway();
  } catch (closeErr) {
    process.stderr.write(`[shutdown] Failed to close kernel gateway: ${closeErr}\n`);
  }

  // Close database connections (no-op for JSON store)
  try {
    store.close();
  } catch (closeErr) {
    process.stderr.write(`[shutdown] Failed to close store: ${closeErr}\n`);
  }

  // Close the A2A API store (PostgresPool-backed when API_STORE_BACKEND=postgres)
  try {
    await apiStoreInstance.close();
  } catch (closeErr) {
    process.stderr.write(`[shutdown] Failed to close API store: ${closeErr}\n`);
  }

  // Close the rate-limit persistent store (audit MED item 3 follow-up).
  // Idempotent — safe even if init failed.
  closeRateLimitStore();

  // Close the optional memory-index adapter store (sqlite/json backend).
  try {
    await projectMemoryAdapter?.close();
  } catch (closeErr) {
    process.stderr.write(`[shutdown] Failed to close memory-index adapter: ${closeErr}\n`);
  }

  // Log loaded tenant count for multi-tenant deployments.
  const tenantProvider = getGlobalTenantProvider();
  if (tenantProvider instanceof SimpleTenantProvider) {
    const tenantCount = tenantProvider.getKnownTenants().length;
    process.stdout.write(`[shutdown] Loaded ${tenantCount} tenant(s)\n`);
  }

  process.stdout.write('[shutdown] Complete\n');
  process.exit(0);
}

function gracefulShutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(`\n[${signal}] Shutting down gracefully...\n`);

  const finish = (): void => {
    void finishGracefulShutdown();
  };
  if (httpServer) {
    httpServer.close(() => {
      process.stdout.write('[shutdown] HTTP server closed\n');
      finish();
    });
  } else {
    finish();
  }

  // Force exit after 10s if graceful shutdown hangs
  setTimeout(() => {
    process.stderr.write('[shutdown] Force exit after 10s timeout\n');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
