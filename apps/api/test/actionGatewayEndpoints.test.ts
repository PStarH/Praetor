import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import express from 'express';
import {
  ACTION_STATES_V1,
  evaluateActionGatewayPolicy,
  type ActionStateV1,
} from '@praetor/contracts';
import {
  buildRunEvidenceBundle,
  canonicalEvidenceBody,
  createEvidenceSigner,
  verifyEvidenceBundle,
} from '@praetor/effect-broker';
import {
  InMemoryKernelRepository,
  seedFreshOperationsDrains,
} from '@praetor/kernel/testing/inMemoryRepository';
import type { KillSwitchScope } from '@praetor/kernel';
import type {
  ActionReconcileRequestResult,
  GatewayEvidenceRecord,
  V1KernelGateway,
} from '../src/v1GatewayKernel.js';
import { GatewayIdempotencyConflictError } from '../src/v1GatewayKernel.js';
import { projectCanonicalActionState } from '../src/actionGatewayEndpoints.js';
import { createV1GatewayRouter } from '../src/v1GatewayEndpoints.js';

class InMemoryGateway implements V1KernelGateway {
  readonly repository = new InMemoryKernelRepository();
  private readonly submissions = new Map<string, string>();
  readonly evidence = new Map<string, GatewayEvidenceRecord>();
  killSwitchLookupError: Error | null = null;
  operationsReady = true;
  evidenceReady = true;

  getOperationsReadiness(_tenantId: string, now = new Date()) {
    return Promise.resolve({
      ready: this.operationsReady,
      ...(this.operationsReady ? {} : { reason: 'RECONCILIATION_DRAIN_UNAVAILABLE' as const }),
      reconciliationWorkers: this.operationsReady ? 1 : 0,
      compensationWorkers: this.operationsReady ? 1 : 0,
      checkedAt: now.toISOString(),
    });
  }

  getEvidenceRepositoryAvailability() {
    return Promise.resolve({ ready: this.evidenceReady });
  }

  async submit(input: Parameters<V1KernelGateway['submit']>[0]) {
    const runId = `run_${createHash('sha256')
      .update(`${input.tenantId}:${input.idempotencyKey}`)
      .digest('hex')
      .slice(0, 40)}`;
    const submission = JSON.stringify(input);
    const existing = await this.repository.getRun(runId, input.tenantId);
    if (existing) {
      if (this.submissions.get(runId) !== submission) {
        throw new GatewayIdempotencyConflictError(
          'Idempotency-Key was already used with a different request',
        );
      }
      return { run: existing, created: false };
    }
    const run = await this.repository.createRun(
      {
        id: runId,
        tenantId: input.tenantId,
        intentHash: 'intent',
        workGraphHash: 'graph',
        workGraphVersion: input.workGraphVersion,
        policySnapshotId: input.policySnapshotId,
        metadata: input.metadata,
        steps: input.steps,
      },
      input.actor,
    );
    this.submissions.set(runId, submission);
    return { run, created: true };
  }

  getRun(runId: string, tenantId: string) {
    return this.repository.getRun(runId, tenantId);
  }
  getStep(stepId: string, tenantId: string) {
    return this.repository.getStep(stepId, tenantId);
  }
  listEvents(runId: string, tenantId: string) {
    return this.repository.listEvents(runId, tenantId);
  }
  listInteractions(runId: string, tenantId: string) {
    return this.repository.listInteractions(runId, tenantId);
  }
  createInteraction(
    input: Parameters<InMemoryKernelRepository['createInteraction']>[0],
    actor: string,
  ) {
    return this.repository.createInteraction(input, actor);
  }
  answerInteraction(input: Parameters<InMemoryKernelRepository['answerInteraction']>[0]) {
    return this.repository.answerInteraction(input);
  }
  listEffects(runId: string, tenantId: string) {
    return this.repository.listEffectsForRun(runId, tenantId);
  }
  getEffect(effectId: string, tenantId: string) {
    return this.repository.getEffect(effectId, tenantId);
  }
  createCompensationAuthorization(
    input: Parameters<InMemoryKernelRepository['createCompensationAuthorization']>[0],
  ) {
    return this.repository.createCompensationAuthorization(input);
  }
  getCompensationAuthorization(authorizationId: string, tenantId: string) {
    return this.repository.getCompensationAuthorization(authorizationId, tenantId);
  }
  requestCompensation(input: Parameters<InMemoryKernelRepository['requestCompensation']>[0]) {
    return this.repository.requestCompensation(input);
  }
  getEvidence(runId: string, tenantId: string) {
    return Promise.resolve(this.evidence.get(`${tenantId}\u0000${runId}`) ?? null);
  }
  async requestReconcile(
    effectId: string,
    tenantId: string,
    actor: string,
  ): Promise<ActionReconcileRequestResult> {
    const current = await this.repository.getEffect(effectId, tenantId);
    if (!current) return { scheduled: false, reason: 'NOT_FOUND' };
    if (current.state !== 'COMPLETION_UNKNOWN' || !current.reconcilePolicy) {
      return { scheduled: false, reason: 'NOT_UNKNOWN' };
    }
    if (current.reconcileEscalatedAt) return { scheduled: false, reason: 'ESCALATED' };
    if (Date.parse(current.reconcilePolicy.deadlineAt) <= Date.now()) {
      return { scheduled: false, reason: 'DEADLINE_EXPIRED' };
    }
    const alreadyScheduled = Date.parse(current.reconcileAfter ?? '') <= Date.now();
    const expedited = await this.repository.requestReconcile({ effectId, tenantId, actor });
    if (!expedited?.reconcileAfter) return { scheduled: false, reason: 'NOT_UNKNOWN' };
    return {
      scheduled: true,
      effectId: expedited.id,
      state: 'COMPLETION_UNKNOWN',
      reconcileAfter: expedited.reconcileAfter,
      alreadyScheduled,
    };
  }
  pauseRun(runId: string, tenantId: string, actor: string) {
    return this.repository.pauseRun(runId, tenantId, actor);
  }
  resumeRun(runId: string, tenantId: string, actor: string) {
    return this.repository.resumeRun(runId, tenantId, actor);
  }
  cancelRun(runId: string, tenantId: string, actor: string) {
    return this.repository.cancelRun(runId, tenantId, actor);
  }
  putKillSwitch(input: Parameters<InMemoryKernelRepository['putKillSwitch']>[0]) {
    return this.repository.putKillSwitch(input);
  }
  removeKillSwitch(input: Parameters<InMemoryKernelRepository['removeKillSwitch']>[0]) {
    return this.repository.removeKillSwitch(input);
  }
  listKillSwitches(tenantId: string) {
    return this.repository.listKillSwitches(tenantId);
  }
  findMatchingKillSwitch(
    tenantId: string,
    dims: Parameters<InMemoryKernelRepository['findMatchingKillSwitch']>[1],
  ) {
    if (this.killSwitchLookupError) throw this.killSwitchLookupError;
    return this.repository.findMatchingKillSwitch(tenantId, dims);
  }
}

const baseAction = {
  source: 'test-agent',
  package: 'test-package',
  model: 'test-model',
  tool: 'ticket.create',
  destination: 'demo://tickets',
  effectType: 'demo.ticket.create',
  args: { title: 'Reset a demo password' },
  idempotencyKey: 'action-key-0001',
};

async function withGateway(
  gateway: InMemoryGateway,
  action: (baseUrl: string) => Promise<void>,
  evidenceJwks?: { keys: readonly unknown[] },
): Promise<void> {
  const previousEvidenceJwks = process.env.COMMANDER_EVIDENCE_JWKS_JSON;
  if (evidenceJwks) process.env.COMMANDER_EVIDENCE_JWKS_JSON = JSON.stringify(evidenceJwks);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (req.header('x-test-no-tenant') !== '1') {
      req.tenantId = req.header('x-test-tenant') ?? 'tenant-a';
    }
    const principal = req.header('x-test-principal') ?? 'api-approver';
    if (principal === 'api-approver') {
      req.apiKeyId = 'test-key';
      req.apiScopes = ['actions:approve'];
    } else if (principal === 'api-reconcile') {
      req.apiKeyId = 'reconcile-key';
      req.apiScopes = ['actions:reconcile'];
    } else if (principal === 'api-read') {
      req.apiKeyId = 'read-key';
      req.apiScopes = ['read'];
    } else if (principal === 'api-admin') {
      req.apiKeyId = 'admin-key';
      req.apiScopes = ['admin'];
    } else if (principal === 'user-admin' || principal === 'user-operator') {
      req.user = {
        id: principal,
        username: principal,
        role: principal === 'user-admin' ? 'admin' : 'operator',
        tenantId: req.tenantId,
      };
    }
    next();
  });
  app.use(
    '/v1',
    createV1GatewayRouter(() => gateway),
  );
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
    if (previousEvidenceJwks === undefined) delete process.env.COMMANDER_EVIDENCE_JWKS_JSON;
    else process.env.COMMANDER_EVIDENCE_JWKS_JSON = previousEvidenceJwks;
  }
}

async function withEvidenceJwks(jwks: unknown, action: () => Promise<void>): Promise<void> {
  const previous = process.env.COMMANDER_EVIDENCE_JWKS_JSON;
  process.env.COMMANDER_EVIDENCE_JWKS_JSON = JSON.stringify(jwks);
  try {
    await action();
  } finally {
    if (previous === undefined) delete process.env.COMMANDER_EVIDENCE_JWKS_JSON;
    else process.env.COMMANDER_EVIDENCE_JWKS_JSON = previous;
  }
}

async function postJson(
  baseUrl: string,
  path: string,
  body: unknown,
  tenant = 'tenant-a',
  principal = 'api-approver',
) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-test-tenant': tenant,
      'x-test-principal': principal,
    },
    body: JSON.stringify(body),
  });
}

function approvalBinding(action: any) {
  return {
    actionDigest: action.simulation.actionDigest,
    simulationId: action.simulation.simulationId,
    policySnapshotId: action.simulation.policySnapshotId,
  };
}

async function putKillSwitch(
  baseUrl: string,
  scope: KillSwitchScope,
  value: string,
  body: { enabled: boolean; reason?: string },
  tenant = 'tenant-a',
  principal = 'api-admin',
) {
  return fetch(`${baseUrl}/v1/actions/kill-switches/${scope}/${encodeURIComponent(value)}`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      'x-test-tenant': tenant,
      'x-test-principal': principal,
    },
    body: JSON.stringify(body),
  });
}

describe('L4-04 kill switch matrix', () => {
  const scopes: Array<{ scope: KillSwitchScope; value: string }> = [
    { scope: 'tenant', value: 'tenant-a' },
    { scope: 'package', value: 'test-package' },
    { scope: 'model', value: 'test-model' },
    { scope: 'tool', value: 'ticket.create' },
    { scope: 'destination', value: 'demo://tickets' },
    { scope: 'effect-type', value: 'demo.ticket.create' },
  ];

  for (const entry of scopes) {
    it(`blocks simulation when ${entry.scope} kill switch is active`, async () => {
      const gateway = new InMemoryGateway();
      await withGateway(gateway, async (baseUrl) => {
        const enabled = await putKillSwitch(baseUrl, entry.scope, entry.value, {
          enabled: true,
          reason: `block ${entry.scope}`,
        });
        assert.equal(enabled.status, 200);
        const response = await postJson(baseUrl, '/v1/actions/simulate', baseAction);
        assert.equal(response.status, 403);
        const payload = (await response.json()) as any;
        assert.equal(payload.error.code, 'KILL_SWITCH_ACTIVE');
        assert.deepEqual(payload.error.details, {
          scope: entry.scope,
          value: entry.value,
        });
      });
    });
  }

  it('lists, updates, and deletes kill switches for the authenticated tenant', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const denied = await fetch(`${baseUrl}/v1/actions/kill-switches`, {
        headers: { 'x-test-tenant': 'tenant-a', 'x-test-principal': 'api-read' },
      });
      assert.equal(denied.status, 403);

      const created = await putKillSwitch(baseUrl, 'tool', 'ticket.create', {
        enabled: true,
        reason: 'maintenance',
      });
      assert.equal(created.status, 200);

      const listed = await fetch(`${baseUrl}/v1/actions/kill-switches`, {
        headers: { 'x-test-tenant': 'tenant-a', 'x-test-principal': 'api-admin' },
      });
      assert.equal(listed.status, 200);
      const listPayload = (await listed.json()) as any;
      assert.equal(listPayload.killSwitches.length, 1);
      assert.equal(listPayload.killSwitches[0].scope, 'tool');

      const removed = await fetch(
        `${baseUrl}/v1/actions/kill-switches/tool/${encodeURIComponent('ticket.create')}`,
        {
          method: 'DELETE',
          headers: { 'x-test-tenant': 'tenant-a', 'x-test-principal': 'api-admin' },
        },
      );
      assert.equal(removed.status, 204);
      const after = await fetch(`${baseUrl}/v1/actions/kill-switches`, {
        headers: { 'x-test-tenant': 'tenant-a', 'x-test-principal': 'api-admin' },
      });
      assert.equal(((await after.json()) as any).killSwitches.length, 0);
    });
  });

  it('blocks propose and worker execution when kill switch is enabled after approval', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const proposed = await postJson(baseUrl, '/v1/actions', {
        ...baseAction,
        destination: 'demo://tickets/approval',
        idempotencyKey: 'action-kill-after-approval',
      });
      assert.equal(proposed.status, 202);
      const payload = (await proposed.json()) as any;
      const approved = await postJson(
        baseUrl,
        `/v1/actions/${payload.action.runId}/approve`,
        approvalBinding(payload.action),
      );
      assert.equal(approved.status, 200);

      const enabled = await putKillSwitch(baseUrl, 'tool', 'ticket.create', { enabled: true });
      assert.equal(enabled.status, 200);

      const blocked = await postJson(baseUrl, '/v1/actions/simulate', {
        ...baseAction,
        idempotencyKey: 'action-kill-after-approval-sim',
      });
      assert.equal(blocked.status, 403);
      assert.equal(((await blocked.json()) as any).error.code, 'KILL_SWITCH_ACTIVE');

      const { createWorkerPolicyEvaluator } =
        await import('../../../packages/worker-plane/src/bootstrap.js');
      const action = payload.action;
      const decision = await createWorkerPolicyEvaluator(gateway.repository).evaluate({
        tenantId: 'tenant-a',
        runId: action.runId,
        stepId: action.stepId,
        type: 'demo.ticket.create',
        request: {
          ...baseAction,
          tenantId: 'tenant-a',
        },
        token: {} as never,
      });
      assert.equal(decision.effect, 'deny');
      assert.equal(decision.reason, 'KILL_SWITCH_ACTIVE');
    });
  });
});

describe('Action Gateway shared policy parity', () => {
  it('returns the shared policy decision from the public simulation endpoint', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const action = {
        ...baseAction,
        destination: 'demo://tickets/approval',
        idempotencyKey: 'action-shared-policy-parity',
      };
      const response = await postJson(baseUrl, '/v1/actions/simulate', action);
      assert.equal(response.status, 200);
      const simulation = ((await response.json()) as { simulation: Record<string, unknown> })
        .simulation;
      const shared = evaluateActionGatewayPolicy(action);
      assert.deepEqual(
        {
          effect: simulation.effect,
          decisionId: simulation.decisionId,
          reason: simulation.reason,
          policySnapshotId: simulation.policySnapshotId,
        },
        {
          effect: shared.effect,
          decisionId: shared.decisionId,
          reason: shared.reason,
          policySnapshotId: shared.policySnapshotId,
        },
      );
    });
  });
});

describe('L4-01 governed action HTTP API', () => {
  it('projects every internal lifecycle state onto the canonical action enum', () => {
    type ProjectionInput = Parameters<typeof projectCanonicalActionState>[0];
    const baseline: ProjectionInput = {
      decisionEffect: 'allow',
      runState: 'PENDING',
    };
    const cases: Array<{
      name: string;
      input: ProjectionInput;
      expected: ActionStateV1;
    }> = [
      { name: 'policy deny', input: { ...baseline, decisionEffect: 'deny' }, expected: 'FAILED' },
      {
        name: 'approval pending',
        input: { ...baseline, decisionEffect: 'require_approval' },
        expected: 'AWAITING_APPROVAL',
      },
      {
        name: 'approval rejected',
        input: { ...baseline, decisionEffect: 'require_approval', approval: false },
        expected: 'FAILED',
      },
      {
        name: 'approval admitted',
        input: {
          ...baseline,
          decisionEffect: 'require_approval',
          approval: true,
          stepState: 'RETRY_WAIT',
        },
        expected: 'ADMITTED',
      },
      { name: 'run pending', input: baseline, expected: 'ADMITTED' },
      {
        name: 'run running',
        input: { ...baseline, runState: 'RUNNING' },
        expected: 'RUNNING',
      },
      {
        name: 'run paused',
        input: { ...baseline, runState: 'PAUSED' },
        expected: 'ADMITTED',
      },
      {
        name: 'run succeeded',
        input: { ...baseline, runState: 'SUCCEEDED' },
        expected: 'SUCCEEDED',
      },
      { name: 'run failed', input: { ...baseline, runState: 'FAILED' }, expected: 'FAILED' },
      {
        name: 'run cancelled',
        input: { ...baseline, runState: 'CANCELLED' },
        expected: 'FAILED',
      },
      {
        name: 'run compensating',
        input: { ...baseline, runState: 'COMPENSATING' },
        expected: 'RUNNING',
      },
      {
        name: 'run compensated',
        input: { ...baseline, runState: 'COMPENSATED' },
        expected: 'SUCCEEDED',
      },
      {
        name: 'step pending',
        input: { ...baseline, stepState: 'PENDING' },
        expected: 'ADMITTED',
      },
      {
        name: 'step running',
        input: { ...baseline, stepState: 'RUNNING' },
        expected: 'RUNNING',
      },
      {
        name: 'step waiting for human',
        input: { ...baseline, stepState: 'WAITING_FOR_HUMAN' },
        expected: 'ADMITTED',
      },
      {
        name: 'step waiting for reconciliation',
        input: { ...baseline, stepState: 'WAITING_FOR_RECONCILIATION' },
        expected: 'COMPLETION_UNKNOWN',
      },
      {
        name: 'step retry wait',
        input: { ...baseline, stepState: 'RETRY_WAIT' },
        expected: 'ADMITTED',
      },
      {
        name: 'step succeeded',
        input: { ...baseline, stepState: 'SUCCEEDED' },
        expected: 'SUCCEEDED',
      },
      {
        name: 'step failed',
        input: { ...baseline, stepState: 'FAILED' },
        expected: 'FAILED',
      },
      {
        name: 'step cancelled',
        input: { ...baseline, stepState: 'CANCELLED' },
        expected: 'FAILED',
      },
      {
        name: 'step skipped',
        input: { ...baseline, stepState: 'SKIPPED' },
        expected: 'FAILED',
      },
      {
        name: 'effect admitted',
        input: { ...baseline, effectState: 'ADMITTED' },
        expected: 'ADMITTED',
      },
      {
        name: 'effect completion unknown',
        input: { ...baseline, effectState: 'COMPLETION_UNKNOWN' },
        expected: 'COMPLETION_UNKNOWN',
      },
      {
        name: 'effect confirmed not applied',
        input: { ...baseline, effectState: 'CONFIRMED_NOT_APPLIED' },
        expected: 'FAILED',
      },
      {
        name: 'effect completed',
        input: { ...baseline, effectState: 'COMPLETED' },
        expected: 'SUCCEEDED',
      },
      {
        name: 'effect failed',
        input: { ...baseline, effectState: 'FAILED' },
        expected: 'FAILED',
      },
      {
        name: 'effect escalation timestamp',
        input: { ...baseline, effectState: 'COMPLETION_UNKNOWN', reconcileEscalatedAt: 'now' },
        expected: 'ESCALATED',
      },
      {
        name: 'effect escalation disposition',
        input: {
          ...baseline,
          effectState: 'COMPLETION_UNKNOWN',
          reconcileDisposition: 'ESCALATED',
        },
        expected: 'ESCALATED',
      },
    ];

    for (const entry of cases) {
      const actual = projectCanonicalActionState(entry.input);
      assert.equal(actual, entry.expected, entry.name);
      assert.ok(ACTION_STATES_V1.includes(actual), `${entry.name}: ${actual}`);
    }
  });

  it('rejects Class A with 503 before creating any run when operations are not ready', async () => {
    const gateway = new InMemoryGateway();
    gateway.operationsReady = false;
    await withGateway(gateway, async (baseUrl) => {
      const response = await postJson(baseUrl, '/v1/actions', {
        ...baseAction,
        idempotencyKey: 'operations-not-ready',
      });
      assert.equal(response.status, 503);
      assert.equal(((await response.json()) as any).error.code, 'OPERATIONS_NOT_READY');
      assert.deepEqual(await gateway.repository.listRuns('tenant-a'), []);
    });
  });

  it('rejects Class A with 503 when the evidence repository is unavailable', async () => {
    const gateway = new InMemoryGateway();
    gateway.evidenceReady = false;
    await withGateway(gateway, async (baseUrl) => {
      const response = await postJson(baseUrl, '/v1/actions', {
        ...baseAction,
        idempotencyKey: 'evidence-not-ready',
      });
      const payload = (await response.json()) as {
        error: {
          code: string;
          details?: { evidenceRepository?: { ready: boolean } };
        };
      };
      assert.equal(response.status, 503);
      assert.equal(payload.error.code, 'OPERATIONS_NOT_READY');
      assert.deepEqual(payload.error.details.evidenceRepository, { ready: false });
      assert.deepEqual(await gateway.repository.listRuns('tenant-a'), []);
    });
  });

  it('admits Class A when operations and the evidence repository are ready', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const response = await postJson(baseUrl, '/v1/actions', {
        ...baseAction,
        idempotencyKey: 'evidence-ready',
      });
      assert.equal(response.status, 202);
    });
  });
  it('requires an authenticated principal on every action endpoint', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const cases = [
        { method: 'POST', path: '/v1/actions/simulate', body: baseAction },
        { method: 'POST', path: '/v1/actions', body: baseAction },
        { method: 'GET', path: '/v1/actions/run-unknown' },
        { method: 'POST', path: '/v1/actions/run-unknown/approve', body: {} },
        { method: 'POST', path: '/v1/actions/run-unknown/reject', body: {} },
        { method: 'POST', path: '/v1/actions/run-unknown/reconcile', body: {} },
        { method: 'GET', path: '/v1/actions/run-unknown/evidence' },
      ] as const;
      for (const request of cases) {
        const response = await fetch(`${baseUrl}${request.path}`, {
          method: request.method,
          headers: {
            'content-type': 'application/json',
            'x-test-tenant': 'tenant-a',
            'x-test-principal': 'none',
          },
          body: request.body === undefined ? undefined : JSON.stringify(request.body),
        });
        assert.equal(response.status, 401, `${request.method} ${request.path}`);
        assert.equal(((await response.json()) as any).error.code, 'AUTHENTICATION_REQUIRED');
      }
    });
  });

  it('queues a tenant-bound unknown effect for the adapter reconciler without completing it in the API', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const created = await postJson(baseUrl, '/v1/actions', {
        ...baseAction,
        idempotencyKey: 'action-reconcile-queue-0001',
      });
      assert.equal(created.status, 202);
      const action = ((await created.json()) as { action: { runId: string } }).action;

      const noUnknown = await postJson(baseUrl, `/v1/actions/${action.runId}/reconcile`, {});
      assert.equal(noUnknown.status, 409);
      assert.equal(
        ((await noUnknown.json()) as { error: { code: string } }).error.code,
        'NO_RECONCILABLE_EFFECT',
      );

      const claimed = await gateway.repository.claimNextStep({
        workerId: 'gateway-reconcile-worker',
        tenantId: 'tenant-a',
        leaseTtlMs: 60_000,
      });
      assert.ok(claimed?.lease);
      const run = await gateway.repository.getRun(action.runId, 'tenant-a');
      assert.ok(run);
      const metadata = run.metadata.actionGateway as {
        effectId: string;
        actionDigest: string;
        policySnapshotId: string;
        envelope: Record<string, unknown>;
      };
      const unrelatedEffectId = 'effect-unrelated-completion-unknown';
      await gateway.repository.admitEffect({
        id: unrelatedEffectId,
        runId: action.runId,
        stepId: claimed.id,
        tenantId: 'tenant-a',
        type: 'demo.ticket.create',
        idempotencyKey: 'action-reconcile-unrelated-0001',
        policyDecisionId: 'action-gateway-allow',
        policySnapshotId: metadata.policySnapshotId,
        actionDigest: metadata.actionDigest,
        request: metadata.envelope,
        lease: claimed.lease,
        actor: 'gateway-reconcile-worker',
      });
      await gateway.repository.markEffectCompletionUnknown({
        effectId: unrelatedEffectId,
        tenantId: 'tenant-a',
        reason: 'unrelated remote outcome uncertain',
        actor: 'gateway-reconcile-worker',
      });
      const admitted = await gateway.repository.admitEffect({
        id: metadata.effectId,
        runId: action.runId,
        stepId: claimed.id,
        tenantId: 'tenant-a',
        type: 'demo.ticket.create',
        idempotencyKey: 'action-reconcile-queue-0001',
        policyDecisionId: 'action-gateway-allow',
        policySnapshotId: metadata.policySnapshotId,
        actionDigest: metadata.actionDigest,
        request: metadata.envelope,
        lease: claimed.lease,
        actor: 'gateway-reconcile-worker',
      });
      assert.equal(admitted.admitted, true);
      await gateway.repository.markEffectCompletionUnknown({
        effectId: metadata.effectId,
        tenantId: 'tenant-a',
        reason: 'remote outcome uncertain',
        actor: 'gateway-reconcile-worker',
      });
      const reconcileAfterBeforeCrossTenantRequest = (
        await gateway.repository.getEffect(metadata.effectId, 'tenant-a')
      )?.reconcileAfter;

      const crossTenant = await postJson(
        baseUrl,
        `/v1/actions/${action.runId}/reconcile`,
        {},
        'tenant-b',
      );
      assert.equal(crossTenant.status, 404);
      assert.equal(
        ((await crossTenant.json()) as { error: { code: string } }).error.code,
        'ACTION_NOT_FOUND',
      );
      assert.equal(
        (await gateway.repository.getEffect(metadata.effectId, 'tenant-a'))?.reconcileAfter,
        reconcileAfterBeforeCrossTenantRequest,
      );

      const queued = await postJson(baseUrl, `/v1/actions/${action.runId}/reconcile`, {});
      assert.equal(queued.status, 202);
      assert.deepEqual(await queued.json(), {
        effectId: metadata.effectId,
        state: 'RECONCILE_QUEUED',
      });
      assert.ok(
        (await gateway.repository.getEffect(metadata.effectId, 'tenant-a'))?.reconcileAfter,
      );
      assert.deepEqual(
        (await gateway.repository.listEvents(action.runId, 'tenant-a'))
          .filter((event) => event.type === 'effect.reconcile_requested')
          .map((event) => ({
            aggregateId: event.aggregateId,
            actor: event.actor,
            stepId: event.stepId,
          })),
        [{ aggregateId: metadata.effectId, actor: 'test-key', stepId: claimed.id }],
      );

      const adapter = {
        descriptor: {
          ...GITHUB_PULL_REQUEST_CREATE_DESCRIPTOR,
          effectType: 'demo.ticket.create',
        },
        async execute() {
          throw new Error('reconciliation must not execute writes');
        },
        async queryOutcome() {
          return { status: 'COMPLETED' as const, response: { ticketId: 'ticket-reconciled' } };
        },
        async compensate() {
          throw new Error('not used');
        },
        async queryCompensationOutcome() {
          return { status: 'UNKNOWN' as const };
        },
      };
      const daemon = new ReconciliationDaemon({
        repository: gateway.repository,
        registry: new ActionAdapterRegistry([adapter]),
        actor: 'reconciliation-daemon',
        pollIntervalMs: 60_000,
        batchSize: 2,
        brokerFactory: () =>
          new EffectBroker(
            { verify: async () => ({}) },
            {
              evaluate: async () => ({
                effect: 'allow' as const,
                decisionId: 'unused',
                policySnapshotId: 'unused',
              }),
            },
            {
              getEffect: (effectId, tenantId) => gateway.repository.getEffect(effectId, tenantId),
              reconcileEffect: (input) => gateway.repository.reconcileEffect(input),
            },
            {
              execute: async () => {
                throw new Error('reconciliation must not execute writes');
              },
            },
            { append: async () => {} },
            { requireRequestBinding: false },
          ),
      });
      const stats = await daemon.tick();
      assert.deepEqual(stats, { claimed: 2, completed: 2, escalated: 0, rescheduled: 0 });
      assert.equal(
        (await gateway.repository.getEffect(metadata.effectId, 'tenant-a'))?.state,
        'COMPLETED',
      );
    });
  });

  it('fails closed when durable reconciliation scheduling is unavailable', async () => {
    const gateway = new InMemoryGateway();
    gateway.reconcileError = new Error('reconciliation scheduler unavailable');
    await withGateway(gateway, async (baseUrl) => {
      const created = await postJson(baseUrl, '/v1/actions', {
        ...baseAction,
        idempotencyKey: 'action-reconcile-unavailable-0001',
      });
      const action = ((await created.json()) as { action: { runId: string } }).action;
      const claimed = await gateway.repository.claimNextStep({
        workerId: 'gateway-reconcile-worker',
        tenantId: 'tenant-a',
        leaseTtlMs: 60_000,
      });
      assert.ok(claimed?.lease);
      const run = await gateway.repository.getRun(action.runId, 'tenant-a');
      assert.ok(run);
      const metadata = run.metadata.actionGateway as {
        effectId: string;
        actionDigest: string;
        policySnapshotId: string;
        envelope: Record<string, unknown>;
      };
      await gateway.repository.admitEffect({
        id: metadata.effectId,
        runId: action.runId,
        stepId: claimed.id,
        tenantId: 'tenant-a',
        type: 'demo.ticket.create',
        idempotencyKey: 'action-reconcile-unavailable-0001',
        policyDecisionId: 'action-gateway-allow',
        policySnapshotId: metadata.policySnapshotId,
        actionDigest: metadata.actionDigest,
        request: metadata.envelope,
        lease: claimed.lease,
        actor: 'gateway-reconcile-worker',
      });
      await gateway.repository.markEffectCompletionUnknown({
        effectId: metadata.effectId,
        tenantId: 'tenant-a',
        reason: 'remote outcome uncertain',
        actor: 'gateway-reconcile-worker',
      });
      const reconcileAfterBeforeUnavailableRequest = (
        await gateway.repository.getEffect(metadata.effectId, 'tenant-a')
      )?.reconcileAfter;

      const response = await postJson(baseUrl, `/v1/actions/${action.runId}/reconcile`, {});
      assert.equal(response.status, 503);
      assert.equal(
        ((await response.json()) as { error: { code: string } }).error.code,
        'RECONCILER_UNAVAILABLE',
      );
      assert.equal(
        (await gateway.repository.getEffect(metadata.effectId, 'tenant-a'))?.reconcileAfter,
        reconcileAfterBeforeUnavailableRequest,
      );
    });
  });

  it('does not accept authentication without req.tenantId', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/actions/simulate`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-test-principal': 'api-approver',
          'x-test-no-tenant': '1',
        },
        body: JSON.stringify(baseAction),
      });
      assert.equal(response.status, 401);
      assert.equal(((await response.json()) as any).error.code, 'TENANT_IDENTITY_REQUIRED');
    });
  });

  it('authorizes reconciliation before any action or effect lookup', async () => {
    const gateway = new InMemoryGateway();
    let getRunCalls = 0;
    let requestReconcileCalls = 0;
    const getRun = gateway.getRun.bind(gateway);
    gateway.getRun = async (...args) => {
      getRunCalls += 1;
      return getRun(...args);
    };
    gateway.requestReconcile = async () => {
      requestReconcileCalls += 1;
      return { scheduled: false, reason: 'NOT_FOUND' };
    };

    await withGateway(gateway, async (baseUrl) => {
      for (const principal of ['api-read', 'api-approver', 'user-operator']) {
        const response = await postJson(
          baseUrl,
          '/v1/actions/not-visible/reconcile',
          {},
          'tenant-a',
          principal,
        );
        assert.equal(response.status, 403, principal);
        assert.equal(((await response.json()) as any).error.code, 'ACTION_RECONCILE_FORBIDDEN');
      }
      assert.equal(getRunCalls, 0);
      assert.equal(requestReconcileCalls, 0);
    });
  });

  it('returns 202 for both a new expedite and its idempotent replay using only owner calls', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const proposed = await postJson(baseUrl, '/v1/actions', {
        ...baseAction,
        idempotencyKey: 'action-reconcile-idempotent',
      });
      const action = ((await proposed.json()) as any).action;
      const reconcileAfter = '2026-07-29T10:00:00.000Z';
      const results = [
        {
          scheduled: true,
          effectId: action.effectId,
          state: 'COMPLETION_UNKNOWN',
          reconcileAfter,
          alreadyScheduled: false,
        },
        {
          scheduled: true,
          effectId: action.effectId,
          state: 'COMPLETION_UNKNOWN',
          reconcileAfter,
          alreadyScheduled: true,
        },
      ] as const;
      const calls: Array<{ effectId: string; tenantId: string; actor: string }> = [];
      gateway.requestReconcile = async (effectId, tenantId, actor) => {
        calls.push({ effectId, tenantId, actor });
        const result = results[calls.length - 1];
        assert.ok(result);
        return result;
      };
      gateway.listEffects = async () => {
        assert.fail('the API expedite path must not inspect effects or invoke an adapter query');
      };
      gateway.getEffect = async () => {
        assert.fail('the API expedite path must not read the effect directly');
      };

      for (const [index, expected] of results.entries()) {
        const response = await postJson(
          baseUrl,
          `/v1/actions/${action.runId}/reconcile`,
          {},
          'tenant-a',
          index === 0 ? 'api-reconcile' : 'user-admin',
        );
        assert.equal(response.status, 202);
        assert.deepEqual(await response.json(), expected);
      }
      assert.deepEqual(calls, [
        { effectId: action.effectId, tenantId: 'tenant-a', actor: 'reconcile-key' },
        { effectId: action.effectId, tenantId: 'tenant-a', actor: 'user-admin' },
      ]);
    });
  });

  it('maps owner reconciliation dispositions without calling an in-process adapter', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const proposed = await postJson(baseUrl, '/v1/actions', {
        ...baseAction,
        idempotencyKey: 'action-reconcile-mappings',
      });
      const action = ((await proposed.json()) as any).action;
      const cases = [
        { reason: 'NOT_FOUND', status: 404, code: 'ACTION_NOT_FOUND' },
        { reason: 'NOT_UNKNOWN', status: 409, code: 'NO_RECONCILABLE_EFFECT' },
        { reason: 'ESCALATED', status: 409, code: 'RECONCILIATION_ESCALATED' },
        { reason: 'DEADLINE_EXPIRED', status: 410, code: 'RECONCILIATION_DEADLINE_EXPIRED' },
      ] as const;
      let resultIndex = 0;
      gateway.requestReconcile = async () => {
        const result = cases[resultIndex++];
        assert.ok(result);
        return { scheduled: false, reason: result.reason };
      };
      gateway.listEffects = async () => {
        assert.fail('the owner result is the only reconciliation state authority');
      };
      gateway.getEffect = async () => {
        assert.fail('the API must not query effects or adapters after loading the action binding');
      };

      for (const expected of cases) {
        const response = await postJson(
          baseUrl,
          `/v1/actions/${action.runId}/reconcile`,
          {},
          'tenant-a',
          'api-reconcile',
        );
        assert.equal(response.status, expected.status, expected.reason);
        assert.equal(((await response.json()) as any).error.code, expected.code);
      }
    });
  });

  it('conceals a cross-tenant reconciliation target before requesting an expedite', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const proposed = await postJson(baseUrl, '/v1/actions', {
        ...baseAction,
        idempotencyKey: 'action-reconcile-cross-tenant',
      });
      const action = ((await proposed.json()) as any).action;
      let requestReconcileCalls = 0;
      gateway.requestReconcile = async () => {
        requestReconcileCalls += 1;
        return { scheduled: false, reason: 'NOT_FOUND' };
      };

      const response = await postJson(
        baseUrl,
        `/v1/actions/${action.runId}/reconcile`,
        {},
        'tenant-b',
        'api-reconcile',
      );
      assert.equal(response.status, 404);
      assert.equal(((await response.json()) as any).error.code, 'ACTION_NOT_FOUND');
      assert.equal(requestReconcileCalls, 0);
    });
  });

  it('limits approve and reject to admin users or approval-scoped API keys', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const first = await postJson(baseUrl, '/v1/actions', {
        ...baseAction,
        destination: 'demo://tickets/approval',
        idempotencyKey: 'action-auth-approve',
      });
      const firstAction = ((await first.json()) as any).action;
      const firstRunId = firstAction.runId;

      for (const principal of ['api-read', 'user-operator']) {
        const forbidden = await postJson(
          baseUrl,
          `/v1/actions/${firstRunId}/approve`,
          {},
          'tenant-a',
          principal,
        );
        assert.equal(forbidden.status, 403, principal);
        assert.equal(((await forbidden.json()) as any).error.code, 'ACTION_APPROVAL_FORBIDDEN');
      }
      const unauthenticated = await postJson(
        baseUrl,
        `/v1/actions/${firstRunId}/approve`,
        {},
        'tenant-a',
        'none',
      );
      assert.equal(unauthenticated.status, 401);

      const approved = await postJson(
        baseUrl,
        `/v1/actions/${firstRunId}/approve`,
        approvalBinding(firstAction),
        'tenant-a',
        'api-approver',
      );
      assert.equal(approved.status, 200);

      const second = await postJson(baseUrl, '/v1/actions', {
        ...baseAction,
        destination: 'demo://tickets/approval',
        idempotencyKey: 'action-auth-reject',
      });
      const secondRunId = ((await second.json()) as any).action.runId;
      const rejected = await postJson(
        baseUrl,
        `/v1/actions/${secondRunId}/reject`,
        { reason: 'admin rejection' },
        'tenant-a',
        'user-admin',
      );
      assert.equal(rejected.status, 200);
    });
  });

  it('refuses a rejection that records no reason', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const proposed = await postJson(baseUrl, '/v1/actions', {
        ...baseAction,
        destination: 'demo://tickets/approval',
        idempotencyKey: 'action-reject-reason-required',
      });
      assert.equal(proposed.status, 202);
      const runId = ((await proposed.json()) as { action: { runId: string } }).action.runId;
      assert.ok(runId, 'a proposal must yield a run id');

      // The published contract (`actionRejectionRequestSchema` in
      // packages/contracts/src/schemas.ts) requires `reason`: a rejection is an
      // operator decision recorded for audit, and a reason-less rejection
      // carries no accountability. The API schema must not accept less than the
      // contract promises.
      const missing = await postJson(
        baseUrl,
        `/v1/actions/${runId}/reject`,
        {},
        'tenant-a',
        'user-admin',
      );
      assert.equal(missing.status, 400);

      const blank = await postJson(
        baseUrl,
        `/v1/actions/${runId}/reject`,
        { reason: '' },
        'tenant-a',
        'user-admin',
      );
      assert.equal(blank.status, 400);

      const accepted = await postJson(
        baseUrl,
        `/v1/actions/${runId}/reject`,
        { reason: 'policy mismatch' },
        'tenant-a',
        'user-admin',
      );
      assert.equal(accepted.status, 200);
    });
  });

  it('simulates and durably proposes one allowed action as one tool step', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const simulated = await postJson(baseUrl, '/v1/actions/simulate', baseAction);
      assert.equal(simulated.status, 200);
      const simulation = ((await simulated.json()) as any).simulation;
      assert.deepEqual(Object.keys(simulation).sort(), [
        'actionDigest',
        'decisionId',
        'effect',
        'policySnapshotId',
        'reason',
        'simulationId',
      ]);
      assert.equal(simulation.effect, 'allow');
      const simulationRun = await gateway.repository.getRun(simulation.simulationId, 'tenant-a');
      assert.ok(simulationRun);
      assert.equal(simulationRun.state, 'CANCELLED');
      assert.ok(simulationRun.terminalAt);
      assert.deepEqual(simulationRun.metadata.actionGatewaySimulation, simulation);
      assert.equal(
        (await gateway.repository.listEffectsForRun(simulation.simulationId, 'tenant-a')).length,
        0,
      );
      assert.equal(
        (await gateway.repository.listEvents(simulation.simulationId, 'tenant-a')).some(
          (event) => event.type === 'run.created',
        ),
        true,
      );
      assert.equal(
        (await gateway.repository.listEvents(simulation.simulationId, 'tenant-a')).some(
          (event) => event.type === 'run.cancelled',
        ),
        true,
      );

      const proposed = await postJson(baseUrl, '/v1/actions', baseAction);
      assert.equal(proposed.status, 202);
      const payload = (await proposed.json()) as any;
      assert.equal(payload.action.decision.effect, 'allow');
      assert.equal(payload.action.state, 'ADMITTED');
      assert.deepEqual(Object.keys(payload.action.decision).sort(), [
        'decisionId',
        'effect',
        'policySnapshotId',
        'reason',
      ]);

      const run = await gateway.repository.getRun(payload.action.runId, 'tenant-a');
      assert.ok(run);
      const actionMetadata = run.metadata.actionGateway as any;
      assert.equal(actionMetadata.authority, 'commander.action-gateway/v1');
      assert.deepEqual(actionMetadata.simulation, simulation);
      const step = await gateway.repository.getStep(actionMetadata.stepId, 'tenant-a');
      assert.equal(step?.kind, 'tool');
      assert.equal(step?.input.effectType, 'demo.ticket.create');
    });
  });

  it('persists a denied proposal but never represents it as admitted', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const denied = await postJson(baseUrl, '/v1/actions', {
        ...baseAction,
        destination: 'https://untrusted.example/tickets',
        idempotencyKey: 'action-key-denied',
      });
      assert.equal(denied.status, 403);
      const payload = (await denied.json()) as any;
      assert.equal(payload.action.decision.effect, 'deny');
      assert.equal(payload.action.state, 'FAILED');
      const claimed = await gateway.repository.claimNextStep({
        workerId: 'deny-worker',
        workerGeneration: 1,
        tenantId: 'tenant-a',
        capabilities: ['tool'],
        leaseTtlMs: 30_000,
      });
      assert.equal(claimed, null, 'no claimable PENDING tool step on deny');
    });
  });

  it('admits the registered Kubernetes rollback only behind exact approval', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const proposed = await postJson(baseUrl, '/v1/actions', {
        ...baseAction,
        tool: 'kubernetes.deployment.rollback',
        destination: 'k8s://kind/commander/deployments/api',
        effectType: 'connector.kubernetes.deployment.rollback',
        args: { targetRevision: '7', reason: 'controlled rollback proof' },
        idempotencyKey: 'kubernetes-rollback-approval',
      });

      assert.equal(proposed.status, 202);
      const payload = (await proposed.json()) as any;
      assert.equal(payload.action.decision.effect, 'require_approval');
      assert.equal(payload.action.state, 'AWAITING_APPROVAL');
      const step = await gateway.repository.getStep(payload.action.stepId, 'tenant-a');
      assert.equal(step?.input.effectType, 'connector.kubernetes.deployment.rollback');
    });
  });

  it('proposes demo ticket compensation through the same Action Gateway authority', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const proposed = await postJson(baseUrl, '/v1/actions', {
        ...baseAction,
        tool: 'ticket.compensate',
        effectType: 'compensate.demo.ticket.create',
        args: { targetIdempotencyKey: 'action-key-0001' },
        idempotencyKey: 'action-key-compensate',
      });
      assert.equal(proposed.status, 202);
      const payload = (await proposed.json()) as any;
      assert.equal(payload.action.decision.effect, 'allow');
      const step = await gateway.repository.getStep(payload.action.stepId, 'tenant-a');
      assert.equal(step?.input.effectType, 'compensate.demo.ticket.create');
    });
  });

  it('creates a durable approval interaction and releases only an approval', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const proposed = await postJson(baseUrl, '/v1/actions', {
        ...baseAction,
        destination: 'demo://tickets/approval',
        idempotencyKey: 'action-key-approval',
      });
      assert.equal(proposed.status, 202);
      const payload = (await proposed.json()) as any;
      assert.equal(payload.action.decision.effect, 'require_approval');
      assert.equal(payload.action.state, 'AWAITING_APPROVAL');

      const approved = await postJson(baseUrl, `/v1/actions/${payload.action.runId}/approve`, {
        actionDigest: payload.action.simulation.actionDigest,
        simulationId: payload.action.simulation.simulationId,
        policySnapshotId: payload.action.simulation.policySnapshotId,
      });
      assert.equal(approved.status, 200);
      assert.equal(((await approved.json()) as any).action.state, 'ADMITTED');

      const run = await gateway.repository.getRun(payload.action.runId, 'tenant-a');
      const metadata = run!.metadata.actionGateway as any;
      assert.equal(
        (await gateway.repository.getStep(metadata.stepId, 'tenant-a'))?.state,
        'RETRY_WAIT',
      );
      assert.equal(
        (await gateway.repository.listInteractions(payload.action.runId, 'tenant-a'))[0]?.response
          ?.approved,
        true,
      );
      assert.deepEqual(
        (await gateway.repository.listInteractions(payload.action.runId, 'tenant-a'))[0]?.response,
        {
          approved: true,
          actionDigest: payload.action.simulation.actionDigest,
          simulationId: payload.action.simulation.simulationId,
          policySnapshotId: payload.action.simulation.policySnapshotId,
          reviewer: 'test-key',
          runId: payload.action.runId,
          tenantId: 'tenant-a',
        },
      );
    });
  });

  it('rejects approval when its supplied action digest differs from the persisted simulation', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const actionInput = {
        ...baseAction,
        destination: 'demo://tickets/approval',
        idempotencyKey: 'action-approval-digest-mismatch',
      };
      const simulated = await postJson(baseUrl, '/v1/actions/simulate', actionInput);
      const simulation = ((await simulated.json()) as any).simulation;
      const proposed = await postJson(baseUrl, '/v1/actions', actionInput);
      const action = ((await proposed.json()) as any).action;

      const rejected = await postJson(baseUrl, `/v1/actions/${action.runId}/approve`, {
        actionDigest: '0'.repeat(64),
        simulationId: simulation.simulationId,
        policySnapshotId: simulation.policySnapshotId,
      });
      assert.equal(rejected.status, 409);
      assert.equal(((await rejected.json()) as any).error.code, 'ACTION_DIGEST_MISMATCH');

      const interactions = await gateway.repository.listInteractions(action.runId, 'tenant-a');
      assert.equal(interactions[0]?.status, 'pending');
    });
  });

  it('projects completion-unknown and terminal execution states after approval', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const proposeApproval = async (idempotencyKey: string) => {
        const response = await postJson(baseUrl, '/v1/actions', {
          ...baseAction,
          destination: 'demo://tickets/approval',
          idempotencyKey,
        });
        const action = ((await response.json()) as any).action;
        const approved = await postJson(
          baseUrl,
          `/v1/actions/${action.runId}/approve`,
          approvalBinding(action),
        );
        assert.equal(approved.status, 200);
        const run = await gateway.repository.getRun(action.runId, 'tenant-a');
        return { action, metadata: run!.metadata.actionGateway as any };
      };
      const claim = () =>
        gateway.repository.claimNextStep({
          workerId: 'status-worker',
          workerGeneration: 1,
          tenantId: 'tenant-a',
          capabilities: ['tool'],
          leaseTtlMs: 30_000,
        });

      const unknown = await proposeApproval('action-status-unknown');
      const unknownStep = await claim();
      assert.ok(unknownStep?.lease);
      const unknownEffectRequest = {
        id: unknown.metadata.effectId,
        runId: unknown.action.runId,
        stepId: unknownStep.id,
        tenantId: 'tenant-a',
        type: 'demo.ticket.create',
        idempotencyKey: 'action-status-unknown',
        policyDecisionId: 'action-gateway-allow-after-approval',
        policySnapshotId: unknown.metadata.policySnapshotId,
        actionDigest: unknown.metadata.actionDigest,
        request: unknown.metadata.envelope,
        lease: unknownStep.lease,
        actor: 'status-worker',
      };
      assert.deepEqual(
        await gateway.repository.admitEffect(unknownEffectRequest),
        { admitted: false, reason: 'OPERATIONS_NOT_READY' },
        'the old fixture must not bypass Class A admission readiness',
      );
      seedFreshOperationsDrains(gateway.repository, 'tenant-a');
      assert.equal((await gateway.repository.admitEffect(unknownEffectRequest)).admitted, true);
      await gateway.repository.markEffectCompletionUnknown({
        effectId: unknown.metadata.effectId,
        tenantId: 'tenant-a',
        reason: 'remote completion uncertain',
        actor: 'status-worker',
      });
      const unknownGet = await fetch(`${baseUrl}/v1/actions/${unknown.action.runId}`, {
        headers: { 'x-test-tenant': 'tenant-a' },
      });
      assert.equal(((await unknownGet.json()) as any).action.state, 'COMPLETION_UNKNOWN');

      const terminal = await proposeApproval('action-status-terminal');
      const terminalStep = await claim();
      assert.ok(terminalStep?.lease);
      const terminalEffectRequest = {
        id: terminal.metadata.effectId,
        runId: terminal.action.runId,
        stepId: terminalStep.id,
        tenantId: 'tenant-a',
        type: 'demo.ticket.create',
        idempotencyKey: 'action-status-terminal',
        policyDecisionId: 'action-gateway-allow-after-approval',
        policySnapshotId: terminal.metadata.policySnapshotId,
        actionDigest: terminal.metadata.actionDigest,
        request: terminal.metadata.envelope,
        lease: terminalStep.lease,
        actor: 'status-worker',
      };
      seedFreshOperationsDrains(gateway.repository, 'tenant-a');
      assert.equal((await gateway.repository.admitEffect(terminalEffectRequest)).admitted, true);
      await gateway.repository.completeEffect(
        terminal.metadata.effectId,
        'tenant-a',
        terminalStep.lease,
        { status: 'ok' },
        'status-worker',
      );
      await gateway.repository.completeStep({
        stepId: terminalStep.id,
        tenantId: 'tenant-a',
        lease: terminalStep.lease,
        expectedVersion: terminalStep.version,
        output: { status: 'ok' },
        actor: 'status-worker',
      });
      const terminalGet = await fetch(`${baseUrl}/v1/actions/${terminal.action.runId}`, {
        headers: { 'x-test-tenant': 'tenant-a' },
      });
      const terminalBody = (await terminalGet.json()) as {
        action: { state: string; forwardReceiptHash?: string };
      };
      assert.equal(terminalBody.action.state, 'SUCCEEDED');
      assert.equal(
        terminalBody.action.forwardReceiptHash,
        createHash('sha256').update('{"status":"ok"}').digest('hex'),
        'clients need the durable receipt hash to request compensation without reading the database',
      );
    });
  });

  it('rejects an approval-required action without authorizing its effect', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const proposed = await postJson(baseUrl, '/v1/actions', {
        ...baseAction,
        destination: 'demo://tickets/approval',
        idempotencyKey: 'action-key-reject',
      });
      const payload = (await proposed.json()) as any;
      const rejected = await postJson(baseUrl, `/v1/actions/${payload.action.runId}/reject`, {
        reason: 'not authorized',
      });
      assert.equal(rejected.status, 200);
      assert.equal(((await rejected.json()) as any).action.state, 'FAILED');
      const rejectedStep = await gateway.repository.getStep(payload.action.stepId, 'tenant-a');
      assert.equal(rejectedStep?.state, 'CANCELLED');
      assert.equal(
        (await gateway.repository.getRun(payload.action.runId, 'tenant-a'))?.state,
        'CANCELLED',
      );
    });
  });

  it('scopes get and approval to req.tenantId only', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const proposed = await postJson(baseUrl, '/v1/actions', {
        ...baseAction,
        destination: 'demo://tickets/approval',
        idempotencyKey: 'action-key-tenant',
      });
      const payload = (await proposed.json()) as any;

      const crossTenantGet = await fetch(`${baseUrl}/v1/actions/${payload.action.runId}`, {
        headers: { 'x-test-tenant': 'tenant-b' },
      });
      assert.equal(crossTenantGet.status, 404);
      const crossTenantApprove = await postJson(
        baseUrl,
        `/v1/actions/${payload.action.runId}/approve`,
        approvalBinding(payload.action),
        'tenant-b',
      );
      assert.equal(crossTenantApprove.status, 404);
    });
  });

  it('replays one idempotency key without creating a second run or step', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const first = await postJson(baseUrl, '/v1/actions', baseAction);
      const replay = await postJson(baseUrl, '/v1/actions', baseAction);
      assert.equal(first.status, 202);
      assert.equal(replay.status, 200);
      const firstPayload = (await first.json()) as any;
      const replayPayload = (await replay.json()) as any;
      assert.equal(replayPayload.idempotentReplay, true);
      assert.equal(replayPayload.action.runId, firstPayload.action.runId);
      assert.equal(
        (await gateway.repository.listEvents(firstPayload.action.runId, 'tenant-a')).filter(
          (event) => event.type === 'run.created',
        ).length,
        1,
      );
    });
  });

  it('returns the persisted signed receipt for a completed compensation effect', async () => {
    const gateway = new InMemoryGateway();
    const { privateKey } = generateKeyPairSync('ed25519');
    const signer = createEvidenceSigner({
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      keyId: 'cell-test-1',
    });
    await withEvidenceJwks(signer.jwks, () =>
      withGateway(gateway, async (baseUrl) => {
        const proposed = await postJson(baseUrl, '/v1/actions', {
          ...baseAction,
          destination: 'demo://tickets/approval',
          idempotencyKey: 'action-key-evidence',
          args: {
            title: 'SENSITIVE_TOOL_ARGUMENT',
            Authorization: 'Bearer SENSITIVE_AUTH_TOKEN',
          },
        });
        const payload = (await proposed.json()) as any;
        const approved = await postJson(
          baseUrl,
          `/v1/actions/${payload.action.runId}/approve`,
          approvalBinding(payload.action),
        );
        assert.equal(approved.status, 200);
        const claimed = await gateway.repository.claimNextStep({
          workerId: 'evidence-worker',
          workerGeneration: 1,
          tenantId: 'tenant-a',
          capabilities: ['tool'],
          leaseTtlMs: 30_000,
        });
        assert.ok(claimed?.lease);
        const run = await gateway.repository.getRun(payload.action.runId, 'tenant-a');
        const metadata = run!.metadata.actionGateway as any;
        const effectRequest = {
          id: metadata.effectId,
          runId: run!.id,
          stepId: claimed.id,
          tenantId: 'tenant-a',
          type: 'demo.ticket.create',
          idempotencyKey: 'action-key-evidence',
          policyDecisionId: 'action-gateway-allow-after-approval',
          policySnapshotId: metadata.policySnapshotId,
          actionDigest: metadata.actionDigest,
          request: metadata.envelope,
          lease: claimed.lease,
          actor: 'evidence-worker',
        };
        assert.deepEqual(
          await gateway.repository.admitEffect(effectRequest),
          { admitted: false, reason: 'OPERATIONS_NOT_READY' },
          'the old fixture must not bypass Class A admission readiness',
        );
        seedFreshOperationsDrains(gateway.repository, 'tenant-a');
        const admission = await gateway.repository.admitEffect(effectRequest);
        assert.equal(admission.admitted, true);
        await gateway.repository.completeEffect(
          metadata.effectId,
          'tenant-a',
          claimed.lease,
          {
            status: 'ok',
            body: 'SENSITIVE_EFFECT_RESPONSE',
            access_token: 'SENSITIVE_RESPONSE_TOKEN',
          },
          'evidence-worker',
        );
        await gateway.repository.completeStep({
          stepId: claimed.id,
          tenantId: 'tenant-a',
          lease: claimed.lease,
          expectedVersion: claimed.version,
          output: { status: 'ok' },
          actor: 'evidence-worker',
        });
        const body = buildRunEvidenceBundle({
          tenantId: 'tenant-a',
          runId: run!.id,
          actionDigest: metadata.actionDigest,
          intentHash: run!.intentHash,
          workGraphHash: run!.workGraphHash,
          workGraphVersion: run!.workGraphVersion,
          policySnapshotId: run!.policySnapshotId,
          kernelApiVersion: 'v1',
          effects: await gateway.repository.listEffectsForRun(run!.id, 'tenant-a'),
          exportedAt: '2026-07-17T06:00:02.000Z',
          bundleId: 'bundle-persisted-evidence',
        });
        const signature = await signer.sign(canonicalEvidenceBody(body));
        gateway.evidence.set(`tenant-a\u0000${run!.id}`, {
          tenantId: 'tenant-a',
          runId: run!.id,
          bundleId: body.bundleId,
          actionDigest: body.actionDigest,
          body,
          contentHash: body.contentHash,
          signature,
          createdAt: body.exportedAt,
          anchoredAt: '2026-07-17T06:00:04.000Z',
          retentionUntil: '2027-07-17T06:00:04.000Z',
        });
        const evidence = await fetch(`${baseUrl}/v1/actions/${payload.action.runId}/evidence`, {
          headers: { 'x-test-tenant': 'tenant-a' },
        });
        assert.equal(evidence.status, 200);
        const evidenceText = await evidence.text();
        const evidencePayload = JSON.parse(evidenceText) as any;
        assert.equal(evidencePayload.receipt.schemaVersion, 'l3-11.v0');
        assert.equal(evidencePayload.receipt.scope.runId, payload.action.runId);
        assert.equal(evidencePayload.receipt.signature.keyId, 'cell-test-1');
        assert.equal(evidencePayload.verification.ok, true);
        assert.equal(verifyEvidenceBundle(evidencePayload.receipt).ok, true);
        assert.equal(evidenceText.includes('SENSITIVE_TOOL_ARGUMENT'), false);
        assert.equal(evidenceText.includes('SENSITIVE_AUTH_TOKEN'), false);
        assert.equal(evidenceText.includes('SENSITIVE_EFFECT_RESPONSE'), false);
        assert.equal(evidenceText.includes('SENSITIVE_RESPONSE_TOKEN'), false);
        assert.equal(evidenceText.includes('Approve demo.ticket.create'), false);
        assert.equal(evidencePayload.receipt.effects[0].responseSummary.status, 'ok');

        gateway.evidence.set(`tenant-a\u0000${run!.id}`, {
          ...gateway.evidence.get(`tenant-a\u0000${run!.id}`)!,
          signature: { ...signature, value: 'forged-signature' },
        });
        const forged = await fetch(`${baseUrl}/v1/actions/${payload.action.runId}/evidence`, {
          headers: { 'x-test-tenant': 'tenant-a' },
        });
        assert.equal(forged.status, 503);
        assert.equal(
          ((await forged.json()) as { error: { code: string } }).error.code,
          'EVIDENCE_INVALID',
        );

        const reconcile = await postJson(
          baseUrl,
          `/v1/actions/${payload.action.runId}/reconcile`,
          {},
          'tenant-a',
          'api-admin',
        );
        assert.equal(reconcile.status, 409);
      }),
    );
  });

  it('does not reconstruct evidence from transient interaction events', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const proposed = await postJson(baseUrl, '/v1/actions', {
        ...baseAction,
        idempotencyKey: 'action-evidence-escalated-unknown',
      });
      assert.equal(proposed.status, 202);
      const action = ((await proposed.json()) as any).action;
      const run = await gateway.repository.getRun(action.runId, 'tenant-a');
      const metadata = run!.metadata.actionGateway as any;
      const claimedStep = await gateway.repository.claimNextStep({
        workerId: 'evidence-escalation-worker',
        workerGeneration: 1,
        tenantId: 'tenant-a',
        capabilities: ['tool'],
        leaseTtlMs: 30_000,
      });
      assert.ok(claimedStep?.lease);
      const admitted = await gateway.repository.admitEffect({
        id: metadata.effectId,
        runId: action.runId,
        stepId: claimedStep.id,
        tenantId: 'tenant-a',
        type: metadata.envelope.effectType,
        idempotencyKey: metadata.envelope.idempotencyKey,
        policyDecisionId: metadata.decision.decisionId,
        policySnapshotId: metadata.policySnapshotId,
        actionDigest: metadata.actionDigest,
        request: metadata.envelope,
        lease: claimedStep.lease,
        actor: 'evidence-escalation-worker',
      });
      assert.equal(admitted.admitted, true);
      if (!admitted.admitted) return;
      await gateway.repository.markEffectCompletionUnknown({
        effectId: admitted.effect.id,
        tenantId: 'tenant-a',
        reason: 'remote outcome unknown',
        actor: 'evidence-escalation-worker',
      });
      const [claimedEffect] = await gateway.repository.claimReconcileEffects({
        tenantId: 'tenant-a',
        limit: 1,
        now: new Date(Date.now() + 60_000),
        workerId: 'evidence-escalation-worker',
        workerGeneration: 1,
      });
      assert.ok(claimedEffect);
      assert.equal(
        await gateway.repository.escalateReconcile({
          effectId: admitted.effect.id,
          tenantId: 'tenant-a',
          claimToken: claimedEffect.claimToken,
          reason: 'unregistered_adapter',
        }),
        true,
      );

      const evidence = await fetch(`${baseUrl}/v1/actions/${payload.action.runId}/evidence`, {
        headers: { 'x-test-tenant': 'tenant-a' },
      });
      assert.equal(evidence.status, 503);
      const evidenceText = await evidence.text();
      const evidencePayload = JSON.parse(evidenceText) as any;
      assert.equal(evidenceText.includes('USER_CONTROLLED_REJECT_SECRET'), false);
      assert.equal(evidencePayload.error.code, 'EVIDENCE_NOT_READY');
    });
  });

  it('exports signed evidence for compensation runs without forward action metadata', async () => {
    const gateway = new InMemoryGateway();
    const compensationRunId = 'compensation-run-evidence';
    const compensationEffectId = 'effect-compensation-evidence';
    const compensationActionDigest = 'c'.repeat(64);
    const authorization = {
      schema: 'commander.compensation/v1',
      tenantId: 'tenant-a',
      originalRunId: 'forward-run-evidence',
      originalEffectId: 'effect-forward-evidence',
      compensationRunId,
      compensationEffectId,
      actionDigest: compensationActionDigest,
    };
    const compensationRun = {
      id: compensationRunId,
      tenantId: 'tenant-a',
      intentHash: 'compensation-intent',
      workGraphHash: 'compensation-graph',
      workGraphVersion: 'compensation/v1',
      state: 'SUCCEEDED' as const,
      version: 1,
      policySnapshotId: 'action-gateway-mvp-v1',
      createdAt: '2026-07-17T06:00:00.000Z',
      updatedAt: '2026-07-17T06:00:04.000Z',
      terminalAt: '2026-07-17T06:00:04.000Z',
      metadata: { compensation: { authorization } },
    };
    const originalGetRun = gateway.getRun.bind(gateway);
    gateway.getRun = async (runId, tenantId) =>
      runId === compensationRunId && tenantId === 'tenant-a'
        ? compensationRun
        : originalGetRun(runId, tenantId);
    const originalGetEffect = gateway.getEffect.bind(gateway);
    const compensationEffect = {
      id: compensationEffectId,
      runId: compensationRunId,
      stepId: 'step-compensation-evidence',
      tenantId: 'tenant-a',
      type: 'compensate.demo.ticket.create',
      idempotencyKey: 'cmp:effect-forward-evidence:1.0.0',
      requestHash: 'r'.repeat(64),
      policyDecisionId: 'compensation-allow',
      policySnapshotId: compensationRun.policySnapshotId,
      actionDigest: compensationActionDigest,
      leaseWorkerId: 'worker-compensation-evidence',
      leaseWorkerGeneration: 1,
      leaseFencingEpoch: 1,
      state: 'COMPLETED' as const,
      request: {},
      response: {},
      createdAt: compensationRun.createdAt,
      completedAt: compensationRun.updatedAt,
      reconcileAttempts: 0,
      governedActionDeadlineAt: null,
      reconcilePolicy: null,
      reconcileDisposition: null,
      reconcileAfter: null,
      reconcileObservedAt: null,
      reconcileClaimToken: null,
      reconcileClaimExpiresAt: null,
      reconcileClaimedAt: null,
      reconcileClaimWorkerId: null,
      reconcileClaimWorkerGeneration: null,
      reconcileLastError: null,
      reconcileEscalatedAt: null,
      reconcileEscalationCode: null,
    };
    gateway.getEffect = async (effectId, tenantId) =>
      effectId === compensationEffectId && tenantId === 'tenant-a'
        ? compensationEffect
        : originalGetEffect(effectId, tenantId);
    const originalListEffects = gateway.listEffects.bind(gateway);
    gateway.listEffects = async (runId, tenantId) =>
      runId === compensationRunId && tenantId === 'tenant-a'
        ? [compensationEffect]
        : originalListEffects(runId, tenantId);
    const { privateKey } = generateKeyPairSync('ed25519');
    const signer = createEvidenceSigner({
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      keyId: 'cell-compensation-evidence-1',
    });
    const body = buildRunEvidenceBundle({
      tenantId: 'tenant-a',
      runId: compensationRunId,
      actionDigest: compensationActionDigest,
      policySnapshotId: compensationRun.policySnapshotId,
      effects: [],
      exportedAt: '2026-07-17T06:00:02.000Z',
      bundleId: 'bundle-compensation-evidence',
    });
    const signature = await signer.sign(canonicalEvidenceBody(body));
    gateway.evidence.set(`tenant-a\u0000${compensationRunId}`, {
      tenantId: 'tenant-a',
      runId: compensationRunId,
      bundleId: body.bundleId,
      actionDigest: body.actionDigest,
      body,
      contentHash: body.contentHash,
      signature,
      createdAt: body.exportedAt,
      anchoredAt: '2026-07-17T06:00:04.000Z',
      retentionUntil: '2027-07-17T06:00:04.000Z',
    });

    await withEvidenceJwks(signer.jwks, () =>
      withGateway(gateway, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/v1/actions/${compensationRunId}/evidence`, {
          headers: { 'x-test-tenant': 'tenant-a' },
        });
        assert.equal(response.status, 200);
        const payload = (await response.json()) as any;
        assert.equal(payload.receipt.scope.runId, compensationRunId);
        assert.equal(payload.verification.ok, true);
      }),
    );
  });

  it('does not expose evidence for a run without governed compensation binding', async () => {
    const gateway = new InMemoryGateway();
    const runId = 'unbound-evidence-run';
    const run = {
      id: runId,
      tenantId: 'tenant-a',
      intentHash: 'intent-unbound',
      workGraphHash: 'graph-unbound',
      workGraphVersion: 'generic/v1',
      state: 'SUCCEEDED' as const,
      version: 1,
      policySnapshotId: 'action-gateway-mvp-v1',
      createdAt: '2026-07-17T06:00:00.000Z',
      updatedAt: '2026-07-17T06:00:04.000Z',
      terminalAt: '2026-07-17T06:00:04.000Z',
      metadata: { compensationRequestId: 'unbound-request' },
    };
    const originalGetRun = gateway.getRun.bind(gateway);
    gateway.getRun = async (requestedRunId, tenantId) =>
      requestedRunId === runId && tenantId === 'tenant-a'
        ? run
        : originalGetRun(requestedRunId, tenantId);
    const { privateKey } = generateKeyPairSync('ed25519');
    const signer = createEvidenceSigner({
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      keyId: 'cell-unbound-evidence-1',
    });
    const body = buildRunEvidenceBundle({
      tenantId: 'tenant-a',
      runId,
      actionDigest: 'd'.repeat(64),
      policySnapshotId: run.policySnapshotId,
      effects: [],
      exportedAt: '2026-07-17T06:00:02.000Z',
      bundleId: 'bundle-unbound-evidence',
    });
    const signature = await signer.sign(canonicalEvidenceBody(body));
    gateway.evidence.set(`tenant-a\u0000${runId}`, {
      tenantId: 'tenant-a',
      runId,
      bundleId: body.bundleId,
      actionDigest: body.actionDigest,
      body,
      contentHash: body.contentHash,
      signature,
      createdAt: body.exportedAt,
      anchoredAt: '2026-07-17T06:00:04.000Z',
      retentionUntil: '2027-07-17T06:00:04.000Z',
    });

    await withEvidenceJwks(signer.jwks, () =>
      withGateway(gateway, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/v1/actions/${runId}/evidence`, {
          headers: { 'x-test-tenant': 'tenant-a' },
        });
        assert.equal(response.status, 404);
        assert.deepEqual(await response.json(), {
          error: { code: 'ACTION_NOT_FOUND', message: 'Action was not found.' },
        });
      }),
    );
  });

  it('rejects persisted evidence whose body scope is not bound to the requested tenant', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const proposed = await postJson(baseUrl, '/v1/actions', {
        ...baseAction,
        idempotencyKey: 'action-key-cross-scope-evidence',
      });
      const payload = (await proposed.json()) as { action: { runId: string } };
      const body = buildRunEvidenceBundle({
        tenantId: 'tenant-b',
        runId: payload.action.runId,
        actionDigest: 'a'.repeat(64),
        policySnapshotId: 'action-gateway-mvp-v1',
        effects: [],
        exportedAt: '2026-07-17T06:00:02.000Z',
        bundleId: 'bundle-cross-scope-evidence',
      });
      gateway.evidence.set(`tenant-a\u0000${payload.action.runId}`, {
        tenantId: 'tenant-a',
        runId: payload.action.runId,
        bundleId: body.bundleId,
        actionDigest: body.actionDigest,
        body,
        contentHash: body.contentHash,
        signature: {
          algorithm: 'Ed25519',
          keyId: 'cell-test-1',
          signedAt: '2026-07-17T06:00:03.000Z',
          value: 'persisted-signature',
        },
        createdAt: body.exportedAt,
        anchoredAt: '2026-07-17T06:00:04.000Z',
        retentionUntil: '2027-07-17T06:00:04.000Z',
      });

      const evidence = await fetch(`${baseUrl}/v1/actions/${payload.action.runId}/evidence`, {
        headers: { 'x-test-tenant': 'tenant-a' },
      });
      assert.equal(evidence.status, 503);
      assert.equal(
        ((await evidence.json()) as { error: { code: string } }).error.code,
        'EVIDENCE_INVALID',
      );
    });
  });

  it('returns EVIDENCE_INVALID for a malformed persisted evidence body', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const proposed = await postJson(baseUrl, '/v1/actions', {
        ...baseAction,
        idempotencyKey: 'action-key-malformed-evidence',
      });
      const payload = (await proposed.json()) as { action: { runId: string } };
      const body = buildRunEvidenceBundle({
        tenantId: 'tenant-a',
        runId: payload.action.runId,
        actionDigest: 'b'.repeat(64),
        policySnapshotId: 'action-gateway-mvp-v1',
        effects: [],
        exportedAt: '2026-07-17T06:00:02.000Z',
        bundleId: 'bundle-malformed-evidence',
      });
      gateway.evidence.set(`tenant-a\u0000${payload.action.runId}`, {
        tenantId: 'tenant-a',
        runId: payload.action.runId,
        bundleId: body.bundleId,
        actionDigest: body.actionDigest,
        body: { ...body, effects: null } as unknown as GatewayEvidenceRecord['body'],
        contentHash: body.contentHash,
        signature: {
          algorithm: 'Ed25519',
          keyId: 'cell-test-1',
          signedAt: '2026-07-17T06:00:03.000Z',
          value: 'persisted-signature',
        },
        createdAt: body.exportedAt,
        anchoredAt: '2026-07-17T06:00:04.000Z',
        retentionUntil: '2027-07-17T06:00:04.000Z',
      });

      const evidence = await fetch(`${baseUrl}/v1/actions/${payload.action.runId}/evidence`, {
        headers: { 'x-test-tenant': 'tenant-a' },
      });
      assert.equal(evidence.status, 503);
      assert.equal(
        ((await evidence.json()) as { error: { code: string } }).error.code,
        'EVIDENCE_INVALID',
      );
    });
  });

  it('blocks generic run submissions from spoofing Action Gateway external work', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/runs`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'spoof-key-0001',
          'x-test-tenant': 'tenant-a',
        },
        body: JSON.stringify({
          goal: 'bypass action gateway',
          policySnapshotId: 'action-gateway-mvp-v1',
          metadata: {
            actionGateway: {
              authority: 'commander.action-gateway/v1',
              decision: { effect: 'allow' },
            },
          },
          steps: [
            {
              kind: 'tool',
              input: {
                toolName: 'ticket.create',
                effectType: 'demo.ticket.create',
                args: { title: 'bypass' },
              },
            },
          ],
        }),
      });
      assert.equal(response.status, 403);
      assert.equal(((await response.json()) as any).error.code, 'ACTION_GATEWAY_REQUIRED');
    });
  });

  it('rejects agent steps that declare external tools on POST /v1/runs', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/runs`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'agent-tools-key-01',
          'x-test-tenant': 'tenant-a',
        },
        body: JSON.stringify({
          goal: 'agent with tools',
          policySnapshotId: 'action-gateway-mvp-v1',
          steps: [
            {
              kind: 'agent',
              input: {
                goal: 'do work',
                agentId: 'agent-1',
                definitionVersion: '1',
                providerSnapshot: { provider: 'openai', model: 'gpt-4' },
                tools: ['ticket.create'],
              },
            },
          ],
        }),
      });
      assert.equal(response.status, 403);
      assert.equal(((await response.json()) as any).error.code, 'ACTION_GATEWAY_REQUIRED');
    });
  });

  it('returns 409 IDEMPOTENCY_KEY_CONFLICT when the same key is reused with different args', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const first = await postJson(baseUrl, '/v1/actions', {
        ...baseAction,
        idempotencyKey: 'action-key-conflict',
        args: { title: 'first' },
      });
      assert.equal(first.status, 202);
      const conflict = await postJson(baseUrl, '/v1/actions', {
        ...baseAction,
        idempotencyKey: 'action-key-conflict',
        args: { title: 'second' },
      });
      assert.equal(conflict.status, 409);
      assert.equal(((await conflict.json()) as any).error.code, 'IDEMPOTENCY_KEY_CONFLICT');
    });
  });

  it('returns 503 KILL_SWITCH_LOOKUP_FAILED when kill-switch lookup throws', async () => {
    const gateway = new InMemoryGateway();
    gateway.killSwitchLookupError = new Error('db unavailable');
    await withGateway(gateway, async (baseUrl) => {
      const response = await postJson(baseUrl, '/v1/actions/simulate', baseAction);
      assert.equal(response.status, 503);
      assert.equal(((await response.json()) as any).error.code, 'KILL_SWITCH_LOOKUP_FAILED');
    });
  });
});

describe('canonical compensation HTTP retries', () => {
  async function fixture(baseUrl: string, gateway: InMemoryGateway) {
    const proposed = await postJson(baseUrl, '/v1/actions', {
      ...baseAction,
      destination: 'demo://tickets/approval',
      idempotencyKey: 'compensation-http-retry',
    });
    const { action } = (await proposed.json()) as {
      action: {
        runId: string;
        simulation: { actionDigest: string; simulationId: string; policySnapshotId: string };
      };
    };
    assert.equal(
      (
        await postJson(baseUrl, `/v1/actions/${action.runId}/approve`, {
          actionDigest: action.simulation.actionDigest,
          simulationId: action.simulation.simulationId,
          policySnapshotId: action.simulation.policySnapshotId,
        })
      ).status,
      200,
    );
    const step = await gateway.repository.claimNextStep({
      workerId: 'retry-worker',
      workerGeneration: 1,
      tenantId: 'tenant-a',
      capabilities: ['tool'],
      leaseTtlMs: 30000,
    });
    assert.ok(step?.lease);
    const run = await gateway.getRun(action.runId, 'tenant-a');
    const metadata = run!.metadata.actionGateway as {
      effectId: string;
      envelope: Record<string, unknown>;
    };
    seedFreshOperationsDrains(gateway.repository, 'tenant-a');
    assert.equal(
      (
        await gateway.repository.admitEffect({
          id: metadata.effectId,
          runId: action.runId,
          stepId: step.id,
          tenantId: 'tenant-a',
          type: 'demo.ticket.create',
          idempotencyKey: 'compensation-http-retry',
          policyDecisionId: 'decision',
          policySnapshotId: action.simulation.policySnapshotId,
          actionDigest: action.simulation.actionDigest,
          request: metadata.envelope,
          lease: step.lease,
          actor: 'retry-worker',
        })
      ).admitted,
      true,
    );
    const receipt = { ticketId: 'ticket-retry' };
    await gateway.repository.completeEffect(
      metadata.effectId,
      'tenant-a',
      step.lease,
      receipt,
      'retry-worker',
    );
    const path = `/v1/actions/${action.runId}/compensations`;
    const body = {
      originalEffectId: metadata.effectId,
      adapterVersion: '1.0.0',
      compensationEffectType: 'compensate.demo.ticket.create',
      compensationPatch: {},
      forwardReceiptHash: createHash('sha256').update(JSON.stringify(receipt)).digest('hex'),
    };
    const response = await postJson(baseUrl, path, body);
    assert.equal(response.status, 202, await response.clone().text());
    const { authorization } = (await response.json()) as {
      authorization: {
        id: string;
        expiresAt: string;
        actionDigest: string;
        policySnapshotId: string;
        approvalInteractionId: string;
      };
    };
    assert.ok(authorization);
    return {
      path,
      body,
      authorization,
      approvalPath: `${path}/${authorization.id}/approve`,
      binding: {
        actionDigest: authorization.actionDigest,
        policySnapshotId: authorization.policySnapshotId,
      },
    };
  }

  it('preserves authorization TTL and returns the same request on approval retries', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const f = await fixture(baseUrl, gateway);
      const retry = await postJson(baseUrl, f.path, f.body);
      assert.equal(retry.status, 202);
      const repeated = (await retry.json()) as {
        authorization: { expiresAt: string };
        replayed: boolean;
      };
      assert.equal(repeated.authorization.expiresAt, f.authorization.expiresAt);
      assert.equal(repeated.replayed, true);
      const first = await postJson(baseUrl, f.approvalPath, f.binding);
      assert.equal(first.status, 202, await first.clone().text());
      const original = (await first.json()) as { request: { id: string }; interaction: unknown };
      const again = await postJson(baseUrl, f.approvalPath, f.binding);
      assert.equal(again.status, 202);
      const replay = (await again.json()) as {
        request: { id: string };
        interaction: unknown;
        replayed: boolean;
      };
      assert.equal(replay.request.id, original.request.id);
      assert.deepEqual(replay.interaction, original.interaction);
      assert.equal(replay.replayed, true);
      assert.equal(
        (await postJson(baseUrl, f.approvalPath, { ...f.binding, actionDigest: '0'.repeat(64) }))
          .status,
        409,
      );
    });
  });

  it('concurrent identical approvals converge on one durable request', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const f = await fixture(baseUrl, gateway);
      const answer = gateway.answerInteraction.bind(gateway);
      let arrivals = 0;
      let release!: () => void;
      const bothArrived = new Promise<void>((resolve) => {
        release = resolve;
      });
      gateway.answerInteraction = async (input) => {
        arrivals += 1;
        if (arrivals === 2) release();
        await bothArrived;
        return answer(input);
      };
      const responses = await Promise.all([
        postJson(baseUrl, f.approvalPath, f.binding),
        postJson(baseUrl, f.approvalPath, f.binding),
      ]);
      assert.deepEqual(
        responses.map((response) => response.status),
        [202, 202],
      );
      const bodies = await Promise.all(
        responses.map(
          async (response) =>
            (await response.json()) as { request: { id: string }; replayed: boolean },
        ),
      );
      assert.equal(bodies[0]!.request.id, bodies[1]!.request.id);
      assert.equal(bodies.filter((body) => body.replayed).length, 1);
      assert.equal(arrivals, 2, 'exercise the pending-to-answered CAS race');
    });
  });

  it('recovers after an answered approval whose request write failed, and rejects tampered persisted answers', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const f = await fixture(baseUrl, gateway);
      const request = gateway.requestCompensation.bind(gateway);
      let failOnce = true;
      gateway.requestCompensation = (input) => {
        if (failOnce) {
          failOnce = false;
          throw new Error('injected request persistence failure');
        }
        return request(input);
      };
      assert.equal((await postJson(baseUrl, f.approvalPath, f.binding)).status, 500);
      const retry = await postJson(baseUrl, f.approvalPath, f.binding);
      assert.equal(retry.status, 202, await retry.clone().text());
      const list = gateway.listInteractions.bind(gateway);
      gateway.listInteractions = async (runId, tenantId) =>
        (await list(runId, tenantId)).map((interaction) =>
          interaction.id === f.authorization.approvalInteractionId
            ? {
                ...interaction,
                response: { ...interaction.response, originalEffectId: 'tampered' },
              }
            : interaction,
        );
      assert.equal((await postJson(baseUrl, f.approvalPath, f.binding)).status, 409);
    });
  });
});
