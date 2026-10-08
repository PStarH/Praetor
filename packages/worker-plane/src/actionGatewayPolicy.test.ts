import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { ActionAdapterRegistry, type ActionAdapter } from '@praetor/action-adapters';
import {
  GITHUB_PULL_REQUEST_CREATE_DESCRIPTOR,
  SERVICENOW_INCIDENT_CREATE_DESCRIPTOR,
  evaluateActionGatewayPolicy,
  KUBERNETES_DEPLOYMENT_ROLLBACK_DESCRIPTOR,
} from '@praetor/contracts';
import { InMemoryKernelRepository } from '@praetor/kernel/testing/inMemoryRepository';
import { createWorkerPolicyEvaluator, evaluateActionGatewayMvpV1 } from './bootstrap.js';

const canonical = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
    .join(',')}}`;
};

const digest = (value: Record<string, unknown>): string =>
  createHash('sha256').update(canonical(value)).digest('hex');

type ActionEnvelopeFixture = {
  tenantId: string;
  source: string;
  package: string;
  model: string;
  tool: string;
  destination: string;
  effectType: string;
  args: Record<string, string>;
  idempotencyKey: string;
};

const envelope: ActionEnvelopeFixture = {
  tenantId: 'tenant-a',
  source: 'test-agent',
  package: 'test-package',
  model: 'test-model',
  tool: 'ticket.create',
  destination: 'demo://tickets',
  effectType: 'demo.ticket.create',
  args: { title: 'Reset a demo password' },
  idempotencyKey: 'action-key-0001',
};

function adapter(descriptor: ActionAdapter['descriptor']): ActionAdapter {
  return {
    descriptor,
    async execute() {
      return {};
    },
    async queryOutcome() {
      return { status: 'UNKNOWN', error: { code: 'NOT_QUERIED', message: 'not queried' } };
    },
    async compensate() {
      return {};
    },
    async queryCompensationOutcome() {
      return { status: 'UNKNOWN', error: { code: 'NOT_QUERIED', message: 'not queried' } };
    },
  };
}

const kubernetesRegistry = new ActionAdapterRegistry([
  adapter(KUBERNETES_DEPLOYMENT_ROLLBACK_DESCRIPTOR),
]);

async function createActionRun(
  repository: InMemoryKernelRepository,
  options: {
    runId?: string;
    tenantId?: string;
    effect?: 'allow' | 'deny' | 'require_approval';
    destination?: string;
    actionDigest?: string;
    decisionId?: string;
    metadataEffectId?: string;
    metadataPolicySnapshotId?: string;
    runPolicySnapshotId?: string;
    simulationId?: string;
    simulationActionDigest?: string;
    simulationDecisionId?: string;
    effectType?: string;
    tool?: string;
    envelope?: ActionEnvelopeFixture;
  } = {},
) {
  const baseEnvelope = options.envelope ?? envelope;
  const tenantId = options.tenantId ?? baseEnvelope.tenantId;
  const runId = options.runId ?? 'run-action';
  const stepId = `${runId}-step`;
  const effectId = `${runId}-effect`;
  const interactionId = `${runId}-interaction`;
  const effect = options.effect ?? 'allow';
  const destination =
    options.destination ??
    (options.envelope
      ? baseEnvelope.destination
      : effect === 'require_approval'
        ? 'demo://tickets/approval'
        : effect === 'deny'
          ? 'demo://tickets/denied'
          : baseEnvelope.destination);
  const actionEnvelope = {
    ...baseEnvelope,
    tenantId,
    effectType: options.effectType ?? baseEnvelope.effectType,
    tool: options.tool ?? baseEnvelope.tool,
    destination,
  };
  const actionDigest = options.actionDigest ?? digest(actionEnvelope);
  const policySnapshotId = options.metadataPolicySnapshotId ?? 'action-gateway-mvp-v1';
  const decisionId = options.decisionId ?? `action-gateway-${effect}`;
  const simulationId = options.simulationId ?? `${runId}-simulation`;
  await repository.createRun(
    {
      id: runId,
      tenantId,
      intentHash: 'intent',
      workGraphHash: 'graph',
      workGraphVersion: 'action-gateway/v1',
      policySnapshotId: options.runPolicySnapshotId ?? 'action-gateway-mvp-v1',
      metadata: {
        actionGateway: {
          authority: 'commander.action-gateway/v1',
          stepId,
          effectId: options.metadataEffectId ?? effectId,
          interactionId: effect === 'require_approval' ? interactionId : undefined,
          actionDigest,
          policySnapshotId,
          decision: {
            effect,
            decisionId,
            reason: effect,
            policySnapshotId,
          },
          simulation: {
            simulationId,
            actionDigest: options.simulationActionDigest ?? actionDigest,
            effect,
            decisionId: options.simulationDecisionId ?? decisionId,
            reason: effect,
            policySnapshotId,
          },
          envelope: actionEnvelope,
        },
      },
      steps: [
        {
          id: stepId,
          kind: 'tool',
          initialState: effect === 'require_approval' ? 'WAITING_FOR_HUMAN' : 'PENDING',
          interaction:
            effect === 'require_approval'
              ? { id: interactionId, prompt: 'Approve demo ticket creation?' }
              : undefined,
          input: {
            toolName: actionEnvelope.tool,
            effectType: actionEnvelope.effectType,
            args: actionEnvelope.args,
            actionEnvelope,
            effectId,
            idempotencyKey: actionEnvelope.idempotencyKey,
          },
        },
      ],
    },
    'action-gateway',
  );
  return {
    runId,
    stepId,
    interactionId,
    actionEnvelope,
    actionDigest,
    simulationId,
    policySnapshotId,
  };
}

function evaluate(
  repository: InMemoryKernelRepository,
  input: {
    tenantId: string;
    runId: string;
    stepId: string;
    request?: Record<string, unknown>;
    registry?: ActionAdapterRegistry;
  },
) {
  const request = input.request ?? envelope;
  return createWorkerPolicyEvaluator(repository, input.registry).evaluate({
    tenantId: input.tenantId,
    runId: input.runId,
    stepId: input.stepId,
    type: String(request.effectType ?? envelope.effectType),
    request,
    token: {} as never,
  });
}

describe('L4-01 Action Gateway worker policy', () => {
  it('allows a registered Kubernetes manifest action only after exact bound approval', async () => {
    const kubernetesEnvelope = {
      ...envelope,
      tool: 'kubernetes.deployment.rollback',
      destination: 'k8s://kind/commander/deployments/api',
      effectType: 'connector.kubernetes.deployment.rollback',
      args: { targetRevision: '41', reason: 'campaign-4 test' },
    };
    const repository = new InMemoryKernelRepository();
    const action = await createActionRun(repository, {
      runId: 'run-kubernetes-approval',
      effect: 'require_approval',
      decisionId: 'action-gateway-manifest-require_approval',
      envelope: kubernetesEnvelope,
    });

    assert.equal(
      (
        await evaluate(repository, {
          tenantId: 'tenant-a',
          runId: action.runId,
          stepId: action.stepId,
          request: action.actionEnvelope,
          registry: kubernetesRegistry,
        })
      ).effect,
      'deny',
    );

    await repository.answerInteraction({
      interactionId: action.interactionId,
      runId: action.runId,
      tenantId: 'tenant-a',
      response: {
        approved: true,
        actionDigest: action.actionDigest,
        simulationId: action.simulationId,
        policySnapshotId: action.policySnapshotId,
        reviewer: 'reviewer-a',
        runId: action.runId,
        tenantId: 'tenant-a',
      },
      actor: 'reviewer-a',
    });
    const approved = await evaluate(repository, {
      tenantId: 'tenant-a',
      runId: action.runId,
      stepId: action.stepId,
      request: action.actionEnvelope,
      registry: kubernetesRegistry,
    });
    assert.equal(approved.effect, 'allow');
    assert.equal(approved.decisionId, 'action-gateway-allow-after-approval');

    const crossDestination = await evaluate(repository, {
      tenantId: 'tenant-a',
      runId: action.runId,
      stepId: action.stepId,
      request: {
        ...action.actionEnvelope,
        destination: 'k8s://kind/commander/deployments/other',
      },
      registry: kubernetesRegistry,
    });
    assert.equal(crossDestination.effect, 'deny');
    assert.equal(crossDestination.reason, 'ACTION_DIGEST_MISMATCH');

    for (const [runId, override] of [
      ['run-kubernetes-malformed', { destination: 'k8s://kind/other%2Ftenant/deployments/api' }],
      ['run-kubernetes-wrong-tool', { tool: 'kubernetes.deployment.scale' }],
    ] as const) {
      const rejected = await createActionRun(repository, {
        runId,
        effect: 'require_approval',
        decisionId: 'action-gateway-manifest-require_approval',
        envelope: { ...kubernetesEnvelope, ...override },
      });
      const decision = await evaluate(repository, {
        tenantId: 'tenant-a',
        runId: rejected.runId,
        stepId: rejected.stepId,
        request: rejected.actionEnvelope,
        registry: kubernetesRegistry,
      });
      assert.equal(decision.effect, 'deny', runId);
      assert.equal(decision.reason, 'ACTION_GATEWAY_DECISION_REVALIDATION_FAILED', runId);
    }
  });

  it('revalidates a registered Kubernetes compensation as approval-required', () => {
    const policyInput = {
      ...envelope,
      tool: 'kubernetes.deployment.rollback',
      destination: 'k8s://kind/commander/deployments/api',
      effectType: 'compensate.kubernetes.deployment.rollback',
      args: { targetRevision: '2', reason: 'compensation proof' },
    };
    const decision = evaluateActionGatewayMvpV1(policyInput, kubernetesRegistry);
    assert.deepEqual(decision, {
      effect: 'require_approval',
      decisionId: 'action-gateway-manifest-require_approval',
      reason: "Registered adapter policy requires 'require_approval' for this exact action.",
      policySnapshotId: 'action-gateway-mvp-v1',
    });
  });

  it('preserves registry-aware production admission and Kubernetes destination validation', () => {
    const kubernetes = {
      ...envelope,
      effectType: 'connector.kubernetes.deployment.rollback',
      tool: 'kubernetes.deployment.rollback',
      destination: 'k8s://cluster-1/namespace-1/deployments/api',
    };
    assert.equal(evaluateActionGatewayMvpV1(kubernetes).effect, 'deny');
    assert.equal(
      evaluateActionGatewayMvpV1(kubernetes, kubernetesRegistry).effect,
      'require_approval',
    );
    assert.equal(
      evaluateActionGatewayMvpV1(
        { ...kubernetes, destination: 'k8s://Cluster_1/namespace-1/deployments/api' },
        kubernetesRegistry,
      ).effect,
      'deny',
    );

    assert.equal(evaluateActionGatewayMvpV1(envelope).effect, 'allow');
    assert.equal(
      evaluateActionGatewayMvpV1({ ...envelope, destination: undefined }).reason,
      "Destination 'undefined' is not registered by the Action Gateway.",
    );
  });

  for (const [descriptor, destination] of [
    [GITHUB_PULL_REQUEST_CREATE_DESCRIPTOR, 'github://commander/repository/pulls'],
    [SERVICENOW_INCIDENT_CREATE_DESCRIPTOR, 'servicenow://instance/incident'],
  ] as const) {
    it(`requires durable bound approval before executing ${descriptor.effectType}`, async () => {
      const registry = new ActionAdapterRegistry([adapter(descriptor)]);
      const repository = new InMemoryKernelRepository();
      const action = await createActionRun(repository, {
        effect: 'require_approval',
        decisionId: 'action-gateway-manifest-require_approval',
        envelope: {
          ...envelope,
          effectType: descriptor.effectType,
          tool: descriptor.toolName,
          destination,
        },
      });
      const input = {
        tenantId: 'tenant-a',
        runId: action.runId,
        stepId: action.stepId,
        request: action.actionEnvelope,
        registry,
      };
      assert.equal((await evaluate(repository, input)).effect, 'deny');
      await repository.answerInteraction({
        interactionId: action.interactionId,
        runId: action.runId,
        tenantId: 'tenant-a',
        response: {
          approved: true,
          actionDigest: action.actionDigest,
          simulationId: action.simulationId,
          policySnapshotId: action.policySnapshotId,
          reviewer: 'reviewer-a',
          runId: action.runId,
          tenantId: 'tenant-a',
        },
        actor: 'reviewer-a',
      });
      assert.equal((await evaluate(repository, input)).effect, 'allow');
      assert.equal(
        (
          await evaluate(repository, {
            ...input,
            request: { ...action.actionEnvelope, args: { title: 'tampered' } },
          })
        ).effect,
        'deny',
      );
    });
    for (const effectType of [descriptor.effectType, descriptor.compensationEffectType]) {
      it(`revalidates registered ${effectType} against the shared gateway policy`, () => {
        const registry = new ActionAdapterRegistry([adapter(descriptor)]);
        const input = { ...envelope, effectType, tool: descriptor.toolName, destination };
        const { reasonCode: _reasonCode, ...expected } = evaluateActionGatewayPolicy(input);
        assert.equal(expected.effect, 'require_approval');
        assert.deepEqual(evaluateActionGatewayMvpV1(input, registry), expected);
        assert.equal(evaluateActionGatewayMvpV1(input).effect, 'deny');
        for (const invalid of [
          { ...input, tool: 'unregistered.tool' },
          { ...input, destination: `${destination}/unregistered` },
          { ...input, destination: 'https://unregistered.invalid' },
          { ...input, effectType: 'connector.unregistered.create' },
        ]) {
          assert.equal(evaluateActionGatewayMvpV1(invalid, registry).effect, 'deny');
        }
      });
    }
  }

  it('allows only a trusted persisted Action Gateway envelope', async () => {
    const repository = new InMemoryKernelRepository();
    const action = await createActionRun(repository);
    const decision = await evaluate(repository, {
      tenantId: 'tenant-a',
      runId: action.runId,
      stepId: action.stepId,
      request: action.actionEnvelope,
    });
    assert.equal(decision.effect, 'allow');
    assert.equal(decision.decisionId, 'action-gateway-allow');
    assert.equal(decision.policySnapshotId, 'action-gateway-mvp-v1');
  });

  it('fails closed for missing, forged, cross-tenant, and snapshot-mismatched metadata', async () => {
    const repository = new InMemoryKernelRepository();
    await repository.createRun(
      {
        id: 'run-generic',
        tenantId: 'tenant-a',
        intentHash: 'intent',
        workGraphHash: 'graph',
        workGraphVersion: 'v1',
        policySnapshotId: 'action-gateway-mvp-v1',
        steps: [{ id: 'step-generic', kind: 'tool', input: {} }],
      },
      'generic-gateway',
    );
    const missing = await evaluate(repository, {
      tenantId: 'tenant-a',
      runId: 'run-generic',
      stepId: 'step-generic',
    });
    assert.equal(missing.effect, 'deny');

    const forged = await createActionRun(repository, {
      runId: 'run-forged',
      actionDigest: 'forged-digest',
    });
    assert.equal(
      (
        await evaluate(repository, {
          tenantId: 'tenant-a',
          runId: forged.runId,
          stepId: forged.stepId,
          request: forged.actionEnvelope,
        })
      ).effect,
      'deny',
    );

    const mismatch = await createActionRun(repository, {
      runId: 'run-snapshot-mismatch',
      metadataPolicySnapshotId: 'policy-forged',
    });
    const drifted = await evaluate(repository, {
      tenantId: 'tenant-a',
      runId: mismatch.runId,
      stepId: mismatch.stepId,
      request: mismatch.actionEnvelope,
    });
    assert.equal(drifted.effect, 'deny');
    assert.equal(drifted.reason, 'POLICY_SNAPSHOT_DRIFT');

    const forgedDecision = await createActionRun(repository, {
      runId: 'run-forged-decision',
      decisionId: 'forged-allow',
    });
    assert.equal(
      (
        await evaluate(repository, {
          tenantId: 'tenant-a',
          runId: forgedDecision.runId,
          stepId: forgedDecision.stepId,
          request: forgedDecision.actionEnvelope,
        })
      ).effect,
      'deny',
    );

    const forgedEffect = await createActionRun(repository, {
      runId: 'run-forged-effect',
      metadataEffectId: 'effect-not-bound-to-step',
    });
    assert.equal(
      (
        await evaluate(repository, {
          tenantId: 'tenant-a',
          runId: forgedEffect.runId,
          stepId: forgedEffect.stepId,
          request: forgedEffect.actionEnvelope,
        })
      ).effect,
      'deny',
    );

    assert.equal(
      (
        await evaluate(repository, {
          tenantId: 'tenant-b',
          runId: forged.runId,
          stepId: forged.stepId,
          request: forged.actionEnvelope,
        })
      ).effect,
      'deny',
    );
  });

  it('allows approval-required metadata only after a positive bound interaction response', async () => {
    const repository = new InMemoryKernelRepository();
    const action = await createActionRun(repository, {
      runId: 'run-approval',
      effect: 'require_approval',
    });

    assert.equal(
      (
        await evaluate(repository, {
          tenantId: 'tenant-a',
          runId: action.runId,
          stepId: action.stepId,
          request: action.actionEnvelope,
        })
      ).effect,
      'deny',
    );

    await repository.answerInteraction({
      interactionId: action.interactionId,
      runId: action.runId,
      tenantId: 'tenant-a',
      response: {
        approved: true,
        actionDigest: action.actionDigest,
        simulationId: action.simulationId,
        policySnapshotId: action.policySnapshotId,
        reviewer: 'reviewer-a',
        runId: action.runId,
        tenantId: 'tenant-a',
      },
      actor: 'reviewer-a',
    });
    const approved = await evaluate(repository, {
      tenantId: 'tenant-a',
      runId: action.runId,
      stepId: action.stepId,
      request: action.actionEnvelope,
    });
    assert.equal(approved.effect, 'allow');
    assert.equal(approved.decisionId, 'action-gateway-allow-after-approval');
  });

  it('rejects exact execution argument mutation with ACTION_DIGEST_MISMATCH', async () => {
    const repository = new InMemoryKernelRepository();
    const action = await createActionRun(repository, {
      runId: 'run-args-mutated',
    });
    const decision = await evaluate(repository, {
      tenantId: 'tenant-a',
      runId: action.runId,
      stepId: action.stepId,
      request: {
        ...action.actionEnvelope,
        args: { title: 'Mutated after approval' },
      },
    });
    assert.equal(decision.effect, 'deny');
    assert.equal(decision.reason, 'ACTION_DIGEST_MISMATCH');
  });

  it('re-validates action-gateway-mvp-v1 and rejects a forged allow decision', async () => {
    const repository = new InMemoryKernelRepository();
    // Envelope destination is unregistered (evaluateAction → deny), but sealed
    // metadata claims allow — worker must fail closed on revalidation.
    const forged = await createActionRun(repository, {
      runId: 'run-forged-allow-decision',
      effect: 'allow',
      destination: 'demo://tickets/forged',
    });
    const decision = await evaluate(repository, {
      tenantId: 'tenant-a',
      runId: forged.runId,
      stepId: forged.stepId,
      request: forged.actionEnvelope,
    });
    assert.equal(decision.effect, 'deny');
    assert.equal(decision.reason, 'ACTION_GATEWAY_DECISION_REVALIDATION_FAILED');
  });

  it('does not honor post-create mutation of caller-held run metadata clones', async () => {
    const repository = new InMemoryKernelRepository();
    const action = await createActionRun(repository, {
      runId: 'run-metadata-immutable',
      effect: 'deny',
      destination: 'demo://tickets/forged',
    });
    const held = await repository.getRun(action.runId, 'tenant-a');
    assert.ok(held);
    const gateway = held.metadata.actionGateway as {
      decision: { effect: string; decisionId: string; reason: string };
      simulation: { effect: string; decisionId: string; reason: string };
    };
    gateway.decision.effect = 'allow';
    gateway.decision.decisionId = 'action-gateway-allow';
    gateway.decision.reason = 'allow';
    gateway.simulation.effect = 'allow';
    gateway.simulation.decisionId = 'action-gateway-allow';
    gateway.simulation.reason = 'allow';

    const reloaded = await repository.getRun(action.runId, 'tenant-a');
    const persisted = reloaded!.metadata.actionGateway as {
      decision: { effect: string; decisionId: string };
    };
    assert.equal(persisted.decision.effect, 'deny');
    assert.equal(persisted.decision.decisionId, 'action-gateway-deny');

    const decision = await evaluate(repository, {
      tenantId: 'tenant-a',
      runId: action.runId,
      stepId: action.stepId,
      request: action.actionEnvelope,
    });
    assert.equal(decision.effect, 'deny');
  });

  it('rejects a simulation that is not exactly bound to its persisted action', async () => {
    const repository = new InMemoryKernelRepository();
    const action = await createActionRun(repository, {
      runId: 'run-simulation-mismatch',
      simulationActionDigest: 'f'.repeat(64),
    });
    const decision = await evaluate(repository, {
      tenantId: 'tenant-a',
      runId: action.runId,
      stepId: action.stepId,
      request: action.actionEnvelope,
    });
    assert.equal(decision.effect, 'deny');
    assert.equal(decision.reason, 'SIMULATION_MISMATCH');
  });

  it('rejects an approval whose digest, simulation, snapshot, or reviewer binding is invalid', async () => {
    for (const [name, override] of [
      ['digest', { actionDigest: 'f'.repeat(64) }],
      ['simulation', { simulationId: 'simulation-from-another-action' }],
      ['snapshot', { policySnapshotId: 'policy-from-another-action' }],
      ['reviewer', { reviewer: '' }],
    ] as const) {
      const repository = new InMemoryKernelRepository();
      const action = await createActionRun(repository, {
        runId: `run-approval-binding-${name}`,
        effect: 'require_approval',
      });
      const approvalResponse = {
        approved: true,
        actionDigest: action.actionDigest,
        simulationId: action.simulationId,
        policySnapshotId: action.policySnapshotId,
        reviewer: 'reviewer-a',
        runId: action.runId,
        tenantId: 'tenant-a',
      };
      await repository.answerInteraction({
        interactionId: action.interactionId,
        runId: action.runId,
        tenantId: 'tenant-a',
        response: { ...approvalResponse, ...override },
        actor: 'reviewer-a',
      });
      const decision = await evaluate(repository, {
        tenantId: 'tenant-a',
        runId: action.runId,
        stepId: action.stepId,
        request: action.actionEnvelope,
      });
      assert.equal(decision.effect, 'deny', name);
      assert.equal(decision.reason, 'APPROVAL_BINDING_MISMATCH', name);
    }
  });

  it('rejects replay of an approval from another run or tenant', async () => {
    const repository = new InMemoryKernelRepository();
    const source = await createActionRun(repository, {
      runId: 'run-approval-source',
      effect: 'require_approval',
    });
    const sourceApproval = {
      approved: true,
      actionDigest: source.actionDigest,
      simulationId: source.simulationId,
      policySnapshotId: source.policySnapshotId,
      reviewer: 'reviewer-a',
      runId: source.runId,
      tenantId: 'tenant-a',
    };

    const crossRun = await createActionRun(repository, {
      runId: 'run-approval-cross-run',
      effect: 'require_approval',
      simulationId: source.simulationId,
    });
    await repository.answerInteraction({
      interactionId: crossRun.interactionId,
      runId: crossRun.runId,
      tenantId: 'tenant-a',
      response: sourceApproval,
      actor: 'reviewer-a',
    });
    const crossRunDecision = await evaluate(repository, {
      tenantId: 'tenant-a',
      runId: crossRun.runId,
      stepId: crossRun.stepId,
      request: crossRun.actionEnvelope,
    });
    assert.equal(crossRunDecision.effect, 'deny');
    assert.equal(crossRunDecision.reason, 'APPROVAL_BINDING_MISMATCH');

    const crossTenant = await createActionRun(repository, {
      runId: 'run-approval-cross-tenant',
      tenantId: 'tenant-b',
      effect: 'require_approval',
    });
    await repository.answerInteraction({
      interactionId: crossTenant.interactionId,
      runId: crossTenant.runId,
      tenantId: 'tenant-b',
      response: sourceApproval,
      actor: 'reviewer-a',
    });
    const crossTenantDecision = await evaluate(repository, {
      tenantId: 'tenant-b',
      runId: crossTenant.runId,
      stepId: crossTenant.stepId,
      request: crossTenant.actionEnvelope,
    });
    assert.equal(crossTenantDecision.effect, 'deny');
    assert.equal(crossTenantDecision.reason, 'APPROVAL_BINDING_MISMATCH');
  });

  it('never allows a rejected interaction or a persisted deny decision', async () => {
    const repository = new InMemoryKernelRepository();
    const rejected = await createActionRun(repository, {
      runId: 'run-rejected',
      effect: 'require_approval',
    });
    await repository.answerInteraction({
      interactionId: rejected.interactionId,
      runId: rejected.runId,
      tenantId: 'tenant-a',
      response: { approved: false, reviewer: 'reviewer-a' },
      actor: 'reviewer-a',
    });
    assert.equal(
      (
        await evaluate(repository, {
          tenantId: 'tenant-a',
          runId: rejected.runId,
          stepId: rejected.stepId,
          request: rejected.actionEnvelope,
        })
      ).effect,
      'deny',
    );

    const denied = await createActionRun(repository, {
      runId: 'run-denied',
      effect: 'deny',
    });
    assert.equal(
      (
        await evaluate(repository, {
          tenantId: 'tenant-a',
          runId: denied.runId,
          stepId: denied.stepId,
          request: denied.actionEnvelope,
        })
      ).effect,
      'deny',
    );
  });
});

describe('L4-04 kill switch worker policy', () => {
  it('denies execution when an enabled kill switch matches the persisted envelope', async () => {
    const repository = new InMemoryKernelRepository();
    const action = await createActionRun(repository);
    await repository.putKillSwitch({
      tenantId: 'tenant-a',
      scope: 'tool',
      value: 'ticket.create',
      enabled: true,
      actor: 'ops-a',
    });
    const decision = await evaluate(repository, {
      tenantId: 'tenant-a',
      runId: action.runId,
      stepId: action.stepId,
      request: action.actionEnvelope,
    });
    assert.equal(decision.effect, 'deny');
    assert.equal(decision.reason, 'KILL_SWITCH_ACTIVE');
  });

  it('still denies after approval when kill switch is enabled later', async () => {
    const repository = new InMemoryKernelRepository();
    const action = await createActionRun(repository, {
      runId: 'run-kill-after-approval',
      effect: 'require_approval',
    });
    await repository.answerInteraction({
      interactionId: action.interactionId,
      runId: action.runId,
      tenantId: 'tenant-a',
      response: {
        approved: true,
        actionDigest: action.actionDigest,
        simulationId: action.simulationId,
        policySnapshotId: action.policySnapshotId,
        reviewer: 'reviewer-a',
        runId: action.runId,
        tenantId: 'tenant-a',
      },
      actor: 'reviewer-a',
    });
    await repository.putKillSwitch({
      tenantId: 'tenant-a',
      scope: 'destination',
      value: 'demo://tickets/approval',
      enabled: true,
      actor: 'ops-a',
    });
    const decision = await evaluate(repository, {
      tenantId: 'tenant-a',
      runId: action.runId,
      stepId: action.stepId,
      request: action.actionEnvelope,
    });
    assert.equal(decision.effect, 'deny');
    assert.equal(decision.reason, 'KILL_SWITCH_ACTIVE');
  });

  it('denies when kill-switch lookup fails (fail-closed)', async () => {
    const repository = new InMemoryKernelRepository();
    const action = await createActionRun(repository, { runId: 'run-kill-lookup-fail' });
    const kernel = {
      getRun: (runId: string, tenantId: string) => repository.getRun(runId, tenantId),
      getStep: (stepId: string, tenantId: string) => repository.getStep(stepId, tenantId),
      listInteractions: (runId: string, tenantId: string) =>
        repository.listInteractions(runId, tenantId),
      findMatchingKillSwitch: async () => {
        throw new Error('kill switch store unavailable');
      },
    };
    const decision = await createWorkerPolicyEvaluator(kernel).evaluate({
      tenantId: 'tenant-a',
      runId: action.runId,
      stepId: action.stepId,
      type: 'demo.ticket.create',
      request: action.actionEnvelope,
      token: {} as never,
    });
    assert.equal(decision.effect, 'deny');
    assert.equal(decision.reason, 'KILL_SWITCH_LOOKUP_FAILED');
  });
});
