import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  evaluateManifestGatewayEffect,
  findAdapterManifest,
  githubPrBodyMarker,
  servicenowCorrelationId,
} from '@praetor/contracts';
import {
  AdapterExecutionError,
  buildEffectEvidenceBundle,
  verifyEvidenceBundle,
  CapabilityTokenIssuer,
  CapabilityTokenVerifier,
  EffectBroker,
  EffectBrokerError,
  canonicalRequestHash,
  deriveEffectIdempotencyKey,
  type EffectExecutor,
  type EffectKernelPort,
} from '@praetor/effect-broker';
import type { ActionAdapter } from '../types.js';
import { toEvidenceSummary } from '../types.js';
import { ActionAdapterRegistry } from '../registry.js';
import { buildConformanceIssueInput } from './grantFixture.js';

export interface ConformanceRemoteCounters {
  createCount: number;
  writeCount: number;
  compensateCount: number;
}

export interface ConformanceAdapterContext {
  adapter: ActionAdapter;
  counters: ConformanceRemoteCounters;
  destination: string;
  executeArgs: Record<string, unknown>;
  queryRequest: Record<string, unknown>;
  compensationPatch: Record<string, unknown>;
  prepareTimeout?: () => void;
}

export interface ConformanceAdapterFactory {
  readonly name: string;
  createAdapter(): ConformanceAdapterContext;
  // Required, not optional: C9 and C11 previously returned early (passing) when a
  // factory omitted these hooks, so the suite certified capabilities the adapter
  // never demonstrated.
  createAuthFailureAdapter(): ActionAdapter;
  createMultiMarkerContext(): ConformanceAdapterContext;
}

export interface ConformanceSuiteOptions {
  factory: ConformanceAdapterFactory;
}

const tenantId = 'tenant-a';
const runId = 'run-conformance';
const stepId = 'step-conformance';
const baseEffectId = 'eff-conformance-1';

/**
 * Adapter-level identity key for the fixture: derived from the fixture's real
 * tenant/run/step/effect plus the execute request, never an opaque literal, so
 * the fixture is legal under the broker's `'derive'` policy as well as `'caller'`.
 */
export function conformanceIdempotencyKeyFor(input: {
  destination: string;
  args: Record<string, unknown>;
  effectId?: string;
}): string {
  return deriveEffectIdempotencyKey({
    tenantId,
    runId,
    stepId,
    effectId: input.effectId ?? baseEffectId,
    request: { destination: input.destination, args: input.args },
  });
}

function baseExecuteInput(ctx: ConformanceAdapterContext, args?: Record<string, unknown>) {
  const resolvedArgs = args ?? ctx.executeArgs;
  return {
    tenantId,
    effectId: baseEffectId,
    idempotencyKey: conformanceIdempotencyKeyFor({
      destination: ctx.destination,
      args: resolvedArgs,
    }),
    destination: ctx.destination,
    args: resolvedArgs,
    signal: AbortSignal.timeout(10_000),
  };
}

function adapterExecutor(adapter: ActionAdapter): EffectExecutor {
  return {
    execute: async (input) => {
      const ctx = input.executionContext;
      if (!ctx?.tenantId || !ctx.effectId) {
        throw new Error('EFFECT_AUTHORIZATION_REQUIRED');
      }
      // The broker hashes the request; the ledger body carries no idempotency
      // key (a self-referential request could never satisfy `'derive'`), so the
      // executor recomputes the same derived key from the admitted request.
      const idempotencyKey = deriveEffectIdempotencyKey({
        tenantId: ctx.tenantId,
        runId,
        stepId,
        effectId: ctx.effectId,
        request: input.request,
      });
      const destination = String(input.request.destination ?? '');
      if (input.type.startsWith('compensate.')) {
        return adapter.compensate({
          tenantId: ctx.tenantId,
          effectId: ctx.effectId,
          originalEffectId: String(
            (input.request as Record<string, unknown>).originalEffectId ?? '',
          ),
          idempotencyKey,
          destination,
          forwardResponse:
            ((input.request as Record<string, unknown>).forwardResponse as Record<
              string,
              unknown
            >) ?? {},
          compensationPatch:
            ((input.request as Record<string, unknown>).compensationPatch as Record<
              string,
              unknown
            >) ?? {},
          signal: input.signal,
        });
      }
      return adapter.execute({
        tenantId: ctx.tenantId,
        effectId: ctx.effectId,
        idempotencyKey,
        destination,
        args: (input.request.args as Record<string, unknown>) ?? {},
        signal: input.signal,
      });
    },
  };
}

function createChaosKernel(): {
  kernel: EffectKernelPort;
  getState: () => string;
} {
  const effects = new Map<
    string,
    {
      id: string;
      state: string;
      type: string;
      idempotencyKey: string;
      request: Record<string, unknown>;
      response?: Record<string, unknown>;
      runId: string;
      stepId: string;
      tenantId: string;
    }
  >();
  const byKey = new Map<string, string>();
  const kernel: EffectKernelPort = {
    admitEffect: async (input) => {
      const key = `${input.tenantId}:${input.idempotencyKey}`;
      const priorId = byKey.get(key);
      if (priorId) {
        return { admitted: true, replayed: true, effect: { ...effects.get(priorId)! } };
      }
      const effect = {
        id: input.id,
        state: 'ADMITTED',
        type: input.type,
        idempotencyKey: input.idempotencyKey,
        request: input.request,
        runId: input.runId,
        stepId: input.stepId,
        tenantId: input.tenantId,
      };
      effects.set(effect.id, effect);
      byKey.set(key, effect.id);
      return { admitted: true, replayed: false, effect: { ...effect } };
    },
    completeEffect: async () => null,
    markEffectCompletionUnknown: async (input) => {
      const effect = effects.get(input.effectId);
      if (!effect || effect.tenantId !== input.tenantId || effect.state !== 'ADMITTED') return null;
      effect.state = 'COMPLETION_UNKNOWN';
      return { ...effect };
    },
    getEffect: async (effectId, tenantId) => {
      const effect = effects.get(effectId);
      if (!effect || effect.tenantId !== tenantId) return null;
      return { ...effect };
    },
    reconcileEffect: async (input) => {
      const effect = effects.get(input.effectId);
      if (!effect || effect.tenantId !== input.tenantId || effect.state !== 'COMPLETION_UNKNOWN') {
        return null;
      }
      effect.state = input.state;
      effect.response = input.response;
      return { ...effect };
    },
  };
  return {
    kernel,
    getState: () => effects.get('eff-conformance-chaos')?.state ?? 'MISSING',
  };
}

async function runTimeoutReconcileScenario(ctx: ConformanceAdapterContext): Promise<void> {
  ctx.prepareTimeout?.();
  const registry = new ActionAdapterRegistry([ctx.adapter]);
  const executor = adapterExecutor(ctx.adapter);
  const { kernel, getState } = createChaosKernel();
  const issuer = CapabilityTokenIssuer.generate({
    issuer: 'commander-worker',
    audience: 'commander.effect-broker',
    keyId: 'conformance',
  });
  const tokens = new CapabilityTokenVerifier({
    issuer: 'commander-worker',
    audience: 'commander.effect-broker',
    publicKeys: { conformance: issuer.publicKey },
  });
  const chaosEffectId = 'eff-conformance-chaos';
  const request = {
    destination: ctx.destination,
    args: ctx.executeArgs,
  };
  // Contract-complete fixture: the key is derived from the exact same five
  // fields the broker re-derives under the 'derive' policy, and the workload
  // binding is explicit and pinned to the granted capability's workloadId.
  const idempotencyKey = deriveEffectIdempotencyKey({
    tenantId,
    runId,
    stepId,
    effectId: chaosEffectId,
    request,
  });
  const workloadBinding = {
    tenantId,
    runId,
    stepId,
    workloadId: 'worker-1',
  };
  const broker = new EffectBroker(
    tokens,
    {
      evaluate: async () => ({
        effect: 'allow',
        decisionId: 'conformance',
        policySnapshotId: 'policy',
        reason: 'ok',
      }),
    },
    kernel,
    executor,
    { append: async () => {} },
    // 保持默认 requireRequestBinding=true；token 已绑定 canonicalRequestHash。
    // 显式 'derive'：一致性夹具必须同时满足 caller 与 derive 两种策略。
    {
      localWorkerId: 'worker-1',
      localWorkerGeneration: 1,
      idempotencyKeyPolicy: 'derive',
    },
  );
  const token = issuer.issue(
    buildConformanceIssueInput({
      jti: 'jti-conformance-chaos',
      tenantId,
      runId,
      stepId,
      effectTypes: [ctx.adapter.descriptor.effectType],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      requestHash: canonicalRequestHash(request),
      actionDigest: canonicalRequestHash(request),
      workerId: 'worker-1',
      workerGeneration: 1,
    }),
  );
  await assert.rejects(
    () =>
      broker.execute({
        effectId: chaosEffectId,
        token,
        type: ctx.adapter.descriptor.effectType,
        request,
        idempotencyKey,
        lease: {
          workerId: 'worker-1',
          workerGeneration: 1,
          token: 'lease',
          fencingEpoch: 1,
        },
        actor: 'worker-1',
        workloadBinding,
      }),
    (error: unknown) =>
      error instanceof EffectBrokerError &&
      (error.code === 'COMPLETION_UNCONFIRMED' || error.code === 'COMPLETION_UNKNOWN'),
  );
  assert.equal(getState(), 'COMPLETION_UNKNOWN');
  const querier = registry.outcomeQuerierFor(ctx.adapter.descriptor.effectType);
  assert.ok(querier);
  const reconciled = await broker.reconcileUnknown({
    effect: {
      id: chaosEffectId,
      state: 'COMPLETION_UNKNOWN',
      type: ctx.adapter.descriptor.effectType,
      idempotencyKey,
      request,
      runId,
      stepId,
      tenantId,
    },
    querier,
  });
  assert.equal(reconciled.status, 'APPLIED');
  assert.equal(getState(), 'COMPLETION_UNKNOWN');
}

export function registerConformanceSuite(options: ConformanceSuiteOptions): void {
  const { factory } = options;

  describe(`L4-02 conformance — ${factory.name}`, () => {
    it('C1 double execute creates one remote resource', async () => {
      const ctx = factory.createAdapter();
      const input = baseExecuteInput(ctx);
      await ctx.adapter.execute(input);
      await ctx.adapter.execute(input);
      assert.equal(ctx.counters.createCount, 1);
    });

    it('C2 queryOutcome performs no write', async () => {
      const ctx = factory.createAdapter();
      await ctx.adapter.execute(baseExecuteInput(ctx));
      const writesBefore = ctx.counters.writeCount;
      await ctx.adapter.queryOutcome({
        tenantId,
        effectId: 'eff-conformance-1',
        idempotencyKey: conformanceIdempotencyKeyFor({
          destination: ctx.destination,
          args: ctx.executeArgs,
        }),
        destination: ctx.destination,
        request: ctx.queryRequest,
      });
      assert.equal(ctx.counters.writeCount, writesBefore);
    });

    it('C7 destination mismatch denies via manifest evaluation and adapter rejection', async () => {
      const ctx = factory.createAdapter();
      const descriptor = ctx.adapter.descriptor;
      // The descriptor under test must be the registered manifest for its own
      // destination; without this the case passed on the contracts table alone.
      const registered = findAdapterManifest({
        effectType: descriptor.effectType,
        toolName: descriptor.toolName,
        destination: ctx.destination,
      });
      assert.ok(registered, 'the adapter descriptor must match a fixed manifest');
      assert.equal(registered.adapterId, descriptor.adapterId);
      const mismatched =
        descriptor.adapterId === 'github.pull-request.create'
          ? 'github://octo/repo/issues'
          : descriptor.adapterId === 'servicenow.incident.create'
            ? 'servicenow://dev12345/change_request'
            : 'k8s://kind/commander/services/api';
      assert.equal(
        findAdapterManifest({
          effectType: descriptor.effectType,
          toolName: descriptor.toolName,
          destination: mismatched,
        }),
        null,
      );
      assert.equal(evaluateManifestGatewayEffect(descriptor, mismatched), 'deny');
      await assert.rejects(() =>
        ctx.adapter.execute({ ...baseExecuteInput(ctx), destination: mismatched }),
      );
    });

    it('C8 unregistered tool/effect denies via manifest lookup', () => {
      const ctx = factory.createAdapter();
      const descriptor = ctx.adapter.descriptor;
      const registered = findAdapterManifest({
        effectType: descriptor.effectType,
        toolName: descriptor.toolName,
        destination: ctx.destination,
      });
      assert.equal(registered?.adapterId, descriptor.adapterId);
      assert.equal(registered?.compensationEffectType, descriptor.compensationEffectType);
      assert.equal(
        findAdapterManifest({
          effectType: 'demo.ticket.create',
          toolName: 'ticket.create',
          destination: ctx.destination,
        }),
        null,
      );
    });

    it('C9 401/403 map to NOT_COMMITTED terminal classification', async () => {
      const ctx = factory.createAdapter();
      const adapter = factory.createAuthFailureAdapter();
      await assert.rejects(
        () => adapter.execute(baseExecuteInput(ctx)),
        (error: unknown) => {
          assert.ok(error instanceof AdapterExecutionError);
          assert.equal(error.commitState, 'NOT_COMMITTED');
          assert.equal(error.retryMode, 'NEVER');
          // The classification must come from an HTTP 401/403 response, not from
          // any arbitrary failure inside the adapter.
          const status = error.details?.httpStatus;
          assert.equal(status === 401 || status === 403, true);
          return true;
        },
      );
    });

    it('C11 multi-marker queryOutcome returns UNKNOWN for escalation', async () => {
      const ctx = factory.createMultiMarkerContext();
      const outcome = await ctx.adapter.queryOutcome({
        tenantId,
        effectId: 'eff-conformance-multi',
        idempotencyKey: conformanceIdempotencyKeyFor({
          destination: ctx.destination,
          args: ctx.executeArgs,
        }),
        destination: ctx.destination,
        request: ctx.queryRequest,
      });
      assert.equal(outcome.status, 'UNKNOWN');
      assert.equal(outcome.error?.code, 'RECONCILE_OUTCOME_NOT_YET_VISIBLE');
    });

    it('C12 evidence summary passes DLP verification', async () => {
      const ctx = factory.createAdapter();
      const response = await ctx.adapter.execute(baseExecuteInput(ctx));
      const summary = toEvidenceSummary(ctx.adapter.descriptor, {
        ...response,
        token: 'must-not-appear',
        authorization: 'Bearer secret',
        args: { password: 'leak' },
      });
      const bundle = buildEffectEvidenceBundle({
        tenantId,
        runId: 'run-1',
        effectId: 'eff-1',
        policySnapshotId: 'ps-1',
        effects: [
          {
            id: 'eff-1',
            runId: 'run-1',
            stepId: 'step-1',
            tenantId,
            type: ctx.adapter.descriptor.effectType,
            state: 'COMPLETED',
            policyDecisionId: 'pd-1',
            requestHash: 'hash-1',
            request: { destination: ctx.destination },
            response: { ...summary },
            createdAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          },
        ],
        auditEvents: [],
      });
      const verification = verifyEvidenceBundle(bundle);
      assert.equal(verification.ok, true);
      const serialized = JSON.stringify(bundle);
      assert.equal(serialized.includes('must-not-appear'), false);
      assert.equal(serialized.includes('Bearer secret'), false);
    });

    it('C3 timeout reconcile COMPLETED', async () => {
      const ctx = factory.createAdapter();
      await runTimeoutReconcileScenario(ctx);
    });

    it('C4 reconcile no extra create', async () => {
      const ctx = factory.createAdapter();
      await runTimeoutReconcileScenario(ctx);
      assert.equal(ctx.counters.createCount, 1);
    });

    it('C5 double compensate one remote change', async () => {
      const ctx = factory.createAdapter();
      const forward = await ctx.adapter.execute(baseExecuteInput(ctx));
      const compensateInput = {
        tenantId,
        effectId: 'eff-conformance-cmp',
        originalEffectId: 'eff-conformance-1',
        idempotencyKey: 'cmp:eff-conformance-1:1.0.0',
        destination: ctx.destination,
        forwardResponse: forward,
        compensationPatch: ctx.compensationPatch,
        signal: AbortSignal.timeout(10_000),
      };
      await ctx.adapter.compensate(compensateInput);
      await ctx.adapter.compensate(compensateInput);
      assert.equal(ctx.counters.compensateCount, 1);
    });
  });
}

export { githubPrBodyMarker, servicenowCorrelationId };
