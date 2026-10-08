import type { EffectOutcomeQuerier } from '@praetor/effect-broker';
import type { ActionAdapterDescriptorV1 } from '@praetor/contracts';
import type {
  ActionAdapter,
  AdapterCredentialProvider,
  KubernetesCredentialProvider,
} from './types.js';
import { createGitHubPullRequestCreateAdapter } from './github/pullRequestCreate.js';
import { createServiceNowIncidentCreateAdapter } from './servicenow/incidentCreate.js';
import { createKubernetesDeploymentRollbackAdapter } from './kubernetes/deploymentRollback.js';

export class ActionAdapterRegistry {
  private readonly adapters: Map<string, ActionAdapter>;

  constructor(adapters: readonly ActionAdapter[]) {
    this.adapters = new Map();
    for (const adapter of adapters) {
      this.register(adapter.descriptor.effectType, adapter);
      this.register(adapter.descriptor.compensationEffectType, adapter);
    }
  }

  // One effect type must route to exactly one adapter. Before this check a later
  // adapter silently overwrote an earlier key, so `resolve()` could return the
  // wrong adapter and `outcomeQuerierFor()` could call its compensation query for
  // a forward effect. Refuse to construct a colliding registry instead.
  private register(effectType: string, adapter: ActionAdapter): void {
    if (this.adapters.has(effectType)) {
      throw new Error(`Duplicate action adapter effect type registration: ${effectType}`);
    }
    this.adapters.set(effectType, adapter);
  }

  static production(
    credentials: AdapterCredentialProvider & KubernetesCredentialProvider,
  ): ActionAdapterRegistry {
    return new ActionAdapterRegistry([
      createGitHubPullRequestCreateAdapter({ credentials }),
      createServiceNowIncidentCreateAdapter({ credentials }),
      createKubernetesDeploymentRollbackAdapter({ credentials }),
    ]);
  }

  static empty(): ActionAdapterRegistry {
    return new ActionAdapterRegistry([]);
  }

  resolve(effectType: string): ActionAdapter | null {
    return this.adapters.get(effectType) ?? null;
  }

  outcomeQuerierFor(effectType: string): EffectOutcomeQuerier | null {
    const adapter = this.resolve(effectType);
    if (!adapter) return null;
    return {
      queryOutcome: async (input) => {
        const queryInput = {
          tenantId: input.tenantId,
          effectId: input.effectId,
          idempotencyKey: input.idempotencyKey,
          destination: String(input.request.destination ?? ''),
          request: input.request,
          signal: input.signal,
        };
        if (effectType === adapter.descriptor.compensationEffectType) {
          return adapter.queryCompensationOutcome(queryInput);
        }
        return adapter.queryOutcome(queryInput);
      },
    };
  }

  listDescriptors(): readonly ActionAdapterDescriptorV1[] {
    const seen = new Set<string>();
    const descriptors: ActionAdapterDescriptorV1[] = [];
    for (const adapter of this.adapters.values()) {
      if (seen.has(adapter.descriptor.adapterId)) continue;
      seen.add(adapter.descriptor.adapterId);
      descriptors.push(adapter.descriptor);
    }
    return descriptors;
  }
}
