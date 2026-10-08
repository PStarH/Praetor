import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import express from 'express';
import { resetGuardianAgent } from '@praetor/core';
import { createMCPRouter, type McpActionGatewayExecutor } from '../src/mcpEndpoints.js';

async function withMcpRouter(
  options: Parameters<typeof createMCPRouter>[0],
  action: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = {
      id: 'gateway-admin',
      username: 'gateway-admin',
      role: 'admin',
      authVersion: 1,
    };
    next();
  });
  app.use('/mcp', createMCPRouter(options));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    await action(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function rpc(baseUrl: string, name: string, args: Record<string, unknown>) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: name,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.error, undefined);
  return body;
}

describe('MCP Action Gateway surface', () => {
  it('advertises gateway-only enterprise tools and dispatches exact requests', async () => {
    const calls: Parameters<McpActionGatewayExecutor['request']>[0][] = [];
    const executor: McpActionGatewayExecutor = {
      request: async (request) => {
        calls.push(request);
        return { action: { runId: 'run-api-1', state: 'PROPOSED' } };
      },
    };

    await withMcpRouter({ actionGatewayExecutor: executor }, async (baseUrl) => {
      const statusResponse = await fetch(`${baseUrl}/mcp/status`);
      const status = (await statusResponse.json()) as {
        enterpriseWrites: boolean;
        tools: Array<{ name: string }>;
      };
      assert.equal(status.enterpriseWrites, true);
      assert.deepEqual(status.tools.map((tool) => tool.name).sort(), [
        'commander_action_approve',
        'commander_action_compensation_approve',
        'commander_action_compensation_request',
        'commander_action_evidence',
        'commander_action_get',
        'commander_action_propose',
        'commander_action_reconcile',
        'commander_action_simulate',
      ]);

      const envelope = {
        source: 'mcp',
        package: 'commander.mcp',
        model: 'mcp-default',
        tool: 'ticket.create',
        destination: 'demo://tickets',
        effectType: 'demo.ticket.create',
        args: { title: 'hello' },
        idempotencyKey: 'mcp-api-0001',
      };
      await rpc(baseUrl, 'commander_action_simulate', envelope);
      await rpc(baseUrl, 'commander_action_propose', envelope);
      await rpc(baseUrl, 'commander_action_get', { runId: 'run/1' });
      await rpc(baseUrl, 'commander_action_approve', {
        runId: 'run/1',
        idempotencyKey: 'mcp-approve-0001',
        actionDigest: 'b'.repeat(64),
        simulationId: 'simulation-api-1',
        policySnapshotId: 'policy-api-1',
      });
      await rpc(baseUrl, 'commander_action_compensation_request', {
        runId: 'run/1',
        idempotencyKey: 'mcp-compensation-0001',
        originalEffectId: 'effect-1',
        adapterVersion: 'demo.adapter.v1',
        compensationEffectType: 'compensate.demo.ticket.create',
        compensationPatch: { ticketId: 'ticket-1' },
        forwardReceiptHash: 'c'.repeat(64),
      });
      await rpc(baseUrl, 'commander_action_compensation_approve', {
        runId: 'run/1',
        authorizationId: 'authorization-1',
        idempotencyKey: 'mcp-compensation-approve-0001',
        actionDigest: 'd'.repeat(64),
        policySnapshotId: 'policy-api-1',
      });
      resetGuardianAgent();
      await rpc(baseUrl, 'commander_action_reconcile', {
        runId: 'run/1',
        idempotencyKey: 'mcp-reconcile-0001',
      });
      await rpc(baseUrl, 'commander_action_evidence', { runId: 'run/1' });
    });

    assert.deepEqual(calls, [
      {
        method: 'POST',
        path: '/v1/actions/simulate',
        body: {
          source: 'mcp',
          package: 'commander.mcp',
          model: 'mcp-default',
          tool: 'ticket.create',
          destination: 'demo://tickets',
          effectType: 'demo.ticket.create',
          args: { title: 'hello' },
          idempotencyKey: 'mcp-api-0001',
        },
        headers: { 'Idempotency-Key': 'mcp-api-0001' },
      },
      {
        method: 'POST',
        path: '/v1/actions',
        body: {
          source: 'mcp',
          package: 'commander.mcp',
          model: 'mcp-default',
          tool: 'ticket.create',
          destination: 'demo://tickets',
          effectType: 'demo.ticket.create',
          args: { title: 'hello' },
          idempotencyKey: 'mcp-api-0001',
        },
        headers: { 'Idempotency-Key': 'mcp-api-0001' },
      },
      { method: 'GET', path: '/v1/actions/run%2F1' },
      {
        method: 'POST',
        path: '/v1/actions/run%2F1/approve',
        body: {
          actionDigest: 'b'.repeat(64),
          simulationId: 'simulation-api-1',
          policySnapshotId: 'policy-api-1',
        },
        headers: { 'Idempotency-Key': 'mcp-approve-0001' },
      },
      {
        method: 'POST',
        path: '/v1/actions/run%2F1/compensations',
        body: {
          originalEffectId: 'effect-1',
          adapterVersion: 'demo.adapter.v1',
          compensationEffectType: 'compensate.demo.ticket.create',
          compensationPatch: { ticketId: 'ticket-1' },
          forwardReceiptHash: 'c'.repeat(64),
        },
        headers: { 'Idempotency-Key': 'mcp-compensation-0001' },
      },
      {
        method: 'POST',
        path: '/v1/actions/run%2F1/compensations/authorization-1/approve',
        body: { actionDigest: 'd'.repeat(64), policySnapshotId: 'policy-api-1' },
        headers: { 'Idempotency-Key': 'mcp-compensation-approve-0001' },
      },
      {
        method: 'POST',
        path: '/v1/actions/run%2F1/reconcile',
        headers: { 'Idempotency-Key': 'mcp-reconcile-0001' },
      },
      { method: 'GET', path: '/v1/actions/run%2F1/evidence' },
    ]);
  });

  it('advertises local-only mode honestly', async () => {
    await withMcpRouter({ localRuntime: true }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/mcp/status`);
      const status = (await response.json()) as {
        enterpriseWrites: boolean;
        tools: Array<{ name: string }>;
      };
      assert.equal(status.enterpriseWrites, false);
      assert.ok(status.tools.some((tool) => tool.name === 'execute_agent'));
      assert.ok(!status.tools.some((tool) => tool.name === 'commander_action_propose'));
    });
  });
});
