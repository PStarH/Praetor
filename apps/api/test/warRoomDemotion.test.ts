import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, before, after } from 'node:test';
import express from 'express';
import { createWarRoomStore } from '../src/store.js';
import { ProjectMemoryStoreAdapter } from '../src/memoryStoreAdapter.js';
import { InMemoryMemoryService, MemoryStoreFacade } from '@praetor/core';
import { AgentStateStore } from '../src/agentStateStore.js';
import { createProjectRouter } from '../src/projectEndpoints.js';
import { enterpriseRouteFreeze, legacyHeader } from '../src/enterpriseGateway.js';

/**
 * WS3 §5 WarRoom demotion tests.
 *
 * Verifies:
 * - Enterprise profile: WarRoom write endpoints (missions/approve/logs/agent-state/memory)
 *   return 410 Gone + x-legacy before reaching the handler.
 * - Enterprise profile: GET endpoints are reachable under /v1 (migrated read-only surface).
 * - Enterprise profile: legacy GET endpoints under /projects/* return 410 + x-legacy.
 * - Standard profile: write endpoints still work but carry x-legacy header.
 * - Standard profile: GET endpoints work at original paths with x-legacy header.
 */

const PROJECT_ID = 'project-war-room';
const LEGACY_WRITE_ENDPOINTS: Array<[string, string, Record<string, unknown>]> = [
  ['POST', `/projects/${PROJECT_ID}/missions`, { title: 't', assignedAgentId: 'agent-builder' }],
  ['PATCH', '/missions/mission-1', { status: 'DONE' }],
  ['POST', '/missions/mission-1/approve', { approver: 'op' }],
  ['POST', `/projects/${PROJECT_ID}/memory`, { title: 't', content: 'c' }],
  ['POST', '/missions/mission-1/logs', { message: 'log' }],
  ['PATCH', `/projects/${PROJECT_ID}/agents/agent-builder/state`, { summary: 's' }],
];

const V1_GET_ENDPOINTS: Array<[string, string]> = [
  ['GET', '/v1/projects'],
  ['GET', `/v1/projects/${PROJECT_ID}/agents`],
  ['GET', `/v1/projects/${PROJECT_ID}/war-room`],
  ['GET', `/v1/projects/${PROJECT_ID}/memory`],
  ['GET', `/v1/projects/${PROJECT_ID}/memory/overview`],
  ['GET', `/v1/projects/${PROJECT_ID}/memory/search`],
  ['GET', `/v1/projects/${PROJECT_ID}/governance/stats`],
  ['GET', `/v1/projects/${PROJECT_ID}/governance/alerts`],
];

function request(base: string, method: string, url: string, body?: unknown) {
  const init: RequestInit = { method, redirect: 'manual' };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  return fetch(`${base}${url}`, init);
}

async function withApp(
  profile: 'enterprise' | 'standard',
  action: (base: string) => Promise<void>,
): Promise<void> {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'ws3-warroom-'));
  const oldFile = process.env.COMMANDER_WARROOM_FILE;
  const oldProfile = process.env.COMMANDER_PROFILE;
  process.env.COMMANDER_WARROOM_FILE = path.join(tmpDir, 'war-room.json');
  process.env.COMMANDER_PROFILE = profile;
  try {
    const store = createWarRoomStore();
    const memoryStore = new ProjectMemoryStoreAdapter(
      new MemoryStoreFacade(new InMemoryMemoryService(), 'tenant-demotion-test'),
    );
    const agentStateStore = new AgentStateStore();

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = {
        id: 'warroom-test-user',
        username: 'warroom-test-user',
        role: 'admin',
        tenantId: 'local',
      };
      next();
    });
    // Middleware order mirrors index.ts startServer() wiring.
    app.use(enterpriseRouteFreeze());
    app.use(legacyHeader());
    // Legacy router at root (write + read in standard; frozen in enterprise).
    app.use('/', createProjectRouter(store, memoryStore, agentStateStore));
    // /v1 read-only surface (spec §5.1 GET migration).
    app.use('/v1', createProjectRouter(store, memoryStore, agentStateStore, { readOnly: true }));

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      await action(`http://127.0.0.1:${address.port}`);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  } finally {
    // F-B-6: assigning `undefined` coerces to the string "undefined", leaving
    // COMMANDER_PROFILE DEFINED for every later test in the process.
    if (oldProfile === undefined) delete process.env.COMMANDER_PROFILE;
    else process.env.COMMANDER_PROFILE = oldProfile;
    if (oldFile !== undefined) process.env.COMMANDER_WARROOM_FILE = oldFile;
    else delete process.env.COMMANDER_WARROOM_FILE;
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe('WS3 §5 WarRoom demotion — enterprise profile', () => {
  it('rejects every WarRoom write endpoint with 410 Gone + x-legacy', async () => {
    await withApp('enterprise', async (base) => {
      for (const [method, url, body] of LEGACY_WRITE_ENDPOINTS) {
        const res = await request(base, method, url, body);
        assert.equal(res.status, 410, `${method} ${url} must be 410`);
        assert.equal(res.headers.get('x-legacy'), 'true', `${method} ${url} must carry x-legacy`);
        const json = (await res.json()) as { error: { code: string } };
        assert.equal(json.error.code, 'GONE', `${method} ${url} must return GONE`);
      }
    });
  });

  it('serves GET endpoints under /v1 (migrated read-only surface)', async () => {
    await withApp('enterprise', async (base) => {
      for (const [method, url] of V1_GET_ENDPOINTS) {
        const res = await request(base, method, url);
        assert.equal(res.status, 200, `${method} ${url} must be reachable under /v1`);
        assert.equal(res.headers.get('x-legacy'), null, `${url} must not carry x-legacy`);
        assert.equal(res.headers.get('x-commander-projection'), 'war-room');
        assert.equal(res.headers.get('x-commander-canonical-authority'), 'kernel');
      }
    });
  });

  it('does NOT expose WarRoom write endpoints under /v1 (readOnly surface)', async () => {
    await withApp('enterprise', async (base) => {
      // Spec §5.1: WarRoom write endpoints are removed, not migrated.
      // /v1 must not carry POST/PATCH missions/approve/logs/agent-state/memory.
      for (const [method, url, body] of LEGACY_WRITE_ENDPOINTS) {
        const v1Url =
          url.startsWith('/projects/') || url.startsWith('/missions/') ? `/v1${url}` : `/v1${url}`;
        const res = await request(base, method, v1Url, body);
        assert.equal(
          res.status,
          404,
          `${method} ${v1Url} must not exist under /v1 (read-only surface)`,
        );
      }
    });
  });

  it('rejects legacy GET endpoints under /projects/* with 410 + x-legacy', async () => {
    await withApp('enterprise', async (base) => {
      const res = await request(base, 'GET', '/projects');
      assert.equal(res.status, 410);
      assert.equal(res.headers.get('x-legacy'), 'true');
    });
  });
});

describe('WS3 §5 WarRoom demotion — standard profile', () => {
  it('still serves write endpoints but tags x-legacy', async () => {
    await withApp('standard', async (base) => {
      // POST /projects/:id/missions should succeed (201) and carry x-legacy.
      const res = await request(base, 'POST', `/projects/${PROJECT_ID}/missions`, {
        title: 'ws3 test mission',
        assignedAgentId: 'agent-builder',
      });
      assert.equal(res.status, 201, 'write endpoint must still work in standard profile');
      assert.equal(res.headers.get('x-legacy'), 'true', 'must carry x-legacy header');
    });
  });

  it('serves GET endpoints at original paths with x-legacy', async () => {
    await withApp('standard', async (base) => {
      const res = await request(base, 'GET', '/projects');
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('x-legacy'), 'true');
    });
  });

  it('does NOT tag /v1 paths with x-legacy', async () => {
    await withApp('standard', async (base) => {
      const res = await request(base, 'GET', '/v1/projects');
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('x-legacy'), null);
    });
  });
});
