import assert from 'node:assert/strict';
import { generateKeyPairSync, X509Certificate, createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rootCertificates } from 'node:tls';
import { describe, it } from 'node:test';
import {
  CAPABILITY_AUTHORITY_REQUIRED,
  CAPABILITY_JWKS_JSON_ENV,
  CAPABILITY_KEY_ID_ENV,
  CAPABILITY_PRIVATE_KEY_PEM_ENV,
} from '@praetor/kernel';
import { InMemoryKernelRepository } from '@praetor/kernel/testing/inMemoryRepository';
import { Pool } from 'pg';
import {
  assertDurableCapabilityStores,
  assertNonOwnerDatabaseRole,
  assertNonOwnerDatabaseUrl,
  CAPABILITY_DURABLE_STORES_REQUIRED,
  createWorkerEvidenceSigner,
  createEffectBroker,
  createWorkerService,
  EVIDENCE_REPOSITORY_REQUIRED,
  EVIDENCE_SIGNING_KEY_ID_ENV,
  EVIDENCE_SIGNING_PRIVATE_KEY_PEM_ENV,
  OWNER_DATABASE_ROLE_REJECTED,
  productionCapabilityBrokerOptions,
  withDefaultLlmAllowlist,
} from './bootstrap.js';

function ed25519Material(kid: string): {
  privateKeyPem: string;
  jwksJson: string;
  keyId: string;
} {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const jwk = publicKey.export({ format: 'jwk' }) as { x?: string };
  const jwksJson = JSON.stringify({
    keys: [{ kty: 'OKP', crv: 'Ed25519', kid, x: jwk.x, alg: 'EdDSA', use: 'sig' }],
  });
  return { privateKeyPem, jwksJson, keyId: kid };
}

function productionEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    ...overrides,
  } as NodeJS.ProcessEnv;
}

describe('worker-plane authority startup gates', () => {
  it('requires stable evidence signing material in production', async () => {
    assert.throws(
      () => createWorkerEvidenceSigner(productionEnv()),
      /EVIDENCE_SIGNING_KEY_REQUIRED/,
    );
    const material = ed25519Material('evidence-cell-1');
    const first = createWorkerEvidenceSigner(
      productionEnv({
        [EVIDENCE_SIGNING_PRIVATE_KEY_PEM_ENV]: material.privateKeyPem,
        [EVIDENCE_SIGNING_KEY_ID_ENV]: material.keyId,
      }),
    );
    const second = createWorkerEvidenceSigner(
      productionEnv({
        [EVIDENCE_SIGNING_PRIVATE_KEY_PEM_ENV]: material.privateKeyPem,
        [EVIDENCE_SIGNING_KEY_ID_ENV]: material.keyId,
      }),
    );
    assert.ok(first && second);
    const signature = await first.sign('{"worker":1}');
    assert.equal(second.verify('{"worker":1}', signature), true);

    const capability = ed25519Material('capability-cell-1');
    const repository = new InMemoryKernelRepository();
    Object.defineProperty(repository, 'completeEffectWithEvidence', { value: undefined });
    const env = productionEnv({
      [CAPABILITY_PRIVATE_KEY_PEM_ENV]: capability.privateKeyPem,
      [CAPABILITY_KEY_ID_ENV]: capability.keyId,
      [CAPABILITY_JWKS_JSON_ENV]: capability.jwksJson,
    });
    assert.throws(
      () => createEffectBroker(repository as never, 'worker-1', env, first),
      new RegExp(EVIDENCE_REPOSITORY_REQUIRED),
    );
  });

  it('preserves the signed evidence authority surface through the policy wrapper', () => {
    const repository = new InMemoryKernelRepository();
    const port = withDefaultLlmAllowlist(repository);

    assert.equal(typeof port.completeEffectWithEvidence, 'function');
    assert.equal(typeof port.failEffectWithEvidence, 'function');
    assert.equal(typeof port.listEffectsForRun, 'function');
    assert.equal(typeof port.listEvents, 'function');
  });

  it('rejects an incomplete signed evidence authority before worker polling', () => {
    const capability = ed25519Material('capability-evidence-contract');
    const evidence = ed25519Material('evidence-contract');
    const signer = createWorkerEvidenceSigner(
      productionEnv({
        [EVIDENCE_SIGNING_PRIVATE_KEY_PEM_ENV]: evidence.privateKeyPem,
        [EVIDENCE_SIGNING_KEY_ID_ENV]: evidence.keyId,
      }),
    );
    assert.ok(signer);
    const env = productionEnv({
      [CAPABILITY_PRIVATE_KEY_PEM_ENV]: capability.privateKeyPem,
      [CAPABILITY_KEY_ID_ENV]: capability.keyId,
      [CAPABILITY_JWKS_JSON_ENV]: capability.jwksJson,
    });

    for (const method of [
      'completeEffectWithEvidence',
      'failEffectWithEvidence',
      'listEffectsForRun',
      'listEvents',
    ] as const) {
      const repository = new InMemoryKernelRepository();
      Object.defineProperty(repository, method, { value: undefined });
      assert.throws(
        () => createEffectBroker(repository as never, 'worker-1', env, signer),
        new RegExp(EVIDENCE_REPOSITORY_REQUIRED),
        method,
      );
    }
  });

  it('rejects missing private key before poll (production)', () => {
    const mat = ed25519Material('kid-wp');
    const repo = new InMemoryKernelRepository();
    assert.throws(
      () =>
        createEffectBroker(
          repo as never,
          'worker-1',
          productionEnv({
            [CAPABILITY_KEY_ID_ENV]: mat.keyId,
            [CAPABILITY_JWKS_JSON_ENV]: mat.jwksJson,
          }),
        ),
      (err: unknown) =>
        err instanceof Error &&
        err.message.startsWith(CAPABILITY_AUTHORITY_REQUIRED) &&
        err.message.includes(CAPABILITY_PRIVATE_KEY_PEM_ENV),
    );
  });

  it('rejects missing JWKS before poll (production)', () => {
    const mat = ed25519Material('kid-wp');
    const repo = new InMemoryKernelRepository();
    assert.throws(
      () =>
        createEffectBroker(
          repo as never,
          'worker-1',
          productionEnv({
            [CAPABILITY_PRIVATE_KEY_PEM_ENV]: mat.privateKeyPem,
            [CAPABILITY_KEY_ID_ENV]: mat.keyId,
          }),
        ),
      (err: unknown) =>
        err instanceof Error &&
        err.message.startsWith(CAPABILITY_AUTHORITY_REQUIRED) &&
        err.message.includes(CAPABILITY_JWKS_JSON_ENV),
    );
  });

  it('rejects missing key id before poll (production)', () => {
    const mat = ed25519Material('kid-wp');
    const repo = new InMemoryKernelRepository();
    assert.throws(
      () =>
        createEffectBroker(
          repo as never,
          'worker-1',
          productionEnv({
            [CAPABILITY_PRIVATE_KEY_PEM_ENV]: mat.privateKeyPem,
            [CAPABILITY_JWKS_JSON_ENV]: mat.jwksJson,
          }),
        ),
      (err: unknown) =>
        err instanceof Error &&
        err.message.startsWith(CAPABILITY_AUTHORITY_REQUIRED) &&
        err.message.includes(CAPABILITY_KEY_ID_ENV),
    );
  });

  it('rejects missing evidence signing key before broker startup', () => {
    const mat = ed25519Material('kid-evidence-required');
    const repo = new InMemoryKernelRepository();
    assert.throws(
      () =>
        createEffectBroker(
          repo as never,
          'worker-1',
          productionEnv({
            [CAPABILITY_PRIVATE_KEY_PEM_ENV]: mat.privateKeyPem,
            [CAPABILITY_KEY_ID_ENV]: mat.keyId,
            [CAPABILITY_JWKS_JSON_ENV]: mat.jwksJson,
          }),
        ),
      /EVIDENCE_SIGNING_KEY_REQUIRED/,
    );
  });

  it('rejects owner-role DSN userinfo (no false-positive on commander_worker)', () => {
    assert.throws(
      () =>
        assertNonOwnerDatabaseUrl(
          'postgres://commander_owner:commander_owner@postgres:5432/commander',
        ),
      (err: unknown) =>
        err instanceof Error && err.message.startsWith(OWNER_DATABASE_ROLE_REJECTED),
    );
    assert.throws(
      () => assertNonOwnerDatabaseUrl('postgresql://commander_owner@127.0.0.1/db'),
      /OWNER_DATABASE_ROLE_REJECTED/,
    );
    // Task 1 worker-url must not false-positive.
    assert.doesNotThrow(() =>
      assertNonOwnerDatabaseUrl(
        'postgres://commander_worker:commander_worker@postgres:5432/commander',
      ),
    );
    assert.doesNotThrow(() =>
      assertNonOwnerDatabaseUrl('postgres://commander_app:commander_app@postgres:5432/commander'),
    );
  });

  it('rejects post-connect current_user matching owner', () => {
    assert.throws(
      () => assertNonOwnerDatabaseRole('commander_owner'),
      (err: unknown) =>
        err instanceof Error && err.message.startsWith(OWNER_DATABASE_ROLE_REJECTED),
    );
    assert.doesNotThrow(() => assertNonOwnerDatabaseRole('commander_worker'));
  });

  it('rejects unavailable replay store before poll', () => {
    const mat = ed25519Material('kid-replay');
    const repo = new InMemoryKernelRepository();
    const { capability } = createEffectBroker(
      repo as never,
      'worker-1',
      productionEnv({
        [CAPABILITY_PRIVATE_KEY_PEM_ENV]: mat.privateKeyPem,
        [CAPABILITY_KEY_ID_ENV]: mat.keyId,
        [CAPABILITY_JWKS_JSON_ENV]: mat.jwksJson,
        [EVIDENCE_SIGNING_PRIVATE_KEY_PEM_ENV]: mat.privateKeyPem,
        [EVIDENCE_SIGNING_KEY_ID_ENV]: 'evidence-replay',
      }),
    );
    assert.throws(
      () =>
        assertDurableCapabilityStores(capability, {
          isCapabilityRevoked: () => false,
          revokeCapability: async () => undefined,
          // consumeCapabilityReplay intentionally absent
        }),
      (err: unknown) =>
        err instanceof Error &&
        err.message.startsWith(CAPABILITY_DURABLE_STORES_REQUIRED) &&
        err.message.includes('consumeCapabilityReplay'),
    );
  });

  it('rejects unavailable revocation store before poll', () => {
    const mat = ed25519Material('kid-rev');
    const repo = new InMemoryKernelRepository();
    const { capability } = createEffectBroker(
      repo as never,
      'worker-1',
      productionEnv({
        [CAPABILITY_PRIVATE_KEY_PEM_ENV]: mat.privateKeyPem,
        [CAPABILITY_KEY_ID_ENV]: mat.keyId,
        [CAPABILITY_JWKS_JSON_ENV]: mat.jwksJson,
        [EVIDENCE_SIGNING_PRIVATE_KEY_PEM_ENV]: mat.privateKeyPem,
        [EVIDENCE_SIGNING_KEY_ID_ENV]: 'evidence-revocation',
      }),
    );
    assert.throws(
      () =>
        assertDurableCapabilityStores(capability, {
          consumeCapabilityReplay: async () => false,
          // isCapabilityRevoked / revokeCapability intentionally absent
        }),
      (err: unknown) =>
        err instanceof Error &&
        err.message.startsWith(CAPABILITY_DURABLE_STORES_REQUIRED) &&
        /isCapabilityRevoked|revokeCapability/.test(err.message),
    );
  });

  it('wires durable replay + revocations on EffectBroker options (no generate path)', () => {
    const mat = ed25519Material('kid-ok');
    const repo = new InMemoryKernelRepository();
    const { capability, issuer, broker } = createEffectBroker(
      repo as never,
      'worker-1',
      productionEnv({
        [CAPABILITY_PRIVATE_KEY_PEM_ENV]: mat.privateKeyPem,
        [CAPABILITY_KEY_ID_ENV]: mat.keyId,
        [CAPABILITY_JWKS_JSON_ENV]: mat.jwksJson,
        [EVIDENCE_SIGNING_PRIVATE_KEY_PEM_ENV]: mat.privateKeyPem,
        [EVIDENCE_SIGNING_KEY_ID_ENV]: 'evidence-ok',
      }),
    );
    assert.equal(capability.generated, false);
    assert.ok(issuer);
    assert.ok(broker);
    const opts = productionCapabilityBrokerOptions(capability, 'worker-1');
    assert.ok(opts.replay);
    assert.equal(typeof opts.replay, 'function');
    assert.ok(opts.revocations);
    assert.equal(opts.requireDurableCapabilityStores, true);
    assert.equal(opts.requireOperationsReadiness, true);
    assert.equal(opts.requireRequestBinding, true);
    assert.equal(opts.localWorkerId, 'worker-1');
  });
});

describe('createWorkerService pool lifecycle (WP-11)', () => {
  it('releases the verified pool when assembly fails after the pool is created', async () => {
    // The pool must be a real verified pool so the failure lands *after* it exists:
    // a valid TLS fixture lets pool construction succeed, then the owner-role probe
    // fails against a refused port — exactly the path that used to leak the pool.
    const pem = rootCertificates[0];
    assert.ok(pem, 'Node must provide at least one trusted root certificate');
    const directory = mkdtempSync(join(tmpdir(), 'commander-worker-plane-'));
    const caFile = join(directory, 'ca.pem');
    writeFileSync(caFile, pem, { mode: 0o600 });
    const spki = new X509Certificate(pem).publicKey.export({ format: 'der', type: 'spki' });
    const spkiSha256 = createHash('sha256').update(spki).digest('hex');

    const ended: Pool[] = [];
    const originalEnd = Pool.prototype.end as unknown as (...args: unknown[]) => unknown;
    Pool.prototype.end = function patchedEnd(this: Pool, ...args: unknown[]) {
      ended.push(this);
      return originalEnd.apply(this, args);
    } as unknown as typeof Pool.prototype.end;

    const keys = [
      'DATABASE_URL',
      'COMMANDER_WORKER_TENANTS',
      'COMMANDER_WORKER_AUTH_TOKEN',
      'COMMANDER_DATABASE_TLS_CA_FILE',
      'COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256',
      'NODE_ENV',
      'COMMANDER_PROFILE',
      'COMMANDER_REQUIRE_EFFECT_BROKER',
      'COMMANDER_REQUIRE_WORKLOAD_BINDING',
    ] as const;
    const previous = new Map<string, string | undefined>(
      keys.map((key) => [key, process.env[key]]),
    );
    process.env.DATABASE_URL =
      'postgres://commander_worker:pw@127.0.0.1:1/commander?sslmode=verify-full';
    process.env.COMMANDER_WORKER_TENANTS = 'tenant-a';
    process.env.COMMANDER_WORKER_AUTH_TOKEN = 'test-token';
    process.env.COMMANDER_DATABASE_TLS_CA_FILE = caFile;
    process.env.COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256 = spkiSha256;
    process.env.NODE_ENV = 'test';
    delete process.env.COMMANDER_PROFILE;
    delete process.env.COMMANDER_REQUIRE_EFFECT_BROKER;
    delete process.env.COMMANDER_REQUIRE_WORKLOAD_BINDING;

    try {
      await assert.rejects(createWorkerService(), /ECONNREFUSED|EADDRNOTAVAIL|connect/i);
    } finally {
      Pool.prototype.end = originalEnd as unknown as typeof Pool.prototype.end;
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(directory, { recursive: true, force: true });
    }

    assert.equal(ended.length, 1, 'the verified pool must be ended on the failure path');
    assert.ok(ended[0] instanceof Pool, 'the ended pool must be the worker verified pool');
  });
});
