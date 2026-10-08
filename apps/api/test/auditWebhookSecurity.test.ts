import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import express, { type Request, type Response } from 'express';
import type { AddressInfo } from 'node:net';

const originalCwd = process.cwd();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-webhook-security-'));
process.chdir(tmpDir);

const { createAuditLogRouter } = await import('../src/auditLogEndpoints');
const { createApprovalConfigRouter } = await import('../src/approvalConfigEndpoints');
const { createWebhookRouter } = await import('../src/webhookEndpoints');
const { resetUnifiedAuditLog } = await import('@praetor/core/security');

const webhookFile = path.join(tmpDir, '.commander', 'webhooks.json');
const userActionsFile = path.join(tmpDir, '.commander', 'audit', 'user-actions.ndjson');
const securityFile = path.join(tmpDir, '.commander', 'security', 'events.ndjson');
const approvalAuditFile = path.join(tmpDir, '.commander', 'security-audit.jsonl');
const wecomEncodingAESKey = Buffer.alloc(32, 0x42).toString('base64').replace(/=$/, '');
const wecomReceiveId = 'ww-security-test';
function encryptWeComMessage(message: string, receiveId = wecomReceiveId): string {
  const key = Buffer.from(`${wecomEncodingAESKey}=`, 'base64');
  const messageBuffer = Buffer.from(message);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(messageBuffer.length);
  const unpadded = Buffer.concat([
    Buffer.alloc(16, 0x24),
    length,
    messageBuffer,
    Buffer.from(receiveId),
  ]);
  const paddingLength = 32 - (unpadded.length % 32);
  const padded = Buffer.concat([unpadded, Buffer.alloc(paddingLength, paddingLength)]);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString('base64');
}

function signWeCom(token: string, timestamp: string, nonce: string, encrypted: string): string {
  return crypto
    .createHash('sha1')
    .update([token, timestamp, nonce, encrypted].sort().join(''))
    .digest('hex');
}

async function postWeCom(
  baseUrl: string,
  configId: string,
  token: string,
  encrypted: string,
  plaintextContent?: string,
): Promise<globalThis.Response> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = 'security-nonce';
  const msgSignature = signWeCom(token, timestamp, nonce, encrypted);
  const params = new URLSearchParams({ timestamp, nonce, msg_signature: msgSignature });
  const outerContent = plaintextContent ? `<Content><![CDATA[${plaintextContent}]]></Content>` : '';
  return fetch(`${baseUrl}/api/webhook/wecom/${configId}?${params}`, {
    method: 'POST',
    headers: { 'content-type': 'application/xml' },
    body: `<xml><Encrypt><![CDATA[${encrypted}]]></Encrypt>${outerContent}</xml>`,
  });
}

function testPrincipal(req: Request, _res: Response, next: () => void): void {
  const tenantId = req.header('x-test-tenant');
  const role = req.header('x-test-role');
  if (tenantId) req.tenantId = tenantId;
  if (role === 'viewer' || role === 'auditor' || role === 'admin') {
    req.user = { id: `${role}-id`, username: role, role, tenantId };
  }
  next();
}

async function startServer(router: express.Router) {
  const app = express();
  app.use(express.json());
  app.use(testPrincipal);
  app.use(router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function headers(role: 'viewer' | 'auditor' | 'admin', tenantId: string) {
  return { 'x-test-role': role, 'x-test-tenant': tenantId };
}

beforeEach(() => {
  fs.mkdirSync(path.dirname(webhookFile), { recursive: true });
  fs.mkdirSync(path.dirname(userActionsFile), { recursive: true });
  fs.mkdirSync(path.dirname(securityFile), { recursive: true });
  fs.writeFileSync(
    webhookFile,
    JSON.stringify([
      {
        id: 'enabled-a',
        platform: 'dingtalk',
        name: 'enabled A',
        secret: 'enabled-a-secret',
        agentId: 'agent-a',
        enabled: true,
        createdAt: '2026-07-22T00:00:00.000Z',
        tenantId: 'tenant-a',
      },
      {
        id: 'disabled-a',
        platform: 'dingtalk',
        name: 'disabled A',
        secret: 'disabled-a-secret',
        agentId: 'agent-disabled',
        enabled: false,
        createdAt: '2026-07-22T00:00:00.000Z',
        tenantId: 'tenant-a',
      },
      {
        id: 'enabled-b',
        platform: 'feishu',
        name: 'enabled B',
        secret: 'enabled-b-secret',
        agentId: 'agent-b',
        enabled: true,
        createdAt: '2026-07-22T00:00:00.000Z',
        tenantId: 'tenant-b',
      },
      {
        id: 'wecom-enabled',
        platform: 'wecom',
        name: 'WeCom enabled',
        secret: 'wecom-enabled-secret',
        encodingAESKey: wecomEncodingAESKey,
        receiveId: wecomReceiveId,
        agentId: 'agent-wecom',
        enabled: true,
        createdAt: '2026-07-22T00:00:00.000Z',
        tenantId: 'tenant-a',
      },
      {
        id: 'wecom-missing-key',
        platform: 'wecom',
        name: 'WeCom missing key',
        secret: 'wecom-missing-key-secret',
        receiveId: wecomReceiveId,
        agentId: 'agent-wecom',
        enabled: true,
        createdAt: '2026-07-22T00:00:00.000Z',
        tenantId: 'tenant-a',
      },
    ]),
  );
  const auditEntries = [
    {
      id: 'audit-a',
      timestamp: '2026-07-22T01:00:00.000Z',
      category: 'user_action',
      eventType: 'action.a',
      severity: 'info',
      tenantId: 'tenant-a',
      message: 'audit tenant A',
      source: 'test',
    },
    {
      id: 'audit-b',
      timestamp: '2026-07-22T02:00:00.000Z',
      category: 'user_action',
      eventType: 'action.b',
      severity: 'warn',
      tenantId: 'tenant-b',
      message: 'audit tenant B',
      source: 'test',
    },
    {
      id: 'audit-unscoped',
      timestamp: '2026-07-22T03:00:00.000Z',
      category: 'user_action',
      eventType: 'action.unscoped',
      severity: 'critical',
      message: 'audit unscoped',
      source: 'test',
    },
  ];
  fs.writeFileSync(userActionsFile, auditEntries.map((entry) => JSON.stringify(entry)).join('\n'));
  fs.writeFileSync(
    securityFile,
    auditEntries
      .slice(0, 2)
      .map((entry) =>
        JSON.stringify({
          ...entry,
          type: entry.eventType,
          context: { tenantId: entry.tenantId },
        }),
      )
      .join('\n'),
  );
  fs.writeFileSync(
    approvalAuditFile,
    [
      {
        timestamp: '2026-07-22T01:00:00.000Z',
        event: 'approval.decision',
        decision: 'allow',
        tenantId: 'tenant-a',
      },
      {
        timestamp: '2026-07-22T02:00:00.000Z',
        event: 'approval.decision',
        decision: 'deny',
        tenantId: 'tenant-b',
      },
      { timestamp: '2026-07-22T03:00:00.000Z', event: 'approval.decision', decision: 'allow' },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n'),
  );
  resetUnifiedAuditLog();
});

after(() => {
  process.chdir(originalCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('audit endpoint security', () => {
  it('rejects missing or insufficient authority', async () => {
    const server = await startServer(createAuditLogRouter());
    try {
      assert.equal((await fetch(`${server.baseUrl}/api/audit-logs`)).status, 401);
      assert.equal(
        (
          await fetch(`${server.baseUrl}/api/audit-logs`, {
            headers: headers('viewer', 'tenant-a'),
          })
        ).status,
        403,
      );
    } finally {
      await server.close();
    }
  });

  it('keeps query and export tenant-bound while preserving legitimate auditor reads', async () => {
    const server = await startServer(createAuditLogRouter());
    try {
      const query = await fetch(`${server.baseUrl}/api/audit-logs`, {
        headers: headers('auditor', 'tenant-a'),
      });
      assert.equal(query.status, 200);
      const queryBody = (await query.json()) as { entries: Array<{ id: string }> };
      assert.ok(queryBody.entries.length > 0);
      assert.ok(queryBody.entries.every((entry) => entry.id === 'audit-a'));

      const exported = await fetch(`${server.baseUrl}/api/audit-logs/export`, {
        headers: headers('auditor', 'tenant-b'),
      });
      assert.equal(exported.status, 200);
      const exportBody = await exported.text();
      assert.match(exportBody, /audit-b/);
      assert.doesNotMatch(exportBody, /audit-a|audit-unscoped/);

      const stats = await fetch(`${server.baseUrl}/api/audit-logs/stats`, {
        headers: headers('auditor', 'tenant-a'),
      });
      const statsText = await stats.text();
      assert.equal(stats.status, 200);
      assert.match(statsText, /action\.a/);
      assert.doesNotMatch(statsText, /action\.b|action\.unscoped/);

      const catalog = await fetch(`${server.baseUrl}/api/audit-logs/categories`, {
        headers: headers('auditor', 'tenant-b'),
      });
      const catalogText = await catalog.text();
      assert.equal(catalog.status, 200);
      assert.match(catalogText, /action\.b/);
      assert.doesNotMatch(catalogText, /action\.a|action\.unscoped/);

      const legacy = await fetch(`${server.baseUrl}/api/audit/logs`, {
        headers: headers('admin', 'tenant-a'),
      });
      assert.equal(legacy.status, 200);
      const legacyBody = (await legacy.json()) as { logs: Array<{ tenantId?: string }> };
      assert.ok(legacyBody.logs.length > 0);
      assert.ok(legacyBody.logs.every((entry) => entry.tenantId === 'tenant-a'));
    } finally {
      await server.close();
    }
  });
});

describe('approval audit endpoint security', () => {
  it('requires tenant-bound audit authority and hides foreign approval decisions', async () => {
    const server = await startServer(createApprovalConfigRouter());
    try {
      assert.equal((await fetch(`${server.baseUrl}/api/approval/audit-log`)).status, 401);
      assert.equal(
        (
          await fetch(`${server.baseUrl}/api/approval/audit-log`, {
            headers: headers('viewer', 'tenant-a'),
          })
        ).status,
        403,
      );
      const own = await fetch(`${server.baseUrl}/api/approval/audit-log`, {
        headers: headers('auditor', 'tenant-a'),
      });
      assert.equal(own.status, 200);
      const body = (await own.json()) as { entries: Array<{ tenantId?: string }> };
      assert.deepEqual(
        body.entries.map((entry) => entry.tenantId),
        ['tenant-a'],
      );
    } finally {
      await server.close();
    }
  });
});

describe('webhook endpoint security', () => {
  it('redacts secrets from list/create and requires admin mutation authority', async () => {
    const server = await startServer(createWebhookRouter());
    try {
      const list = await fetch(`${server.baseUrl}/api/webhook/config`, {
        headers: headers('admin', 'tenant-a'),
      });
      const listText = await list.text();
      assert.equal(list.status, 200);
      assert.doesNotMatch(listText, /secret/i);
      assert.doesNotMatch(listText, /enabled B/);

      const unauthenticated = await fetch(`${server.baseUrl}/api/webhook/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ platform: 'feishu', name: 'anon write', agentId: 'agent-x' }),
      });
      assert.equal(unauthenticated.status, 401);

      const denied = await fetch(`${server.baseUrl}/api/webhook/config`, {
        method: 'POST',
        headers: { ...headers('viewer', 'tenant-a'), 'content-type': 'application/json' },
        body: JSON.stringify({ platform: 'feishu', name: 'viewer write', agentId: 'agent-x' }),
      });
      assert.equal(denied.status, 403);

      const created = await fetch(`${server.baseUrl}/api/webhook/config`, {
        method: 'POST',
        headers: { ...headers('admin', 'tenant-a'), 'content-type': 'application/json' },
        body: JSON.stringify({
          platform: 'feishu',
          name: 'admin write',
          agentId: 'agent-new',
          secret: 'caller-supplied-secret',
        }),
      });
      const createdText = await created.text();
      assert.equal(created.status, 201);
      assert.doesNotMatch(createdText, /secret/i);
      assert.match(fs.readFileSync(webhookFile, 'utf-8'), /caller-supplied-secret/);
    } finally {
      await server.close();
    }
  });

  it('rejects disabled callbacks before execution and accepts an enabled signed callback', async () => {
    const server = await startServer(createWebhookRouter());
    try {
      const disabled = await fetch(
        `${server.baseUrl}/api/webhook/dingtalk/disabled-a?timestamp=0&sign=invalid`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ msgtype: 'text', text: { content: 'execute this' } }),
        },
      );
      assert.equal(disabled.status, 404);
      assert.equal(
        (
          await fetch(`${server.baseUrl}/api/webhook/feishu/disabled-a`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              header: { event_type: 'im.message.receive_v1', token: 'disabled-a-secret' },
              event: { message: { content: JSON.stringify({ text: 'execute this' }) } },
            }),
          })
        ).status,
        404,
      );
      assert.equal(
        (
          await fetch(`${server.baseUrl}/api/webhook/wecom/disabled-a`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({}),
          })
        ).status,
        404,
      );

      const timestamp = String(Date.now());
      const sign = crypto
        .createHmac('sha256', 'enabled-a-secret')
        .update(`${timestamp}\nenabled-a-secret`)
        .digest('base64');
      const enabled = await fetch(
        `${server.baseUrl}/api/webhook/dingtalk/enabled-a?timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ msgtype: 'text', text: { content: '' } }),
        },
      );
      assert.equal(enabled.status, 200);
      assert.match(await enabled.text(), /Please send a message/);
    } finally {
      await server.close();
    }
  });

  it('prevents an admin from deleting another tenant webhook', async () => {
    const server = await startServer(createWebhookRouter());
    try {
      const crossTenant = await fetch(`${server.baseUrl}/api/webhook/config/enabled-a`, {
        method: 'DELETE',
        headers: headers('admin', 'tenant-b'),
      });
      assert.equal(crossTenant.status, 404);
      assert.match(fs.readFileSync(webhookFile, 'utf-8'), /enabled-a/);

      const sameTenant = await fetch(`${server.baseUrl}/api/webhook/config/enabled-a`, {
        method: 'DELETE',
        headers: headers('admin', 'tenant-a'),
      });
      assert.equal(sameTenant.status, 200);
      assert.doesNotMatch(fs.readFileSync(webhookFile, 'utf-8'), /enabled-a/);
    } finally {
      await server.close();
    }
  });

  it('does not trust plaintext Content when a correctly signed envelope carries another message', async () => {
    const decrypted =
      '<xml><MsgType><![CDATA[image]]></MsgType><Content><![CDATA[encrypted metadata]]></Content></xml>';
    const encrypted = encryptWeComMessage(decrypted);
    const server = await startServer(createWebhookRouter());
    try {
      const response = await postWeCom(
        server.baseUrl,
        'wecom-enabled',
        'wecom-enabled-secret',
        encrypted,
        'attacker plaintext should never execute',
      );
      assert.equal(response.status, 200);
      assert.match(await response.text(), /<Content><!\[CDATA\[OK\]\]><\/Content>/);
    } finally {
      await server.close();
    }
  });

  it('fails closed when a signed WeCom callback has no encodingAESKey', async () => {
    const encrypted = encryptWeComMessage(
      '<xml><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[secret message]]></Content></xml>',
    );
    const server = await startServer(createWebhookRouter());
    try {
      const response = await postWeCom(
        server.baseUrl,
        'wecom-missing-key',
        'wecom-missing-key-secret',
        encrypted,
      );
      assert.equal(response.status, 401);
      assert.match(await response.text(), /decryption unavailable/);
    } finally {
      await server.close();
    }
  });

  it('validates a legitimate encrypted text callback without restoring in-process execution', async () => {
    const encrypted = encryptWeComMessage(
      '<xml><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[legitimate encrypted task]]></Content></xml>',
    );
    const server = await startServer(createWebhookRouter());
    try {
      const response = await postWeCom(
        server.baseUrl,
        'wecom-enabled',
        'wecom-enabled-secret',
        encrypted,
        'forged outer plaintext',
      );
      assert.equal(response.status, 410);
      const body = (await response.json()) as {
        error?: { code?: string; replacement?: string };
      };
      assert.equal(body.error?.code, 'LEGACY_EXECUTION_DISABLED');
      assert.equal(body.error?.replacement, 'POST /v1/actions');
    } finally {
      await server.close();
    }
  });
});
