import { EffectBrokerError } from '@praetor/effect-broker';
import { WorkerExecutionError } from './types.js';
/**
 * Production/enterprise EffectBroker requirement gate (WS2 §4 / L3-03a).
 * Shared across agent, tool, and connector step executors.
 */
import type { ToolEffectCatalog } from './toolEffectCatalog.js';
import { DENY_ALL_TOOL_EFFECT_CATALOG } from './toolEffectCatalog.js';

/**
 * Single production-profile predicate for the worker plane.
 *
 * Every profile that means "this is a real deployment" must be listed here, so the
 * agent, tool, connector, LLM and sandbox-readiness gates cannot drift apart. The
 * tool/connector executors previously re-derived this list locally and each copy
 * omitted a different flag; `COMMANDER_REQUIRE_WORKLOAD_BINDING` in particular was
 * lost when the copies were replaced, which re-opened the caller-supplied-token
 * fallback for deployments running only that flag.
 */
export function isProductionEffectGate(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.NODE_ENV === 'production' ||
    env.COMMANDER_PROFILE === 'enterprise' ||
    env.COMMANDER_REQUIRE_EFFECT_BROKER === '1' ||
    env.COMMANDER_REQUIRE_WORKLOAD_BINDING === '1'
  );
}

export function assertEffectBrokerForProduction(component: string, broker: unknown): void {
  if (isProductionEffectGate() && !broker) {
    throw new Error(
      `EFFECT_BROKER_UNAVAILABLE: ${component} requires EffectBroker in production/enterprise (WS2 §1 / L3-03a)`,
    );
  }
}

export interface EffectRoutingContext {
  brokerPresent?: boolean;
  toolName?: string;
  connectorName?: string;
  catalog?: ToolEffectCatalog;
  /** Connector step supplied connection config — forbids localOnly registry bypass in prod. */
  hasConnection?: boolean;
}

/**
 * Whether step input `localOnly: true` is authorized to bypass EffectBroker.
 *
 * - Production: catalog must list the tool/connector (fail-closed if missing).
 * - Dev/test: step claim alone suffices (L3-03a ergonomics).
 */
export function isCatalogAuthorizedLocalOnly(
  input: { localOnly?: boolean },
  ctx: Pick<EffectRoutingContext, 'toolName' | 'connectorName' | 'catalog'>,
): boolean {
  if (input.localOnly !== true) return false;
  if (!isProductionEffectGate()) return true;

  const catalog = ctx.catalog ?? DENY_ALL_TOOL_EFFECT_CATALOG;
  if (ctx.toolName) return catalog.isLocalOnlyTool(ctx.toolName);
  if (ctx.connectorName) return catalog.isLocalOnlyConnector(ctx.connectorName);
  return false;
}

/**
 * Fail-closed routing for tool/connector steps.
 *
 * - Explicit `hasExternalEffects: true` always requires broker mediation.
 * - `localOnly: true` may use the registry only when catalog-authoritative
 *   (L3-03b); forged step-input localOnly in production routes via broker.
 * - Production connector steps with `connection` cannot use localOnly bypass.
 * - Otherwise: production/enterprise gate OR a wired broker → mediate.
 */
export function mustRouteExternalEffectThroughBroker(
  input: {
    hasExternalEffects?: boolean;
    localOnly?: boolean;
  },
  options?: EffectRoutingContext,
): boolean {
  if (input.hasExternalEffects === true) return true;

  if (isProductionEffectGate() && options?.hasConnection === true) {
    return true;
  }

  if (
    isCatalogAuthorizedLocalOnly(input, {
      toolName: options?.toolName,
      connectorName: options?.connectorName,
      catalog: options?.catalog,
    })
  ) {
    return false;
  }

  if (isProductionEffectGate() || options?.brokerPresent === true) return true;
  return false;
}

/** Fail-closed lease shape before EffectBroker.admit (kernel fencing). */
export function assertEffectBrokerLease(
  lease: {
    workerId: string;
    workerGeneration?: number;
    token: string;
    fencingEpoch: number;
  },
  options?: { requireGeneration?: boolean },
): void {
  if (typeof lease.token !== 'string' || lease.token.length === 0) {
    throw new WorkerExecutionError('Effect admission requires lease token', {
      code: 'EFFECT_AUTHORIZATION_REQUIRED',
      retryable: false,
    });
  }
  if (!Number.isFinite(lease.fencingEpoch) || lease.fencingEpoch < 0) {
    throw new WorkerExecutionError('Effect admission requires valid fencingEpoch', {
      code: 'EFFECT_AUTHORIZATION_REQUIRED',
      retryable: false,
    });
  }
  if (options?.requireGeneration && lease.workerGeneration === undefined) {
    throw new WorkerExecutionError(
      'Effect admission requires lease workerGeneration (kernel fencing)',
      { code: 'EFFECT_AUTHORIZATION_REQUIRED', retryable: false },
    );
  }
}

/**
 * Preserve EffectBrokerError codes (COMPLETION_UNKNOWN, WORKER_AFFINITY_*, …)
 * instead of collapsing everything into EFFECT_EXECUTION_FAILED.
 */
export function workerExecutionErrorFromEffectFailure(
  error: unknown,
  context: { toolName?: string; connectorName?: string; operation?: string; stepId: string },
): WorkerExecutionError {
  if (error instanceof WorkerExecutionError) return error;
  if (error instanceof EffectBrokerError) {
    const retryable =
      error.code === 'EFFECT_IN_FLIGHT' ||
      error.code === 'COMPLETION_UNKNOWN' ||
      error.code === 'WORKER_AFFINITY_MISMATCH';
    return new WorkerExecutionError(error.message, {
      code: error.code,
      retryable,
      details: { ...error.details, ...context },
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new WorkerExecutionError(message, {
    code: 'EFFECT_EXECUTION_FAILED',
    retryable: false,
    details: context,
  });
}
