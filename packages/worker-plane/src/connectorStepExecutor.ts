/**
 * ConnectorStepExecutor — executes connector steps for external system integration.
 *
 * Connector steps differ from tool steps in that they manage long-lived
 * connections to external systems (e.g., databases, message queues, APIs)
 * and may maintain connection pools, handle reconnection, and manage
 * authentication token refresh.
 *
 * Use cases:
 * - Database queries (read/write to customer databases)
 * - Message queue publish/consume (Kafka, RabbitMQ, SQS)
 * - External API calls with managed auth (OAuth token refresh)
 * - File transfer (SFTP, S3 upload/download)
 *
 * The executor delegates to registered ConnectorHandler implementations.
 */

import type { StepExecutor, ClaimedStep, WorkerRecord } from './types.js';
import { WorkerExecutionError } from './types.js';
import type { ExternalEffectBroker } from './toolStepExecutor.js';
import { deriveEffectIdempotencyKey, type CapabilityTokenIssuer } from '@praetor/effect-broker';
import {
  assertEffectBrokerForProduction,
  isProductionEffectGate,
  mustRouteExternalEffectThroughBroker,
  workerExecutionErrorFromEffectFailure,
} from './effectGate.js';
import type { ToolEffectCatalog } from './toolEffectCatalog.js';
import { DENY_ALL_TOOL_EFFECT_CATALOG } from './toolEffectCatalog.js';
import {
  getStepWorkloadBinding,
  mintStepCapabilityToken,
  requireStepWorkloadBinding,
} from './stepWorkloadIdentity.js';
import { awaitWithAbortTimeout } from './awaitWithAbortTimeout.js';

export interface ConnectorStepInput {
  /** Connector name (e.g., "postgres", "kafka", "s3", "http"). */
  connectorName: string;
  /** Operation to perform. */
  operation: string;
  /** Operation arguments. */
  args: Record<string, unknown>;
  /** Connection configuration (resolved at execution time). */
  connection?: ConnectorConnectionConfig;
  hasExternalEffects?: boolean;
  /** Pure-local connector op (no external IO). Required in production to bypass the broker. */
  localOnly?: boolean;
  effectId?: string;
  idempotencyKey?: string;
  capabilityToken?: string;
  /** Optional timeout override in milliseconds. */
  timeoutMs?: number;
}

export interface ConnectorConnectionConfig {
  /** Connection string or URI. */
  uri?: string;
  /** Authentication method. */
  authMethod?: 'api_key' | 'oauth' | 'basic' | 'none';
  /** Pre-shared key reference (resolved via SecretBroker). */
  secretRef?: string;
  /** Additional connection options. */
  options?: Record<string, unknown>;
}

export interface ConnectorStepOutput {
  result: unknown;
  durationMs: number;
  connectorName: string;
  operation: string;
  bytesTransferred?: number;
}

export interface ConnectorHandler {
  /** Initialize the connection (called once per worker). */
  initialize(config: ConnectorConnectionConfig): Promise<void>;
  /** Execute an operation. */
  execute(
    operation: string,
    args: Record<string, unknown>,
    ctx: { signal: AbortSignal; tenantId: string; runId: string; stepId: string },
  ): Promise<unknown>;
  /** Close the connection (called on worker shutdown). */
  close(): Promise<void>;
}

export interface ConnectorRegistry {
  /** Get a connector handler by name. */
  get(name: string): ConnectorHandler | null;
  /** Register a connector handler. */
  register(name: string, handler: ConnectorHandler): void;
}

export class ConnectorStepExecutor implements StepExecutor {
  private readonly registry: ConnectorRegistry;
  private readonly effectBroker?: ExternalEffectBroker;
  private readonly capabilityIssuer?: CapabilityTokenIssuer;
  private readonly catalog: ToolEffectCatalog;

  constructor(
    registry?: ConnectorRegistry,
    effectBroker?: ExternalEffectBroker,
    capabilityIssuer?: CapabilityTokenIssuer,
    catalog?: ToolEffectCatalog,
  ) {
    assertEffectBrokerForProduction('connector step executor', effectBroker);
    this.registry = registry ?? new DefaultConnectorRegistry();
    this.effectBroker = effectBroker;
    this.capabilityIssuer = capabilityIssuer;
    this.catalog = catalog ?? DENY_ALL_TOOL_EFFECT_CATALOG;
  }

  async execute(
    step: ClaimedStep,
    context: { signal: AbortSignal; worker: WorkerRecord },
  ): Promise<Record<string, unknown> | undefined> {
    const input = step.input as unknown as ConnectorStepInput;

    if (!input.connectorName || typeof input.connectorName !== 'string') {
      throw new WorkerExecutionError('Step ' + step.id + ' missing required field: connectorName', {
        code: 'INVALID_INPUT',
        retryable: false,
      });
    }

    if (!input.operation || typeof input.operation !== 'string') {
      throw new WorkerExecutionError('Step ' + step.id + ' missing required field: operation', {
        code: 'INVALID_INPUT',
        retryable: false,
      });
    }

    if (
      mustRouteExternalEffectThroughBroker(input, {
        brokerPresent: this.effectBroker != null,
        connectorName: input.connectorName,
        catalog: this.catalog,
        hasConnection: input.connection != null,
      })
    ) {
      if (!this.effectBroker) {
        throw new WorkerExecutionError('External connector execution requires an Effect Broker', {
          code: 'EFFECT_BROKER_UNAVAILABLE',
          retryable: false,
        });
      }
      if (!step.lease || !input.effectId) {
        throw new WorkerExecutionError(
          'External connector execution requires effectId and a live step lease',
          { code: 'EFFECT_AUTHORIZATION_REQUIRED', retryable: false },
        );
      }
      const request = input.args ?? {};
      const effectType = input.connectorName + '.' + input.operation;
      const idempotencyKey = deriveEffectIdempotencyKey({
        tenantId: step.tenantId,
        runId: step.runId,
        stepId: step.id,
        effectId: input.effectId,
        request,
      });
      let capabilityToken = input.capabilityToken;
      // WP-09: use the shared production gate. A locally re-derived predicate that
      // omitted COMMANDER_REQUIRE_EFFECT_BROKER let a deployment which had turned
      // the broker gate on fall back to the step's caller-supplied capability
      // token instead of demanding the step-bound mint.
      const production = isProductionEffectGate();
      let workloadBinding = getStepWorkloadBinding();
      if (this.capabilityIssuer) {
        workloadBinding = requireStepWorkloadBinding();
        capabilityToken = mintStepCapabilityToken({
          issuer: this.capabilityIssuer,
          effectType,
          request,
        });
      } else if (production) {
        throw new WorkerExecutionError(
          'External connector execution requires CapabilityTokenIssuer for step-bound mint in production',
          { code: 'EFFECT_CAPABILITY_ISSUER_REQUIRED', retryable: false },
        );
      }
      if (!capabilityToken) {
        throw new WorkerExecutionError(
          'External connector execution requires capabilityToken or capabilityIssuer',
          { code: 'EFFECT_AUTHORIZATION_REQUIRED', retryable: false },
        );
      }
      try {
        const result = await this.effectBroker.execute({
          effectId: input.effectId,
          token: capabilityToken,
          type: effectType,
          request,
          idempotencyKey,
          lease: step.lease,
          actor: context.worker.id,
          timeoutMs: input.timeoutMs,
          workloadBinding,
        });
        return {
          result: result.response,
          effectId: result.effectId,
          replayed: result.replayed,
          connectorName: input.connectorName,
          operation: input.operation,
        };
      } catch (error) {
        throw workerExecutionErrorFromEffectFailure(error, {
          connectorName: input.connectorName,
          operation: input.operation,
          stepId: step.id,
        });
      }
    }

    const handler = this.registry.get(input.connectorName);
    if (!handler) {
      throw new WorkerExecutionError(
        "Connector '" + input.connectorName + "' not found in registry",
        {
          code: 'CONNECTOR_NOT_FOUND',
          retryable: false,
        },
      );
    }

    // Initialize connection if config is provided
    if (input.connection) {
      await handler.initialize(input.connection);
    }

    const started = Date.now();
    const timeoutMs = input.timeoutMs ?? 60_000;

    try {
      const result = await awaitWithAbortTimeout(
        (signal) =>
          handler.execute(input.operation, input.args ?? {}, {
            signal,
            tenantId: step.tenantId,
            runId: step.runId,
            stepId: step.id,
          }),
        {
          parentSignal: context.signal,
          timeoutMs,
          timeoutError: (cooperative) =>
            new WorkerExecutionError(
              "Connector '" +
                input.connectorName +
                "' operation '" +
                input.operation +
                "' timed out after " +
                timeoutMs +
                'ms',
              {
                code: 'TIMEOUT',
                // cancel/timeout 已胜出：retryable 恒 false（堵 microtask dual-dispatch）；
                // cooperative 仅遥测（同步窗内 abort-linked），不驱动 retry。对齐 #74。
                retryable: false,
                details: {
                  connectorName: input.connectorName,
                  operation: input.operation,
                  stepId: step.id,
                  cooperative,
                },
              },
            ),
          abortError: (cooperative) =>
            new WorkerExecutionError('Connector execution aborted', {
              code: 'ABORTED',
              // 同上：abort 胜出后非 retryable；cooperative 仅遥测。
              retryable: false,
              details: {
                connectorName: input.connectorName,
                operation: input.operation,
                stepId: step.id,
                cooperative,
              },
            }),
        },
      );

      const output: ConnectorStepOutput = {
        result,
        durationMs: Date.now() - started,
        connectorName: input.connectorName,
        operation: input.operation,
      };
      return output as unknown as Record<string, unknown>;
    } catch (error) {
      if (error instanceof WorkerExecutionError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new WorkerExecutionError(message, {
        code: 'CONNECTOR_EXECUTION_FAILED',
        retryable: this.isRetryable(error),
        retryDelayMs: 10_000,
        details: {
          connectorName: input.connectorName,
          operation: input.operation,
          stepId: step.id,
        },
      });
    }
  }

  private isRetryable(error: unknown): boolean {
    if (error instanceof Error) {
      const msg = error.message.toLowerCase();
      if (msg.includes('timeout') || msg.includes('etimedout') || msg.includes('econnreset'))
        return true;
      if (msg.includes('rate limit') || msg.includes('429') || msg.includes('503')) return true;
      if (msg.includes('connection') && (msg.includes('refused') || msg.includes('reset')))
        return true;
    }
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Default registry implementation
// ──────────────────────────────────────────────────────────────────────────

class DefaultConnectorRegistry implements ConnectorRegistry {
  private readonly handlers: Record<string, ConnectorHandler> = {};

  get(name: string): ConnectorHandler | null {
    return this.handlers[name] ?? null;
  }

  register(name: string, handler: ConnectorHandler): void {
    this.handlers[name] = handler;
  }
}
