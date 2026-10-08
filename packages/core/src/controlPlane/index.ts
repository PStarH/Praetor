/**
 * Control plane facade — Architecture V2.
 *
 * Identity, tenancy, policy PDP, and audit sink entry points.
 * Implementations currently delegate to existing core modules; shared values
 * crossing a package boundary belong to @praetor/contracts.
 */

import { getSideEffectGate, type SideEffectGate } from '../runtime/sideEffectGate';
import { getExecutionScheduler } from '../atr/scheduler';
import { getGlobalTenantProvider } from '../runtime/tenantProvider';
import { getSecurityAuditLogger } from '../security/securityAuditLogger';
import { createHash, randomUUID } from 'node:crypto';

import type { WorkloadIdentity } from '@praetor/contracts';
export type { WorkloadIdentity } from '@praetor/contracts';

export interface ControlPlaneConfig {
  defaultScopes?: string[];
  tokenTtlSeconds?: number;
  /** TTL for step-scoped workload identities (default 300s). */
  stepTokenTtlSeconds?: number;
}

export class ControlPlane {
  private readonly defaultScopes: string[];
  private readonly tokenTtlSeconds: number;
  private readonly stepTokenTtlSeconds: number;
  private readonly identities = new Map<string, WorkloadIdentity>();
  private readonly identitiesByToken = new Map<string, WorkloadIdentity>();

  constructor(config: ControlPlaneConfig = {}) {
    this.defaultScopes = config.defaultScopes ?? ['agent.execute', 'tool.invoke'];
    this.tokenTtlSeconds = config.tokenTtlSeconds ?? 3600;
    this.stepTokenTtlSeconds = config.stepTokenTtlSeconds ?? 300;
  }

  /** Issue a workload identity for an agent run. */
  issueIdentity(input: {
    tenantId: string;
    userId?: string;
    scopes?: string[];
    workloadId?: string;
  }): WorkloadIdentity {
    return this.storeIdentity({
      tenantId: input.tenantId,
      userId: input.userId,
      scopes: input.scopes,
      workloadId: input.workloadId,
      ttlSeconds: this.tokenTtlSeconds,
    });
  }

  /** Issue a short-lived identity bound to a claimed kernel step. */
  issueStepIdentity(input: {
    tenantId: string;
    runId: string;
    stepId: string;
    userId?: string;
    scopes?: string[];
    workloadId?: string;
  }): WorkloadIdentity {
    return this.storeIdentity({
      tenantId: input.tenantId,
      runId: input.runId,
      stepId: input.stepId,
      userId: input.userId,
      scopes: input.scopes,
      workloadId:
        input.workloadId ?? `wl_${input.runId}_${input.stepId}_${randomUUID().slice(0, 8)}`,
      ttlSeconds: this.stepTokenTtlSeconds,
    });
  }

  getIdentity(workloadId: string): WorkloadIdentity | undefined {
    const id = this.identities.get(workloadId);
    if (!id) return undefined;
    if (this.isExpired(id)) {
      this.dropIdentity(id);
      return undefined;
    }
    return id;
  }

  verifyIdentityByToken(token: string): WorkloadIdentity | undefined {
    const id = this.identitiesByToken.get(token);
    if (!id) return undefined;
    if (this.isExpired(id)) {
      this.dropIdentity(id);
      return undefined;
    }
    return id;
  }

  private storeIdentity(input: {
    tenantId: string;
    runId?: string;
    stepId?: string;
    userId?: string;
    scopes?: string[];
    workloadId?: string;
    ttlSeconds: number;
  }): WorkloadIdentity {
    const now = Date.now();
    const workloadId = input.workloadId ?? `wl_${randomUUID()}`;
    const token = createHash('sha256')
      .update(
        `${workloadId}:${input.tenantId}:${input.runId ?? ''}:${input.stepId ?? ''}:${now}:${randomUUID()}`,
      )
      .digest('hex');
    const identity: WorkloadIdentity = {
      workloadId,
      tenantId: input.tenantId,
      runId: input.runId,
      stepId: input.stepId,
      userId: input.userId,
      scopes: input.scopes ?? this.defaultScopes,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + input.ttlSeconds * 1000).toISOString(),
      token,
    };
    this.identities.set(workloadId, identity);
    this.identitiesByToken.set(token, identity);
    this.audit('identity.issued', {
      workloadId,
      tenantId: input.tenantId,
      runId: input.runId,
      stepId: input.stepId,
      scopes: identity.scopes,
    });
    return identity;
  }

  private isExpired(id: WorkloadIdentity): boolean {
    return Date.parse(id.expiresAt) <= Date.now();
  }

  private dropIdentity(id: WorkloadIdentity): void {
    this.identities.delete(id.workloadId);
    this.identitiesByToken.delete(id.token);
  }

  /** Resolve tenant config via existing tenant provider. */
  resolveTenant(tenantId: string) {
    return getGlobalTenantProvider().getTenantConfig(tenantId);
  }

  /** Policy enforcement point — SideEffectGate. */
  policyPep(): SideEffectGate {
    return getSideEffectGate();
  }

  /** Kernel scheduler (data-plane claim surface exposed for control ops). */
  scheduler() {
    return getExecutionScheduler();
  }

  audit(type: string, details: Record<string, unknown>): void {
    try {
      getSecurityAuditLogger().logEvent({
        type: type as never,
        severity: 'low',
        source: 'ControlPlane',
        message: type,
        details,
      });
    } catch {
      /* audit must never break control plane */
    }
  }
}

let controlPlaneSingleton: ControlPlane | null = null;

export function getControlPlane(): ControlPlane {
  if (!controlPlaneSingleton) controlPlaneSingleton = new ControlPlane();
  return controlPlaneSingleton;
}

export function resetControlPlane(): void {
  controlPlaneSingleton = null;
}
