#!/usr/bin/env tsx
/**
 * L4-A golden demo — deterministic in-memory Action Gateway harness.
 *
 * Runs ten named checks against the real kernel repository, Action Gateway
 * router, EffectBroker, and demo.ticket.create adapter. No external DB required.
 *
 * Usage: pnpm demo:l4-a
 */

import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import express from 'express';
import { verifyEvidenceBundle } from '@praetor/effect-broker';
import {
  CapabilityTokenIssuer,
  CapabilityTokenVerifier,
  EffectBroker,
  buildTerminalEvidenceRecordFromKernel,
  canonicalRequestHash,
  createEvidenceSigner,
} from '@praetor/effect-broker';
import { InMemoryKernelRepository } from '@praetor/kernel/testing/inMemoryRepository';
import {
  ApiKeyWorkerAuthenticator,
  ToolStepExecutor,
  WorkerService,
  createWorkerPolicyEvaluator,
} from '../packages/worker-plane/src/index.js';
// WP-14: the in-memory registry is deliberately not exposed from the package
// root; import it from its module, as the worker-plane suites do.
import { InMemoryWorkerRegistry } from '../packages/worker-plane/src/registry.js';
import { InMemoryTicketAdapter } from '../packages/worker-plane/src/ticketAdapter.js';
import type { GatewayEvidenceRecord, V1KernelGateway } from '../apps/api/src/v1GatewayKernel.js';
import { createV1GatewayRouter } from '../apps/api/src/v1GatewayEndpoints.js';
import { CommanderGatewayClient } from '../packages/sdk/src/v1/client.js';

export const GOLDEN_DEMO_MODE = 'simulated' as const;
export const GOLDEN_DEMO_TENANT = 'l4-a-demo-tenant';

export const GOLDEN_DEMO_CHECKS = [
  'policy-simulation',
  'propose-approve-execute',
  'approval-rejection-failed',
  'exact-approval-binding',
  'kill-switch-blocks',
  'evidence-verification',
  'completion-unknown',
  'reconcile',
  'sdk-policy-equivalence',
  'cleanup',
] as const;

export type GoldenDemoCheckName = (typeof GOLDEN_DEMO_CHECKS)[number];

export interface GoldenDemoCheckResult {
  name: GoldenDemoCheckName;
  passed: boolean;
  detail?: string;
}

export interface GoldenDemoResult {
  mode: typeof GOLDEN_DEMO_MODE;
  checks: GoldenDemoCheckResult[];
  allPassed: boolean;
  elapsedMs: number;
}

const BASE_ACTION = {
  source: 'l4-a-golden-demo',
  package: 'l4-a-demo-package',
  model: 'l4-a-demo-model',
  tool: 'ticket.create',
  destination: 'demo://tickets',
  effectType: 'demo.ticket.create',
  args: { title: 'L4-A golden demo ticket' },
} as const;

class InMemoryGateway implements V1KernelGateway {
  readonly repository = new InMemoryKernelRepository();
  readonly evidenceSigner = createEvidenceSigner({
    privateKeyPem: generateKeyPairSync('ed25519')
      .privateKey.export({ format: 'pem', type: 'pkcs8' })
      .toString(),
    keyId: 'l4-a-demo-evidence',
  });
  private readonly submissions = new Map<string, string>();

  constructor() {
    const drainIdentity = 'db:commander_adapter_ops';
    const registeredAt = new Date(Date.now() - 1_000);
    const lastHeartbeatAt = new Date();
    this.repository.seedTestWorker('l4-a-reconcile-drain', [GOLDEN_DEMO_TENANT], 1, {
      capabilities: ['effect.reconcile'],
      identitySubject: drainIdentity,
      registeredAt,
      lastHeartbeatAt,
    });
    this.repository.seedTestWorker('l4-a-compensation-drain', [GOLDEN_DEMO_TENANT], 1, {
      capabilities: ['effect.compensate'],
      identitySubject: drainIdentity,
      registeredAt,
      lastHeartbeatAt,
    });
  }

  getOperationsReadiness(tenantId: string, now?: Date) {
    return this.repository.getOperationsReadiness(tenantId, now);
  }

  getEvidenceRepositoryAvailability() {
    return this.repository.checkEvidenceRepositoryAvailability();
  }

  createInteraction(
    input: Parameters<InMemoryKernelRepository['createInteraction']>[0],
    actor: string,
  ) {
    return this.repository.createInteraction(input, actor);
  }

  async getEvidence(runId: string, tenantId: string): Promise<GatewayEvidenceRecord | null> {
    const record = await this.repository.getEvidence(runId, tenantId);
    return record
      ? {
          ...record,
          body: record.body as GatewayEvidenceRecord['body'],
        }
      : null;
  }

  async requestReconcile(effectId: string, tenantId: string, actor: string) {
    return this.repository.requestReconcile({ effectId, tenantId, actor });
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

  async submit(input: Parameters<V1KernelGateway['submit']>[0]) {
    const runId = `run_${createHash('sha256')
      .update(`${input.tenantId}:${input.idempotencyKey}`)
      .digest('hex')
      .slice(0, 40)}`;
    const submission = JSON.stringify(input);
    const existing = await this.repository.getRun(runId, input.tenantId);
    if (existing) {
      assert.equal(this.submissions.get(runId), submission);
      return { run: existing, created: false };
    }
    const run = await this.repository.createRun(
      {
        id: runId,
        tenantId: input.tenantId,
        intentHash: 'l4-a-intent',
        workGraphHash: 'l4-a-graph',
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
  answerInteraction(input: Parameters<InMemoryKernelRepository['answerInteraction']>[0]) {
    return this.repository.answerInteraction(input);
  }
  listEffects(runId: string, tenantId: string) {
    return this.repository.listEffectsForRun(runId, tenantId);
  }
  getEffect(effectId: string, tenantId: string) {
    return this.repository.getEffect(effectId, tenantId);
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
    return this.repository.findMatchingKillSwitch(tenantId, dims);
  }
}

interface DemoHarness {
  gateway: InMemoryGateway;
  baseUrl: string;
  server: Server;
  get closed(): boolean;
  close: () => Promise<void>;
}

async function startHarness(gateway: InMemoryGateway): Promise<DemoHarness> {
  const previousEvidenceJwks = process.env.COMMANDER_EVIDENCE_JWKS_JSON;
  process.env.COMMANDER_EVIDENCE_JWKS_JSON = JSON.stringify(gateway.evidenceSigner.jwks);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.tenantId = GOLDEN_DEMO_TENANT;
    req.apiKeyId = 'l4-a-demo-key';
    req.apiScopes = ['actions:approve', 'actions:kill', 'admin'];
    next();
  });
  app.use(
    '/v1',
    createV1GatewayRouter(() => gateway),
  );
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let closed = false;
  return {
    gateway,
    baseUrl,
    server,
    get closed() {
      return closed;
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      if (previousEvidenceJwks === undefined) delete process.env.COMMANDER_EVIDENCE_JWKS_JSON;
      else process.env.COMMANDER_EVIDENCE_JWKS_JSON = previousEvidenceJwks;
    },
  };
}

async function postJson(
  baseUrl: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function approvalBinding(action: {
  simulation: { actionDigest: string; simulationId: string; policySnapshotId: string };
}) {
  return {
    actionDigest: action.simulation.actionDigest,
    simulationId: action.simulation.simulationId,
    policySnapshotId: action.simulation.policySnapshotId,
  };
}

async function createDemoWorker(
  kernel: InMemoryKernelRepository,
  tickets: InMemoryTicketAdapter,
  evidenceSigner: InMemoryGateway['evidenceSigner'],
) {
  await kernel.setAllowlistEntry(GOLDEN_DEMO_TENANT, 'demo.ticket.create', true);
  const issuer = CapabilityTokenIssuer.generate({
    issuer: 'commander-worker',
    audience: 'commander.effect-broker',
    keyId: 'l4-a-demo',
  });
  const verifier = new CapabilityTokenVerifier({
    issuer: 'commander-worker',
    audience: 'commander.effect-broker',
    publicKeys: { 'l4-a-demo': issuer.publicKey },
  });
  const bootstrap = await import('../packages/worker-plane/src/bootstrap.js');
  const broker = new EffectBroker(
    verifier,
    createWorkerPolicyEvaluator(kernel),
    kernel,
    // 签名是 (tickets = adapter)，不能传 { tickets } 对象字面量
    bootstrap.createWorkerEffectExecutor(tickets),
    { append: async () => {} },
    {
      requireRequestBinding: true,
      localWorkerId: 'l4-a-demo-worker',
      evidenceSigner,
      requireEvidencePersistence: true,
    },
  );
  const worker = new WorkerService(
    {
      id: 'l4-a-demo-worker',
      kind: 'tool',
      version: 'l4-a',
      capabilities: ['tool'],
      maxConcurrency: 1,
    },
    {
      subject: 'worker:l4-a-demo',
      token: 'l4-a-demo-worker-token',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
    new ApiKeyWorkerAuthenticator({
      validTokens: new Set(['l4-a-demo-worker-token']),
      defaultTenantIds: [GOLDEN_DEMO_TENANT],
      defaultCapabilities: ['tool'],
    }),
    new InMemoryWorkerRegistry(),
    kernel,
    new ToolStepExecutor(undefined, broker, issuer),
    {
      leaseTtlMs: 30_000,
      workerHeartbeatMs: 10_000,
      pollIntervalMs: 5,
      onRegistered: (record) => broker.bindLocalWorkerGeneration(record.generation),
    },
  );
  return { worker, broker, tickets };
}

async function checkPolicySimulation(baseUrl: string): Promise<void> {
  const allow = await postJson(baseUrl, '/v1/actions/simulate', {
    ...BASE_ACTION,
    idempotencyKey: 'l4-a-sim-allow',
  });
  assert.equal(allow.status, 200);
  assert.equal(
    ((await allow.json()) as { simulation: { effect: string } }).simulation.effect,
    'allow',
  );

  const deny = await postJson(baseUrl, '/v1/actions/simulate', {
    ...BASE_ACTION,
    destination: 'https://untrusted.example/tickets',
    idempotencyKey: 'l4-a-sim-deny',
  });
  assert.equal(deny.status, 200);
  assert.equal(
    ((await deny.json()) as { simulation: { effect: string } }).simulation.effect,
    'deny',
  );

  const approval = await postJson(baseUrl, '/v1/actions/simulate', {
    ...BASE_ACTION,
    destination: 'demo://tickets/approval',
    idempotencyKey: 'l4-a-sim-approval',
  });
  assert.equal(approval.status, 200);
  assert.equal(
    ((await approval.json()) as { simulation: { effect: string } }).simulation.effect,
    'require_approval',
  );
}

async function checkProposeApproveExecute(
  baseUrl: string,
  gateway: InMemoryGateway,
): Promise<void> {
  const tickets = new InMemoryTicketAdapter();
  const { worker } = await createDemoWorker(gateway.repository, tickets, gateway.evidenceSigner);
  await worker.start();
  try {
    const proposed = await postJson(baseUrl, '/v1/actions', {
      ...BASE_ACTION,
      idempotencyKey: 'l4-a-propose-execute',
    });
    assert.equal(proposed.status, 202);
    const payload = (await proposed.json()) as {
      action: { runId: string; decision: { effect: string } };
    };
    assert.equal(payload.action.decision.effect, 'allow');

    assert.equal(await worker.pollOnce(), true);
    await worker.waitForIdle();
    assert.equal(
      (await gateway.repository.getRun(payload.action.runId, GOLDEN_DEMO_TENANT))?.state,
      'SUCCEEDED',
    );
    assert.equal(tickets.createInvocations, 1);
  } finally {
    await worker.stop();
  }
}

async function checkApprovalRejectionFailed(baseUrl: string): Promise<void> {
  const proposed = await postJson(baseUrl, '/v1/actions', {
    ...BASE_ACTION,
    destination: 'demo://tickets/approval',
    idempotencyKey: 'l4-a-reject',
  });
  assert.equal(proposed.status, 202);
  const action = (await proposed.json()) as { action: { runId: string; state: string } };
  assert.equal(action.action.state, 'AWAITING_APPROVAL');

  const rejected = await postJson(baseUrl, `/v1/actions/${action.action.runId}/reject`, {
    reason: 'l4-a demo rejection',
  });
  assert.equal(rejected.status, 200);
  const rejectedPayload = (await rejected.json()) as { action: { state: string } };
  assert.equal(rejectedPayload.action.state, 'FAILED');

  const current = await fetch(`${baseUrl}/v1/actions/${action.action.runId}`);
  assert.equal(current.status, 200);
  assert.equal(((await current.json()) as { action: { state: string } }).action.state, 'FAILED');
}

async function checkExactApprovalBinding(baseUrl: string, gateway: InMemoryGateway): Promise<void> {
  const proposed = await postJson(baseUrl, '/v1/actions', {
    ...BASE_ACTION,
    destination: 'demo://tickets/approval',
    idempotencyKey: 'l4-a-binding',
  });
  const action = (
    (await proposed.json()) as {
      action: {
        runId: string;
        simulation: { actionDigest: string; simulationId: string; policySnapshotId: string };
      };
    }
  ).action;

  const rejected = await postJson(baseUrl, `/v1/actions/${action.runId}/approve`, {
    actionDigest: '0'.repeat(64),
    simulationId: action.simulation.simulationId,
    policySnapshotId: action.simulation.policySnapshotId,
  });
  assert.equal(rejected.status, 409);
  assert.equal(
    ((await rejected.json()) as { error: { code: string } }).error.code,
    'ACTION_DIGEST_MISMATCH',
  );

  const evaluator = createWorkerPolicyEvaluator(gateway.repository);
  const mutatedRun = 'l4-a-mutated-run';
  const stepId = `${mutatedRun}-step`;
  const effectId = `${mutatedRun}-effect`;
  const interactionId = `${mutatedRun}-interaction`;
  const envelope = {
    tenantId: GOLDEN_DEMO_TENANT,
    source: BASE_ACTION.source,
    package: BASE_ACTION.package,
    model: BASE_ACTION.model,
    tool: BASE_ACTION.tool,
    destination: 'demo://tickets/approval',
    effectType: BASE_ACTION.effectType,
    args: { title: 'Approved title' },
    idempotencyKey: 'l4-a-mutated-key',
  };
  const actionDigest = canonicalRequestHash(envelope);
  const simulationId = `${mutatedRun}-simulation`;
  await gateway.repository.createRun(
    {
      id: mutatedRun,
      tenantId: GOLDEN_DEMO_TENANT,
      intentHash: 'l4-a-intent',
      workGraphHash: 'l4-a-graph',
      workGraphVersion: 'action-gateway/v1',
      policySnapshotId: 'action-gateway-mvp-v1',
      metadata: {
        actionGateway: {
          authority: 'commander.action-gateway/v1',
          stepId,
          effectId,
          interactionId,
          actionDigest,
          policySnapshotId: 'action-gateway-mvp-v1',
          decision: {
            effect: 'require_approval',
            decisionId: 'action-gateway-require_approval',
            reason: 'approval',
            policySnapshotId: 'action-gateway-mvp-v1',
          },
          simulation: {
            simulationId,
            actionDigest,
            effect: 'require_approval',
            decisionId: 'action-gateway-require_approval',
            reason: 'approval',
            policySnapshotId: 'action-gateway-mvp-v1',
          },
          envelope,
        },
      },
      steps: [
        {
          id: stepId,
          kind: 'tool',
          initialState: 'WAITING_FOR_HUMAN',
          interaction: { id: interactionId, prompt: 'Approve?' },
          input: {
            toolName: envelope.tool,
            effectType: envelope.effectType,
            args: { title: 'Mutated title' },
            actionEnvelope: { ...envelope, args: { title: 'Mutated title' } },
            effectId,
            idempotencyKey: envelope.idempotencyKey,
            policySnapshotId: 'action-gateway-mvp-v1',
          },
        },
      ],
    },
    'l4-a-demo',
  );
  await gateway.repository.answerInteraction({
    interactionId,
    runId: mutatedRun,
    tenantId: GOLDEN_DEMO_TENANT,
    response: {
      approved: true,
      actionDigest,
      simulationId,
      policySnapshotId: 'action-gateway-mvp-v1',
      reviewer: 'l4-a-demo-key',
      runId: mutatedRun,
      tenantId: GOLDEN_DEMO_TENANT,
    },
    actor: 'l4-a-demo-key',
  });
  const decision = await evaluator.evaluate({
    tenantId: GOLDEN_DEMO_TENANT,
    runId: mutatedRun,
    stepId,
    type: 'demo.ticket.create',
    request: { ...envelope, tenantId: GOLDEN_DEMO_TENANT },
    token: {} as never,
  });
  assert.equal(decision.effect, 'deny');
  assert.equal(decision.reason, 'ACTION_DIGEST_MISMATCH');
}

async function checkKillSwitchBlocks(baseUrl: string, gateway: InMemoryGateway): Promise<void> {
  const enabled = await fetch(
    `${baseUrl}/v1/actions/kill-switches/tool/${encodeURIComponent('ticket.create')}`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, reason: 'l4-a demo maintenance' }),
    },
  );
  assert.equal(enabled.status, 200);

  const blocked = await postJson(baseUrl, '/v1/actions/simulate', {
    ...BASE_ACTION,
    idempotencyKey: 'l4-a-kill-sim',
  });
  assert.equal(blocked.status, 403);
  assert.equal(
    ((await blocked.json()) as { error: { code: string } }).error.code,
    'KILL_SWITCH_ACTIVE',
  );

  await gateway.repository.removeKillSwitch({
    tenantId: GOLDEN_DEMO_TENANT,
    scope: 'tool',
    value: 'ticket.create',
    actor: 'l4-a-demo',
  });

  const proposed = await postJson(baseUrl, '/v1/actions', {
    ...BASE_ACTION,
    destination: 'demo://tickets/approval',
    idempotencyKey: 'l4-a-kill-after-approval',
  });
  const action = (
    (await proposed.json()) as {
      action: {
        runId: string;
        simulation: { actionDigest: string; simulationId: string; policySnapshotId: string };
      };
    }
  ).action;
  const approved = await postJson(
    baseUrl,
    `/v1/actions/${action.runId}/approve`,
    approvalBinding(action),
  );
  assert.equal(approved.status, 200);

  await gateway.putKillSwitch({
    tenantId: GOLDEN_DEMO_TENANT,
    scope: 'tool',
    value: 'ticket.create',
    enabled: true,
    reason: 'post-approval block',
    actor: 'l4-a-demo',
  });

  const evaluator = createWorkerPolicyEvaluator(gateway.repository);
  const decision = await evaluator.evaluate({
    tenantId: GOLDEN_DEMO_TENANT,
    runId: action.runId,
    stepId: (await gateway.repository.getRun(action.runId, GOLDEN_DEMO_TENANT))!.metadata
      .actionGateway!.stepId as string,
    type: 'demo.ticket.create',
    request: {
      ...BASE_ACTION,
      tenantId: GOLDEN_DEMO_TENANT,
      destination: 'demo://tickets/approval',
      idempotencyKey: 'l4-a-kill-after-approval',
    },
    token: {} as never,
  });
  assert.equal(decision.effect, 'deny');
  assert.equal(decision.reason, 'KILL_SWITCH_ACTIVE');
}

async function checkEvidenceVerification(baseUrl: string, gateway: InMemoryGateway): Promise<void> {
  const proposed = await postJson(baseUrl, '/v1/actions', {
    ...BASE_ACTION,
    destination: 'demo://tickets/approval',
    idempotencyKey: 'l4-a-evidence',
    args: {
      title: 'SENSITIVE_TOOL_ARGUMENT',
      Authorization: 'Bearer SENSITIVE_AUTH_TOKEN',
    },
  });
  const payload = (await proposed.json()) as {
    action: {
      runId: string;
      simulation: { actionDigest: string; simulationId: string; policySnapshotId: string };
    };
  };
  const approved = await postJson(
    baseUrl,
    `/v1/actions/${payload.action.runId}/approve`,
    approvalBinding(payload.action),
  );
  assert.equal(approved.status, 200);

  const claimed = await gateway.repository.claimNextStep({
    workerId: 'l4-a-evidence-worker',
    workerGeneration: 1,
    tenantId: GOLDEN_DEMO_TENANT,
    capabilities: ['tool'],
    leaseTtlMs: 30_000,
  });
  assert.ok(claimed?.lease);
  const run = await gateway.repository.getRun(payload.action.runId, GOLDEN_DEMO_TENANT);
  const metadata = run!.metadata.actionGateway as {
    effectId: string;
    envelope: Record<string, unknown>;
    actionDigest: string;
    policySnapshotId: string;
  };
  await gateway.repository.admitEffect({
    id: metadata.effectId,
    runId: run!.id,
    stepId: claimed.id,
    tenantId: GOLDEN_DEMO_TENANT,
    type: 'demo.ticket.create',
    idempotencyKey: 'l4-a-evidence',
    policyDecisionId: 'action-gateway-allow-after-approval',
    policySnapshotId: metadata.policySnapshotId,
    actionDigest: metadata.actionDigest,
    request: metadata.envelope,
    lease: claimed.lease,
    actor: 'l4-a-evidence-worker',
  });
  const response = {
    status: 'ok',
    body: 'SENSITIVE_EFFECT_RESPONSE',
    access_token: 'SENSITIVE_RESPONSE_TOKEN',
  };
  const recordedAt = new Date().toISOString();
  const evidenceRecord = await buildTerminalEvidenceRecordFromKernel({
    kernel: {
      listEffectsForRun: (runId, tenantId) => gateway.repository.listEffectsForRun(runId, tenantId),
      listEvents: (runId, tenantId) => gateway.repository.listEvents(runId, tenantId),
    },
    signer: gateway.evidenceSigner,
    tenantId: GOLDEN_DEMO_TENANT,
    runId: run!.id,
    effectId: metadata.effectId,
    projectedState: 'COMPLETED',
    response,
    terminalEvent: {
      type: 'effect.completed',
      severity: 'low',
      details: { source: 'l4-a-golden-demo' },
    },
    recordedAt,
    retentionUntil: new Date(Date.parse(recordedAt) + 60 * 60 * 1_000).toISOString(),
  });
  await gateway.repository.completeEffectWithEvidence(
    metadata.effectId,
    GOLDEN_DEMO_TENANT,
    claimed.lease,
    response,
    'l4-a-evidence-worker',
    evidenceRecord,
  );
  await gateway.repository.completeStep({
    stepId: claimed.id,
    tenantId: GOLDEN_DEMO_TENANT,
    lease: claimed.lease,
    expectedVersion: claimed.version,
    output: { status: 'ok' },
    actor: 'l4-a-evidence-worker',
  });

  const evidence = await fetch(`${baseUrl}/v1/actions/${payload.action.runId}/evidence`);
  assert.equal(evidence.status, 200);
  const evidenceText = await evidence.text();
  const evidencePayload = JSON.parse(evidenceText) as {
    receipt: {
      schemaVersion: string;
      scope: { runId: string };
      effects: Array<{ responseSummary: { status: string } }>;
    };
    verification: { ok: boolean };
  };
  assert.equal(evidencePayload.receipt.schemaVersion, 'l3-11.v0');
  assert.equal(evidencePayload.receipt.scope.runId, payload.action.runId);
  assert.equal(evidencePayload.verification.ok, true);
  assert.equal(verifyEvidenceBundle(evidencePayload.receipt as never).ok, true);
  for (const secret of [
    'SENSITIVE_TOOL_ARGUMENT',
    'SENSITIVE_AUTH_TOKEN',
    'SENSITIVE_EFFECT_RESPONSE',
    'SENSITIVE_RESPONSE_TOKEN',
  ]) {
    assert.equal(evidenceText.includes(secret), false, `evidence leaked ${secret}`);
  }
}

async function checkCompletionUnknown(baseUrl: string, gateway: InMemoryGateway): Promise<void> {
  const proposed = await postJson(baseUrl, '/v1/actions', {
    ...BASE_ACTION,
    destination: 'demo://tickets/approval',
    idempotencyKey: 'l4-a-unknown',
  });
  const action = (
    (await proposed.json()) as {
      action: {
        runId: string;
        simulation: { actionDigest: string; simulationId: string; policySnapshotId: string };
      };
    }
  ).action;
  const approved = await postJson(
    baseUrl,
    `/v1/actions/${action.runId}/approve`,
    approvalBinding(action),
  );
  assert.equal(approved.status, 200);

  const claimed = await gateway.repository.claimNextStep({
    workerId: 'l4-a-unknown-worker',
    workerGeneration: 1,
    tenantId: GOLDEN_DEMO_TENANT,
    capabilities: ['tool'],
    leaseTtlMs: 30_000,
  });
  assert.ok(claimed?.lease);
  const run = await gateway.repository.getRun(action.runId, GOLDEN_DEMO_TENANT);
  const metadata = run!.metadata.actionGateway as {
    effectId: string;
    envelope: Record<string, unknown>;
    actionDigest: string;
    policySnapshotId: string;
  };
  await gateway.repository.admitEffect({
    id: metadata.effectId,
    runId: action.runId,
    stepId: claimed.id,
    tenantId: GOLDEN_DEMO_TENANT,
    type: 'demo.ticket.create',
    idempotencyKey: 'l4-a-unknown',
    policyDecisionId: 'action-gateway-allow-after-approval',
    policySnapshotId: metadata.policySnapshotId,
    actionDigest: metadata.actionDigest,
    request: metadata.envelope,
    lease: claimed.lease,
    actor: 'l4-a-unknown-worker',
  });
  await gateway.repository.markEffectCompletionUnknown({
    effectId: metadata.effectId,
    tenantId: GOLDEN_DEMO_TENANT,
    reason: 'remote completion uncertain',
    actor: 'l4-a-unknown-worker',
  });

  const current = await fetch(`${baseUrl}/v1/actions/${action.runId}`);
  assert.equal(
    ((await current.json()) as { action: { state: string } }).action.state,
    'COMPLETION_UNKNOWN',
  );
}

async function checkReconcile(baseUrl: string, gateway: InMemoryGateway): Promise<void> {
  const proposed = await postJson(baseUrl, '/v1/actions', {
    ...BASE_ACTION,
    destination: 'demo://tickets/approval',
    idempotencyKey: 'l4-a-reconcile',
  });
  const action = (
    (await proposed.json()) as {
      action: {
        runId: string;
        simulation: { actionDigest: string; simulationId: string; policySnapshotId: string };
      };
    }
  ).action;

  // propose 仅创建 run/step，effect 尚未 admit：契约为 404 ACTION_NOT_FOUND
  const noUnknown = await postJson(baseUrl, `/v1/actions/${action.runId}/reconcile`, {});
  assert.equal(noUnknown.status, 404);
  assert.equal(
    ((await noUnknown.json()) as { error: { code: string } }).error.code,
    'ACTION_NOT_FOUND',
  );

  const approved = await postJson(
    baseUrl,
    `/v1/actions/${action.runId}/approve`,
    approvalBinding(action),
  );
  assert.equal(approved.status, 200);

  const claimed = await gateway.repository.claimNextStep({
    workerId: 'l4-a-reconcile-worker',
    workerGeneration: 1,
    tenantId: GOLDEN_DEMO_TENANT,
    capabilities: ['tool'],
    leaseTtlMs: 30_000,
  });
  assert.ok(claimed?.lease);
  const run = await gateway.repository.getRun(action.runId, GOLDEN_DEMO_TENANT);
  const metadata = run!.metadata.actionGateway as {
    effectId: string;
    envelope: Record<string, unknown>;
    actionDigest: string;
    policySnapshotId: string;
  };
  await gateway.repository.admitEffect({
    id: metadata.effectId,
    runId: action.runId,
    stepId: claimed.id,
    tenantId: GOLDEN_DEMO_TENANT,
    type: 'demo.ticket.create',
    idempotencyKey: 'l4-a-reconcile',
    policyDecisionId: 'action-gateway-allow-after-approval',
    policySnapshotId: metadata.policySnapshotId,
    actionDigest: metadata.actionDigest,
    request: metadata.envelope,
    lease: claimed.lease,
    actor: 'l4-a-reconcile-worker',
  });
  await gateway.repository.markEffectCompletionUnknown({
    effectId: metadata.effectId,
    tenantId: GOLDEN_DEMO_TENANT,
    reason: 'timeout after remote commit',
    actor: 'l4-a-reconcile-worker',
  });

  const reconcile = await postJson(baseUrl, `/v1/actions/${action.runId}/reconcile`, {});
  assert.equal(reconcile.status, 202);
  const reconcilePayload = (await reconcile.json()) as {
    scheduled: boolean;
    effectId: string;
    state: string;
  };
  assert.equal(reconcilePayload.scheduled, true);
  assert.equal(reconcilePayload.effectId, metadata.effectId);
  assert.equal(reconcilePayload.state, 'COMPLETION_UNKNOWN');
}

async function checkSdkPolicyEquivalence(baseUrl: string): Promise<void> {
  const input = {
    ...BASE_ACTION,
    idempotencyKey: 'l4-a-sdk-equiv',
  };
  const direct = await postJson(baseUrl, '/v1/actions/simulate', input);
  assert.equal(direct.status, 200);
  const directSimulation = ((await direct.json()) as { simulation: Record<string, unknown> })
    .simulation;

  const client = new CommanderGatewayClient({
    baseUrl,
    apiKey: 'l4-a-demo-key',
  });
  const sdkResult = await client.simulateAction(input);
  assert.equal(sdkResult.simulation.effect, directSimulation.effect);
  assert.equal(sdkResult.simulation.actionDigest, directSimulation.actionDigest);
  assert.equal(sdkResult.simulation.policySnapshotId, directSimulation.policySnapshotId);
  assert.equal(sdkResult.simulation.decisionId, directSimulation.decisionId);
}

const CHECK_RUNNERS: Record<
  Exclude<GoldenDemoCheckName, 'cleanup'>,
  (baseUrl: string, gateway: InMemoryGateway) => Promise<void>
> = {
  'policy-simulation': (baseUrl) => checkPolicySimulation(baseUrl),
  'propose-approve-execute': (baseUrl, gateway) => checkProposeApproveExecute(baseUrl, gateway),
  'approval-rejection-failed': (baseUrl) => checkApprovalRejectionFailed(baseUrl),
  'exact-approval-binding': (baseUrl, gateway) => checkExactApprovalBinding(baseUrl, gateway),
  'kill-switch-blocks': (baseUrl, gateway) => checkKillSwitchBlocks(baseUrl, gateway),
  'evidence-verification': (baseUrl, gateway) => checkEvidenceVerification(baseUrl, gateway),
  'completion-unknown': (baseUrl, gateway) => checkCompletionUnknown(baseUrl, gateway),
  reconcile: (baseUrl, gateway) => checkReconcile(baseUrl, gateway),
  'sdk-policy-equivalence': (baseUrl) => checkSdkPolicyEquivalence(baseUrl),
};

async function checkHarnessCleanup(
  harness: DemoHarness,
  previousEvidenceJwks: string | undefined,
): Promise<void> {
  await harness.close();
  assert.equal(harness.closed, true);
  assert.equal(process.env.COMMANDER_EVIDENCE_JWKS_JSON, previousEvidenceJwks);
  await assert.rejects(
    fetch(`${harness.baseUrl}/v1/actions/simulate`),
    (error: unknown) => error instanceof TypeError,
  );
}

export async function runGoldenDemo(options: { silent?: boolean } = {}): Promise<GoldenDemoResult> {
  const started = Date.now();
  const checks: GoldenDemoCheckResult[] = [];

  for (const name of GOLDEN_DEMO_CHECKS) {
    const previousEvidenceJwks = process.env.COMMANDER_EVIDENCE_JWKS_JSON;
    const gateway = new InMemoryGateway();
    const harness = await startHarness(gateway);
    try {
      try {
        if (name === 'cleanup') {
          await checkHarnessCleanup(harness, previousEvidenceJwks);
        } else {
          await CHECK_RUNNERS[name](harness.baseUrl, gateway);
        }
        checks.push({ name, passed: true });
        if (!options.silent) {
          console.log(`[l4-a-golden-demo] PASS ${name}`);
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        checks.push({ name, passed: false, detail });
        if (!options.silent) {
          console.log(`[l4-a-golden-demo] FAIL ${name}: ${detail}`);
        }
      }
    } finally {
      await harness.close();
    }
  }

  const result: GoldenDemoResult = {
    mode: GOLDEN_DEMO_MODE,
    checks,
    allPassed: checks.every((check) => check.passed),
    elapsedMs: Date.now() - started,
  };

  if (!options.silent) {
    const passed = checks.filter((check) => check.passed).length;
    console.log(
      `[l4-a-golden-demo] mode=${result.mode} checks=${passed}/${checks.length} elapsedMs=${result.elapsedMs}`,
    );
    console.log('[l4-a-golden-demo] SDK example: packages/sdk/examples/governed-action.ts');
    console.log(
      '[l4-a-golden-demo] Python example: packages/python-sdk/examples/governed_action.py',
    );
  }

  return result;
}

async function main(): Promise<void> {
  console.log(`[l4-a-golden-demo] starting (${GOLDEN_DEMO_MODE} harness)`);
  const result = await runGoldenDemo();
  if (!result.allPassed) {
    process.exitCode = 1;
  }
}

const isMain =
  process.argv[1]?.endsWith('l4-a-golden-demo.ts') ||
  process.argv[1]?.endsWith('l4-a-golden-demo.js');

if (isMain) {
  main().catch((error) => {
    console.error('[l4-a-golden-demo] fatal', error);
    process.exit(1);
  });
}
