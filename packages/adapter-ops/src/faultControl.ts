import { createHash } from 'node:crypto';
import {
  AdapterExecutionError,
  canonicalRequestHash,
  type AuditSink,
  type CapabilityTokenPort,
} from '@praetor/effect-broker';

export const FAULT_CONTROL_EFFECT_TYPE = 'fault-control.campaign';
export const DEFAULT_FAULT_CONTROL_TIMEOUT_MS = 30_000;
export const MAX_FAULT_CONTROL_TTL_MS = 5 * 60_000;

export interface FaultControlCommand {
  campaignId: string;
  tenantId: string;
  provider: string;
  destination: string;
  destinationHash: string;
  effectId: string;
  idempotencyKey: string;
  faults: string[];
  audience: string;
  sourceCommit: string;
  imageDigest: string;
  expiresAt: string;
  nonce: string;
  issuer: string;
  keyId: string;
  workerId: string;
  workerGeneration: number;
}

export interface FaultControlRuntime {
  tenantId: string;
  audience: string;
  sourceCommit: string;
  imageDigest: string;
  sourceDirty: boolean;
  allowedDestinations: Array<{ provider: string; destinationHash: string }>;
  allowedFaults: readonly string[];
  workerId: string;
  workerGeneration: number;
}

export interface FaultControlExecutor {
  apply(input: { command: FaultControlCommand; signal: AbortSignal }): Promise<void>;
  cleanup(input: { command: FaultControlCommand }): Promise<void>;
}

export interface KubernetesRollbackPatch {
  tenantId: string;
  effectId: string;
  idempotencyKey: string;
  destination: string;
}

/**
 * One-shot, capability-admitted classifier for a real Kubernetes rollback
 * PATCH. It never performs the PATCH: the production adapter owns that I/O.
 */
export class KubernetesRollbackFaultArm implements FaultControlExecutor {
  private active:
    | {
        command: FaultControlCommand;
        settle: (error?: Error) => void;
      }
    | undefined;

  async apply(input: { command: FaultControlCommand; signal: AbortSignal }): Promise<void> {
    if (this.active) throw new Error('FAULT_CONTROL_ALREADY_ARMED');
    return new Promise<void>((resolve, reject) => {
      const settle = (error?: Error) => {
        if (this.active?.settle !== settle) return;
        this.active = undefined;
        input.signal.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else resolve();
      };
      const onAbort = () => settle(new Error('FAULT_CONTROL_ABORTED'));
      this.active = { command: input.command, settle };
      if (input.signal.aborted) {
        onAbort();
        return;
      }
      input.signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  async cleanup(input: { command: FaultControlCommand }): Promise<void> {
    if (this.active?.command === input.command) {
      this.active.settle(new Error('FAULT_CONTROL_CLEANED'));
    }
  }

  async afterPatchResponse(patch: KubernetesRollbackPatch): Promise<void> {
    const active = this.active;
    if (
      !active ||
      active.command.tenantId !== patch.tenantId ||
      active.command.effectId !== patch.effectId ||
      active.command.idempotencyKey !== patch.idempotencyKey ||
      active.command.destination !== patch.destination
    ) {
      return;
    }
    active.settle();
    throw new AdapterExecutionError('Governed fault injected after Kubernetes rollback PATCH', {
      code: 'GOVERNED_TIMEOUT_AFTER_COMMIT',
      commitState: 'UNKNOWN',
      retryMode: 'QUERY_FIRST',
    });
  }
}

export interface CampaignFaultControlHandlerOptions {
  capability: Pick<CapabilityTokenPort, 'verify'>;
  audit: AuditSink;
  runtime: FaultControlRuntime;
  executor: FaultControlExecutor;
  clock?: () => Date;
}

export type FaultControlResult =
  | { accepted: true }
  | {
      accepted: false;
      code:
        | 'FAULT_CONTROL_CAPABILITY_INVALID'
        | 'FAULT_CONTROL_REQUEST_BINDING_MISMATCH'
        | 'FAULT_CONTROL_RUNTIME_DENIED'
        | 'FAULT_CONTROL_EXECUTION_TIMEOUT'
        | 'FAULT_CONTROL_CAPABILITY_EXPIRED'
        | 'FAULT_CONTROL_EXECUTION_FAILED'
        | 'FAULT_CONTROL_CLEANUP_FAILED';
    };

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function nonEmpty(value: string): boolean {
  return value.trim().length > 0;
}

function commandIsWellFormed(command: FaultControlCommand): boolean {
  const strings = [
    command.campaignId,
    command.tenantId,
    command.provider,
    command.destination,
    command.destinationHash,
    command.effectId,
    command.idempotencyKey,
    command.audience,
    command.sourceCommit,
    command.imageDigest,
    command.expiresAt,
    command.nonce,
    command.issuer,
    command.keyId,
    command.workerId,
  ];
  return (
    strings.every(nonEmpty) &&
    Array.isArray(command.faults) &&
    command.faults.length > 0 &&
    new Set(command.faults).size === command.faults.length &&
    command.faults.every(nonEmpty) &&
    command.destinationHash === sha256(command.destination) &&
    /^sha256:[a-f0-9]{64}$/.test(command.imageDigest) &&
    Number.isFinite(Date.parse(command.expiresAt)) &&
    Number.isInteger(command.workerGeneration) &&
    command.workerGeneration > 0
  );
}

/**
 * Authenticates and bounds a real campaign fault controller.
 *
 * The handler owns admission and cleanup guarantees only. It has no shell,
 * Docker, SQL, or network primitive; the production adapter-ops integration
 * supplies the narrow executor port that realizes an allowed fault.
 */
export class CampaignFaultControlHandler {
  private readonly clock: () => Date;

  constructor(private readonly options: CampaignFaultControlHandlerOptions) {
    this.clock = options.clock ?? (() => new Date());
  }

  async handle(input: {
    token: string;
    command: FaultControlCommand;
    timeoutMs?: number;
  }): Promise<FaultControlResult> {
    const { command } = input;
    if (!commandIsWellFormed(command)) {
      await this.audit(command, 'fault_control.rejected', 'high', {
        code: 'FAULT_CONTROL_RUNTIME_DENIED',
      });
      return { accepted: false, code: 'FAULT_CONTROL_RUNTIME_DENIED' };
    }

    let grant: Awaited<ReturnType<CapabilityTokenPort['verify']>>;
    try {
      grant = await this.options.capability.verify(input.token);
    } catch {
      await this.audit(command, 'fault_control.rejected', 'high', {
        code: 'FAULT_CONTROL_CAPABILITY_INVALID',
      });
      return { accepted: false, code: 'FAULT_CONTROL_CAPABILITY_INVALID' };
    }

    if (
      grant.tenantId !== command.tenantId ||
      grant.runId !== command.campaignId ||
      grant.stepId !== command.effectId ||
      grant.issuer !== command.issuer ||
      grant.audience !== command.audience ||
      grant.keyId !== command.keyId ||
      grant.nonce !== command.nonce ||
      grant.expiresAt !== command.expiresAt ||
      grant.effectTypes.length !== 1 ||
      grant.effectTypes[0] !== FAULT_CONTROL_EFFECT_TYPE ||
      grant.requestHash !== this.requestHash(command)
    ) {
      await this.audit(command, 'fault_control.rejected', 'high', {
        code: 'FAULT_CONTROL_REQUEST_BINDING_MISMATCH',
        capabilityJti: grant.jti,
      });
      return { accepted: false, code: 'FAULT_CONTROL_REQUEST_BINDING_MISMATCH' };
    }
    const capabilityLifetimeMs = Date.parse(command.expiresAt) - Date.parse(grant.issuedAt ?? '');
    if (
      !Number.isFinite(capabilityLifetimeMs) ||
      capabilityLifetimeMs <= 0 ||
      capabilityLifetimeMs > MAX_FAULT_CONTROL_TTL_MS
    ) {
      await this.audit(command, 'fault_control.rejected', 'high', {
        code: 'FAULT_CONTROL_RUNTIME_DENIED',
        capabilityJti: grant.jti,
      });
      return { accepted: false, code: 'FAULT_CONTROL_RUNTIME_DENIED' };
    }
    if (!this.runtimeAllows(command)) {
      await this.audit(command, 'fault_control.rejected', 'high', {
        code: 'FAULT_CONTROL_RUNTIME_DENIED',
      });
      return { accepted: false, code: 'FAULT_CONTROL_RUNTIME_DENIED' };
    }

    const requestedTimeoutMs = input.timeoutMs ?? DEFAULT_FAULT_CONTROL_TIMEOUT_MS;
    if (!Number.isInteger(requestedTimeoutMs) || requestedTimeoutMs <= 0) {
      await this.audit(command, 'fault_control.rejected', 'high', {
        code: 'FAULT_CONTROL_RUNTIME_DENIED',
      });
      return { accepted: false, code: 'FAULT_CONTROL_RUNTIME_DENIED' };
    }
    const remainingCapabilityLifetimeMs = Date.parse(command.expiresAt) - this.clock().getTime();
    if (remainingCapabilityLifetimeMs <= 0) {
      await this.audit(command, 'fault_control.rejected', 'high', {
        code: 'FAULT_CONTROL_CAPABILITY_EXPIRED',
      });
      return { accepted: false, code: 'FAULT_CONTROL_CAPABILITY_EXPIRED' };
    }
    const expiresFirst = remainingCapabilityLifetimeMs <= requestedTimeoutMs;
    const timeoutMs = Math.min(requestedTimeoutMs, remainingCapabilityLifetimeMs);

    await this.audit(command, 'fault_control.accepted', 'medium', { capabilityJti: grant.jti });
    const controller = new AbortController();
    let deadlineReject: ((reason: Error) => void) | undefined;
    const deadline = new Promise<void>((_resolve, reject) => {
      deadlineReject = reject;
    });
    const timeout = setTimeout(() => {
      const code = expiresFirst
        ? 'FAULT_CONTROL_CAPABILITY_EXPIRED'
        : 'FAULT_CONTROL_EXECUTION_TIMEOUT';
      const error = new Error(code);
      controller.abort(error);
      deadlineReject?.(error);
    }, timeoutMs);
    let result: FaultControlResult = { accepted: true };
    try {
      await Promise.race([
        this.options.executor.apply({ command, signal: controller.signal }),
        deadline,
      ]);
      await this.audit(command, 'fault_control.completed', 'medium', { capabilityJti: grant.jti });
    } catch {
      const code = controller.signal.aborted
        ? expiresFirst
          ? 'FAULT_CONTROL_CAPABILITY_EXPIRED'
          : 'FAULT_CONTROL_EXECUTION_TIMEOUT'
        : 'FAULT_CONTROL_EXECUTION_FAILED';
      await this.audit(command, 'fault_control.failed', 'high', { capabilityJti: grant.jti, code });
      result = { accepted: false, code };
    } finally {
      clearTimeout(timeout);
      try {
        await this.options.executor.cleanup({ command });
        await this.audit(command, 'fault_control.cleaned', 'medium', { capabilityJti: grant.jti });
      } catch {
        await this.audit(command, 'fault_control.cleanup_failed', 'critical', {
          capabilityJti: grant.jti,
          code: 'FAULT_CONTROL_CLEANUP_FAILED',
        });
        result = { accepted: false, code: 'FAULT_CONTROL_CLEANUP_FAILED' };
      }
    }
    return result;
  }

  private runtimeAllows(command: FaultControlCommand): boolean {
    return (
      !this.options.runtime.sourceDirty &&
      command.tenantId === this.options.runtime.tenantId &&
      command.audience === this.options.runtime.audience &&
      command.sourceCommit === this.options.runtime.sourceCommit &&
      command.imageDigest === this.options.runtime.imageDigest &&
      command.workerId === this.options.runtime.workerId &&
      command.workerGeneration === this.options.runtime.workerGeneration &&
      this.options.runtime.allowedDestinations.some(
        (destination) =>
          destination.provider === command.provider &&
          destination.destinationHash === command.destinationHash,
      ) &&
      command.faults.every((fault) => this.options.runtime.allowedFaults.includes(fault)) &&
      Date.parse(command.expiresAt) > this.clock().getTime()
    );
  }

  private requestHash(command: FaultControlCommand): string {
    // The issuer and verifier bind the complete submitted command, not a projection.
    return canonicalRequestHash({ ...command });
  }

  private async audit(
    command: FaultControlCommand,
    type: string,
    severity: 'low' | 'medium' | 'high' | 'critical',
    details: Record<string, unknown>,
  ): Promise<void> {
    await this.options.audit.append({
      type,
      severity,
      tenantId: command.tenantId,
      runId: command.campaignId,
      stepId: command.effectId,
      at: this.clock().toISOString(),
      details: {
        cellTenantId: this.options.runtime.tenantId,
        campaignId: command.campaignId,
        provider: command.provider,
        destinationHash: command.destinationHash,
        faults: command.faults,
        sourceCommit: command.sourceCommit,
        imageDigest: command.imageDigest,
        ...details,
      },
    });
  }
}
