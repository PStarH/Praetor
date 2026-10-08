import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { commanderActionMarker, compensationIdempotencyKey } from '@praetor/contracts';
import { AdapterExecutionError } from '@praetor/effect-broker';
import type { KubernetesCredentialProvider } from '../types.js';
import { createKubernetesDeploymentRollbackAdapter } from './deploymentRollback.js';

const tenantId = 'tenant-a';
const destination = 'k8s://kind/commander/deployments/api';
const idempotencyKey = 'idem-1';
const actionAnnotation = 'commander.io/action-marker';
const compensationAnnotation = 'commander.io/compensation-marker';

interface DeploymentFixture {
  name: string;
  namespace: string;
  revision: string;
  annotations: Record<string, string>;
  template: Record<string, unknown>;
  generation?: number;
  observedGeneration?: number;
}

interface ReplicaSetFixture {
  name: string;
  namespace: string;
  revision: string;
  deployment: string;
  template: Record<string, unknown>;
}

interface FixtureState {
  deployments: DeploymentFixture[];
  replicaSets: ReplicaSetFixture[];
  calls: Array<{ method: string; path: string; body?: Record<string, unknown> }>;
  markerPatchCount: number;
  rollbackCount: number;
  timeoutAfterRollback: boolean;
  rolloutCompletes: boolean;
  listStatus?: number;
}

function credentials(): KubernetesCredentialProvider {
  return {
    async getToken(tenant, cluster, namespace) {
      assert.equal(tenant, tenantId);
      assert.equal(cluster, 'kind');
      assert.equal(namespace, 'commander');
      return 'k8s-token';
    },
    getServer(tenant, cluster, namespace) {
      assert.equal(tenant, tenantId);
      assert.equal(cluster, 'kind');
      assert.equal(namespace, 'commander');
      return new URL('https://kubernetes.example');
    },
  };
}

function wireDeployment(deployment: DeploymentFixture): Record<string, unknown> {
  const generation = deployment.generation ?? 2;
  return {
    metadata: {
      name: deployment.name,
      namespace: deployment.namespace,
      uid: `uid-${deployment.name}`,
      resourceVersion: '100',
      generation,
      annotations: {
        ...deployment.annotations,
        'deployment.kubernetes.io/revision': deployment.revision,
      },
    },
    spec: {
      selector: { matchLabels: { app: deployment.name } },
      template: deployment.template,
    },
    status: {
      observedGeneration: deployment.observedGeneration ?? generation,
      replicas: 1,
      updatedReplicas: 1,
      availableReplicas: 1,
      unavailableReplicas: 0,
    },
  };
}

function wireReplicaSet(replicaSet: ReplicaSetFixture): Record<string, unknown> {
  return {
    metadata: {
      name: replicaSet.name,
      namespace: replicaSet.namespace,
      annotations: { 'deployment.kubernetes.io/revision': replicaSet.revision },
      ownerReferences: [
        { apiVersion: 'apps/v1', kind: 'Deployment', uid: `uid-${replicaSet.deployment}` },
      ],
    },
    spec: { template: replicaSet.template },
  };
}

const templateV1 = {
  metadata: { labels: { app: 'api' } },
  spec: { containers: [{ name: 'api', image: 'example/api:v1' }] },
};
const templateV2 = {
  metadata: { labels: { app: 'api' } },
  spec: { containers: [{ name: 'api', image: 'example/api:v2' }] },
};

function fixture(initial?: Partial<FixtureState>) {
  const state: FixtureState = {
    deployments: [
      {
        name: 'api',
        namespace: 'commander',
        revision: '9',
        annotations: {},
        template: templateV2,
      },
    ],
    replicaSets: [
      {
        name: 'api-v1',
        namespace: 'commander',
        revision: '7',
        deployment: 'api',
        template: templateV1,
      },
      {
        name: 'api-v2',
        namespace: 'commander',
        revision: '9',
        deployment: 'api',
        template: templateV2,
      },
    ],
    calls: [],
    markerPatchCount: 0,
    rollbackCount: 0,
    timeoutAfterRollback: false,
    rolloutCompletes: true,
    ...initial,
  };
  const fetchImpl = async (request: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(request));
    const method = init?.method ?? 'GET';
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : undefined;
    state.calls.push({ method, path: url.pathname, body });
    assert.equal(
      init?.headers && new Headers(init.headers).get('Authorization'),
      'Bearer k8s-token',
    );

    const collection = '/apis/apps/v1/namespaces/commander/deployments';
    if (method === 'GET' && url.pathname === collection) {
      if (state.listStatus) return new Response('{}', { status: state.listStatus });
      return Response.json({ items: state.deployments.map(wireDeployment) });
    }
    if (method === 'GET' && url.pathname === '/apis/apps/v1/namespaces/commander/replicasets') {
      assert.equal(url.searchParams.get('labelSelector'), 'app=api');
      return Response.json({ items: state.replicaSets.map(wireReplicaSet) });
    }
    if (method === 'PATCH' && url.pathname === `${collection}/api`) {
      const annotations = ((body?.metadata as Record<string, unknown>)?.annotations ??
        {}) as Record<string, string>;
      Object.assign(state.deployments[0]!.annotations, annotations);
      if (body?.spec && typeof body.spec === 'object') {
        state.rollbackCount += 1;
        state.deployments[0]!.template = (body.spec as Record<string, unknown>).template as Record<
          string,
          unknown
        >;
        state.deployments[0]!.revision = '10';
        state.deployments[0]!.generation = 3;
        state.deployments[0]!.observedGeneration = state.rolloutCompletes ? 3 : 2;
        if (state.timeoutAfterRollback) {
          state.timeoutAfterRollback = false;
          throw new DOMException('request timed out', 'AbortError');
        }
      } else {
        state.markerPatchCount += 1;
      }
      return Response.json(wireDeployment(state.deployments[0]!));
    }
    return new Response('{}', { status: 404 });
  };
  return {
    state,
    adapter: createKubernetesDeploymentRollbackAdapter({
      credentials: credentials(),
      fetch: fetchImpl,
    }),
  };
}

function executeInput() {
  return {
    tenantId,
    effectId: 'effect-1',
    idempotencyKey,
    destination,
    args: { targetRevision: '7', reason: 'rollback faulty release' },
    signal: AbortSignal.timeout(10_000),
  };
}

describe('Kubernetes deployment rollback adapter', () => {
  it('rejects forward arguments outside the approved descriptor keys', async () => {
    const { adapter, state } = fixture();
    await assert.rejects(
      () =>
        adapter.execute({
          ...executeInput(),
          args: { targetRevision: '7', reason: 'rollback faulty release', image: 'attacker/image' },
        }),
      (error: unknown) =>
        error instanceof AdapterExecutionError &&
        error.code === 'KUBERNETES_ARGUMENTS_INVALID' &&
        error.commitState === 'NOT_COMMITTED',
    );
    assert.equal(state.markerPatchCount, 0);
    assert.equal(state.rollbackCount, 0);
  });

  it('uses ReplicaSet history and strategic merge PATCH for an apps/v1 rollback', async () => {
    const { adapter, state } = fixture();
    const response = await adapter.execute(executeInput());

    assert.deepEqual(response, {
      deployment: 'api',
      namespace: 'commander',
      revision: '9',
      status: 'APPLIED',
      httpStatus: 200,
    });
    assert.deepEqual(
      state.calls.map(({ method, path }) => `${method} ${path}`),
      [
        'GET /apis/apps/v1/namespaces/commander/deployments',
        'GET /apis/apps/v1/namespaces/commander/replicasets',
        'PATCH /apis/apps/v1/namespaces/commander/deployments/api',
        'PATCH /apis/apps/v1/namespaces/commander/deployments/api',
      ],
    );
    assert.equal(
      state.deployments[0]!.annotations[actionAnnotation],
      commanderActionMarker(tenantId, idempotencyKey),
    );
    assert.equal(state.markerPatchCount, 1);
    assert.equal(state.rollbackCount, 1);
  });

  it('recovers timeout-after-accept by query and never writes twice', async () => {
    const { adapter, state } = fixture({ timeoutAfterRollback: true });
    await assert.rejects(
      () => adapter.execute(executeInput()),
      (error: unknown) => {
        assert.ok(error instanceof AdapterExecutionError);
        assert.equal(error.commitState, 'UNKNOWN');
        assert.equal(error.retryMode, 'QUERY_FIRST');
        return true;
      },
    );
    const outcome = await adapter.queryOutcome({
      tenantId,
      effectId: 'effect-1',
      idempotencyKey,
      destination,
      request: { args: { targetRevision: '7' } },
    });
    assert.deepEqual(outcome, {
      status: 'APPLIED',
      response: {
        deployment: 'api',
        namespace: 'commander',
        revision: '9',
        status: 'APPLIED',
        httpStatus: 200,
      },
    });
    await adapter.execute(executeInput());
    assert.equal(state.markerPatchCount, 1);
    assert.equal(state.rollbackCount, 1);
  });

  it('keeps an accepted but unconverged rollout UNKNOWN for query-first recovery', async () => {
    const { adapter, state } = fixture({ rolloutCompletes: false });
    await assert.rejects(
      () => adapter.execute(executeInput()),
      (error: unknown) =>
        error instanceof AdapterExecutionError &&
        error.code === 'KUBERNETES_ROLLOUT_PENDING' &&
        error.retryMode === 'QUERY_FIRST',
    );
    const outcome = await adapter.queryOutcome({
      tenantId,
      effectId: 'effect-1',
      idempotencyKey,
      destination,
      request: { targetRevision: '7' },
    });
    assert.equal(outcome.status, 'UNKNOWN');
    assert.equal(state.rollbackCount, 1);
  });

  it('reports UNKNOWN when a 200 deployment list omits items (AA-05)', async () => {
    const malformed = fixture({ listStatus: 200 });
    const outcome = await malformed.adapter.queryOutcome({
      tenantId,
      effectId: 'effect-1',
      idempotencyKey,
      destination,
      request: { targetRevision: '7' },
    });
    assert.equal(outcome.status, 'UNKNOWN');
  });

  it('preserves NOT_APPLIED and UNKNOWN remote classifications', async () => {
    const absent = fixture();
    const missing = await absent.adapter.queryOutcome({
      tenantId,
      effectId: 'effect-1',
      idempotencyKey,
      destination,
      request: { targetRevision: '7' },
    });
    assert.deepEqual(missing, {
      status: 'NOT_APPLIED',
      response: {
        deployment: 'api',
        namespace: 'commander',
        status: 'NOT_APPLIED',
        httpStatus: 200,
      },
    });

    const marker = commanderActionMarker(tenantId, idempotencyKey);
    const conflicting = fixture({
      deployments: [
        {
          name: 'api',
          namespace: 'commander',
          revision: '8',
          annotations: { [actionAnnotation]: marker },
          template: templateV2,
        },
      ],
    });
    assert.deepEqual(
      await conflicting.adapter.queryOutcome({
        tenantId,
        effectId: 'effect-1',
        idempotencyKey,
        destination,
        request: { targetRevision: '7' },
      }),
      {
        status: 'UNKNOWN',
        error: {
          code: 'RECONCILE_OUTCOME_NOT_YET_VISIBLE',
          message: 'Remote outcome is not yet provable',
        },
      },
    );

    const duplicate = fixture({
      deployments: [
        {
          name: 'api',
          namespace: 'commander',
          revision: '7',
          annotations: { [actionAnnotation]: marker },
          template: templateV1,
        },
        {
          name: 'api-copy',
          namespace: 'commander',
          revision: '7',
          annotations: { [actionAnnotation]: marker },
          template: templateV1,
        },
      ],
    });
    assert.deepEqual(
      await duplicate.adapter.queryOutcome({
        tenantId,
        effectId: 'effect-1',
        idempotencyKey,
        destination,
        request: { targetRevision: '7' },
      }),
      {
        status: 'UNKNOWN',
        error: {
          code: 'RECONCILE_OUTCOME_NOT_YET_VISIBLE',
          message: 'Remote outcome is not yet provable',
        },
      },
    );
  });

  it('maps unavailable collection queries to UNKNOWN', async () => {
    const missing = fixture({ listStatus: 404 });
    assert.equal(
      (
        await missing.adapter.queryOutcome({
          tenantId,
          effectId: 'effect-1',
          idempotencyKey,
          destination,
          request: { targetRevision: '7' },
        })
      ).status,
      'UNKNOWN',
    );
    for (const status of [409, 429, 500]) {
      const uncertain = fixture({ listStatus: status });
      assert.deepEqual(
        await uncertain.adapter.queryOutcome({
          tenantId,
          effectId: 'effect-1',
          idempotencyKey,
          destination,
          request: { targetRevision: '7' },
        }),
        {
          status: 'UNKNOWN',
          error: {
            code: 'RECONCILE_OUTCOME_NOT_YET_VISIBLE',
            message: 'Remote outcome is not yet provable',
          },
        },
      );
    }
  });

  it('uses the original revision and a separate marker for governed compensation', async () => {
    const { adapter, state } = fixture({
      deployments: [
        {
          name: 'api',
          namespace: 'commander',
          revision: '7',
          annotations: {},
          template: templateV1,
        },
      ],
    });
    const input = {
      tenantId,
      effectId: 'compensation-effect-1',
      originalEffectId: 'effect-1',
      idempotencyKey: 'must-not-be-used-as-marker',
      destination,
      forwardResponse: { deployment: 'api', namespace: 'commander', revision: '9' },
      compensationPatch: { targetRevision: '9', reason: 'restore prior revision' },
      signal: AbortSignal.timeout(10_000),
    };
    await adapter.compensate(input);
    await adapter.compensate(input);

    assert.equal(state.rollbackCount, 1);
    assert.equal(
      state.deployments[0]!.annotations[compensationAnnotation],
      compensationIdempotencyKey('effect-1', adapter.descriptor.adapterVersion),
    );
    assert.notEqual(
      state.deployments[0]!.annotations[compensationAnnotation],
      commanderActionMarker(tenantId, idempotencyKey),
    );
  });

  it('denies missing original revision and mutated compensation patches', async () => {
    const { adapter } = fixture();
    const base = {
      tenantId,
      effectId: 'compensation-effect-1',
      originalEffectId: 'effect-1',
      idempotencyKey: 'cmp-key',
      destination,
      forwardResponse: { deployment: 'api', namespace: 'commander', revision: '9' },
      compensationPatch: { targetRevision: '9', reason: 'restore prior revision' },
      signal: AbortSignal.timeout(10_000),
    };
    await assert.rejects(
      () => adapter.compensate({ ...base, forwardResponse: {} }),
      /Missing original revision/,
    );
    await assert.rejects(
      () =>
        adapter.compensate({
          ...base,
          compensationPatch: { ...base.compensationPatch, image: 'attacker/image' },
        }),
      /compensationPatch.*denied/,
    );
    await assert.rejects(
      () =>
        adapter.compensate({
          ...base,
          compensationPatch: { targetRevision: '8', reason: 'mutate target' },
        }),
      /targetRevision.*original revision/,
    );
  });

  it('queries uncertain compensation before any second write', async () => {
    const { adapter, state } = fixture({
      deployments: [
        {
          name: 'api',
          namespace: 'commander',
          revision: '7',
          annotations: {},
          template: templateV1,
        },
      ],
      timeoutAfterRollback: true,
    });
    const input = {
      tenantId,
      effectId: 'compensation-effect-1',
      originalEffectId: 'effect-1',
      idempotencyKey: 'cmp-key',
      destination,
      forwardResponse: { deployment: 'api', namespace: 'commander', revision: '9' },
      compensationPatch: { targetRevision: '9', reason: 'restore prior revision' },
      signal: AbortSignal.timeout(10_000),
    };
    await assert.rejects(
      () => adapter.compensate(input),
      (error: unknown) => {
        assert.ok(error instanceof AdapterExecutionError);
        assert.equal(error.commitState, 'UNKNOWN');
        assert.equal(error.retryMode, 'QUERY_FIRST');
        return true;
      },
    );
    const outcome = await adapter.queryCompensationOutcome({
      tenantId,
      effectId: 'compensation-effect-1',
      idempotencyKey: 'cmp-key',
      destination,
      request: {
        originalEffectId: 'effect-1',
        forwardResponse: input.forwardResponse,
        compensationPatch: input.compensationPatch,
      },
    });
    assert.equal(outcome.status, 'APPLIED');
    await adapter.compensate(input);
    assert.equal(state.rollbackCount, 1);
  });

  it('returns UNKNOWN when a compensation marker is absent', async () => {
    const { adapter } = fixture();
    assert.deepEqual(
      await adapter.queryCompensationOutcome({
        tenantId,
        effectId: 'compensation-effect-1',
        idempotencyKey: 'cmp-key',
        destination,
        request: {
          originalEffectId: 'effect-1',
          forwardResponse: { revision: '9' },
          compensationPatch: { targetRevision: '9', reason: 'restore prior revision' },
        },
      }),
      {
        status: 'UNKNOWN',
        error: {
          code: 'RECONCILE_OUTCOME_NOT_YET_VISIBLE',
          message: 'Remote outcome is not yet provable',
        },
      },
    );
  });
});
