import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { runWithTenant } from '@praetor/core/runtime/tenantContext';
import { AgentCardRegistry, type AgentCard } from '../src/agentCard';
import { createAgentCardRouter } from '../src/agentCardEndpoints';
import { tenantContextMiddleware } from '../src/tenantContextMiddleware';

function makeCard(id: string, tenantId?: string): AgentCard {
  return {
    id,
    tenantId,
    name: `Agent ${id}`,
    description: 'Test agent',
    version: '1.0.0',
    capabilities: [{ id: 'test', name: 'Test', description: 'Test', modalities: ['text'] }],
    authentication: [{ type: 'bearer', description: 'Bearer token' }],
    endpoints: [
      { type: 'task', url: 'https://agent.test/task', method: 'POST', description: 'Task' },
    ],
    metadata: { vendor: 'Test', tags: ['test'], updatedAt: new Date(0).toISOString() },
  };
}

describe('AgentCardRegistry tenant ownership', () => {
  it('binds legitimate registration to the active tenant', () => {
    const registry = new AgentCardRegistry();
    const card = makeCard('tenant-a-card');

    runWithTenant('tenant-a', () => registry.register(card));

    assert.equal(card.tenantId, 'tenant-a');
    assert.equal(runWithTenant('tenant-a', () => registry.get(card.id))?.tenantId, 'tenant-a');
  });

  it('rejects caller-selected foreign ownership', () => {
    const registry = new AgentCardRegistry();

    assert.throws(
      () => runWithTenant('tenant-a', () => registry.register(makeCard('forged', 'tenant-b'))),
      /Cross-tenant registration blocked/,
    );
    assert.equal(runWithTenant('tenant-b', () => registry.listAll()).length, 0);
  });

  it('rejects overwriting a public or foreign card id', () => {
    const registry = new AgentCardRegistry();
    registry.register(makeCard('shared-id'));

    assert.throws(
      () => runWithTenant('tenant-a', () => registry.register(makeCard('shared-id'))),
      /Cross-tenant card overwrite blocked/,
    );
    assert.equal(registry.get('shared-id')?.tenantId, '__default__');
  });

  it('allows the owning tenant to update its own card', () => {
    const registry = new AgentCardRegistry();
    runWithTenant('tenant-a', () => registry.register(makeCard('owned')));
    const updated = makeCard('owned');
    updated.description = 'Updated by owner';

    runWithTenant('tenant-a', () => registry.register(updated));

    assert.equal(
      runWithTenant('tenant-a', () => registry.get('owned'))?.description,
      'Updated by owner',
    );
  });
});

describe('agent-card HTTP registration', () => {
  it('returns 403 for forged tenant ownership and preserves victim discovery', async () => {
    const registry = new AgentCardRegistry();
    runWithTenant('tenant-b', () => registry.register(makeCard('victim-card')));
    const app = express();
    app.use(express.json());
    app.use(tenantContextMiddleware);
    app.use('/api', createAgentCardRouter(registry));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.on('listening', resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/agent-cards`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-tenant-id': 'tenant-a' },
        body: JSON.stringify(makeCard('victim-card', 'tenant-b')),
      });

      assert.equal(response.status, 403);
      assert.equal(
        runWithTenant('tenant-b', () => registry.get('victim-card'))?.name,
        'Agent victim-card',
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
