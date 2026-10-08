import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import { Pool } from 'pg';
import {
  PostgresKernelRepository,
  PostgresTenantContextAuthority,
  runKernelMigrations,
  seedWorkerAllowedTenants,
  type NewKernelStep,
} from '@praetor/kernel';
import {
  WorkerService,
  PostgresWorkerRegistry,
  ApiKeyWorkerAuthenticator,
  ToolStepExecutor,
  createWorkerPolicyEvaluator,
  type StepExecutor,
} from '@praetor/worker-plane';
import {
  CapabilityTokenIssuer,
  CapabilityTokenVerifier,
  EffectBroker,
  canonicalRequestHash,
  createEvidenceSigner,
} from '@praetor/effect-broker';
import { InMemoryKernelRepository } from '@praetor/kernel/testing/inMemoryRepository';
import { InMemoryWorkerRegistry } from '../registry.js';
import { InMemoryTicketAdapter } from '../ticketAdapter.js';
import type { KernelWorkerPort } from '../types.js';

const databaseUrl = process.env.COMMANDER_KERNEL_DATABASE_URL ?? process.env.DATABASE_URL;
const requirePg = process.env.COMMANDER_E2E_REQUIRE_PG === '1';
const workerPassword = process.env.COMMANDER_WORKER_PASSWORD ?? 'commander_worker';
const appPassword = process.env.COMMANDER_APP_PASSWORD ?? 'commander_app';

function deriveRoleDatabaseUrl(baseUrl: string, username: string, password: string): string {
  const url = new URL(baseUrl);
  url.username = username;
  url.password = password;
  return url.toString();
}

function deriveWorkerDatabaseUrl(baseUrl: string): string {
  return deriveRoleDatabaseUrl(baseUrl, 'commander_worker', workerPassword);
}

/** Deterministic executor — proves worker↔kernel claim/complete without AgentRuntime/LLM. */
const deterministicExecutor: StepExecutor = {
  async execute(step) {
    return {
      status: 'completed',
      summary: `deterministic:${String((step.input as { goal?: string })?.goal ?? '')}`,
      runId: step.runId,
    };
  },
};

function agentInput(goal: string): Record<string, unknown> {
  return {
    goal,
    agentId: 'agent-default',
    definitionVersion: 'v1',
    providerSnapshot: { provider: 'mock', model: 'mock-model' },
  };
}

async function createInMemoryActionRun(
  kernel: InMemoryKernelRepository,
  input: {
    runId: string;
    effect: 'allow' | 'deny' | 'require_approval';
    destination: string;
    effectType?: string;
    tool?: string;
    args?: Record<string, unknown>;
    executionArgs?: Record<string, unknown>;
  },
) {
  const tenantId = 'tenant-action-e2e';
  const stepId = `${input.runId}-step`;
  const effectId = `${input.runId}-effect`;
  const interactionId = `${input.runId}-interaction`;
  const envelope = {
    tenantId,
    source: 'e2e-agent',
    package: 'e2e-package',
    model: 'e2e-model',
    tool: input.tool ?? 'ticket.create',
    destination: input.destination,
    effectType: input.effectType ?? 'demo.ticket.create',
    args: input.args ?? { title: `${input.effect} ticket` },
    idempotencyKey: `${input.runId}-key`,
  };
  const actionDigest = canonicalRequestHash(envelope);
  const simulationId = `${input.runId}-simulation`;
  const decisionId = `action-gateway-${input.effect}`;
  const executionEnvelope = {
    ...envelope,
    args: input.executionArgs ?? envelope.args,
  };
  await kernel.createRun(
    {
      id: input.runId,
      tenantId,
      intentHash: 'intent-action-e2e',
      workGraphHash: 'graph-action-e2e',
      workGraphVersion: 'action-gateway/v1',
      policySnapshotId: 'action-gateway-mvp-v1',
      metadata: {
        actionGateway: {
          authority: 'commander.action-gateway/v1',
          stepId,
          effectId,
          interactionId: input.effect === 'require_approval' ? interactionId : undefined,
          actionDigest,
          policySnapshotId: 'action-gateway-mvp-v1',
          decision: {
            effect: input.effect,
            decisionId,
            reason: input.effect,
            policySnapshotId: 'action-gateway-mvp-v1',
          },
          simulation: {
            simulationId,
            actionDigest,
            effect: input.effect,
            decisionId,
            reason: input.effect,
            policySnapshotId: 'action-gateway-mvp-v1',
          },
          envelope,
        },
      },
      steps: [
        {
          id: stepId,
          kind: 'tool',
          initialState: input.effect === 'require_approval' ? 'WAITING_FOR_HUMAN' : 'PENDING',
          interaction:
            input.effect === 'require_approval'
              ? { id: interactionId, prompt: 'Approve demo ticket?' }
              : undefined,
          input: {
            toolName: envelope.tool,
            effectType: envelope.effectType,
            args: executionEnvelope.args,
            actionEnvelope: executionEnvelope,
            effectId,
            idempotencyKey: envelope.idempotencyKey,
            // Must match run/decision snapshot — mint defaults to 'policy' otherwise.
            policySnapshotId: 'action-gateway-mvp-v1',
          },
        },
      ],
    },
    'action-gateway',
  );
  return {
    tenantId,
    stepId,
    interactionId,
    envelope,
    actionDigest,
    simulationId,
  };
}

describe('Action Gateway → Kernel → EffectBroker → demo adapter (in-memory)', () => {
  it('executes allow and approved actions while denied actions never reach the adapter', async () => {
    const kernel = new InMemoryKernelRepository();
    const registeredAt = new Date(Date.now() - 1_000);
    const heartbeat = new Date();
    kernel.seedTestWorker('ops-reconcile', ['tenant-action-e2e'], 1, {
      capabilities: ['effect.reconcile'],
      identitySubject: 'db:commander_adapter_ops',
      registeredAt,
      lastHeartbeatAt: heartbeat,
    });
    kernel.seedTestWorker('ops-compensate', ['tenant-action-e2e'], 1, {
      capabilities: ['effect.compensate'],
      identitySubject: 'db:commander_adapter_ops',
      registeredAt,
      lastHeartbeatAt: heartbeat,
    });
    await kernel.setAllowlistEntry('tenant-action-e2e', 'demo.ticket.create', true);
    await kernel.setAllowlistEntry('tenant-action-e2e', 'compensate.demo.ticket.create', true);
    const issuer = CapabilityTokenIssuer.generate({
      issuer: 'commander-worker',
      audience: 'commander.effect-broker',
      keyId: 'action-e2e',
    });
    const verifier = new CapabilityTokenVerifier({
      issuer: 'commander-worker',
      audience: 'commander.effect-broker',
      publicKeys: { 'action-e2e': issuer.publicKey },
    });
    const tickets = new InMemoryTicketAdapter();
    const { privateKey } = generateKeyPairSync('ed25519');
    const evidenceSigner = createEvidenceSigner({
      privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      keyId: 'action-e2e-evidence',
    });
    const bootstrap = await import('../bootstrap.js');
    const createWorkerEffectExecutor = bootstrap.createWorkerEffectExecutor;
    assert.equal(typeof createWorkerEffectExecutor, 'function');
    const auditEvents: Array<{ type: string; details: Record<string, unknown> }> = [];
    const broker = new EffectBroker(
      verifier,
      createWorkerPolicyEvaluator(kernel),
      kernel,
      // 签名是 (tickets = adapter)，不能传 { tickets } 对象字面量
      createWorkerEffectExecutor(tickets),
      {
        append: async (event) => {
          auditEvents.push({ type: event.type, details: event.details });
        },
      },
      {
        requireRequestBinding: true,
        localWorkerId: 'worker-action-e2e',
        evidenceSigner,
        requireEvidencePersistence: true,
      },
    );
    const worker = new WorkerService(
      {
        id: 'worker-action-e2e',
        kind: 'tool',
        version: 'e2e',
        capabilities: ['tool'],
        maxConcurrency: 1,
      },
      {
        subject: 'worker:action-e2e',
        token: 'worker-action-token',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      new ApiKeyWorkerAuthenticator({
        validTokens: new Set(['worker-action-token']),
        defaultTenantIds: ['tenant-action-e2e'],
        defaultCapabilities: ['tool'],
      }),
      new InMemoryWorkerRegistry(),
      // KernelStep types `lease` as optional; a claimed step always carries one.
      kernel as unknown as KernelWorkerPort,
      new ToolStepExecutor(undefined, broker, issuer),
      {
        leaseTtlMs: 30_000,
        workerHeartbeatMs: 10_000,
        pollIntervalMs: 5,
        onRegistered: (record) => broker.bindLocalWorkerGeneration(record.generation),
      },
    );

    const allowed = await createInMemoryActionRun(kernel, {
      runId: 'run-action-allow',
      effect: 'allow',
      destination: 'demo://tickets',
    });
    const denied = await createInMemoryActionRun(kernel, {
      runId: 'run-action-deny',
      effect: 'deny',
      destination: 'https://untrusted.example/tickets',
    });
    const approval = await createInMemoryActionRun(kernel, {
      runId: 'run-action-approval',
      effect: 'require_approval',
      destination: 'demo://tickets/approval',
    });

    await worker.start();
    try {
      assert.equal(await worker.pollOnce(), true);
      await worker.waitForIdle();
      const allowedRun = await kernel.getRun('run-action-allow', allowed.tenantId);
      const allowedStep = await kernel.getStep(allowed.stepId, allowed.tenantId);
      assert.equal(
        allowedRun?.state,
        'SUCCEEDED',
        JSON.stringify({ run: allowedRun, step: allowedStep }),
      );
      assert.equal(tickets.createInvocations, 1);

      assert.equal(await worker.pollOnce(), true);
      await worker.waitForIdle();
      assert.equal((await kernel.getRun('run-action-deny', denied.tenantId))?.state, 'FAILED');
      assert.equal(tickets.createInvocations, 1);

      assert.equal(await worker.pollOnce(), false, 'approval step is not claimable before answer');
      await kernel.answerInteraction({
        interactionId: approval.interactionId,
        runId: 'run-action-approval',
        tenantId: approval.tenantId,
        response: {
          approved: true,
          actionDigest: approval.actionDigest,
          simulationId: approval.simulationId,
          policySnapshotId: 'action-gateway-mvp-v1',
          reviewer: 'reviewer-a',
          runId: 'run-action-approval',
          tenantId: approval.tenantId,
        },
        actor: 'reviewer-a',
      });
      assert.equal(await worker.pollOnce(), true);
      await worker.waitForIdle();
      assert.equal(
        (await kernel.getRun('run-action-approval', approval.tenantId))?.state,
        'SUCCEEDED',
      );
      assert.equal(tickets.createInvocations, 2);
      assert.equal(
        (await kernel.listEffectsForRun('run-action-approval', approval.tenantId)).length,
        1,
      );

      const mutated = await createInMemoryActionRun(kernel, {
        runId: 'run-action-mutated-after-approval',
        effect: 'require_approval',
        destination: 'demo://tickets/approval',
        args: { title: 'Approved title' },
        executionArgs: { title: 'Mutated title' },
      });
      await kernel.answerInteraction({
        interactionId: mutated.interactionId,
        runId: 'run-action-mutated-after-approval',
        tenantId: mutated.tenantId,
        response: {
          approved: true,
          actionDigest: mutated.actionDigest,
          simulationId: mutated.simulationId,
          policySnapshotId: 'action-gateway-mvp-v1',
          reviewer: 'reviewer-a',
          runId: 'run-action-mutated-after-approval',
          tenantId: mutated.tenantId,
        },
        actor: 'reviewer-a',
      });
      assert.equal(await worker.pollOnce(), true);
      await worker.waitForIdle();
      assert.equal(
        (await kernel.getRun('run-action-mutated-after-approval', mutated.tenantId))?.state,
        'FAILED',
      );
      assert.equal(tickets.createInvocations, 2, 'mutated action never invokes adapter');
      assert.equal(
        (await kernel.listEffectsForRun('run-action-mutated-after-approval', mutated.tenantId))
          .length,
        0,
        'mutated action is rejected before broker admission',
      );

      const compensation = await createInMemoryActionRun(kernel, {
        runId: 'run-action-compensate',
        effect: 'allow',
        destination: 'demo://tickets',
        effectType: 'compensate.demo.ticket.create',
        tool: 'ticket.compensate',
        args: { targetIdempotencyKey: allowed.envelope.idempotencyKey },
      });
      assert.equal(await worker.pollOnce(), true);
      await worker.waitForIdle();
      const compensationStep = await kernel.getStep(compensation.stepId, compensation.tenantId);
      assert.equal(
        (await kernel.getRun('run-action-compensate', compensation.tenantId))?.state,
        'FAILED',
        JSON.stringify(compensationStep?.error),
      );
      assert.equal(
        tickets.compensateInvocations,
        0,
        'Task 1 must fail closed before adapter compensation',
      );
      const remote = await tickets.queryOutcome({
        effectId: 'run-action-allow-effect',
        idempotencyKey: allowed.envelope.idempotencyKey,
        type: 'demo.ticket.create',
        request: {},
        tenantId: allowed.tenantId,
      });
      assert.equal(remote.status, 'APPLIED');
      assert.equal(remote.response?.status, 'open');
      const compensationEffects = await kernel.listEffectsForRun(
        'run-action-compensate',
        compensation.tenantId,
      );
      assert.equal(compensationEffects.length, 0, 'Task 3 admission RPC is not available yet');
      assert.equal(
        auditEvents.some(
          (event) =>
            event.type === 'effect.completed' && event.details.runId === 'run-action-compensate',
        ),
        false,
      );
    } finally {
      await worker.stop();
    }
  });
});

describe(
  'Gateway → Kernel → Worker PostgreSQL E2E (opt-in)',
  { skip: !databaseUrl && !requirePg },
  () => {
    it('executes a default V1 agent run end-to-end in PostgreSQL', async () => {
      if (!databaseUrl) {
        throw new Error('PostgreSQL E2E requires COMMANDER_KERNEL_DATABASE_URL or DATABASE_URL');
      }
      const tenantId = `e2e-tenant-${Date.now()}`;
      const workerId = `e2e-worker-${Date.now()}`;
      let pool: Pool | undefined;
      let appPool: Pool | undefined;
      let authorityPool: Pool | undefined;
      let workerPool: Pool | undefined;
      let worker: WorkerService | undefined;
      let migrationsComplete = false;
      try {
        pool = new Pool({ connectionString: databaseUrl, max: 8 });
        appPool = new Pool({
          connectionString: deriveRoleDatabaseUrl(databaseUrl, 'commander_app', appPassword),
          max: 4,
        });
        authorityPool = new Pool({
          connectionString: deriveRoleDatabaseUrl(
            databaseUrl,
            'commander_tenant_authority',
            process.env.COMMANDER_TENANT_AUTHORITY_PASSWORD ?? 'commander_tenant_authority',
          ),
          max: 2,
        });

        await runKernelMigrations(pool);
        migrationsComplete = true;
        const escapedWorkerPassword = workerPassword.replace(/'/g, "''");
        await pool.query(
          `ALTER ROLE commander_worker WITH LOGIN PASSWORD '${escapedWorkerPassword}'`,
        );
        await pool.query(
          `INSERT INTO commander_tenant_authority_allowed_tenants (tenant_id)
           VALUES ($1)
           ON CONFLICT (tenant_id) DO UPDATE SET enabled = true`,
          [tenantId],
        );
        await seedWorkerAllowedTenants(pool, [tenantId]);
        workerPool = new Pool({
          connectionString: deriveWorkerDatabaseUrl(databaseUrl),
          max: 4,
        });

        const appKernel = new PostgresKernelRepository(appPool, {
          tenantContextPhase: 'enforce',
          tenantContextAuthority: new PostgresTenantContextAuthority(authorityPool),
        });
        const workerKernel = new PostgresKernelRepository(workerPool);
        await appKernel.initialize();
        await workerKernel.initialize();

        const registry = new PostgresWorkerRegistry(workerPool);
        await registry.initialize();

        const authenticator = new ApiKeyWorkerAuthenticator({
          validTokens: new Set(['worker-token']),
          defaultTenantIds: [tenantId],
          defaultCapabilities: ['agent'],
        });

        worker = new WorkerService(
          {
            id: workerId,
            kind: 'agent',
            version: 'e2e',
            capabilities: ['agent'],
            maxConcurrency: 2,
          },
          {
            subject: `worker:${workerId}`,
            token: 'worker-token',
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          },
          authenticator,
          registry,
          // KernelStep types `lease` as optional; a claimed step always carries one.
          workerKernel as unknown as KernelWorkerPort,
          deterministicExecutor,
          { leaseTtlMs: 5000, workerHeartbeatMs: 1000, pollIntervalMs: 50 },
        );

        await worker.start();

        const step: NewKernelStep = {
          id: `step-${tenantId}`,
          kind: 'agent',
          input: agentInput('say hello'),
          maxAttempts: 1,
        };

        const run = await appKernel.createRun(
          {
            id: `run-${tenantId}`,
            tenantId,
            intentHash: 'intent-e2e',
            workGraphHash: 'hash-e2e',
            workGraphVersion: 'v1',
            policySnapshotId: 'policy-e2e',
            steps: [step],
          },
          'e2e-test',
        );

        for (let i = 0; i < 200; i++) {
          const claimed = await worker.pollOnce();
          if (!claimed) {
            const current = await appKernel.getRun(run.id, tenantId);
            if (current?.state === 'SUCCEEDED' || current?.state === 'FAILED') break;
          }
          await new Promise((r) => setTimeout(r, 50));
        }

        await worker.waitForIdle();

        const finalRun = await appKernel.getRun(run.id, tenantId);
        const finalStep = await appKernel.getStep(step.id, tenantId);
        const events = await appKernel.listEvents(run.id, tenantId);
        assert.equal(
          finalRun?.state,
          'SUCCEEDED',
          `run ended in state ${finalRun?.state}; step=${JSON.stringify(finalStep?.error ?? finalStep?.state)}`,
        );

        assert.ok(
          events.some((e) => e.type === 'run.succeeded'),
          'run.succeeded event present',
        );

        const outbox = await pool.query(
          "SELECT * FROM commander_outbox WHERE tenant_id=$1 AND payload->>'runId'=$2",
          [tenantId, run.id],
        );
        assert.ok((outbox.rowCount ?? 0) > 0, 'outbox publication exists');
      } finally {
        try {
          await worker?.stop();
        } finally {
          try {
            if (pool && migrationsComplete) {
              await pool.query('DELETE FROM commander_steps WHERE tenant_id=$1', [tenantId]);
              await pool.query('DELETE FROM commander_runs WHERE tenant_id=$1', [tenantId]);
              await pool.query('DELETE FROM commander_events WHERE tenant_id=$1', [tenantId]);
              await pool.query('DELETE FROM commander_outbox WHERE tenant_id=$1', [tenantId]);
              await pool.query('DELETE FROM commander_worker_claim_secrets WHERE worker_id=$1', [
                workerId,
              ]);
              await pool.query('DELETE FROM commander_workers WHERE id=$1', [workerId]);
              await pool.query('DELETE FROM commander_worker_allowed_tenants WHERE tenant_id=$1', [
                tenantId,
              ]);
            }
          } finally {
            await Promise.all([
              workerPool?.end(),
              authorityPool?.end(),
              appPool?.end(),
              pool?.end(),
            ]);
          }
        }
      }
    });

    it('reclaims an expired lease so a second worker completes without dual success', async () => {
      if (!databaseUrl) return;
      const tenantId = `e2e-reclaim-${Date.now()}`;
      const workerA = `e2e-wA-${Date.now()}`;
      const workerB = `e2e-wB-${Date.now()}`;
      let pool: Pool | undefined;
      let migrationsComplete = false;
      try {
        pool = new Pool({ connectionString: databaseUrl, max: 8 });
        await runKernelMigrations(pool);
        migrationsComplete = true;
        // Recovery/reclaim is a scheduler-plane write (cross-tenant). Worker claims use
        // the same repo with an explicit tenantIds scope on claimNextStep.
        const kernel = new PostgresKernelRepository(pool, { schedulerMode: true });
        await kernel.initialize();

        await pool.query(
          `INSERT INTO commander_workers (id,kind,version,capabilities,max_concurrency,status,generation,identity_subject,tenant_ids)
         VALUES ($1,'agent','e2e','["agent"]',2,'ACTIVE',1,$2,$3::jsonb),
                ($4,'agent','e2e','["agent"]',2,'ACTIVE',1,$5,$6::jsonb)`,
          [
            workerA,
            workerA,
            JSON.stringify([tenantId]),
            workerB,
            workerB,
            JSON.stringify([tenantId]),
          ],
        );

        const runId = `run-${tenantId}`;
        const stepId = `step-${tenantId}`;
        await kernel.createRun(
          {
            id: runId,
            tenantId,
            intentHash: 'intent-reclaim',
            workGraphHash: 'hash-reclaim',
            workGraphVersion: 'v1',
            policySnapshotId: 'policy-e2e',
            steps: [
              {
                id: stepId,
                kind: 'agent',
                input: agentInput('reclaim path'),
                maxAttempts: 3,
              },
            ],
          },
          'e2e-reclaim',
        );

        const claimed = await kernel.claimNextStep({
          workerId: workerA,
          workerGeneration: 1,
          tenantIds: [tenantId],
          capabilities: ['agent'],
          leaseTtlMs: 80,
        });
        assert.ok(claimed, 'worker A claims first');
        const staleLease = claimed!.lease!;
        const staleVersion = claimed!.version;

        await new Promise((r) => setTimeout(r, 120));
        const reclaimed = await kernel.reclaimExpiredLeases(new Date(), 10);
        assert.ok(
          reclaimed.some((s) => s.id === stepId),
          'expired lease reclaimed',
        );

        const second = await kernel.claimNextStep({
          workerId: workerB,
          workerGeneration: 1,
          tenantIds: [tenantId],
          capabilities: ['agent'],
          leaseTtlMs: 30_000,
        });
        assert.ok(second, 'worker B claims after reclaim');
        assert.notEqual(second!.lease!.token, staleLease.token, 'new lease token');
        assert.notEqual(
          second!.lease!.fencingEpoch,
          staleLease.fencingEpoch,
          'fencing epoch advanced',
        );

        const zombie = await kernel.completeStep({
          stepId,
          tenantId,
          lease: staleLease,
          expectedVersion: staleVersion,
          output: { status: 'zombie' },
          actor: workerA,
        });
        assert.equal(zombie, null, 'zombie worker A cannot complete after reclaim');

        const done = await kernel.completeStep({
          stepId,
          tenantId,
          lease: second!.lease!,
          expectedVersion: second!.version,
          output: { status: 'ok' },
          actor: workerB,
        });
        assert.ok(done);
        assert.equal(done!.state, 'SUCCEEDED');

        const finalRun = await kernel.getRun(runId, tenantId);
        assert.equal(finalRun?.state, 'SUCCEEDED');
      } finally {
        try {
          if (pool && migrationsComplete) {
            await pool.query('DELETE FROM commander_steps WHERE tenant_id=$1', [tenantId]);
            await pool.query('DELETE FROM commander_runs WHERE tenant_id=$1', [tenantId]);
            await pool.query('DELETE FROM commander_events WHERE tenant_id=$1', [tenantId]);
            await pool.query('DELETE FROM commander_outbox WHERE tenant_id=$1', [tenantId]);
            await pool.query('DELETE FROM commander_workers WHERE id = ANY($1::text[])', [
              [workerA, workerB],
            ]);
          }
        } finally {
          await pool?.end();
        }
      }
    });
  },
);
