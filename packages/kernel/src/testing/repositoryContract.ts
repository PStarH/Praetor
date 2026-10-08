import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateRunTransition } from '@praetor/contracts';
import { deriveEffectIdempotencyKey } from '@praetor/effect-broker';
import type { KernelRepository } from '../repository.js';
import type {
  NewKernelStep,
  ClaimStepRequest,
  KernelCompensationRequest,
  ClaimedCompensationRequest,
} from '../types.js';
import { SqliteKernelRepository } from '../sqlite.js';
import {
  canonicalCompensationHash,
  sealGovernedCompensationAuthorization,
} from '../ops/compensationAuthority.js';
import {
  governedCompensationAuthorizationInput,
  type LegacyGovernedCompensationInput,
} from '../ops/compensationPersistence.js';
import {
  KERNEL_COMPENSATION_TOPIC,
  consumeCompensationBatch,
  type CompensationOutboxPort,
} from '../ops/compensationConsumer.js';

export interface RepositoryContractContext {
  name: string;
  create: () => Promise<KernelRepository>;
  destroy: (repo: KernelRepository) => Promise<void>;
  /** Adapter-ops PostgreSQL reconciliation uses a database-owned claim clock. */
  reconcileClaimUsesDatabaseClock?: boolean;
  seedWorker?: (repo: KernelRepository) => Promise<{ workerId: string; generation: number }>;
  seedOperationsWorker?: (
    repo: KernelRepository,
    input: {
      id: string;
      tenantIds: string[];
      capabilities: string[];
      status?: 'ACTIVE' | 'DRAINING' | 'OFFLINE';
      registeredAt: Date;
      lastHeartbeatAt: Date;
      identitySubject?: string;
    },
  ) => Promise<void>;
  /** Durable adapter-ops worker used to claim governed compensation work. */
  seedCompensationWorker?: (repo: KernelRepository) => Promise<{
    workerId: string;
    generation: number;
    claimSecret: string;
  }>;
}

const createRun = (steps: NewKernelStep[] = [{ id: 'step-a', kind: 'agent' }]) => ({
  id: 'run-1',
  tenantId: 'tenant-a',
  intentHash: 'intent',
  workGraphHash: 'graph',
  workGraphVersion: 'v1',
  policySnapshotId: 'policy-v1',
  steps,
});

async function claim(
  kernel: KernelRepository,
  ctx: RepositoryContractContext,
  overrides: Partial<ClaimStepRequest> = {},
) {
  const worker = await ctx.seedWorker?.(kernel);
  return kernel.claimNextStep({
    workerId: worker?.workerId ?? 'worker-1',
    workerGeneration: worker?.generation ?? 1,
    leaseTtlMs: 60_000,
    tenantId: 'tenant-a',
    capabilities: ['agent', 'tool'],
    ...overrides,
  });
}

async function seedFreshOperationsDrains(
  kernel: KernelRepository,
  ctx: RepositoryContractContext,
  suffix: string,
): Promise<void> {
  assert.ok(ctx.seedOperationsWorker, `${ctx.name} must seed operations workers`);
  const now = new Date();
  for (const [role, capability] of [
    ['reconcile', 'effect.reconcile'],
    ['compensation', 'effect.compensate'],
  ] as const) {
    await ctx.seedOperationsWorker!(kernel, {
      id: `${role}:${suffix}`,
      tenantIds: ['tenant-a'],
      capabilities: [capability],
      identitySubject: 'db:commander_adapter_ops',
      registeredAt: new Date(now.getTime() - 10_000),
      lastHeartbeatAt: new Date(now.getTime() - 1_000),
    });
  }
}

/**
 * Drive the producer-written compensation records up to a claimed work item:
 * a completed forward effect, a durable authorization row, the compensation
 * request/outbox pair and the compact outbox payload the producer writes.
 */
async function seedClaimedGovernedCompensation(
  kernel: KernelRepository,
  ctx: RepositoryContractContext,
  suffix: string,
): Promise<{
  work: ClaimedCompensationRequest;
  workerId: string;
  request: KernelCompensationRequest;
  /** Digest carried by the compact outbox payload, i.e. the durable row digest. */
  durableActionDigest: string;
}> {
  const base = new Date();
  await seedFreshOperationsDrains(kernel, ctx, suffix);
  const runId = `run-forward-${suffix}`;
  const stepId = `step-forward-${suffix}`;
  const effectId = `effect-forward-${suffix}`;
  await kernel.createRun(
    {
      id: runId,
      tenantId: 'tenant-a',
      intentHash: `intent-forward-${suffix}`,
      workGraphHash: `graph-forward-${suffix}`,
      workGraphVersion: 'v1',
      policySnapshotId: 'policy-v1',
      steps: [
        {
          id: stepId,
          kind: 'agent',
          maxAttempts: 1,
          scheduledAt: new Date(base.getTime() - 1_000).toISOString(),
        },
      ],
    },
    'gateway',
  );
  const forwardWorker = await ctx.seedWorker?.(kernel);
  const forwardActor = forwardWorker?.workerId ?? 'worker-1';
  const forwardStep = await kernel.claimNextStep({
    workerId: forwardActor,
    workerGeneration: forwardWorker?.generation ?? 1,
    leaseTtlMs: 60_000,
    tenantId: 'tenant-a',
    capabilities: ['agent', 'tool'],
  });
  assert.ok(forwardStep?.lease, `${ctx.name} must claim the forward step`);
  const destination = `demo://ticket/${suffix}`;
  const forwardResponse = { providerId: `INC-${suffix}` };
  const forwardAdmitted = await kernel.admitEffect({
    id: effectId,
    runId,
    stepId,
    tenantId: 'tenant-a',
    type: 'tool.ticket.create',
    idempotencyKey: `effect-forward-${suffix}-key`,
    request: { destination },
    policyDecisionId: 'policy-decision-forward',
    policySnapshotId: 'policy-v1',
    actionDigest: 'a'.repeat(64),
    lease: forwardStep.lease,
    actor: forwardActor,
  });
  assert.equal(forwardAdmitted.admitted, true, JSON.stringify(forwardAdmitted));
  assert.ok(
    await kernel.completeEffect(
      effectId,
      'tenant-a',
      forwardStep.lease,
      forwardResponse,
      forwardActor,
    ),
  );

  const legacy: LegacyGovernedCompensationInput = {
    tenantId: 'tenant-a',
    originalRunId: runId,
    originalEffectId: effectId,
    forwardReceipt: forwardResponse,
    adapterVersion: `demo-ticket/${suffix}/v1`,
    compensationEffectType: 'compensate.demo.ticket.create',
    compensationPatch: { status: 'cancelled' },
    policyDecisionId: 'policy-decision-compensation',
    policySnapshotId: 'policy-compensation-v1',
    actionDigest: '',
    decisionEffect: 'allow',
    authorizationExpiresAt: new Date(Date.now() + 300_000).toISOString(),
    approvalBinding: null,
    actor: 'api-user',
  };
  const sealed = sealGovernedCompensationAuthorization(
    governedCompensationAuthorizationInput({
      request: legacy,
      originalRunStateAtRequest: 'RUNNING',
      originalEffect: { request: { destination }, response: forwardResponse },
    }),
  );
  const durableActionDigest = canonicalCompensationHash({
    type: legacy.compensationEffectType,
    originalEffectId: legacy.originalEffectId,
    adapterVersion: legacy.adapterVersion,
    destination,
    forwardResponse,
    compensationPatch: legacy.compensationPatch,
  });
  await kernel.createCompensationAuthorization({
    id: sealed.authorizationId,
    tenantId: 'tenant-a',
    originalRunId: legacy.originalRunId,
    originalEffectId: legacy.originalEffectId,
    compensationEffectType: legacy.compensationEffectType,
    adapterVersion: legacy.adapterVersion,
    compensationPatch: legacy.compensationPatch,
    forwardReceiptHash: sealed.forwardReceiptHash,
    policyDecisionId: legacy.policyDecisionId,
    policySnapshotId: legacy.policySnapshotId,
    decision: legacy.decisionEffect,
    actionDigest: durableActionDigest,
    expiresAt: legacy.authorizationExpiresAt,
  });
  const requested = await kernel.requestCompensation({
    tenantId: 'tenant-a',
    authorizationId: sealed.authorizationId,
    actor: 'api-user',
  });
  assert.equal(requested.accepted, true, JSON.stringify(requested));
  if (!requested.accepted) throw new Error('compensation request rejected');

  const compensationWorker = await ctx.seedCompensationWorker!(kernel);
  const claimed = await kernel.claimCompensationWork({
    workerId: compensationWorker.workerId,
    workerGeneration: compensationWorker.generation,
    claimSecret: compensationWorker.claimSecret,
    topic: KERNEL_COMPENSATION_TOPIC,
    limit: 10,
  });
  assert.equal(
    claimed.length,
    1,
    'compact producer payload must resolve durable governed authority',
  );
  const work = claimed[0]!;
  assert.ok('outboxMessageId' in work, 'expected the durable claim shape');
  return {
    work,
    workerId: compensationWorker.workerId,
    request: work.request,
    durableActionDigest,
  };
}

export function runKernelRepositoryContractTests(ctx: RepositoryContractContext): void {
  // Contract fixtures use stable IDs. Run cases serially so SQL-backed runners
  // can reset their disposable database without cross-case interference.
  describe(`KernelRepository contract — ${ctx.name}`, { concurrency: 1 }, () => {
    it('fails operations readiness closed until distinct drains complete fresh ticks', async () => {
      const kernel = await ctx.create();
      const now = new Date('2026-07-23T10:00:00.000Z');
      try {
        assert.deepEqual(await kernel.getOperationsReadiness('tenant-a', now), {
          ready: false,
          reason: 'RECONCILIATION_DRAIN_UNAVAILABLE',
          reconciliationWorkers: 0,
          compensationWorkers: 0,
          checkedAt: now.toISOString(),
        });
        assert.ok(ctx.seedOperationsWorker, `${ctx.name} must seed operations workers`);
        await ctx.seedOperationsWorker!(kernel, {
          id: 'reconcile:a',
          tenantIds: ['tenant-a'],
          capabilities: ['effect.reconcile'],
          identitySubject: 'forged:generic-worker',
          registeredAt: new Date(now.getTime() - 1_000),
          lastHeartbeatAt: new Date(now.getTime() - 1_000),
        });
        assert.equal(
          (await kernel.getOperationsReadiness('tenant-a', now)).ready,
          false,
          'forged identity and registration timestamp cannot establish readiness',
        );
        await ctx.seedOperationsWorker!(kernel, {
          id: 'reconcile:a',
          tenantIds: ['tenant-a'],
          capabilities: ['effect.reconcile'],
          identitySubject: 'db:commander_adapter_ops',
          registeredAt: new Date(now.getTime() - 10_000),
          lastHeartbeatAt: new Date(now.getTime() - 1_000),
        });
        await ctx.seedOperationsWorker!(kernel, {
          id: 'compensate:a',
          tenantIds: ['tenant-a'],
          capabilities: ['effect.compensate'],
          identitySubject: 'db:commander_adapter_ops',
          registeredAt: new Date(now.getTime() - 10_000),
          lastHeartbeatAt: new Date(now.getTime() - 1_000),
        });
        const ready = await kernel.getOperationsReadiness('tenant-a', now);
        assert.equal(ready.ready, true);
        assert.equal(ready.reconciliationWorkers, 1);
        assert.equal(ready.compensationWorkers, 1);
        assert.equal(
          (await kernel.getOperationsReadiness('tenant-b', now)).ready,
          false,
          'another tenant cannot borrow drains',
        );
      } finally {
        await ctx.destroy(kernel);
      }
    });

    it('rejects stale, draining, and dual-capability substitutes for distinct drains', async () => {
      const kernel = await ctx.create();
      const now = new Date('2026-07-23T10:00:00.000Z');
      try {
        assert.ok(ctx.seedOperationsWorker, `${ctx.name} must seed operations workers`);
        await ctx.seedOperationsWorker!(kernel, {
          id: 'both:a',
          tenantIds: ['tenant-a'],
          capabilities: ['effect.reconcile', 'effect.compensate'],
          identitySubject: 'db:commander_adapter_ops',
          registeredAt: new Date(now.getTime() - 10_000),
          lastHeartbeatAt: new Date(now.getTime() - 1_000),
        });
        assert.equal(
          (await kernel.getOperationsReadiness('tenant-a', now)).ready,
          false,
          'capabilities must be exact and server assigned',
        );
        await ctx.seedOperationsWorker!(kernel, {
          id: 'reconcile:a',
          tenantIds: ['tenant-a'],
          capabilities: ['effect.reconcile'],
          status: 'DRAINING',
          identitySubject: 'db:commander_adapter_ops',
          registeredAt: new Date(now.getTime() - 10_000),
          lastHeartbeatAt: new Date(now.getTime() - 1_000),
        });
        await ctx.seedOperationsWorker!(kernel, {
          id: 'compensate:a',
          tenantIds: ['tenant-a'],
          capabilities: ['effect.compensate'],
          identitySubject: 'db:commander_adapter_ops',
          registeredAt: new Date(now.getTime() - 60_000),
          lastHeartbeatAt: new Date(now.getTime() - 31_000),
        });
        const readiness = await kernel.getOperationsReadiness('tenant-a', now);
        assert.equal(readiness.ready, false);
        assert.equal(readiness.reason, 'RECONCILIATION_DRAIN_UNAVAILABLE');
      } finally {
        await ctx.destroy(kernel);
      }
    });

    it('fails Class A admission closed until both operations drains are fresh', async () => {
      const kernel = await ctx.create();
      try {
        await kernel.createRun(createRun(), 'gateway');
        const claimed = await claim(kernel, ctx);
        assert.ok(claimed?.lease);

        const blocked = await kernel.admitEffect({
          id: 'effect-class-a-blocked',
          runId: 'run-1',
          stepId: claimed!.id,
          tenantId: 'tenant-a',
          type: 'http.post',
          idempotencyKey: 'class-a-blocked',
          policyDecisionId: 'decision-class-a',
          policySnapshotId: 'policy-v1',
          actionDigest: 'a'.repeat(64),
          request: { target: 'blocked' },
          lease: claimed!.lease!,
          actor: 'worker-1',
        });
        assert.deepEqual(blocked, { admitted: false, reason: 'OPERATIONS_NOT_READY' });

        await seedFreshOperationsDrains(kernel, ctx, 'admission');

        const admitted = await kernel.admitEffect({
          id: 'effect-class-a-ready',
          runId: 'run-1',
          stepId: claimed!.id,
          tenantId: 'tenant-a',
          type: 'http.post',
          idempotencyKey: 'class-a-ready',
          policyDecisionId: 'decision-class-a',
          policySnapshotId: 'policy-v1',
          actionDigest: 'b'.repeat(64),
          request: { target: 'ready' },
          lease: claimed!.lease!,
          actor: 'worker-1',
        });
        assert.equal(admitted.admitted, true);
      } finally {
        await ctx.destroy(kernel);
      }
    });

    it('allows only completed Class A replays to bypass operations readiness', async () => {
      for (const state of ['ADMITTED', 'COMPLETION_UNKNOWN', 'FAILED'] as const) {
        const kernel = await ctx.create();
        try {
          await kernel.createRun(createRun(), 'gateway');
          const claimed = await claim(kernel, ctx);
          assert.ok(claimed?.lease);
          const suffix = `replay-${state.toLowerCase()}`;
          await seedFreshOperationsDrains(kernel, ctx, suffix);
          const request = {
            id: `effect-${suffix}`,
            runId: 'run-1',
            stepId: claimed!.id,
            tenantId: 'tenant-a',
            type: 'http.post',
            idempotencyKey: `idem-${suffix}`,
            policyDecisionId: 'decision-replay',
            policySnapshotId: 'policy-v1',
            actionDigest: 'a'.repeat(64),
            request: { target: suffix },
            lease: claimed!.lease!,
            actor: 'worker-1',
          };
          assert.equal((await kernel.admitEffect(request)).admitted, true);
          if (state === 'COMPLETION_UNKNOWN') {
            assert.ok(
              await kernel.markEffectCompletionUnknown({
                effectId: request.id,
                tenantId: request.tenantId,
                reason: 'timeout',
                actor: request.actor,
              }),
            );
          } else if (state === 'FAILED') {
            assert.ok(
              await kernel.failEffect({
                effectId: request.id,
                tenantId: request.tenantId,
                lease: request.lease,
                error: { code: 'REMOTE_REJECTED', message: 'rejected', retryable: false },
                actor: request.actor,
              }),
            );
          }
          const now = new Date();
          await ctx.seedOperationsWorker!(kernel, {
            id: `compensation:${suffix}`,
            tenantIds: ['tenant-a'],
            capabilities: ['effect.compensate'],
            status: 'DRAINING',
            identitySubject: 'db:commander_adapter_ops',
            registeredAt: new Date(now.getTime() - 10_000),
            lastHeartbeatAt: new Date(now.getTime() - 1_000),
          });

          const replay = await kernel.admitEffect({
            ...request,
            id: `${request.id}-replay`,
          });
          assert.equal(replay.admitted, false, `${state} is not a completed durable receipt`);
          if (!replay.admitted) {
            assert.ok(
              replay.reason === 'OPERATIONS_NOT_READY' || replay.reason === 'LEASE_LOST',
              `${state} must fail closed on readiness or the released lease`,
            );
          }
        } finally {
          await ctx.destroy(kernel);
        }
      }

      const kernel = await ctx.create();
      try {
        await kernel.createRun(createRun(), 'gateway');
        const claimed = await claim(kernel, ctx);
        assert.ok(claimed?.lease);
        await seedFreshOperationsDrains(kernel, ctx, 'replay-completed');
        const request = {
          id: 'effect-replay-completed',
          runId: 'run-1',
          stepId: claimed!.id,
          tenantId: 'tenant-a',
          type: 'http.post',
          idempotencyKey: 'idem-replay-completed',
          policyDecisionId: 'decision-replay',
          policySnapshotId: 'policy-v1',
          actionDigest: 'b'.repeat(64),
          request: { target: 'completed' },
          lease: claimed!.lease!,
          actor: 'worker-1',
        };
        assert.equal((await kernel.admitEffect(request)).admitted, true);
        assert.equal(
          (
            await kernel.completeEffect(
              request.id,
              request.tenantId,
              request.lease,
              { receipt: 'durable' },
              request.actor,
            )
          )?.state,
          'COMPLETED',
        );
        const now = new Date();
        await ctx.seedOperationsWorker!(kernel, {
          id: 'compensation:replay-completed',
          tenantIds: ['tenant-a'],
          capabilities: ['effect.compensate'],
          status: 'DRAINING',
          identitySubject: 'db:commander_adapter_ops',
          registeredAt: new Date(now.getTime() - 10_000),
          lastHeartbeatAt: new Date(now.getTime() - 1_000),
        });
        const replay = await kernel.admitEffect({ ...request, id: `${request.id}-replay` });
        assert.equal(replay.admitted && replay.replayed, true);
        if (replay.admitted) assert.equal(replay.effect.state, 'COMPLETED');
      } finally {
        await ctx.destroy(kernel);
      }
    });

    it('claims dependency-ready work once and fences stale completion', async () => {
      const kernel = await ctx.create();
      try {
        await kernel.createRun(createRun(), 'gateway');
        const claimed = await claim(kernel, ctx);
        assert.equal(claimed?.state, 'RUNNING');
        assert.equal(await claim(kernel, ctx, { workerId: 'worker-2' }), null);
        const stale = await kernel.completeStep({
          stepId: 'step-a',
          tenantId: claimed!.tenantId,
          lease: {
            workerId: claimed!.lease!.workerId,
            token: 'wrong',
            fencingEpoch: claimed!.lease!.fencingEpoch,
            workerGeneration: claimed!.lease!.workerGeneration,
          },
          expectedVersion: claimed!.version,
          actor: 'worker-1',
        });
        assert.equal(stale, null);
        const complete = await kernel.completeStep({
          stepId: 'step-a',
          tenantId: claimed!.tenantId,
          lease: claimed!.lease!,
          expectedVersion: claimed!.version,
          output: { ok: true },
          actor: 'worker-1',
        });
        assert.equal(complete?.state, 'SUCCEEDED');
        assert.equal((await kernel.getRun('run-1', 'tenant-a'))?.state, 'SUCCEEDED');
      } finally {
        await ctx.destroy(kernel);
      }
    });

    it('enforces graph dependencies and effect idempotency within a tenant', async () => {
      const kernel = await ctx.create();
      try {
        await kernel.createRun(
          createRun([
            { id: 'first', kind: 'agent' },
            { id: 'second', kind: 'tool', dependencies: ['first'] },
          ]),
          'gateway',
        );
        const first = await claim(kernel, ctx, { capabilities: ['agent'] });
        assert.equal(first?.id, 'first');
        await seedFreshOperationsDrains(kernel, ctx, 'idempotency');
        const admitted = await kernel.admitEffect({
          id: 'effect-1',
          runId: 'run-1',
          stepId: 'first',
          tenantId: 'tenant-a',
          type: 'http.write',
          idempotencyKey: 'key-1',
          policyDecisionId: 'decision-1',
          policySnapshotId: 'policy-v1',
          actionDigest: 'a'.repeat(64),
          request: { target: 'x' },
          lease: first!.lease!,
          actor: 'worker-1',
        });
        assert.equal(admitted.admitted, true);
        const replay = await kernel.admitEffect({
          id: 'effect-2',
          runId: 'run-1',
          stepId: 'first',
          tenantId: 'tenant-a',
          type: 'http.write',
          idempotencyKey: 'key-1',
          policyDecisionId: 'decision-1',
          policySnapshotId: 'policy-v1',
          actionDigest: 'a'.repeat(64),
          request: { target: 'x' },
          lease: first!.lease!,
          actor: 'worker-1',
        });
        assert.equal(replay.admitted && replay.replayed, true);
        await kernel.completeEffect(
          'effect-1',
          'tenant-a',
          first!.lease!,
          { ok: true },
          'worker-1',
        );
        await kernel.completeStep({
          stepId: 'first',
          tenantId: first!.tenantId,
          lease: first!.lease!,
          expectedVersion: first!.version,
          actor: 'worker-1',
        });
        assert.equal((await claim(kernel, ctx, { capabilities: ['tool'] }))?.id, 'second');
      } finally {
        await ctx.destroy(kernel);
      }
    });

    it('persists admit policy/lease bindings and conflicts on snapshot or digest mismatch', async () => {
      const kernel = await ctx.create();
      try {
        await kernel.createRun(createRun(), 'gateway');
        const claimed = await claim(kernel, ctx);
        assert.ok(claimed?.lease);
        await seedFreshOperationsDrains(kernel, ctx, 'bindings');
        const lease = claimed!.lease!;
        const digest = 'c'.repeat(64);
        const admitted = await kernel.admitEffect({
          id: 'effect-bind',
          runId: 'run-1',
          stepId: claimed!.id,
          tenantId: 'tenant-a',
          type: 'http.write',
          idempotencyKey: 'bind-key',
          policyDecisionId: 'decision-bind',
          policySnapshotId: 'policy-bind-v1',
          actionDigest: digest,
          request: { target: 'bind' },
          lease,
          actor: 'worker-1',
        });
        assert.equal(admitted.admitted, true);
        assert.equal(admitted.replayed, false);
        if (!admitted.admitted) return;
        assert.equal(admitted.effect.policySnapshotId, 'policy-bind-v1');
        assert.equal(admitted.effect.actionDigest, digest);
        assert.equal(admitted.effect.leaseWorkerId, lease.workerId);
        assert.equal(admitted.effect.leaseWorkerGeneration, lease.workerGeneration ?? 0);
        assert.equal(admitted.effect.leaseFencingEpoch, lease.fencingEpoch);

        const loaded = await kernel.getEffect('effect-bind', 'tenant-a');
        assert.ok(loaded);
        assert.equal(loaded!.policySnapshotId, 'policy-bind-v1');
        assert.equal(loaded!.actionDigest, digest);
        assert.equal(loaded!.leaseWorkerId, lease.workerId);
        assert.equal(loaded!.leaseWorkerGeneration, lease.workerGeneration ?? 0);
        assert.equal(loaded!.leaseFencingEpoch, lease.fencingEpoch);

        const snapshotConflict = await kernel.admitEffect({
          id: 'effect-bind-snap',
          runId: 'run-1',
          stepId: claimed!.id,
          tenantId: 'tenant-a',
          type: 'http.write',
          idempotencyKey: 'bind-key',
          policyDecisionId: 'decision-bind',
          policySnapshotId: 'policy-bind-v2',
          actionDigest: digest,
          request: { target: 'bind' },
          lease,
          actor: 'worker-1',
        });
        assert.equal(snapshotConflict.admitted, false);
        if (!snapshotConflict.admitted)
          assert.equal(snapshotConflict.reason, 'IDEMPOTENCY_CONFLICT');

        const digestConflict = await kernel.admitEffect({
          id: 'effect-bind-digest',
          runId: 'run-1',
          stepId: claimed!.id,
          tenantId: 'tenant-a',
          type: 'http.write',
          idempotencyKey: 'bind-key',
          policyDecisionId: 'decision-bind',
          policySnapshotId: 'policy-bind-v1',
          actionDigest: 'd'.repeat(64),
          request: { target: 'bind' },
          lease,
          actor: 'worker-1',
        });
        assert.equal(digestConflict.admitted, false);
        if (!digestConflict.admitted) assert.equal(digestConflict.reason, 'IDEMPOTENCY_CONFLICT');
      } finally {
        await ctx.destroy(kernel);
      }
    });

    it('admitEffect fails closed on blank policySnapshotId / lease.workerId (never coerces to legacy-unbound)', async () => {
      const kernel = await ctx.create();
      try {
        await kernel.createRun(createRun(), 'gateway');
        const claimed = await claim(kernel, ctx);
        assert.ok(claimed?.lease);
        const lease = claimed!.lease!;

        const blankSnapshot = await kernel.admitEffect({
          id: 'effect-blank-snapshot',
          runId: 'run-1',
          stepId: claimed!.id,
          tenantId: 'tenant-a',
          type: 'http.write',
          idempotencyKey: 'blank-snapshot-key',
          policyDecisionId: 'decision-blank',
          policySnapshotId: '   ',
          actionDigest: 'e'.repeat(64),
          request: { target: 'blank' },
          lease,
          actor: 'worker-1',
        });
        assert.equal(blankSnapshot.admitted, false);
        if (!blankSnapshot.admitted)
          assert.equal(blankSnapshot.reason, 'POLICY_SNAPSHOT_ID_REQUIRED');

        const blankWorker = await kernel.admitEffect({
          id: 'effect-blank-worker',
          runId: 'run-1',
          stepId: claimed!.id,
          tenantId: 'tenant-a',
          type: 'http.write',
          idempotencyKey: 'blank-worker-key',
          policyDecisionId: 'decision-blank',
          policySnapshotId: 'policy-blank-v1',
          actionDigest: 'e'.repeat(64),
          request: { target: 'blank' },
          lease: { ...lease, workerId: '   ' },
          actor: 'worker-1',
        });
        assert.equal(blankWorker.admitted, false);
        if (!blankWorker.admitted) assert.equal(blankWorker.reason, 'LEASE_WORKER_ID_REQUIRED');
      } finally {
        await ctx.destroy(kernel);
      }
    });

    it('writes an outbox message for lifecycle events', async () => {
      const kernel = await ctx.create();
      try {
        await kernel.createRun(createRun(), 'gateway');
        const messages = await kernel.claimOutbox(10);
        assert.equal(messages.length, 1);
        assert.equal(messages[0]?.topic, 'commander.run.created');
        assert.equal(
          await kernel.markOutboxPublished(messages[0]!.id, messages[0]!.claimToken!),
          true,
        );
        assert.equal((await kernel.claimOutbox(10)).length, 0);
      } finally {
        await ctx.destroy(kernel);
      }
    });

    it('pauses and resumes runs', async () => {
      const kernel = await ctx.create();
      try {
        await kernel.createRun(createRun(), 'gateway');
        await claim(kernel, ctx);
        const paused = await kernel.pauseRun('run-1', 'tenant-a', 'control-plane');
        assert.equal(paused?.state, 'PAUSED');
        assert.equal(await claim(kernel, ctx), null);
        const resumed = await kernel.resumeRun('run-1', 'tenant-a', 'control-plane');
        assert.equal(resumed?.state, 'RUNNING');
        assert.equal((await claim(kernel, ctx))?.state, 'RUNNING');
      } finally {
        await ctx.destroy(kernel);
      }
    });

    it('L3-08a reconcileEffect advances COMPLETION_UNKNOWN only', async () => {
      const kernel = await ctx.create();
      try {
        await kernel.createRun(createRun(), 'gateway');
        const claimed = await claim(kernel, ctx);
        await seedFreshOperationsDrains(kernel, ctx, 'reconcile');
        await kernel.admitEffect({
          id: 'effect-recon',
          runId: 'run-1',
          stepId: claimed!.id,
          tenantId: 'tenant-a',
          type: 'ticket.create',
          idempotencyKey: 'idem-recon',
          policyDecisionId: 'decision-1',
          policySnapshotId: 'policy-v1',
          actionDigest: 'a'.repeat(64),
          request: { title: 't' },
          lease: claimed!.lease!,
          actor: 'worker-1',
        });
        await kernel.markEffectCompletionUnknown({
          effectId: 'effect-recon',
          tenantId: 'tenant-a',
          reason: 'timeout',
          actor: 'worker-1',
        });
        assert.equal(
          (
            await kernel.reconcileEffect({
              effectId: 'effect-recon',
              tenantId: 'tenant-a',
              state: 'COMPLETED',
              response: { ticketId: 'T-1' },
              actor: 'reconciler',
            })
          )?.state,
          'COMPLETED',
        );
      } finally {
        await ctx.destroy(kernel);
      }
    });

    it('requestReconcile and claimReconcileEffects respect scheduling', async () => {
      const kernel = await ctx.create();
      try {
        await kernel.createRun(createRun(), 'gateway');
        const claimed = await claim(kernel, ctx);
        await seedFreshOperationsDrains(kernel, ctx, 'claim-reconcile');
        await kernel.admitEffect({
          id: 'effect-claim',
          runId: 'run-1',
          stepId: claimed!.id,
          tenantId: 'tenant-a',
          type: 'connector.github.pull-request.create',
          idempotencyKey: 'claim-key',
          policyDecisionId: 'decision-1',
          policySnapshotId: 'policy-v1',
          actionDigest: 'a'.repeat(64),
          request: {},
          lease: claimed!.lease!,
          actor: 'worker-1',
        });
        await kernel.markEffectCompletionUnknown({
          effectId: 'effect-claim',
          tenantId: 'tenant-a',
          reason: 'timeout',
          actor: 'worker-1',
        });
        const requested = await kernel.requestReconcile({
          effectId: 'effect-claim',
          tenantId: 'tenant-a',
          actor: 'api',
        });
        assert.equal(requested.scheduled, true);
        if (!ctx.reconcileClaimUsesDatabaseClock) {
          assert.equal(
            (await kernel.claimReconcileEffects({ limit: 5, now: new Date(0) })).length,
            0,
          );
        }
        const claimedEffects = await kernel.claimReconcileEffects({
          limit: 5,
          now: ctx.reconcileClaimUsesDatabaseClock ? undefined : new Date(Date.now() + 120_000),
        });
        assert.equal(claimedEffects.length, 1);
      } finally {
        await ctx.destroy(kernel);
      }
    });

    it('failEffect transitions ADMITTED to FAILED while holding lease', async () => {
      const kernel = await ctx.create();
      try {
        await kernel.createRun(createRun(), 'gateway');
        const claimed = await claim(kernel, ctx);
        await seedFreshOperationsDrains(kernel, ctx, 'fail-effect');
        await kernel.admitEffect({
          id: 'effect-fail',
          runId: 'run-1',
          stepId: claimed!.id,
          tenantId: 'tenant-a',
          type: 'connector.github.pull-request.create',
          idempotencyKey: 'fail-key',
          policyDecisionId: 'decision-1',
          policySnapshotId: 'policy-v1',
          actionDigest: 'a'.repeat(64),
          request: {},
          lease: claimed!.lease!,
          actor: 'worker-1',
        });
        const failed = await kernel.failEffect({
          effectId: 'effect-fail',
          tenantId: 'tenant-a',
          lease: claimed!.lease!,
          error: { code: 'AUTH_FAILED', message: '401', retryable: false },
          actor: 'worker-1',
        });
        assert.equal(failed?.state, 'FAILED');
      } finally {
        await ctx.destroy(kernel);
      }
    });

    it('putKillSwitch and findMatchingKillSwitch', async () => {
      const kernel = await ctx.create();
      try {
        await kernel.putKillSwitch({
          tenantId: 'tenant-a',
          scope: 'tool',
          value: 'ticket.create',
          enabled: true,
          actor: 'ops',
          reason: 'block',
        });
        const match = await kernel.findMatchingKillSwitch('tenant-a', {
          tool: 'ticket.create',
          effectType: 'demo.ticket.create',
        });
        assert.ok(match);
        assert.equal(match.scope, 'tool');
      } finally {
        await ctx.destroy(kernel);
      }
    });

    it('isActionAllowed fails closed without allowlist', async () => {
      const kernel = await ctx.create();
      try {
        assert.equal(await kernel.isActionAllowed('tenant-a', 'http.post'), false);
        await kernel.setAllowlistEntry('tenant-a', 'http.post', true);
        assert.equal(await kernel.isActionAllowed('tenant-a', 'http.post'), true);
      } finally {
        await ctx.destroy(kernel);
      }
    });

    it('incrementQuota and getQuota', async () => {
      const kernel = await ctx.create();
      try {
        const r1 = await kernel.incrementQuota({ tenantId: 'tenant-a', actionClass: 'http' });
        assert.equal(r1.countUsed, 1);
        assert.equal((await kernel.getQuota('tenant-a', 'http')).countUsed, 1);
      } finally {
        await ctx.destroy(kernel);
      }
    });

    it('createInteraction and answerInteraction wake step', async () => {
      const kernel = await ctx.create();
      try {
        await kernel.createRun(
          createRun([{ id: 'step-human', kind: 'tool', initialState: 'WAITING_FOR_HUMAN' }]),
          'gateway',
        );
        const interaction = await kernel.createInteraction(
          {
            runId: 'run-1',
            stepId: 'step-human',
            tenantId: 'tenant-a',
            prompt: 'Approve now?',
          },
          'gateway',
        );
        const answered = await kernel.answerInteraction({
          interactionId: interaction.id,
          runId: 'run-1',
          tenantId: 'tenant-a',
          response: { approved: true },
          actor: 'human',
        });
        assert.equal(answered.status, 'answered');
      } finally {
        await ctx.destroy(kernel);
      }
    });

    it('answerInteraction rejects an interaction past its expiry without releasing the step', async () => {
      const kernel = await ctx.create();
      try {
        await kernel.createRun(
          createRun([{ id: 'step-human', kind: 'tool', initialState: 'WAITING_FOR_HUMAN' }]),
          'gateway',
        );
        const interaction = await kernel.createInteraction(
          {
            runId: 'run-1',
            stepId: 'step-human',
            tenantId: 'tenant-a',
            prompt: 'Approve now?',
            expiresAt: new Date(Date.now() - 60_000),
          },
          'gateway',
        );
        await assert.rejects(
          () =>
            kernel.answerInteraction({
              interactionId: interaction.id,
              runId: 'run-1',
              tenantId: 'tenant-a',
              response: { approved: true },
              actor: 'human',
            }),
          (error: unknown) =>
            (error as { code?: string }).code === 'INTERACTION_EXPIRED' &&
            /expired/i.test((error as Error).message),
        );
        assert.equal((await kernel.getInteraction(interaction.id, 'tenant-a'))?.status, 'pending');
        assert.equal((await kernel.getStep('step-human', 'tenant-a'))?.state, 'WAITING_FOR_HUMAN');
      } finally {
        await ctx.destroy(kernel);
      }
    });

    it('createTimer claimExpiredTimers acknowledgeTimer', async () => {
      const kernel = await ctx.create();
      try {
        await kernel.createRun(createRun(), 'gateway');
        const firesAt = new Date(Date.now() - 1000);
        const timer = await kernel.createTimer(
          {
            runId: 'run-1',
            stepId: 'step-a',
            tenantId: 'tenant-a',
            firesAt,
            timerType: 'STEP_DEADLINE',
            payload: {},
          },
          'test',
        );
        const fired = await kernel.claimExpiredTimers(new Date(), 10);
        assert.ok(fired.some((t) => t.id === timer.id));
        const token = fired.find((t) => t.id === timer.id)?.claimToken;
        assert.ok(token);
        assert.equal(await kernel.acknowledgeTimer(timer.id, 'tenant-a', token!), true);
      } finally {
        await ctx.destroy(kernel);
      }
    });

    it('only performs valid run state transitions', async () => {
      const kernel = await ctx.create();
      try {
        await kernel.createRun(createRun(), 'gateway');
        await claim(kernel, ctx);
        assert.equal(validateRunTransition('PENDING', 'RUNNING').ok, true);
        await kernel.pauseRun('run-1', 'tenant-a', 'control-plane');
        assert.equal(validateRunTransition('RUNNING', 'PAUSED').ok, true);
      } finally {
        await ctx.destroy(kernel);
      }
    });

    it('claims and executes governed compensation published by requestCompensation', async () => {
      const kernel = await ctx.create();
      try {
        if (!ctx.seedCompensationWorker) return;
        const base = new Date();
        await seedFreshOperationsDrains(kernel, ctx, 'roundtrip');
        await kernel.createRun(
          {
            id: 'run-forward',
            tenantId: 'tenant-a',
            intentHash: 'intent-forward',
            workGraphHash: 'graph-forward',
            workGraphVersion: 'v1',
            policySnapshotId: 'policy-v1',
            steps: [
              {
                id: 'step-forward',
                kind: 'agent',
                maxAttempts: 1,
                scheduledAt: new Date(base.getTime() - 1_000).toISOString(),
              },
            ],
          },
          'gateway',
        );
        const forwardWorker = await ctx.seedWorker?.(kernel);
        const forwardActor = forwardWorker?.workerId ?? 'worker-1';
        const forwardStep = await kernel.claimNextStep({
          workerId: forwardActor,
          workerGeneration: forwardWorker?.generation ?? 1,
          leaseTtlMs: 60_000,
          tenantId: 'tenant-a',
          capabilities: ['agent', 'tool'],
        });
        assert.ok(forwardStep?.lease, `${ctx.name} must claim the forward step`);
        const destination = 'demo://ticket/roundtrip';
        const forwardResponse = { providerId: 'INC-roundtrip' };
        const admitted = await kernel.admitEffect({
          id: 'effect-forward',
          runId: 'run-forward',
          stepId: 'step-forward',
          tenantId: 'tenant-a',
          type: 'tool.ticket.create',
          idempotencyKey: 'effect-forward-key',
          request: { destination },
          policyDecisionId: 'policy-decision-forward',
          policySnapshotId: 'policy-v1',
          actionDigest: 'a'.repeat(64),
          lease: forwardStep.lease,
          actor: forwardActor,
        });
        assert.equal(admitted.admitted, true, JSON.stringify(admitted));
        assert.ok(
          await kernel.completeEffect(
            'effect-forward',
            'tenant-a',
            forwardStep.lease,
            forwardResponse,
            forwardActor,
          ),
        );

        const legacy: LegacyGovernedCompensationInput = {
          tenantId: 'tenant-a',
          originalRunId: 'run-forward',
          originalEffectId: 'effect-forward',
          forwardReceipt: forwardResponse,
          adapterVersion: 'demo-ticket/roundtrip/v1',
          compensationEffectType: 'compensate.demo.ticket.create',
          compensationPatch: { status: 'cancelled' },
          policyDecisionId: 'policy-decision-compensation',
          policySnapshotId: 'policy-compensation-v1',
          actionDigest: '',
          decisionEffect: 'allow',
          authorizationExpiresAt: new Date(Date.now() + 300_000).toISOString(),
          approvalBinding: null,
          actor: 'api-user',
        };
        const sealed = sealGovernedCompensationAuthorization(
          governedCompensationAuthorizationInput({
            request: legacy,
            originalRunStateAtRequest: 'RUNNING',
            originalEffect: { request: { destination }, response: forwardResponse },
          }),
        );
        // The durable authorization row stores the request/admission action digest,
        // not the sealed governed digest the compact outbox payload carries.
        const durableActionDigest = canonicalCompensationHash({
          type: legacy.compensationEffectType,
          originalEffectId: legacy.originalEffectId,
          adapterVersion: legacy.adapterVersion,
          destination,
          forwardResponse,
          compensationPatch: legacy.compensationPatch,
        });
        await kernel.createCompensationAuthorization({
          id: sealed.authorizationId,
          tenantId: 'tenant-a',
          originalRunId: legacy.originalRunId,
          originalEffectId: legacy.originalEffectId,
          compensationEffectType: legacy.compensationEffectType,
          adapterVersion: legacy.adapterVersion,
          compensationPatch: legacy.compensationPatch,
          forwardReceiptHash: sealed.forwardReceiptHash,
          policyDecisionId: legacy.policyDecisionId,
          policySnapshotId: legacy.policySnapshotId,
          decision: legacy.decisionEffect,
          actionDigest: durableActionDigest,
          expiresAt: legacy.authorizationExpiresAt,
        });
        const requested = await kernel.requestCompensation({
          tenantId: 'tenant-a',
          authorizationId: sealed.authorizationId,
          actor: 'api-user',
        });
        assert.equal(requested.accepted, true, JSON.stringify(requested));
        if (!requested.accepted) return;

        const compensationWorker = await ctx.seedCompensationWorker(kernel);
        const port: CompensationOutboxPort = {
          claimCompensationWork: (input) => kernel.claimCompensationWork(input),
          parkCompensationUnknown: async () => ({
            applied: true,
            disposition: 'COMPLETION_UNKNOWN',
            replayed: false,
          }),
          finalizeCompensation: async (input) => ({
            applied: true,
            disposition: input.disposition,
            replayed: false,
          }),
        };
        let executions = 0;
        let admittedRequest: Record<string, unknown> | undefined;
        const result = await consumeCompensationBatch(
          port,
          {
            admit: async (input) => {
              admittedRequest = input.request;
              return { admitted: true, effectId: input.effectId, replayed: false };
            },
            executeAdmitted: async (input) => {
              executions += 1;
              return { effectId: input.effectId, replayed: false, response: { ok: true } };
            },
          },
          async () => 'compensation-capability-token',
          {
            workerId: compensationWorker.workerId,
            workerGeneration: compensationWorker.generation,
            claimSecret: compensationWorker.claimSecret,
            topic: KERNEL_COMPENSATION_TOPIC,
            limit: 10,
            registry: {
              resolve: () => ({ descriptor: { adapterVersion: legacy.adapterVersion } }),
            },
          },
        );
        assert.equal(
          result.consumed,
          1,
          'compact producer payload must resolve durable governed authority',
        );
        assert.equal(result.succeeded, 1, JSON.stringify(result));
        assert.equal(result.escalated, 0);
        assert.equal(executions, 1);
        assert.equal(admittedRequest?.originalEffectId, legacy.originalEffectId);
        assert.equal(admittedRequest?.destination, destination);
        // A durable compensation claim moves the compensation run to
        // COMPENSATING — the state claim_compensation_request (the SQL authority)
        // writes and the state every settlement path requires before it will
        // advance the run. Pinned here so an implementation cannot quietly leave
        // the run in the generic RUNNING state, which no settlement matches.
        assert.equal(
          (await kernel.getRun(requested.request.compensationRunId, 'tenant-a'))?.state,
          'COMPENSATING',
        );
        assert.equal(
          (await kernel.getStep(requested.request.compensationStepId, 'tenant-a'))?.state,
          'RUNNING',
        );
      } finally {
        await ctx.destroy(kernel);
      }
    });

    it('admits a compensate.* effect through admitEffect from the compact producer payload', async () => {
      const kernel = await ctx.create();
      try {
        if (!ctx.seedCompensationWorker) return;
        const { work, workerId, request } = await seedClaimedGovernedCompensation(
          kernel,
          ctx,
          'admit',
        );
        const admitted = await kernel.admitEffect({
          id: request.compensationEffectId!,
          runId: request.compensationRunId,
          stepId: request.compensationStepId,
          tenantId: 'tenant-a',
          type: work.authorization.compensationEffectType,
          idempotencyKey: deriveEffectIdempotencyKey({
            tenantId: request.tenantId,
            runId: request.compensationRunId,
            stepId: request.compensationStepId,
            effectId: request.compensationEffectId!,
            request: {
              originalEffectId: request.originalEffectId,
              destination: request.destination,
              forwardResponse: work.forwardResponse,
              compensationPatch: request.compensationPatch,
            },
          }),
          policyDecisionId: work.authorization.policyDecisionId,
          policySnapshotId: work.authorization.policySnapshotId,
          actionDigest: work.authorization.actionDigest,
          request: {
            originalEffectId: request.originalEffectId,
            destination: request.destination,
            forwardResponse: work.forwardResponse,
            compensationPatch: request.compensationPatch,
          },
          lease: work.lease,
          compensationBinding: {
            requestId: request.id,
            authorizationId: work.authorization.id,
            claimToken: request.claimToken!,
          },
          actor: workerId,
        });
        assert.equal(admitted.admitted, true, JSON.stringify(admitted));
      } finally {
        await ctx.destroy(kernel);
      }
    });

    it('refuses a compensate.* admitEffect whose actionDigest matches only the compact payload', async () => {
      const kernel = await ctx.create();
      try {
        if (!ctx.seedCompensationWorker) return;
        const { work, workerId, request } = await seedClaimedGovernedCompensation(
          kernel,
          ctx,
          'durable-digest',
        );
        const admitted = await kernel.admitEffect({
          id: request.compensationEffectId!,
          runId: request.compensationRunId,
          stepId: request.compensationStepId,
          tenantId: 'tenant-a',
          type: work.authorization.compensationEffectType,
          idempotencyKey: deriveEffectIdempotencyKey({
            tenantId: request.tenantId,
            runId: request.compensationRunId,
            stepId: request.compensationStepId,
            effectId: request.compensationEffectId!,
            request: {
              originalEffectId: request.originalEffectId,
              destination: request.destination,
              forwardResponse: work.forwardResponse,
              compensationPatch: request.compensationPatch,
            },
          }),
          policyDecisionId: work.authorization.policyDecisionId,
          policySnapshotId: work.authorization.policySnapshotId,
          actionDigest: 'f'.repeat(64),
          request: {
            originalEffectId: request.originalEffectId,
            destination: request.destination,
            forwardResponse: work.forwardResponse,
            compensationPatch: request.compensationPatch,
          },
          lease: work.lease,
          compensationBinding: {
            requestId: request.id,
            authorizationId: work.authorization.id,
            claimToken: request.claimToken!,
          },
          actor: workerId,
        });
        assert.equal(admitted.admitted, false, JSON.stringify(admitted));
        if (!admitted.admitted) {
          assert.equal(admitted.reason, 'COMPENSATION_ADMISSION_UNAVAILABLE');
        }
      } finally {
        await ctx.destroy(kernel);
      }
    });
  });
}

// Default runners: only when this file is a direct test entry (test / test:sqlite).
// Importing runKernelRepositoryContractTests from postgres.integration must NOT
// also register InMemory/SQLite suites (shared-process pollution / missing native bindings).
import { InMemoryKernelRepository } from './inMemoryRepository.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const isDirectTestEntry = process.argv.some((arg) => {
  try {
    return import.meta.url === pathToFileURL(arg).href;
  } catch {
    return false;
  }
});

if (isDirectTestEntry) {
  runKernelRepositoryContractTests({
    name: 'InMemory',
    create: async () => new InMemoryKernelRepository(),
    destroy: async () => {},
    seedOperationsWorker: async (repo, input) => {
      (repo as InMemoryKernelRepository).seedTestWorker(input.id, input.tenantIds, 1, input);
    },
    seedCompensationWorker: async (repo) => {
      const claimSecret = (repo as InMemoryKernelRepository).seedTestWorker(
        'compensation:contract',
        ['tenant-a'],
        1,
        { capabilities: ['effect.compensate'], identitySubject: 'db:commander_adapter_ops' },
      );
      return { workerId: 'compensation:contract', generation: 1, claimSecret };
    },
  });

  runKernelRepositoryContractTests({
    name: 'SQLite',
    create: async () => {
      const dir = mkdtempSync(join(tmpdir(), 'kernel-contract-'));
      const path = join(dir, 'kernel.sqlite');
      const repo = new SqliteKernelRepository({ path, schedulerMode: true });
      await repo.initialize();
      (repo as SqliteKernelRepository & { _contractDir?: string })._contractDir = dir;
      return repo;
    },
    destroy: async (repo) => {
      const sqlite = repo as SqliteKernelRepository & { _contractDir?: string };
      sqlite.close();
      if (sqlite._contractDir) rmSync(sqlite._contractDir, { recursive: true, force: true });
    },
    seedWorker: async (repo) => {
      const sqlite = repo as SqliteKernelRepository;
      sqlite.seedTestWorker('worker-1', ['tenant-a'], 1);
      return { workerId: 'worker-1', generation: 1 };
    },
    seedOperationsWorker: async (repo, input) => {
      (repo as SqliteKernelRepository).seedTestWorker(input.id, input.tenantIds, 1, input);
    },
    seedCompensationWorker: async (repo) => {
      const claimSecret = (repo as SqliteKernelRepository).seedTestWorker(
        'compensation:contract',
        ['tenant-a'],
        1,
        { capabilities: ['effect.compensate'], identitySubject: 'db:commander_adapter_ops' },
      );
      return { workerId: 'compensation:contract', generation: 1, claimSecret };
    },
  });
}
