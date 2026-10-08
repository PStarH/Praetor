/**
 * P0 local worker bootstrap — mock LLM, real Postgres kernel.
 *
 * Used only for local/CI proof of Gateway → Kernel → Worker terminal states.
 * Production deployments must use packages/worker-plane/src/bootstrap.ts with real providers.
 *
 * Env:
 *   COMMANDER_WORKER_DATABASE_URL (preferred least-privilege worker LOGIN)
 *   DATABASE_URL or COMMANDER_KERNEL_DATABASE_URL (required)
 *   COMMANDER_WORKER_AUTH_TOKEN (default: worker-token)
 *   COMMANDER_WORKER_TENANTS (required explicit list; '*'/empty fail-closed — same as prod)
 *   COMMANDER_WORKER_CAPABILITIES (default: agent)
 */
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { PostgresKernelRepository } from '@praetor/kernel';
import { createVerifiedPostgresPool } from '@praetor/postgres-runtime';
import type { LLMProvider, LLMRequest, LLMResponse } from '@praetor/core';
import {
  WorkerService,
  PostgresWorkerRegistry,
  ApiKeyWorkerAuthenticator,
  createAgentStepExecutor,
  resolveWorkerTenantScope,
  type WorkerDefinition,
  type WorkerIdentity,
} from '@praetor/worker-plane';

class MockProvider implements LLMProvider {
  readonly name = 'mock';
  async call(_request: LLMRequest): Promise<LLMResponse> {
    return {
      model: 'mock-model',
      content: 'p0 mock completion',
      finishReason: 'stop',
      usage: { promptTokens: 8, completionTokens: 4, totalTokens: 12 },
    };
  }
}

export async function createWorkerService(): Promise<WorkerService> {
  const dbUrl =
    process.env.COMMANDER_WORKER_DATABASE_URL ??
    process.env.COMMANDER_KERNEL_DATABASE_URL ??
    process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error(
      'COMMANDER_WORKER_DATABASE_URL, COMMANDER_KERNEL_DATABASE_URL, or DATABASE_URL is required',
    );
  }

  // Fail-closed before Pool/register/poll — never infer schedulerMode from '*'.
  const { tenantIds, schedulerMode } = resolveWorkerTenantScope(process.env);

  const authToken = process.env.COMMANDER_WORKER_AUTH_TOKEN ?? 'worker-token';
  const workerId = process.env.COMMANDER_WORKER_ID ?? `p0-worker-${randomUUID().slice(0, 8)}`;
  const capabilities = (process.env.COMMANDER_WORKER_CAPABILITIES ?? 'agent')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const maxConcurrency = Number(process.env.COMMANDER_WORKER_MAX_CONCURRENCY ?? 4);

  const pool = createVerifiedPostgresPool({
    connectionString: dbUrl,
    max: maxConcurrency + 4,
  });
  const kernel = new PostgresKernelRepository(pool, { schedulerMode });
  await kernel.initialize();

  const registry = new PostgresWorkerRegistry(pool);
  await registry.initialize();

  const authenticator = new ApiKeyWorkerAuthenticator({
    validTokens: new Set([authToken]),
    defaultTenantIds: tenantIds,
    defaultCapabilities: capabilities,
  });

  // Default deterministic executor: proves gateway↔kernel↔worker without AgentRuntime
  // side-effects (git stash, OTel, provider routing). Set COMMANDER_P0_USE_MOCK_LLM=1
  // to exercise createAgentStepExecutor + MockProvider instead.
  const useMockLlm = process.env.COMMANDER_P0_USE_MOCK_LLM === '1';
  const executor = useMockLlm
    ? createAgentStepExecutor({
        providers: { mock: new MockProvider() },
        config: {
          defaultProvider: 'mock',
        },
      })
    : {
        async execute(step: { runId: string; input: Record<string, unknown> }) {
          return {
            status: 'completed',
            summary: `p0-deterministic:${String(step.input?.['goal'] ?? '')}`,
            runId: step.runId,
          };
        },
      };

  const definition: WorkerDefinition = {
    id: workerId,
    kind: 'agent',
    version: 'p0-mock',
    capabilities,
    maxConcurrency,
    labels: { hostname: hostname(), mode: 'p0-mock' },
  };

  const identity: WorkerIdentity = {
    subject: process.env.COMMANDER_WORKER_AUTH_SUBJECT ?? `worker:${workerId}`,
    token: authToken,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };

  return new WorkerService(definition, identity, authenticator, registry, kernel, executor, {
    leaseTtlMs: Number(process.env.COMMANDER_WORKER_LEASE_TTL_MS ?? 30_000),
    workerHeartbeatMs: Number(process.env.COMMANDER_WORKER_HEARTBEAT_MS ?? 5_000),
    pollIntervalMs: Number(process.env.COMMANDER_WORKER_POLL_MS ?? 100),
  });
}
