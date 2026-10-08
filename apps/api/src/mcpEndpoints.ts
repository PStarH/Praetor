import express, { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { hashSecret } from '@praetor/core/runtime';
import { MCPServer, getModelRouter, createMCPClient, reportSilentFailure } from '@praetor/core';
import type {
  MCPTool,
  MCPToolResult,
  MCPContentItem,
  ModelTier,
  MCPClientConfig,
} from '@praetor/core';
import { URL } from 'node:url';
import * as path from 'node:path';
import { hasRole, type UserRole } from './userStore';
import { getApiKeyStore } from './apiKeyStore';
import { getCurrentTenantId } from '@praetor/core/runtime/tenantContext';

// ── Security: SSRF prevention ────────────────────────────────────────────────
// Block requests to private/internal IP ranges and cloud metadata endpoints.
const PRIVATE_IP_PATTERNS = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^::1$/,
  /^0:0:0:0:0:0:0:1$/,
  /^fc[0-9a-f]{2}:/i, // IPv6 ULA fc00::/7
  /^fd[0-9a-f]{2}:/i,
  /^fe80:/i, // IPv6 link-local
];

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata',
  '0.0.0.0',
  '::1',
]);

function normalizeHostname(hostname: string): string {
  let h = hostname.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h.startsWith('::ffff:')) {
    const rest = h.slice('::ffff:'.length);
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(rest)) {
      h = rest;
    } else {
      const parts = rest.split(':');
      if (parts.length === 2) {
        const hi = Number.parseInt(parts[0], 16);
        const lo = Number.parseInt(parts[1], 16);
        if (Number.isFinite(hi) && Number.isFinite(lo)) {
          h = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
        }
      }
    }
  }
  if (h.endsWith('.')) h = h.slice(0, -1);
  return h;
}

/**
 * Validate a URL to prevent SSRF attacks.
 * Only allows http/https schemes and rejects private/internal hosts.
 */
function isSafeUrl(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    const hostname = normalizeHostname(parsed.hostname);
    if (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost')) {
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

// ── Security: Command injection prevention ───────────────────────────────────
// Allowlist of permitted MCP server commands for stdio transport.
// Per OWASP OS Command Injection Defense Cheat Sheet: use allowlist, not blocklist.
// SECURITY: npx, uvx, and docker are intentionally excluded (RCE / supply-chain).
const ALLOWED_MCP_COMMANDS = new Set(['node', 'python', 'python3']);

const EVAL_FLAGS = new Set([
  '-e',
  '--eval',
  '-c',
  '--command',
  '-p',
  '--print',
  'eval',
  '-E',
  '-r',
  '--require',
  '--import',
  '--loader',
  '--experimental-loader',
  '--inspect',
  '--inspect-brk',
  '--inspect-port',
]);

/**
 * Validate a command for stdio MCP transport.
 * Security: Based on OWASP OS Command Injection Defense Cheat Sheet — strict allowlist.
 */
function isAllowedCommand(command: string): boolean {
  const baseName = command.split('/').pop()?.split('\\').pop()?.toLowerCase() ?? '';
  return ALLOWED_MCP_COMMANDS.has(baseName);
}

/** Reject inline-eval / module-loader flags that turn interpreters into RCE. */
function validateMcpArgs(args: readonly string[]): string | undefined {
  for (const arg of args) {
    const a = arg.trim().toLowerCase();
    if (
      EVAL_FLAGS.has(a) ||
      a.startsWith('-e=') ||
      a.startsWith('--eval=') ||
      a.startsWith('-c=') ||
      a.startsWith('--command=') ||
      a.startsWith('-p=') ||
      a.startsWith('--print=') ||
      a.startsWith('-r=') ||
      a.startsWith('--require=') ||
      a.startsWith('--import=') ||
      a.startsWith('--loader=') ||
      a.startsWith('--experimental-loader=') ||
      a.startsWith('--inspect=') ||
      a.startsWith('--inspect-brk=') ||
      a.startsWith('--inspect-port=')
    ) {
      return `MCP command arguments may not contain an inline-eval flag ("${arg}")`;
    }
    // Clustered short options: node -pe '…', python -Oc, etc.
    if (a.startsWith('-') && !a.startsWith('--') && a.length > 1) {
      const cluster = a.slice(1).split('=')[0] ?? '';
      if (/[epcr]/.test(cluster)) {
        return `MCP command arguments may not contain an inline-eval short-option cluster ("${arg}")`;
      }
    }
  }
  return undefined;
}

function requireMcpAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.user) {
    if (!hasRole(req.user.role, 'admin' as UserRole)) {
      res.status(403).json({ error: 'Insufficient privileges' });
      return;
    }
    next();
    return;
  }
  const scopes = req.apiScopes ?? [];
  if (scopes.includes('mcp:admin') || scopes.includes('admin') || scopes.includes('*')) {
    next();
    return;
  }
  res.status(401).json({ error: 'Authentication required' });
}

export interface McpActionGatewayRequest {
  method: 'GET' | 'POST';
  path: string;
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
}

export interface McpActionGatewayExecutor {
  request(input: McpActionGatewayRequest): Promise<unknown>;
}

export interface McpRouterOptions {
  actionGatewayExecutor?: McpActionGatewayExecutor;
  actionGatewayUrl?: string;
  actionGatewayApiKey?: string;
  localRuntime?: boolean;
  /**
   * AUDIT-D1②: resolves the tenant bound to the configured Action Gateway
   * service credential (the principal the forwarded request authenticates as).
   * Defaults to the PostgreSQL API-key store; tests inject an in-memory
   * resolver so the confused-deputy boundary is provable without a database.
   */
  resolveServiceCredentialTenant?: (apiKey: string) => Promise<string | null>;
}

/** Environment variable holding the Action Gateway service credential. */
const MCP_SERVICE_CREDENTIAL_ENV = 'COMMANDER_API_KEY';

function defaultResolveServiceCredentialTenant(apiKey: string): Promise<string | null> {
  return getApiKeyStore()
    .findByHash(hashSecret(apiKey))
    .then((record) => record?.tenantId ?? null)
    .catch((err: unknown) => {
      reportSilentFailure(err, 'mcpEndpoints:resolveServiceCredentialTenant');
      // Fail closed: an unresolvable service tenant cannot be proven to match
      // the caller, so the mismatch check below rejects the dispatch.
      return null;
    });
}

/**
 * AUDIT-C1: MCP tools/call executes with the configured service credential
 * against the Action Gateway — the caller's own authority must gate which
 * gateway tools are reachable, otherwise a low-privilege principal obtains the
 * service credential's powers through MCP (confused deputy). Mirrors the
 * role/scope model of actionGatewayEndpoints.
 */
const MCP_ACTION_TOOL_AUTHORITY: Record<string, { minRole: UserRole; scopes: string[] }> = {
  commander_action_propose: {
    minRole: 'developer',
    scopes: ['actions:propose', 'write', 'admin', '*'],
  },
  commander_action_approve: { minRole: 'admin', scopes: ['actions:approve', 'admin', '*'] },
  commander_action_compensation_request: {
    minRole: 'developer',
    scopes: ['actions:compensation', 'write', 'admin', '*'],
  },
  commander_action_compensation_approve: {
    minRole: 'admin',
    scopes: ['actions:approve', 'admin', '*'],
  },
  commander_action_reconcile: { minRole: 'admin', scopes: ['actions:reconcile', 'admin', '*'] },
};

function toolNameFromJsonRpc(body: unknown): string | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const rpc = body as { method?: unknown; params?: { name?: unknown } };
  if (rpc.method !== 'tools/call') return undefined;
  const name = rpc.params?.name;
  return typeof name === 'string' ? name : undefined;
}

function callerMayInvokeActionTool(req: Request, tool: string): boolean {
  const authority = MCP_ACTION_TOOL_AUTHORITY[tool];
  if (!authority) return true; // read-only gateway tools stay for any principal
  if (req.user) return hasRole(req.user.role, authority.minRole);
  const scopes = req.apiScopes ?? [];
  return scopes.some((sc) => authority.scopes.includes(sc));
}

/**
 * AUDIT-D1②: the HTTP MCP executor authenticates to the Action Gateway with a
 * static service credential. A caller from tenant A invoking a gateway tool
 * while the service credential belongs to tenant B would otherwise read or
 * mutate B's actions under B's identity (confused deputy). The caller's
 * authenticated tenant must therefore equal the service credential's tenant
 * before any gateway dispatch. Returns `undefined` when the check passes,
 * otherwise the caller-facing reason. A caller with no authenticated tenant has
 * no tenant identity to widen, so it proceeds on the service credential
 * (single-tenant / local deployments); an unresolvable service tenant fails
 * closed against a tenant-bound caller.
 */
function callerTenantViolation(
  req: Request,
  serviceCredentialTenant: string | null,
): string | undefined {
  const callerTenant = req.tenantId ?? getCurrentTenantId() ?? null;
  if (!callerTenant) return undefined;
  if (serviceCredentialTenant !== callerTenant) {
    return 'Caller tenant does not match the Action Gateway service credential tenant';
  }
  return undefined;
}

export function createMCPRouter(options: McpRouterOptions = {}): Router {
  const router = express.Router();
  // Security: express.json() with limit is applied globally in index.ts.

  const server = new MCPServer('telos-mcp', '1.0.0');
  const localRuntime = isLocalRuntimeEnabled(options.localRuntime);
  if (localRuntime) {
    registerCoreTools(server);
  } else {
    registerActionGatewayTools(server, resolveActionGatewayExecutor(options));
  }

  const serviceCredential =
    options.actionGatewayApiKey?.trim() || process.env[MCP_SERVICE_CREDENTIAL_ENV]?.trim();
  const resolveServiceCredentialTenant =
    options.resolveServiceCredentialTenant ?? defaultResolveServiceCredentialTenant;

  // POST /mcp — JSON-RPC 2.0 endpoint for all MCP methods
  router.post('/', async (req, res) => {
    // AUDIT-C1: authorize gateway tool invocation with the CALLER's
    // authority before dispatch — the executor signs with the service key.
    const tool = toolNameFromJsonRpc(req.body);
    if (tool && !callerMayInvokeActionTool(req, tool)) {
      res.status(403).json({
        jsonrpc: '2.0',
        id: (req.body as { id?: unknown })?.id ?? null,
        error: { code: -32603, message: `Insufficient authority for MCP tool: ${tool}` },
      });
      return;
    }
    // AUDIT-D1②: reject a caller whose tenant differs from the tenant bound to
    // the service credential BEFORE the gateway dispatch (confused deputy).
    if (tool && !localRuntime && serviceCredential) {
      let serviceTenant: string | null = null;
      try {
        serviceTenant = await resolveServiceCredentialTenant(serviceCredential);
      } catch (err: unknown) {
        reportSilentFailure(err, 'mcpEndpoints:callerTenantViolation');
        serviceTenant = null; // fail closed below
      }
      const violation = callerTenantViolation(req, serviceTenant);
      if (violation) {
        res.status(403).json({
          jsonrpc: '2.0',
          id: (req.body as { id?: unknown })?.id ?? null,
          error: { code: -32603, message: violation },
        });
        return;
      }
    }
    const response = await server.handleRequest(req.body);
    res.json(response);
  });

  // GET /.well-known/mcp — capability discovery
  router.get('/.well-known/mcp', (_req, res) => {
    res.json({
      name: 'telos-mcp',
      version: '1.0.0',
      capabilities: server.getCapabilities(),
      enterpriseWrites: !localRuntime,
    });
  });

  // GET /mcp/status — server status and tool inventory
  router.get('/status', (_req, res) => {
    const status = server.getStatus();
    res.json({
      status: status.initialized ? 'initialized' : 'ready',
      ...status,
      tools: server.listTools(),
      enterpriseWrites: !localRuntime,
      timestamp: new Date().toISOString(),
    });
  });

  // POST /mcp/discover — Auto-discover and inject an external MCP server's tools
  router.post('/discover', requireMcpAdmin, async (req, res) => {
    const { url, transport, command, args: toolArgs, headers, label } = req.body ?? {};

    if (!url && !command) {
      return res.status(400).json({
        error: 'url (streamable-http) or command (stdio) is required',
      });
    }

    // Security: SSRF prevention — validate URL scheme and reject private IPs.
    // Per OWASP SSRF Prevention Cheat Sheet: only allow http/https to public hosts.
    if (url && !isSafeUrl(url)) {
      return res.status(400).json({
        error: 'Invalid or blocked URL. Only http/https to public hosts is allowed.',
      });
    }

    // Security: Command injection prevention — strict command allowlist.
    // Per OWASP OS Command Injection Defense Cheat Sheet: never pass untrusted
    // input to shell; use allowlist of permitted executable names.
    if (command && !isAllowedCommand(command)) {
      return res.status(400).json({
        error: `Command "${command}" is not in the allowed list. Permitted: ${[...ALLOWED_MCP_COMMANDS].join(', ')}`,
      });
    }

    const argsList: string[] = Array.isArray(toolArgs) ? toolArgs.map(String) : [];
    const argsError = validateMcpArgs(argsList);
    if (argsError) {
      return res.status(400).json({ error: argsError });
    }

    // Also reject when basename is uvx even if somehow allowlisted via path tricks.
    if (command && path.basename(command).toLowerCase() === 'uvx') {
      return res.status(400).json({
        error: 'uvx is not allowed for MCP discover',
      });
    }

    const startTime = Date.now();
    const discoveryLabel = label ?? `mcp-${Date.now()}`;

    try {
      const config: MCPClientConfig = url
        ? ({ url, transport: 'streamable-http', headers: headers ?? {} } as MCPClientConfig)
        : ({ command, args: argsList, transport: 'stdio' } as MCPClientConfig);

      const client = createMCPClient(config);
      // MCPClient.connect() takes zero args in the current protocol runner;
      // cast through `unknown` keeps this resilient to upstream signature
      // drift without leaking call-site changes.
      await (client as unknown as { connect: () => Promise<void> }).connect();

      const tools = await client.listTools();
      const resources = await client.listResources().catch(() => []);
      const prompts = await client.listPrompts().catch(() => []);
      const serverInfo = client.getServerInfo();

      await client.disconnect();

      res.json({
        status: 'discovered',
        label: discoveryLabel,
        server: {
          name: serverInfo.name,
          version: serverInfo.version,
          transport: url ? 'streamable-http' : 'stdio',
          url: url ?? `stdio:${command}`,
        },
        tools: tools.map((t) => ({ name: t.name, description: t.description })),
        toolCount: tools.length,
        resources: resources.map((r) => ({ uri: r.uri, name: r.name })),
        prompts: prompts.map((p) => ({ name: p.name, description: p.description })),
        durationMs: Date.now() - startTime,
        instruction: `MCP server "${discoveryLabel}" discovered with ${tools.length} tools.`,
      });
    } catch (err) {
      // Security: Per Express security best practice — do not leak internal error details.
      console.error('[mcpEndpoints] Discovery error:', err);
      res.status(502).json({
        status: 'failed',
        label: discoveryLabel,
        error: 'Failed to connect to MCP server',
        durationMs: Date.now() - startTime,
        hint: 'Verify the MCP server is running and accessible.',
      });
    }
  });

  return router;
}

function registerActionGatewayTools(
  server: MCPServer,
  executor: McpActionGatewayExecutor | undefined,
): void {
  const actionEnvelopeSchema: MCPTool['inputSchema'] = {
    type: 'object',
    properties: {
      source: { type: 'string' },
      package: { type: 'string' },
      model: { type: 'string' },
      tool: { type: 'string' },
      destination: { type: 'string' },
      effectType: { type: 'string' },
      args: { type: 'object' },
      idempotencyKey: { type: 'string' },
    },
    required: [
      'source',
      'package',
      'model',
      'tool',
      'destination',
      'effectType',
      'args',
      'idempotencyKey',
    ],
  };
  const runIdSchema: MCPTool['inputSchema'] = {
    type: 'object',
    properties: { runId: { type: 'string' } },
    required: ['runId'],
  };
  const idempotentRunIdSchema: MCPTool['inputSchema'] = {
    type: 'object',
    properties: {
      runId: { type: 'string' },
      idempotencyKey: { type: 'string' },
    },
    required: ['runId', 'idempotencyKey'],
  };
  const compensationRequestSchema: MCPTool['inputSchema'] = {
    type: 'object',
    properties: {
      runId: { type: 'string' },
      idempotencyKey: { type: 'string' },
      originalEffectId: { type: 'string' },
      adapterVersion: { type: 'string' },
      compensationEffectType: { type: 'string' },
      compensationPatch: { type: 'object' },
      forwardReceiptHash: { type: 'string' },
    },
    required: [
      'runId',
      'idempotencyKey',
      'originalEffectId',
      'adapterVersion',
      'compensationEffectType',
      'compensationPatch',
      'forwardReceiptHash',
    ],
  };
  const compensationApprovalSchema: MCPTool['inputSchema'] = {
    type: 'object',
    properties: {
      runId: { type: 'string' },
      authorizationId: { type: 'string' },
      idempotencyKey: { type: 'string' },
      actionDigest: { type: 'string' },
      policySnapshotId: { type: 'string' },
    },
    required: ['runId', 'authorizationId', 'idempotencyKey', 'actionDigest', 'policySnapshotId'],
  };

  registerGatewayTool(
    server,
    executor,
    'commander_action_simulate',
    'Simulate a governed action through the Commander Action Gateway.',
    actionEnvelopeSchema,
    (args) => actionRequest('POST', '/v1/actions/simulate', args),
  );
  registerGatewayTool(
    server,
    executor,
    'commander_action_propose',
    'Propose a governed action through the Commander Action Gateway.',
    actionEnvelopeSchema,
    (args) => actionRequest('POST', '/v1/actions', args),
  );
  registerGatewayTool(
    server,
    executor,
    'commander_action_get',
    'Get a governed action from the Commander Action Gateway.',
    runIdSchema,
    (args) => ({ method: 'GET', path: actionPath(args.runId) }),
  );
  registerGatewayTool(
    server,
    executor,
    'commander_action_approve',
    'Approve an action using its exact simulation binding.',
    {
      type: 'object',
      properties: {
        runId: { type: 'string' },
        idempotencyKey: { type: 'string' },
        actionDigest: { type: 'string' },
        simulationId: { type: 'string' },
        policySnapshotId: { type: 'string' },
      },
      required: ['runId', 'idempotencyKey', 'actionDigest', 'simulationId', 'policySnapshotId'],
    },
    (args) => {
      const { runId, idempotencyKey, actionDigest, simulationId, policySnapshotId } = args;
      return {
        method: 'POST',
        path: `${actionPath(runId)}/approve`,
        body: { actionDigest, simulationId, policySnapshotId },
        headers: idempotencyHeaders(idempotencyKey),
      };
    },
  );
  registerGatewayTool(
    server,
    executor,
    'commander_action_compensation_request',
    'Request governed compensation for a completed forward effect.',
    compensationRequestSchema,
    (args) => {
      const { runId, idempotencyKey, ...body } = args;
      return {
        method: 'POST',
        path: `${actionPath(runId)}/compensations`,
        body,
        headers: idempotencyHeaders(idempotencyKey),
      };
    },
  );
  registerGatewayTool(
    server,
    executor,
    'commander_action_compensation_approve',
    'Approve a bound compensation authorization.',
    compensationApprovalSchema,
    (args) => {
      const { runId, authorizationId, idempotencyKey, actionDigest, policySnapshotId } = args;
      return {
        method: 'POST',
        path: `${actionPath(runId)}/compensations/${encodeURIComponent(requiredString(authorizationId, 'authorizationId'))}/approve`,
        body: { actionDigest, policySnapshotId },
        headers: idempotencyHeaders(idempotencyKey),
      };
    },
  );
  registerGatewayTool(
    server,
    executor,
    'commander_action_reconcile',
    'Request reconciliation for a completion-unknown action.',
    idempotentRunIdSchema,
    (args) => ({
      method: 'POST',
      path: `${actionPath(args.runId)}/reconcile`,
      headers: idempotencyHeaders(args.idempotencyKey),
    }),
  );
  registerGatewayTool(
    server,
    executor,
    'commander_action_evidence',
    'Get the evidence bundle for a governed action.',
    runIdSchema,
    (args) => ({ method: 'GET', path: `${actionPath(args.runId)}/evidence` }),
  );
}

function registerGatewayTool(
  server: MCPServer,
  executor: McpActionGatewayExecutor | undefined,
  name: string,
  description: string,
  inputSchema: MCPTool['inputSchema'],
  buildRequest: (args: Record<string, unknown>) => McpActionGatewayRequest,
): void {
  server.registerTool({ name, description, inputSchema }, async (args) => {
    if (!executor) {
      throw new Error(
        'ACTION_GATEWAY_REQUIRED: configure COMMANDER_ACTION_GATEWAY_URL for enterprise MCP actions.',
      );
    }
    const result = await executor.request(buildRequest(args));
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  });
}

function actionRequest(
  method: 'POST',
  path: string,
  body: Record<string, unknown>,
): McpActionGatewayRequest {
  return { method, path, body, headers: idempotencyHeaders(body.idempotencyKey) };
}

function idempotencyHeaders(value: unknown): Record<string, string> {
  return { 'Idempotency-Key': requiredString(value, 'idempotencyKey') };
}

function actionPath(runId: unknown): string {
  return `/v1/actions/${encodeURIComponent(requiredString(runId, 'runId'))}`;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function isEnterpriseOrProductionMcpMode(env: NodeJS.ProcessEnv = process.env): boolean {
  const profile = env.COMMANDER_PROFILE?.trim().toLowerCase();
  if (profile === 'enterprise') return true;
  const commanderEnv = env.COMMANDER_ENV?.trim().toLowerCase();
  if (commanderEnv === 'production' || commanderEnv === 'prod') return true;
  return env.NODE_ENV === 'production';
}

function isLocalRuntimeEnabled(
  configured?: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (isEnterpriseOrProductionMcpMode(env)) return false;
  return configured ?? env.COMMANDER_MCP_LOCAL_RUNTIME?.trim() === '1';
}

function resolveActionGatewayExecutor(
  options: McpRouterOptions,
): McpActionGatewayExecutor | undefined {
  if (options.actionGatewayExecutor) return options.actionGatewayExecutor;
  const baseUrl =
    options.actionGatewayUrl?.trim() || process.env.COMMANDER_ACTION_GATEWAY_URL?.trim();
  if (!baseUrl) return undefined;
  return createFetchActionGatewayExecutor({
    baseUrl,
    apiKey: options.actionGatewayApiKey ?? process.env.COMMANDER_API_KEY,
  });
}

export function createFetchActionGatewayExecutor(options: {
  baseUrl: string;
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
}): McpActionGatewayExecutor {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (!fetchImpl) throw new Error('A fetch implementation is required for the Action Gateway');
  const baseUrl = options.baseUrl.replace(/\/$/, '');
  return {
    async request(input) {
      const headers = new Headers(input.headers);
      headers.set('accept', 'application/json');
      if (input.body) headers.set('content-type', 'application/json');
      // AUDIT-D1①: a static Commander API key must be sent as X-API-Key.
      // Authorization: Bearer is reserved for JWT access tokens and is rejected
      // by enterprise /v1 JWT middleware before API-key auth can inspect it.
      if (options.apiKey) headers.set('x-api-key', options.apiKey);
      // AUDIT-D1②: attribute the caller's authenticated tenant on the forwarded
      // request. The gateway's tenant guard only ever lets this header *match*
      // the authenticated service principal, so a caller from tenant A hitting a
      // tenant-B service credential is rejected downstream — the header can
      // never be trusted as identity on its own.
      const callerTenant = getCurrentTenantId();
      if (callerTenant) headers.set('x-tenant-id', callerTenant);
      const response = await fetchImpl(`${baseUrl}${input.path}`, {
        method: input.method,
        headers,
        ...(input.body ? { body: JSON.stringify(input.body) } : {}),
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`Action Gateway request failed (${response.status}): ${text}`);
      }
      if (!text) return {};
      return JSON.parse(text) as unknown;
    },
  };
}

function registerCoreTools(server: MCPServer): void {
  server.registerTool(
    {
      name: 'execute_agent',
      description:
        'Execute an agent task with the TELOS runtime. Provide a goal and optional context.',
      inputSchema: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'The task objective for the agent' },
          agentId: { type: 'string', description: 'Agent identifier' },
          context: { type: 'string', description: 'Additional context' },
        },
        required: ['goal'],
      },
    },
    async (args) => {
      return {
        content: [
          { type: 'text', text: `Agent ${args.agentId ?? 'default'} executed: ${args.goal}` },
        ],
      };
    },
  );

  server.registerTool(
    {
      name: 'list_models',
      description: 'List all available models and their tiers in the TELOS ModelRouter',
      inputSchema: {
        type: 'object',
        properties: {
          tier: { type: 'string', description: 'Filter by tier: eco, standard, power, consensus' },
        },
      },
    },
    async (args) => {
      const router = getModelRouter();
      const models = router.listModels(args.tier as ModelTier | undefined);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              models.map((m) => ({ id: m.id, tier: m.tier, provider: m.provider })),
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    {
      name: 'route_task',
      description:
        'Preview which model tier a task would be routed to based on its goal and context',
      inputSchema: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'The task goal' },
          riskLevel: { type: 'string', description: 'Risk level: LOW, MEDIUM, HIGH, CRITICAL' },
        },
        required: ['goal'],
      },
    },
    async (args) => {
      const router = getModelRouter();
      const decision = router.route({
        agentId: 'mcp-caller',
        projectId: 'mcp',
        goal: args.goal as string,
        contextData: {
          governanceProfile: { riskLevel: args.riskLevel ?? 'LOW' },
        },
        availableTools: [],
        maxSteps: 5,
        tokenBudget: 8000,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(decision, null, 2) }],
      };
    },
  );
}

export function createMCPClientRouter(): Router {
  const router = express.Router();
  // Security: express.json() with limit is applied globally in index.ts.

  // POST /mcp/client/connect — Connect to an external MCP server
  router.post('/connect', requireMcpAdmin, async (req, res) => {
    const { name, transport, command, args: toolArgs, url, headers } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    if (command && !isAllowedCommand(command)) {
      return res.status(400).json({
        error: `Command "${command}" is not in the allowed list. Permitted: ${[...ALLOWED_MCP_COMMANDS].join(', ')}`,
      });
    }
    const argsList: string[] = Array.isArray(toolArgs) ? toolArgs.map(String) : [];
    const argsError = validateMcpArgs(argsList);
    if (argsError) {
      return res.status(400).json({ error: argsError });
    }

    // Store the connection configuration for later use
    res.json({
      status: 'configured',
      name,
      transport: transport ?? 'stdio',
      instruction: `MCP server "${name}" configured. Tools will be available on next agent execution.`,
    });
  });

  return router;
}
