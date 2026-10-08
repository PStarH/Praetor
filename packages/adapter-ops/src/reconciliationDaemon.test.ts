import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  canonicalEvidenceBody,
  EffectBroker,
  type EffectRemoteOutcome,
  createEvidenceSigner,
  verifyEvidenceSignature,
  type EvidenceBundle,
  type EvidenceSignature,
} from '@praetor/effect-broker';
import {
  ReconciliationDaemon,
  reconcileQueryThrownError,
  type ReconciliationDaemonOptions,
} from './reconciliationDaemon.js';

/**
 * A real Ed25519 signer: the daemon self-checks `assertEvidenceRecord(record,
 * { verifySignature: signer.verify })`, and a `verify: () => true` double turned
 * that acceptance boundary into a no-op, so terminal evidence signatures were
 * never actually verified.
 */
const TEST_EVIDENCE_SIGNER = createEvidenceSigner({
  privateKeyPem: generateKeyPairSync('ed25519').privateKey.export({
    type: 'pkcs8',
    format: 'pem',
  }) as string,
  keyId: 'test-key',
});

const TEST_RECONCILE_WORKER = {
  workerId: 'reconcile:test-instance',
  workerGeneration: 7,
  claimSecret: 'test-claim-secret',
} as const;

const EFFECT = {
  id: 'effect-1',
  runId: 'run-1',
  stepId: 'step-1',
  tenantId: 'tenant-a',
  type: 'github.pull-request.create',
  idempotencyKey: 'effect-key',
  request: { destination: 'octo/repo' },
  response: undefined,
  state: 'COMPLETION_UNKNOWN',
  actionDigest: 'a'.repeat(64),
  policyDecisionId: 'decision-1',
  policySnapshotId: 'policy-1',
  requestHash: 'request-1',
  createdAt: '2026-07-29T00:00:00.000Z',
} as const;

const CLAIM = {
  effect: EFFECT,
  claimToken: 'claim-token',
} as const;

const SUCCESS = {
  applied: true,
  replayed: false,
  disposition: 'COMPLETED',
  receipt: {},
} as const;

function mutationWithoutEvidence(input: unknown): Record<string, unknown> {
  assert.ok(input && typeof input === 'object');
  const { evidence: _evidence, ...mutation } = input as Record<string, unknown>;
  return mutation;
}

function assertSignedEvidence(input: unknown): void {
  assert.ok(input && typeof input === 'object');
  const evidence = (input as Record<string, unknown>).evidence as
    { body?: unknown; signature?: unknown } | undefined;
  assert.ok(evidence && typeof evidence === 'object');
  const signature = evidence.signature as EvidenceSignature;
  assert.equal(signature.algorithm, 'Ed25519');
  assert.equal(signature.keyId, 'test-key');
  // Cryptographically verify the terminal evidence instead of comparing it to
  // the value the stub signer happened to return.
  assert.equal(
    verifyEvidenceSignature(
      canonicalEvidenceBody(evidence.body as EvidenceBundle),
      signature,
      TEST_EVIDENCE_SIGNER.jwks,
    ),
    true,
    'terminal evidence signature must verify against the signing key',
  );
  // A tampered body must not verify — the check above must be able to fail.
  const tampered = { ...(evidence.body as Record<string, unknown>), runId: 'run-tampered' };
  assert.equal(
    verifyEvidenceSignature(
      canonicalEvidenceBody(tampered as unknown as EvidenceBundle),
      signature,
      TEST_EVIDENCE_SIGNER.jwks,
    ),
    false,
    'a tampered evidence body must fail verification',
  );
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail('condition was not reached');
}

function daemonFor(input: {
  outcome?: Record<string, unknown>;
  queryError?: unknown;
  queryDelayMs?: number;
  brokerFactoryError?: unknown;
  brokerFactory?: ReconciliationDaemonOptions['brokerFactory'];
  repository?: Record<string, unknown>;
  registry?: Record<string, unknown>;
  heartbeat?: () => Promise<void>;
  drain?: () => Promise<void>;
  telemetry?: (event: Record<string, unknown>) => void;
  terminalEvidenceContext?: Record<string, unknown>;
  queryTimeoutMs?: number;
}) {
  const querier = { queryOutcome: async () => ({ status: 'UNKNOWN' }) };
  const queryCalls: Array<Record<string, unknown>> = [];
  let brokerFactoryCalls = 0;
  const repository = {
    claimReconcileEffects: async () => [CLAIM],
    listEffectsForRun: async () => [EFFECT],
    listEvents: async () => [],
    completeReconcileEffect: async () => SUCCESS,
    confirmEffectNotApplied: async () => ({ ...SUCCESS, disposition: 'CONFIRMED_NOT_APPLIED' }),
    rescheduleReconcileEffect: async () => ({ ...SUCCESS, disposition: 'RESCHEDULED' }),
    escalateReconcileEffect: async () => ({ ...SUCCESS, disposition: 'ESCALATED' }),
    ...input.repository,
  };
  const daemon = new ReconciliationDaemon({
    ...TEST_RECONCILE_WORKER,
    repository: repository as never,
    registry: {
      resolve: () => ({}),
      outcomeQuerierFor: () => querier,
      ...input.registry,
    } as never,
    pollIntervalMs: 60_000,
    batchSize: 10,
    evidenceSigner: TEST_EVIDENCE_SIGNER,
    brokerFactory:
      input.brokerFactory ??
      (() => {
        brokerFactoryCalls += 1;
        if ('brokerFactoryError' in input) throw input.brokerFactoryError;
        return {
          reconcileUnknown: async (query: Record<string, unknown>) => {
            queryCalls.push(query);
            if ('queryError' in input) throw input.queryError;
            if (input.queryDelayMs) {
              await new Promise<void>((resolve) => setTimeout(resolve, input.queryDelayMs));
            }
            return (
              input.outcome ?? { status: 'UNKNOWN', error: { code: 'UNKNOWN', message: 'unknown' } }
            );
          },
        } as never;
      }),
    heartbeat: input.heartbeat,
    drain: input.drain,
    telemetry: input.telemetry as never,
    terminalEvidenceContext: input.terminalEvidenceContext as never,
    queryTimeoutMs: input.queryTimeoutMs,
  });
  return { daemon, querier, queryCalls, repository, brokerFactoryCalls: () => brokerFactoryCalls };
}

function evidenceSigner() {
  const { privateKey } = generateKeyPairSync('ed25519');
  return createEvidenceSigner({
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    keyId: 'reconciliation-evidence-key',
  });
}

describe('ReconciliationDaemon', () => {
  it('binds evidence context reads to the current reconcile claim token', async () => {
    const reads: unknown[][] = [];
    const { daemon } = daemonFor({
      outcome: { status: 'APPLIED', response: { number: 42 } },
      terminalEvidenceContext: {
        getTerminalEvidenceContext: async (...args: unknown[]) => {
          reads.push(args);
          return { effect: EFFECT, events: [] };
        },
      },
      repository: {
        listEffectsForRun: async () => assert.fail('broad effect read must not run'),
        listEvents: async () => assert.fail('broad event read must not run'),
      },
    });

    assert.equal((await daemon.tick()).completed, 1);
    assert.deepEqual(reads, [[EFFECT.id, EFFECT.runId, EFFECT.tenantId, CLAIM.claimToken]]);
  });

  it('maps APPLIED and NOT_APPLIED to exactly one fenced terminal mutation', async () => {
    for (const test of [
      {
        outcome: { status: 'APPLIED', response: { number: 42 } },
        method: 'completeReconcileEffect',
        response: { number: 42 },
      },
      {
        outcome: { status: 'NOT_APPLIED', response: { checked: true } },
        method: 'confirmEffectNotApplied',
        response: { checked: true },
      },
    ] as const) {
      const writes: Array<{ method: string; input: unknown }> = [];
      const dispositions = {
        completeReconcileEffect: 'COMPLETED',
        confirmEffectNotApplied: 'CONFIRMED_NOT_APPLIED',
        rescheduleReconcileEffect: 'RESCHEDULED',
        escalateReconcileEffect: 'ESCALATED',
      } as const;
      const methods = Object.fromEntries(
        Object.entries(dispositions).map(([method, disposition]) => [
          method,
          async (input: unknown) => {
            writes.push({ method, input });
            return { ...SUCCESS, disposition };
          },
        ]),
      );
      const { daemon, queryCalls } = daemonFor({
        outcome: test.outcome,
        repository: methods,
      });

      assert.deepEqual(await daemon.tick(), {
        claimed: 1,
        completed: 1,
        escalated: 0,
        rescheduled: 0,
      });
      assert.equal(queryCalls.length, 1);
      assert.equal(queryCalls[0]?.effect, EFFECT, 'broker must receive the claimed snapshot');
      assert.deepEqual(
        writes.map(({ method, input }) => ({ method, input: mutationWithoutEvidence(input) })),
        [
          {
            method: test.method,
            input: {
              tenantId: EFFECT.tenantId,
              effectId: EFFECT.id,
              ...TEST_RECONCILE_WORKER,
              claimToken: CLAIM.claimToken,
              response: test.response,
            },
          },
        ],
      );
      assertSignedEvidence(writes[0]?.input);
    }
  });

  it('passes UNKNOWN to the repository without calculating attempts, backoff, or deadline', async () => {
    const writes: Array<{ method: string; input: unknown }> = [];
    const { daemon } = daemonFor({
      outcome: {
        status: 'UNKNOWN',
        error: { code: 'RECONCILE_OUTCOME_NOT_YET_VISIBLE', message: 'not visible yet' },
      },
      repository: {
        rescheduleReconcileEffect: async (input: unknown) => {
          writes.push({ method: 'rescheduleReconcileEffect', input });
          return { ...SUCCESS, disposition: 'RESCHEDULED' };
        },
        escalateReconcileEffect: async (input: unknown) => {
          writes.push({ method: 'escalateReconcileEffect', input });
          return { ...SUCCESS, disposition: 'ESCALATED' };
        },
      },
    });

    assert.deepEqual(await daemon.tick(), {
      claimed: 1,
      completed: 0,
      escalated: 0,
      rescheduled: 1,
    });
    assert.deepEqual(
      writes.map(({ method, input }) => ({ method, input: mutationWithoutEvidence(input) })),
      [
        {
          method: 'rescheduleReconcileEffect',
          input: {
            tenantId: EFFECT.tenantId,
            effectId: EFFECT.id,
            ...TEST_RECONCILE_WORKER,
            claimToken: CLAIM.claimToken,
            lastError: {
              code: 'RECONCILE_OUTCOME_NOT_YET_VISIBLE',
              message: 'not visible yet',
            },
          },
        },
      ],
    );
    assertSignedEvidence(writes[0]?.input);
    assert.equal('reconcileAfter' in (writes[0]?.input as object), false);
  });

  it('normalizes thrown queries without persisting thrown content and treats reschedule as success', async () => {
    const leakedSecret = 'https://user:raw-secret@example.test/provider-body';
    const thrown = Object.assign(new Error(leakedSecret), {
      name: 'CredentialExplosion',
      code: 'AUTHORIZATION_HEADER_BEARER_SECRET',
      cause: { providerBody: leakedSecret },
    });
    let heartbeatCount = 0;
    let persisted: Record<string, unknown> | undefined;
    const { daemon } = daemonFor({
      queryError: thrown,
      repository: {
        rescheduleReconcileEffect: async (input: Record<string, unknown>) => {
          persisted = input;
          return { ...SUCCESS, disposition: 'RESCHEDULED' };
        },
      },
      heartbeat: async () => {
        heartbeatCount += 1;
      },
    });

    assert.equal((await daemon.tick()).rescheduled, 1);
    assert.equal(heartbeatCount, 1);
    assert.deepEqual(persisted?.lastError, {
      code: 'RECONCILE_QUERY_THROWN',
      message: 'Outcome query threw Error for effect type github.pull-request.create',
    });
    assert.equal(JSON.stringify(persisted).includes(leakedSecret), false);
    assert.equal(JSON.stringify(persisted).includes('AUTHORIZATION_HEADER'), false);
  });

  it('does not consume an attempt when broker construction fails before the query', async () => {
    const failure = Object.assign(new Error('broker unavailable'), { code: 'BROKER_UNAVAILABLE' });
    const writes: string[] = [];
    const { daemon } = daemonFor({
      brokerFactoryError: failure,
      repository: {
        rescheduleReconcileEffect: async () => {
          writes.push('reschedule');
          return { ...SUCCESS, disposition: 'RESCHEDULED' };
        },
      },
    });

    await assert.rejects(() => daemon.tick(), failure);
    assert.deepEqual(writes, []);
  });

  it('uses stable safe summaries for every thrown-value kind and caps them at 512 code points', () => {
    const cases: Array<[unknown, string]> = [
      [new TypeError('private'), 'TypeError'],
      ['raw secret', 'non-Error:string'],
      [{ providerBody: 'private' }, 'non-Error:object'],
      [42, 'non-Error:number'],
      [true, 'non-Error:boolean'],
      [1n, 'non-Error:bigint'],
      [Symbol('private'), 'non-Error:symbol'],
      [() => 'private', 'non-Error:function'],
      [undefined, 'non-Error:undefined'],
      [null, 'non-Error:null'],
    ];
    for (const [thrown, kind] of cases) {
      assert.deepEqual(reconcileQueryThrownError(thrown, 'type with spaces/?'), {
        code: 'RECONCILE_QUERY_THROWN',
        message: `Outcome query threw ${kind} for effect type type_with_spaces__`,
      });
    }

    const result = reconcileQueryThrownError('secret', `type/${'x'.repeat(600)}\ud83d\ude00`);
    assert.equal(Array.from(result.message).length, 512);
    assert.equal(result.message.endsWith('...'), false);
    assert.match(result.message, /^Outcome query threw non-Error:string for effect type type_/);
  });

  it('escalates missing adapters before querying and preserves fenced claim auth', async () => {
    let queryCount = 0;
    let mutation: unknown;
    const { daemon } = daemonFor({
      registry: {
        resolve: () => null,
        outcomeQuerierFor: () => {
          queryCount += 1;
          return null;
        },
      },
      repository: {
        escalateReconcileEffect: async (input: unknown) => {
          mutation = input;
          return { ...SUCCESS, disposition: 'ESCALATED' };
        },
      },
    });

    assert.equal((await daemon.tick()).escalated, 1);
    assert.equal(queryCount, 0);
    assertSignedEvidence(mutation);
    assert.deepEqual(mutationWithoutEvidence(mutation), {
      tenantId: EFFECT.tenantId,
      effectId: EFFECT.id,
      ...TEST_RECONCILE_WORKER,
      claimToken: CLAIM.claimToken,
      reason: 'RECONCILE_ADAPTER_NOT_FOUND',
    });
  });

  it('escalates a registered adapter without query support before invoking the broker', async () => {
    let mutation: unknown;
    const { daemon, brokerFactoryCalls } = daemonFor({
      registry: {
        resolve: () => ({}),
        outcomeQuerierFor: () => null,
      },
      repository: {
        escalateReconcileEffect: async (input: unknown) => {
          mutation = input;
          return { ...SUCCESS, disposition: 'ESCALATED' };
        },
      },
    });
    assert.equal((await daemon.tick()).escalated, 1);
    assert.equal(brokerFactoryCalls(), 0);
    assertSignedEvidence(mutation);
    assert.deepEqual(mutationWithoutEvidence(mutation), {
      tenantId: EFFECT.tenantId,
      effectId: EFFECT.id,
      ...TEST_RECONCILE_WORKER,
      claimToken: CLAIM.claimToken,
      reason: 'RECONCILE_QUERY_UNSUPPORTED',
    });
  });

  it('uses the compensation-specific escalation when compensation query support is missing', async () => {
    let mutation: unknown;
    const compensationEffect = {
      ...EFFECT,
      id: 'effect-compensation',
      type: 'compensate.kubernetes.deployment.rollback',
    };
    const { daemon, brokerFactoryCalls } = daemonFor({
      registry: {
        resolve: () => ({}),
        outcomeQuerierFor: () => null,
      },
      repository: {
        claimReconcileEffects: async () => [
          {
            effect: compensationEffect,
            claimToken: 'claim-compensation',
          },
        ],
        listEffectsForRun: async () => [compensationEffect],
        escalateReconcileEffect: async (input: unknown) => {
          mutation = input;
          return { ...SUCCESS, disposition: 'ESCALATED' };
        },
      },
    });

    assert.equal((await daemon.tick()).escalated, 1);
    assert.equal(brokerFactoryCalls(), 0);
    assertSignedEvidence(mutation);
    assert.deepEqual(mutationWithoutEvidence(mutation), {
      tenantId: compensationEffect.tenantId,
      effectId: compensationEffect.id,
      ...TEST_RECONCILE_WORKER,
      claimToken: 'claim-compensation',
      reason: 'COMPENSATION_QUERY_UNSUPPORTED',
    });
  });

  it('turns a malformed UNKNOWN into a typed adapter failure', async () => {
    let persisted: Record<string, unknown> | undefined;
    const { daemon } = daemonFor({
      outcome: { status: 'UNKNOWN' },
      repository: {
        rescheduleReconcileEffect: async (input: Record<string, unknown>) => {
          persisted = input;
          return { ...SUCCESS, disposition: 'RESCHEDULED' };
        },
      },
    });

    assert.equal((await daemon.tick()).rescheduled, 1);
    assert.deepEqual(persisted?.lastError, {
      code: 'ADAPTER_OUTCOME_INVALID',
      message: 'Adapter outcome invalid for effect type github.pull-request.create',
    });
  });

  it('does not retry or fall back to another write after a fenced mutation is rejected', async () => {
    const writes: string[] = [];
    const { daemon } = daemonFor({
      outcome: { status: 'APPLIED', response: {} },
      repository: {
        completeReconcileEffect: async () => {
          writes.push('complete');
          return { applied: false, reason: 'CLAIM_NOT_OWNED' };
        },
        rescheduleReconcileEffect: async () => {
          writes.push('reschedule');
          return { ...SUCCESS, disposition: 'RESCHEDULED' };
        },
        escalateReconcileEffect: async () => {
          writes.push('escalate');
          return { ...SUCCESS, disposition: 'ESCALATED' };
        },
      },
    });

    await assert.rejects(() => daemon.tick(), { code: 'RECONCILE_CLAIM_NOT_OWNED' });
    assert.deepEqual(writes, ['complete']);
  });

  it('passes durable worker identity to claims and records database failures', async () => {
    const failure = Object.assign(new Error('db unavailable'), { code: 'DB_UNAVAILABLE' });
    let claimInput: unknown;
    let heartbeats = 0;
    const telemetry: Array<Record<string, unknown>> = [];
    const { daemon } = daemonFor({
      repository: {
        claimReconcileEffects: async (input: unknown) => {
          claimInput = input;
          throw failure;
        },
      },
      heartbeat: async () => {
        heartbeats += 1;
      },
      telemetry: (event) => telemetry.push(event),
    });

    await assert.rejects(() => daemon.tick(), failure);
    assert.deepEqual(claimInput, { ...TEST_RECONCILE_WORKER, limit: 10 });
    assert.equal(heartbeats, 0);
    assert.equal(daemon.getHealth().lastErrorCode, 'DB_UNAVAILABLE');
    assert.deepEqual(
      telemetry.map(({ type, loop, errorCode }) => ({ type, loop, errorCode })),
      [
        {
          type: 'ops_loop_tick_failed',
          loop: 'reconciliation',
          errorCode: 'DB_UNAVAILABLE',
        },
      ],
    );
  });

  it('starts an immediate non-overlapping tick and drains after in-flight work', async () => {
    let releaseClaim: ((entries: never[]) => void) | undefined;
    const claimed = new Promise<never[]>((resolve) => {
      releaseClaim = resolve;
    });
    let claimCalls = 0;
    let heartbeats = 0;
    let drains = 0;
    const { daemon } = daemonFor({
      repository: {
        claimReconcileEffects: async () => {
          claimCalls += 1;
          return claimed;
        },
      },
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
      claimed: 0,
      completed: 0,
      escalated: 0,
      rescheduled: 0,
    });

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
   * AO-06: the outcome query had no timeout, so a query slower than the kernel's
   * fixed 60s claim lease let the lease expire mid-flight; the later mutation was
   * fenced (`CLAIM_EXPIRED`) and `reconcile_attempts` never advanced, so the same
   * effect was re-driven forever. The daemon must bound the query and route the
   * timeout through the reschedule path.
   */
  it('turns an over-budget outcome query into a reschedule instead of blocking the tick', async () => {
    let persisted: Record<string, unknown> | undefined;
    const { daemon } = daemonFor({
      queryTimeoutMs: 25,
      queryDelayMs: 200,
      outcome: { status: 'UNKNOWN', error: { code: 'SLOW_REMOTE', message: 'slow remote' } },
      repository: {
        rescheduleReconcileEffect: async (input: Record<string, unknown>) => {
          persisted = input;
          return { ...SUCCESS, disposition: 'RESCHEDULED' };
        },
      },
    });

    const startedAt = Date.now();
    const stats = await daemon.tick();
    const elapsedMs = Date.now() - startedAt;

    assert.equal(stats.rescheduled, 1);
    assert.equal(stats.completed, 0);
    assert.deepEqual(persisted?.lastError, {
      code: 'RECONCILE_QUERY_TIMEOUT',
      message: 'Outcome query exceeded 25ms budget for effect type github.pull-request.create',
    });
    assert.ok(elapsedMs < 150, `tick must not wait for the slow query (waited ${elapsedMs}ms)`);
  });

  it('aborts the adapter through the real broker and keeps a timeout ahead of an abort-time APPLIED result', async () => {
    let observedSignal: AbortSignal | undefined;
    let aborts = 0;
    let completions = 0;
    let lastError: unknown;
    const { daemon } = daemonFor({
      queryTimeoutMs: 25,
      brokerFactory: () => ({ reconcileUnknown: EffectBroker.prototype.reconcileUnknown }),
      registry: {
        outcomeQuerierFor: () => ({
          queryOutcome: async ({ signal }: { signal?: AbortSignal }) => {
            observedSignal = signal;
            return new Promise<EffectRemoteOutcome>((resolve) => {
              signal?.addEventListener(
                'abort',
                () => {
                  aborts += 1;
                  resolve({ status: 'APPLIED', response: { number: 42 } });
                },
                { once: true },
              );
            });
          },
        }),
      },
      repository: {
        completeReconcileEffect: async () => {
          completions += 1;
          return SUCCESS;
        },
        rescheduleReconcileEffect: async (input: Record<string, unknown>) => {
          lastError = input.lastError;
          return { ...SUCCESS, disposition: 'RESCHEDULED' };
        },
      },
    });
    const keepAlive = setInterval(() => undefined, 1_000);
    try {
      const stats = await daemon.tick();
      assert.equal(
        observedSignal?.aborted,
        true,
        'adapter must receive an aborted deadline signal',
      );
      assert.equal(aborts, 1);
      assert.equal(stats.rescheduled, 1);
      assert.equal(stats.completed, 0);
      assert.equal(completions, 0);
      assert.deepEqual(lastError, {
        code: 'RECONCILE_QUERY_TIMEOUT',
        message: 'Outcome query exceeded 25ms budget for effect type github.pull-request.create',
      });
    } finally {
      clearInterval(keepAlive);
    }
  });

  it('does not commit a late APPLIED result from an adapter that ignores cancellation', async () => {
    let observedSignal: AbortSignal | undefined;
    let completeQuery: ((outcome: EffectRemoteOutcome) => void) | undefined;
    let completions = 0;
    const { daemon } = daemonFor({
      queryTimeoutMs: 25,
      brokerFactory: () => ({ reconcileUnknown: EffectBroker.prototype.reconcileUnknown }),
      registry: {
        outcomeQuerierFor: () => ({
          queryOutcome: async ({ signal }: { signal?: AbortSignal }) => {
            observedSignal = signal;
            return new Promise<EffectRemoteOutcome>((resolve) => {
              completeQuery = resolve;
            });
          },
        }),
      },
      repository: {
        completeReconcileEffect: async () => {
          completions += 1;
          return SUCCESS;
        },
      },
    });
    const keepAlive = setInterval(() => undefined, 1_000);
    try {
      assert.equal((await daemon.tick()).rescheduled, 1);
      assert.equal(observedSignal?.aborted, true);
      assert.ok(completeQuery);
      completeQuery({ status: 'APPLIED', response: { number: 42 } });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(completions, 0);
    } finally {
      clearInterval(keepAlive);
    }
  });

  it('refuses a query budget that is not a positive integer below the claim lease', () => {
    for (const queryTimeoutMs of [0, -1, 1.5, Number.NaN, 60_000, 120_000]) {
      assert.throws(
        () => daemonFor({ queryTimeoutMs }),
        /RECONCILE_QUERY_TIMEOUT_INVALID/,
        `queryTimeoutMs=${String(queryTimeoutMs)}`,
      );
    }
  });
});
