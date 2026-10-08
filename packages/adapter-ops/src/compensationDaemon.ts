import {
  consumeCompensationBatch,
  KERNEL_COMPENSATION_TOPIC,
  type CompensationOutboxPort,
  type CompensationTokenProvider,
  type KernelEffect,
} from '@praetor/kernel';
import {
  buildTerminalEvidenceRecordFromKernel,
  type EffectBroker,
  type EvidenceSigner,
} from '@praetor/effect-broker';
import type { ActionAdapterRegistry } from '@praetor/action-adapters';
import {
  opsLoopErrorCode,
  opsLoopErrorMessage,
  type OpsLoopTelemetryEvent,
  type OpsLoopHealth,
} from './reconciliationDaemon.js';

export interface CompensationTickStats {
  consumed: number;
  succeeded: number;
  handedOff: number;
  escalated: number;
  replayed: number;
}

const EMPTY_COMPENSATION_STATS: CompensationTickStats = {
  consumed: 0,
  succeeded: 0,
  handedOff: 0,
  escalated: 0,
  replayed: 0,
};

export interface CompensationDaemonOptions {
  repository: CompensationOutboxPort;
  terminalEvidenceContext?: {
    getTerminalEvidenceContext(
      effectId: string,
      runId: string,
      tenantId: string,
      claimToken: string,
    ): Promise<
      Awaited<
        ReturnType<
          NonNullable<
            import('@praetor/effect-broker').EffectKernelPort['getTerminalEvidenceContext']
          >
        >
      > & { evidence: import('@praetor/kernel').KernelEvidenceRecord | null }
    >;
  };
  evidenceRepository?: {
    getEvidence(
      runId: string,
      tenantId: string,
    ): Promise<import('@praetor/kernel').KernelEvidenceRecord | null>;
    listEffectsForRun(runId: string, tenantId: string): Promise<KernelEffect[]>;
    listEvents(
      runId: string,
      tenantId: string,
    ): Promise<
      Array<{
        type: string;
        tenantId: string;
        runId: string;
        stepId?: string;
        aggregateId: string;
        occurredAt: string;
        payload: Record<string, unknown>;
      }>
    >;
  };
  broker: EffectBroker;
  registry: ActionAdapterRegistry;
  tokenProvider: CompensationTokenProvider;
  pollIntervalMs: number;
  batchSize?: number;
  workerId: string;
  /** Durable registry generation — must match broker localWorkerGeneration. */
  workerGeneration: number;
  /** Register-time claim secret for worker LOGIN outbox DEFINER RPC. */
  claimSecret: string;
  evidenceSigner?: EvidenceSigner;
  evidenceRetentionMs?: number;
  /** Narrow worker-lifecycle callbacks; wiring binds durable identity/secret arguments. */
  heartbeat?: () => Promise<void>;
  drain?: () => Promise<void>;
  telemetry?: (event: OpsLoopTelemetryEvent) => void;
  /** Immediately revoke/drain durable authority; lifecycle stop happens outside the active tick. */
  onFatalInvariant?: (reason: string) => Promise<void>;
  audit?: {
    append(event: {
      type: string;
      severity: 'low' | 'medium' | 'high' | 'critical';
      tenantId: string;
      runId: string;
      stepId: string;
      at: string;
      details: Record<string, unknown>;
    }): Promise<void>;
  };
}

export class CompensationDaemon {
  private timer: NodeJS.Timeout | null = null;
  private activeTick: Promise<CompensationTickStats> | null = null;
  private lastTickSucceeded = false;
  private readonly healthState: OpsLoopHealth = {
    mode: 'draining',
    running: false,
    inFlight: false,
    claimed: 0,
    completed: 0,
    handedOff: 0,
    escalated: 0,
    rescheduled: 0,
    skippedOverlappingTicks: 0,
  };

  constructor(private readonly options: CompensationDaemonOptions) {}

  start(): void {
    if (this.healthState.running) return;
    this.healthState.running = true;
    this.lastTickSucceeded = false;
    delete this.healthState.lastSucceededAt;
    this.timer = setInterval(() => {
      void this.tick().catch(() => {
        // tick() already records health and telemetry before rejecting.
      });
    }, this.options.pollIntervalMs);
    void this.tick().catch(() => {
      // tick() already records health and telemetry before rejecting.
    });
  }

  async stop(options: { drain?: boolean } = {}): Promise<void> {
    const shouldDrain = this.healthState.running && options.drain !== false;
    this.healthState.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const errors: unknown[] = [];
    try {
      await this.activeTick;
    } catch (error) {
      errors.push(error);
    }
    if (shouldDrain && this.options.drain) {
      try {
        await this.options.drain();
      } catch (error) {
        this.recordFailure(error);
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'compensation daemon stop failed');
  }

  isHealthy(now = Date.now()): boolean {
    if (!this.healthState.running || !this.lastTickSucceeded || !this.healthState.lastSucceededAt) {
      return false;
    }
    return now - Date.parse(this.healthState.lastSucceededAt) <= this.options.pollIntervalMs * 3;
  }

  getHealth(): OpsLoopHealth {
    return { ...this.healthState };
  }

  async tick(): Promise<CompensationTickStats> {
    if (this.activeTick) {
      this.healthState.skippedOverlappingTicks += 1;
      return { ...EMPTY_COMPENSATION_STATS };
    }
    this.healthState.inFlight = true;
    this.healthState.lastStartedAt = new Date().toISOString();
    const activeTick = this.runTick().finally(() => {
      if (this.activeTick === activeTick) {
        this.activeTick = null;
        this.healthState.inFlight = false;
      }
    });
    this.activeTick = activeTick;
    return activeTick;
  }

  private async runTick(): Promise<CompensationTickStats> {
    try {
      const result = await consumeCompensationBatch(
        this.options.repository,
        {
          admit: (input) => this.options.broker.admit(input),
          executeAdmitted: (input) => this.options.broker.executeAdmitted(input),
        },
        this.options.tokenProvider,
        {
          topic: KERNEL_COMPENSATION_TOPIC,
          limit: this.options.batchSize ?? 50,
          workerId: this.options.workerId,
          workerGeneration: this.options.workerGeneration,
          claimSecret: this.options.claimSecret,
          registry: this.options.registry,
          terminalEvidence: (input) => this.buildTerminalEvidence(input),
          onAdapterUnregistered: this.options.audit
            ? async (info) => {
                await this.options.audit!.append({
                  type: 'compensation.adapter_unregistered',
                  severity: 'high',
                  tenantId: info.tenantId,
                  runId: info.runId,
                  stepId: info.stepId,
                  at: new Date().toISOString(),
                  details: {
                    compensationAction: info.compensationAction,
                    outboxMessageId: info.outboxMessageId,
                  },
                });
              }
            : undefined,
        },
      );
      const stats = {
        consumed: result.consumed,
        succeeded: result.succeeded,
        handedOff: result.handedOff,
        escalated: result.escalated,
        replayed: result.replayed,
      };
      this.healthState.claimed += stats.consumed;
      // AO-03: only a terminal success is `completed`. A COMPLETION_UNKNOWN
      // handoff is an undetermined remote outcome, not a success — counting it
      // as completed made an unresolved effect read as done on /health.
      this.healthState.completed += stats.succeeded;
      this.healthState.handedOff += stats.handedOff;
      this.healthState.escalated += stats.escalated;
      await this.options.heartbeat?.();
      this.healthState.lastSucceededAt = new Date().toISOString();
      this.lastTickSucceeded = true;
      return stats;
    } catch (error) {
      this.recordFailure(error);
      if (this.options.onFatalInvariant) {
        try {
          await this.options.onFatalInvariant(opsLoopErrorCode(error));
        } catch (safeStopError) {
          throw new AggregateError(
            [error, safeStopError],
            'compensation tick failed and authority drain was incomplete',
          );
        }
      }
      throw error;
    }
  }

  private async buildTerminalEvidence(input: {
    tenantId: string;
    runId: string;
    effectId: string;
    projectedState: 'COMPLETED' | 'CONFIRMED_NOT_APPLIED' | 'COMPLETION_UNKNOWN';
    response: Record<string, unknown>;
    eventType: string;
    disposition: 'COMPLETED' | 'CONFIRMED_NOT_APPLIED' | 'ESCALATED';
    claimToken: string;
  }): Promise<import('@praetor/kernel').KernelEvidenceRecord> {
    const evidenceRepository = this.options.evidenceRepository;
    if (!evidenceRepository) {
      throw Object.assign(new Error('compensation evidence lifecycle repository is required'), {
        code: 'TERMINAL_EVIDENCE_REQUIRED',
      });
    }
    if (input.projectedState === 'COMPLETED') {
      const existing = this.options.terminalEvidenceContext
        ? (
            await this.options.terminalEvidenceContext.getTerminalEvidenceContext(
              input.effectId,
              input.runId,
              input.tenantId,
              input.claimToken,
            )
          ).evidence
        : await evidenceRepository.getEvidence(input.runId, input.tenantId);
      if (existing?.bundleId === `evidence_${input.effectId}`) return existing;
      throw Object.assign(new Error('completed compensation evidence is missing'), {
        code: 'TERMINAL_EVIDENCE_REQUIRED',
      });
    }
    if (!this.options.evidenceSigner) {
      throw Object.assign(new Error('compensation evidence signer is required'), {
        code: 'EVIDENCE_SIGNING_KEY_REQUIRED',
      });
    }
    const recordedAt = new Date().toISOString();
    const evidence = await buildTerminalEvidenceRecordFromKernel({
      kernel: this.options.terminalEvidenceContext ?? evidenceRepository,
      signer: this.options.evidenceSigner,
      ...input,
      terminalEvent: {
        type: input.eventType,
        severity: 'high',
        details: { disposition: input.disposition },
      },
      recordedAt,
      retentionUntil: new Date(
        Date.parse(recordedAt) + (this.options.evidenceRetentionMs ?? 365 * 24 * 60 * 60 * 1_000),
      ).toISOString(),
      claimToken: input.claimToken,
    });
    return { ...evidence, body: Object.fromEntries(Object.entries(evidence.body)) };
  }

  private recordFailure(error: unknown): void {
    this.lastTickSucceeded = false;
    const at = new Date().toISOString();
    const errorCode = opsLoopErrorCode(error);
    this.healthState.lastFailedAt = at;
    this.healthState.lastErrorCode = errorCode;
    this.options.telemetry?.({
      type: 'ops_loop_tick_failed',
      loop: 'compensation',
      errorCode,
      ...(opsLoopErrorMessage(error) ? { errorMessage: opsLoopErrorMessage(error) } : {}),
      at,
    });
  }
}

export function reverseCompensationEffectIds(effectIds: string[]): string[] {
  return [...effectIds].reverse();
}
