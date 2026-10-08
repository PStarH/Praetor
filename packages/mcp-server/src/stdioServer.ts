import {
  MCPServer,
  getModelRouter,
  createAllTools,
  MCP_ERROR_CODES,
  MCP_PROTOCOL_VERSION,
  createFetchActionGatewayExecutor,
  type ModelTier,
  type MCPTool,
  type MCPResource,
  type MCPPrompt,
  type MCPServerCapabilities,
  type ActionGatewayExecutor,
  type JSONRPCRequest,
} from '@praetor/core';

export interface McpActionGatewayRequest {
  method: 'GET' | 'POST';
  path: string;
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
}

export interface McpActionGatewayExecutor {
  request(input: McpActionGatewayRequest): Promise<unknown>;
}

export interface StdioMcpServerOptions {
  /** Server name advertised during MCP initialization. */
  name?: string;
  /** Server version advertised during MCP initialization. */
  version?: string;
  /** If true, only register the lightweight model-router tools (default: false). */
  modelRouterOnly?: boolean;
  /** If true, expose dangerous built-in tools such as shell_execute (default: false). */
  allowDangerousTools?: boolean;
  /** Enable the non-enterprise local runtime surface (defaults to COMMANDER_MCP_LOCAL_RUNTIME=1). */
  localRuntime?: boolean;
  /** Override Action Gateway base URL (defaults to COMMANDER_ACTION_GATEWAY_URL). */
  actionGatewayUrl?: string;
  /** Override Action Gateway API key (defaults to COMMANDER_API_KEY). */
  actionGatewayApiKey?: string;
  /** Override Action Gateway tenant header (defaults to COMMANDER_TENANT_ID). */
  actionGatewayTenantId?: string;
  /** Inject a custom Action Gateway executor (used by tests). */
  actionGatewayExecutor?: ActionGatewayExecutor | McpActionGatewayExecutor;
}

export interface StdioMcpServerStatus {
  initialized: boolean;
  name: string;
  version: string;
  protocolVersion: string;
  capabilities: MCPServerCapabilities;
  tools: MCPTool[];
  resources: MCPResource[];
  prompts: MCPPrompt[];
  uptimeSeconds: number;
  enterpriseWrites: boolean;
}

/**
 * Create an MCP server wired to Commander services.
 *
 * The default surface contains only canonical Action Gateway tools. Local
 * model-router and built-in Commander tools require the explicit local-runtime
 * development gate and never advertise enterprise write capability.
 */
export function createStdioMcpServer(options: StdioMcpServerOptions = {}): {
  server: MCPServer;
  status: StdioMcpServerStatus;
} {
  const name = options.name ?? 'commander-mcp-server';
  const version = options.version ?? '0.2.0';
  const startTime = Date.now();

  const server = new MCPServer(name, version);

  const localRuntime = isLocalRuntimeEnabled(options.localRuntime);
  if (localRuntime) {
    registerModelRouterTools(server);
    if (!options.modelRouterOnly) {
      registerCommanderTools(server, options);
    }
  } else {
    registerActionGatewayTools(server, resolveMcpActionGatewayExecutor(options));
  }

  // `version` mirrors packages/mcp-server/package.json. Update both together
  // when bumping. `MCP_PROTOCOL_VERSION` is shared with the core client/server
  // so the stdio transport stays in lockstep with the in-process implementation.
  const status: StdioMcpServerStatus = {
    initialized: false,
    name,
    version,
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: server.getCapabilities(),
    tools: server.listTools(),
    resources: [],
    prompts: [],
    uptimeSeconds: 0,
    enterpriseWrites: !localRuntime,
  };

  return {
    server,
    get status() {
      status.initialized = true;
      status.capabilities = server.getCapabilities();
      status.tools = server.listTools();
      status.resources = [];
      status.prompts = [];
      status.uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
      return status;
    },
  };
}

/**
 * Start reading line-delimited JSON-RPC messages from stdin and writing
 * responses to stdout.
 */
export function startStdioServer(options: StdioMcpServerOptions = {}): {
  server: MCPServer;
  status: StdioMcpServerStatus;
  stop: () => void;
} {
  const { server, status } = createStdioMcpServer(options);
  let buffer = '';
  let running = true;

  const onData = (chunk: Buffer) => {
    if (!running) return;
    buffer += chunk.toString('utf-8');
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // handleLine reports its own failures, but attach a handler so a
      // transport-level throw can never surface as an unhandled rejection.
      void handleLine(server, trimmed).catch((err: unknown) => {
        process.stderr.write(
          `[commander-mcp-server] request failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      });
    }
  };

  const onError = (err: Error) => {
    process.stderr.write(`[commander-mcp-server] stdin error: ${err.message}\n`);
  };

  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', onData);
  process.stdin.on('error', onError);

  const stop = () => {
    running = false;
    process.stdin.off('data', onData);
    process.stdin.off('error', onError);
  };

  return { server, status, stop };
}

export async function handleLine(server: MCPServer, line: string): Promise<void> {
  let request: unknown;
  try {
    request = JSON.parse(line);
  } catch (err) {
    writeResponse({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: MCP_ERROR_CODES.PARSE_ERROR,
        message: `Parse error: ${err instanceof Error ? err.message : String(err)}`,
      },
    });
    return;
  }

  // A parsed JSON value that is not an object (e.g. `null` or a bare array)
  // must never reach dispatch/handleRequest: it has no usable `id`.
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    writeResponse({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: MCP_ERROR_CODES.INVALID_REQUEST,
        message: 'Invalid Request: expected a JSON-RPC object',
      },
    });
    return;
  }

  const message = request as Record<string, unknown>;
  if (
    message.jsonrpc === '2.0' &&
    typeof message.method === 'string' &&
    !Object.prototype.hasOwnProperty.call(message, 'id')
  ) {
    return; // notification — no response
  }

  if (typeof message.id !== 'string' && typeof message.id !== 'number') {
    writeResponse({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: MCP_ERROR_CODES.INVALID_REQUEST,
        message: 'Invalid Request: "id" must be a string or number',
      },
    });
    return;
  }

  try {
    const response = await server.handleRequest(request as JSONRPCRequest);
    writeResponse(response);
  } catch (err) {
    writeResponse({
      jsonrpc: '2.0',
      id: message.id,
      error: {
        code: MCP_ERROR_CODES.INTERNAL_ERROR,
        message: `Request failed: ${err instanceof Error ? err.message : String(err)}`,
      },
    });
  }
}

function writeResponse(response: unknown): void {
  process.stdout.write(JSON.stringify(response) + '\n');
}

function registerModelRouterTools(server: MCPServer): void {
  server.registerTool(
    {
      name: 'execute_agent',
      description:
        'Execute an agent task with the Commander runtime. Provide a goal and optional context.',
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
    async (args) => ({
      content: [
        { type: 'text', text: `Agent ${args.agentId ?? 'default'} executed: ${args.goal}` },
      ],
    }),
  );

  server.registerTool(
    {
      name: 'list_models',
      description: 'List all available models and their tiers in the Commander ModelRouter',
      inputSchema: {
        type: 'object',
        properties: {
          tier: {
            type: 'string',
            description: 'Filter by tier: eco, standard, power, consensus',
          },
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

function registerCommanderTools(server: MCPServer, options: StdioMcpServerOptions): void {
  try {
    const tools = createAllTools();
    const executor = isCoreActionGatewayExecutor(options.actionGatewayExecutor)
      ? options.actionGatewayExecutor
      : resolveCoreActionGatewayExecutor(options);
    server.registerCommanderTools(tools, undefined, {
      allowDangerousTools: options.allowDangerousTools === true,
      actionGatewayExecutor: executor,
    });
  } catch (err) {
    process.stderr.write(
      `[commander-mcp-server] Failed to register Commander tools: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
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
      const { runId, actionDigest, simulationId, policySnapshotId } = args;
      return {
        method: 'POST',
        path: `${actionPath(runId)}/approve`,
        body: { actionDigest, simulationId, policySnapshotId },
        headers: idempotencyHeaders(args.idempotencyKey),
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

function idempotencyHeaders(idempotencyKey: unknown): Record<string, string> {
  return { 'Idempotency-Key': requiredString(idempotencyKey, 'idempotencyKey') };
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

export function isEnterpriseOrProductionMcpMode(env: NodeJS.ProcessEnv = process.env): boolean {
  const profile = env.COMMANDER_PROFILE?.trim().toLowerCase();
  if (profile === 'enterprise') return true;
  const commanderEnv = env.COMMANDER_ENV?.trim().toLowerCase();
  if (commanderEnv === 'production' || commanderEnv === 'prod') return true;
  return env.NODE_ENV === 'production';
}

export function isLocalRuntimeEnabled(
  configured?: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (isEnterpriseOrProductionMcpMode(env)) return false;
  return configured ?? env.COMMANDER_MCP_LOCAL_RUNTIME?.trim() === '1';
}

export function assertActionGatewayConfigured(
  env: NodeJS.ProcessEnv = process.env,
  options: { allowDangerousTools?: boolean } = {},
): void {
  const requireGateway =
    isEnterpriseOrProductionMcpMode(env) || options.allowDangerousTools === true;
  if (!requireGateway) return;
  if (!env.COMMANDER_ACTION_GATEWAY_URL?.trim()) {
    throw new Error(
      options.allowDangerousTools === true && !isEnterpriseOrProductionMcpMode(env)
        ? 'COMMANDER_ACTION_GATEWAY_URL is required when --allow-dangerous-tools is set.'
        : 'COMMANDER_ACTION_GATEWAY_URL is required in enterprise/production MCP mode.',
    );
  }
}

function resolveCoreActionGatewayExecutor(
  options: StdioMcpServerOptions,
): ActionGatewayExecutor | undefined {
  const actionGatewayUrl =
    options.actionGatewayUrl?.trim() || process.env.COMMANDER_ACTION_GATEWAY_URL?.trim();
  if (!actionGatewayUrl) return undefined;
  return createFetchActionGatewayExecutor({
    baseUrl: actionGatewayUrl,
    apiKey: options.actionGatewayApiKey ?? process.env.COMMANDER_API_KEY,
  });
}

function resolveMcpActionGatewayExecutor(
  options: StdioMcpServerOptions,
): McpActionGatewayExecutor | undefined {
  if (isMcpActionGatewayExecutor(options.actionGatewayExecutor)) {
    return options.actionGatewayExecutor;
  }
  const baseUrl =
    options.actionGatewayUrl?.trim() || process.env.COMMANDER_ACTION_GATEWAY_URL?.trim();
  if (!baseUrl) return undefined;
  return createFetchMcpActionGatewayExecutor({
    baseUrl,
    apiKey: options.actionGatewayApiKey ?? process.env.COMMANDER_API_KEY,
    tenantId: options.actionGatewayTenantId ?? process.env.COMMANDER_TENANT_ID,
  });
}

function isMcpActionGatewayExecutor(
  executor: StdioMcpServerOptions['actionGatewayExecutor'],
): executor is McpActionGatewayExecutor {
  return typeof (executor as McpActionGatewayExecutor | undefined)?.request === 'function';
}

function isCoreActionGatewayExecutor(
  executor: StdioMcpServerOptions['actionGatewayExecutor'],
): executor is ActionGatewayExecutor {
  return typeof (executor as ActionGatewayExecutor | undefined)?.proposeAction === 'function';
}

export function createFetchMcpActionGatewayExecutor(options: {
  baseUrl: string;
  apiKey?: string;
  tenantId?: string;
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
      // Static Commander API keys use X-API-Key. Authorization: Bearer is
      // reserved for JWT access tokens and is rejected by enterprise /v1 JWT
      // middleware before the API-key middleware can inspect it.
      if (options.apiKey) headers.set('x-api-key', options.apiKey);
      if (options.tenantId) headers.set('x-tenant-id', options.tenantId);
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
