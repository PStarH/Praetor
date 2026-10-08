import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import express, { type Router } from 'express';
import {
  createSeedWarRoomData,
  getProjectWarRoomSnapshot,
  getWorkCoordinator,
  InMemoryMemoryService,
  MemoryStoreFacade,
  resetWorkCoordinator,
} from '@praetor/core';
import { runWithTenant } from '@praetor/core/runtime/tenantContext';
import { createDlqRouter } from '../src/dlqEndpoints.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { ProjectMemoryStoreAdapter } from '../src/memoryStoreAdapter.js';
import { createProjectRouter } from '../src/projectEndpoints.js';
import type { IWarRoomStore } from '../src/store.js';
import { createTeamRouter } from '../src/teamEndpoints.js';
import { createWorkflowRouter } from '../src/workflowEndpoints.js';

function authenticatedApp(router: Router): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const principal = req.header('x-test-principal');
    if (principal) {
      const requestedRole = req.header('x-test-role');
      req.user = {
        id: principal,
        username: principal,
        role:
          requestedRole === 'admin' || requestedRole === 'super_admin'
            ? requestedRole
            : 'developer',
        tenantId: req.header('x-test-tenant') ?? undefined,
      };
    }
    const apiKey = req.header('x-test-api-key');
    if (apiKey) {
      req.apiKeyId = apiKey;
      req.apiScopes = [];
      req.tenantId = req.header('x-test-tenant') ?? undefined;
    }
    next();
  });
  app.use(router);
  return app;
}

async function withServer(app: express.Express, action: (base: string) => Promise<void>) {
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

function headers(
  principal: string,
  tenant: string,
  role?: 'admin' | 'super_admin',
): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-test-principal': principal,
    'x-test-tenant': tenant,
    ...(role ? { 'x-test-role': role } : {}),
  };
}

describe('CMD-PROJECT-TENANT-ISOLATION-001', () => {
  it('requires identity, hides cross-tenant projects, and preserves same-tenant/admin access', async () => {
    const data = createSeedWarRoomData();
    Object.assign(data.projects[0], { tenantId: 'local', ownerId: 'alice' });
    const store: IWarRoomStore = {
      listProjects: () => data.projects,
      getProjectSnapshot: (projectId) => getProjectWarRoomSnapshot(data, projectId),
      listAgents: (projectId) => data.agents.filter((agent) => agent.projectId === projectId),
      getGovernanceStats: () => ({
        totalMissions: 0,
        highRiskMissions: 0,
        manualGovernanceMissions: 0,
        pendingApprovalMissions: 0,
        completionRate: 0,
        manualApprovalRate: 0,
      }),
      getPendingApprovals: () => [],
      createMission: () => {
        throw new Error('not used');
      },
      updateMission: () => {
        throw new Error('not used');
      },
      createLog: () => {
        throw new Error('not used');
      },
      close: () => undefined,
    };
    const memory = new ProjectMemoryStoreAdapter(
      new MemoryStoreFacade(new InMemoryMemoryService(), 'project-security-test'),
    );
    const app = authenticatedApp(createProjectRouter(store, memory, new AgentStateStore()));

    await withServer(app, async (base) => {
      assert.equal((await fetch(`${base}/projects/project-war-room/war-room`)).status, 401);
      assert.equal(
        (
          await fetch(`${base}/projects/project-war-room/war-room`, {
            headers: headers('alice', 'local'),
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await fetch(`${base}/projects/project-war-room/war-room`, {
            headers: headers('bob', 'local'),
          })
        ).status,
        404,
      );
      assert.equal(
        (
          await fetch(`${base}/projects/project-war-room/war-room`, {
            headers: headers('bob', 'local', 'admin'),
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await fetch(`${base}/projects/project-war-room/war-room`, {
            headers: headers('mallory', 'tenant-b'),
          })
        ).status,
        404,
      );
      assert.equal(
        (
          await fetch(`${base}/projects/project-war-room/war-room`, {
            headers: headers('root', 'tenant-b', 'super_admin'),
          })
        ).status,
        200,
      );
    });
  });

  it('fails closed for ownerless project mutations while preserving admin and explicit-owner access', async () => {
    const data = createSeedWarRoomData();
    Object.assign(data.projects[0], { tenantId: 'tenant-a' });
    const projectId = data.projects[0].id;
    const agentId = data.agents.find((agent) => agent.projectId === projectId)!.id;
    const missionId = data.missions.find((mission) => mission.projectId === projectId)!.id;
    const calls = { agentState: 0, missionCreate: 0, missionUpdate: 0, memory: 0, log: 0 };
    const store: IWarRoomStore = {
      listProjects: () => data.projects,
      getProjectSnapshot: (id) => getProjectWarRoomSnapshot(data, id),
      listAgents: (id) => data.agents.filter((agent) => agent.projectId === id),
      getGovernanceStats: () => ({
        totalMissions: 0,
        highRiskMissions: 0,
        manualGovernanceMissions: 0,
        pendingApprovalMissions: 0,
        completionRate: 0,
        manualApprovalRate: 0,
      }),
      getPendingApprovals: () => [],
      createMission: (input) => {
        calls.missionCreate += 1;
        return { ...data.missions[0], ...input, id: `created-${calls.missionCreate}` };
      },
      updateMission: (id, input) => {
        calls.missionUpdate += 1;
        return { ...data.missions[0], ...input, id };
      },
      createLog: (input) => {
        calls.log += 1;
        return { ...data.logs[0], ...input, id: `log-${calls.log}` };
      },
      close: () => undefined,
    };
    const memory = {
      list: async () => [],
      overview: async () => ({}),
      search: async () => [],
      append: async (input: Record<string, unknown>) => {
        calls.memory += 1;
        return { ...input, id: `memory-${calls.memory}` };
      },
    } as unknown as ProjectMemoryStoreAdapter;
    const agentState = {
      get: () => undefined,
      upsert: (input: Record<string, unknown>) => {
        calls.agentState += 1;
        return { ...input, updatedAt: new Date().toISOString() };
      },
    } as unknown as AgentStateStore;
    const app = authenticatedApp(createProjectRouter(store, memory, agentState));

    const requests = (base: string, requestHeaders: Record<string, string>) => [
      fetch(`${base}/projects/${projectId}/agents/${agentId}/state`, {
        method: 'PATCH',
        headers: requestHeaders,
        body: JSON.stringify({ summary: 'forged' }),
      }),
      fetch(`${base}/projects/${projectId}/missions`, {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify({ title: 'forged', assignedAgentId: agentId }),
      }),
      fetch(`${base}/missions/${missionId}`, {
        method: 'PATCH',
        headers: requestHeaders,
        body: JSON.stringify({ title: 'forged' }),
      }),
      fetch(`${base}/projects/${projectId}/memory`, {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify({ title: 'forged', content: 'forged' }),
      }),
      fetch(`${base}/missions/${missionId}/logs`, {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify({ message: 'forged' }),
      }),
    ];

    await withServer(app, async (base) => {
      for (const deniedHeaders of [
        headers('viewer-a', 'tenant-a'),
        {
          'content-type': 'application/json',
          'x-test-api-key': 'key-a',
          'x-test-tenant': 'tenant-a',
        },
      ]) {
        const denied = await Promise.all(requests(base, deniedHeaders));
        assert.deepEqual(
          denied.map((response) => response.status),
          [404, 404, 404, 404, 404],
        );
      }
      assert.deepEqual(calls, {
        agentState: 0,
        missionCreate: 0,
        missionUpdate: 0,
        memory: 0,
        log: 0,
      });

      const adminResults = await Promise.all(
        requests(base, headers('tenant-admin', 'tenant-a', 'admin')),
      );
      assert.deepEqual(
        adminResults.map((response) => response.status),
        [200, 201, 200, 201, 201],
      );

      Object.assign(data.projects[0], { ownerId: 'alice' });
      const ownerResults = await Promise.all(requests(base, headers('alice', 'tenant-a')));
      assert.deepEqual(
        ownerResults.map((response) => response.status),
        [200, 201, 200, 201, 201],
      );
    });
  });

  it('rejects memory records that reference a mission or agent from another project', async () => {
    const data = createSeedWarRoomData();
    const projectA = data.projects[0];
    Object.assign(projectA, { tenantId: 'tenant-a', ownerId: 'alice' });
    const projectB = { ...projectA, id: 'project-b', name: 'Project B', ownerId: 'bob' };
    data.projects.push(projectB);
    const foreignMission = { ...data.missions[0], id: 'mission-b', projectId: projectB.id };
    const foreignAgent = { ...data.agents[0], id: 'agent-b', projectId: projectB.id };
    data.missions.push(foreignMission);
    data.agents.push(foreignAgent);
    let appendCalls = 0;
    const store: IWarRoomStore = {
      listProjects: () => data.projects,
      getProjectSnapshot: (id) => getProjectWarRoomSnapshot(data, id),
      listAgents: (id) => data.agents.filter((agent) => agent.projectId === id),
      getGovernanceStats: () => ({
        totalMissions: 0,
        highRiskMissions: 0,
        manualGovernanceMissions: 0,
        pendingApprovalMissions: 0,
        completionRate: 0,
        manualApprovalRate: 0,
      }),
      getPendingApprovals: () => [],
      createMission: () => data.missions[0],
      updateMission: () => data.missions[0],
      createLog: () => data.logs[0],
      close: () => undefined,
    };
    const memory = {
      append: async (input: Record<string, unknown>) => {
        appendCalls += 1;
        return { ...input, id: 'memory-forged' };
      },
    } as unknown as ProjectMemoryStoreAdapter;
    const app = authenticatedApp(
      createProjectRouter(store, memory, { get: () => undefined } as unknown as AgentStateStore),
    );

    await withServer(app, async (base) => {
      const response = await fetch(`${base}/projects/${projectA.id}/memory`, {
        method: 'POST',
        headers: headers('alice', 'tenant-a'),
        body: JSON.stringify({
          title: 'cross-project references',
          content: 'must fail',
          missionId: foreignMission.id,
          agentId: foreignAgent.id,
        }),
      });
      assert.equal(response.status, 404);
      assert.equal(appendCalls, 0);
    });
  });
});

describe('CMD-WORKFLOW-GLOBAL-001', () => {
  const workflowsFile = path.resolve('.commander/workflows.json');
  let previous: string | undefined;

  before(() => {
    try {
      previous = readFileSync(workflowsFile, 'utf8');
    } catch {
      previous = undefined;
    }
    mkdirSync(path.dirname(workflowsFile), { recursive: true });
    writeFileSync(workflowsFile, '[]\n');
  });

  after(() => {
    if (previous === undefined) rmSync(workflowsFile, { force: true });
    else writeFileSync(workflowsFile, previous);
  });

  it('scopes persisted workflows to their owner tenant while allowing admins', async () => {
    const app = authenticatedApp(createWorkflowRouter());
    await withServer(app, async (base) => {
      assert.equal((await fetch(`${base}/api/workflows`)).status, 401);
      const created = await fetch(`${base}/api/workflows`, {
        method: 'POST',
        headers: headers('alice', 'tenant-a'),
        body: JSON.stringify({
          name: 'tenant-a workflow',
          nodes: [{ id: 'start', type: 'start', position: { x: 0, y: 0 }, data: {} }],
          edges: [],
        }),
      });
      assert.equal(created.status, 201);
      const id = ((await created.json()) as { workflow: { id: string } }).workflow.id;

      assert.equal(
        (await fetch(`${base}/api/workflows/${id}`, { headers: headers('mallory', 'tenant-b') }))
          .status,
        404,
      );
      assert.equal(
        (
          await fetch(`${base}/api/workflows/${id}/execute`, {
            method: 'POST',
            headers: headers('mallory', 'tenant-b'),
          })
        ).status,
        404,
      );
      assert.equal(
        (
          await fetch(`${base}/api/workflows/${id}`, {
            method: 'DELETE',
            headers: headers('mallory', 'tenant-b'),
          })
        ).status,
        404,
      );
      assert.equal(
        (await fetch(`${base}/api/workflows/${id}`, { headers: headers('alice', 'tenant-a') }))
          .status,
        200,
      );
      assert.equal(
        (
          await fetch(`${base}/api/workflows/${id}/execute`, {
            method: 'POST',
            headers: headers('alice', 'tenant-a'),
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await fetch(`${base}/api/workflows/${id}`, {
            headers: headers('tenant-admin', 'tenant-a', 'admin'),
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await fetch(`${base}/api/workflows/${id}`, {
            headers: headers('root', 'tenant-b', 'super_admin'),
          })
        ).status,
        200,
      );
    });
  });

  it('does not acknowledge a workflow whose write to disk failed', async () => {
    // Force the atomic write to fail: rename(2) of a file onto an existing
    // directory fails, so the persistence step cannot succeed.
    rmSync(workflowsFile, { force: true });
    mkdirSync(workflowsFile, { recursive: true });
    try {
      const app = authenticatedApp(createWorkflowRouter());
      await withServer(app, async (base) => {
        const created = await fetch(`${base}/api/workflows`, {
          method: 'POST',
          headers: headers('alice', 'tenant-a'),
          body: JSON.stringify({
            name: 'must-not-be-acknowledged',
            nodes: [{ id: 'start', type: 'start', position: { x: 0, y: 0 }, data: {} }],
            edges: [],
          }),
        });
        assert.ok(
          created.status >= 400,
          `a failed disk write must not be acknowledged, got HTTP ${created.status}`,
        );

        const listed = await fetch(`${base}/api/workflows`, {
          headers: headers('alice', 'tenant-a'),
        });
        const body = (await listed.json()) as { workflows: { name: string }[] };
        assert.equal(
          body.workflows.some((workflow) => workflow.name === 'must-not-be-acknowledged'),
          false,
          'a workflow that failed to persist must not appear in the served cache',
        );
      });
    } finally {
      rmSync(workflowsFile, { recursive: true, force: true });
      writeFileSync(workflowsFile, '[]\n');
    }
  });
});

describe('CMD-TEAM-REASSIGN-001', () => {
  after(() => resetWorkCoordinator());

  it('mounts the router once at the /api/teams paths it declares', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    assert.match(source, /name: 'team', mountPath: '\/'/);
    assert.doesNotMatch(source, /name: 'team', mountPath: '\/api'/);
  });

  it('binds workId to runId and blocks cross-tenant reassignment', async () => {
    resetWorkCoordinator();
    const coord = getWorkCoordinator();
    const [item] = await runWithTenant('tenant-a', () =>
      coord.enqueue({
        runId: 'run-a',
        parentNodeId: 'owner-a',
        goal: 'test',
        tools: [],
        ownerId: 'owner-a',
      }),
    );
    assert.equal(item.tenantId, 'tenant-a');
    assert.equal(item.ownerId, 'owner-a');
    assert.ok(coord.claim('agent-a', { runId: 'run-a' }));

    const app = authenticatedApp(createTeamRouter());
    await withServer(app, async (base) => {
      assert.equal(
        (
          await fetch(`${base}/api/teams/run-a/reassign`, {
            method: 'POST',
            headers: headers('tenant-admin', 'tenant-a', 'admin'),
            body: JSON.stringify({ workId: item.id }),
          })
        ).status,
        200,
      );
      assert.ok(coord.claim('agent-a', { runId: 'run-a' }));
      assert.equal(
        (
          await fetch(`${base}/api/teams/run-a/reassign`, {
            method: 'POST',
            headers: headers('mallory', 'tenant-b'),
            body: JSON.stringify({ workId: item.id }),
          })
        ).status,
        404,
      );
      assert.equal(
        (
          await fetch(`${base}/api/teams/wrong-run/reassign`, {
            method: 'POST',
            headers: headers('owner-a', 'tenant-a'),
            body: JSON.stringify({ workId: item.id }),
          })
        ).status,
        404,
      );
      assert.equal(
        (
          await fetch(`${base}/api/teams/run-a/reassign`, {
            method: 'POST',
            headers: headers('owner-a', 'tenant-a'),
            body: JSON.stringify({ workId: item.id }),
          })
        ).status,
        200,
      );
    });
  });

  it('fails closed when persisted work has no authoritative owner', async () => {
    resetWorkCoordinator();
    const coord = getWorkCoordinator();
    const [item] = await runWithTenant('tenant-a', () =>
      coord.enqueue({
        runId: 'run-without-owner',
        parentNodeId: 'alice',
        goal: 'private task',
        tools: [],
      }),
    );
    assert.ok(coord.claim('alice', { runId: 'run-without-owner' }));

    const app = authenticatedApp(createTeamRouter());
    await withServer(app, async (base) => {
      for (const endpoint of ['status', 'work', 'agents']) {
        assert.equal(
          (
            await fetch(`${base}/api/teams/run-without-owner/${endpoint}`, {
              headers: headers('alice', 'tenant-a'),
            })
          ).status,
          404,
        );
      }
      assert.equal(
        (
          await fetch(`${base}/api/teams/run-without-owner/reassign`, {
            method: 'POST',
            headers: headers('alice', 'tenant-a'),
            body: JSON.stringify({ workId: item.id }),
          })
        ).status,
        404,
      );
      assert.equal(coord.list({ runId: 'run-without-owner' })[0]?.status, 'CLAIMED');
    });
  });
});

describe('CMD-DLQ-REPLAY-001', () => {
  const dlqDir = path.resolve('.commander_dlq');
  const dlqFile = path.join(dlqDir, 'semantic_drift.ndjson');
  let previous: string | undefined;

  before(() => {
    try {
      previous = readFileSync(dlqFile, 'utf8');
    } catch {
      previous = undefined;
    }
    mkdirSync(dlqDir, { recursive: true });
  });

  after(() => {
    if (previous === undefined) rmSync(dlqFile, { force: true });
    else writeFileSync(dlqFile, previous);
  });

  it('does not let another tenant discover or replay a DLQ entry', async () => {
    writeFileSync(
      dlqFile,
      `${JSON.stringify({
        id: 'entry-tenant-a',
        category: 'semantic_drift',
        runId: 'run-a',
        agentId: 'owner-a',
        timestamp: new Date().toISOString(),
        errorClass: 'Error',
        errorMessage: 'failed',
        retryable: true,
        attemptNumber: 1,
        operationName: 'op',
        compensated: false,
        recovered: false,
        tags: [],
        tenantId: 'tenant-a',
        ownerId: 'owner-a',
      })}\n`,
    );
    const app = authenticatedApp(createDlqRouter());
    await withServer(app, async (base) => {
      assert.equal(
        (
          await fetch(`${base}/api/dlq/replay/entry-tenant-a`, {
            method: 'POST',
            headers: headers('mallory', 'tenant-b'),
          })
        ).status,
        404,
      );
      assert.equal(
        (
          await fetch(`${base}/api/dlq/replay/entry-tenant-a`, {
            method: 'POST',
            headers: headers('owner-a', 'tenant-a'),
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await fetch(`${base}/api/dlq/replay/entry-tenant-a`, {
            method: 'POST',
            headers: headers('tenant-admin', 'tenant-a', 'admin'),
          })
        ).status,
        200,
      );
      const persisted = readFileSync(dlqFile, 'utf8');
      assert.match(persisted, /"recovered":true/);
    });
  });
});
