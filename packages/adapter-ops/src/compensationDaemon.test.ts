import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';
import { EffectBroker, canonicalRequestHash, createEvidenceSigner } from '@praetor/effect-broker';
import { InMemoryKernelRepository } from '@praetor/kernel/testing/inMemoryRepository';
import type { CompensationOutboxPort } from '@praetor/kernel';
import { CompensationDaemon } from './compensationDaemon.js';
import { canonicalCompensationHash } from '../../kernel/src/ops/compensationAuthority.js';

/**
 * A real signer rather than a `verify: () => true` double: the assertion below
 * requires the daemon to hand back already-committed evidence untouched, and
 * re-signing it (which the stub hid, because it always returned the same
 * signature value) is now observable.
 */
const TEST_EVIDENCE_SIGNER = createEvidenceSigner({
  privateKeyPem: generateKeyPairSync('ed25519').privateKey.export({
    type: 'pkcs8',
    format: 'pem',
  }) as string,
  keyId: 'compensation-daemon-test-key',
});

const WORKER = {
  workerId: 'compensation:pod-a',
  workerGeneration: 3,
  claimSecret: 'claim-secret-pod-a',
} as const;

type ClaimedCompensationWork = Awaited<
  ReturnType<CompensationOutboxPort['claimCompensationWork']>
>[number];

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail('condition was not reached');
}

function emptyPort(
  claim?: CompensationOutboxPort['claimCompensationWork'],
): CompensationOutboxPort {
  return {
    claimCompensationWork: claim ?? (async () => []),
    parkCompensationUnknown: async () => {
      throw new Error('parkCompensationUnknown is not exercised by legacy-path fixtures');
    },
    finalizeCompensation: async () => {
      throw new Error('finalizeCompensation is not exercised by legacy-path fixtures');
    },
  };
}

function daemonFor(input: {
  repository?: CompensationOutboxPort;
  heartbeat?: () => Promise<void>;
  drain?: () => Promise<void>;
  onFatalInvariant?: (reason: string) => Promise<void>;
}) {
  return new CompensationDaemon({
    ...WORKER,
    repository: input.repository ?? emptyPort(),
    registry: { resolve: () => ({}) } as never,
    broker: {} as never,
    tokenProvider: async () => 'token',
    pollIntervalMs: 60_000,
    batchSize: 10,
    heartbeat: input.heartbeat,
    drain: input.drain,
    onFatalInvariant: input.onFatalInvariant,
  });
}

describe('CompensationDaemon', () => {
  it('passes the broker-signed receipt into durable COMPLETED finalization', async () => {
    const forwardResponse = { remoteId: 'remote-a' };
    const compensationPatch = { remoteId: 'remote-a' };
    const actionDigest = canonicalCompensationHash({
      type: 'compensate.http.post',
      originalEffectId: 'effect-forward',
      adapterVersion: 'adapter-v1',
      destination: 'https://example.test/resource',
      forwardResponse,
      compensationPatch,
    });
    const authorization = {
      id: 'authorization-a',
      tenantId: 'tenant-a',
      originalRunId: 'run-forward',
      originalEffectId: 'effect-forward',
      compensationEffectType: 'compensate.http.post',
      adapterVersion: 'adapter-v1',
      compensationPatch,
      forwardReceiptHash: canonicalCompensationHash(forwardResponse),
      policyDecisionId: 'decision-a',
      policySnapshotId: 'snapshot-a',
      decision: 'allow' as const,
      actionDigest,
      expiresAt: '2099-01-01T00:00:00.000Z',
    };
    const request = {
      id: 'request-a',
      tenantId: 'tenant-a',
      originalRunId: 'run-forward',
      originalEffectId: 'effect-forward',
      compensationRunId: 'run-compensation',
      compensationStepId: 'step-compensation',
      adapterVersion: 'adapter-v1',
      compensationEffectType: 'compensate.http.post',
      destination: 'https://example.test/resource',
      compensationPatch,
      forwardReceiptHash: canonicalCompensationHash(forwardResponse),
      authorizationId: 'authorization-a',
      reconcilePolicy: {
        maxAttempts: 3,
        initialDelayMs: 1_000,
        maxDelayMs: 5_000,
        deadlineAt: '2099-01-01T00:00:00.000Z',
      },
      state: 'CLAIMED' as const,
      claimToken: 'claim-a',
      compensationEffectId: 'effect-compensation',
    };
    const evidence = {
      tenantId: 'tenant-a',
      runId: 'run-compensation',
      bundleId: 'evidence_effect-compensation',
      actionDigest,
      body: {},
      contentHash: 'c'.repeat(64),
      signature: {
        algorithm: 'Ed25519' as const,
        keyId: 'test-key',
        signedAt: '2026-07-30T00:00:00.000Z',
        value: 'signature',
      },
      createdAt: '2026-07-30T00:00:00.000Z',
      anchoredAt: '2026-07-30T00:00:00.000Z',
      retentionUntil: '2027-07-30T00:00:00.000Z',
    };
    let finalized: Record<string, unknown> | undefined;
    let admittedInput: Record<string, unknown> | undefined;
    const contextReads: unknown[][] = [];
    const repository = {
      ...emptyPort(async (input) => [
        {
          request,
          authorization,
          forwardResponse,
          lease: {
            workerId: input.workerId,
            workerGeneration: input.workerGeneration,
            token: 'claim-a',
            fencingEpoch: 4,
            expiresAt: '2099-01-01T00:00:00.000Z',
          },
          outboxMessageId: 'outbox-a',
          outboxClaimToken: 'claim-a',
        },
      ]),
      getEvidence: async () => evidence,
      listEffectsForRun: async () => [],
      listEvents: async () => [],
      finalizeCompensation: async (input: Record<string, unknown>) => {
        finalized = input;
        return { applied: true as const, disposition: 'COMPLETED' as const, replayed: false };
      },
    };
    const daemon = new CompensationDaemon({
      ...WORKER,
      repository: repository as never,
      evidenceRepository: repository as never,
      registry: { resolve: () => ({ descriptor: { adapterVersion: 'adapter-v1' } }) } as never,
      broker: {
        admit: async (input: Record<string, unknown>) => {
          admittedInput = input;
          return { admitted: true, effectId: 'effect-compensation', replayed: false };
        },
        executeAdmitted: async () => ({
          effectId: 'effect-compensation',
          replayed: false,
          response: { restored: true },
        }),
      } as never,
      tokenProvider: async () => 'token',
      evidenceSigner: TEST_EVIDENCE_SIGNER,
      terminalEvidenceContext: {
        getTerminalEvidenceContext: async (...args: unknown[]) => {
          contextReads.push(args);
          return { effect: {} as never, events: [], evidence };
        },
      },
      pollIntervalMs: 60_000,
    });

    assert.equal((await daemon.tick()).succeeded, 1);
    assert.deepEqual(admittedInput?.compensationClaim, {
      requestId: 'request-a',
      requestClaimToken: 'claim-a',
      outboxMessageId: 'outbox-a',
      outboxClaimToken: 'claim-a',
    });
    assert.deepEqual(finalized?.evidence, evidence);
    assert.deepEqual(contextReads, [
      ['effect-compensation', 'run-compensation', 'tenant-a', 'claim-a'],
    ]);
  });

  it('heartbeats only after a real governed zero-claim tick', async () => {
    let claimInput: unknown;
    let heartbeats = 0;
    const daemon = daemonFor({
      repository: emptyPort(async (input) => {
        claimInput = input;
        return [];
      }),
      heartbeat: async () => {
        heartbeats += 1;
      },
    });

    assert.deepEqual(await daemon.tick(), {
      consumed: 0,
      succeeded: 0,
      handedOff: 0,
      escalated: 0,
      replayed: 0,
    });
    assert.deepEqual(claimInput, {
      ...WORKER,
      topic: 'commander.kernel.compensation.requested',
      limit: 10,
    });
    assert.equal(heartbeats, 1);
    assert.ok(daemon.getHealth().lastSucceededAt);
  });

  it('does not heartbeat and invokes safe-stop on a fatal claim failure', async () => {
    const failure = Object.assign(new Error('claim authority unavailable'), {
      code: 'COMPENSATION_CLAIM_UNAVAILABLE',
    });
    let heartbeats = 0;
    const safeStops: string[] = [];
    const daemon = daemonFor({
      repository: emptyPort(async () => {
        throw failure;
      }),
      heartbeat: async () => {
        heartbeats += 1;
      },
      onFatalInvariant: async (reason) => {
        safeStops.push(reason);
      },
    });

    await assert.rejects(() => daemon.tick(), failure);
    assert.equal(heartbeats, 0);
    assert.deepEqual(safeStops, ['COMPENSATION_CLAIM_UNAVAILABLE']);
    assert.equal(daemon.getHealth().lastSucceededAt, undefined);
    assert.equal(daemon.getHealth().lastErrorCode, 'COMPENSATION_CLAIM_UNAVAILABLE');
  });

  it('starts one immediate tick, skips overlap, then drains', async () => {
    let releaseClaim: ((work: ClaimedCompensationWork[]) => void) | undefined;
    const claimed = new Promise<ClaimedCompensationWork[]>((resolve) => {
      releaseClaim = resolve;
    });
    let claimCalls = 0;
    let heartbeats = 0;
    let drains = 0;
    const daemon = daemonFor({
      repository: emptyPort(async () => {
        claimCalls += 1;
        return claimed;
      }),
      heartbeat: async () => {
        heartbeats += 1;
      },
      drain: async () => {
        drains += 1;
      },
    });

    daemon.start();
    await waitFor(() => claimCalls === 1);
    assert.equal(daemon.getHealth().inFlight, true);
    assert.deepEqual(await daemon.tick(), {
      consumed: 0,
      succeeded: 0,
      handedOff: 0,
      escalated: 0,
      replayed: 0,
    });
    assert.equal(daemon.getHealth().skippedOverlappingTicks, 1);

    const stopping = daemon.stop();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(drains, 0);
    releaseClaim?.([]);
    await stopping;
    assert.equal(heartbeats, 1);
    assert.equal(drains, 1);
    assert.equal(daemon.getHealth().running, false);
  });

  /**
   * AO-03: `parkCompensationUnknown`/`handoffCompensationUnknown` means the
   * remote outcome is undetermined. The daemon used to add `handedOff` into
   * `health.completed`, so an unresolved compensation showed up as success on
   * /health. It must be its own bucket.
   */
  it('reports a COMPLETION_UNKNOWN handoff as handedOff, never as completed', async () => {
    const tenantId = 'tenant-handoff';
    const forwardResponse = {};
    const destination = 'https://api.example/repos/o/r';
    const compensationEffectType = 'compensate.github.pull_request.create';
    const adapterVersion = 'v1';
    const compensationPatch = {};
    const authorization = {
      id: 'auth-handoff',
      tenantId,
      originalRunId: 'run-original',
      originalEffectId: 'effect-original',
      compensationEffectType,
      adapterVersion,
      compensationPatch,
      forwardReceiptHash: canonicalCompensationHash(forwardResponse),
      policyDecisionId: 'pd-1',
      policySnapshotId: 'ps-1',
      decision: 'allow' as const,
      actionDigest: canonicalCompensationHash({
        type: compensationEffectType,
        originalEffectId: 'effect-original',
        adapterVersion,
        destination,
        forwardResponse,
        compensationPatch,
      }),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      approvalBinding: null,
    };
    const request = {
      id: 'request-handoff',
      tenantId,
      originalRunId: 'run-original',
      originalEffectId: 'effect-original',
      compensationRunId: 'run-compensation',
      compensationStepId: 'step-compensation',
      adapterVersion,
      compensationEffectType,
      destination,
      compensationPatch,
      forwardReceiptHash: authorization.forwardReceiptHash,
      authorizationId: authorization.id,
      reconcilePolicy: {},
      state: 'CLAIMED' as const,
      compensationEffectId: 'effect-compensation',
      claimToken: 'request-claim',
    };
    const workerId = 'compensation:pod-handoff';
    const work = {
      authorization,
      request,
      forwardResponse,
      outboxMessageId: 'message-1',
      outboxClaimToken: 'outbox-claim',
      lease: { workerId, workerGeneration: 7, token: 'lease-token', fencingEpoch: 0 },
    };
    const dispositions: string[] = [];
    const outbox = {
      async claimCompensationWork() {
        return [work];
      },
      async completeCompensationWork() {
        dispositions.push('completeCompensationWork');
        return { applied: true as const, disposition: 'COMPLETED' as const };
      },
      async handoffCompensationUnknown() {
        dispositions.push('handoffCompensationUnknown');
        return { applied: true as const, disposition: 'HANDOFF_UNKNOWN' as const };
      },
      async escalateCompensationWork() {
        dispositions.push('escalateCompensationWork');
        return { applied: true as const, disposition: 'ESCALATED' as const };
      },
      async parkCompensationUnknown() {
        dispositions.push('parkCompensationUnknown');
        return { applied: true as const, disposition: 'COMPLETION_UNKNOWN' as const };
      },
      async finalizeCompensation() {
        dispositions.push('finalizeCompensation');
        return { applied: true as const, disposition: 'COMPLETED' as const };
      },
    };
    const daemon = new CompensationDaemon({
      repository: outbox as never,
      broker: {
        admit: async () => ({
          admitted: true,
          effectId: 'effect-compensation',
          replayed: false,
        }),
        executeAdmitted: async () => {
          throw Object.assign(new Error('completion is uncertain'), {
            code: 'COMPLETION_UNKNOWN',
          });
        },
      } as never,
      registry: { resolve: () => ({ descriptor: { adapterVersion } }) } as never,
      tokenProvider: async () => 'token',
      pollIntervalMs: 60_000,
      workerId,
      workerGeneration: 7,
      claimSecret: 'claim-secret',
    });

    const stats = await daemon.tick();
    assert.deepEqual(dispositions, ['parkCompensationUnknown']);
    assert.equal(stats.consumed, 1);
    assert.equal(stats.succeeded, 0);
    assert.equal(stats.handedOff, 1);

    const health = daemon.getHealth();
    assert.equal(health.claimed, 1);
    assert.equal(health.completed, 0, 'an undetermined handoff must not count as completed');
    assert.equal(health.handedOff, 1, 'the undetermined handoff needs its own bucket');
  });

  it('persists a verifiable receipt when the broker completes an admitted effect', async () => {
    const kernel = new InMemoryKernelRepository();
    await kernel.createRun(
      {
        id: 'run-compensation-evidence',
        tenantId: 'tenant-a',
        intentHash: 'intent',
        workGraphHash: 'graph',
        workGraphVersion: 'v1',
        policySnapshotId: 'adapter-ops-v1',
        steps: [{ id: 'step-compensation-evidence', kind: 'tool' }],
      },
      'gateway',
    );
    const step = await kernel.claimNextStep({
      workerId: 'compensation-daemon',
      workerGeneration: 1,
      leaseTtlMs: 60_000,
    });
    assert.ok(step?.lease);
    const { privateKey } = generateKeyPairSync('ed25519');
    const signer = createEvidenceSigner({
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      keyId: 'compensation-evidence-key',
    });
    const request: Record<string, unknown> = { originalEffectId: 'effect-forward' };
    const actionDigest = 'c'.repeat(64);
    const broker = new EffectBroker(
      {
        verify: async () => ({
          jti: 'compensation-grant',
          tenantId: 'tenant-a',
          runId: 'run-compensation-evidence',
          stepId: step.id,
          audience: 'commander.effect-broker',
          effectTypes: ['compute.echo'],
          expiresAt: '2099-01-01T00:00:00.000Z',
          policySnapshotId: 'adapter-ops-v1',
          requestHash: canonicalRequestHash(request),
          actionDigest,
          workerId: 'compensation-daemon',
          workerGeneration: 1,
          authorizationId: 'auth-compensation',
          requestId: 'request-compensation',
          policyDecisionId: 'adapter-ops-allow',
          adapterVersion: '1',
          decisionEffect: 'allow',
          approvalBinding: null,
        }),
      },
      {
        evaluate: async () => ({
          effect: 'allow',
          decisionId: 'adapter-ops-allow',
          reason: 'registered compensation adapter',
          policySnapshotId: 'adapter-ops-v1',
        }),
      },
      {
        admitEffect: (input: Parameters<InMemoryKernelRepository['admitEffect']>[0]) =>
          kernel.admitEffect(input),
        completeEffect: (...args: Parameters<InMemoryKernelRepository['completeEffect']>) =>
          kernel.completeEffect(...args),
        completeEffectWithEvidence: (
          ...args: Parameters<InMemoryKernelRepository['completeEffectWithEvidence']>
        ) => kernel.completeEffectWithEvidence(...args),
        markEffectCompletionUnknown: (
          ...args: Parameters<InMemoryKernelRepository['markEffectCompletionUnknown']>
        ) => kernel.markEffectCompletionUnknown(...args),
        listEffectsForRun: (...args: Parameters<InMemoryKernelRepository['listEffectsForRun']>) =>
          kernel.listEffectsForRun(...args),
        listEvents: (...args: Parameters<InMemoryKernelRepository['listEvents']>) =>
          kernel.listEvents(...args),
      },
      { execute: async () => ({ status: 'compensated' }) },
      { append: async () => {} },
      { evidenceSigner: signer },
    );

    await broker.execute({
      effectId: 'effect-compensation',
      token: 'verified-by-test-port',
      type: 'compute.echo',
      request,
      idempotencyKey: 'compensation-evidence',
      lease: step.lease,
      actor: 'compensation-daemon',
    });
    const evidence = await kernel.getEvidence('run-compensation-evidence', 'tenant-a');
    assert.ok(evidence);
    const body = evidence.body as { terminalDisposition?: string; scope?: { effectId?: string } };
    assert.equal(body.terminalDisposition, 'SUCCEEDED');
    assert.equal(body.scope?.effectId, 'effect-compensation');
  });
});
