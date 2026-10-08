/**
 * Durable CapabilityReplayStore / CapabilityRevocationStore adapters over
 * KernelRepository (commander_capability_replays + revocations).
 */

import type { CapabilityReplayStore, CapabilityRevocationStore } from '@praetor/effect-broker';
import type { KernelRepository } from './repository.js';

export type CapabilityReplayRepository = Pick<KernelRepository, 'consumeCapabilityReplay'>;
export type CapabilityRevocationRepository = Pick<
  KernelRepository,
  'isCapabilityRevoked' | 'revokeCapability'
>;

/**
 * Tenant-bound replay store. `consume` key format is `jti:nonce` (broker verifier).
 * Bind tenant at construction — do not ship a single process-wide fixed tenant for
 * multi-tenant workers; use {@link createDurableCapabilityReplayConsume} or
 * {@link KernelCapabilityReplayStore.forTenant} instead.
 */
export class KernelCapabilityReplayStore implements CapabilityReplayStore {
  constructor(
    private readonly repository: CapabilityReplayRepository,
    private readonly tenantId: string,
  ) {
    if (!tenantId) {
      throw new Error('CAPABILITY_REPLAY_TENANT_REQUIRED');
    }
  }

  static forTenant(
    repository: CapabilityReplayRepository,
    tenantId: string,
  ): KernelCapabilityReplayStore {
    return new KernelCapabilityReplayStore(repository, tenantId);
  }

  async consume(key: string, expiresAt: string): Promise<boolean> {
    const [jti, nonce] = key.split(':', 2);
    if (!jti || !nonce) {
      throw new Error('CAPABILITY_REPLAY_KEY_INVALID');
    }
    return this.repository.consumeCapabilityReplay({
      tenantId: this.tenantId,
      jti,
      nonce,
      expiresAt,
    });
  }
}

/**
 * Tenant-bound revocation adapter. `isRevoked(jti, tenantId)` must carry the
 * grant tenant so worker repos can set `app.tenant_scope` under RLS.
 * Prefer {@link KernelCapabilityRevocationStore.revokeGrant} when tenantId is known;
 * bare {@link revoke} requires `defaultTenantId` at construction.
 */
export class KernelCapabilityRevocationStore implements CapabilityRevocationStore {
  constructor(
    private readonly repository: CapabilityRevocationRepository,
    private readonly options: { defaultTenantId?: string } = {},
  ) {}

  async isRevoked(jti: string, tenantId: string): Promise<boolean> {
    if (!tenantId) {
      throw new Error('CAPABILITY_REVOCATION_TENANT_REQUIRED');
    }
    return this.repository.isCapabilityRevoked(jti, tenantId);
  }

  async revoke(jti: string, expiresAt: string): Promise<void> {
    const tenantId = this.options.defaultTenantId;
    if (!tenantId) {
      throw new Error('CAPABILITY_REVOCATION_TENANT_REQUIRED');
    }
    await this.repository.revokeCapability({ jti, tenantId, expiresAt });
  }

  async revokeGrant(input: {
    jti: string;
    tenantId: string;
    expiresAt: string;
    reason?: string;
  }): Promise<void> {
    await this.repository.revokeCapability(input);
  }
}

/** Consume replay using grant.tenantId — for multi-tenant durable verify paths. */
export async function createDurableCapabilityReplayConsume(
  repository: CapabilityReplayRepository,
  input: { tenantId: string; jti: string; nonce: string; expiresAt: string },
): Promise<boolean> {
  return repository.consumeCapabilityReplay(input);
}
