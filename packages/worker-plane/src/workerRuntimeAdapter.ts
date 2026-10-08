import { KernelStepExecutor, createAgentRuntimeFactory } from '@praetor/core';
import type { StepExecutor, ClaimedStep, WorkerLease } from './types.js';
import type {
  AgentRuntimeFactoryOptions,
  AgentRuntimeInterface,
  LLMProvider,
} from '@praetor/core';
import type { CapabilityTokenIssuer, EffectBroker } from '@praetor/effect-broker';
import {
  createLlmEffectAuth,
  runWithLlmEffectAuth,
  wrapProviderWithEffectBroker,
  type LlmEffectAuth,
} from './llmBrokerBridge.js';
import { assertEffectBrokerForProduction } from './effectGate.js';

export {
  KernelStepExecutor,
  SandboxManager,
  getControlPlane,
  resetControlPlane,
} from '@praetor/core';
export type { WorkloadIdentity } from '@praetor/core';

export type AgentStepExecutorOptions = AgentRuntimeFactoryOptions & {
  defaultMaxSteps?: number;
  defaultTokenBudget?: number;
  defaultProjectId?: string;
  /**
   * WS2 §1 / §10: unified EffectBroker for external LLM provider calls
   * (`llm.*`). When set, registered providers are wrapped so every `call`
   * goes through `broker.execute`. Production refuses to build an agent
   * executor without a broker + capability issuer.
   */
  effectBroker?: EffectBroker;
  /** Issuer used to mint per-call LLM capability tokens (request-bound). */
  capabilityIssuer?: CapabilityTokenIssuer;
};

function wrapProviders(
  providers: Record<string, LLMProvider> | undefined,
  broker: EffectBroker,
): Record<string, LLMProvider> | undefined {
  if (!providers) return undefined;
  const out: Record<string, LLMProvider> = {};
  for (const [name, provider] of Object.entries(providers)) {
    out[name] = wrapProviderWithEffectBroker(provider, broker);
  }
  return out;
}

/** Ensure late registerProvider calls also go through the broker wrap. */
function withBrokerWrappedRegistration(
  runtime: AgentRuntimeInterface,
  broker: EffectBroker,
): AgentRuntimeInterface {
  const original = runtime.registerProvider.bind(runtime);
  runtime.registerProvider = (name: string, provider: LLMProvider) => {
    original(name, wrapProviderWithEffectBroker(provider, broker));
  };
  return runtime;
}

/**
 * Map claimed step lease → EffectBroker lease fields.
 * Must preserve `workerGeneration` (kernel treats missing as -1 → LEASE_LOST).
 */
export function toLlmBrokerLease(lease: WorkerLease): LlmEffectAuth['lease'] {
  return {
    workerId: lease.workerId,
    workerGeneration: lease.workerGeneration,
    token: lease.token,
    fencingEpoch: lease.fencingEpoch,
  };
}

export function createAgentStepExecutor(options: AgentStepExecutorOptions = {}): StepExecutor {
  assertEffectBrokerForProduction('agent step executor', options.effectBroker);
  // Broker without issuer wraps providers but never injects ALS → every LLM call
  // fails EFFECT_AUTHORIZATION_REQUIRED. Require both whenever broker is set.
  if (options.effectBroker && !options.capabilityIssuer) {
    throw new Error(
      'EFFECT_CAPABILITY_ISSUER_REQUIRED: agent LLM path needs CapabilityTokenIssuer for request-bound mint (WS2 §1)',
    );
  }

  const {
    defaultMaxSteps,
    defaultTokenBudget,
    defaultProjectId,
    effectBroker: broker,
    capabilityIssuer: issuer,
    ...factoryOptions
  } = options;

  const baseFactory = createAgentRuntimeFactory({
    ...factoryOptions,
    providers: broker ? wrapProviders(factoryOptions.providers, broker) : factoryOptions.providers,
  });

  const runtimeFactory = (tenantId: string) => {
    const runtime = baseFactory(tenantId);
    return broker ? withBrokerWrappedRegistration(runtime, broker) : runtime;
  };

  const inner = new KernelStepExecutor(runtimeFactory, {
    defaultMaxSteps,
    defaultTokenBudget,
    defaultProjectId,
  });

  if (!issuer) {
    return inner;
  }

  // Inject call-time mint auth for the duration of each agent step. Identity is
  // read from the step-workload ALS that workerService establishes around this
  // execute call — never from the caller-supplied step object.
  return {
    async execute(step: ClaimedStep, context) {
      const auth = createLlmEffectAuth({
        actor: context.worker.id,
        lease: toLlmBrokerLease(step.lease),
        issuer,
      });
      return runWithLlmEffectAuth(auth, () => inner.execute(step, context));
    },
  };
}

export interface ExecutorManifestEntry {
  kind: string;
  factory: () => StepExecutor | Promise<StepExecutor>;
}

export interface ExecutorManifest {
  entries: ReadonlyMap<string, ExecutorManifestEntry>;
  validate(capabilities: string[]): void;
}

export function createExecutorManifest(
  factories: Record<string, () => StepExecutor | Promise<StepExecutor>>,
): ExecutorManifest {
  const entries = new Map<string, ExecutorManifestEntry>();
  for (const [kind, factory] of Object.entries(factories)) {
    entries.set(kind, { kind, factory });
  }

  return {
    entries,
    validate(capabilities: string[]) {
      const required = capabilities.includes('*') ? Array.from(entries.keys()) : capabilities;
      const missing = required.filter((cap) => !entries.has(cap));
      if (missing.length > 0) {
        throw new Error(`Executor manifest missing required capabilities: ${missing.join(', ')}`);
      }
    },
  };
}
