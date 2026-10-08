/**
 * L3-07 / Task 3 — step-scoped workload binding from live claim + worker registration.
 *
 * Tenant/run/step and worker fencing come from the kernel-claimed step lease and
 * the registered WorkerRecord — never ambient env or process-local ControlPlane maps.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { getCapabilityTokenIssuer, getCapabilityTokenVerifier } from '@praetor/core/security';
import {
  canonicalRequestHash,
  isClassAEffectType,
  type CapabilityTokenIssuer,
  type WorkloadBinding,
} from '@praetor/effect-broker';
import type { ClaimedStep, WorkerRecord } from './types.js';

export interface StepWorkloadBinding extends WorkloadBinding {
  workloadId: string;
  workerId: string;
  workerGeneration: number;
}

export interface StepWorkloadContext {
  binding: StepWorkloadBinding;
}

const stepWorkloadStorage = new AsyncLocalStorage<StepWorkloadContext>();

function isProductionProfile(): boolean {
  return (
    process.env.NODE_ENV === 'production' ||
    process.env.COMMANDER_PROFILE === 'enterprise' ||
    process.env.COMMANDER_REQUIRE_WORKLOAD_BINDING === '1'
  );
}

/**
 * Bind ALS to the claimed step + registered worker.
 * Lease workerId/generation must match the live WorkerRecord or fail closed.
 */
export function runWithStepWorkloadIdentity<T>(
  step: ClaimedStep,
  worker: WorkerRecord,
  fn: () => T,
): T {
  const leaseGen = step.lease.workerGeneration;
  if (
    step.lease.workerId !== worker.id ||
    typeof leaseGen !== 'number' ||
    !Number.isFinite(leaseGen) ||
    leaseGen !== worker.generation
  ) {
    throw new Error('WORKLOAD_LEASE_BINDING_MISMATCH');
  }
  const binding: StepWorkloadBinding = {
    tenantId: step.tenantId,
    runId: step.runId,
    stepId: step.id,
    workloadId: `${worker.id}:${worker.generation}`,
    workerId: worker.id,
    workerGeneration: worker.generation,
  };
  return stepWorkloadStorage.run({ binding }, fn);
}

export function getStepWorkloadContext(): StepWorkloadContext | undefined {
  return stepWorkloadStorage.getStore();
}

export function getStepWorkloadBinding(): StepWorkloadBinding | undefined {
  return stepWorkloadStorage.getStore()?.binding;
}

/** Fail-closed when production profile requires step binding but ALS is empty. */
export function requireStepWorkloadBinding(): StepWorkloadBinding {
  const ctx = stepWorkloadStorage.getStore();
  if (!ctx) {
    if (isProductionProfile()) {
      throw new Error(
        'WORKLOAD_IDENTITY_REQUIRED: step-scoped identity missing for effect admission',
      );
    }
    throw new Error('WORKLOAD_IDENTITY_REQUIRED: step-scoped identity missing');
  }
  return ctx.binding;
}

/** Mint a capability grant bound to the active step identity (tenant from binding only). */
export function mintStepCapabilityToken(input: {
  issuer: CapabilityTokenIssuer;
  effectType: string;
  request: Record<string, unknown>;
  ttlMs?: number;
  /** Optional override; Class A defaults to canonicalRequestHash(request). */
  actionDigest?: string;
}): string {
  const binding = requireStepWorkloadBinding();
  const ttlMs = input.ttlMs ?? 5 * 60_000;
  const requestHash = canonicalRequestHash(input.request);
  return input.issuer.issue({
    jti: randomUUID(),
    tenantId: binding.tenantId,
    runId: binding.runId,
    stepId: binding.stepId,
    workloadId: binding.workloadId,
    // Live WorkerRecord / ALS fence — admit must match lease workerId/generation.
    workerId: binding.workerId,
    workerGeneration: binding.workerGeneration,
    effectTypes: [input.effectType],
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    requestHash,
    // Class A admit requires grant.actionDigest — mint must carry it.
    ...(isClassAEffectType(input.effectType)
      ? { actionDigest: input.actionDigest ?? requestHash }
      : input.actionDigest
        ? { actionDigest: input.actionDigest }
        : {}),
  });
}

/** HMAC tool token for the local registry path. Issued by the core singleton. */
export function issueLocalToolCapabilityToken(input: { toolName: string; aud: string }): string {
  return getCapabilityTokenIssuer().issue({
    sub: 'worker-1',
    aud: input.aud,
    tools: [input.toolName],
    ttlSeconds: 300,
  });
}

/** Fail closed: a local tool runs only when this token authorizes that tool and tenant. */
export function verifyLocalToolCapabilityToken(input: {
  token: string;
  toolName: string;
  args: Record<string, unknown>;
  aud: string;
}): { ok: boolean; reason?: string } {
  const verdict = getCapabilityTokenVerifier().verify(input.token, {
    tool: input.toolName,
    args: input.args,
    consumeReplay: false,
    aud: input.aud,
  });
  return verdict.ok ? { ok: true } : { ok: false, reason: verdict.reason };
}
