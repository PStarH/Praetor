/**
 * Production worker bootstrap module.
 *
 * This module is the bridge between the worker-plane's fail-closed `main.ts`
 * entry point and the actual runtime infrastructure (Postgres kernel, AgentRuntime,
 * tool registries). It is loaded via `COMMANDER_WORKER_BOOTSTRAP` env var.
 *
 * Environment variables:
 * - DATABASE_URL: PostgreSQL connection string (required)
 * - COMMANDER_WORKER_ID: Worker instance ID (default: auto-generated)
 * - COMMANDER_WORKER_KIND: Worker type (default: 'agent')
 * - COMMANDER_WORKER_CAPABILITIES: Comma-separated capability list (default: 'agent')
 * - COMMANDER_WORKER_MAX_CONCURRENCY: Max concurrent steps (default: 10)
 * - COMMANDER_WORKER_TENANTS: Comma-separated explicit tenant IDs (required).
 *   '*', missing, empty, and comma-only values fail closed with
 *   WORKER_TENANT_SCOPE_REQUIRED before any database activity.
 * - COMMANDER_WORKER_AUTH_TOKEN: Worker authentication token
 * - COMMANDER_WORKER_AUTH_SUBJECT: Worker identity subject
 * - COMMANDER_WORKER_LEASE_TTL_MS: Step lease TTL (default: 30000)
 * - COMMANDER_WORKER_HEARTBEAT_MS: Heartbeat interval (default: 10000)
 * - COMMANDER_WORKER_POLL_MS: Poll interval (default: 250)
 * - COMMANDER_DEMO_TICKET_ALLOWLIST: Set to `1` to auto-seed demo.ticket.* allowlist
 *   defaults on worker bootstrap (off by default; production stays fail-closed).
 *   llm.* defaults still auto-seed via ensureAllowlistDefault (explicit deny wins).
 */

import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { WorkerService } from './workerService.js';
import { PostgresWorkerRegistry } from './registry.js';
import { ApiKeyWorkerAuthenticator } from './apiKeyAuthenticator.js';
import { ToolStepExecutor } from './toolStepExecutor.js';
import { createDefaultWorkerToolEffectCatalog } from './toolEffectCatalog.js';
import { EvaluatorStepExecutor } from './evaluatorStepExecutor.js';
import { CompositeStepExecutor } from './compositeStepExecutor.js';
import { createAgentStepExecutor, createExecutorManifest } from './workerRuntimeAdapter.js';
import { createProductionWorkerSandboxReadiness } from './sandboxReadiness.js';
import type { WorkerDefinition, WorkerIdentity, WorkerKind, StepExecutor } from './types.js';
import type {
  EffectExecutor,
  PolicyEvaluator,
  AuditSink,
  EffectKernelPort,
  EffectBrokerOptions,
  ConfiguredEvidenceSigner,
} from '@praetor/effect-broker';
import {
  EffectBroker,
  CapabilityTokenIssuer,
  canonicalRequestHash,
  createEvidenceSigner,
} from '@praetor/effect-broker';
import type { KernelInteraction, KernelRun, KernelStep, KernelRepository } from '@praetor/kernel';
import {
  createCapabilityAuthority,
  createVerifiedPostgresPool,
  type CapabilityAuthority,
} from '@praetor/kernel';
import { ACTION_GATEWAY_POLICY_ID, evaluateActionGatewayPolicy } from '@praetor/contracts';
import {
  ActionAdapterRegistry,
  parseKubernetesDeploymentDestination,
} from '@praetor/action-adapters';
import {
  createActionAdapterEffectExecutor,
  createProductionAdapterRegistry,
} from './actionAdapterExecutor.js';
import { InMemoryTicketAdapter } from './ticketAdapter.js';

/** Thrown when a worker is not scoped to an explicit, non-empty tenant list. */
export const WORKER_TENANT_SCOPE_REQUIRED = 'WORKER_TENANT_SCOPE_REQUIRED';

/** Runtime DSN / session uses owner or migration LOGIN — refuse before poll. */
export const OWNER_DATABASE_ROLE_REJECTED = 'OWNER_DATABASE_ROLE_REJECTED';

/** Durable replay/revocation stores missing from authority or kernel repository. */
export const CAPABILITY_DURABLE_STORES_REQUIRED = 'CAPABILITY_DURABLE_STORES_REQUIRED';

export const EVIDENCE_SIGNING_PRIVATE_KEY_PEM_ENV = 'COMMANDER_EVIDENCE_SIGNING_PRIVATE_KEY_PEM';
export const EVIDENCE_SIGNING_KEY_ID_ENV = 'COMMANDER_EVIDENCE_SIGNING_KEY_ID';
export const EVIDENCE_REPOSITORY_REQUIRED = 'EVIDENCE_REPOSITORY_REQUIRED';

export function createWorkerEvidenceSigner(
  env: NodeJS.ProcessEnv = process.env,
): ConfiguredEvidenceSigner | null {
  const privateKeyPem = env[EVIDENCE_SIGNING_PRIVATE_KEY_PEM_ENV]?.trim() ?? '';
  const keyId = env[EVIDENCE_SIGNING_KEY_ID_ENV]?.trim() ?? '';
  const required = env.NODE_ENV === 'production';
  if (!privateKeyPem || !keyId) {
    if (required) throw new Error('EVIDENCE_SIGNING_KEY_REQUIRED');
    return null;
  }
  return createEvidenceSigner({ privateKeyPem, keyId });
}

/** Owner / migration LOGIN role — never accept for worker DATABASE_URL. */
export const OWNER_MIGRATION_DATABASE_ROLES = new Set(['commander_owner']);

/**
 * Resolve the worker's durable tenant scope fail-closed.
 *
 * A worker is a least-privilege runtime (commander_worker role, no BYPASSRLS)
 * and must never be granted database authority through tenant configuration.
 * `*`, missing, empty, and comma-only `COMMANDER_WORKER_TENANTS` all throw
 * `WORKER_TENANT_SCOPE_REQUIRED` BEFORE any Pool/repository/registration/poll.
 * `schedulerMode` is always false; cross-tenant claim authority belongs to the
 * kernel-ops scheduler entrypoint, not to workers.
 */
export function resolveWorkerTenantScope(env: NodeJS.ProcessEnv = process.env): {
  tenantIds: string[];
  schedulerMode: false;
} {
  const tenantIds = (env.COMMANDER_WORKER_TENANTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (tenantIds.length === 0 || tenantIds.includes('*')) {
    throw new Error(
      `${WORKER_TENANT_SCOPE_REQUIRED}: COMMANDER_WORKER_TENANTS must be a non-empty, explicit ` +
        "tenant list. '*', missing, empty, and comma-only scopes are rejected before any database " +
        'activity; scheduler-mode cross-tenant claims are only available through kernel-ops.',
    );
  }
  return { tenantIds, schedulerMode: false };
}

/** Extract LOGIN username from a postgres DSN userinfo (null if not a postgres URL). */
export function databaseUrlLoginRole(dsn: string): string | null {
  const m = dsn.match(/^(?:postgres|postgresql):\/\/([^:/?@]+)(?::[^@]*)?@/i);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}

/**
 * Reject owner/migration credentials in the connection URL userinfo.
 * Task 1 `worker-url` (`commander_worker`) must pass — no false positive.
 */
export function assertNonOwnerDatabaseUrl(dsn: string): void {
  const role = databaseUrlLoginRole(dsn);
  if (role === null) return;
  if (OWNER_MIGRATION_DATABASE_ROLES.has(role)) {
    throw new Error(
      `${OWNER_DATABASE_ROLE_REJECTED}: DATABASE_URL userinfo role '${role}' is forbidden ` +
        '(owner/migration). Workers must use Task 1 worker-url (commander_worker).',
    );
  }
}

/** Reject post-connect `current_user` matching owner/migration. */
export function assertNonOwnerDatabaseRole(currentUser: string): void {
  const role = currentUser.trim();
  if (OWNER_MIGRATION_DATABASE_ROLES.has(role)) {
    throw new Error(
      `${OWNER_DATABASE_ROLE_REJECTED}: session current_user '${role}' is forbidden ` +
        '(owner/migration). Workers must authenticate as commander_worker.',
    );
  }
}

type CapabilityStoreRepository = {
  consumeCapabilityReplay?: unknown;
  isCapabilityRevoked?: unknown;
  revokeCapability?: unknown;
};

/**
 * Production EffectBroker options require durable replay + revocations from the
 * Task 3 factory (non-optional). Also verifies kernel repository methods exist.
 */
export function assertDurableCapabilityStores(
  capability: Pick<CapabilityAuthority, 'revocations' | 'replayForTenant'>,
  repository: CapabilityStoreRepository,
): void {
  if (!capability.revocations) {
    throw new Error(
      `${CAPABILITY_DURABLE_STORES_REQUIRED}: createCapabilityAuthority did not provide revocations`,
    );
  }
  if (typeof capability.replayForTenant !== 'function') {
    throw new Error(
      `${CAPABILITY_DURABLE_STORES_REQUIRED}: createCapabilityAuthority did not provide replayForTenant`,
    );
  }
  if (
    typeof capability.revocations.isRevoked !== 'function' ||
    typeof capability.revocations.revoke !== 'function'
  ) {
    throw new Error(
      `${CAPABILITY_DURABLE_STORES_REQUIRED}: revocations must expose isRevoked/revoke`,
    );
  }
  const replay = capability.replayForTenant('__assert_durable_probe__');
  if (!replay || typeof replay.consume !== 'function') {
    throw new Error(
      `${CAPABILITY_DURABLE_STORES_REQUIRED}: replayForTenant() must return a store with consume()`,
    );
  }
  if (typeof repository.consumeCapabilityReplay !== 'function') {
    throw new Error(
      `${CAPABILITY_DURABLE_STORES_REQUIRED}: kernel repository missing consumeCapabilityReplay`,
    );
  }
  if (typeof repository.isCapabilityRevoked !== 'function') {
    throw new Error(
      `${CAPABILITY_DURABLE_STORES_REQUIRED}: kernel repository missing isCapabilityRevoked`,
    );
  }
  if (typeof repository.revokeCapability !== 'function') {
    throw new Error(
      `${CAPABILITY_DURABLE_STORES_REQUIRED}: kernel repository missing revokeCapability`,
    );
  }
}

/** Build EffectBroker options with durable replay + revocations (non-optional).
 * Replay is the authority factory (no fixed tenant) — durable consume stays on
 * capability.verifier via grant.tenantId; options only assert wiring presence.
 */
export function productionCapabilityBrokerOptions(
  capability: CapabilityAuthority,
  localWorkerId: string,
  evidenceSigner?: ConfiguredEvidenceSigner,
): EffectBrokerOptions & {
  replay: CapabilityAuthority['replayForTenant'];
  revocations: CapabilityAuthority['revocations'];
  requireDurableCapabilityStores: true;
  requireOperationsReadiness: true;
} {
  return {
    audience: capability.audience,
    requireRequestBinding: true,
    localWorkerId,
    requireDurableCapabilityStores: true,
    requireOperationsReadiness: true,
    replay: (tenantId: string) => capability.replayForTenant(tenantId),
    revocations: capability.revocations,
    evidenceSigner,
  };
}

/** WP-05: hooks the entrypoint supplies to the worker it loads. */
export interface WorkerBootstrapOptions {
  /** Claim-loop liveness signal (readiness) forwarded to WorkerService. */
  onClaimLoopHealth?: (healthy: boolean) => void;
}

export async function createWorkerService(
  options: WorkerBootstrapOptions = {},
): Promise<WorkerService> {
  // Fail-closed BEFORE sandbox readiness, DB connect, registration, or polling:
  // a worker without an explicit tenant scope must not start.
  const { tenantIds, schedulerMode } = resolveWorkerTenantScope(process.env);
  const evidenceSigner = createWorkerEvidenceSigner(process.env);

  await createProductionWorkerSandboxReadiness().assertReady();

  // ── Validate required env vars ──
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error('DATABASE_URL is required for worker bootstrap');
  }
  // Owner-DSN gate BEFORE Pool connect / poll (URL userinfo).
  assertNonOwnerDatabaseUrl(dbUrl);

  const authToken = process.env.COMMANDER_WORKER_AUTH_TOKEN;
  if (!authToken) {
    throw new Error('COMMANDER_WORKER_AUTH_TOKEN is required for worker bootstrap');
  }

  // ── Parse configuration ──
  const workerId = process.env.COMMANDER_WORKER_ID ?? `worker-${randomUUID().slice(0, 8)}`;
  const workerKind = (process.env.COMMANDER_WORKER_KIND ?? 'agent') as WorkerKind;
  const capabilities = (process.env.COMMANDER_WORKER_CAPABILITIES ?? 'agent')
    .split(',')
    .map((s) => s.trim());
  const maxConcurrency = parseInt(process.env.COMMANDER_WORKER_MAX_CONCURRENCY ?? '10', 10);

  // ── Build worker identity ──
  const expiresAt = new Date(Date.now() + 3600_000); // 1 hour
  const identity: WorkerIdentity = {
    subject: process.env.COMMANDER_WORKER_AUTH_SUBJECT ?? `worker:${workerId}`,
    token: authToken,
    expiresAt: expiresAt.toISOString(),
  };

  // ── Build worker definition ──
  const definition: WorkerDefinition = {
    id: workerId,
    kind: workerKind,
    version: process.env.npm_package_version ?? '0.2.0',
    capabilities,
    maxConcurrency,
    labels: {
      hostname: hostname(),
      pid: String(process.pid),
      node_version: process.version,
    },
  };

  // ── Connect to PostgreSQL ──
  const pool = createVerifiedPostgresPool({
    connectionString: dbUrl,
    max: maxConcurrency + 5,
  });

  try {
    // Post-connect owner-role gate (current_user) before kernel/broker/poll.
    {
      const client = await pool.connect();
      try {
        const identityRows = (await client.query('SELECT current_user::text AS role_name')) as {
          rows: Array<{ role_name?: string }>;
        };
        assertNonOwnerDatabaseRole(identityRows.rows[0]?.role_name ?? '');
      } finally {
        client.release();
      }
    }

    // ── Create kernel repository adapter ──
    // Lazy dynamic import to avoid circular dependency at module load time.
    // Workers always connect with schedulerMode:false (commander_worker role, no
    // BYPASSRLS) and carry an explicit tenant scope on every write. Tenant
    // configuration never grants database authority; scheduler mode is reserved
    // for the kernel-ops entrypoint.
    const { PostgresKernelRepository } = (await import('@praetor/kernel')) as unknown as {
      PostgresKernelRepository: new (pool: any, options?: { schedulerMode?: boolean }) => any;
    };
    const kernel = new PostgresKernelRepository(pool, { schedulerMode });

    // ── Create registry ──
    const registry = new PostgresWorkerRegistry(pool);

    // ── Create authenticator ──
    const authenticator = new ApiKeyWorkerAuthenticator({
      validTokens: new Set([authToken]),
      defaultTenantIds: tenantIds,
      defaultCapabilities: capabilities,
    });

    // ── Create shared Effect Broker for external side effects ──
    // Task 3 factory — never CapabilityTokenIssuer.generate() for production authority.
    const { broker: effectBroker, issuer: capabilityIssuer } = createEffectBroker(
      kernel,
      workerId,
      process.env,
      evidenceSigner,
    );

    // ── Create step executor based on worker kind ──
    const executor = await createExecutorForKind(
      workerKind,
      capabilities,
      effectBroker,
      capabilityIssuer,
    );

    // ── Build worker service ──
    const service = new WorkerService(
      definition,
      identity,
      authenticator,
      registry,
      kernel,
      executor,
      {
        leaseTtlMs: parseInt(process.env.COMMANDER_WORKER_LEASE_TTL_MS ?? '30000', 10),
        workerHeartbeatMs: parseInt(process.env.COMMANDER_WORKER_HEARTBEAT_MS ?? '10000', 10),
        pollIntervalMs: parseInt(process.env.COMMANDER_WORKER_POLL_MS ?? '250', 10),
        sandboxReadiness: createProductionWorkerSandboxReadiness(),
        // WP-05: readiness follows the claim loop, not a one-shot startup latch.
        onClaimLoopHealth: options.onClaimLoopHealth,
        // WP-11: the verified pool belongs to the service lifecycle; stop() releases it.
        onDispose: () => pool.end(),
        // Generation is only known after registry.register — bind into broker affinity.
        onRegistered: (worker) => effectBroker.bindLocalWorkerGeneration(worker.generation),
      },
    );

    return service;
  } catch (error) {
    // WP-11: a failure after the pool was created must not leak its connections —
    // the service never exists to dispose them.
    await pool.end();
    throw error;
  }
}

/**
 * Worker-plane effect policy (Architecture V2 admission force).
 *
 * - llm.* is allow-by-default so agents can call models once EffectBroker is
 *   wired (still subject to capability tokens + kernel allowlist).
 * - All other external effect types remain deny-by-default (fail-closed).
 * - Worker effect-policy env set to the permit sentinel is intentionally ignored (WS2 §4).
 */
interface ActionGatewayPolicyKernel {
  getRun(runId: string, tenantId: string): Promise<KernelRun | null>;
  getStep(stepId: string, tenantId: string): Promise<KernelStep | null>;
  listInteractions(runId: string, tenantId: string): Promise<KernelInteraction[]>;
  findMatchingKillSwitch(
    tenantId: string,
    dims: {
      package?: string;
      model?: string;
      tool?: string;
      destination?: string;
      effectType?: string;
    },
  ): Promise<{ scope: string; value: string; enabled: boolean } | null>;
}

function isActionGatewayPolicyKernel(value: unknown): value is ActionGatewayPolicyKernel {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ActionGatewayPolicyKernel>;
  return (
    typeof candidate.getRun === 'function' &&
    typeof candidate.getStep === 'function' &&
    typeof candidate.listInteractions === 'function' &&
    typeof candidate.findMatchingKillSwitch === 'function'
  );
}

function denyActionGateway(reason: string) {
  return {
    effect: 'deny' as const,
    decisionId: 'action-gateway-deny-default',
    reason,
    policySnapshotId: ACTION_GATEWAY_POLICY_ID,
  };
}

/**
 * Worker re-runs the shared policy so a sealed metadata.decision alone cannot authorize effects.
 */
export function evaluateActionGatewayMvpV1(
  envelope: Record<string, unknown>,
  actionAdapters: ActionAdapterRegistry = ActionAdapterRegistry.empty(),
): {
  effect: 'allow' | 'deny' | 'require_approval';
  decisionId: string;
  reason: string;
  policySnapshotId: 'action-gateway-mvp-v1';
} {
  const effectType = envelope.effectType;
  const tool = envelope.tool;
  const destination = envelope.destination;
  const adapter = typeof effectType === 'string' ? actionAdapters.resolve(effectType) : null;
  if (
    adapter &&
    (effectType === adapter.descriptor.effectType ||
      effectType === adapter.descriptor.compensationEffectType) &&
    tool === adapter.descriptor.toolName &&
    typeof destination === 'string'
  ) {
    try {
      if (adapter.descriptor.adapterId === 'kubernetes.deployment.rollback') {
        parseKubernetesDeploymentDestination(destination);
      }
      const { effect, decisionId, reason, policySnapshotId } = evaluateActionGatewayPolicy({
        effectType,
        tool,
        destination,
      });
      return { effect, decisionId, reason, policySnapshotId };
    } catch {
      // Invalid Kubernetes destinations remain deny-by-default.
    }
  }
  const isDemo =
    (effectType === 'demo.ticket.create' && tool === 'ticket.create') ||
    (effectType === 'compensate.demo.ticket.create' && tool === 'ticket.compensate');
  if (!isDemo || typeof destination !== 'string') {
    return {
      effect: 'deny',
      decisionId: 'action-gateway-deny',
      reason: isDemo
        ? `Destination '${String(destination)}' is not registered by the Action Gateway.`
        : `Effect type '${String(effectType)}' is not registered by the Action Gateway.`,
      policySnapshotId: ACTION_GATEWAY_POLICY_ID,
    };
  }
  const { effect, decisionId, reason, policySnapshotId } = evaluateActionGatewayPolicy({
    effectType,
    tool,
    destination,
  });
  return { effect, decisionId, reason, policySnapshotId };
}

export function createWorkerPolicyEvaluator(
  kernelOrEnv: ActionGatewayPolicyKernel | NodeJS.ProcessEnv = process.env,
  actionAdapters: ActionAdapterRegistry = ActionAdapterRegistry.empty(),
): PolicyEvaluator {
  const kernel = isActionGatewayPolicyKernel(kernelOrEnv) ? kernelOrEnv : null;
  return {
    evaluate: async (input) => {
      if (typeof input.type === 'string' && input.type.startsWith('llm.')) {
        return {
          effect: 'allow' as const,
          decisionId: 'llm-model-default',
          reason: `Default worker policy allows model invocation (type=${input.type}).`,
          policySnapshotId: 'worker-llm-v1',
        };
      }
      if (!kernel) {
        return {
          effect: 'deny' as const,
          decisionId: 'deny-default',
          reason:
            `Default worker policy denies external effects (type=${input.type}). ` +
            'A kernel-backed Action Gateway policy evaluator is required.',
          policySnapshotId: 'worker-llm-v1',
        };
      }
      try {
        const [run, step] = await Promise.all([
          kernel.getRun(input.runId, input.tenantId),
          kernel.getStep(input.stepId, input.tenantId),
        ]);
        if (!run || !step || step.runId !== run.id || step.tenantId !== run.tenantId) {
          return denyActionGateway('ACTION_GATEWAY_RUN_NOT_FOUND');
        }
        const value = run.metadata.actionGateway;
        if (!value || typeof value !== 'object') {
          return denyActionGateway('ACTION_GATEWAY_METADATA_REQUIRED');
        }
        const metadata = value as Record<string, unknown>;
        const envelope = metadata.envelope;
        const decision = metadata.decision;
        const simulation = metadata.simulation;
        if (
          metadata.authority !== 'commander.action-gateway/v1' ||
          metadata.stepId !== step.id ||
          typeof metadata.effectId !== 'string' ||
          typeof metadata.actionDigest !== 'string' ||
          typeof metadata.policySnapshotId !== 'string' ||
          !envelope ||
          typeof envelope !== 'object' ||
          !decision ||
          typeof decision !== 'object'
        ) {
          return denyActionGateway('ACTION_GATEWAY_METADATA_INVALID');
        }
        const actionEnvelope = envelope as Record<string, unknown>;
        const actionDecision = decision as Record<string, unknown>;
        if (!simulation || typeof simulation !== 'object') {
          return denyActionGateway('SIMULATION_MISMATCH');
        }
        try {
          const killSwitch = await kernel.findMatchingKillSwitch(input.tenantId, {
            package:
              typeof actionEnvelope.package === 'string' ? actionEnvelope.package : undefined,
            model: typeof actionEnvelope.model === 'string' ? actionEnvelope.model : undefined,
            tool: typeof actionEnvelope.tool === 'string' ? actionEnvelope.tool : undefined,
            destination:
              typeof actionEnvelope.destination === 'string'
                ? actionEnvelope.destination
                : undefined,
            effectType:
              typeof actionEnvelope.effectType === 'string' ? actionEnvelope.effectType : undefined,
          });
          if (killSwitch) {
            return denyActionGateway('KILL_SWITCH_ACTIVE');
          }
        } catch {
          return denyActionGateway('KILL_SWITCH_LOOKUP_FAILED');
        }
        const actionSimulation = simulation as Record<string, unknown>;
        if (
          typeof actionSimulation.simulationId !== 'string' ||
          actionSimulation.actionDigest !== metadata.actionDigest ||
          actionSimulation.effect !== actionDecision.effect ||
          actionSimulation.decisionId !== actionDecision.decisionId ||
          actionSimulation.reason !== actionDecision.reason ||
          actionSimulation.policySnapshotId !== metadata.policySnapshotId
        ) {
          return denyActionGateway('SIMULATION_MISMATCH');
        }
        const persistedStepEnvelope = step.input.actionEnvelope;
        const actionArgs = actionEnvelope.args;
        const stepArgs = step.input.args;
        const requestArgs = input.request.args;
        if (
          actionEnvelope.tenantId !== input.tenantId ||
          actionEnvelope.effectType !== input.type ||
          step.input.effectType !== input.type ||
          metadata.effectId !== step.input.effectId ||
          !persistedStepEnvelope ||
          typeof persistedStepEnvelope !== 'object' ||
          !actionArgs ||
          typeof actionArgs !== 'object' ||
          !stepArgs ||
          typeof stepArgs !== 'object' ||
          !requestArgs ||
          typeof requestArgs !== 'object'
        ) {
          return denyActionGateway('ACTION_GATEWAY_BINDING_MISMATCH');
        }
        const digest = canonicalRequestHash(actionEnvelope);
        if (
          digest !== metadata.actionDigest ||
          canonicalRequestHash(persistedStepEnvelope as Record<string, unknown>) !== digest ||
          canonicalRequestHash(input.request) !== digest ||
          canonicalRequestHash(stepArgs as Record<string, unknown>) !==
            canonicalRequestHash(actionArgs as Record<string, unknown>) ||
          canonicalRequestHash(requestArgs as Record<string, unknown>) !==
            canonicalRequestHash(actionArgs as Record<string, unknown>)
        ) {
          return denyActionGateway('ACTION_DIGEST_MISMATCH');
        }
        if (
          run.policySnapshotId !== metadata.policySnapshotId ||
          actionDecision.policySnapshotId !== metadata.policySnapshotId ||
          typeof actionDecision.reason !== 'string'
        ) {
          return denyActionGateway('POLICY_SNAPSHOT_DRIFT');
        }
        // Defense in depth: re-evaluate mvp-v1 against the bound envelope so a
        // forged or post-create-mutated metadata.decision cannot authorize work.
        let revalidatedDecisionId: string | null = null;
        if (metadata.policySnapshotId === ACTION_GATEWAY_POLICY_ID) {
          const fresh = evaluateActionGatewayMvpV1(actionEnvelope, actionAdapters);
          if (
            fresh.effect !== actionDecision.effect ||
            fresh.decisionId !== actionDecision.decisionId
          ) {
            return denyActionGateway('ACTION_GATEWAY_DECISION_REVALIDATION_FAILED');
          }
          revalidatedDecisionId = fresh.decisionId;
        }
        if (actionDecision.effect === 'allow') {
          if (
            actionDecision.decisionId !== 'action-gateway-allow' &&
            actionDecision.decisionId !== revalidatedDecisionId
          ) {
            return denyActionGateway('ACTION_GATEWAY_DECISION_INVALID');
          }
          return {
            effect: 'allow' as const,
            decisionId: String(actionDecision.decisionId),
            reason: actionDecision.reason,
            policySnapshotId: String(metadata.policySnapshotId),
          };
        }
        if (actionDecision.effect !== 'require_approval') {
          return denyActionGateway('ACTION_GATEWAY_POLICY_DENIED');
        }
        if (
          (actionDecision.decisionId !== 'action-gateway-require_approval' &&
            actionDecision.decisionId !== revalidatedDecisionId) ||
          typeof metadata.interactionId !== 'string'
        ) {
          return denyActionGateway('ACTION_GATEWAY_APPROVAL_MISSING');
        }
        const interactions = await kernel.listInteractions(run.id, run.tenantId);
        const approval = interactions.find(
          (interaction) =>
            interaction.id === metadata.interactionId &&
            interaction.stepId === step.id &&
            interaction.status === 'answered',
        );
        if (approval?.response?.approved !== true) {
          return denyActionGateway('ACTION_GATEWAY_APPROVAL_REQUIRED');
        }
        if (
          approval.response.actionDigest !== metadata.actionDigest ||
          approval.response.simulationId !== actionSimulation.simulationId ||
          approval.response.policySnapshotId !== metadata.policySnapshotId ||
          typeof approval.response.reviewer !== 'string' ||
          approval.response.reviewer.length === 0 ||
          approval.response.runId !== run.id ||
          approval.response.tenantId !== run.tenantId
        ) {
          return denyActionGateway('APPROVAL_BINDING_MISMATCH');
        }
        return {
          effect: 'allow' as const,
          decisionId: 'action-gateway-allow-after-approval',
          reason: 'A tenant/run/step-bound approval was recorded by the kernel.',
          policySnapshotId: String(metadata.policySnapshotId),
        };
      } catch {
        return denyActionGateway('ACTION_GATEWAY_POLICY_LOOKUP_FAILED');
      }
    },
  };
}

type AllowlistKernel = EffectKernelPort & ActionGatewayPolicyKernel;

/**
 * Read the durable allowlist without letting a worker process invent policy.
 * Allowlist defaults belong to the API/migration path; missing policy fails closed.
 */
export function withDefaultLlmAllowlist(
  kernel: AllowlistKernel,
  _env: NodeJS.ProcessEnv = process.env,
): EffectKernelPort {
  return {
    getOperationsReadiness: kernel.getOperationsReadiness?.bind(kernel),
    admitEffect: (input) => kernel.admitEffect(input),
    completeEffect: (effectId, tenantId, lease, response, actor) =>
      kernel.completeEffect(effectId, tenantId, lease, response, actor),
    completeEffectWithEvidence: kernel.completeEffectWithEvidence?.bind(kernel),
    failEffectWithEvidence: kernel.failEffectWithEvidence?.bind(kernel),
    markEffectCompletionUnknown: kernel.markEffectCompletionUnknown?.bind(kernel),
    listEffectsForRun: kernel.listEffectsForRun?.bind(kernel),
    listEvents: kernel.listEvents?.bind(kernel),
    incrementQuota: kernel.incrementQuota?.bind(kernel),
    getQuota: kernel.getQuota?.bind(kernel),
    isActionAllowed: async (tenantId, action) => {
      if (!kernel.isActionAllowed) return false;
      return kernel.isActionAllowed(tenantId, action);
    },
  };
}

export function createWorkerEffectExecutor(
  tickets = new InMemoryTicketAdapter(),
  actionAdapterExecutor?: EffectExecutor,
): EffectExecutor {
  return {
    execute: async (input) => {
      if (input.type.startsWith('llm.')) {
        const ctx = input.executionContext;
        if (
          !ctx?.tenantId ||
          !ctx.workerId ||
          typeof ctx.fencingEpoch !== 'number' ||
          typeof ctx.leaseToken !== 'string' ||
          !ctx.leaseToken
        ) {
          throw new Error(
            'EFFECT_AUTHORIZATION_REQUIRED: llm.* execute requires executionContext tenantId, workerId, fencingEpoch, leaseToken from grant lease',
          );
        }
        const { dispatchLlmEffect } = await import('./llmBrokerBridge.js');
        return dispatchLlmEffect({
          type: input.type,
          request: input.request,
          signal: input.signal,
          tenantId: ctx.tenantId,
          workerId: ctx.workerId,
          fencingEpoch: ctx.fencingEpoch,
          leaseToken: ctx.leaseToken,
        });
      }
      if (input.type === 'demo.ticket.create') {
        const ctx = input.executionContext;
        const args = input.request.args;
        if (
          !ctx?.tenantId ||
          !args ||
          typeof args !== 'object' ||
          typeof (args as Record<string, unknown>).title !== 'string' ||
          typeof input.request.idempotencyKey !== 'string'
        ) {
          throw new Error('INVALID_DEMO_TICKET_ACTION');
        }
        const ticket = await tickets.create({
          tenantId: ctx.tenantId,
          idempotencyKey: input.request.idempotencyKey,
          title: (args as Record<string, unknown>).title as string,
        });
        return {
          ticketId: ticket.ticketId,
          title: ticket.title,
          status: ticket.status,
        };
      }
      if (input.type === 'compensate.demo.ticket.create') {
        const ctx = input.executionContext;
        const args = input.request.args;
        if (
          !ctx?.tenantId ||
          !args ||
          typeof args !== 'object' ||
          typeof (args as Record<string, unknown>).targetIdempotencyKey !== 'string'
        ) {
          throw new Error('INVALID_DEMO_TICKET_COMPENSATION');
        }
        const ticket = await tickets.compensate({
          tenantId: ctx.tenantId,
          idempotencyKey: (args as Record<string, unknown>).targetIdempotencyKey as string,
        });
        return {
          ticketId: ticket.ticketId,
          title: ticket.title,
          status: ticket.status,
        };
      }
      if (actionAdapterExecutor) {
        return actionAdapterExecutor.execute(input);
      }
      throw new Error(`UNREGISTERED_EFFECT_TYPE: ${input.type}`);
    },
  };
}

/**
 * Wire EffectBroker via Task 3 `createCapabilityAuthority` from `@praetor/kernel`.
 * Production / enterprise refuse `CapabilityTokenIssuer.generate()` (factory gate).
 * Durable `replay` + `revocations` are non-optional on broker options (presence);
 * EffectBroker ctor fail-closed when requireDurable / production profile.
 * Token verify still owns durable consume via grant.tenantId (no options double-consume).
 */
export function createEffectBroker(
  kernel: AllowlistKernel & KernelRepository,
  localWorkerId: string,
  env: NodeJS.ProcessEnv = process.env,
  evidenceSigner: ConfiguredEvidenceSigner | null = null,
): {
  broker: EffectBroker;
  issuer: CapabilityTokenIssuer;
  capability: CapabilityAuthority;
} {
  const capability = createCapabilityAuthority(env, kernel);
  assertDurableCapabilityStores(capability, kernel);
  const signer = evidenceSigner ?? createWorkerEvidenceSigner(env);

  const actionAdapters = createProductionAdapterRegistry(undefined, env);
  const policy = createWorkerPolicyEvaluator(kernel, actionAdapters);
  const effectKernel = withDefaultLlmAllowlist(kernel);
  const executor = createWorkerEffectExecutor(
    undefined,
    createActionAdapterEffectExecutor(actionAdapters),
  );

  // Console audit sink. Production should forward to a durable audit store.
  const audit: AuditSink = {
    append: async (event: {
      type: string;
      severity: 'low' | 'medium' | 'high' | 'critical';
      tenantId: string;
      runId: string;
      stepId: string;
      at: string;
      details: Record<string, unknown>;
    }) => {
      // eslint-disable-next-line no-console
      console.log(`[effect-audit] ${event.type} ${event.severity}`, event.details);
    },
  };

  const brokerOptions = productionCapabilityBrokerOptions(capability, localWorkerId);
  let evidenceOptions: Pick<EffectBrokerOptions, 'evidenceSigner' | 'requireEvidencePersistence'> =
    {};
  if (signer) {
    if (
      !effectKernel.completeEffectWithEvidence ||
      !effectKernel.failEffectWithEvidence ||
      !effectKernel.listEffectsForRun ||
      !effectKernel.listEvents
    ) {
      throw new Error(EVIDENCE_REPOSITORY_REQUIRED);
    }
    evidenceOptions = {
      evidenceSigner: signer,
      requireEvidencePersistence: true,
    };
  }

  // WS2 §4: request binding is mandatory. The EffectBroker constructor
  // enforces this in production (throws REQUEST_BINDING_DISABLED_IN_PROD).
  // Verifier already embeds durable tenant-scoped replay + revocations;
  // options still carry non-optional store handles from the factory.
  const broker = new EffectBroker(capability.verifier, policy, effectKernel, executor, audit, {
    ...brokerOptions,
    ...evidenceOptions,
    idempotencyKeyPolicy: 'derive',
  });
  return { broker, issuer: capability.issuer, capability };
}

/**
 * Create the appropriate step executor(s) based on worker kind.
 * A worker can handle multiple step kinds if configured with multiple capabilities.
 */
async function createExecutorForKind(
  kind: WorkerKind,
  capabilities: string[],
  effectBroker?: EffectBroker,
  capabilityIssuer?: CapabilityTokenIssuer,
): Promise<StepExecutor> {
  const toolEffectCatalog = createDefaultWorkerToolEffectCatalog();

  // Explicit executor manifest — validated at startup. No runtime guessing.
  const manifest = createExecutorManifest({
    agent: () => createAgentStepExecutor({ effectBroker, capabilityIssuer }),
    tool: () => new ToolStepExecutor(undefined, effectBroker, capabilityIssuer, toolEffectCatalog),
    evaluator: () => new EvaluatorStepExecutor(),
    connector: async () => {
      const { ConnectorStepExecutor } = await import('./connectorStepExecutor.js');
      return new ConnectorStepExecutor(
        undefined,
        effectBroker,
        capabilityIssuer,
        toolEffectCatalog,
      );
    },
  });

  manifest.validate(capabilities);

  const requiredCapabilities = capabilities.includes('*')
    ? Array.from(manifest.entries.keys())
    : capabilities;
  const executors: Record<string, StepExecutor> = {};
  for (const cap of requiredCapabilities) {
    const entry = manifest.entries.get(cap);
    if (!entry) {
      throw new Error(`No executor manifest entry for capability '${cap}'`);
    }
    executors[cap] = await entry.factory();
  }

  // If multiple executors, use composite
  const executorList = Object.entries(executors);
  if (executorList.length > 1) {
    return new CompositeStepExecutor(new Map(executorList));
  }

  // Single executor — return directly
  const single = executorList[0]?.[1];
  if (!single) {
    throw new Error(
      `No executor available for worker kind '${kind}' with capabilities [${capabilities.join(', ')}]`,
    );
  }
  return single;
}
