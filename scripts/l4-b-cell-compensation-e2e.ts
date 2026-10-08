#!/usr/bin/env tsx
/**
 * L4-B cell compensation E2E — compose topology + adapter-ops consumer proof.
 *
 *   pnpm cell:compensation-e2e -- --mode mock
 *   pnpm cell:compensation-e2e -- --mode compose [--up]
 */

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { GITHUB_PULL_REQUEST_CREATE_DESCRIPTOR } from '@praetor/contracts';
import { KERNEL_COMPENSATION_TOPIC, type KernelCompensationRequest } from '@praetor/kernel';
import { InMemoryKernelRepository } from '@praetor/kernel/testing/inMemoryRepository';
// Root package.json does not declare @praetor/action-adapters, so the bare
// specifier cannot resolve from scripts/; import the workspace source directly.
import {
  ActionAdapterRegistry,
  createGitHubPullRequestCreateAdapter,
} from '../packages/action-adapters/src/index.js';
import { CompensationDaemon } from '../packages/adapter-ops/src/compensationDaemon.js';
import { canonicalCompensationHash } from '../packages/kernel/src/ops/compensationAuthority.js';
import type { DurableCompensationMetadataAuthorization as GovernedCompensationMetadataAuthorization } from '../packages/kernel/src/ops/compensationPersistence.js';
import {
  assertComposeCellHealth,
  CELL_COMPOSE_ENV,
  CELL_E2E_TENANT,
  tryComposeCellUp,
} from './l4-b-cell-compose.js';
import {
  loadControlledChangeProofArtifact,
  notReadyControlledChangeEvidence,
  validateControlledChangeEvidence,
  type ControlledChangeCellEvidence,
} from './l4-b-cell-smoke.js';

import {
  COMPENSATION_COMPOSE_CMD,
  prepareCompensationFixture,
  seedCompensationFixturePolicy,
  verifyCompensationFixture,
} from './cell-compensation-fixture.js';

export { notReadyControlledChangeEvidence } from './l4-b-cell-smoke.js';

export type CompensationE2EMode = 'mock' | 'compose';

export interface CompensationE2EResult {
  mode: CompensationE2EMode;
  verdict: 'ENFORCED' | 'ENFORCED-script-only' | 'BLOCKED';
  passed: boolean;
  steps: Record<string, boolean | string>;
  controlledChange: ControlledChangeCellEvidence;
  dockerError?: string;
  elapsedMs: number;
}

export { assertComposeCellHealth, CELL_COMPOSE_ENV, CELL_E2E_TENANT, tryComposeCellUp };

async function httpJson(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
  idempotencyKey?: string,
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const apiKey = CELL_COMPOSE_ENV.COMMANDER_API_KEY;
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      // Prefer x-api-key only — Authorization: Bearer is interpreted as JWT.
      // CI generates a fresh key for each compose stack; local mock compose
      // keeps the deterministic fallback from CELL_COMPOSE_ENV.
      'x-api-key': apiKey,
      'x-tenant-id': CELL_E2E_TENANT,
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const error = json?.error;
    const code =
      typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    const safeCode = typeof code === 'string' && /^[A-Z_]{1,80}$/.test(code) ? code : 'UNKNOWN';
    console.error(`Cell HTTP ${method} ${path}: status=${res.status} code=${safeCode}`);
  }
  return { status: res.status, json };
}

export interface AdapterOpsCompensationMockEvidence {
  consumed: number;
  succeeded: number;
  escalated: number;
  replayed: number;
  executions: number;
  genericClaimTopics: string[];
  remainingCompensationOutbox: number;
  compensationEffectId: string;
  compensationEffectState: string | null;
  compensationEffectResponse: Record<string, unknown> | null;
  compensationRunState: string | null;
}

/** Single source of truth for the mock-mode pass criterion (script + test). */
export function adapterOpsCompensationMockPassed(
  evidence: AdapterOpsCompensationMockEvidence,
): boolean {
  return (
    evidence.consumed === 1 &&
    evidence.succeeded === 1 &&
    evidence.escalated === 0 &&
    evidence.executions === 1 &&
    evidence.compensationEffectState === 'COMPLETED' &&
    evidence.remainingCompensationOutbox === 0
  );
}

export async function runAdapterOpsCompensationMock(): Promise<AdapterOpsCompensationMockEvidence> {
  const adapter = createGitHubPullRequestCreateAdapter({
    credentials: {
      async getGitHubToken() {
        return 'gh-mock';
      },
      async getServiceNowCredentials() {
        throw new Error('not used');
      },
    },
  });
  const registry = new ActionAdapterRegistry([adapter]);
  const kernel = new InMemoryKernelRepository();
  const tenantId = 'adapter-ops-mock-tenant';
  const workerId = 'adapter-ops-mock';
  const workerGeneration = 1;
  // In-memory compensation claims are fail-closed on the durable adapter-ops
  // identity: exactly one `effect.compensate` capability on `db:commander_adapter_ops`.
  const claimSecret = kernel.seedTestWorker(workerId, [tenantId], workerGeneration, {
    capabilities: ['effect.compensate'],
    identitySubject: 'db:commander_adapter_ops',
    registeredAt: new Date(Date.now() - 1_000),
    lastHeartbeatAt: new Date(),
  });

  // ── Forward (original) run + COMPLETED forward effect. The durable compensation
  // authorization binds to this effect, and `requestCompensation` re-derives the
  // action digest from the effect's request.destination + response, so both must
  // exist before the authorization is created.
  const forwardWorkerId = 'forward-exec-mock';
  const forwardWorkerGeneration = 1;
  const forwardSecret = kernel.seedTestWorker(
    forwardWorkerId,
    [tenantId],
    forwardWorkerGeneration,
    {
      capabilities: ['agent', 'tool'],
    },
  );
  const forwardRequest = { destination: 'github://octo/repo/pulls' };
  const forwardResponse = { prNumber: 1 };
  await kernel.createRun(
    {
      id: 'run-cmp-forward',
      tenantId,
      intentHash: 'intent-adapter-ops-forward',
      workGraphHash: 'graph-adapter-ops-forward',
      workGraphVersion: 'v1',
      policySnapshotId: 'policy-adapter-ops-mock',
      steps: [{ id: 'step-forward', kind: 'tool' }],
    },
    forwardWorkerId,
  );
  const forwardStep = await kernel.claimNextStep({
    workerId: forwardWorkerId,
    workerGeneration: forwardWorkerGeneration,
    claimSecret: forwardSecret,
    capabilities: ['tool'],
    leaseTtlMs: 60_000,
  });
  if (!forwardStep?.lease) throw new Error('forward step claim failed');
  const forwardAdmitted = await kernel.admitEffect({
    id: 'effect-forward',
    runId: 'run-cmp-forward',
    stepId: forwardStep.id,
    tenantId,
    // `read.*` is outside the Class A family, so a forward effect needs no
    // operations readiness that the seeding below is not responsible for.
    type: 'read.github.pull-request',
    idempotencyKey: 'forward-adapter-ops-mock',
    policyDecisionId: 'decision-adapter-ops-mock',
    policySnapshotId: 'policy-adapter-ops-mock',
    actionDigest: 'a'.repeat(64),
    request: forwardRequest,
    lease: forwardStep.lease,
    actor: forwardWorkerId,
  });
  if (!forwardAdmitted.admitted) {
    throw new Error(`forward effect admission failed: ${forwardAdmitted.reason}`);
  }
  const forwardCompleted = await kernel.completeEffect(
    'effect-forward',
    tenantId,
    forwardStep.lease,
    forwardResponse,
    forwardWorkerId,
  );
  if (!forwardCompleted) throw new Error('forward effect completion failed');

  // ── Durable authorization + durable request. `requestCompensation` is what
  // publishes the governed compensation outbox row, so the fixture must never
  // seed that row by hand: the claim guard resolves the durable request and its
  // sealed authorization, and drops (marks published) any message it cannot
  // resolve.
  const compensationPatch = { state: 'closed' };
  const authorizationRecord = {
    id: 'authorization-adapter-ops-mock',
    tenantId,
    originalRunId: 'run-cmp-forward',
    originalEffectId: 'effect-forward',
    compensationEffectType: adapter.descriptor.compensationEffectType,
    adapterVersion: adapter.descriptor.adapterVersion,
    compensationPatch,
    forwardReceiptHash: canonicalCompensationHash(forwardResponse),
    policyDecisionId: 'decision-adapter-ops-mock',
    policySnapshotId: 'policy-adapter-ops-mock',
    decision: 'allow' as const,
    actionDigest: canonicalCompensationHash({
      type: adapter.descriptor.compensationEffectType,
      originalEffectId: 'effect-forward',
      adapterVersion: adapter.descriptor.adapterVersion,
      destination: forwardRequest.destination,
      forwardResponse,
      compensationPatch,
    }),
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  };
  await kernel.createCompensationAuthorization(authorizationRecord);
  const requested = await kernel.requestCompensation({
    tenantId,
    authorizationId: authorizationRecord.id,
    actor: 'action-gateway',
  });
  if (!requested.accepted) {
    throw new Error(`compensation request rejected: ${requested.reason}`);
  }
  const durableRequest = requested.request;
  // `requestCompensation` creates the compensation run and step itself (with the
  // durable authorization on the run metadata AND the step input), so the fixture
  // must not create them: doing so collides with DUPLICATE_RUN. Read back exactly
  // what the repository persisted instead of rebuilding it.
  const compensationRun = await kernel.getRun(durableRequest.compensationRunId, tenantId);
  const authorization = (
    compensationRun?.metadata?.compensation as
      { authorization: GovernedCompensationMetadataAuthorization } | undefined
  )?.authorization;
  if (!authorization) throw new Error('compensation run metadata authorization missing');

  kernel.seedOutboxMessage({
    topic: 'commander.run.created',
    tenantId,
    key: `${tenantId}/generic`,
    payload: { tenantId, runId: 'run-generic' },
  });

  const genericClaims = await kernel.claimOutbox(10);
  const genericClaimTopics = genericClaims.map((message) => message.topic);
  assert.ok(
    genericClaimTopics.includes('commander.run.created') &&
      !genericClaimTopics.includes(KERNEL_COMPENSATION_TOPIC),
    'kernel-ops publisher must not steal compensation topic',
  );

  let executions = 0;
  let admittedLease: {
    workerId: string;
    workerGeneration?: number;
    token: string;
    fencingEpoch: number;
  } | null = null;

  const daemon = new CompensationDaemon({
    repository: kernel,
    registry,
    broker: {
      admit: async (input: {
        effectId: string;
        type: string;
        request: Record<string, unknown>;
        idempotencyKey: string;
        lease: { workerId: string; workerGeneration?: number; token: string; fencingEpoch: number };
      }) => {
        admittedLease = input.lease;
        const admission = await kernel.admitEffect({
          id: input.effectId,
          runId: authorization.compensationRunId,
          stepId: authorization.compensationStepId,
          tenantId,
          type: input.type,
          idempotencyKey: input.idempotencyKey,
          policyDecisionId: authorization.policyDecisionId,
          policySnapshotId: authorization.policySnapshotId,
          actionDigest: authorization.actionDigest,
          request: input.request,
          lease: {
            ...input.lease,
            workerGeneration: input.lease.workerGeneration ?? workerGeneration,
          },
          compensationBinding: {
            authorizationId: authorization.authorizationId,
            requestId: authorization.requestId,
            claimToken: input.lease.token,
          },
          actor: workerId,
        });
        return admission.admitted
          ? { admitted: true, effectId: admission.effect.id, replayed: admission.replayed }
          : {
              admitted: false,
              effectId: input.effectId,
              replayed: false,
              reason: admission.reason,
            };
      },
      executeAdmitted: async (input: { effectId: string }) => {
        if (!admittedLease) {
          throw new Error('compensation effect was not admitted before execution');
        }
        executions += 1;
        const lease = {
          workerId: admittedLease.workerId,
          workerGeneration: admittedLease.workerGeneration ?? workerGeneration,
          token: admittedLease.token,
          fencingEpoch: admittedLease.fencingEpoch,
        };
        const admitted = await kernel.getEffect(input.effectId, tenantId);
        if (!admitted) throw new Error('compensation effect not found before completion');
        // Completion must carry terminal evidence: the daemon builds the
        // compensation's own terminal evidence from it and fails closed with
        // TERMINAL_EVIDENCE_REQUIRED when the completed effect has none.
        const bundleId = `evidence_${admitted.id}`;
        const contentHash = 'e'.repeat(64);
        const signature = {
          algorithm: 'Ed25519' as const,
          keyId: 'adapter-ops-mock-key',
          signedAt: '2026-08-05T00:00:00.000Z',
          value: 'adapter-ops-mock-signature',
        };
        const completed = await kernel.completeEffectWithEvidence(
          input.effectId,
          tenantId,
          lease,
          { state: 'closed' },
          workerId,
          {
            tenantId,
            runId: admitted.runId,
            bundleId,
            actionDigest: admitted.actionDigest,
            body: {
              bodyVersion: 'commander.evidence-body/v1',
              bundleId,
              actionDigest: admitted.actionDigest,
              contentHash,
              terminalDisposition: 'SUCCEEDED',
              scope: { tenantId, runId: admitted.runId, effectId: admitted.id },
              effects: [{ effectId: admitted.id, state: 'COMPLETED' }],
              auditEvents: [{ type: 'compensation.completed' }],
              signature,
            },
            contentHash,
            signature,
            createdAt: '2026-08-05T00:00:00.000Z',
            anchoredAt: '2026-08-05T00:00:01.000Z',
            retentionUntil: '2027-08-05T00:00:00.000Z',
          },
        );
        if (!completed) throw new Error('compensation effect completion was rejected');
        return {
          effectId: completed.id,
          replayed: false,
          response: { state: 'closed' },
        };
      },
    },
    tokenProvider: async () => 'cmp-token',
    // The daemon builds terminal evidence for the compensation effect; without
    // this lifecycle repository it fails closed with TERMINAL_EVIDENCE_REQUIRED.
    evidenceRepository: kernel,
    pollIntervalMs: 60_000,
    workerId,
    workerGeneration,
    claimSecret,
  });

  const tick = await daemon.tick();
  const effect = await kernel.getEffect(authorization.compensationEffectId, tenantId);
  const run = await kernel.getRun(authorization.compensationRunId, tenantId);
  const remaining = await kernel.claimOutboxByTopic(KERNEL_COMPENSATION_TOPIC, 10);
  return {
    consumed: tick.consumed,
    succeeded: tick.succeeded,
    escalated: tick.escalated,
    replayed: tick.replayed,
    executions,
    genericClaimTopics,
    remainingCompensationOutbox: remaining.length,
    compensationEffectId: authorization.compensationEffectId,
    compensationEffectState: effect?.state ?? null,
    compensationEffectResponse: effect?.response ?? null,
    compensationRunState: run?.state ?? null,
  };
}

async function pollTerminal(
  baseUrl: string,
  path: string,
  actionProjection: boolean,
  timeoutMs = 90_000,
): Promise<Record<string, unknown> | null> {
  const terminal = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'COMPENSATED']);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { status, json } = await httpJson(baseUrl, 'GET', path);
    if (status !== 200) return null;
    const value = actionProjection ? json?.action : json;
    if (typeof value !== 'object' || value === null) return null;
    const projection = value as Record<string, unknown>;
    if (typeof projection.state === 'string' && terminal.has(projection.state)) return projection;
    await sleep(500);
  }
  return null;
}

export async function runComposeDemoCompensationFlow(
  baseUrl = 'http://localhost:4000',
): Promise<Record<string, boolean>> {
  const result = {
    proposed: false,
    approved: false,
    forwardDone: false,
    tamperRejected: false,
    authorizationReplayed: false,
    approvalTamperRejected: false,
    requestReplayed: false,
    compensated: false,
  };
  const descriptor = GITHUB_PULL_REQUEST_CREATE_DESCRIPTOR;
  const idem = `cell-comp-${Date.now()}`;
  const proposal = {
    source: 'cell-e2e',
    package: 'cell-e2e',
    model: 'mock',
    tool: descriptor.toolName,
    destination: 'github://octo/repo/pulls',
    effectType: descriptor.effectType,
    args: {
      head: 'cell-e2e',
      base: 'main',
      title: 'Cell compensation E2E',
      body: 'Canonical compensation proof',
    },
    idempotencyKey: idem,
  };
  let proposed = await httpJson(baseUrl, 'POST', '/v1/actions', proposal, idem);
  // Only the explicit worker-registration readiness error is transient.
  for (let attempt = 0; attempt < 12 && proposed.status === 503; attempt += 1) {
    const error = proposed.json?.error as { code?: unknown } | undefined;
    if (error?.code !== 'OPERATIONS_NOT_READY') break;
    await sleep(5_000);
    proposed = await httpJson(baseUrl, 'POST', '/v1/actions', proposal, idem);
  }
  if (proposed.status !== 202) {
    console.error(`Cell compensation proposal rejected: status=${proposed.status}`);
    return result;
  }
  result.proposed = true;
  const action = proposed.json?.action as
    | {
        runId?: string;
        simulation?: { actionDigest: string; simulationId: string; policySnapshotId: string };
      }
    | undefined;
  if (!action?.runId || !action.simulation) return result;
  const approved = await httpJson(
    baseUrl,
    'POST',
    `/v1/actions/${action.runId}/approve`,
    {
      actionDigest: action.simulation.actionDigest,
      simulationId: action.simulation.simulationId,
      policySnapshotId: action.simulation.policySnapshotId,
    },
    `approve-${idem}`,
  );
  if (approved.status !== 200) return result;
  result.approved = true;
  const forward = await pollTerminal(baseUrl, `/v1/actions/${action.runId}`, true);
  if (forward?.state !== 'SUCCEEDED') return result;
  result.forwardDone = true;
  if (
    typeof forward.effectId !== 'string' ||
    typeof forward.forwardReceiptHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(forward.forwardReceiptHash)
  )
    return result;
  const path = `/v1/actions/${action.runId}/compensations`;
  const request = {
    originalEffectId: forward.effectId,
    adapterVersion: descriptor.adapterVersion,
    compensationEffectType: descriptor.compensationEffectType,
    compensationPatch: {},
    forwardReceiptHash: forward.forwardReceiptHash,
  };
  const tampered = await httpJson(
    baseUrl,
    'POST',
    path,
    {
      ...request,
      forwardReceiptHash: `${request.forwardReceiptHash[0] === '0' ? '1' : '0'}${request.forwardReceiptHash.slice(1)}`,
    },
    `tamper-${idem}`,
  );
  result.tamperRejected =
    tampered.status === 409 &&
    (tampered.json?.error as { code?: unknown } | undefined)?.code === 'FORWARD_RECEIPT_MISMATCH';
  if (!result.tamperRejected) return result;
  let compensation = await httpJson(baseUrl, 'POST', path, request, `cmp-${idem}`);
  if (compensation.status !== 202) return result;
  let approvalPath: string | undefined;
  let approvalBody: { actionDigest: string; policySnapshotId: string } | undefined;
  if (compensation.json?.state === 'AWAITING_APPROVAL') {
    const authorization = compensation.json.authorization as
      | {
          id?: string;
          actionDigest?: string;
          policySnapshotId?: string;
        }
      | undefined;
    if (!authorization?.id || !authorization.actionDigest || !authorization.policySnapshotId)
      return result;
    // A distinct HTTP idempotency key proves durable authorization replay,
    // rather than merely returning the middleware's cached HTTP response.
    const replay = await httpJson(baseUrl, 'POST', path, request, `cmp-replay-${idem}`);
    const replayAuthorization = replay.json?.authorization as
      { id?: unknown; actionDigest?: unknown } | undefined;
    result.authorizationReplayed =
      replay.status === 202 &&
      replay.json?.replayed === true &&
      replayAuthorization?.id === authorization.id &&
      replayAuthorization?.actionDigest === authorization.actionDigest;
    if (!result.authorizationReplayed) return result;
    approvalPath = `${path}/${authorization.id}/approve`;
    approvalBody = {
      actionDigest: authorization.actionDigest,
      policySnapshotId: authorization.policySnapshotId,
    };
    const invalidApproval = await httpJson(
      baseUrl,
      'POST',
      approvalPath,
      {
        ...approvalBody,
        actionDigest: `${approvalBody.actionDigest[0] === '0' ? '1' : '0'}${approvalBody.actionDigest.slice(1)}`,
      },
      `cmp-approve-tamper-${idem}`,
    );
    result.approvalTamperRejected =
      invalidApproval.status === 409 &&
      (invalidApproval.json?.error as { code?: unknown } | undefined)?.code ===
        'APPROVAL_BINDING_MISMATCH';
    if (!result.approvalTamperRejected) return result;
    compensation = await httpJson(
      baseUrl,
      'POST',
      approvalPath,
      approvalBody,
      `cmp-approve-${idem}`,
    );
  }
  const compensationRequest = compensation.json?.request as
    Partial<KernelCompensationRequest> | undefined;
  const runId = compensationRequest?.compensationRunId;
  if (
    compensation.status !== 202 ||
    compensation.json?.accepted !== true ||
    typeof runId !== 'string'
  )
    return result;
  const terminal = await pollTerminal(baseUrl, `/v1/runs/${runId}/status`, false);
  if (terminal?.state !== 'SUCCEEDED') return result;
  const replay = await httpJson(
    baseUrl,
    'POST',
    approvalPath ?? path,
    approvalBody ?? request,
    `cmp-request-replay-${idem}`,
  );
  const replayRequest = replay.json?.request as Partial<KernelCompensationRequest> | undefined;
  result.requestReplayed =
    replay.status === 202 &&
    replay.json?.accepted === true &&
    replay.json?.replayed === true &&
    replayRequest?.compensationRunId === runId &&
    typeof compensationRequest?.id === 'string' &&
    replayRequest?.id === compensationRequest.id;
  result.compensated = result.requestReplayed;
  return result;
}

export async function runCellCompensationE2E(options: {
  mode?: CompensationE2EMode;
  baseUrl?: string;
  composeUp?: boolean;
  controlledChange?: ControlledChangeCellEvidence;
}): Promise<CompensationE2EResult> {
  const started = Date.now();
  const mode = options.mode ?? 'mock';
  const steps: Record<string, boolean | string> = {};
  const controlledChange = validateControlledChangeEvidence(
    options.controlledChange ?? notReadyControlledChangeEvidence(),
  );

  if (mode === 'mock') {
    try {
      steps.S_mock_adapter_ops = adapterOpsCompensationMockPassed(
        await runAdapterOpsCompensationMock(),
      );
    } catch (err) {
      steps.S_mock_adapter_ops = false;
      steps.mockError = err instanceof Error ? err.message : String(err);
    }
    const passed = steps.S_mock_adapter_ops === true;
    return {
      mode,
      verdict: passed ? 'ENFORCED-script-only' : 'BLOCKED',
      passed,
      steps,
      controlledChange,
      elapsedMs: Date.now() - started,
    };
  }

  let dockerError: string | undefined;
  const fixtureEnv = options.composeUp
    ? prepareCompensationFixture()
    : {
        CELL_GITHUB_TLS_DIR: process.env.CELL_GITHUB_TLS_DIR ?? '',
        CELL_GITHUB_TOKEN: process.env.CELL_GITHUB_TOKEN ?? '',
        CELL_GITHUB_ORACLE_TOKEN: process.env.CELL_GITHUB_ORACLE_TOKEN ?? '',
      };
  if (
    !fixtureEnv.CELL_GITHUB_TLS_DIR ||
    !fixtureEnv.CELL_GITHUB_TOKEN ||
    !fixtureEnv.CELL_GITHUB_ORACLE_TOKEN
  ) {
    return {
      mode,
      verdict: 'BLOCKED',
      passed: false,
      steps,
      controlledChange,
      dockerError: 'Compose compensation requires --up or an existing configured GitHub fixture',
      elapsedMs: Date.now() - started,
    };
  }
  if (options.composeUp) {
    const up = tryComposeCellUp(COMPENSATION_COMPOSE_CMD, fixtureEnv);
    steps.composeUp = up.ok;
    if (!up.ok) {
      return {
        mode,
        verdict: 'BLOCKED',
        passed: false,
        steps,
        controlledChange,
        dockerError: up.error,
        elapsedMs: Date.now() - started,
      };
    }
  }

  const health = await assertComposeCellHealth(options.baseUrl);
  Object.assign(steps, health);

  if (Object.values(health).some((v) => !v)) {
    return {
      mode,
      verdict: 'BLOCKED',
      passed: false,
      steps,
      controlledChange,
      dockerError,
      elapsedMs: Date.now() - started,
    };
  }

  try {
    seedCompensationFixturePolicy(fixtureEnv);
    steps.fixturePolicySeeded = true;
  } catch {
    return {
      mode,
      verdict: 'BLOCKED',
      passed: false,
      steps,
      controlledChange,
      dockerError: 'COMPENSATION_FIXTURE_POLICY_SEED_FAILED',
      elapsedMs: Date.now() - started,
    };
  }
  const flow = await runComposeDemoCompensationFlow(options.baseUrl);
  Object.assign(steps, flow);
  try {
    steps.remoteExactlyOnce = verifyCompensationFixture(fixtureEnv);
  } catch {
    steps.remoteExactlyOnce = false;
    steps.fixtureEvidenceError = 'COMPENSATION_FIXTURE_EVIDENCE_UNAVAILABLE';
  }

  // Host InMemory CompensationDaemon is informational only and does not raise compose evidence.
  // (specialized audit: S_adapter_ops_mock was greenwashing "adapter-ops consumed outbox").
  const mockOk = await runAdapterOpsCompensationMock()
    .then(adapterOpsCompensationMockPassed)
    .catch(() => false);
  steps.S_adapter_ops_mock_host = mockOk;

  const passed =
    flow.proposed === true &&
    flow.approved === true &&
    flow.forwardDone === true &&
    flow.compensated === true &&
    steps.remoteExactlyOnce === true &&
    (options.composeUp ? steps.composeUp === true : true);

  return {
    mode,
    verdict: passed ? 'ENFORCED' : 'BLOCKED',
    passed,
    steps,
    controlledChange,
    dockerError,
    elapsedMs: Date.now() - started,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const modeIdx = args.indexOf('--mode');
  const baseIdx = args.indexOf('--base-url');
  const mode = (modeIdx >= 0 ? args[modeIdx + 1] : 'compose') as CompensationE2EMode;
  const baseUrl = baseIdx >= 0 ? args[baseIdx + 1] : 'http://localhost:4000';
  const composeUp = args.includes('--up');
  const proofIdx = args.indexOf('--controlled-change-proof');
  const controlledChange = await loadControlledChangeProofArtifact(
    (proofIdx >= 0 ? args[proofIdx + 1] : undefined) ??
      process.env.COMMANDER_KUBERNETES_PROOF_ARTIFACT,
  );

  const result = await runCellCompensationE2E({ mode, baseUrl, composeUp, controlledChange });
  const outDir = join(process.cwd(), 'artifacts');
  await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, `l4-b-cell-compensation-e2e-${Date.now()}.json`);
  await writeFile(outPath, JSON.stringify(result, null, 2));
  console.log(`Cell compensation E2E steps: ${JSON.stringify(result.steps)}`);
  console.log(
    `Cell compensation E2E ${result.verdict} ${result.passed ? 'PASS' : 'FAIL'} → ${outPath}`,
  );
  if (!result.passed) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
