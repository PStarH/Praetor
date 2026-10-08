import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import {
  buildVerifiedPostgresPoolConfig,
  type VerifiedPostgresPoolInput,
} from '@praetor/postgres-runtime';
import type { ShadowManifestTrust } from './report.js';

import type { ShadowDatabaseOperation } from './repository.js';
export type { ShadowDatabaseOperation } from './repository.js';

export interface ShadowStartupConfig {
  poolInput: VerifiedPostgresPoolInput;
  tenantId: string;
  retentionDays: number;
  ingestionAttestationKey?: Buffer;
  trustedManifestPublicKeys: ReadonlyMap<string, ShadowManifestTrust>;
  reportSigning?: { keyId: string; privateKey: KeyObject };
  cleanupFreshnessMinutes: number;
}

const IDENTIFIER = /^[\x21-\x7e]{1,128}$/;
const PLACEHOLDER = /^(?:replace[_-]?me|change[_-]?me|example|placeholder|public)$/i;

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

function identifier(env: NodeJS.ProcessEnv, name: string): string {
  const value = required(env, name);
  if (!IDENTIFIER.test(value)) throw new Error(`${name}_INVALID`);
  if (PLACEHOLDER.test(value)) throw new Error(`${name}_PLACEHOLDER`);
  return value;
}

function boundedInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const raw = required(env, name);
  if (!/^\d+$/.test(raw)) throw new Error(`${name}_INVALID`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name}_INVALID`);
  }
  return value;
}

function manifestKeys(env: NodeJS.ProcessEnv): ReadonlyMap<string, ShadowManifestTrust> {
  const raw = required(env, 'COMMANDER_SHADOW_TRUSTED_MANIFEST_KEYS_JSON');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('COMMANDER_SHADOW_TRUSTED_MANIFEST_KEYS_JSON_INVALID');
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('COMMANDER_SHADOW_TRUSTED_MANIFEST_KEYS_JSON_INVALID');
  }
  const result = new Map<string, ShadowManifestTrust>();
  for (const value of parsed) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('COMMANDER_SHADOW_MANIFEST_KEY_INVALID');
    }
    const record = value as Record<string, unknown>;
    const keyId = record.keyId;
    if (
      Object.keys(record).sort().join('\0') !==
        ['algorithm', 'keyId', 'publicKeyPem', 'status'].sort().join('\0') ||
      record.algorithm !== 'Ed25519' ||
      typeof keyId !== 'string' ||
      !IDENTIFIER.test(keyId) ||
      PLACEHOLDER.test(keyId) ||
      (record.status !== 'active' && record.status !== 'revoked') ||
      typeof record.publicKeyPem !== 'string' ||
      result.has(keyId)
    ) {
      throw new Error('COMMANDER_SHADOW_MANIFEST_KEY_INVALID');
    }
    try {
      const key = createPublicKey(record.publicKeyPem);
      if (key.asymmetricKeyType !== 'ed25519') throw new Error('wrong type');
      result.set(keyId, {
        algorithm: 'Ed25519',
        keyId,
        status: record.status,
        publicKey: key,
      });
    } catch {
      throw new Error('COMMANDER_SHADOW_MANIFEST_KEY_INVALID');
    }
  }
  return result;
}

function reportSigning(env: NodeJS.ProcessEnv): { keyId: string; privateKey: KeyObject } {
  const keyId = identifier(env, 'COMMANDER_SHADOW_REPORT_SIGNING_KEY_ID');
  const pem = required(env, 'COMMANDER_SHADOW_REPORT_SIGNING_PRIVATE_KEY_PEM');
  try {
    const privateKey = createPrivateKey(pem);
    if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('wrong type');
    return { keyId, privateKey };
  } catch {
    throw new Error('COMMANDER_SHADOW_REPORT_SIGNING_PRIVATE_KEY_PEM_INVALID');
  }
}

export function loadShadowStartupConfig(
  operation: ShadowDatabaseOperation,
  env: NodeJS.ProcessEnv = process.env,
): ShadowStartupConfig {
  const attestationKeyHex = env.COMMANDER_SHADOW_INGESTION_ATTESTATION_KEY_HEX;
  if (attestationKeyHex !== undefined && !/^[0-9a-f]{64}$/.test(attestationKeyHex)) {
    throw new Error('COMMANDER_SHADOW_INGESTION_ATTESTATION_KEY_HEX_INVALID');
  }
  // The DSN (which carries credentials) lives only inside poolInput; it is not
  // copied onto the returned config, so logging/serializing the config cannot
  // leak a plaintext connection string.
  const databaseUrl = required(env, 'COMMANDER_SHADOW_DATABASE_URL');
  const poolInput: VerifiedPostgresPoolInput = { connectionString: databaseUrl, max: 4 };
  // The verified pool config is built here purely to fail closed at config time:
  // its builder is what reads the trusted CA, requires the pinned server SPKI,
  // and enforces sslmode=verify-full on the DSN. The config value itself is
  // discarded — pool construction belongs to createVerifiedPostgresPool, which
  // is the single factory this repository allows to construct a pg.Pool.
  buildVerifiedPostgresPoolConfig(poolInput, env);
  return {
    ...(attestationKeyHex === undefined
      ? {}
      : { ingestionAttestationKey: Buffer.from(attestationKeyHex, 'hex') }),
    poolInput,
    tenantId: identifier(env, 'COMMANDER_SHADOW_TENANT_ID'),
    retentionDays: boundedInteger(env, 'COMMANDER_SHADOW_RETENTION_DAYS', 1, 30),
    trustedManifestPublicKeys: manifestKeys(env),
    ...(operation === 'report-export' ? { reportSigning: reportSigning(env) } : {}),
    cleanupFreshnessMinutes: boundedInteger(
      env,
      'COMMANDER_SHADOW_CLEANUP_FRESHNESS_MINUTES',
      1,
      120,
    ),
  };
}
