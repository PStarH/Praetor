import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import express, { type Request, type Response } from 'express';
import {
  getMessageBus,
  getOutboundNetworkPolicy,
  getWebhookDispatcher,
  resetMessageBus,
  resetWebhookDispatcher,
} from '@praetor/core';
import { runWithTenant } from '@praetor/core/runtime/tenantContext';
import { createOutgoingWebhookRouter } from '../src/outgoingWebhookEndpoints';

function listen(app: express.Express): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        port,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for webhook delivery');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function injectPrincipal(req: Request, _res: Response, next: () => void): void {
  const role = req.header('x-test-role') === 'viewer' ? 'viewer' : 'admin';
  const claimTenant = req.header('x-test-tenant') ?? 'tenant-a';
  const boundTenant = req.header('x-test-bound-tenant') ?? claimTenant;
  const noTenant = req.header('x-test-no-tenant') === 'true';
  if (req.header('x-test-auth') === 'api-key') {
    req.user = null;
    req.apiKeyId = `key-${claimTenant}`;
    req.apiScopes = role === 'viewer' ? ['read'] : ['admin'];
  } else {
    req.user = {
      id: `${role}-1`,
      username: `${role}-1`,
      role,
      tenantId: noTenant ? undefined : claimTenant,
    };
  }
  req.tenantId = noTenant ? undefined : boundTenant;
  next();
}

describe('outgoing webhook credential redaction', () => {
  it('never exposes configured headers while preserving them for delivery', async () => {
    resetWebhookDispatcher();
    const dispatcher = runWithTenant('tenant-a', () => getWebhookDispatcher());
    const app = express();
    app.use(express.json());
    app.use(injectPrincipal);
    app.use(createOutgoingWebhookRouter());

    const { port, close } = await listen(app);
    let webhookId: string | undefined;

    try {
      const createResponse = await fetch(`http://127.0.0.1:${port}/api/outgoing-webhooks`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-test-role': 'admin',
        },
        body: JSON.stringify({
          url: 'https://hooks.example.com/commander-security-test',
          events: ['agent.completed'],
          secret: 'signing-secret',
          headers: {
            Authorization: 'Bearer downstream-secret',
            'X-Api-Key': 'api-secret',
            'X-Delivery-Mode': 'batch',
          },
        }),
      });
      assert.equal(createResponse.status, 201);
      const createBody = (await createResponse.json()) as {
        webhook: Record<string, unknown> & { id: string };
      };
      webhookId = createBody.webhook.id;
      assert.equal('secret' in createBody.webhook, false);
      assert.equal('headers' in createBody.webhook, false);

      const stored = dispatcher.getWebhook(webhookId);
      assert.equal(stored?.secret, 'signing-secret');
      assert.deepEqual(stored?.headers, {
        Authorization: 'Bearer downstream-secret',
        'X-Api-Key': 'api-secret',
        'X-Delivery-Mode': 'batch',
      });

      const listResponse = await fetch(`http://127.0.0.1:${port}/api/outgoing-webhooks`, {
        headers: { 'x-test-role': 'viewer' },
      });
      assert.equal(listResponse.status, 200);
      const listBody = (await listResponse.json()) as { webhooks: Array<Record<string, unknown>> };
      const listed = listBody.webhooks.find((webhook) => webhook.id === webhookId);
      assert.ok(listed);
      assert.equal('secret' in listed, false);
      assert.equal('headers' in listed, false);

      const detailResponse = await fetch(
        `http://127.0.0.1:${port}/api/outgoing-webhooks/${webhookId}`,
        { headers: { 'x-test-role': 'viewer' } },
      );
      assert.equal(detailResponse.status, 200);
      const detailBody = (await detailResponse.json()) as { webhook: Record<string, unknown> };
      assert.equal('secret' in detailBody.webhook, false);
      assert.equal('headers' in detailBody.webhook, false);

      const viewerCreateResponse = await fetch(`http://127.0.0.1:${port}/api/outgoing-webhooks`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-test-role': 'viewer',
        },
        body: JSON.stringify({
          url: 'https://hooks.example.com/forbidden',
          events: ['agent.completed'],
        }),
      });
      assert.equal(viewerCreateResponse.status, 403);

      const viewerDeleteResponse = await fetch(
        `http://127.0.0.1:${port}/api/outgoing-webhooks/${webhookId}`,
        { method: 'DELETE', headers: { 'x-test-role': 'viewer' } },
      );
      assert.equal(viewerDeleteResponse.status, 403);
      assert.ok(dispatcher.getWebhook(webhookId));
    } finally {
      if (webhookId) dispatcher.deregisterWebhook(webhookId);
      await close();
      resetWebhookDispatcher();
    }
  });

  it('isolates configuration and delivery metadata between tenants', async () => {
    resetWebhookDispatcher();
    const app = express();
    app.use(express.json());
    app.use(injectPrincipal);
    app.use(createOutgoingWebhookRouter());
    const { port, close } = await listen(app);

    try {
      const created = await fetch(`http://127.0.0.1:${port}/api/outgoing-webhooks`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-test-role': 'admin',
          'x-test-tenant': 'tenant-a',
          'x-test-auth': 'api-key',
        },
        body: JSON.stringify({
          url: 'https://hooks.example.com/tenant-a',
          events: ['agent.completed'],
          description: 'tenant-a-only',
        }),
      });
      assert.equal(created.status, 201);
      const webhookId = ((await created.json()) as { webhook: { id: string } }).webhook.id;

      const tenantBHeaders = {
        'x-test-role': 'admin',
        'x-test-tenant': 'tenant-b',
        'x-test-auth': 'api-key',
      };
      const listB = await fetch(`http://127.0.0.1:${port}/api/outgoing-webhooks`, {
        headers: tenantBHeaders,
      });
      assert.equal(listB.status, 200);
      assert.deepEqual(await listB.json(), { webhooks: [] });

      for (const suffix of ['', '/deliveries']) {
        const response = await fetch(
          `http://127.0.0.1:${port}/api/outgoing-webhooks/${webhookId}${suffix}`,
          { headers: tenantBHeaders },
        );
        assert.equal(response.status, 404);
      }

      const deleteB = await fetch(`http://127.0.0.1:${port}/api/outgoing-webhooks/${webhookId}`, {
        method: 'DELETE',
        headers: tenantBHeaders,
      });
      assert.equal(deleteB.status, 404);

      const recentB = await fetch(
        `http://127.0.0.1:${port}/api/outgoing-webhooks/deliveries/recent`,
        { headers: tenantBHeaders },
      );
      assert.equal(recentB.status, 200);
      assert.deepEqual(await recentB.json(), { deliveries: [] });

      const detailA = await fetch(`http://127.0.0.1:${port}/api/outgoing-webhooks/${webhookId}`, {
        headers: {
          'x-test-role': 'viewer',
          'x-test-tenant': 'tenant-a',
          'x-test-auth': 'api-key',
        },
      });
      assert.equal(detailA.status, 200);
      assert.equal(
        ((await detailA.json()) as { webhook: { description: string } }).webhook.description,
        'tenant-a-only',
      );
      const deleteA = await fetch(`http://127.0.0.1:${port}/api/outgoing-webhooks/${webhookId}`, {
        method: 'DELETE',
        headers: {
          'x-test-role': 'admin',
          'x-test-tenant': 'tenant-a',
          'x-test-auth': 'api-key',
        },
      });
      assert.equal(deleteA.status, 200);
    } finally {
      await close();
      resetWebhookDispatcher();
    }
  });

  it('fails closed when the bound tenant is missing or disagrees with the JWT claim', async () => {
    resetWebhookDispatcher();
    const app = express();
    app.use(express.json());
    app.use(injectPrincipal);
    app.use(createOutgoingWebhookRouter());
    const { port, close } = await listen(app);

    try {
      const mismatch = await fetch(`http://127.0.0.1:${port}/api/outgoing-webhooks`, {
        headers: {
          'x-test-tenant': 'tenant-a',
          'x-test-bound-tenant': 'tenant-b',
        },
      });
      assert.equal(mismatch.status, 403);

      const missing = await fetch(`http://127.0.0.1:${port}/api/outgoing-webhooks`, {
        headers: { 'x-test-no-tenant': 'true' },
      });
      assert.equal(missing.status, 403);

      const missingApiKey = await fetch(`http://127.0.0.1:${port}/api/outgoing-webhooks`, {
        headers: { 'x-test-auth': 'api-key', 'x-test-no-tenant': 'true' },
      });
      assert.equal(missingApiKey.status, 403);
    } finally {
      await close();
      resetWebhookDispatcher();
    }
  });

  it('lazily starts tenant dispatchers and delivers only events from the matching tenant bus', async () => {
    resetWebhookDispatcher();
    resetMessageBus();
    const deliveries: Array<{ url: string; event: { payload: unknown } }> = [];
    const networkPolicy = getOutboundNetworkPolicy();
    const originalFetch = networkPolicy.ssrfCheckedFetch.bind(networkPolicy);
    networkPolicy.ssrfCheckedFetch = async (url, init) => {
      deliveries.push({
        url,
        event: JSON.parse(String(init?.body)) as { payload: unknown },
      });
      return new Response(null, { status: 204 });
    };

    const app = express();
    app.use(express.json());
    app.use(injectPrincipal);
    app.use(createOutgoingWebhookRouter());
    const { port, close } = await listen(app);

    try {
      for (const tenantId of ['tenant-a', 'tenant-b']) {
        const response = await fetch(`http://127.0.0.1:${port}/api/outgoing-webhooks`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-test-auth': 'api-key',
            'x-test-role': 'admin',
            'x-test-tenant': tenantId,
          },
          body: JSON.stringify({
            url: `https://hooks.example.com/${tenantId}`,
            events: ['agent.completed'],
          }),
        });
        assert.equal(response.status, 201);
      }

      runWithTenant('tenant-a', () =>
        getMessageBus().publish('agent.completed', 'test', { tenantId: 'tenant-a' }),
      );
      runWithTenant('tenant-b', () =>
        getMessageBus().publish('agent.completed', 'test', { tenantId: 'tenant-b' }),
      );
      await waitFor(() => deliveries.length === 2);
      await waitFor(
        () =>
          runWithTenant('tenant-a', () => getWebhookDispatcher().getDeliveryLog().length) === 1 &&
          runWithTenant('tenant-b', () => getWebhookDispatcher().getDeliveryLog().length) === 1,
      );

      assert.deepEqual(
        deliveries.map(({ url, event }) => ({ url, payload: event.payload })),
        [
          {
            url: 'https://hooks.example.com/tenant-a',
            payload: { tenantId: 'tenant-a' },
          },
          {
            url: 'https://hooks.example.com/tenant-b',
            payload: { tenantId: 'tenant-b' },
          },
        ],
      );

      for (const tenantId of ['tenant-a', 'tenant-b']) {
        const state = JSON.parse(
          readFileSync(path.resolve('.commander', `tenant_${tenantId}`, 'webhooks.json'), 'utf8'),
        ) as {
          tenantId: string;
          webhooks: Array<{ url: string }>;
          deliveryLog: Array<{ webhookId: string }>;
        };
        assert.equal(state.tenantId, tenantId);
        assert.deepEqual(
          state.webhooks.map((webhook) => webhook.url),
          [`https://hooks.example.com/${tenantId}`],
        );
        assert.equal(state.deliveryLog.length, 1);
      }

      getWebhookDispatcher().stop();
      runWithTenant('tenant-a', () =>
        getMessageBus().publish('agent.completed', 'test', { tenantId: 'after-shutdown' }),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(deliveries.length, 2);
    } finally {
      networkPolicy.ssrfCheckedFetch = originalFetch;
      await close();
      resetWebhookDispatcher();
      resetMessageBus();
    }
  });
});
