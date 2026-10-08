import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  consumeCompensationBatch,
  type ClaimedCompensationWork,
  type CompensationOutboxPort,
} from './compensationConsumer.js';
import {
  canonicalCompensationHash,
  sealGovernedCompensationAuthorization,
  type GovernedCompensationAuthorization,
  type GovernedCompensationAuthorizationInput,
} from './compensationAuthority.js';
import type { ClaimedCompensationRequest, CompensationAuthorizationRecord } from '../types.js';
import { deriveEffectIdempotencyKey } from '@praetor/effect-broker';

const WORKER = {
  workerId: 'compensation:pod-a',
  workerGeneration: 4,
  claimSecret: 'claim-secret-pod-a',
} as const;

function authorityInput(): GovernedCompensationAuthorizationInput {
  return {
    schema: 'commander.compensation/v1',
    authorizationId: 'authorization-1',
    requestId: 'request-1',
    tenantId: 'tenant-a',
    originalRunId: 'run-original',
    originalEffectId: 'effect-original',
    originalRunStateAtRequest: 'COMPENSATING',
    compensationRunId: 'run-compensation',
    compensationStepId: 'step-compensation',
    compensationEffectId: 'effect-compensation',
    compensationEffectType: 'compensate.kubernetes.deployment.rollback',
    compensationRequest: {
      originalEffectId: 'effect-original',
      destination: 'k8s://cluster-a/default/deployments/api',
      forwardResponse: { originalRevision: '7' },
      compensationPatch: { targetRevision: '7', reason: 'rollback' },
    },
    idempotencyKey: 'cmp:effect-original:1.0.0',
    forwardReceipt: { originalRevision: '7' },
    adapterVersion: '1.0.0',
    policyDecisionId: 'decision-1',
    policySnapshotId: 'policy-42',
    decisionEffect: 'allow',
    authorizationExpiresAt: '2099-07-29T11:00:00.000Z',
    approvalBinding: null,
  };
}

function claimed(): ClaimedCompensationRequest {
  const governed = sealGovernedCompensationAuthorization(authorityInput());
  const requestPayload = governed.compensationRequest;
  const authorization: CompensationAuthorizationRecord = {
    id: governed.authorizationId,
    tenantId: governed.tenantId,
    originalRunId: governed.originalRunId,
    originalEffectId: governed.originalEffectId,
    compensationEffectType: governed.compensationEffectType,
    adapterVersion: governed.adapterVersion,
    compensationPatch: requestPayload.compensationPatch as Record<string, unknown>,
    forwardReceiptHash: governed.forwardReceiptHash,
    policyDecisionId: governed.policyDecisionId,
    policySnapshotId: governed.policySnapshotId,
    decision: governed.decisionEffect,
    actionDigest: canonicalCompensationHash({
      type: governed.compensationEffectType,
      originalEffectId: governed.originalEffectId,
      adapterVersion: governed.adapterVersion,
      destination: requestPayload.destination,
      forwardResponse: governed.forwardReceipt,
      compensationPatch: requestPayload.compensationPatch,
    }),
    expiresAt: governed.authorizationExpiresAt,
  };
  const request: ClaimedCompensationRequest['request'] = {
    id: governed.requestId,
    tenantId: governed.tenantId,
    originalRunId: governed.originalRunId,
    originalEffectId: governed.originalEffectId,
    compensationRunId: governed.compensationRunId,
    compensationStepId: governed.compensationStepId,
    adapterVersion: governed.adapterVersion,
    compensationEffectType: governed.compensationEffectType,
    destination: String(requestPayload.destination),
    compensationPatch: requestPayload.compensationPatch as Record<string, unknown>,
    forwardReceiptHash: governed.forwardReceiptHash,
    authorizationId: governed.authorizationId,
    reconcilePolicy: {
      maxAttempts: 3,
      initialDelayMs: 1_000,
      maxDelayMs: 5_000,
      deadlineAt: governed.authorizationExpiresAt,
    },
    state: 'CLAIMED',
    claimWorkerId: WORKER.workerId,
    claimWorkerGeneration: WORKER.workerGeneration,
    claimToken: 'outbox-claim-1',
    compensationEffectId: governed.compensationEffectId,
  };
  return {
    request,
    forwardResponse: governed.forwardReceipt,
    outboxMessageId: 'outbox-1',
    outboxClaimToken: 'outbox-claim-1',
    authorization,
    lease: {
      workerId: WORKER.workerId,
      workerGeneration: WORKER.workerGeneration,
      token: 'step-lease-1',
      fencingEpoch: 12,
      expiresAt: '2099-07-29T11:00:00.000Z',
    },
  };
}

function makePort(items: ClaimedCompensationWork[] = [claimed()]) {
  const calls: Array<{ method: string; input: unknown }> = [];
  let served = false;
  const port: CompensationOutboxPort = {
    async claimCompensationWork(input) {
      calls.push({ method: 'claim', input });
      if (served) return [];
      served = true;
      return items;
    },
    async parkCompensationUnknown(input) {
      calls.push({ method: 'park', input });
      return { applied: true, disposition: 'COMPLETION_UNKNOWN', replayed: false };
    },
    async finalizeCompensation(input) {
      calls.push({ method: 'finalize', input });
      return { applied: true, disposition: input.disposition, replayed: false };
    },
  };
  return {
    port,
    calls,
    resetClaim: () => {
      served = false;
    },
  };
}

const registry = {
  resolve: (effectType: string) =>
    effectType === 'compensate.kubernetes.deployment.rollback'
      ? { descriptor: { adapterVersion: '1.0.0' } }
      : null,
};

describe('governed compensation consumer', () => {
  it('accepts a durable action digest that binds the claimed destination', async () => {
    const forwardResponse = { originalRevision: '7' };
    const compensationPatch = { targetRevision: '7', reason: 'rollback' };
    const destination = 'k8s://cluster-a/default/deployments/api';
    const authorization: CompensationAuthorizationRecord = {
      id: 'authorization-durable-destination',
      tenantId: 'tenant-a',
      originalRunId: 'run-original',
      originalEffectId: 'effect-original',
      compensationEffectType: 'compensate.kubernetes.deployment.rollback',
      adapterVersion: '1.0.0',
      compensationPatch,
      forwardReceiptHash: canonicalCompensationHash(forwardResponse),
      policyDecisionId: 'decision-durable',
      policySnapshotId: 'policy-durable',
      decision: 'allow',
      actionDigest: canonicalCompensationHash({
        type: 'compensate.kubernetes.deployment.rollback',
        originalEffectId: 'effect-original',
        adapterVersion: '1.0.0',
        destination,
        forwardResponse,
        compensationPatch,
      }),
      expiresAt: '2099-07-29T11:00:00.000Z',
    };
    const request: ClaimedCompensationRequest['request'] = {
      id: 'request-durable-destination',
      tenantId: 'tenant-a',
      originalRunId: 'run-original',
      originalEffectId: 'effect-original',
      compensationRunId: 'run-compensation',
      compensationStepId: 'step-compensation',
      adapterVersion: '1.0.0',
      compensationEffectType: authorization.compensationEffectType,
      destination,
      compensationPatch,
      forwardReceiptHash: authorization.forwardReceiptHash,
      authorizationId: authorization.id,
      reconcilePolicy: {
        maxAttempts: 3,
        initialDelayMs: 1_000,
        maxDelayMs: 5_000,
        deadlineAt: '2099-07-30T11:00:00.000Z',
      },
      state: 'CLAIMED',
      claimToken: 'request-claim-token',
      compensationEffectId: 'effect-compensation',
    };
    const work: ClaimedCompensationRequest = {
      request,
      forwardResponse,
      authorization,
      outboxMessageId: 'outbox-durable-destination',
      outboxClaimToken: 'outbox-claim-token',
      lease: {
        workerId: WORKER.workerId,
        workerGeneration: WORKER.workerGeneration,
        token: 'step-lease-token',
        fencingEpoch: 12,
        expiresAt: '2099-07-29T11:00:00.000Z',
      },
    };
    const port: CompensationOutboxPort = {
      async claimCompensationWork() {
        return [work];
      },
      async parkCompensationUnknown() {
        throw new Error('unexpected uncertainty park');
      },
      async finalizeCompensation(input) {
        return { applied: true, disposition: input.disposition, replayed: false };
      },
    };
    let admittedRequest: Record<string, unknown> | undefined;
    let admittedIdempotencyKey: string | undefined;
    const result = await consumeCompensationBatch(
      port,
      {
        async admit(input) {
          admittedRequest = input.request;
          admittedIdempotencyKey = input.idempotencyKey;
          return { admitted: true, effectId: request.compensationEffectId!, replayed: false };
        },
        async executeAdmitted() {
          return {
            effectId: request.compensationEffectId!,
            replayed: false,
            response: { ok: true },
          };
        },
      },
      async () => 'durable-token',
      { ...WORKER, registry },
    );

    assert.equal(result.succeeded, 1);
    assert.deepEqual(admittedRequest, {
      originalEffectId: request.originalEffectId,
      destination,
      forwardResponse,
      compensationPatch,
    });
    assert.equal(
      admittedIdempotencyKey,
      deriveEffectIdempotencyKey({
        tenantId: authorization.tenantId,
        runId: request.compensationRunId,
        stepId: request.compensationStepId,
        effectId: request.compensationEffectId!,
        request: admittedRequest!,
      }),
    );
  });

  it('uses persisted authorization, effect identity, and a real claimed step lease', async () => {
    const work = claimed();
    const { port, calls } = makePort([work]);
    let tokenInput: unknown;
    let admitInput: unknown;
    const result = await consumeCompensationBatch(
      port,
      {
        async admit(input) {
          admitInput = input;
          return {
            admitted: true,
            effectId: work.request.compensationEffectId!,
            replayed: false,
          };
        },
        async executeAdmitted() {
          return {
            effectId: work.request.compensationEffectId!,
            replayed: false,
            response: { status: 'rolled-back' },
          };
        },
      },
      async (input) => {
        tokenInput = input;
        return 'governed-token';
      },
      { ...WORKER, registry, limit: 10 },
    );

    assert.deepEqual(result, {
      consumed: 1,
      succeeded: 1,
      handedOff: 0,
      escalated: 0,
      replayed: 0,
    });
    assert.deepEqual(tokenInput, {
      authorization: work.authorization,
      request: work.request,
      forwardResponse: work.forwardResponse,
    });
    assert.deepEqual(admitInput, {
      effectId: work.request.compensationEffectId!,
      token: 'governed-token',
      type: work.authorization.compensationEffectType,
      request: {
        originalEffectId: work.request.originalEffectId,
        destination: work.request.destination,
        forwardResponse: work.forwardResponse,
        compensationPatch: work.request.compensationPatch,
      },
      idempotencyKey: deriveEffectIdempotencyKey({
        tenantId: work.request.tenantId,
        runId: work.request.compensationRunId,
        stepId: work.request.compensationStepId,
        effectId: work.request.compensationEffectId!,
        request: {
          originalEffectId: work.request.originalEffectId,
          destination: work.request.destination,
          forwardResponse: work.forwardResponse,
          compensationPatch: work.request.compensationPatch,
        },
      }),
      lease: work.lease,
      actor: WORKER.workerId,
      workloadBinding: {
        tenantId: work.authorization.tenantId,
        runId: work.request.compensationRunId,
        stepId: work.request.compensationStepId,
        workloadId: WORKER.workerId,
      },
      compensationClaim: {
        requestId: work.request.id,
        requestClaimToken: work.request.claimToken,
        outboxMessageId: work.outboxMessageId,
        outboxClaimToken: work.outboxClaimToken,
      },
    });
    assert.deepEqual(
      calls.map((call) => call.method),
      ['claim', 'finalize'],
    );
    assert.deepEqual(calls[1]?.input, {
      ...WORKER,
      tenantId: work.request.tenantId,
      requestId: work.request.id,
      effectId: work.request.compensationEffectId!,
      disposition: 'COMPLETED',
      actor: WORKER.workerId,
      outboxMessageId: work.outboxMessageId,
      outboxClaimToken: work.outboxClaimToken,
      response: { status: 'rolled-back' },
      evidence: undefined,
    });
  });

  it('atomically hands off completion uncertainty and never retries the write', async () => {
    const work = claimed();
    const { port, calls } = makePort([work]);
    let executeCalls = 0;
    const result = await consumeCompensationBatch(
      port,
      {
        async admit() {
          return {
            admitted: true,
            effectId: work.request.compensationEffectId!,
            replayed: false,
          };
        },
        async executeAdmitted() {
          executeCalls += 1;
          throw Object.assign(new Error('response lost'), { code: 'COMPLETION_UNKNOWN' });
        },
      },
      async () => 'token',
      { ...WORKER, registry },
    );

    assert.equal(executeCalls, 1);
    assert.deepEqual(result, {
      consumed: 1,
      succeeded: 0,
      handedOff: 1,
      escalated: 0,
      replayed: 0,
    });
    assert.deepEqual(
      calls.map((call) => call.method),
      ['claim', 'park'],
    );
    assert.deepEqual(calls[1]?.input, {
      ...WORKER,
      tenantId: work.request.tenantId,
      requestId: work.request.id,
      effectId: work.request.compensationEffectId!,
      actor: WORKER.workerId,
      outboxMessageId: work.outboxMessageId,
      outboxClaimToken: work.outboxClaimToken,
      error: { code: 'COMPLETION_UNKNOWN', message: 'Compensation completion is uncertain' },
    });
  });

  it('escalates mutated authorization before token issuance or adapter invocation', async () => {
    const valid = claimed();
    const mutated = {
      ...valid,
      authorization: {
        ...valid.authorization,
        compensationPatch: { targetRevision: '8', reason: 'caller mutation' },
      },
    } satisfies ClaimedCompensationWork;
    const { port, calls } = makePort([mutated]);
    let tokenCalls = 0;
    let brokerCalls = 0;
    const result = await consumeCompensationBatch(
      port,
      {
        async admit() {
          brokerCalls += 1;
          throw new Error('must not admit');
        },
        async executeAdmitted() {
          brokerCalls += 1;
          throw new Error('must not execute');
        },
      },
      async () => {
        tokenCalls += 1;
        return 'token';
      },
      { ...WORKER, registry },
    );

    assert.equal(tokenCalls, 0);
    assert.equal(brokerCalls, 0);
    assert.equal(result.escalated, 1);
    assert.deepEqual(
      calls.map((call) => call.method),
      ['claim', 'finalize'],
    );
    assert.equal(
      (calls[1]?.input as { response: { reason: string } }).response.reason,
      'COMPENSATION_ACTION_DIGEST_MISMATCH',
    );
  });

  it('escalates adapter-version drift before token issuance or adapter invocation', async () => {
    const { port, calls } = makePort();
    let tokenCalls = 0;
    let brokerCalls = 0;
    const result = await consumeCompensationBatch(
      port,
      {
        async admit() {
          brokerCalls += 1;
          throw new Error('must not admit');
        },
        async executeAdmitted() {
          brokerCalls += 1;
          throw new Error('must not execute');
        },
      },
      async () => {
        tokenCalls += 1;
        return 'token';
      },
      {
        ...WORKER,
        registry: {
          resolve: () => ({ descriptor: { adapterVersion: '2.0.0' } }),
        },
      },
    );

    assert.equal(tokenCalls, 0);
    assert.equal(brokerCalls, 0);
    assert.equal(result.escalated, 1);
    assert.deepEqual(
      calls.map((call) => call.method),
      ['claim', 'finalize'],
    );
    assert.equal(
      (calls[1]?.input as { response: { reason: string } }).response.reason,
      'COMPENSATION_ADAPTER_VERSION_MISMATCH',
    );
  });

  it('fails the tick without a second mutation when atomic completion loses its claim', async () => {
    const work = claimed();
    const { port, calls } = makePort([work]);
    port.finalizeCompensation = async (input) => {
      calls.push({ method: 'finalize', input });
      return { applied: false, reason: 'CLAIM_NOT_OWNED' };
    };

    await assert.rejects(
      () =>
        consumeCompensationBatch(
          port,
          {
            async admit() {
              return {
                admitted: true,
                effectId: work.request.compensationEffectId!,
                replayed: false,
              };
            },
            async executeAdmitted() {
              return {
                effectId: work.request.compensationEffectId!,
                replayed: false,
                response: {},
              };
            },
          },
          async () => 'token',
          { ...WORKER, registry },
        ),
      { code: 'COMPENSATION_CLAIM_NOT_OWNED' },
    );
    assert.deepEqual(
      calls.map((call) => call.method),
      ['claim', 'finalize'],
    );
  });

  it('allows only one of two concurrent workers to own and execute a claim', async () => {
    const work = claimed();
    let available = true;
    let executeCalls = 0;
    const port = makePort([]).port;
    port.claimCompensationWork = async (input) => {
      if (!available || input.workerId !== WORKER.workerId) return [];
      available = false;
      return [work];
    };
    const broker = {
      async admit() {
        return {
          admitted: true,
          effectId: work.request.compensationEffectId!,
          replayed: false,
        };
      },
      async executeAdmitted() {
        executeCalls += 1;
        return { effectId: work.request.compensationEffectId!, replayed: false, response: {} };
      },
    };

    const [owner, other] = await Promise.all([
      consumeCompensationBatch(port, broker, async () => 'token', { ...WORKER, registry }),
      consumeCompensationBatch(port, broker, async () => 'token', {
        workerId: 'compensation:pod-b',
        workerGeneration: 9,
        claimSecret: 'claim-secret-pod-b',
        registry,
      }),
    ]);

    assert.equal(owner.consumed + other.consumed, 1);
    assert.equal(executeCalls, 1);
  });

  it('replays the same durable effect after a post-commit finalize crash without a second remote write', async () => {
    const work = claimed();
    const { port, resetClaim } = makePort([work]);
    let finalizeCalls = 0;
    port.finalizeCompensation = async () => {
      finalizeCalls += 1;
      if (finalizeCalls === 1)
        throw Object.assign(new Error('database disconnected'), { code: 'DB_LOST' });
      return { applied: true, disposition: 'COMPLETED', replayed: false };
    };
    let remoteWrites = 0;
    let committed = false;
    const broker = {
      async admit() {
        return {
          admitted: true,
          effectId: work.request.compensationEffectId!,
          replayed: committed,
        };
      },
      async executeAdmitted() {
        if (!committed) {
          remoteWrites += 1;
          committed = true;
        }
        return {
          effectId: work.request.compensationEffectId!,
          replayed: committed,
          response: { status: 'rolled-back' },
        };
      },
    };

    await assert.rejects(
      () => consumeCompensationBatch(port, broker, async () => 'token', { ...WORKER, registry }),
      { code: 'DB_LOST' },
    );
    resetClaim();
    const replay = await consumeCompensationBatch(port, broker, async () => 'token', {
      ...WORKER,
      registry,
    });

    assert.equal(replay.succeeded, 1);
    assert.equal(remoteWrites, 1);
    assert.equal(finalizeCalls, 2);
  });
});
