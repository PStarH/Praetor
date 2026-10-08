import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import express, { type Request, type Response, type Router } from 'express';
import {
  getMessageBus,
  getWorkCoordinator,
  resetMessageBus,
  resetWorkCoordinator,
} from '@praetor/core';
import { createPipelineRouter } from '../src/pipelineEndpoints.js';
import stateMachineRouter from '../src/stateMachineEndpoints.js';
import { createStreamRouter } from '../src/streamEndpoints.js';
import { createTeamRouter } from '../src/teamEndpoints.js';

type Role = 'developer' | 'viewer' | 'admin' | 'super_admin';

const API_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function authenticatedApp(router: Router): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next) => {
    const principal = req.header('x-test-principal');
    if (principal) {
      req.user = {
        id: principal,
        username: principal,
        role: (req.header('x-test-role') ?? 'developer') as Role,
        tenantId: req.header('x-test-tenant') ?? undefined,
      };
      req.tenantId = req.user.tenantId;
    }
    next();
  });
  app.use(router);
  return app;
}

function headers(principal: string, tenant: string, role: Role = 'developer') {
  return {
    'content-type': 'application/json',
    'x-test-principal': principal,
    'x-test-tenant': tenant,
    'x-test-role': role,
  };
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

describe('CMD-STATE-MACHINE-TENANT-ISOLATION-001', () => {
  const previousLegacy = process.env.COMMANDER_LEGACY_EXECUTION;
  const previousNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.NODE_ENV = 'development';
    process.env.COMMANDER_LEGACY_EXECUTION = '1';
  });

  after(() => {
    if (previousLegacy === undefined) delete process.env.COMMANDER_LEGACY_EXECUTION;
    else process.env.COMMANDER_LEGACY_EXECUTION = previousLegacy;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  });

  it('binds pattern machines to the creator tenant and owner', async () => {
    const app = authenticatedApp(createPipelineRouter());
    await withServer(app, async (base) => {
      const created = await fetch(`${base}/api/state-machine/create`, {
        method: 'POST',
        headers: headers('alice', 'tenant-a'),
        body: JSON.stringify({ pattern: 'orchestrator-worker' }),
      });
      assert.equal(created.status, 200);

      const { machineId } = (await created.json()) as { machineId: string };
      const second = await fetch(`${base}/api/state-machine/create`, {
        method: 'POST',
        headers: headers('alice', 'tenant-a'),
        body: JSON.stringify({ pattern: 'orchestrator-worker' }),
      });
      assert.equal(second.status, 200);
      const secondBody = (await second.json()) as { machineId: string };
      assert.notEqual(secondBody.machineId, machineId);

      assert.equal(
        (
          await fetch(`${base}/api/state-machine/${machineId}`, {
            headers: headers('bob', 'tenant-a'),
          })
        ).status,
        404,
      );
      assert.equal(
        (
          await fetch(`${base}/api/state-machine/${machineId}/transition`, {
            method: 'POST',
            headers: headers('mallory', 'tenant-b'),
            body: JSON.stringify({ targetState: 'completed' }),
          })
        ).status,
        404,
      );
      assert.equal(
        (
          await fetch(`${base}/api/state-machine/${machineId}`, {
            headers: headers('tenant-admin', 'tenant-a', 'admin'),
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await fetch(`${base}/api/state-machine/${machineId}`, {
            headers: headers('root', 'tenant-b', 'super_admin'),
          })
        ).status,
        200,
      );
    });
  });

  it('binds the task state-machine reader and memory mutator to the creator', async () => {
    const app = authenticatedApp(stateMachineRouter);
    const taskId = `tenant-task-${Date.now()}`;
    await withServer(app, async (base) => {
      const created = await fetch(`${base}/create`, {
        method: 'POST',
        headers: headers('alice', 'tenant-a'),
        body: JSON.stringify({ taskId, projectId: 'project-a', agentId: 'agent-a' }),
      });
      assert.equal(created.status, 200);

      assert.equal(
        (
          await fetch(`${base}/create`, {
            method: 'POST',
            headers: headers('mallory', 'tenant-b'),
            body: JSON.stringify({ taskId, projectId: 'project-b', agentId: 'agent-b' }),
          })
        ).status,
        404,
      );
      assert.equal(
        (
          await fetch(`${base}/create`, {
            method: 'POST',
            headers: headers('alice', 'tenant-a'),
            body: JSON.stringify({ taskId, projectId: 'project-a', agentId: 'agent-a' }),
          })
        ).status,
        409,
      );

      const transitioned = await fetch(`${base}/${taskId}/transition`, {
        method: 'POST',
        headers: headers('alice', 'tenant-a'),
        body: JSON.stringify({ toState: 'planning' }),
      });
      assert.equal(transitioned.status, 200);
      const checkpointId = (
        (await transitioned.json()) as { state: { metadata: { checkpointId: string } } }
      ).state.metadata.checkpointId;
      const occupiedTaskId = `occupied-task-${Date.now()}`;
      assert.equal(
        (
          await fetch(`${base}/create`, {
            method: 'POST',
            headers: headers('bob', 'tenant-b'),
            body: JSON.stringify({
              taskId: occupiedTaskId,
              projectId: 'project-b',
              agentId: 'agent-b',
            }),
          })
        ).status,
        200,
      );

      assert.equal(
        (await fetch(`${base}/${taskId}`, { headers: headers('mallory', 'tenant-b') })).status,
        404,
      );
      assert.equal(
        (
          await fetch(`${base}/foreign-resume/resume`, {
            method: 'POST',
            headers: headers('mallory', 'tenant-b'),
            body: JSON.stringify({ checkpointId }),
          })
        ).status,
        404,
      );
      assert.equal(
        (
          await fetch(`${base}/${occupiedTaskId}/resume`, {
            method: 'POST',
            headers: headers('alice', 'tenant-a'),
            body: JSON.stringify({ checkpointId }),
          })
        ).status,
        404,
      );
      assert.equal(
        (await fetch(`${base}/${occupiedTaskId}`, { headers: headers('bob', 'tenant-b') })).status,
        200,
      );
      assert.equal(
        (
          await fetch(`${base}/owner-resume/resume`, {
            method: 'POST',
            headers: headers('alice', 'tenant-a'),
            body: JSON.stringify({ checkpointId }),
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await fetch(`${base}/owner-resume/resume`, {
            method: 'POST',
            headers: headers('alice', 'tenant-a'),
            body: JSON.stringify({ checkpointId }),
          })
        ).status,
        409,
      );
      assert.equal(
        (
          await fetch(`${base}/${taskId}/memory`, {
            method: 'POST',
            headers: headers('bob', 'tenant-a'),
            body: JSON.stringify({ type: 'observation', content: 'tamper' }),
          })
        ).status,
        404,
      );
      assert.equal(
        (await fetch(`${base}/${taskId}`, { headers: headers('alice', 'tenant-a') })).status,
        200,
      );
      assert.equal(
        (
          await fetch(`${base}/${taskId}`, {
            headers: headers('tenant-admin', 'tenant-a', 'admin'),
          })
        ).status,
        200,
      );
    });
  });

  it('does not overwrite a persisted destination after an API restart', async () => {
    const taskId = `persisted-task-${Date.now()}`;
    const stateDir = path.join(API_ROOT, 'data', 'state-machines');
    const stateFile = path.join(stateDir, `${taskId}.json`);
    const now = new Date().toISOString();
    const persistedState = {
      currentStep: 'initialized',
      context: {},
      memory: {
        taskId,
        projectId: 'project-b',
        agentId: 'agent-b',
        history: [],
        createdAt: now,
        updatedAt: now,
      },
      governanceMode: 'SINGLE',
      metadata: { createdAt: now, updatedAt: now, version: 1 },
      ownership: { tenantId: 'tenant-b', ownerId: 'bob' },
    };
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(stateFile, JSON.stringify(persistedState));

    const app = authenticatedApp(stateMachineRouter);
    try {
      await withServer(app, async (base) => {
        assert.equal(
          (
            await fetch(`${base}/create`, {
              method: 'POST',
              headers: headers('alice', 'tenant-a'),
              body: JSON.stringify({ taskId, projectId: 'project-a', agentId: 'agent-a' }),
            })
          ).status,
          404,
        );
        assert.equal(
          (
            await fetch(`${base}/create`, {
              method: 'POST',
              headers: headers('bob', 'tenant-b'),
              body: JSON.stringify({ taskId, projectId: 'project-b', agentId: 'agent-b' }),
            })
          ).status,
          409,
        );
        assert.equal(
          (
            await fetch(`${base}/${taskId}/resume`, {
              method: 'POST',
              headers: headers('alice', 'tenant-a'),
              body: JSON.stringify({ checkpointId: '00000000-0000-4000-8000-000000000001' }),
            })
          ).status,
          404,
        );
        assert.deepEqual(JSON.parse(readFileSync(stateFile, 'utf8')), persistedState);
      });
    } finally {
      rmSync(stateFile, { force: true });
    }
  });
});

describe('CMD-PIPELINE-RUN-DISCLOSURE-001', () => {
  const previousLegacy = process.env.COMMANDER_LEGACY_EXECUTION;
  const previousNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.NODE_ENV = 'development';
    process.env.COMMANDER_LEGACY_EXECUTION = '1';
  });

  after(() => {
    if (previousLegacy === undefined) delete process.env.COMMANDER_LEGACY_EXECUTION;
    else process.env.COMMANDER_LEGACY_EXECUTION = previousLegacy;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  });

  it('restricts privileged results to tenant admins while preserving super-admin access', async () => {
    const app = authenticatedApp(
      createPipelineRouter({
        agentExecutor: async () => ({ output: { secret: 'tenant-a-result' } }),
      }),
    );
    await withServer(app, async (base) => {
      const executed = await fetch(`${base}/api/pipeline/execute`, {
        method: 'POST',
        headers: headers('admin-a', 'tenant-a', 'admin'),
        body: JSON.stringify({
          id: 'pipeline-a',
          steps: [{ id: 'step-a', agentId: 'agent-a' }],
          input: { sensitive: true },
        }),
      });
      assert.equal(executed.status, 200);
      const run = (await executed.json()) as { id: string };

      assert.equal(
        (
          await fetch(`${base}/api/pipeline/runs/${run.id}`, {
            headers: headers('viewer-a', 'tenant-a', 'viewer'),
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await fetch(`${base}/api/pipeline/runs/${run.id}`, {
            headers: headers('admin-b', 'tenant-b', 'admin'),
          })
        ).status,
        404,
      );
      assert.equal(
        (
          await fetch(`${base}/api/pipeline/runs/${run.id}`, {
            headers: headers('other-admin-a', 'tenant-a', 'admin'),
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await fetch(`${base}/api/pipeline/runs/${run.id}`, {
            headers: headers('root', 'tenant-b', 'super_admin'),
          })
        ).status,
        200,
      );
      const foreignList = await fetch(`${base}/api/pipeline/runs`, {
        headers: headers('admin-b', 'tenant-b', 'admin'),
      });
      assert.deepEqual(await foreignList.json(), []);
    });
  });
});

describe('CMD-TEAM-READ-TENANT-001', () => {
  afterEach(() => resetWorkCoordinator());

  it('hides status, work, and agents for foreign tenants and preserves owner/admin access', async () => {
    resetWorkCoordinator();
    const [item] = getWorkCoordinator().enqueue({
      runId: 'run-tenant-a',
      parentNodeId: 'owner-a',
      goal: 'private coordination goal',
      tools: [],
      tenantId: 'tenant-a',
      ownerId: 'owner-a',
    });
    assert.equal(item.ownerId, 'owner-a');
    const app = authenticatedApp(createTeamRouter());
    await withServer(app, async (base) => {
      for (const endpoint of ['status', 'work', 'agents']) {
        assert.equal((await fetch(`${base}/api/teams/run-tenant-a/${endpoint}`)).status, 401);
        assert.equal(
          (
            await fetch(`${base}/api/teams/run-tenant-a/${endpoint}`, {
              headers: headers('mallory', 'tenant-b'),
            })
          ).status,
          404,
        );
        assert.equal(
          (
            await fetch(`${base}/api/teams/run-tenant-a/${endpoint}`, {
              headers: headers('owner-a', 'tenant-a'),
            })
          ).status,
          200,
        );
        assert.equal(
          (
            await fetch(`${base}/api/teams/run-tenant-a/${endpoint}`, {
              headers: headers('admin-a', 'tenant-a', 'admin'),
            })
          ).status,
          200,
        );
      }
    });
  });
});

describe('CMD-SSE-PROJECT-AUTHZ-001', () => {
  afterEach(() => resetMessageBus());

  it('authorizes the project and drops events for other or unattributed projects', async () => {
    const projects = new Map<string, unknown>([
      ['project-a', { id: 'project-a', tenantId: 'tenant-a', ownerId: 'alice' }],
      ['project-b', { id: 'project-b', tenantId: 'tenant-a', ownerId: 'bob' }],
    ]);
    const app = authenticatedApp(
      createStreamRouter({ resolveProject: (projectId) => projects.get(projectId) }),
    );
    await withServer(app, async (base) => {
      assert.equal(
        (
          await fetch(`${base}/projects/project-a/events`, {
            headers: headers('mallory', 'tenant-b'),
          })
        ).status,
        404,
      );

      const response = await fetch(`${base}/projects/project-a/events`, {
        headers: { ...headers('alice', 'tenant-a'), accept: 'text/event-stream' },
      });
      assert.equal(response.status, 200);
      const reader = response.body?.getReader();
      assert.ok(reader);
      await reader.read(); // retry frame

      const bus = getMessageBus() as unknown as {
        publish(topic: string, source: string, payload: unknown): unknown;
      };
      bus.publish('agent.started', 'agent-b', { projectId: 'project-b', goal: 'foreign-secret' });
      bus.publish('agent.started', 'agent-unknown', { goal: 'unattributed-secret' });
      bus.publish('agent.started', 'agent-a', { projectId: 'project-a', goal: 'allowed-event' });

      const chunk = await reader.read();
      const text = new TextDecoder().decode(chunk.value);
      assert.match(text, /allowed-event/);
      assert.doesNotMatch(text, /foreign-secret|unattributed-secret/);
      await reader.cancel();
    });
  });

  it('fails closed when project ownership metadata cannot be resolved', async () => {
    const withoutResolver = authenticatedApp(createStreamRouter());
    await withServer(withoutResolver, async (base) => {
      assert.equal(
        (
          await fetch(`${base}/projects/project-a/events`, {
            headers: headers('alice', 'tenant-a'),
          })
        ).status,
        404,
      );
    });

    const withoutTenantMetadata = authenticatedApp(
      createStreamRouter({ resolveProject: () => ({ id: 'project-a', ownerId: 'alice' }) }),
    );
    await withServer(withoutTenantMetadata, async (base) => {
      assert.equal(
        (
          await fetch(`${base}/projects/project-a/events`, {
            headers: headers('alice', 'tenant-a'),
          })
        ).status,
        404,
      );
    });
  });
});
