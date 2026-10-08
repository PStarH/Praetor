import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { Pool, PoolClient } from 'pg';
import { TASK1_DATABASE_ROLES } from './canonicalBootstrap.js';
import { observeTask1DatabasePeers } from './task1DatabasePeer.js';

const LOGINS = {
  'adapter-ops': 'commander_adapter_ops',
  app: 'commander_app',
  owner: 'commander_owner',
  scheduler: 'commander_scheduler',
  'tenant-authority': 'commander_tenant_authority',
  worker: 'commander_worker',
} as const;

function certificate(): X509Certificate {
  const directory = mkdtempSync(join(tmpdir(), 'commander-peer-cert-'));
  const key = join(directory, 'tls.key');
  const cert = join(directory, 'tls.crt');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-new',
      '-nodes',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:P-256',
      '-days',
      '2',
      '-subj',
      '/CN=db.example.test',
      '-addext',
      'subjectAltName=DNS:db.example.test',
      '-keyout',
      key,
      '-out',
      cert,
    ],
    { stdio: 'ignore' },
  );
  return new X509Certificate(readFileSync(cert));
}

class FakePool {
  constructor(
    private readonly login: string,
    private readonly cert: X509Certificate,
    private readonly databaseOid = '42',
    private readonly encrypted = true,
  ) {}
  async connect(): Promise<PoolClient> {
    return {
      connection: {
        stream: {
          encrypted: this.encrypted,
          getPeerCertificate: () => ({ raw: this.cert.raw }),
        },
      },
      query: async () => ({
        rows: [
          {
            current_user: this.login,
            session_user: this.login,
            database_oid: this.databaseOid,
            database_name: 'commander',
          },
        ],
        rowCount: 1,
      }),
      release: () => undefined,
    } as unknown as PoolClient;
  }
  async end(): Promise<void> {}
  on(): this {
    return this;
  }
}

const spkiOf = (cert: X509Certificate): string =>
  createHash('sha256')
    .update(cert.publicKey.export({ format: 'der', type: 'spki' }))
    .digest('hex');

function peerEnv(cert: X509Certificate, expectedSpki: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    COMMANDER_DATABASE_TLS_CA_FILE: '/run/ca.crt',
    COMMANDER_DATABASE_TLS_CA_MOUNT_IDENTITY: 'database-public-ca/v1',
    COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256: expectedSpki,
  };
  for (const role of TASK1_DATABASE_ROLES) {
    env[`COMMANDER_${role.toUpperCase().replace('-', '_')}_DATABASE_URL`] =
      `postgres://${LOGINS[role]}:secret@db.example.test/commander?sslmode=verify-full`;
  }
  return env;
}

const peerOptions = (
  cert: X509Certificate,
  overrides: { databaseOidFor?: (login: string) => string; encrypted?: boolean } = {},
): Parameters<typeof observeTask1DatabasePeers>[1] => ({
  readFile: (() => Buffer.from('ca')) as unknown as typeof import('node:fs').readFileSync,
  createPool: ((input) => {
    const login = decodeURIComponent(new URL(String(input.connectionString)).username);
    return new FakePool(
      login,
      cert,
      overrides.databaseOidFor?.(login) ?? '42',
      overrides.encrypted ?? true,
    ) as unknown as Pool;
  }) as typeof import('@praetor/postgres-runtime').createVerifiedPostgresPool,
});

describe('Task 1 six-role database peer observation', () => {
  it('binds every exact Commander login to one verified socket identity', async () => {
    const cert = certificate();
    const expectedSpki = spkiOf(cert);
    const env = peerEnv(cert, expectedSpki);
    const observation = await observeTask1DatabasePeers(env, peerOptions(cert));
    assert.deepEqual(
      observation.input.roles.map(({ role }) => role),
      [...TASK1_DATABASE_ROLES],
    );
    assert.deepEqual(
      observation.binding.roles.map(({ role }) => role),
      [...TASK1_DATABASE_ROLES],
    );
    assert.equal(new Set(observation.binding.roles.map(({ databaseOid }) => databaseOid)).size, 1);
    // The pin is the CA-derived SPKI, not whatever the fixture happens to return.
    assert.equal(
      observation.binding.roles.every(({ serverSpkiSha256 }) => serverSpkiSha256 === expectedSpki),
      true,
    );
  });

  // F-K2-7: the previous version computed the expected SPKI from the exact
  // certificate the fake pool returned and used one database_oid for every role,
  // so it was self-fulfilling — deleting the SPKI or OID binding would not have
  // failed it. These are the missing negative cases.
  it('rejects a server whose SPKI differs from the pinned expectation', async () => {
    const cert = certificate();
    const env = peerEnv(cert, 'f'.repeat(64));
    await assert.rejects(
      () => observeTask1DatabasePeers(env, peerOptions(cert)),
      /DATABASE_PEER_BINDING_INVALID/,
    );
  });

  it('rejects roles that do not all resolve to the same database OID', async () => {
    const cert = certificate();
    const env = peerEnv(cert, spkiOf(cert));
    await assert.rejects(
      () =>
        observeTask1DatabasePeers(
          env,
          peerOptions(cert, {
            databaseOidFor: (login) => (login === 'commander_worker' ? '43' : '42'),
          }),
        ),
      /DATABASE_PEER_BINDING_INVALID/,
    );
  });

  it('rejects a plaintext socket even when the certificate matches', async () => {
    const cert = certificate();
    const env = peerEnv(cert, spkiOf(cert));
    await assert.rejects(
      () => observeTask1DatabasePeers(env, peerOptions(cert, { encrypted: false })),
      /TASK1_DATABASE_PEER_TLS_SOCKET_REQUIRED/,
    );
  });
});
