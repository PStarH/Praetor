import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  getCapabilityTokenIssuer,
  getGlobalLogger,
  getGlobalMetrics,
  resetControlPlane,
} from '@praetor/core';

function localToolToken(toolName: string): string {
  return getCapabilityTokenIssuer().issue({
    sub: 'worker-1',
    aud: 'tenant-a',
    tools: [toolName],
    ttlSeconds: 300,
  });
}
import { InMemoryWorkerRegistry } from './registry.js';
import { WorkerService } from './workerService.js';
import { WorkerExecutionError } from './types.js';
import type {
  ClaimedStep,
  KernelWorkerPort,
  StepExecutor,
  WorkerIdentity,
  WorkerLease,
} from './types.js';
import { getStepWorkloadBinding } from './stepWorkloadIdentity.js';
import { ToolStepExecutor } from './toolStepExecutor.js';

const identity = {
  subject: 'spiffe://commander/worker/agent-1',
  token: 'test-token',
  expiresAt: '2099-01-01T00:00:00.000Z',
};
const definition = {
  id: 'agent-1',
  kind: 'agent' as const,
  version: 'v1',
  capabilities: ['agent'],
  maxConcurrency: 2,
};
const auth = { authenticate: async () => ({ tenantIds: ['tenant-a'], capabilities: ['agent'] }) };

class FakeKernel implements KernelWorkerPort {
  lastClaimGeneration: number | undefined;
  lastFailureCode: string | undefined;
  lastFailureRetryable: boolean | undefined;
  lastFailureRetryAt: Date | undefined;
  failureCount = 0;
  heartbeatCount = 0;
  claimDelayMs = 0;
  lastHeartbeatActiveSteps: number | undefined;
  private readonly steps: Array<
    ClaimedStep & {
      state: 'PENDING' | 'RUNNING' | 'RETRY_WAIT' | 'SUCCEEDED' | 'FAILED';
      maxAttempts: number;
    }
  > = [];
  private readonly runs = new Map<string, { tenantId: string; state: 'PENDING' | 'SUCCEEDED' }>();
  private readonly limits = new Map<string, number>();
  addRun(
    id: string,
    tenantId: string,
    definitions: Array<{
      id: string;
      kind: string;
      input?: Record<string, unknown>;
      maxAttempts?: number;
    }>,
  ): void {
    this.runs.set(id, { tenantId, state: 'PENDING' });
    for (const definition of definitions)
      this.steps.push({
        ...definition,
        runId: id,
        tenantId,
        version: 1,
        attempt: 0,
        input: definition.input ?? {},
        state: 'PENDING',
        // Default matches production (maxAttempts ?? 1). Callers that need retries set explicitly.
        maxAttempts: definition.maxAttempts ?? 1,
        lease: { workerId: '', token: '', fencingEpoch: 0, expiresAt: '' },
      });
  }
  setLimit(tenantId: string, value: number): void {
    this.limits.set(tenantId, value);
  }
  lastClaimTenantIds: string[] | undefined;
  async claimNextStep(request: {
    workerId: string;
    workerGeneration?: number;
    leaseTtlMs: number;
    tenantIds?: string[];
    capabilities: string[];
  }): Promise<ClaimedStep | null> {
    this.lastClaimGeneration = request.workerGeneration;
    this.lastClaimTenantIds = request.tenantIds;
    if (this.claimDelayMs > 0)
      await new Promise((resolve) => setTimeout(resolve, this.claimDelayMs));
    // Caller tenantIds are ignored (durable authz). Tests still filter by auth registry
    // via worker capabilities only — mirrors claim_next_step without request scope.
    const step = this.steps.find(
      (candidate) =>
        ['PENDING', 'RETRY_WAIT'].includes(candidate.state) &&
        request.capabilities.includes(candidate.kind) &&
        this.steps.filter(
          (other) => other.tenantId === candidate.tenantId && other.state === 'RUNNING',
        ).length < (this.limits.get(candidate.tenantId) ?? Number.MAX_SAFE_INTEGER),
    );
    if (!step) return null;
    step.state = 'RUNNING';
    step.version++;
    step.attempt++;
    step.lease = {
      workerId: request.workerId,
      workerGeneration: request.workerGeneration ?? 0,
      token: 'lease-' + step.id,
      fencingEpoch: step.lease.fencingEpoch + 1,
      expiresAt: new Date(Date.now() + request.leaseTtlMs).toISOString(),
    };
    return structuredClone(step);
  }
  async heartbeatStep(
    _stepId: string,
    _tenantId: string,
    _lease: WorkerLease,
    _leaseTtlMs: number,
  ): Promise<unknown | null> {
    this.heartbeatCount++;
    return {};
  }
  async completeStep(request: {
    stepId: string;
    tenantId: string;
    lease: WorkerLease;
    expectedVersion: number;
  }): Promise<unknown | null> {
    const step = this.steps.find((candidate) => candidate.id === request.stepId);
    if (
      !step ||
      step.state !== 'RUNNING' ||
      step.version !== request.expectedVersion ||
      step.lease.token !== request.lease.token
    )
      return null;
    step.state = 'SUCCEEDED';
    const all = this.steps.filter((candidate) => candidate.runId === step.runId);
    if (all.every((candidate) => candidate.state === 'SUCCEEDED'))
      this.runs.get(step.runId)!.state = 'SUCCEEDED';
    return {};
  }
  async failStep(request: {
    stepId: string;
    tenantId: string;
    lease: WorkerLease;
    expectedVersion: number;
    error: { retryable: boolean; code?: string };
    retryAt?: Date;
    refundAttempt?: boolean;
  }): Promise<unknown | null> {
    this.failureCount++;
    const step = this.steps.find((candidate) => candidate.id === request.stepId);
    if (
      !step ||
      step.state !== 'RUNNING' ||
      step.version !== request.expectedVersion ||
      step.lease.token !== request.lease.token
    )
      return null;
    this.lastFailureCode = request.error.code;
    this.lastFailureRetryable = request.error.retryable;
    this.lastFailureRetryAt = request.retryAt;
    // Match production kernel: refundAttempt first, then retryable && retryAt && attempt < maxAttempts.
    if (request.refundAttempt && step.attempt > 0) step.attempt -= 1;
    const retry =
      Boolean(request.error.retryable) &&
      Boolean(request.retryAt) &&
      step.attempt < step.maxAttempts;
    step.state = retry ? 'RETRY_WAIT' : 'FAILED';
    return {};
  }
  getRun(id: string): { state: string } | undefined {
    return this.runs.get(id);
  }
  getStep(id: string): { state: string; attempt?: number } | undefined {
    const step = this.steps.find((candidate) => candidate.id === id);
    return step ? { state: step.state, attempt: step.attempt } : undefined;
  }
}

describe('worker plane', () => {
  for (const [label, expiresAt] of [
    ['malformed', 'not-a-date'],
    ['empty', ''],
    ['whitespace', '   '],
    ['missing', undefined],
    ['null', null],
    ['out-of-range', '+999999-01-01T00:00:00.000Z'],
    ['expired', '2029-12-31T23:59:59.999Z'],
    ['at current time', '2030-01-01T00:00:00.000Z'],
  ] as const) {
    it(`WP01 rejects ${label} expiry before authentication or registration`, async (t) => {
      t.mock.method(Date, 'now', () => Date.parse('2030-01-01T00:00:00.000Z'));
      const registry = new InMemoryWorkerRegistry();
      const initialize = t.mock.method(registry, 'initialize');
      const register = t.mock.method(registry, 'register');
      const authenticate = t.mock.fn(auth.authenticate);
      const onRegistered = t.mock.fn();
      const service = new WorkerService(
        definition,
        { ...identity, expiresAt } as WorkerIdentity,
        { authenticate },
        registry,
        new FakeKernel(),
        { execute: async () => ({}) },
        { onRegistered },
      );
      t.after(() => service.stop());

      await assert.rejects(service.start(), /Worker identity is expired/);
      assert.equal(authenticate.mock.callCount(), 0);
      assert.equal(initialize.mock.callCount(), 0);
      assert.equal(register.mock.callCount(), 0);
      assert.equal(onRegistered.mock.callCount(), 0);
      assert.equal(await registry.get(definition.id), null);
      assert.equal(service.record, null);
      assert.equal(await service.pollOnce(), false);
    });
  }

  it('WP01 registers an identity expiring one millisecond in the future', async (t) => {
    t.mock.method(Date, 'now', () => Date.parse('2030-01-01T00:00:00.000Z'));
    const registry = new InMemoryWorkerRegistry();
    const register = t.mock.method(registry, 'register');
    const service = new WorkerService(
      definition,
      { ...identity, expiresAt: '2030-01-01T00:00:00.001Z' },
      auth,
      registry,
      new FakeKernel(),
      { execute: async () => ({}) },
    );
    t.after(() => service.stop());
    assert.equal((await service.start()).id, definition.id);
    assert.equal(register.mock.callCount(), 1);
  });

  it('wraps each claimed step with step-scoped workload identity ALS', async () => {
    const kernel = new FakeKernel();
    kernel.addRun('run-wrapped', 'tenant-a', [{ id: 'wrapped-step', kind: 'agent' }]);
    let seenBinding: ReturnType<typeof getStepWorkloadBinding>;
    const service = new WorkerService(
      definition,
      identity,
      auth,
      new InMemoryWorkerRegistry(),
      kernel,
      {
        execute: async (step, context) => {
          seenBinding = getStepWorkloadBinding();
          assert.ok(seenBinding);
          assert.equal(seenBinding.tenantId, step.tenantId);
          assert.equal(seenBinding.runId, step.runId);
          assert.equal(seenBinding.stepId, step.id);
          assert.equal(seenBinding.workerId, context.worker.id);
          assert.equal(seenBinding.workerGeneration, context.worker.generation);
          assert.equal(seenBinding.workloadId, `${context.worker.id}:${context.worker.generation}`);
          return { ok: true };
        },
      },
      { leaseTtlMs: 1_000, workerHeartbeatMs: 1_000 },
    );
    await service.start();
    assert.equal(await service.pollOnce(), true);
    assert.equal(kernel.lastClaimTenantIds, undefined);
    await service.waitForIdle();
    assert.ok(seenBinding);
    assert.equal(getStepWorkloadBinding(), undefined);
    await service.stop();
  });

  it('authenticates, registers, claims only capability-authorized work, and completes through the kernel', async (t) => {
    const kernel = new FakeKernel();
    kernel.addRun('run-a', 'tenant-a', [{ id: 'agent-step', kind: 'agent' }]);
    kernel.addRun('run-b', 'tenant-b', [{ id: 'tool-step', kind: 'tool' }]);
    const registry = new InMemoryWorkerRegistry();
    const register = t.mock.method(registry, 'register');
    const service = new WorkerService(
      definition,
      identity,
      auth,
      registry,
      kernel,
      { execute: async () => ({ completed: true }) },
      { leaseTtlMs: 1_000, workerHeartbeatMs: 1_000 },
    );
    await service.start();
    // Tenant scoping is DB-owned: the worker registers its authenticated tenant
    // ceiling and the claim RPC authorizes against `commander_workers`, so the
    // poll must NOT forward caller-supplied tenantIds (they could only widen it).
    assert.deepEqual(
      register.mock.calls[0]?.arguments[2],
      ['tenant-a'],
      'the authenticated tenant ceiling must be registered',
    );
    assert.equal(await service.pollOnce(), true);
    assert.equal(kernel.lastClaimGeneration, 1);
    assert.equal(
      kernel.lastClaimTenantIds,
      undefined,
      'claim tenant scope is DB-owned, never caller-supplied',
    );
    await service.waitForIdle();
    assert.equal(kernel.getRun('run-a')?.state, 'SUCCEEDED');
    assert.equal(kernel.getRun('run-b')?.state, 'PENDING');
    assert.equal((await registry.get('agent-1'))?.identitySubject, identity.subject);
    await service.stop();
  });

  it('enforces the shared tenant concurrency limit before local worker capacity', async () => {
    const kernel = new FakeKernel();
    kernel.setLimit('tenant-a', 1);
    kernel.addRun('run-a', 'tenant-a', [
      { id: 'a-1', kind: 'agent' },
      { id: 'a-2', kind: 'agent' },
    ]);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = new WorkerService(
      definition,
      identity,
      auth,
      new InMemoryWorkerRegistry(),
      kernel,
      {
        execute: async () => {
          await blocked;
          return {};
        },
      },
      { leaseTtlMs: 1_000, workerHeartbeatMs: 1_000 },
    );
    await service.start();
    assert.equal(await service.pollOnce(), true);
    assert.equal(await service.pollOnce(), false);
    release();
    await service.waitForIdle();
    assert.equal(await service.pollOnce(), true);
    await service.waitForIdle();
    await service.stop();
  });

  it('rejects unapproved capability declarations and preserves executor retry intent', async () => {
    const kernel = new FakeKernel();
    kernel.addRun('run-a', 'tenant-a', [{ id: 'agent-step', kind: 'agent', maxAttempts: 2 }]);
    const denied = new WorkerService(
      { ...definition, capabilities: ['agent', 'tool'] },
      identity,
      auth,
      new InMemoryWorkerRegistry(),
      kernel,
      { execute: async () => ({}) },
    );
    await assert.rejects(denied.start(), /not authorized/);

    const service = new WorkerService(
      definition,
      identity,
      auth,
      new InMemoryWorkerRegistry(),
      kernel,
      {
        execute: async () => {
          throw new WorkerExecutionError('provider timeout', {
            code: 'PROVIDER_TIMEOUT',
            retryable: true,
            retryDelayMs: 1,
          });
        },
      },
      { leaseTtlMs: 1_000, workerHeartbeatMs: 1_000 },
    );
    await service.start();
    await service.pollOnce();
    await service.waitForIdle();
    assert.equal(kernel.getStep('agent-step')?.state, 'RETRY_WAIT');
    await service.stop();
  });

  for (const code of [
    'COMPLETION_UNKNOWN',
    'COMPLETION_UNCONFIRMED',
    'EVIDENCE_PERSIST_FAILED',
  ] as const) {
    it(`does not fail a step after EffectBroker transfers ownership with ${code}`, async () => {
      const kernel = new FakeKernel();
      kernel.addRun(`run-${code}`, 'tenant-a', [{ id: `step-${code}`, kind: 'agent' }]);
      const service = new WorkerService(
        definition,
        identity,
        auth,
        new InMemoryWorkerRegistry(),
        kernel,
        {
          execute: async () => {
            throw new WorkerExecutionError('effect ownership transferred to reconciliation', {
              code,
              retryable: true,
            });
          },
        },
        { leaseTtlMs: 1_000, workerHeartbeatMs: 1_000 },
      );

      await service.start();
      assert.equal(await service.pollOnce(), true);
      await service.waitForIdle();
      assert.equal(kernel.failureCount, 0);
      await service.stop();
    });
  }

  it('refuses to initialize the registry when sandbox readiness fails', async () => {
    const kernel = new FakeKernel();
    const registry = new InMemoryWorkerRegistry();
    let initialized = false;
    const initialize = registry.initialize.bind(registry);
    registry.initialize = async () => {
      initialized = true;
      await initialize();
    };
    const service = new WorkerService(
      definition,
      identity,
      auth,
      registry,
      kernel,
      { execute: async () => ({}) },
      {
        sandboxReadiness: {
          assertReady: async () => {
            throw new Error('SANDBOX_UNAVAILABLE: docker runtime is unavailable');
          },
        },
      },
    );

    await assert.rejects(service.start(), /SANDBOX_UNAVAILABLE/);
    assert.equal(initialized, false);
    assert.equal(service.record, null);
  });

  it('fails a claimed step with SANDBOX_UNAVAILABLE instead of completing it', async () => {
    const kernel = new FakeKernel();
    kernel.addRun('run-sandbox', 'tenant-a', [{ id: 'sandbox-step', kind: 'agent' }]);
    const service = new WorkerService(
      definition,
      identity,
      auth,
      new InMemoryWorkerRegistry(),
      kernel,
      {
        execute: async () => {
          const error = new Error('required Docker workload could not start');
          error.name = 'SandboxInitializationError';
          throw error;
        },
      },
      { leaseTtlMs: 1_000, workerHeartbeatMs: 1_000 },
    );

    await service.start();
    assert.equal(await service.pollOnce(), true);
    await service.waitForIdle();
    assert.equal(kernel.lastFailureCode, 'SANDBOX_UNAVAILABLE');
    assert.notEqual(kernel.getStep('sandbox-step')?.state, 'SUCCEEDED');
    await service.stop();
  });

  it('maps sandbox errors wrapped by executors into WorkerExecutionError to SANDBOX_UNAVAILABLE', async () => {
    const kernel = new FakeKernel();
    kernel.addRun('run-wrapped', 'tenant-a', [{ id: 'wrapped-step', kind: 'agent' }]);
    const sandboxCause = new Error('required Docker workload could not start');
    sandboxCause.name = 'SandboxInitializationError';
    const service = new WorkerService(
      definition,
      identity,
      auth,
      new InMemoryWorkerRegistry(),
      kernel,
      {
        execute: async () => {
          throw new WorkerExecutionError(
            'effect failed: sandbox probe error',
            { code: 'EFFECT_EXECUTION_FAILED', retryable: false },
            sandboxCause,
          );
        },
      },
      { leaseTtlMs: 1_000, workerHeartbeatMs: 1_000 },
    );

    await service.start();
    assert.equal(await service.pollOnce(), true);
    await service.waitForIdle();
    assert.equal(kernel.lastFailureCode, 'SANDBOX_UNAVAILABLE');
    assert.notEqual(kernel.getStep('wrapped-step')?.state, 'SUCCEEDED');
    await service.stop();
  });

  it('does not over-claim when concurrent pollOnce races maxConcurrency', async () => {
    const kernel = new FakeKernel();
    kernel.claimDelayMs = 40;
    kernel.addRun('run-race', 'tenant-a', [
      { id: 'r1', kind: 'agent' },
      { id: 'r2', kind: 'agent' },
      { id: 'r3', kind: 'agent' },
    ]);
    let executing = 0;
    let peak = 0;
    const service = new WorkerService(
      definition,
      identity,
      auth,
      new InMemoryWorkerRegistry(),
      kernel,
      {
        execute: async () => {
          executing++;
          peak = Math.max(peak, executing);
          await new Promise((resolve) => setTimeout(resolve, 60));
          executing--;
          return {};
        },
      },
      { leaseTtlMs: 1_000, workerHeartbeatMs: 1_000 },
    );
    await service.start();
    const results = await Promise.all([service.pollOnce(), service.pollOnce(), service.pollOnce()]);
    assert.equal(results.filter(Boolean).length, 2);
    await service.waitForIdle();
    assert.equal(peak, 2);
    assert.equal(kernel.getStep('r3')?.state, 'PENDING');
    await service.stop();
  });

  it('returns claimed step without executing when stop races claim', async () => {
    const kernel = new FakeKernel();
    kernel.claimDelayMs = 50;
    // Production default maxAttempts=1: without refundAttempt this would terminal-FAIL after claim++.
    kernel.addRun('run-stop', 'tenant-a', [{ id: 'stop-step', kind: 'agent', maxAttempts: 1 }]);
    let executed = false;
    const service = new WorkerService(
      definition,
      identity,
      auth,
      new InMemoryWorkerRegistry(),
      kernel,
      {
        execute: async () => {
          executed = true;
          return {};
        },
      },
      { leaseTtlMs: 1_000, workerHeartbeatMs: 1_000 },
    );
    await service.start();
    const poll = service.pollOnce();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await service.stop();
    assert.equal(await poll, false);
    assert.equal(executed, false);
    assert.equal(kernel.lastFailureCode, 'WORKER_STOPPED');
    assert.ok(kernel.lastFailureRetryAt instanceof Date, 'retryAt required for kernel requeue');
    assert.equal(kernel.getStep('stop-step')?.state, 'RETRY_WAIT');
    assert.equal(
      kernel.getStep('stop-step')?.attempt,
      0,
      'stop-during-claim must refund the claim attempt',
    );
  });

  it('aborts in-flight step controllers when stop() is called', async () => {
    const kernel = new FakeKernel();
    kernel.addRun('run-abort-stop', 'tenant-a', [{ id: 'abort-stop-step', kind: 'agent' }]);
    let sawAbort = false;
    const service = new WorkerService(
      definition,
      identity,
      auth,
      new InMemoryWorkerRegistry(),
      kernel,
      {
        execute: async (_step, context) => {
          await new Promise<void>((_resolve, reject) => {
            if (context.signal.aborted) {
              sawAbort = true;
              reject(new Error('already aborted'));
              return;
            }
            context.signal.addEventListener(
              'abort',
              () => {
                sawAbort = true;
                reject(new Error('Worker stopped'));
              },
              { once: true },
            );
          });
          return {};
        },
      },
      { leaseTtlMs: 1_000, workerHeartbeatMs: 60_000 },
    );
    await service.start();
    assert.equal(await service.pollOnce(), true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await service.stop();
    assert.equal(sawAbort, true, 'stop() must abort activeControllers so drain does not hang');
  });

  it('counts claimInflight in activeSteps and registry heartbeat', async () => {
    const kernel = new FakeKernel();
    kernel.claimDelayMs = 80;
    kernel.addRun('run-hb', 'tenant-a', [{ id: 'hb-step', kind: 'agent' }]);
    const registry = new InMemoryWorkerRegistry();
    const originalHeartbeat = registry.heartbeat.bind(registry);
    registry.heartbeat = async (workerId, generation, activeSteps, claimSecret) => {
      kernel.lastHeartbeatActiveSteps = activeSteps;
      return originalHeartbeat(workerId, generation, activeSteps, claimSecret);
    };
    const service = new WorkerService(
      definition,
      identity,
      auth,
      registry,
      kernel,
      {
        execute: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return {};
        },
      },
      { leaseTtlMs: 1_000, workerHeartbeatMs: 15 },
    );
    await service.start();
    const poll = service.pollOnce();
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(service.activeSteps, 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(kernel.lastHeartbeatActiveSteps, 1);
    await poll;
    await service.waitForIdle();
    await service.stop();
  });

  it('non-cooperative tool timeout leaves RUNNING and stops lease heartbeat', async () => {
    resetControlPlane();
    const kernel = new FakeKernel();
    kernel.addRun('run-hang', 'tenant-a', [
      {
        id: 'hang-tool',
        kind: 'tool',
        input: {
          toolName: 'hang',
          args: {},
          timeoutMs: 40,
          capabilityToken: localToolToken('hang'),
        },
      },
    ]);
    const toolDef = {
      ...definition,
      id: 'tool-worker',
      kind: 'tool' as const,
      capabilities: ['tool'],
    };
    const toolAuth = {
      authenticate: async () => ({ tenantIds: ['tenant-a'], capabilities: ['tool'] }),
    };
    const executor = new ToolStepExecutor({
      get: () => ({
        execute: async () => new Promise(() => {}),
      }),
    });
    const service = new WorkerService(
      toolDef,
      { ...identity, subject: 'spiffe://commander/worker/tool-worker' },
      toolAuth,
      new InMemoryWorkerRegistry(),
      kernel,
      executor,
      { leaseTtlMs: 600, workerHeartbeatMs: 60_000 },
    );
    await service.start();
    const boundMs = 800;
    const started = Date.now();
    assert.equal(await service.pollOnce(), true);
    await service.waitForIdle();
    assert.ok(Date.now() - started < boundMs, 'step must leave RUNNING within bound');
    assert.equal(kernel.getStep('hang-tool')?.state, 'FAILED');
    assert.equal(kernel.lastFailureCode, 'TIMEOUT');
    assert.equal(kernel.lastFailureRetryable, false);
    const heartbeatsAtIdle = kernel.heartbeatCount;
    await new Promise((resolve) => setTimeout(resolve, 450));
    assert.equal(
      kernel.heartbeatCount,
      heartbeatsAtIdle,
      'lease heartbeat must stop after timeout failStep',
    );
    await service.stop();
  });

  it('parent abort of non-cooperative tool leaves RUNNING via failStep', async () => {
    resetControlPlane();
    const kernel = new FakeKernel();
    kernel.addRun('run-abort-hang', 'tenant-a', [
      {
        id: 'abort-hang-tool',
        kind: 'tool',
        input: {
          toolName: 'hang',
          args: {},
          timeoutMs: 30_000,
          capabilityToken: localToolToken('hang'),
        },
      },
    ]);
    const toolDef = {
      ...definition,
      id: 'tool-abort-worker',
      kind: 'tool' as const,
      capabilities: ['tool'],
    };
    const toolAuth = {
      authenticate: async () => ({ tenantIds: ['tenant-a'], capabilities: ['tool'] }),
    };
    const registry = new InMemoryWorkerRegistry();
    const executor = new ToolStepExecutor({
      get: () => ({
        execute: async () => new Promise(() => {}),
      }),
    });
    const service = new WorkerService(
      toolDef,
      { ...identity, subject: 'spiffe://commander/worker/tool-abort-worker' },
      toolAuth,
      registry,
      kernel,
      executor,
      { leaseTtlMs: 600, workerHeartbeatMs: 40 },
    );
    await service.start();
    const boundMs = 800;
    const started = Date.now();
    assert.equal(await service.pollOnce(), true);
    // Bump generation so worker heartbeat aborts active step controllers (parent abort).
    await registry.register(
      toolDef,
      'spiffe://commander/worker/tool-abort-worker',
      ['tenant-a'],
      service.record?.claimSecret,
    );
    await service.waitForIdle();
    assert.ok(Date.now() - started < boundMs, 'parent-abort step must leave RUNNING within bound');
    assert.notEqual(kernel.getStep('abort-hang-tool')?.state, 'RUNNING');
    assert.equal(kernel.lastFailureCode, 'ABORTED');
    assert.equal(kernel.lastFailureRetryable, false);
    assert.equal(kernel.getStep('abort-hang-tool')?.state, 'FAILED');
    await service.stop();
  });

  it('stop aborts activeControllers so non-cooperative hang leaves RUNNING', async () => {
    resetControlPlane();
    const kernel = new FakeKernel();
    kernel.addRun('run-stop-hang', 'tenant-a', [
      {
        id: 'stop-hang-tool',
        kind: 'tool',
        input: {
          toolName: 'hang',
          args: {},
          timeoutMs: 30_000,
          capabilityToken: localToolToken('hang'),
        },
      },
    ]);
    const toolDef = {
      ...definition,
      id: 'tool-stop-worker',
      kind: 'tool' as const,
      capabilities: ['tool'],
    };
    const toolAuth = {
      authenticate: async () => ({ tenantIds: ['tenant-a'], capabilities: ['tool'] }),
    };
    const service = new WorkerService(
      toolDef,
      { ...identity, subject: 'spiffe://commander/worker/tool-stop-worker' },
      toolAuth,
      new InMemoryWorkerRegistry(),
      kernel,
      new ToolStepExecutor({
        get: () => ({
          execute: async () => new Promise(() => {}),
        }),
      }),
      { leaseTtlMs: 600, workerHeartbeatMs: 60_000 },
    );
    await service.start();
    assert.equal(await service.pollOnce(), true);
    const boundMs = 800;
    const started = Date.now();
    await service.stop();
    assert.ok(Date.now() - started < boundMs, 'stop must abort active hang within bound');
    assert.equal(kernel.lastFailureCode, 'ABORTED');
    assert.equal(kernel.lastFailureRetryable, false);
    assert.equal(kernel.getStep('stop-hang-tool')?.state, 'FAILED');
  });

  it('preserves retry intent from structural KernelStepExecutorError-like errors', async () => {
    const kernel = new FakeKernel();
    kernel.addRun('run-struct', 'tenant-a', [{ id: 'agent-step', kind: 'agent', maxAttempts: 2 }]);
    class StructuralExecutorError extends Error {
      readonly options: { code?: string; retryable?: boolean; retryDelayMs?: number };
      constructor(
        message: string,
        options: { code?: string; retryable?: boolean; retryDelayMs?: number },
      ) {
        super(message);
        this.name = 'KernelStepExecutorError';
        this.options = options;
      }
    }
    const service = new WorkerService(
      definition,
      identity,
      auth,
      new InMemoryWorkerRegistry(),
      kernel,
      {
        execute: async () => {
          throw new StructuralExecutorError('Step aborted during execution', {
            code: 'ABORTED',
            retryable: true,
            retryDelayMs: 1000,
          });
        },
      },
      { leaseTtlMs: 1_000, workerHeartbeatMs: 60_000 },
    );
    await service.start();
    await service.pollOnce();
    await service.waitForIdle();
    assert.equal(kernel.lastFailureCode, 'ABORTED');
    assert.equal(kernel.getStep('agent-step')?.state, 'RETRY_WAIT');
    await service.stop();
  });

  it('preserves claimSecret across heartbeat (InMemory strips secret like Postgres)', async () => {
    const kernel = new FakeKernel();
    const registry = new InMemoryWorkerRegistry();
    const service = new WorkerService(
      definition,
      identity,
      auth,
      registry,
      kernel,
      { execute: async () => ({ ok: true }) },
      { leaseTtlMs: 1_000, workerHeartbeatMs: 60_000 },
    );
    const registered = await service.start();
    assert.ok(registered.claimSecret, 'register must return claimSecret');
    const secret = registered.claimSecret;
    // Drive one heartbeat via registry semantics used by WorkerService.heartbeat
    const hb = await registry.heartbeat(
      registered.id,
      registered.generation,
      0,
      registered.claimSecret!,
    );
    assert.ok(hb);
    assert.equal(hb.claimSecret, undefined, 'heartbeat must not re-issue claimSecret');
    // Service-internal preserve path: pollOnce needs secret after heartbeat timer would have run
    await (service as unknown as { heartbeat: () => Promise<void> }).heartbeat();
    const worker = (service as unknown as { worker: { claimSecret?: string } }).worker;
    assert.equal(
      worker.claimSecret,
      secret,
      'WorkerService must preserve claimSecret after heartbeat',
    );
    await service.stop();
  });

  it('keeps the poll loop alive when claimNextStep throws', async () => {
    const kernel = new FakeKernel();
    let claims = 0;
    const original = kernel.claimNextStep.bind(kernel);
    kernel.claimNextStep = async (request) => {
      claims += 1;
      if (claims === 1) throw new Error('temporary database failure');
      return original(request);
    };
    kernel.addRun('run-resilient', 'tenant-a', [{ id: 'step-ok', kind: 'agent' }]);
    const logged: Array<{ level: string; message: string }> = [];
    const onLog = (entry: { component: string; level: string; message: string }) => {
      if (entry.component === 'WorkerService' && entry.message.includes('claim loop swallowed')) {
        logged.push({ level: entry.level, message: entry.message });
      }
    };
    getGlobalLogger().onLog(onLog);
    const before = getGlobalMetrics().getLatest('worker.claim_loop.errors');
    const service = new WorkerService(
      definition,
      identity,
      auth,
      new InMemoryWorkerRegistry(),
      kernel,
      { execute: async () => ({ ok: true }) },
      { leaseTtlMs: 1_000, workerHeartbeatMs: 60_000, pollIntervalMs: 10 },
    );
    const ac = new AbortController();
    const running = service.run(ac.signal);
    // Allow first throw + backoff + successful claim
    await new Promise((r) => setTimeout(r, 80));
    await service.waitForIdle();
    ac.abort();
    await running;
    getGlobalLogger().offLog(onLog);
    assert.equal(kernel.getRun('run-resilient')?.state, 'SUCCEEDED');
    assert.ok(logged.length >= 1, 'claim-loop swallow must emit error-level log');
    assert.equal(logged[0]?.level, 'error');
    const after = getGlobalMetrics().getLatest('worker.claim_loop.errors');
    assert.ok(after, 'claim-loop swallow must increment worker.claim_loop.errors');
    assert.ok(
      !before || after.timestamp >= before.timestamp,
      'metric point must be recorded for swallowed claim error',
    );
  });
});

/**
 * WP-04 shutdown bounding, WP-05 claim-loop liveness, WP-10 post-claim kernel
 * observability, and WP-11 owned-resource release.
 */
describe('worker plane recovery and observability', () => {
  /** Resolves when `signal` aborts (a cooperative handler). */
  function abortable(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
  }

  /** Captures WP-10 lease-path failure logs and their metric labels. */
  function leasePathFailures(): {
    entries: Array<{ message: string; failurePath?: unknown }>;
    off: () => void;
  } {
    const entries: Array<{ message: string; failurePath?: unknown }> = [];
    const onLog = (entry: {
      component: string;
      message: string;
      context?: Record<string, unknown>;
    }) => {
      if (entry.component === 'WorkerService' && entry.message.includes('lease path')) {
        entries.push({ message: entry.message, failurePath: entry.context?.failurePath });
      }
    };
    getGlobalLogger().onLog(onLog);
    return { entries, off: () => getGlobalLogger().offLog(onLog) };
  }

  it('bounds the stop() drain when a step handler ignores its abort signal (WP-04)', async () => {
    const kernel = new FakeKernel();
    kernel.addRun('run-drain', 'tenant-a', [{ id: 'drain-step', kind: 'agent' }]);
    let release!: () => void;
    const stuck = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = new WorkerService(
      definition,
      identity,
      auth,
      new InMemoryWorkerRegistry(),
      kernel,
      {
        execute: async () => {
          // Ignores context.signal entirely: shutdown must not wait for it.
          await stuck;
          return {};
        },
      },
      { leaseTtlMs: 1_000, workerHeartbeatMs: 60_000, drainTimeoutMs: 150 },
    );
    await service.start();
    assert.equal(await service.pollOnce(), true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    try {
      const outcome = await Promise.race([
        service.stop().then(() => 'drained' as const),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 2_000)),
      ]);
      assert.equal(outcome, 'drained', 'stop() must not wait for a non-cooperative handler');
    } finally {
      // Let the abandoned step finish so its lease-heartbeat interval is cleared.
      release();
      await service.waitForIdle();
    }
  });

  it('clears readiness when the claim path fails and refreshes it after recovery (WP-05)', async () => {
    const kernel = new FakeKernel();
    let claims = 0;
    const original = kernel.claimNextStep.bind(kernel);
    kernel.claimNextStep = async (request) => {
      claims += 1;
      if (claims === 1) throw new Error('claim authority unavailable');
      return original(request);
    };
    kernel.addRun('run-liveness', 'tenant-a', [{ id: 'liveness-step', kind: 'agent' }]);
    const health: boolean[] = [];
    const service = new WorkerService(
      definition,
      identity,
      auth,
      new InMemoryWorkerRegistry(),
      kernel,
      { execute: async () => ({ ok: true }) },
      {
        leaseTtlMs: 1_000,
        workerHeartbeatMs: 60_000,
        pollIntervalMs: 10,
        onClaimLoopHealth: (healthy) => health.push(healthy),
      },
    );
    const ac = new AbortController();
    const running = service.run(ac.signal);
    await new Promise((resolve) => setTimeout(resolve, 80));
    ac.abort();
    await running;
    assert.equal(health[0], false, 'a failed claim must clear readiness');
    assert.equal(health[health.length - 1], true, 'a recovered claim must refresh readiness');
  });

  const leasePathScenarios: Array<{
    label: string;
    runId: string;
    stepId: string;
    breakKernel: (kernel: FakeKernel) => void;
    execute: StepExecutor['execute'];
  }> = [
    {
      label: 'heartbeat_rejected',
      runId: 'run-hb-rejected',
      stepId: 'hb-rejected-step',
      breakKernel: (kernel) => {
        kernel.heartbeatStep = async () => {
          throw new Error('heartbeat rpc unavailable');
        };
      },
      execute: async (_step, context) => {
        await abortable(context.signal);
        return {};
      },
    },
    {
      label: 'heartbeat_null',
      runId: 'run-hb-null',
      stepId: 'hb-null-step',
      breakKernel: (kernel) => {
        kernel.heartbeatStep = async () => null;
      },
      execute: async (_step, context) => {
        await abortable(context.signal);
        return {};
      },
    },
    {
      label: 'complete_rejected',
      runId: 'run-complete-rejected',
      stepId: 'complete-rejected-step',
      breakKernel: (kernel) => {
        kernel.completeStep = async () => null;
      },
      execute: async () => ({ ok: true }),
    },
    {
      label: 'fail_rejected',
      runId: 'run-fail-rejected',
      stepId: 'fail-rejected-step',
      breakKernel: (kernel) => {
        kernel.failStep = async () => null;
      },
      execute: async () => {
        throw new WorkerExecutionError('executor failed', {
          code: 'EXECUTOR_FAILED',
          retryable: false,
        });
      },
    },
  ];

  for (const scenario of leasePathScenarios) {
    it(`reports a ${scenario.label} post-claim kernel failure instead of aborting silently (WP-10)`, async () => {
      const kernel = new FakeKernel();
      scenario.breakKernel(kernel);
      kernel.addRun(scenario.runId, 'tenant-a', [{ id: scenario.stepId, kind: 'agent' }]);
      const logs = leasePathFailures();
      const service = new WorkerService(
        definition,
        identity,
        auth,
        new InMemoryWorkerRegistry(),
        kernel,
        { execute: scenario.execute },
        { leaseTtlMs: 300, workerHeartbeatMs: 60_000 },
      );
      try {
        await service.start();
        assert.equal(await service.pollOnce(), true);
        await service.waitForIdle();
      } finally {
        logs.off();
        await service.stop();
      }
      assert.equal(
        logs.entries[0]?.failurePath,
        scenario.label,
        'lease-path failure must be logged with its path',
      );
      assert.equal(
        getGlobalMetrics().getLatest('worker.step.lease_path_failures')?.labels.failure_path,
        scenario.label,
        'lease-path failure must be visible as a metric',
      );
    });
  }

  it('releases owned resources from stop() even after a failed start (WP-11)', async () => {
    let disposed = 0;
    const service = new WorkerService(
      { ...definition, capabilities: ['agent', 'tool'] },
      identity,
      auth,
      new InMemoryWorkerRegistry(),
      new FakeKernel(),
      { execute: async () => ({}) },
      {
        onDispose: async () => {
          disposed += 1;
        },
      },
    );
    await assert.rejects(service.start(), /not authorized/);
    await service.stop();
    assert.equal(disposed, 1, 'stop() must release the verified pool owned by the service');
    await service.stop();
    assert.equal(disposed, 1, 'release must happen exactly once');
  });
});
