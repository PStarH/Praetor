/**
 * WS2 §1 — route LLM provider calls through EffectBroker.
 *
 * The broker owns a single EffectExecutor; LLM invocations register a
 * one-shot callback keyed by tenantId:effectId (also placed on the ledger request)
 * so the executor can run the real provider.call without serializing functions.
 *
 * Capability tokens are minted **at call time** (not once per step): request
 * binding hashes include a per-call effectId, so a pre-signed step token would
 * always fail REQUEST_HASH_MISMATCH under requireRequestBinding.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { EffectBroker } from '@praetor/effect-broker';
import {
  canonicalRequestHash,
  deriveEffectIdempotencyKey,
  type CapabilityTokenIssuer,
} from '@praetor/effect-broker';
import type { LLMProvider, LLMRequest, LLMResponse } from '@praetor/core';
import { mintStepCapabilityToken, requireStepWorkloadBinding } from './stepWorkloadIdentity.js';

type LlmInvokeKey = `${string}:${string}`;

interface LlmInvokeEntry {
  tenantId: string;
  effectId: string;
  runId: string;
  stepId: string;
  workerId: string;
  fencingEpoch: number;
  leaseToken: string;
  contentHash: string;
  invoke: () => Promise<LLMResponse>;
  expiresAt: number;
}

/** Process-local tenant-scoped one-shot invoke registry (module private). */
const llmInvokeRegistry = new Map<LlmInvokeKey, LlmInvokeEntry>();

/**
 * Encode tenantId so `:` (allowed in TENANT_ID_RE) cannot collide with the
 * separator — e.g. tenant `a:b` + effect `c` vs tenant `a` + effect `b:c`.
 */
function invokeRegistryKey(tenantId: string, effectId: string): LlmInvokeKey {
  return `${encodeURIComponent(tenantId)}:${effectId}`;
}

/** @internal test-only */
export function resetLlmInvokeRegistryForTests(): void {
  llmInvokeRegistry.clear();
}

/** @internal test-only */
export function __testLlmInvokeRegistrySize(): number {
  return llmInvokeRegistry.size;
}

/** @internal test-only — plant a registry entry (e.g. expired) for dispatch checks. */
export function __testPlantLlmInvokeEntry(entry: LlmInvokeEntry): void {
  llmInvokeRegistry.set(invokeRegistryKey(entry.tenantId, entry.effectId), entry);
}

export interface LlmEffectAuth {
  tenantId: string;
  runId: string;
  stepId: string;
  /** Non-empty workload pin — must match grant.workloadId on admit (fail-closed). */
  workloadId: string;
  actor: string;
  lease: {
    workerId: string;
    workerGeneration?: number;
    token: string;
    fencingEpoch: number;
  };
  /** Capability mint TTL in ms (default 5 minutes). */
  capabilityTtlMs?: number;
  /**
   * Mint a short-lived grant bound to the exact broker request body.
   * Must use the same canonicalRequestHash the broker will verify.
   */
  mintCapabilityToken: (input: { effectType: string; request: Record<string, unknown> }) => string;
}

const llmAuthStorage = new AsyncLocalStorage<LlmEffectAuth>();

export function runWithLlmEffectAuth<T>(auth: LlmEffectAuth, fn: () => T): T {
  return llmAuthStorage.run(auth, fn);
}

export function getLlmEffectAuth(): LlmEffectAuth | undefined {
  return llmAuthStorage.getStore();
}

/**
 * Resolve the admit binding: always the verified step workload identity.
 * Deliberately no ambient fallback — a caller-supplied auth object must never
 * fabricate the tenant/run/step/workload that admit() binds the effect to.
 */
function resolveAdmitWorkloadBinding() {
  return requireStepWorkloadBinding();
}

/** Build ALS auth that mints per-call tokens via the worker's CapabilityTokenIssuer. */
export function createLlmEffectAuth(input: {
  actor: string;
  lease: LlmEffectAuth['lease'];
  issuer: CapabilityTokenIssuer;
  /** Token TTL in ms (default 5 minutes). */
  ttlMs?: number;
}): LlmEffectAuth {
  const ttlMs = input.ttlMs ?? 5 * 60_000;
  // Identity comes from the live step-workload binding only. Callers that need
  // to establish identity must run inside runWithStepWorkloadIdentity().
  const binding = requireStepWorkloadBinding();
  return {
    tenantId: binding.tenantId,
    runId: binding.runId,
    stepId: binding.stepId,
    workloadId: binding.workloadId,
    actor: input.actor,
    lease: input.lease,
    capabilityTtlMs: ttlMs,
    mintCapabilityToken: ({ effectType, request }) => {
      // Re-check ALS at mint time (not create-time snapshot) so expiry/revoke fail-close.
      return mintStepCapabilityToken({
        issuer: input.issuer,
        effectType,
        request,
        ttlMs,
      });
    },
  };
}

/**
 * Hash the call-shaping payload (messages/model/params) for request binding
 * without placing raw prompt text on the effect ledger.
 */
export function hashLlmCallContent(request: LLMRequest): string {
  return canonicalRequestHash({
    model: request.model ?? null,
    messages: request.messages ?? [],
    maxTokens: request.maxTokens ?? null,
    temperature: request.temperature ?? null,
    stop: request.stop ?? null,
    tools: request.tools ?? null,
    responseFormat: request.responseFormat ?? null,
    reasoningConfig: request.reasoningConfig ?? null,
    safePrompt: request.safePrompt ?? null,
    ...(request.cacheConfig === undefined ? {} : { cacheConfig: request.cacheConfig }),
    ...(request.parallelToolCalls === undefined
      ? {}
      : { parallelToolCalls: request.parallelToolCalls }),
  } as Record<string, unknown>);
}

/**
 * Allowed values for COMMANDER_LLM_INVOKE_MODE.
 * - unset / local-affinity: process-local tenant-scoped registry (C-α)
 * - disabled / sealed / unknown: fail-closed at wrap construction (C-γ sealed not shipped)
 */
function assertLlmInvokeModeAllowed(): void {
  const mode = process.env.COMMANDER_LLM_INVOKE_MODE;
  if (mode === undefined || mode === '' || mode === 'local-affinity') return;
  if (mode === 'disabled') {
    throw new Error(
      'LLM_INVOKE_MODE_DISABLED: LLM invoke registry is disabled (COMMANDER_LLM_INVOKE_MODE=disabled)',
    );
  }
  throw new Error(
    `LLM_INVOKE_MODE_DISABLED: COMMANDER_LLM_INVOKE_MODE=${mode} is not implemented (allowed: unset|local-affinity|disabled); sealed requires C-γ`,
  );
}

/**
 * Race provider invoke against broker AbortSignal. LLMProvider.call has no
 * signal param — we fail the dispatch promise on abort even if HTTP continues.
 */
function invokeWithSignal(
  invoke: () => Promise<LLMResponse>,
  signal?: AbortSignal,
): Promise<LLMResponse> {
  if (!signal) return invoke();
  if (signal.aborted) {
    const reason = signal.reason;
    return Promise.reject(reason instanceof Error ? reason : new Error('LLM_INVOKE_ABORTED'));
  }
  return new Promise<LLMResponse>((resolve, reject) => {
    const onAbort = () => {
      const reason = signal.reason;
      reject(reason instanceof Error ? reason : new Error('LLM_INVOKE_ABORTED'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    invoke().then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Wrap an LLM provider so every call is mediated by EffectBroker.execute.
 * Fail-closed when auth context is missing or invoke mode is not local-affinity.
 */
export function wrapProviderWithEffectBroker(
  provider: LLMProvider,
  broker: EffectBroker,
): LLMProvider {
  assertLlmInvokeModeAllowed();
  return {
    name: provider.name,
    async call(request: LLMRequest): Promise<LLMResponse> {
      const auth = getLlmEffectAuth();
      if (!auth) {
        throw new Error(
          'EFFECT_AUTHORIZATION_REQUIRED: LLM calls through EffectBroker need step lease + capability mint',
        );
      }
      const effectType = `llm.${provider.name}`;
      const capabilityTtlMs = auth.capabilityTtlMs ?? 5 * 60_000;
      // Freeze call payload so ledger hash and provider invoke stay atomic.
      const frozenRequest: LLMRequest = structuredClone(request);
      const contentHash = hashLlmCallContent(frozenRequest);
      // Stable effect identity from contentHash (not random UUID) so crash/retry
      // within the same step dedupes on the ledger.
      const effectId = `llm:${auth.runId}:${auth.stepId}:${contentHash}`;
      const registryKey = invokeRegistryKey(auth.tenantId, effectId);
      // Ledger keeps metadata + contentHash (not raw prompt) for DLP-friendly binding.
      const requestBody: Record<string, unknown> = {
        effectId,
        provider: provider.name,
        model: frozenRequest.model ?? null,
        messageCount: Array.isArray(frozenRequest.messages) ? frozenRequest.messages.length : 0,
        contentHash,
      };
      // The idempotency key is derived from the broker request body (never the
      // raw effectId) so it stays legal under the broker's 'derive' policy.
      const idempotencyKey = deriveEffectIdempotencyKey({
        tenantId: auth.tenantId,
        runId: auth.runId,
        stepId: auth.stepId,
        effectId,
        request: requestBody,
      });
      const capabilityToken = auth.mintCapabilityToken({
        effectType,
        request: requestBody,
      });
      llmInvokeRegistry.set(registryKey, {
        tenantId: auth.tenantId,
        effectId,
        runId: auth.runId,
        stepId: auth.stepId,
        workerId: auth.lease.workerId,
        fencingEpoch: auth.lease.fencingEpoch,
        leaseToken: auth.lease.token,
        contentHash,
        expiresAt: Date.now() + capabilityTtlMs,
        invoke: () => {
          const liveHash = hashLlmCallContent(frozenRequest);
          if (liveHash !== contentHash) {
            throw new Error(
              'EFFECT_REQUEST_TAMPERED: LLM invoke payload diverged from admitted contentHash',
            );
          }
          return provider.call(frozenRequest);
        },
      });
      try {
        const result = await broker.execute({
          effectId,
          token: capabilityToken,
          type: effectType,
          request: requestBody,
          idempotencyKey,
          lease: auth.lease,
          actor: auth.actor,
          workloadBinding: resolveAdmitWorkloadBinding(),
        });
        if (result.response == null) {
          throw new Error(
            'EFFECT_RESPONSE_MISSING: broker returned no LLM response (incomplete replay?)',
          );
        }
        return result.response as unknown as LLMResponse;
      } finally {
        llmInvokeRegistry.delete(registryKey);
      }
    },
  };
}

/** Dispatch helper for the worker EffectExecutor — llm.* → tenant-scoped registry invoke. */
export async function dispatchLlmEffect(input: {
  type: string;
  request: Record<string, unknown>;
  signal?: AbortSignal;
  tenantId: string;
  workerId: string;
  fencingEpoch: number;
  leaseToken: string;
}): Promise<Record<string, unknown>> {
  if (!input.type.startsWith('llm.')) {
    throw new Error(`Not an LLM effect type: ${input.type}`);
  }
  const effectId = input.request.effectId;
  if (typeof effectId !== 'string' || !effectId) {
    throw new Error('LLM effect missing effectId for invoke registry lookup');
  }
  const expectedHash = input.request.contentHash;
  if (typeof expectedHash !== 'string' || !expectedHash) {
    throw new Error('LLM effect missing contentHash for invoke integrity check');
  }
  const registryKey = invokeRegistryKey(input.tenantId, effectId);
  const entry = llmInvokeRegistry.get(registryKey);
  if (!entry) {
    // Same effectId under another tenant → TENANT_MISMATCH without leaking that tenantId.
    for (const candidate of llmInvokeRegistry.values()) {
      if (candidate.effectId === effectId) {
        throw new Error(
          `LLM_TENANT_MISMATCH: effectId=${effectId} is not registered for the dispatch tenant`,
        );
      }
    }
    throw new Error(
      `LLM_INVOKE_MISS: no registry entry for tenantId=${input.tenantId} effectId=${effectId}`,
    );
  }
  if (entry.tenantId !== input.tenantId) {
    throw new Error(
      `LLM_TENANT_MISMATCH: effectId=${effectId} is not registered for the dispatch tenant`,
    );
  }
  if (entry.workerId !== input.workerId) {
    throw new Error(
      `LLM_WORKER_MISMATCH: registry workerId=${entry.workerId} dispatch workerId=${input.workerId}`,
    );
  }
  if (entry.fencingEpoch !== input.fencingEpoch) {
    throw new Error(
      `LLM_LEASE_MISMATCH: registry fencingEpoch=${entry.fencingEpoch} dispatch fencingEpoch=${input.fencingEpoch}`,
    );
  }
  if (entry.leaseToken !== input.leaseToken) {
    throw new Error('LLM_LEASE_MISMATCH: registry lease token diverged from dispatch lease');
  }
  if (entry.contentHash !== expectedHash) {
    throw new Error(
      'LLM_CONTENT_HASH_MISMATCH: invoke request contentHash diverged from registered entry',
    );
  }
  if (Date.now() > entry.expiresAt) {
    llmInvokeRegistry.delete(registryKey);
    throw new Error(
      `LLM_INVOKE_EXPIRED: registry entry expired for tenantId=${input.tenantId} effectId=${effectId}`,
    );
  }
  // One-shot: consume before invoke so concurrent dispatch cannot double-call.
  llmInvokeRegistry.delete(registryKey);
  const response = await invokeWithSignal(entry.invoke, input.signal);
  return response as unknown as Record<string, unknown>;
}
