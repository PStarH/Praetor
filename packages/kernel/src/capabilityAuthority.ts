/**
 * Stable capability signing authority for worker-plane / adapter-ops.
 *
 * Loads Ed25519 PEM + JWKS from env. Production/enterprise refuse generated keys.
 * Returns issuer + durable verifier port (tenant-bound replay after signature verify).
 */

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from 'node:crypto';
import {
  CapabilityTokenIssuer,
  CapabilityTokenVerifier,
  type CapabilityGrant,
  type CapabilityTokenPort,
  type KeyLike,
} from '@praetor/effect-broker';
import type { KernelRepository } from './repository.js';
import {
  KernelCapabilityReplayStore,
  KernelCapabilityRevocationStore,
} from './capabilityStores.js';

export const CAPABILITY_PRIVATE_KEY_PEM_ENV = 'COMMANDER_CAPABILITY_PRIVATE_KEY_PEM';
export const CAPABILITY_KEY_ID_ENV = 'COMMANDER_CAPABILITY_KEY_ID';
export const CAPABILITY_JWKS_JSON_ENV = 'COMMANDER_CAPABILITY_JWKS_JSON';
export const CAPABILITY_ISSUER_ENV = 'COMMANDER_CAPABILITY_ISSUER';
export const CAPABILITY_AUDIENCE_ENV = 'COMMANDER_CAPABILITY_AUDIENCE';

export const CAPABILITY_AUTHORITY_REQUIRED = 'CAPABILITY_AUTHORITY_REQUIRED';

export type CapabilityAuthorityEnv = NodeJS.ProcessEnv | Record<string, string | undefined>;

export interface CreateCapabilityAuthorityOptions {
  issuer?: string;
  audience?: string;
  clock?: () => Date;
  clockSkewMs?: number;
  /**
   * Outside production/enterprise, allow ephemeral Ed25519 when PEM/JWKS/key id
   * are missing. Default true. Production/enterprise always refuse generation.
   */
  allowGenerateOutsideProduction?: boolean;
}

export interface CapabilityAuthority {
  keyId: string;
  issuerName: string;
  audience: string;
  /** True when this process generated an ephemeral key (non-prod only). */
  generated: boolean;
  issuer: CapabilityTokenIssuer;
  /** Durable token port: signature + revocation + tenant-scoped replay. */
  verifier: CapabilityTokenPort;
  revocations: KernelCapabilityRevocationStore;
  /** Build a tenant-bound replay store (brief Step 3 shape). */
  replayForTenant(tenantId: string): KernelCapabilityReplayStore;
  publicKeys: ReadonlyMap<string, KeyLike>;
}

interface JwkOkp {
  kty?: string;
  crv?: string;
  kid?: string;
  x?: string;
  alg?: string;
  use?: string;
}

function isProductionOrEnterprise(env: CapabilityAuthorityEnv): boolean {
  // AUDIT-K1: COMMANDER_ENV joins the signal set — production detection must
  // not hinge on NODE_ENV surviving the deployment env plumbing.
  return (
    env.NODE_ENV === 'production' ||
    env.COMMANDER_ENV === 'production' ||
    env.COMMANDER_PROFILE === 'enterprise' ||
    env.COMMANDER_CELL_TIER === 'enterprise' ||
    env.COMMANDER_REQUIRE_CAPABILITY_AUTHORITY === '1'
  );
}

function requiredError(detail: string): Error {
  return new Error(`${CAPABILITY_AUTHORITY_REQUIRED}: ${detail}`);
}

/** Literal placeholder markers that must never appear in real key material. */
const PLACEHOLDER_PATTERN = /replace_me|changeme|demo_only/i;

function assertNoPlaceholderContent(name: string, value: string): void {
  if (PLACEHOLDER_PATTERN.test(value)) {
    throw requiredError(
      `${name} contains placeholder content (REPLACE_ME/changeme/DEMO_ONLY) — set real key material`,
    );
  }
}

function parseJwksPublicKeys(jwksJson: string): Map<string, KeyObject> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jwksJson);
  } catch {
    throw requiredError('COMMANDER_CAPABILITY_JWKS_JSON is not valid JSON');
  }
  const keys = (parsed as { keys?: JwkOkp[] })?.keys;
  if (!Array.isArray(keys) || keys.length === 0) {
    throw requiredError('COMMANDER_CAPABILITY_JWKS_JSON.keys must be a non-empty array');
  }
  const out = new Map<string, KeyObject>();
  for (const jwk of keys) {
    if (!jwk || typeof jwk !== 'object') {
      throw requiredError('JWKS entry must be an object');
    }
    if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519') {
      throw requiredError(`JWKS key ${jwk.kid ?? '(missing kid)'} must be OKP/Ed25519`);
    }
    if (!jwk.kid || !jwk.x) {
      throw requiredError('JWKS Ed25519 key requires kid and x');
    }
    try {
      out.set(
        jwk.kid,
        createPublicKey({
          key: {
            kty: 'OKP',
            crv: 'Ed25519',
            x: jwk.x,
          },
          format: 'jwk',
        }),
      );
    } catch (err) {
      throw requiredError(
        `failed to import JWKS kid=${jwk.kid}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return out;
}

function loadPrivateKey(pem: string): KeyObject {
  try {
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType !== 'ed25519') {
      throw requiredError('COMMANDER_CAPABILITY_PRIVATE_KEY_PEM must be Ed25519');
    }
    return key;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith(CAPABILITY_AUTHORITY_REQUIRED)) throw err;
    throw requiredError(
      `invalid COMMANDER_CAPABILITY_PRIVATE_KEY_PEM: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function publicJwkFromPrivate(privateKey: KeyObject, kid: string): JwkOkp {
  const jwk = privateKey.export({ format: 'jwk' }) as JwkOkp;
  return {
    kty: 'OKP',
    crv: 'Ed25519',
    kid,
    x: jwk.x,
    alg: 'EdDSA',
    use: 'sig',
  };
}

function assertPrivateMatchesJwks(
  privateKey: KeyObject,
  keyId: string,
  publicKeys: ReadonlyMap<string, KeyObject>,
): void {
  const expected = publicKeys.get(keyId);
  if (!expected) {
    throw requiredError(`COMMANDER_CAPABILITY_KEY_ID=${keyId} not present in JWKS`);
  }
  const fromPrivate = privateKey.export({ format: 'jwk' }) as JwkOkp;
  const fromJwks = expected.export({ format: 'jwk' }) as JwkOkp;
  if (fromPrivate.x !== fromJwks.x) {
    throw requiredError(`private key does not match JWKS public key for kid=${keyId}`);
  }
}

function createDurableTokenPort(input: {
  issuerName: string;
  audience: string;
  publicKeys: ReadonlyMap<string, KeyLike>;
  repository: KernelRepository;
  revocations: KernelCapabilityRevocationStore;
  clock?: () => Date;
  clockSkewMs?: number;
}): CapabilityTokenPort {
  // Signature + revocation only; replay is applied after grant.tenantId is known
  // so multi-tenant workers do not share a single constructor tenant.
  const base = new CapabilityTokenVerifier({
    issuer: input.issuerName,
    audience: input.audience,
    publicKeys: input.publicKeys,
    revocations: input.revocations,
    clock: input.clock,
    clockSkewMs: input.clockSkewMs,
  });

  return {
    async verify(token: string, now?: Date): Promise<CapabilityGrant> {
      const grant = await base.verify(token, now);
      // AUDIT-F2: fail closed — a signed grant without a nonce would bypass
      // durable replay accounting entirely (nothing to consume). Reject in
      // production/enterprise profiles; the bundled issuer always sets one.
      if (!grant.nonce && isProductionOrEnterprise(process.env)) {
        throw new Error('Capability grant rejected: replay nonce required in production profile');
      }
      if (grant.nonce) {
        const replayed = await input.repository.consumeCapabilityReplay({
          tenantId: grant.tenantId,
          jti: grant.jti,
          nonce: grant.nonce,
          expiresAt: grant.expiresAt,
        });
        if (replayed) {
          throw new Error('Capability grant replayed');
        }
      }
      return grant;
    },
    async revoke(grant: CapabilityGrant): Promise<void> {
      await input.revocations.revokeGrant({
        jti: grant.jti,
        tenantId: grant.tenantId,
        expiresAt: grant.expiresAt,
      });
    },
  };
}

/**
 * Load stable signing authority from env + wire durable revocation/replay.
 * Production / enterprise / COMMANDER_REQUIRE_CAPABILITY_AUTHORITY=1 refuse
 * missing or invalid PEM/JWKS/key id (never call CapabilityTokenIssuer.generate).
 */
export function createCapabilityAuthority(
  env: CapabilityAuthorityEnv,
  repository: KernelRepository,
  options: CreateCapabilityAuthorityOptions = {},
): CapabilityAuthority {
  const issuerName = options.issuer ?? env[CAPABILITY_ISSUER_ENV]?.trim() ?? 'commander';
  const audience =
    options.audience ?? env[CAPABILITY_AUDIENCE_ENV]?.trim() ?? 'commander.effect-broker';
  const strict = isProductionOrEnterprise(env);
  const allowGenerate = options.allowGenerateOutsideProduction !== false && !strict;

  const pem = env[CAPABILITY_PRIVATE_KEY_PEM_ENV]?.trim();
  const keyId = env[CAPABILITY_KEY_ID_ENV]?.trim();
  const jwksJson = env[CAPABILITY_JWKS_JSON_ENV]?.trim();

  if (pem) assertNoPlaceholderContent(CAPABILITY_PRIVATE_KEY_PEM_ENV, pem);
  if (keyId) assertNoPlaceholderContent(CAPABILITY_KEY_ID_ENV, keyId);
  if (jwksJson) assertNoPlaceholderContent(CAPABILITY_JWKS_JSON_ENV, jwksJson);

  let privateKey: KeyObject;
  let publicKeys: Map<string, KeyLike>;
  let resolvedKeyId: string;
  let generated = false;

  if (!pem || !keyId || !jwksJson) {
    if (!allowGenerate) {
      const missing = [
        !pem ? CAPABILITY_PRIVATE_KEY_PEM_ENV : null,
        !keyId ? CAPABILITY_KEY_ID_ENV : null,
        !jwksJson ? CAPABILITY_JWKS_JSON_ENV : null,
      ].filter(Boolean);
      throw requiredError(`missing ${missing.join(', ')}`);
    }
    // Test/demo only — CapabilityTokenIssuer.generate remains available elsewhere.
    const pair = generateKeyPairSync('ed25519');
    privateKey = pair.privateKey;
    resolvedKeyId = keyId || 'generated';
    const jwk = publicJwkFromPrivate(privateKey, resolvedKeyId);
    publicKeys = new Map([
      [
        resolvedKeyId,
        createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: jwk.x! }, format: 'jwk' }),
      ],
    ]);
    generated = true;
  } else {
    privateKey = loadPrivateKey(pem);
    publicKeys = parseJwksPublicKeys(jwksJson);
    resolvedKeyId = keyId;
    assertPrivateMatchesJwks(privateKey, resolvedKeyId, publicKeys as Map<string, KeyObject>);
  }

  const issuer = new CapabilityTokenIssuer({
    issuer: issuerName,
    audience,
    keyId: resolvedKeyId,
    privateKey,
    clock: options.clock,
  });

  const revocations = new KernelCapabilityRevocationStore(repository);
  const verifier = createDurableTokenPort({
    issuerName,
    audience,
    publicKeys,
    repository,
    revocations,
    clock: options.clock,
    clockSkewMs: options.clockSkewMs,
  });

  return {
    keyId: resolvedKeyId,
    issuerName,
    audience,
    generated,
    issuer,
    verifier,
    revocations,
    publicKeys,
    replayForTenant(tenantId: string) {
      return KernelCapabilityReplayStore.forTenant(repository, tenantId);
    },
  };
}
