import { beforeEach, describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  MCPServer,
  createFetchActionGatewayExecutor,
  resetGuardianAgent,
  type Tool,
} from '@praetor/core';
import {
  assertActionGatewayConfigured,
  createStdioMcpServer,
  handleLine,
  isEnterpriseOrProductionMcpMode,
  isLocalRuntimeEnabled,
  startStdioServer,
  type McpActionGatewayExecutor,
} from '../src/stdioServer';
import { isDirectCliInvocation, run } from '../src/cli';
import { MCP_PROTOCOL_VERSION } from '@praetor/core';

beforeEach(() => {
  resetGuardianAgent();
});

describe('createStdioMcpServer', () => {
  const canonicalActionTools = [
    'commander_action_approve',
    'commander_action_compensation_approve',
    'commander_action_compensation_request',
    'commander_action_evidence',
    'commander_action_get',
    'commander_action_propose',
    'commander_action_reconcile',
    'commander_action_simulate',
  ];

  it('advertises only canonical Action Gateway tools by default', () => {
    const { server, status } = createStdioMcpServer();

    expect(
      server
        .listTools()
        .map((tool) => tool.name)
        .sort(),
    ).toEqual(canonicalActionTools);
    expect(status.enterpriseWrites).toBe(true);
  });

  it('maps every canonical action tool to the Action Gateway', async () => {
    const calls: Parameters<McpActionGatewayExecutor['request']>[0][] = [];
    const executor: McpActionGatewayExecutor = {
      request: async (request) => {
        calls.push(request);
        return { action: { runId: 'run-42', state: 'PROPOSED' } };
      },
    };
    const { server } = createStdioMcpServer({ actionGatewayExecutor: executor });
    const envelope = {
      source: 'mcp',
      package: 'commander.mcp',
      model: 'mcp-default',
      tool: 'ticket.create',
      destination: 'demo://tickets',
      effectType: 'demo.ticket.create',
      args: { title: 'hello' },
      idempotencyKey: 'mcp-action-0001',
    };
    const approval = {
      runId: 'run/42',
      idempotencyKey: 'mcp-approve-0001',
      actionDigest: 'a'.repeat(64),
      simulationId: 'simulation-42',
      policySnapshotId: 'policy-42',
    };
    const compensation = {
      runId: 'run/42',
      idempotencyKey: 'mcp-compensation-0001',
      originalEffectId: 'effect-42',
      adapterVersion: 'demo.adapter.v1',
      compensationEffectType: 'compensate.demo.ticket.create',
      compensationPatch: { ticketId: 'ticket-42' },
      forwardReceiptHash: 'b'.repeat(64),
    };
    const compensationApproval = {
      runId: 'run/42',
      authorizationId: 'authorization-42',
      idempotencyKey: 'mcp-compensation-approve-0001',
      actionDigest: 'c'.repeat(64),
      policySnapshotId: 'policy-42',
    };
    const cases = [
      ['commander_action_simulate', envelope],
      ['commander_action_propose', envelope],
      ['commander_action_get', { runId: 'run/42' }],
      ['commander_action_approve', approval],
      ['commander_action_compensation_request', compensation],
      ['commander_action_compensation_approve', compensationApproval],
      ['commander_action_reconcile', { runId: 'run/42', idempotencyKey: 'mcp-reconcile-0001' }],
      ['commander_action_evidence', { runId: 'run/42' }],
    ] as const;

    for (const [name, args] of cases) {
      resetGuardianAgent();
      const response = await server.handleRequest({
        jsonrpc: '2.0',
        id: name,
        method: 'tools/call',
        params: { name, arguments: args },
      });
      expect(response.error).toBeUndefined();
    }

    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/v1/actions/simulate',
        body: envelope,
        headers: { 'Idempotency-Key': 'mcp-action-0001' },
      },
      {
        method: 'POST',
        path: '/v1/actions',
        body: envelope,
        headers: { 'Idempotency-Key': 'mcp-action-0001' },
      },
      { method: 'GET', path: '/v1/actions/run%2F42' },
      {
        method: 'POST',
        path: '/v1/actions/run%2F42/approve',
        body: {
          actionDigest: 'a'.repeat(64),
          simulationId: 'simulation-42',
          policySnapshotId: 'policy-42',
        },
        headers: { 'Idempotency-Key': 'mcp-approve-0001' },
      },
      {
        method: 'POST',
        path: '/v1/actions/run%2F42/compensations',
        body: {
          originalEffectId: 'effect-42',
          adapterVersion: 'demo.adapter.v1',
          compensationEffectType: 'compensate.demo.ticket.create',
          compensationPatch: { ticketId: 'ticket-42' },
          forwardReceiptHash: 'b'.repeat(64),
        },
        headers: { 'Idempotency-Key': 'mcp-compensation-0001' },
      },
      {
        method: 'POST',
        path: '/v1/actions/run%2F42/compensations/authorization-42/approve',
        body: { actionDigest: 'c'.repeat(64), policySnapshotId: 'policy-42' },
        headers: { 'Idempotency-Key': 'mcp-compensation-approve-0001' },
      },
      {
        method: 'POST',
        path: '/v1/actions/run%2F42/reconcile',
        headers: { 'Idempotency-Key': 'mcp-reconcile-0001' },
      },
      { method: 'GET', path: '/v1/actions/run%2F42/evidence' },
    ]);
  });

  it('requires the explicit local-runtime gate for all legacy tools', () => {
    const gatewayOnly = createStdioMcpServer({ allowDangerousTools: true });
    expect(
      gatewayOnly.server
        .listTools()
        .map((tool) => tool.name)
        .sort(),
    ).toEqual(canonicalActionTools);

    const localOnly = createStdioMcpServer({ localRuntime: true });
    const localNames = localOnly.server.listTools().map((tool) => tool.name);
    expect(localNames).toContain('execute_agent');
    expect(localNames).toContain('list_models');
    expect(localNames).not.toContain('commander_action_propose');
    expect(localOnly.status.enterpriseWrites).toBe(false);
  });

  it('advertises Commander tools and model-router tools by default', () => {
    const { server, status } = createStdioMcpServer({ localRuntime: true });
    const tools = server.listTools();
    expect(tools.length).toBeGreaterThan(0);
    expect(status.tools.length).toBe(tools.length);
    expect(tools.some((t) => t.name === 'execute_agent')).toBe(true);
    expect(tools.some((t) => t.name === 'list_models')).toBe(true);
    expect(tools.some((t) => t.name === 'route_task')).toBe(true);
  });

  it('modelRouterOnly mode only registers the three model-router tools', () => {
    const { server } = createStdioMcpServer({ modelRouterOnly: true, localRuntime: true });
    const tools = server.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['execute_agent', 'list_models', 'route_task']);
  });

  it('initialize returns the shared MCP protocol version', async () => {
    const { server } = createStdioMcpServer({ modelRouterOnly: true, localRuntime: true });
    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'test-client', version: '0.0.1' },
      },
    });
    expect(response.error).toBeUndefined();
    expect(response.result).toMatchObject({
      protocolVersion: MCP_PROTOCOL_VERSION,
      serverInfo: { name: 'commander-mcp-server', version: '0.2.0' },
      capabilities: { tools: {} },
    });
  });

  it('tools/list returns the registered tools', async () => {
    const { server } = createStdioMcpServer({ modelRouterOnly: true, localRuntime: true });
    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });
    expect(response.error).toBeUndefined();
    const result = response.result as { tools: Array<{ name: string }> };
    expect(result.tools.map((t) => t.name).sort()).toEqual([
      'execute_agent',
      'list_models',
      'route_task',
    ]);
  });

  it('tools/call invokes execute_agent', async () => {
    const { server } = createStdioMcpServer({ modelRouterOnly: true, localRuntime: true });
    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'execute_agent',
        arguments: { goal: 'test goal', agentId: 'test-agent' },
      },
    });
    expect(response.error).toBeUndefined();
    const result = response.result as { content: Array<{ type: string; text: string }> };
    expect(result.content[0].text).toContain('test-agent');
    expect(result.content[0].text).toContain('test goal');
  });

  it('status reflects server metadata', () => {
    const { status } = createStdioMcpServer({
      name: 'custom-mcp',
      version: '1.2.3',
      localRuntime: true,
    });
    expect(status.name).toBe('custom-mcp');
    expect(status.version).toBe('1.2.3');
    expect(status.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(status.capabilities.tools).toEqual({});
    expect(status.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('routes external commander tools through the action gateway without local execution', async () => {
    const localExecutions: string[] = [];
    const gatewayCalls: Array<Record<string, unknown>> = [];
    const writeTool: Tool = {
      definition: {
        name: 'demo_external_write',
        description: 'External write tool',
        inputSchema: { type: 'object', properties: { payload: { type: 'string' } } },
      },
      isReadOnly: false,
      execute: async () => {
        localExecutions.push('called');
        return 'local-result';
      },
    };
    const server = new MCPServer('gateway-test', '1.0.0');
    server.registerCommanderTools(new Map([['demo_external_write', writeTool]]), undefined, {
      actionGatewayExecutor: {
        proposeAction: async (input) => {
          gatewayCalls.push(input);
          return {
            action: { runId: 'run-gateway-1', state: 'PENDING' },
            idempotentReplay: false,
          };
        },
      },
    });

    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 99,
      method: 'tools/call',
      params: { name: 'demo_external_write', arguments: { payload: 'hello' } },
    });

    expect(response.error).toBeUndefined();
    expect(gatewayCalls).toHaveLength(1);
    expect(gatewayCalls[0]).toMatchObject({
      source: 'mcp',
      tool: 'demo_external_write',
      args: { payload: 'hello' },
    });
    expect(localExecutions).toHaveLength(0);
  });

  it('keeps list_models local when an action gateway executor is configured', async () => {
    const { server } = createStdioMcpServer({
      modelRouterOnly: true,
      localRuntime: true,
      actionGatewayExecutor: {
        proposeAction: async () => {
          throw new Error('action gateway should not be called for list_models');
        },
      },
    });
    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 100,
      method: 'tools/call',
      params: { name: 'list_models', arguments: {} },
    });
    expect(response.error).toBeUndefined();
    const result = response.result as { content: Array<{ text: string }> };
    expect(result.content[0].text).toContain('[');
  });

  it('createFetchActionGatewayExecutor posts to /v1/actions', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const executor = createFetchActionGatewayExecutor({
      baseUrl: 'https://gateway.example',
      apiKey: 'test-key',
      fetch: async (url, init) => {
        capturedUrl = String(url);
        capturedInit = init;
        return new Response(
          JSON.stringify({
            action: { runId: 'run-1', state: 'PENDING' },
            idempotentReplay: false,
          }),
          { status: 202, headers: { 'content-type': 'application/json' } },
        );
      },
    });
    const result = await executor.proposeAction({
      source: 'mcp',
      package: 'commander.mcp',
      model: 'mcp-default',
      tool: 'demo_external_write',
      destination: 'mcp://commander/demo_external_write',
      effectType: 'mcp.tool.demo_external_write',
      args: { payload: 'x' },
      idempotencyKey: 'mcp-12345678',
    });
    expect(capturedUrl).toBe('https://gateway.example/v1/actions');
    expect(new Headers(capturedInit?.headers).get('idempotency-key')).toBe('mcp-12345678');
    expect(result.action.runId).toBe('run-1');
  });
});

describe('startStdioServer', () => {
  it('returns a stop function', () => {
    const { stop, server } = startStdioServer({ modelRouterOnly: true, localRuntime: true });
    expect(typeof stop).toBe('function');
    expect(server.listTools().length).toBe(3);
    stop();
  });

  it('completes the stdio handshake without responding to notifications', async () => {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('../dist/cli.js', import.meta.url)), '--model-router-only'],
      {
        env: {
          ...process.env,
          NODE_ENV: 'test',
          COMMANDER_PROFILE: '',
          COMMANDER_MCP_LOCAL_RUNTIME: '1',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    try {
      child.stdin.write(
        [
          {
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: MCP_PROTOCOL_VERSION,
              capabilities: {},
              clientInfo: { name: 'subprocess-test', version: '1.0.0' },
            },
          },
          { jsonrpc: '2.0', method: 'notifications/initialized' },
          {
            jsonrpc: '2.0',
            method: 'notifications/progress',
            params: { progressToken: 'test', progress: 1 },
          },
          { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        ]
          .map((message) => JSON.stringify(message))
          .join('\n') + '\n',
      );

      await Promise.race([
        new Promise<void>((resolve) => {
          const poll = () => {
            if (stdout.includes('"id":2')) resolve();
            else setTimeout(poll, 10);
          };
          poll();
        }),
        delay(5_000).then(() => {
          throw new Error(`Timed out waiting for MCP handshake response. stderr: ${stderr}`);
        }),
      ]);
      await delay(100);

      const responses = stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { id?: string | number });
      expect(responses).toHaveLength(2);
      expect(responses.map((response) => response.id).sort()).toEqual([1, 2]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await once(child, 'exit');
      }
    }
  });
});

describe('cli', () => {
  it('detects direct ESM entrypoint invocation without require.main', () => {
    const moduleUrl = pathToFileURL('/workspace/packages/mcp-server/dist/cli.js').href;
    expect(isDirectCliInvocation(moduleUrl, '/workspace/packages/mcp-server/dist/cli.js')).toBe(
      true,
    );
    expect(isDirectCliInvocation(moduleUrl, '/workspace/packages/mcp-server/dist/index.js')).toBe(
      false,
    );
    expect(isDirectCliInvocation(moduleUrl, undefined)).toBe(false);
  });

  it('prints help and exits', () => {
    let output = '';
    let exited = false;
    const originalWrite = process.stdout.write.bind(process.stdout);
    const originalExit = process.exit.bind(process.exit);

    process.stdout.write = ((chunk: string | Uint8Array, cb?: (err?: Error) => void) => {
      output += String(chunk);
      if (cb) cb();
      return true;
    }) as typeof process.stdout.write;

    process.exit = ((code?: number | string | null | undefined) => {
      exited = true;
      throw new Error(`exit:${code ?? 0}`);
    }) as typeof process.exit;

    try {
      run(['node', 'cli.js', '--help']);
    } catch (err) {
      // expected
    } finally {
      process.stdout.write = originalWrite;
      process.exit = originalExit;
    }

    expect(exited).toBe(true);
    expect(output).toContain('commander-mcp-server');
    expect(output).toContain('--model-router-only');
  });

  it('refuses enterprise startup without COMMANDER_ACTION_GATEWAY_URL', () => {
    let stderr = '';
    let exited = false;
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    const originalExit = process.exit.bind(process.exit);
    const originalProfile = process.env.COMMANDER_PROFILE;
    const originalGateway = process.env.COMMANDER_ACTION_GATEWAY_URL;

    process.stderr.write = ((chunk: string | Uint8Array, cb?: (err?: Error) => void) => {
      stderr += String(chunk);
      if (cb) cb();
      return true;
    }) as typeof process.stderr.write;
    process.exit = ((code?: number | string | null | undefined) => {
      exited = true;
      throw new Error(`exit:${code ?? 0}`);
    }) as typeof process.exit;
    process.env.COMMANDER_PROFILE = 'enterprise';
    delete process.env.COMMANDER_ACTION_GATEWAY_URL;

    try {
      run(['node', 'cli.js']);
    } catch {
      // expected
    } finally {
      process.stderr.write = originalStderrWrite;
      process.exit = originalExit;
      if (originalProfile === undefined) delete process.env.COMMANDER_PROFILE;
      else process.env.COMMANDER_PROFILE = originalProfile;
      if (originalGateway === undefined) delete process.env.COMMANDER_ACTION_GATEWAY_URL;
      else process.env.COMMANDER_ACTION_GATEWAY_URL = originalGateway;
    }

    expect(exited).toBe(true);
    expect(stderr).toContain('COMMANDER_ACTION_GATEWAY_URL');
  });
});

describe('action gateway guards', () => {
  it('detects enterprise/production MCP mode', () => {
    expect(isEnterpriseOrProductionMcpMode({ COMMANDER_PROFILE: 'enterprise' })).toBe(true);
    expect(isEnterpriseOrProductionMcpMode({ NODE_ENV: 'production' })).toBe(true);
    expect(isEnterpriseOrProductionMcpMode({ NODE_ENV: 'test' })).toBe(false);
  });

  it('allows non-enterprise startup without gateway url', () => {
    expect(() =>
      assertActionGatewayConfigured({ NODE_ENV: 'test', COMMANDER_ACTION_GATEWAY_URL: undefined }),
    ).not.toThrow();
  });

  it('only enables local tools with the explicit development gate', () => {
    expect(isLocalRuntimeEnabled(undefined, { COMMANDER_MCP_LOCAL_RUNTIME: '1' })).toBe(true);
    expect(isLocalRuntimeEnabled(undefined, { COMMANDER_MCP_LOCAL_RUNTIME: '0' })).toBe(false);
    expect(
      isLocalRuntimeEnabled(undefined, {
        COMMANDER_MCP_LOCAL_RUNTIME: '1',
        COMMANDER_PROFILE: 'enterprise',
      }),
    ).toBe(false);
  });

  it('refuses --allow-dangerous-tools without COMMANDER_ACTION_GATEWAY_URL', () => {
    expect(() =>
      assertActionGatewayConfigured(
        { NODE_ENV: 'test', COMMANDER_ACTION_GATEWAY_URL: undefined },
        { allowDangerousTools: true },
      ),
    ).toThrow(/COMMANDER_ACTION_GATEWAY_URL/);
  });
});

describe('action gateway MCP routing', () => {
  it('maps ticket.create to demo.ticket.create in the action envelope', async () => {
    const { buildMcpActionEnvelope } = await import('@praetor/core');
    const tool = {
      definition: { name: 'ticket.create', description: 'create', inputSchema: { type: 'object' } },
      isReadOnly: false,
      execute: async () => 'local',
    };
    const envelope = buildMcpActionEnvelope(tool as any, { title: 'x' });
    expect(envelope.effectType).toBe('demo.ticket.create');
    expect(envelope.destination).toBe('demo://tickets');
    expect(envelope.tool).toBe('ticket.create');
  });

  it('surfaces ActionGatewayPolicyError as MCP text', async () => {
    const { MCPServer, ActionGatewayPolicyError } = await import('@praetor/core');
    const tool = {
      definition: {
        name: 'demo_external_write',
        description: 'w',
        inputSchema: { type: 'object' },
      },
      isReadOnly: false,
      execute: async () => 'local',
    };
    const server = new MCPServer('policy-test', '1.0.0');
    server.registerCommanderTools(new Map([['demo_external_write', tool as any]]), undefined, {
      actionGatewayExecutor: {
        proposeAction: async () => {
          throw new ActionGatewayPolicyError('ACTION_POLICY_DENIED', 'denied by policy', {});
        },
      },
    });
    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 200,
      method: 'tools/call',
      params: { name: 'demo_external_write', arguments: {} },
    });
    const text = (response.result as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toContain('ACTION_POLICY_DENIED');
    expect(text).toContain('denied by policy');
  });

  it('refuses non-read-only tools without a gateway executor (no local execute)', async () => {
    const localExecutions: string[] = [];
    const writeTool: Tool = {
      definition: {
        name: 'demo_external_write',
        description: 'External write tool',
        inputSchema: { type: 'object', properties: {} },
      },
      isReadOnly: false,
      execute: async () => {
        localExecutions.push('called');
        return 'local-result';
      },
    };
    const server = new MCPServer('fail-closed-test', '1.0.0');
    server.registerCommanderTools(new Map([['demo_external_write', writeTool]]));

    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 201,
      method: 'tools/call',
      params: { name: 'demo_external_write', arguments: {} },
    });

    expect(response.error).toBeUndefined();
    const text = (response.result as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toContain('ACTION_GATEWAY_REQUIRED');
    expect(localExecutions).toHaveLength(0);
  });
});

describe('handleLine JSON-RPC validation (MCP-C01)', () => {
  function captureStdout(): { written: string[]; restore: () => void } {
    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    return { written, restore: () => (process.stdout.write = original) };
  }

  it('rejects JSON null before dispatch and reports an invalid-request error', async () => {
    const dispatched: unknown[] = [];
    const server = {
      handleRequest: async (request: unknown) => {
        dispatched.push(request);
        return { jsonrpc: '2.0', id: null, result: {} };
      },
    } as unknown as MCPServer;
    const { written, restore } = captureStdout();

    try {
      await handleLine(server, 'null');
    } finally {
      restore();
    }

    expect(dispatched).toHaveLength(0);
    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0])).toMatchObject({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600 },
    });
  });

  it('still dispatches a well-formed request', async () => {
    const dispatched: unknown[] = [];
    const server = {
      handleRequest: async (request: unknown) => {
        dispatched.push(request);
        return { jsonrpc: '2.0', id: 7, result: {} };
      },
    } as unknown as MCPServer;
    const { written, restore } = captureStdout();

    try {
      await handleLine(server, JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' }));
    } finally {
      restore();
    }

    expect(dispatched).toHaveLength(1);
    expect(JSON.parse(written[0])).toMatchObject({ jsonrpc: '2.0', id: 7, result: {} });
  });

  it('resolves with an internal-error response when the server throws', async () => {
    const server = {
      handleRequest: async () => {
        throw new Error('downstream blew up');
      },
    } as unknown as MCPServer;
    const { written, restore } = captureStdout();

    try {
      await expect(
        handleLine(server, JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/list' })),
      ).resolves.toBeUndefined();
    } finally {
      restore();
    }

    expect(JSON.parse(written[0])).toMatchObject({
      jsonrpc: '2.0',
      id: 8,
      error: { code: -32603 },
    });
  });

  it('keeps ignoring notifications', async () => {
    const dispatched: unknown[] = [];
    const server = {
      handleRequest: async (request: unknown) => {
        dispatched.push(request);
        return { jsonrpc: '2.0', id: null, result: {} };
      },
    } as unknown as MCPServer;
    const { written, restore } = captureStdout();

    try {
      await handleLine(
        server,
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      );
    } finally {
      restore();
    }

    expect(dispatched).toHaveLength(0);
    expect(written).toHaveLength(0);
  });
});
