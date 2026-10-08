import { createHash, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { createVerifiedPostgresPool } from '@praetor/postgres-runtime';
import type { Pool, PoolClient } from 'pg';
import {
  TASK1_DATABASE_ROLES,
  createDatabasePeerBinding,
  createDatabasePeerBindingInput,
  verifyDatabasePeerBinding,
  type DatabasePeerBindingInputV1,
  type DatabasePeerBindingRoleV1,
  type DatabasePeerBindingV1,
  type Task1DatabaseRole,
} from './canonicalBootstrap.js';

const ROLE_URL_ENV: Readonly<Record<Task1DatabaseRole, string>> = {
  'adapter-ops': 'COMMANDER_ADAPTER_OPS_DATABASE_URL',
  app: 'COMMANDER_APP_DATABASE_URL',
  owner: 'COMMANDER_OWNER_DATABASE_URL',
  scheduler: 'COMMANDER_SCHEDULER_DATABASE_URL',
  'tenant-authority': 'COMMANDER_TENANT_AUTHORITY_DATABASE_URL',
  worker: 'COMMANDER_WORKER_DATABASE_URL',
};

const ROLE_LOGIN: Readonly<Record<Task1DatabaseRole, string>> = {
  'adapter-ops': 'commander_adapter_ops',
  app: 'commander_app',
  owner: 'commander_owner',
  scheduler: 'commander_scheduler',
  'tenant-authority': 'commander_tenant_authority',
  worker: 'commander_worker',
};

interface PeerCertificateSocket {
  getPeerCertificate(detailed?: boolean): { raw?: Buffer };
  encrypted?: boolean;
}

interface PgTlsClient extends PoolClient {
  connection?: { stream?: PeerCertificateSocket };
}

export interface Task1DatabasePeerObservation {
  input: DatabasePeerBindingInputV1;
  binding: DatabasePeerBindingV1;
}

export interface Task1DatabasePeerObserverOptions {
  createPool?: typeof createVerifiedPostgresPool;
  readFile?: typeof readFileSync;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`TASK1_DATABASE_PEER_${name}_REQUIRED`);
  return value;
}

function parsedRoleUrl(env: NodeJS.ProcessEnv, role: Task1DatabaseRole): URL {
  let url: URL;
  try {
    url = new URL(required(env, ROLE_URL_ENV[role]));
  } catch {
    throw new Error(`TASK1_DATABASE_PEER_${role.toUpperCase().replace('-', '_')}_URL_INVALID`);
  }
  if (
    (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') ||
    decodeURIComponent(url.username) !== ROLE_LOGIN[role] ||
    !url.password ||
    !url.hostname ||
    !url.pathname.slice(1)
  ) {
    throw new Error(`TASK1_DATABASE_PEER_${role.toUpperCase().replace('-', '_')}_URL_INVALID`);
  }
  return url;
}

function peerCertificate(client: PoolClient): X509Certificate {
  const stream = (client as PgTlsClient).connection?.stream;
  const raw = stream?.getPeerCertificate(true).raw;
  if (stream?.encrypted !== true || !raw?.length) {
    throw new Error('TASK1_DATABASE_PEER_TLS_SOCKET_REQUIRED');
  }
  try {
    return new X509Certificate(raw);
  } catch {
    throw new Error('TASK1_DATABASE_PEER_CERTIFICATE_INVALID');
  }
}

function certificateSans(certificate: X509Certificate): { dns: string[]; ip: string[] } {
  const dns: string[] = [];
  const ip: string[] = [];
  for (const entry of certificate.subjectAltName?.split(', ') ?? []) {
    if (entry.startsWith('DNS:')) dns.push(entry.slice(4));
    else if (entry.startsWith('IP Address:')) ip.push(entry.slice('IP Address:'.length));
  }
  if (dns.length === 0 && ip.length === 0) {
    throw new Error('TASK1_DATABASE_PEER_CERTIFICATE_SAN_REQUIRED');
  }
  return { dns, ip };
}

function certificateSpkiSha256(certificate: X509Certificate): string {
  return createHash('sha256')
    .update(certificate.publicKey.export({ format: 'der', type: 'spki' }))
    .digest('hex');
}

async function observeRole(
  role: Task1DatabaseRole,
  url: URL,
  env: NodeJS.ProcessEnv,
  createPool: typeof createVerifiedPostgresPool,
): Promise<DatabasePeerBindingRoleV1> {
  const pool: Pool = createPool(
    {
      connectionString: url.toString(),
      max: 1,
      connectionTimeoutMillis: 2_000,
      query_timeout: 2_000,
      statement_timeout: 1_500,
    },
    env,
  );
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    const result = await client.query<{
      current_user: string;
      session_user: string;
      database_oid: string;
      database_name: string;
    }>(`
      SELECT current_user::text AS current_user,
             session_user::text AS session_user,
             database.oid::text AS database_oid,
             pg_catalog.current_database()::text AS database_name
        FROM pg_catalog.pg_database AS database
       WHERE database.datname = pg_catalog.current_database()
    `);
    const row = result.rows[0];
    if (
      result.rowCount !== 1 ||
      row?.current_user !== ROLE_LOGIN[role] ||
      row.session_user !== ROLE_LOGIN[role] ||
      !/^[1-9][0-9]*$/.test(row.database_oid) ||
      row.database_name !== decodeURIComponent(url.pathname.slice(1))
    ) {
      throw new Error('TASK1_DATABASE_PEER_ROLE_IDENTITY_INVALID');
    }
    const certificate = peerCertificate(client);
    return {
      role,
      host: isIP(url.hostname) ? url.hostname : url.hostname.toLowerCase(),
      port: Number(url.port || '5432'),
      tlsServerSans: certificateSans(certificate),
      serverSpkiSha256: certificateSpkiSha256(certificate),
      databaseOid: row.database_oid,
      databaseName: row.database_name,
    };
  } finally {
    client?.release();
    await pool.end();
  }
}

export async function observeTask1DatabasePeers(
  env: NodeJS.ProcessEnv = process.env,
  options: Task1DatabasePeerObserverOptions = {},
): Promise<Task1DatabasePeerObservation> {
  const createPool = options.createPool ?? createVerifiedPostgresPool;
  const readFile = options.readFile ?? readFileSync;
  const caPath = required(env, 'COMMANDER_DATABASE_TLS_CA_FILE');
  const expectedServerSpkiSha256 = required(
    env,
    'COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256',
  );
  const urls = Object.fromEntries(
    TASK1_DATABASE_ROLES.map((role) => [role, parsedRoleUrl(env, role)]),
  ) as Record<Task1DatabaseRole, URL>;
  const input = createDatabasePeerBindingInput({
    roles: TASK1_DATABASE_ROLES.map((role) => ({
      role,
      host: urls[role].hostname,
      port: Number(urls[role].port || '5432'),
    })),
    expectedServerSpkiSha256,
    ca: {
      mountIdentity: required(env, 'COMMANDER_DATABASE_TLS_CA_MOUNT_IDENTITY'),
      path: caPath,
      publicBytesSha256: createHash('sha256').update(readFile(caPath)).digest('hex'),
    },
  });
  const binding = createDatabasePeerBinding({
    roles: await Promise.all(
      TASK1_DATABASE_ROLES.map((role) => observeRole(role, urls[role], env, createPool)),
    ),
  });
  verifyDatabasePeerBinding(input, binding);
  return { input, binding };
}
