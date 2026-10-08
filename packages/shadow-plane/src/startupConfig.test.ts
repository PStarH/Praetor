import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, X509Certificate } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rootCertificates } from 'node:tls';
import { describe, it } from 'node:test';
import { buildVerifiedPostgresPoolConfig } from '@praetor/postgres-runtime';
import { loadShadowStartupConfig } from './startupConfig.js';

function validEnvironment(): NodeJS.ProcessEnv {
  const certificate = new X509Certificate(rootCertificates[0]!);
  const directory = mkdtempSync(join(tmpdir(), 'commander-shadow-config-'));
  const caFile = join(directory, 'ca.pem');
  writeFileSync(caFile, certificate.toString(), { mode: 0o600 });
  const spki = certificate.publicKey.export({ format: 'der', type: 'spki' });
  const manifestKey = generateKeyPairSync('ed25519');
  const reportKey = generateKeyPairSync('ed25519');
  return {
    COMMANDER_DATABASE_TLS_CA_FILE: caFile,
    COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256: createHash('sha256')
      .update(spki)
      .digest('hex'),
    COMMANDER_SHADOW_DATABASE_URL:
      'postgres://shadow:secret@db.internal/shadow?sslmode=verify-full',
    COMMANDER_SHADOW_TENANT_ID: 'tenant-1',
    COMMANDER_SHADOW_RETENTION_DAYS: '14',
    COMMANDER_SHADOW_TRUSTED_MANIFEST_KEYS_JSON: JSON.stringify([
      {
        algorithm: 'Ed25519',
        keyId: 'manifest-key-1',
        status: 'active',
        publicKeyPem: manifestKey.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
      },
    ]),
    COMMANDER_SHADOW_REPORT_SIGNING_KEY_ID: 'report-key-1',
    COMMANDER_SHADOW_REPORT_SIGNING_PRIVATE_KEY_PEM: reportKey.privateKey
      .export({ format: 'pem', type: 'pkcs8' })
      .toString(),
    COMMANDER_SHADOW_CLEANUP_FRESHNESS_MINUTES: '90',
  };
}

describe('shadow startup configuration', () => {
  it('does not load report signing material for other database operations', () => {
    const env = validEnvironment();
    delete env.COMMANDER_SHADOW_REPORT_SIGNING_KEY_ID;
    delete env.COMMANDER_SHADOW_REPORT_SIGNING_PRIVATE_KEY_PEM;
    for (const operation of [
      'manifest-register',
      'import',
      'batch-close',
      'campaign-withdraw',
      'retention-run',
      'status',
    ] as const) {
      assert.equal(loadShadowStartupConfig(operation, env).reportSigning, undefined);
      assert.equal(
        loadShadowStartupConfig(operation, {
          ...env,
          COMMANDER_SHADOW_REPORT_SIGNING_KEY_ID: 'replace-me',
          COMMANDER_SHADOW_REPORT_SIGNING_PRIVATE_KEY_PEM: 'invalid',
        }).reportSigning,
        undefined,
      );
    }
  });

  it('rejects invalid signing material for report export', () => {
    const env = validEnvironment();
    assert.throws(
      () =>
        loadShadowStartupConfig('report-export', {
          ...env,
          COMMANDER_SHADOW_REPORT_SIGNING_PRIVATE_KEY_PEM: 'invalid',
        }),
      /COMMANDER_SHADOW_REPORT_SIGNING_PRIVATE_KEY_PEM_INVALID/,
    );
  });

  it('validates an independent 256-bit ingestion key without requiring it for readers', () => {
    const env = validEnvironment();
    assert.equal(loadShadowStartupConfig('report-export', env).ingestionAttestationKey, undefined);
    for (const key of ['', 'replace-me', 'aa'.repeat(31), 'gg'.repeat(32)]) {
      assert.throws(
        () =>
          loadShadowStartupConfig('report-export', {
            ...env,
            COMMANDER_SHADOW_INGESTION_ATTESTATION_KEY_HEX: key,
          }),
        /COMMANDER_SHADOW_INGESTION_ATTESTATION_KEY_HEX_INVALID/,
      );
    }
    assert.deepEqual(
      loadShadowStartupConfig('report-export', {
        ...env,
        COMMANDER_SHADOW_INGESTION_ATTESTATION_KEY_HEX: 'ab'.repeat(32),
      }).ingestionAttestationKey,
      Buffer.alloc(32, 0xab),
    );
  });

  it('does not expose a second plaintext database URL on the returned config', () => {
    const config = loadShadowStartupConfig('status', validEnvironment());
    assert.equal(
      Object.hasOwn(config, 'databaseUrl'),
      false,
      'the DSN must live only inside poolInput, not as a printable config field',
    );
  });
  it('requires every authoritative credential and policy setting', () => {
    const valid = validEnvironment();
    for (const name of [
      'COMMANDER_SHADOW_DATABASE_URL',
      'COMMANDER_SHADOW_TENANT_ID',
      'COMMANDER_SHADOW_RETENTION_DAYS',
      'COMMANDER_SHADOW_TRUSTED_MANIFEST_KEYS_JSON',
      'COMMANDER_SHADOW_REPORT_SIGNING_KEY_ID',
      'COMMANDER_SHADOW_REPORT_SIGNING_PRIVATE_KEY_PEM',
      'COMMANDER_SHADOW_CLEANUP_FRESHNESS_MINUTES',
    ]) {
      const env = { ...valid };
      delete env[name];
      assert.throws(
        () => loadShadowStartupConfig('report-export', env),
        new RegExp(`${name}_REQUIRED`),
      );
    }
  });

  it('returns validated Ed25519 material and a verified pool config', () => {
    const config = loadShadowStartupConfig('report-export', validEnvironment());
    assert.equal(config.tenantId, 'tenant-1');
    assert.equal(config.retentionDays, 14);
    assert.equal(config.cleanupFreshnessMinutes, 90);
    assert.equal(config.trustedManifestPublicKeys.get('manifest-key-1')?.keyId, 'manifest-key-1');
    assert.equal(config.trustedManifestPublicKeys.get('manifest-key-1')?.status, 'active');
    assert.equal(
      config.trustedManifestPublicKeys.get('manifest-key-1')?.publicKey.asymmetricKeyType,
      'ed25519',
    );
    assert.equal(config.reportSigning?.privateKey.asymmetricKeyType, 'ed25519');
    // The DSN is verified at config time and again when the pool is built; the
    // builder is the single source of the TLS material.
    assert.equal(
      typeof buildVerifiedPostgresPoolConfig(config.poolInput, validEnvironment()).ssl,
      'object',
    );
  });

  it('rejects placeholders, invalid bounds, malformed keys, and unverified DSNs', () => {
    assert.throws(
      () =>
        loadShadowStartupConfig('report-export', {
          ...validEnvironment(),
          COMMANDER_SHADOW_TENANT_ID: 'REPLACE_ME',
        }),
      /COMMANDER_SHADOW_TENANT_ID_PLACEHOLDER/,
    );
    assert.throws(
      () =>
        loadShadowStartupConfig('report-export', {
          ...validEnvironment(),
          COMMANDER_SHADOW_RETENTION_DAYS: '31',
        }),
      /COMMANDER_SHADOW_RETENTION_DAYS_INVALID/,
    );
    assert.throws(
      () =>
        loadShadowStartupConfig('report-export', {
          ...validEnvironment(),
          COMMANDER_SHADOW_CLEANUP_FRESHNESS_MINUTES: '0',
        }),
      /COMMANDER_SHADOW_CLEANUP_FRESHNESS_MINUTES_INVALID/,
    );
    assert.throws(
      () =>
        loadShadowStartupConfig('report-export', {
          ...validEnvironment(),
          COMMANDER_SHADOW_TRUSTED_MANIFEST_KEYS_JSON: '[]',
        }),
      /COMMANDER_SHADOW_TRUSTED_MANIFEST_KEYS_JSON_INVALID/,
    );
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    assert.throws(
      () =>
        loadShadowStartupConfig('report-export', {
          ...validEnvironment(),
          COMMANDER_SHADOW_TRUSTED_MANIFEST_KEYS_JSON: JSON.stringify([
            {
              algorithm: 'Ed25519',
              keyId: 'bad',
              status: 'active',
              publicKeyPem: rsa.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
            },
          ]),
        }),
      /COMMANDER_SHADOW_MANIFEST_KEY_INVALID/,
    );
    assert.throws(
      () =>
        loadShadowStartupConfig('report-export', {
          ...validEnvironment(),
          COMMANDER_SHADOW_DATABASE_URL: 'postgres://shadow:secret@db.internal/shadow',
        }),
      /COMMANDER_DATABASE_SSLMODE_VERIFY_FULL_REQUIRED/,
    );
  });
});
