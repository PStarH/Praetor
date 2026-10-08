import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateRunTransition } from '@praetor/contracts';
import { InMemoryKernelRepository } from './testing/inMemoryRepository.js';
import { KERNEL_COMPENSATION_TOPIC } from './ops/compensationConsumer.js';
import type { KernelRun, NewKernelStep } from './types.js';

const createRun = (steps: NewKernelStep[] = [{ id: 'step-a', kind: 'agent' }]) => ({
  id: 'run-1',
  tenantId: 'tenant-a',
  intentHash: 'intent',
  workGraphHash: 'graph',
  workGraphVersion: 'v1',
  policySnapshotId: 'policy-v1',
  steps,
});

function seedOperationsReadiness(kernel: InMemoryKernelRepository, ...tenantIds: string[]): void {
  const now = new Date();
  for (const tenantId of tenantIds) {
    for (const [role, capability] of [
      ['reconcile', 'effect.reconcile'],
      ['compensation', 'effect.compensate'],
    ] as const) {
      kernel.seedTestWorker(`${role}:${tenantId}`, [tenantId], 1, {
        capabilities: [capability],
        identitySubject: 'db:commander_adapter_ops',
        registeredAt: new Date(now.getTime() - 10_000),
        lastHeartbeatAt: new Date(now.getTime() - 1_000),
      });
    }
  }
}

describe('execution kernel semantics', () => {
  it('claims dependency-ready work once and fences stale completion', async () => {
    const kernel = new InMemoryKernelRepository();
    await kernel.createRun(createRun(), 'gateway');
    const claimed = await kernel.claimNextStep({ workerId: 'worker-1', leaseTtlMs: 60_000 });
    assert.equal(claimed?.state, 'RUNNING');
    assert.equal(await kernel.claimNextStep({ workerId: 'worker-2', leaseTtlMs: 60_000 }), null);
    const stale = await kernel.completeStep({
      stepId: 'step-a',
      tenantId: claimed!.tenantId,
      lease: { workerId: 'worker-1', token: 'wrong', fencingEpoch: claimed!.lease!.fencingEpoch },
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
  });

  it('enforces graph dependencies and effect idempotency within a tenant', async () => {
    const kernel = new InMemoryKernelRepository();
    await kernel.createRun(
      createRun([
        { id: 'first', kind: 'agent' },
        { id: 'second', kind: 'tool', dependencies: ['first'] },
      ]),
      'gateway',
    );
    const first = await kernel.claimNextStep({ workerId: 'worker-1', leaseTtlMs: 60_000 });
    assert.equal(first?.id, 'first');
    assert.equal(await kernel.claimNextStep({ workerId: 'worker-2', leaseTtlMs: 60_000 }), null);
    seedOperationsReadiness(kernel, 'tenant-a');
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
    const conflict = await kernel.admitEffect({
      id: 'effect-3',
      runId: 'run-1',
      stepId: 'first',
      tenantId: 'tenant-a',
      type: 'http.write',
      idempotencyKey: 'key-1',
      policyDecisionId: 'decision-1',
      policySnapshotId: 'policy-v1',
      actionDigest: 'a'.repeat(64),
      request: { target: 'different' },
      lease: first!.lease!,
      actor: 'worker-1',
    });
    assert.equal(conflict.admitted, false);
    if (!conflict.admitted) assert.equal(conflict.reason, 'IDEMPOTENCY_CONFLICT');
    assert.equal(
      await kernel.completeEffect(
        'effect-1',
        'tenant-a',
        { workerId: 'worker-1', token: 'wrong', fencingEpoch: first!.lease!.fencingEpoch },
        { ok: true },
        'worker-1',
      ),
      null,
    );
    assert.ok(
      await kernel.completeEffect('effect-1', 'tenant-a', first!.lease!, { ok: true }, 'worker-1'),
    );
    await kernel.completeStep({
      stepId: 'first',
      tenantId: first!.tenantId,
      lease: first!.lease!,
      expectedVersion: first!.version,
      actor: 'worker-1',
    });
    assert.equal(
      (await kernel.claimNextStep({ workerId: 'worker-2', leaseTtlMs: 60_000 }))?.id,
      'second',
    );
  });

  it('pins policySnapshotId/actionDigest/lease fields and rejects IDEMPOTENCY_CONFLICT on snapshot or digest mismatch', async () => {
    const kernel = new InMemoryKernelRepository();
    await kernel.createRun(createRun([{ id: 'step-a', kind: 'agent' }]), 'gateway');
    const claimed = await kernel.claimNextStep({
      workerId: 'worker-1',
      workerGeneration: 1,
      leaseTtlMs: 60_000,
    });
    assert.ok(claimed?.lease);
    seedOperationsReadiness(kernel, 'tenant-a');
    const lease = claimed!.lease!;
    const digest = 'a'.repeat(64);
    const admitted = await kernel.admitEffect({
      id: 'effect-pin',
      runId: 'run-1',
      stepId: 'step-a',
      tenantId: 'tenant-a',
      type: 'http.write',
      idempotencyKey: 'pin-key',
      policyDecisionId: 'decision-1',
      policySnapshotId: 'policy-v1',
      actionDigest: digest,
      request: { target: 'x' },
      lease,
      actor: 'worker-1',
    });
    assert.equal(admitted.admitted, true);
    if (!admitted.admitted) return;
    assert.equal(admitted.effect.policySnapshotId, 'policy-v1');
    assert.equal(admitted.effect.actionDigest, digest);
    assert.equal(admitted.effect.leaseWorkerId, lease.workerId);
    assert.equal(admitted.effect.leaseWorkerGeneration, lease.workerGeneration ?? 0);
    assert.equal(admitted.effect.leaseFencingEpoch, lease.fencingEpoch);

    const snapshotConflict = await kernel.admitEffect({
      id: 'effect-pin-snap',
      runId: 'run-1',
      stepId: 'step-a',
      tenantId: 'tenant-a',
      type: 'http.write',
      idempotencyKey: 'pin-key',
      policyDecisionId: 'decision-1',
      policySnapshotId: 'policy-v2',
      actionDigest: digest,
      request: { target: 'x' },
      lease,
      actor: 'worker-1',
    });
    assert.equal(snapshotConflict.admitted, false);
    if (!snapshotConflict.admitted) assert.equal(snapshotConflict.reason, 'IDEMPOTENCY_CONFLICT');

    const digestConflict = await kernel.admitEffect({
      id: 'effect-pin-digest',
      runId: 'run-1',
      stepId: 'step-a',
      tenantId: 'tenant-a',
      type: 'http.write',
      idempotencyKey: 'pin-key',
      policyDecisionId: 'decision-1',
      policySnapshotId: 'policy-v1',
      actionDigest: 'b'.repeat(64),
      request: { target: 'x' },
      lease,
      actor: 'worker-1',
    });
    assert.equal(digestConflict.admitted, false);
    if (!digestConflict.admitted) assert.equal(digestConflict.reason, 'IDEMPOTENCY_CONFLICT');
  });

  it('admitEffect fails closed on blank policySnapshotId / lease.workerId (never coerces to legacy-unbound)', async () => {
    const kernel = new InMemoryKernelRepository();
    await kernel.createRun(createRun([{ id: 'step-a', kind: 'agent' }]), 'gateway');
    const claimed = await kernel.claimNextStep({
      workerId: 'worker-1',
      workerGeneration: 1,
      leaseTtlMs: 60_000,
    });
    assert.ok(claimed?.lease);
    const lease = claimed!.lease!;

    const blankSnapshot = await kernel.admitEffect({
      id: 'effect-blank-snapshot',
      runId: 'run-1',
      stepId: 'step-a',
      tenantId: 'tenant-a',
      type: 'http.write',
      idempotencyKey: 'blank-snapshot-key',
      policyDecisionId: 'decision-1',
      policySnapshotId: '   ',
      actionDigest: 'c'.repeat(64),
      request: { target: 'x' },
      lease,
      actor: 'worker-1',
    });
    assert.equal(blankSnapshot.admitted, false);
    if (!blankSnapshot.admitted) assert.equal(blankSnapshot.reason, 'POLICY_SNAPSHOT_ID_REQUIRED');

    const blankWorker = await kernel.admitEffect({
      id: 'effect-blank-worker',
      runId: 'run-1',
      stepId: 'step-a',
      tenantId: 'tenant-a',
      type: 'http.write',
      idempotencyKey: 'blank-worker-key',
      policyDecisionId: 'decision-1',
      policySnapshotId: 'policy-v1',
      actionDigest: 'd'.repeat(64),
      request: { target: 'x' },
      lease: { ...lease, workerId: '   ' },
      actor: 'worker-1',
    });
    assert.equal(blankWorker.admitted, false);
    if (!blankWorker.admitted) assert.equal(blankWorker.reason, 'LEASE_WORKER_ID_REQUIRED');
  });

  it('listEffectsForRun returns ledger rows scoped by runId and tenantId', async () => {
    const kernel = new InMemoryKernelRepository();
    await kernel.createRun(createRun([{ id: 'step-a', kind: 'agent' }]), 'gateway');
    await kernel.createRun(
      {
        ...createRun([{ id: 'step-b', kind: 'agent' }]),
        id: 'run-2',
        tenantId: 'tenant-b',
      },
      'gateway',
    );
    const stepA = await kernel.claimNextStep({
      workerId: 'worker-1',
      leaseTtlMs: 60_000,
      tenantId: 'tenant-a',
    });
    const stepB = await kernel.claimNextStep({
      workerId: 'worker-2',
      leaseTtlMs: 60_000,
      tenantId: 'tenant-b',
    });
    assert.ok(stepA?.lease);
    assert.ok(stepB?.lease);
    seedOperationsReadiness(kernel, 'tenant-a', 'tenant-b');
    assert.equal(
      (
        await kernel.admitEffect({
          id: 'eff-run1',
          runId: 'run-1',
          stepId: 'step-a',
          tenantId: 'tenant-a',
          type: 'http.write',
          idempotencyKey: 'k-a',
          policyDecisionId: 'pd-a',
          policySnapshotId: 'policy-v1',
          actionDigest: 'a'.repeat(64),
          request: { target: 'a' },
          lease: stepA.lease,
          actor: 'worker-1',
        })
      ).admitted,
      true,
    );
    assert.equal(
      (
        await kernel.admitEffect({
          id: 'eff-run2',
          runId: 'run-2',
          stepId: 'step-b',
          tenantId: 'tenant-b',
          type: 'http.write',
          idempotencyKey: 'k-b',
          policyDecisionId: 'pd-b',
          policySnapshotId: 'policy-v1',
          actionDigest: 'a'.repeat(64),
          request: { target: 'b' },
          lease: stepB.lease,
          actor: 'worker-2',
        })
      ).admitted,
      true,
    );

    const forRun1 = await kernel.listEffectsForRun('run-1', 'tenant-a');
    assert.equal(forRun1.length, 1);
    assert.equal(forRun1[0]?.id, 'eff-run1');
    assert.deepEqual(await kernel.listEffectsForRun('run-1', 'tenant-b'), []);
    assert.deepEqual(await kernel.listEffectsForRun('run-missing', 'tenant-a'), []);
  });

  it('writes an outbox message for lifecycle events', async () => {
    const kernel = new InMemoryKernelRepository();
    await kernel.createRun(createRun(), 'gateway');
    const messages = await kernel.claimOutbox(10);
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.topic, 'commander.run.created');
    assert.equal(await kernel.markOutboxPublished(messages[0]!.id, messages[0]!.claimToken!), true);
    assert.equal((await kernel.claimOutbox(10)).length, 0);
  });

  it('reclaims an expired lease and fails the run after retry budget is exhausted', async () => {
    const kernel = new InMemoryKernelRepository();
    await kernel.createRun(createRun([{ id: 'step-a', kind: 'agent', maxAttempts: 1 }]), 'gateway');
    const claimed = await kernel.claimNextStep({ workerId: 'worker-1', leaseTtlMs: 1 });
    const reclaimed = await kernel.reclaimExpiredLeases(new Date(Date.now() + 10));
    assert.equal(reclaimed[0]?.state, 'FAILED');
    assert.equal((await kernel.getRun(claimed!.runId, 'tenant-a'))?.state, 'FAILED');
  });

  it('keeps an expired lease reconcilable when an effect was already admitted', async () => {
    const kernel = new InMemoryKernelRepository();
    await kernel.createRun(createRun([{ id: 'step-a', kind: 'agent', maxAttempts: 1 }]), 'gateway');
    seedOperationsReadiness(kernel, 'tenant-a');
    const claimed = await kernel.claimNextStep({ workerId: 'worker-1', leaseTtlMs: 60_000 });
    assert.ok(claimed?.lease);
    const admitted = await kernel.admitEffect({
      id: 'effect-expired-lease',
      runId: claimed!.runId,
      stepId: claimed!.id,
      tenantId: claimed!.tenantId,
      type: 'http.write',
      idempotencyKey: 'expired-lease-effect',
      policyDecisionId: 'decision-1',
      policySnapshotId: 'policy-v1',
      actionDigest: 'a'.repeat(64),
      request: { target: 'x' },
      lease: claimed!.lease,
      actor: 'worker-1',
    });
    assert.equal(admitted.admitted, true);

    const reclaimed = await kernel.reclaimExpiredLeases(new Date(Date.now() + 60_001));

    assert.equal(reclaimed[0]?.state, 'WAITING_FOR_RECONCILIATION');
    assert.equal(
      (await kernel.getStep(claimed!.id, claimed!.tenantId))?.state,
      'WAITING_FOR_RECONCILIATION',
    );
    assert.equal(
      (await kernel.getEffect('effect-expired-lease', claimed!.tenantId))?.state,
      'COMPLETION_UNKNOWN',
    );
    assert.equal((await kernel.getRun(claimed!.runId, claimed!.tenantId))?.state, 'RUNNING');
  });

  it('applies worker capability and tenant-wide concurrency constraints at claim time', async () => {
    const kernel = new InMemoryKernelRepository();
    await kernel.setTenantConcurrencyLimit('tenant-a', 1);
    await kernel.createRun(
      createRun([
        { id: 'tool-step', kind: 'tool' },
        { id: 'agent-step', kind: 'agent' },
      ]),
      'gateway',
    );
    const tool = await kernel.claimNextStep({
      workerId: 'tool-worker',
      leaseTtlMs: 60_000,
      tenantIds: ['tenant-a'],
      capabilities: ['tool'],
    });
    assert.equal(tool?.id, 'tool-step');
    assert.equal(
      await kernel.claimNextStep({
        workerId: 'agent-worker',
        leaseTtlMs: 60_000,
        tenantIds: ['tenant-a'],
        capabilities: ['agent'],
      }),
      null,
    );
    await kernel.completeStep({
      stepId: tool!.id,
      tenantId: tool!.tenantId,
      lease: tool!.lease!,
      expectedVersion: tool!.version,
      actor: 'tool-worker',
    });
    assert.equal(
      (
        await kernel.claimNextStep({
          workerId: 'agent-worker',
          leaseTtlMs: 60_000,
          tenantIds: ['tenant-a'],
          capabilities: ['agent'],
        })
      )?.id,
      'agent-step',
    );
  });

  it('pauses a running run and releases active worker leases', async () => {
    const kernel = new InMemoryKernelRepository();
    await kernel.createRun(createRun(), 'gateway');
    const claimed = await kernel.claimNextStep({ workerId: 'worker-1', leaseTtlMs: 60_000 });
    assert.equal(claimed?.state, 'RUNNING');
    const paused = await kernel.pauseRun('run-1', 'tenant-a', 'control-plane');
    assert.equal(paused?.state, 'PAUSED');
    assert.equal((await kernel.getStep('step-a', 'tenant-a'))?.state, 'RETRY_WAIT');
    assert.equal(await kernel.claimNextStep({ workerId: 'worker-2', leaseTtlMs: 60_000 }), null);
    const events = await kernel.listEvents('run-1', 'tenant-a');
    assert.ok(events.some((event) => event.type === 'run.paused'));
    assert.ok(events.some((event) => event.type === 'step.paused'));
  });

  it('resumes a paused run so steps become claimable again', async () => {
    const kernel = new InMemoryKernelRepository();
    await kernel.createRun(createRun(), 'gateway');
    await kernel.claimNextStep({ workerId: 'worker-1', leaseTtlMs: 60_000 });
    await kernel.pauseRun('run-1', 'tenant-a', 'control-plane');
    const resumed = await kernel.resumeRun('run-1', 'tenant-a', 'control-plane');
    assert.equal(resumed?.state, 'RUNNING');
    assert.equal(resumed?.pausedAt, undefined);
    const reclaimed = await kernel.claimNextStep({ workerId: 'worker-2', leaseTtlMs: 60_000 });
    assert.equal(reclaimed?.state, 'RUNNING');
    const events = await kernel.listEvents('run-1', 'tenant-a');
    assert.ok(events.some((event) => event.type === 'run.resumed'));
  });

  it('cancels a run and marks all non-terminal steps cancelled', async () => {
    const kernel = new InMemoryKernelRepository();
    await kernel.createRun(
      createRun([
        { id: 'first', kind: 'agent' },
        { id: 'second', kind: 'tool', dependencies: ['first'] },
      ]),
      'gateway',
    );
    const first = await kernel.claimNextStep({ workerId: 'worker-1', leaseTtlMs: 60_000 });
    assert.equal(first?.id, 'first');
    const cancelled = await kernel.cancelRun('run-1', 'tenant-a', 'control-plane');
    assert.equal(cancelled?.state, 'CANCELLED');
    assert.equal((await kernel.getStep('first', 'tenant-a'))?.state, 'CANCELLED');
    assert.equal((await kernel.getStep('second', 'tenant-a'))?.state, 'CANCELLED');
    assert.equal(await kernel.claimNextStep({ workerId: 'worker-2', leaseTtlMs: 60_000 }), null);
    const events = await kernel.listEvents('run-1', 'tenant-a');
    assert.ok(events.some((event) => event.type === 'run.cancelled'));
    assert.ok(events.some((event) => event.type === 'step.cancelled'));
  });

  it('rejects lifecycle commands on terminal runs', async () => {
    const kernel = new InMemoryKernelRepository();
    await kernel.createRun(createRun(), 'gateway');
    const claimed = await kernel.claimNextStep({ workerId: 'worker-1', leaseTtlMs: 60_000 });
    await kernel.completeStep({
      stepId: 'step-a',
      tenantId: claimed!.tenantId,
      lease: claimed!.lease!,
      expectedVersion: claimed!.version,
      actor: 'worker-1',
    });
    assert.equal((await kernel.getRun('run-1', 'tenant-a'))?.state, 'SUCCEEDED');
    assert.equal(await kernel.pauseRun('run-1', 'tenant-a', 'control-plane'), null);
    assert.equal(await kernel.resumeRun('run-1', 'tenant-a', 'control-plane'), null);
    assert.equal(await kernel.cancelRun('run-1', 'tenant-a', 'control-plane'), null);
  });

  it('only performs run state transitions that are valid in @praetor/contracts', async () => {
    const kernel = new InMemoryKernelRepository();
    await kernel.createRun(createRun(), 'gateway');
    let run: KernelRun | null = await kernel.getRun('run-1', 'tenant-a');
    assert.equal(run?.state, 'PENDING');
    const claimed = await kernel.claimNextStep({ workerId: 'worker-1', leaseTtlMs: 60_000 });
    assert.equal(validateRunTransition('PENDING', 'RUNNING').ok, true);
    run = await kernel.pauseRun('run-1', 'tenant-a', 'control-plane');
    assert.equal(run?.state, 'PAUSED');
    assert.equal(validateRunTransition('RUNNING', 'PAUSED').ok, true);
    run = await kernel.resumeRun('run-1', 'tenant-a', 'control-plane');
    assert.equal(run?.state, 'RUNNING');
    assert.equal(validateRunTransition('PAUSED', 'RUNNING').ok, true);
    run = await kernel.cancelRun('run-1', 'tenant-a', 'control-plane');
    assert.equal(run?.state, 'CANCELLED');
    assert.equal(validateRunTransition('RUNNING', 'CANCELLED').ok, true);
    assert.equal(await kernel.pauseRun('run-1', 'tenant-a', 'control-plane'), null);
    assert.equal(validateRunTransition('CANCELLED', 'PAUSED').ok, false);
  });

  it('fences a completion presented with a stale worker generation', async () => {
    const kernel = new InMemoryKernelRepository();
    await kernel.createRun(createRun([{ id: 'step-generation', kind: 'agent' }]), 'gateway');
    const claimed = await kernel.claimNextStep({
      workerId: 'worker-1',
      workerGeneration: 7,
      leaseTtlMs: 60_000,
    });
    assert.equal(claimed?.lease?.workerGeneration, 7);
    const stale = await kernel.completeStep({
      stepId: 'step-generation',
      tenantId: claimed!.tenantId,
      lease: { ...claimed!.lease!, workerGeneration: 6 },
      expectedVersion: claimed!.version,
      actor: 'worker-1',
    });
    assert.equal(stale, null);
    assert.equal((await kernel.getStep('step-generation', 'tenant-a'))?.state, 'RUNNING');
  });

  it('rejects completeStep, failStep, and heartbeatStep with a mismatched tenantId', async () => {
    const kernel = new InMemoryKernelRepository();
    await kernel.createRun(createRun(), 'gateway');
    const claimed = await kernel.claimNextStep({ workerId: 'worker-1', leaseTtlMs: 60_000 });
    assert.ok(claimed?.lease);

    assert.equal(
      await kernel.completeStep({
        stepId: claimed!.id,
        tenantId: 'tenant-b',
        lease: claimed!.lease!,
        expectedVersion: claimed!.version,
        output: { hacked: true },
        actor: 'attacker',
      }),
      null,
    );
    assert.equal((await kernel.getStep('step-a', 'tenant-a'))?.state, 'RUNNING');

    assert.equal(
      await kernel.failStep({
        stepId: claimed!.id,
        tenantId: 'tenant-b',
        lease: claimed!.lease!,
        expectedVersion: claimed!.version,
        error: { code: 'TEST', message: 'cross-tenant fail', retryable: false },
        actor: 'attacker',
      }),
      null,
    );
    assert.equal((await kernel.getStep('step-a', 'tenant-a'))?.state, 'RUNNING');

    assert.equal(
      await kernel.heartbeatStep(claimed!.id, 'tenant-b', claimed!.lease!, 60_000),
      null,
    );
    assert.equal((await kernel.getStep('step-a', 'tenant-a'))?.state, 'RUNNING');
  });

  it('L3-08a reconcileEffect advances COMPLETION_UNKNOWN only (CAS)', async () => {
    const kernel = new InMemoryKernelRepository();
    await kernel.createRun(createRun(), 'gateway');
    const claimed = await kernel.claimNextStep({ workerId: 'worker-1', leaseTtlMs: 60_000 });
    assert.ok(claimed?.lease);
    seedOperationsReadiness(kernel, 'tenant-a');
    const admitted = await kernel.admitEffect({
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
    assert.equal(admitted.admitted, true);
    assert.equal(
      (
        await kernel.markEffectCompletionUnknown({
          effectId: 'effect-recon',
          tenantId: 'tenant-a',
          reason: 'timeout',
          actor: 'worker-1',
        })
      )?.state,
      'COMPLETION_UNKNOWN',
    );
    assert.equal(
      await kernel.reconcileEffect({
        effectId: 'effect-recon',
        tenantId: 'tenant-b',
        state: 'COMPLETED',
        response: { ok: true },
        actor: 'reconciler',
      }),
      null,
      'cross-tenant reconcile must fail',
    );
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
    assert.equal(
      await kernel.reconcileEffect({
        effectId: 'effect-recon',
        tenantId: 'tenant-a',
        state: 'FAILED',
        response: { retry: true },
        actor: 'reconciler',
      }),
      null,
      'second reconcile must be rejected (no longer UNKNOWN)',
    );
  });

  it('parks ADMITTED effects as COMPLETION_UNKNOWN when failStep ends the step', async () => {
    const kernel = new InMemoryKernelRepository();
    await kernel.createRun(createRun(), 'gateway');
    const claimed = await kernel.claimNextStep({ workerId: 'worker-1', leaseTtlMs: 60_000 });
    assert.ok(claimed?.lease);
    seedOperationsReadiness(kernel, 'tenant-a');
    assert.equal(
      (
        await kernel.admitEffect({
          id: 'effect-orphan',
          runId: 'run-1',
          stepId: claimed!.id,
          tenantId: 'tenant-a',
          type: 'http.write',
          idempotencyKey: 'orphan-key',
          policyDecisionId: 'decision-1',
          policySnapshotId: 'policy-v1',
          actionDigest: 'a'.repeat(64),
          request: { target: 'x' },
          lease: claimed!.lease!,
          actor: 'worker-1',
        })
      ).admitted,
      true,
    );
    const failed = await kernel.failStep({
      stepId: claimed!.id,
      tenantId: 'tenant-a',
      lease: claimed!.lease!,
      expectedVersion: claimed!.version,
      error: { code: 'WORKER_CRASH', message: 'died after admit', retryable: false },
      actor: 'worker-1',
    });
    assert.equal(failed?.state, 'FAILED');
    assert.equal(
      (await kernel.getEffect('effect-orphan', 'tenant-a'))?.state,
      'COMPLETION_UNKNOWN',
    );
  });

  // F-K1-22: the previous name claimed this test proved the refund path, but the
  // body omits `refundAttempt` and asserts terminal FAILED. Renamed to the
  // contrast case it actually is; the refund path is the next test.
  it('fails terminally at maxAttempts=1 when failStep omits refundAttempt', async () => {
    const kernel = new InMemoryKernelRepository();
    await kernel.createRun(createRun([{ id: 'step-a', kind: 'agent', maxAttempts: 1 }]), 'gateway');
    const claimed = await kernel.claimNextStep({ workerId: 'worker-1', leaseTtlMs: 60_000 });
    assert.ok(claimed?.lease);
    assert.equal(claimed!.attempt, 1);

    const withoutRefund = await kernel.failStep({
      stepId: claimed!.id,
      tenantId: 'tenant-a',
      lease: claimed!.lease!,
      expectedVersion: claimed!.version,
      error: { code: 'WORKER_STOPPED', message: 'stopped', retryable: true },
      retryAt: new Date(),
      actor: 'worker-1',
    });
    assert.equal(
      withoutRefund?.state,
      'FAILED',
      'without refundAttempt, attempt=1 >= maxAttempts=1 → FAILED',
    );
  });

  it('requeues with refundAttempt under default maxAttempts=1 after claim', async () => {
    const kernel = new InMemoryKernelRepository();
    await kernel.createRun(createRun([{ id: 'step-a', kind: 'agent', maxAttempts: 1 }]), 'gateway');
    const claimed = await kernel.claimNextStep({ workerId: 'worker-1', leaseTtlMs: 60_000 });
    assert.ok(claimed?.lease);
    assert.equal(claimed!.attempt, 1);

    const released = await kernel.failStep({
      stepId: claimed!.id,
      tenantId: 'tenant-a',
      lease: claimed!.lease!,
      expectedVersion: claimed!.version,
      error: { code: 'WORKER_STOPPED', message: 'stopped during claim', retryable: true },
      retryAt: new Date(),
      refundAttempt: true,
      actor: 'worker-1',
    });
    assert.equal(released?.state, 'RETRY_WAIT');
    assert.equal(released?.attempt, 0);

    const reclaimed = await kernel.claimNextStep({ workerId: 'worker-2', leaseTtlMs: 60_000 });
    assert.equal(reclaimed?.id, 'step-a');
    assert.equal(reclaimed?.attempt, 1);
  });

  it('rejects createInteraction when step is not bound to the given tenant/run', async () => {
    const kernel = new InMemoryKernelRepository();
    await kernel.createRun(createRun(), 'gateway');
    await assert.rejects(
      () =>
        kernel.createInteraction(
          { runId: 'run-1', stepId: 'step-a', tenantId: 'tenant-b', prompt: 'cross-tenant?' },
          'attacker',
        ),
      (err: unknown) =>
        err instanceof Error && (err as { code?: string }).code === 'STEP_NOT_FOUND',
    );
    await assert.rejects(
      () =>
        kernel.createInteraction(
          { runId: 'run-missing', stepId: 'step-a', tenantId: 'tenant-a', prompt: 'wrong run?' },
          'attacker',
        ),
      (err: unknown) =>
        err instanceof Error && (err as { code?: string }).code === 'STEP_NOT_FOUND',
    );
  });

  it('parks ADMITTED effects as COMPLETION_UNKNOWN when cancelRun ends open steps', async () => {
    const kernel = new InMemoryKernelRepository();
    await kernel.createRun(createRun(), 'gateway');
    const claimed = await kernel.claimNextStep({ workerId: 'worker-1', leaseTtlMs: 60_000 });
    assert.ok(claimed?.lease);
    seedOperationsReadiness(kernel, 'tenant-a');
    assert.equal(
      (
        await kernel.admitEffect({
          id: 'effect-cancel-orphan',
          runId: 'run-1',
          stepId: claimed!.id,
          tenantId: 'tenant-a',
          type: 'http.write',
          idempotencyKey: 'cancel-orphan-key',
          policyDecisionId: 'decision-1',
          policySnapshotId: 'policy-v1',
          actionDigest: 'a'.repeat(64),
          request: { target: 'z' },
          lease: claimed!.lease!,
          actor: 'worker-1',
        })
      ).admitted,
      true,
    );
    const cancelled = await kernel.cancelRun('run-1', 'tenant-a', 'control-plane');
    assert.equal(cancelled?.state, 'CANCELLED');
    assert.equal((await kernel.getStep('step-a', 'tenant-a'))?.state, 'CANCELLED');
    assert.equal(
      (await kernel.getEffect('effect-cancel-orphan', 'tenant-a'))?.state,
      'COMPLETION_UNKNOWN',
    );
  });

  it('requires separate compensation authority when failStep follows a completed effect', async () => {
    const kernel = new InMemoryKernelRepository();
    await kernel.createRun(createRun([{ id: 'step-a', kind: 'agent', maxAttempts: 1 }]), 'gateway');
    const claimed = await kernel.claimNextStep({ workerId: 'worker-1', leaseTtlMs: 60_000 });
    assert.ok(claimed?.lease);
    seedOperationsReadiness(kernel, 'tenant-a');
    assert.equal(
      (
        await kernel.admitEffect({
          id: 'effect-done',
          runId: 'run-1',
          stepId: claimed!.id,
          tenantId: 'tenant-a',
          type: 'http.write',
          idempotencyKey: 'done-key',
          policyDecisionId: 'decision-1',
          policySnapshotId: 'policy-v1',
          actionDigest: 'a'.repeat(64),
          request: { target: 'crm' },
          lease: claimed!.lease!,
          actor: 'worker-1',
        })
      ).admitted,
      true,
    );
    assert.ok(
      await kernel.completeEffect(
        'effect-done',
        'tenant-a',
        claimed!.lease!,
        { ok: true },
        'worker-1',
      ),
    );

    const failed = await kernel.failStep({
      stepId: claimed!.id,
      tenantId: 'tenant-a',
      lease: claimed!.lease!,
      expectedVersion: claimed!.version,
      error: { code: 'DOWNSTREAM_FAILED', message: 'post-effect failure', retryable: false },
      actor: 'worker-1',
    });
    assert.equal(failed?.state, 'FAILED');
    assert.equal((await kernel.getRun('run-1', 'tenant-a'))?.state, 'RUNNING');

    const messages = await kernel.claimOutboxByTopic(KERNEL_COMPENSATION_TOPIC, 100);
    assert.equal(messages.length, 0);
    assert.equal(
      (await kernel.listEvents('run-1', 'tenant-a')).some(
        (event) => event.type === 'compensation.authorization_required',
      ),
      true,
    );
  });

  it('requires separate compensation authority when failStepByTimer follows a completed effect', async () => {
    const kernel = new InMemoryKernelRepository();
    await kernel.createRun(createRun([{ id: 'step-a', kind: 'agent', maxAttempts: 1 }]), 'gateway');
    const claimed = await kernel.claimNextStep({ workerId: 'worker-1', leaseTtlMs: 60_000 });
    assert.ok(claimed?.lease);
    seedOperationsReadiness(kernel, 'tenant-a');
    assert.equal(
      (
        await kernel.admitEffect({
          id: 'effect-deadline',
          runId: 'run-1',
          stepId: claimed!.id,
          tenantId: 'tenant-a',
          type: 'http.write',
          idempotencyKey: 'deadline-key',
          policyDecisionId: 'decision-1',
          policySnapshotId: 'policy-v1',
          actionDigest: 'a'.repeat(64),
          request: { target: 'crm' },
          lease: claimed!.lease!,
          actor: 'worker-1',
        })
      ).admitted,
      true,
    );
    assert.ok(
      await kernel.completeEffect(
        'effect-deadline',
        'tenant-a',
        claimed!.lease!,
        { ok: true },
        'worker-1',
      ),
    );

    const failed = await kernel.failStepByTimer(
      claimed!.id,
      'tenant-a',
      { code: 'STEP_DEADLINE_EXCEEDED', message: 'deadline', retryable: false },
      'kernel.timer',
    );
    assert.equal(failed?.state, 'FAILED');
    assert.equal((await kernel.getRun('run-1', 'tenant-a'))?.state, 'RUNNING');
    const messages = await kernel.claimOutboxByTopic(KERNEL_COMPENSATION_TOPIC, 100);
    assert.equal(messages.length, 0);
  });

  it('keeps a paused run non-terminal when failStepByTimer lacks compensation authorization', async () => {
    const kernel = new InMemoryKernelRepository();
    await kernel.createRun(createRun([{ id: 'step-a', kind: 'agent', maxAttempts: 1 }]), 'gateway');
    const claimed = await kernel.claimNextStep({ workerId: 'worker-1', leaseTtlMs: 60_000 });
    assert.ok(claimed?.lease);
    seedOperationsReadiness(kernel, 'tenant-a');
    assert.equal(
      (
        await kernel.admitEffect({
          id: 'effect-paused',
          runId: 'run-1',
          stepId: claimed!.id,
          tenantId: 'tenant-a',
          type: 'http.write',
          idempotencyKey: 'paused-key',
          policyDecisionId: 'decision-1',
          policySnapshotId: 'policy-v1',
          actionDigest: 'a'.repeat(64),
          request: { target: 'crm' },
          lease: claimed!.lease!,
          actor: 'worker-1',
        })
      ).admitted,
      true,
    );
    assert.ok(
      await kernel.completeEffect(
        'effect-paused',
        'tenant-a',
        claimed!.lease!,
        { ok: true },
        'worker-1',
      ),
    );

    const paused = await kernel.pauseRun('run-1', 'tenant-a', 'control-plane');
    assert.equal(paused?.state, 'PAUSED');
    // pauseRun parks RUNNING steps into RETRY_WAIT; timer may still fail them.
    assert.equal((await kernel.getStep(claimed!.id, 'tenant-a'))?.state, 'RETRY_WAIT');

    const failed = await kernel.failStepByTimer(
      claimed!.id,
      'tenant-a',
      { code: 'STEP_DEADLINE_EXCEEDED', message: 'deadline while paused', retryable: false },
      'kernel.timer',
    );
    assert.equal(failed?.state, 'FAILED');
    assert.equal((await kernel.getRun('run-1', 'tenant-a'))?.state, 'PAUSED');
    assert.equal(validateRunTransition('PAUSED', 'COMPENSATING').ok, true);

    const messages = await kernel.claimOutboxByTopic(KERNEL_COMPENSATION_TOPIC, 100);
    assert.equal(messages.length, 0);
    assert.equal(
      (await kernel.listEvents('run-1', 'tenant-a')).some(
        (event) => event.type === 'compensation.authorization_required',
      ),
      true,
    );
  });

  it('prefers higher effective priority after aging instead of clamping all steps to 1000', async () => {
    const kernel = new InMemoryKernelRepository();
    const base = new Date('2026-01-01T00:00:00.000Z');
    await kernel.createRun(
      {
        ...createRun([
          {
            id: 'low-old',
            kind: 'agent',
            priority: 0,
            scheduledAt: new Date(base.getTime() - 10 * 60_000).toISOString(),
          },
          {
            id: 'high-new',
            kind: 'agent',
            priority: 100,
            scheduledAt: base.toISOString(),
          },
        ]),
      },
      'gateway',
    );

    const first = await kernel.claimNextStep({
      workerId: 'worker-1',
      leaseTtlMs: 60_000,
      now: base,
    });
    assert.equal(first?.id, 'high-new');

    const second = await kernel.claimNextStep({
      workerId: 'worker-2',
      leaseTtlMs: 60_000,
      now: base,
    });
    assert.equal(second?.id, 'low-old');
  });

  it('does not let GREATEST clamp hide a higher-priority fresh step behind an older low-priority peer', async () => {
    // Contrast case for GREATEST(...,1000) false-green:
    // - high-fresh: priority 200 @ base → LEAST=200, GREATEST=1000, newer scheduled_at
    // - low-aged: priority 0 aged 5m → LEAST=5, GREATEST=1000, older scheduled_at
    // LEAST picks high-fresh (200>5). GREATEST ties both at 1000 then scheduled_at ASC
    // picks low-aged — so this assertion fails under the GREATEST regression.
    const kernel = new InMemoryKernelRepository();
    const base = new Date('2026-01-01T00:00:00.000Z');
    await kernel.createRun(
      {
        ...createRun([
          {
            id: 'low-aged',
            kind: 'agent',
            priority: 0,
            scheduledAt: new Date(base.getTime() - 5 * 60_000).toISOString(),
          },
          {
            id: 'high-fresh',
            kind: 'agent',
            priority: 200,
            scheduledAt: base.toISOString(),
          },
        ]),
      },
      'gateway',
    );

    const claimed = await kernel.claimNextStep({
      workerId: 'worker-1',
      leaseTtlMs: 60_000,
      now: base,
    });
    assert.equal(claimed?.id, 'high-fresh');
  });

  it('parks ADMITTED effects as COMPLETION_UNKNOWN when pauseRun revokes the lease', async () => {
    const kernel = new InMemoryKernelRepository();
    await kernel.createRun(createRun([{ id: 'step-a', kind: 'agent' }]), 'gateway');
    const claimed = await kernel.claimNextStep({ workerId: 'worker-1', leaseTtlMs: 60_000 });
    assert.ok(claimed?.lease);
    seedOperationsReadiness(kernel, 'tenant-a');
    assert.equal(
      (
        await kernel.admitEffect({
          id: 'effect-pause',
          runId: 'run-1',
          stepId: claimed!.id,
          tenantId: 'tenant-a',
          type: 'http.write',
          idempotencyKey: 'pause-key',
          policyDecisionId: 'decision-1',
          policySnapshotId: 'policy-v1',
          actionDigest: 'a'.repeat(64),
          request: { target: 'crm' },
          lease: claimed!.lease!,
          actor: 'worker-1',
        })
      ).admitted,
      true,
    );
    assert.equal((await kernel.getEffect('effect-pause', 'tenant-a'))?.state, 'ADMITTED');

    const paused = await kernel.pauseRun('run-1', 'tenant-a', 'control-plane');
    assert.equal(paused?.state, 'PAUSED');
    assert.equal((await kernel.getStep(claimed!.id, 'tenant-a'))?.state, 'RETRY_WAIT');
    assert.equal((await kernel.getEffect('effect-pause', 'tenant-a'))?.state, 'COMPLETION_UNKNOWN');
    // Stale lease must not complete a parked effect after pause.
    assert.equal(
      await kernel.completeEffect(
        'effect-pause',
        'tenant-a',
        claimed!.lease!,
        { ok: true },
        'worker-1',
      ),
      null,
    );
  });

  it('parks ADMITTED effects as COMPLETION_UNKNOWN when pauseTenant revokes leases', async () => {
    const kernel = new InMemoryKernelRepository();
    await kernel.createRun(createRun([{ id: 'step-a', kind: 'agent' }]), 'gateway');
    const claimed = await kernel.claimNextStep({ workerId: 'worker-1', leaseTtlMs: 60_000 });
    assert.ok(claimed?.lease);
    seedOperationsReadiness(kernel, 'tenant-a');
    assert.equal(
      (
        await kernel.admitEffect({
          id: 'effect-tenant-pause',
          runId: 'run-1',
          stepId: claimed!.id,
          tenantId: 'tenant-a',
          type: 'http.write',
          idempotencyKey: 'tenant-pause-key',
          policyDecisionId: 'decision-1',
          policySnapshotId: 'policy-v1',
          actionDigest: 'a'.repeat(64),
          request: { target: 'crm' },
          lease: claimed!.lease!,
          actor: 'worker-1',
        })
      ).admitted,
      true,
    );

    await kernel.pauseTenant('tenant-a', 'operator', 'maintenance');
    assert.equal((await kernel.getStep(claimed!.id, 'tenant-a'))?.state, 'RETRY_WAIT');
    assert.equal(
      (await kernel.getEffect('effect-tenant-pause', 'tenant-a'))?.state,
      'COMPLETION_UNKNOWN',
    );
    assert.equal(
      await kernel.completeEffect(
        'effect-tenant-pause',
        'tenant-a',
        claimed!.lease!,
        { ok: true },
        'worker-1',
      ),
      null,
    );
  });

  it('cancels open sibling steps when a terminal fail finishes the run as FAILED', async () => {
    const kernel = new InMemoryKernelRepository();
    await kernel.createRun(
      createRun([
        { id: 'step-a', kind: 'agent', maxAttempts: 1 },
        { id: 'step-b', kind: 'agent', maxAttempts: 1 },
      ]),
      'gateway',
    );
    const claimed = await kernel.claimNextStep({ workerId: 'worker-1', leaseTtlMs: 60_000 });
    assert.equal(claimed?.id, 'step-a');
    assert.ok(claimed?.lease);

    const failed = await kernel.failStep({
      stepId: claimed!.id,
      tenantId: 'tenant-a',
      lease: claimed!.lease!,
      expectedVersion: claimed!.version,
      error: { code: 'DOWNSTREAM_FAILED', message: 'no effects', retryable: false },
      actor: 'worker-1',
    });
    assert.equal(failed?.state, 'FAILED');
    assert.equal((await kernel.getRun('run-1', 'tenant-a'))?.state, 'FAILED');
    assert.equal((await kernel.getStep('step-b', 'tenant-a'))?.state, 'CANCELLED');
    assert.equal(await kernel.claimNextStep({ workerId: 'worker-2', leaseTtlMs: 60_000 }), null);
  });

  it('keeps sibling steps open while terminal evidence is absent', async () => {
    const kernel = new InMemoryKernelRepository();
    await kernel.createRun(
      createRun([
        { id: 'step-a', kind: 'agent', maxAttempts: 1 },
        { id: 'step-b', kind: 'agent', maxAttempts: 1 },
      ]),
      'gateway',
    );
    const claimed = await kernel.claimNextStep({ workerId: 'worker-1', leaseTtlMs: 60_000 });
    assert.ok(claimed?.lease);
    seedOperationsReadiness(kernel, 'tenant-a');
    assert.equal(
      (
        await kernel.admitEffect({
          id: 'effect-sibling',
          runId: 'run-1',
          stepId: claimed!.id,
          tenantId: 'tenant-a',
          type: 'http.write',
          idempotencyKey: 'sibling-key',
          policyDecisionId: 'decision-1',
          policySnapshotId: 'policy-v1',
          actionDigest: 'a'.repeat(64),
          request: { target: 'crm' },
          lease: claimed!.lease!,
          actor: 'worker-1',
        })
      ).admitted,
      true,
    );
    assert.ok(
      await kernel.completeEffect(
        'effect-sibling',
        'tenant-a',
        claimed!.lease!,
        { ok: true },
        'worker-1',
      ),
    );

    const failed = await kernel.failStep({
      stepId: claimed!.id,
      tenantId: 'tenant-a',
      lease: claimed!.lease!,
      expectedVersion: claimed!.version,
      error: { code: 'DOWNSTREAM_FAILED', message: 'after effect', retryable: false },
      actor: 'worker-1',
    });
    assert.equal(failed?.state, 'FAILED');
    assert.equal((await kernel.getRun('run-1', 'tenant-a'))?.state, 'RUNNING');
    assert.equal((await kernel.getStep('step-b', 'tenant-a'))?.state, 'PENDING');
  });

  // Compensation execution is authorized only through the separately persisted authority flow.
});
