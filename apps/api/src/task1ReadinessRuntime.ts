import { createPublicKey, X509Certificate } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import { isAbsolute } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createSecureContext } from 'node:tls';
import { createVerifiedPostgresPool } from '@praetor/postgres-runtime';
import type { Pool } from 'pg';
import {
  TASK1_READINESS_PROOF_PATH,
  Task1ReadinessProof,
  type Task1RuntimeIdentity,
} from './task1ReadinessProof.js';

const READINESS_TENANT = 'commander/readiness/v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const POSITIVE_DECIMAL = /^[1-9][0-9]*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;

export interface Task1QueryResult<Row = Record<string, unknown>> {
  rows: Row[];
}

export interface Task1QueryClient {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Task1QueryResult<Row>>;
  release(error?: Error | boolean): void;
}

export interface Task1QueryPool {
  connect(): Promise<Task1QueryClient>;
  query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Task1QueryResult<Row>>;
  on?(event: 'error', listener: (error: Error) => void): unknown;
  off?(event: 'error', listener: (error: Error) => void): unknown;
}

export interface Task1ProofTlsMaterial {
  cert: Buffer;
  key: Buffer;
}

export interface Task1ReadinessEnvironment {
  phase: 'expand' | 'enforce';
  port: number;
  certFile: string;
  keyFile: string;
  proofDnsName: string;
  imageDigest: string;
  configurationSha256: string;
  appDatabaseUrl: string;
  authorityDatabaseUrl: string;
}

function requiredEnvironment(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

function databaseRole(connectionString: string, code: string): string {
  try {
    return decodeURIComponent(new URL(connectionString).username);
  } catch {
    throw new Error(code);
  }
}

export function parseTask1ReadinessEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): Task1ReadinessEnvironment | undefined {
  const rawPhase = env.COMMANDER_TENANT_AUTHORITY_CUTOVER_PHASE?.trim();
  if (!rawPhase) return undefined;
  if (rawPhase !== 'expand' && rawPhase !== 'enforce') {
    throw new Error('COMMANDER_TENANT_AUTHORITY_CUTOVER_PHASE_INVALID');
  }
  const portText = requiredEnvironment(env, 'COMMANDER_TENANT_AUTHORITY_PROOF_PORT');
  const port = Number(portText);
  if (!POSITIVE_DECIMAL.test(portText) || !Number.isSafeInteger(port) || port > 65_535) {
    throw new Error('COMMANDER_TENANT_AUTHORITY_PROOF_PORT_INVALID');
  }
  const certFile = requiredEnvironment(env, 'COMMANDER_TENANT_AUTHORITY_PROOF_CERT_FILE');
  const keyFile = requiredEnvironment(env, 'COMMANDER_TENANT_AUTHORITY_PROOF_KEY_FILE');
  if (!isAbsolute(certFile) || !isAbsolute(keyFile) || certFile === keyFile) {
    throw new Error('TASK1_READINESS_TLS_PATH_INVALID');
  }
  const proofDnsName = requiredEnvironment(env, 'COMMANDER_TENANT_AUTHORITY_PROOF_DNS_NAME');
  const dnsLabels = proofDnsName.split('.');
  if (
    proofDnsName.length > 253 ||
    dnsLabels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ) {
    throw new Error('TASK1_READINESS_PROOF_DNS_NAME_INVALID');
  }
  const imageDigest = requiredEnvironment(env, 'COMMANDER_TENANT_AUTHORITY_IMAGE_DIGEST');
  const configurationSha256 = requiredEnvironment(
    env,
    'COMMANDER_TENANT_AUTHORITY_CONFIGURATION_SHA256',
  );
  if (!IMAGE_DIGEST.test(imageDigest) || !SHA256.test(configurationSha256)) {
    throw new Error('TASK1_READINESS_RUNTIME_IDENTITY_INVALID');
  }
  const appDatabaseUrl = requiredEnvironment(env, 'DATABASE_URL');
  const authorityDatabaseUrl = requiredEnvironment(env, 'COMMANDER_TENANT_AUTHORITY_DATABASE_URL');
  if (appDatabaseUrl === authorityDatabaseUrl) {
    throw new Error('TASK1_READINESS_DATABASE_URLS_MUST_BE_DISTINCT');
  }
  if (
    databaseRole(appDatabaseUrl, 'TASK1_READINESS_APP_DATABASE_URL_INVALID') !== 'commander_app'
  ) {
    throw new Error('TASK1_READINESS_APP_DATABASE_ROLE_INVALID');
  }
  if (
    databaseRole(authorityDatabaseUrl, 'TASK1_READINESS_AUTHORITY_DATABASE_URL_INVALID') !==
    'commander_tenant_authority'
  ) {
    throw new Error('TASK1_READINESS_AUTHORITY_DATABASE_ROLE_INVALID');
  }
  return {
    phase: rawPhase,
    port,
    certFile,
    keyFile,
    proofDnsName,
    imageDigest,
    configurationSha256,
    appDatabaseUrl,
    authorityDatabaseUrl,
  };
}

interface Task1ProofTlsFiles {
  certFile: string;
  keyFile: string;
  expectedUid?: number;
  expectedGid?: number;
  expectedDnsName: string;
}

function currentUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('TASK1_READINESS_FILE_OWNERSHIP_UNSUPPORTED');
  return uid;
}

function currentGid(): number {
  const gid = process.getgid?.();
  if (gid === undefined) throw new Error('TASK1_READINESS_FILE_OWNERSHIP_UNSUPPORTED');
  return gid;
}

function validateProofFile(
  path: string,
  kind: 'CERT' | 'KEY',
  expectedMode: number,
  expectedUid: number,
  expectedGid: number,
): void {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error(`TASK1_READINESS_${kind}_FILE_INVALID`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`TASK1_READINESS_${kind}_FILE_INVALID`);
  }
  if ((stat.mode & 0o777) !== expectedMode) {
    throw new Error(`TASK1_READINESS_${kind}_FILE_MODE_INVALID`);
  }
  if (stat.uid !== expectedUid || stat.gid !== expectedGid) {
    throw new Error(`TASK1_READINESS_${kind}_FILE_OWNER_INVALID`);
  }
}

export function loadTask1ProofTlsMaterial(files: Task1ProofTlsFiles): Task1ProofTlsMaterial {
  const expectedUid = files.expectedUid ?? currentUid();
  const expectedGid = files.expectedGid ?? currentGid();
  validateProofFile(files.certFile, 'CERT', 0o444, expectedUid, expectedGid);
  validateProofFile(files.keyFile, 'KEY', 0o400, expectedUid, expectedGid);

  const cert = readFileSync(files.certFile);
  const key = readFileSync(files.keyFile);
  try {
    const certificate = new X509Certificate(cert);
    const certificateKey = certificate.publicKey;
    const derivedPublicKey = createPublicKey(key);
    const certificateSpki = certificateKey.export({ format: 'der', type: 'spki' });
    const derivedSpki = derivedPublicKey.export({ format: 'der', type: 'spki' });
    if (!certificateSpki.equals(derivedSpki)) throw new Error('key mismatch');
    if (certificateKey.asymmetricKeyType === 'ec') {
      if (certificateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
        throw new Error('unsupported EC curve');
      }
    } else if (certificateKey.asymmetricKeyType !== 'ed25519') {
      throw new Error('unsupported key type');
    }
    const now = Date.now();
    if (
      Date.parse(certificate.validFrom) > now ||
      Date.parse(certificate.validTo) - now < 24 * 60 * 60 * 1_000 ||
      !certificate.subjectAltName
        ?.split(', ')
        .some((entry) => entry === `DNS:${files.expectedDnsName}`)
    ) {
      throw new Error('certificate validity or SAN invalid');
    }
    createSecureContext({ cert, key, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' });
  } catch {
    throw new Error('TASK1_READINESS_TLS_MATERIAL_INVALID');
  }
  return { cert, key };
}

export function createTask1ProofHttpsServer(
  proof: Task1ReadinessProof,
  material: Task1ProofTlsMaterial,
): Server {
  return createServer(
    {
      cert: material.cert,
      key: material.key,
      minVersion: 'TLSv1.3',
      maxVersion: 'TLSv1.3',
    },
    (request, response) => {
      const handled = proof.handle(
        {
          method: request.method,
          url: request.url,
          rawHeaders: request.rawHeaders,
        },
        {
          status(value) {
            response.statusCode = value;
            return this;
          },
          setHeader(name, value) {
            response.setHeader(name, value);
          },
          end(value) {
            response.end(value);
          },
        },
      );
      if (!handled) {
        response.statusCode = 404;
        response.end();
      }
    },
  );
}

interface TargetRow {
  database_oid: number;
  backend_pid: number;
  xid: string;
}

function oneRow<Row>(rows: Row[], code: string): Row {
  if (rows.length !== 1) throw new Error(code);
  return rows[0]!;
}

function releaseError(error: unknown): Error {
  return error instanceof Error ? error : new Error('TASK1_QUERY_STATE_UNKNOWN');
}

async function withTask1QueryClient<Result>(
  pool: Task1QueryPool,
  query: (client: Task1QueryClient) => Promise<Result>,
): Promise<Result> {
  const client = await pool.connect();
  try {
    const result = await query(client);
    client.release();
    return result;
  } catch (error) {
    client.release(releaseError(error));
    throw error;
  }
}

export async function runTask1TenantSelfCheck(
  proof: Task1ReadinessProof,
  appPool: Task1QueryPool,
  authorityPool: Task1QueryPool,
): Promise<void> {
  let client: Task1QueryClient | undefined;
  let transactionStarted = false;
  try {
    client = await appPool.connect();
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    transactionStarted = true;
    const target = oneRow(
      (
        await client.query<TargetRow>(
          `
SELECT
  (SELECT d.oid FROM pg_catalog.pg_database AS d WHERE d.datname = pg_catalog.current_database()) AS database_oid,
  pg_catalog.pg_backend_pid() AS backend_pid,
  pg_catalog.pg_current_xact_id()::text AS xid
`.trim(),
        )
      ).rows,
      'TASK1_READINESS_TARGET_INVALID',
    );
    if (
      !Number.isInteger(target.database_oid) ||
      target.database_oid <= 0 ||
      !Number.isInteger(target.backend_pid) ||
      target.backend_pid <= 0 ||
      !POSITIVE_DECIMAL.test(target.xid)
    ) {
      throw new Error('TASK1_READINESS_TARGET_INVALID');
    }

    const issued = await withTask1QueryClient(authorityPool, async (authorityClient) => {
      const row = oneRow(
        (
          await authorityClient.query<{ context_id: string }>(
            'SELECT context_id::text FROM public.issue_app_tenant_context($1::text, $2::oid, $3::integer, $4::xid8)',
            [READINESS_TENANT, target.database_oid, target.backend_pid, target.xid],
          )
        ).rows,
        'TASK1_READINESS_ISSUE_INVALID',
      );
      if (!UUID.test(row.context_id)) throw new Error('TASK1_READINESS_ISSUE_INVALID');
      return row;
    });

    const bound = oneRow(
      (
        await client.query<{ tenant_id: string }>(
          'SELECT tenant_id FROM public.bind_app_tenant_context($1::uuid)',
          [issued.context_id],
        )
      ).rows,
      'TASK1_READINESS_BIND_INVALID',
    );
    if (bound.tenant_id !== READINESS_TENANT) throw new Error('TASK1_READINESS_BIND_INVALID');

    const resolved = oneRow(
      (
        await client.query<{ tenant_id: string }>(
          'SELECT public.commander_authenticated_app_tenant() AS tenant_id',
        )
      ).rows,
      'TASK1_READINESS_RESOLVE_INVALID',
    );
    if (resolved.tenant_id !== READINESS_TENANT) throw new Error('TASK1_READINESS_RESOLVE_INVALID');

    await client.query('SELECT public.close_app_tenant_context($1::uuid)', [issued.context_id]);
    await client.query('COMMIT');
    transactionStarted = false;
    proof.recordTenantSelfCheck(true);
  } catch (error) {
    proof.invalidateTenantSelfCheck();
    if (client && transactionStarted) await client.query('ROLLBACK').catch(() => undefined);
    client?.release(releaseError(error));
    client = undefined;
    throw error;
  } finally {
    client?.release();
  }
}

interface RuntimeIdentityRow {
  operation_version_text: string;
  runtime_phase: string;
  api_image_digest: string;
  configuration_sha256: string;
}

export async function pollTask1RuntimeIdentity(
  proof: Task1ReadinessProof,
  authorityPool: Task1QueryPool,
): Promise<void> {
  try {
    await withTask1QueryClient(authorityPool, async (client) => {
      const row = oneRow(
        (
          await client.query<RuntimeIdentityRow>(
            `
SELECT operation_version_text, runtime_phase, api_image_digest, configuration_sha256
FROM public.commander_runtime_configuration_identity()
`.trim(),
          )
        ).rows,
        'TASK1_RUNTIME_IDENTITY_INVALID',
      );
      proof.recordRuntimeIdentity({
        operationVersion: row.operation_version_text,
        phase: row.runtime_phase as Task1RuntimeIdentity['phase'],
        imageDigest: row.api_image_digest,
        configurationSha256: row.configuration_sha256,
      });
    });
  } catch (error) {
    proof.invalidateRuntimeIdentity();
    throw error;
  }
}

interface DatabaseIdentityRow {
  installation_id: string;
  database_peer_binding_sha256: string;
}

const DATABASE_IDENTITY_STARTUP_ATTEMPTS = 5;
const DATABASE_IDENTITY_STARTUP_RETRY_MS = 250;

export interface Task1DatabaseIdentity {
  installationId: string;
  databasePeerBindingSha256: string;
}

export async function readTask1DatabaseIdentity(
  authorityPool: Task1QueryPool,
): Promise<Task1DatabaseIdentity> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= DATABASE_IDENTITY_STARTUP_ATTEMPTS; attempt += 1) {
    try {
      return await withTask1QueryClient(authorityPool, async (client) => {
        const row = oneRow(
          (
            await client.query<DatabaseIdentityRow>(
              `
SELECT installation_id::text, database_peer_binding_sha256
FROM public.commander_database_identity()
`.trim(),
            )
          ).rows,
          'TASK1_DATABASE_IDENTITY_INVALID',
        );
        if (!UUID.test(row.installation_id) || !SHA256.test(row.database_peer_binding_sha256)) {
          throw new Error('TASK1_DATABASE_IDENTITY_INVALID');
        }
        return {
          installationId: row.installation_id,
          databasePeerBindingSha256: row.database_peer_binding_sha256,
        };
      });
    } catch (error) {
      lastError = error;
      if (attempt === DATABASE_IDENTITY_STARTUP_ATTEMPTS) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, DATABASE_IDENTITY_STARTUP_RETRY_MS));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('TASK1_DATABASE_IDENTITY_INVALID');
}

export interface Task1ReadinessRuntimeOptions {
  proof: Task1ReadinessProof;
  appPool: Task1QueryPool;
  authorityPool: Task1QueryPool;
  selfCheckIntervalMs?: number;
  runtimeIdentityIntervalMs?: number;
}

export class Task1ReadinessRuntime {
  private stopped = true;
  private selfCheckTimer?: NodeJS.Timeout;
  private identityTimer?: NodeJS.Timeout;
  private readonly poolError = (): void => {
    this.options.proof.invalidateTenantSelfCheck();
    this.options.proof.invalidateRuntimeIdentity();
  };

  constructor(private readonly options: Task1ReadinessRuntimeOptions) {
    const selfCheckInterval = options.selfCheckIntervalMs ?? 10_000;
    const identityInterval = options.runtimeIdentityIntervalMs ?? 1_000;
    if (selfCheckInterval <= 0 || selfCheckInterval > 10_000) {
      throw new Error('TASK1_READINESS_SELF_CHECK_INTERVAL_INVALID');
    }
    if (identityInterval !== 1_000) {
      throw new Error('TASK1_READINESS_IDENTITY_INTERVAL_INVALID');
    }
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.options.proof.invalidateTenantSelfCheck();
    this.options.proof.invalidateRuntimeIdentity();
    this.options.appPool.on?.('error', this.poolError);
    this.options.authorityPool.on?.('error', this.poolError);
    void this.runSelfCheckLoop();
    void this.runIdentityLoop();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.selfCheckTimer) clearTimeout(this.selfCheckTimer);
    if (this.identityTimer) clearTimeout(this.identityTimer);
    this.options.appPool.off?.('error', this.poolError);
    this.options.authorityPool.off?.('error', this.poolError);
    this.poolError();
  }

  private async runSelfCheckLoop(): Promise<void> {
    const startedAt = performance.now();
    try {
      await runTask1TenantSelfCheck(
        this.options.proof,
        this.options.appPool,
        this.options.authorityPool,
      );
    } catch {
      // The state is already invalidated; context values must never be logged.
    }
    if (this.stopped) {
      this.poolError();
      return;
    }
    const interval = this.options.selfCheckIntervalMs ?? 10_000;
    this.selfCheckTimer = setTimeout(
      () => void this.runSelfCheckLoop(),
      Math.max(0, interval - (performance.now() - startedAt)),
    );
  }

  private async runIdentityLoop(): Promise<void> {
    const startedAt = performance.now();
    try {
      await pollTask1RuntimeIdentity(this.options.proof, this.options.authorityPool);
    } catch {
      // The cache is already invalidated and may contain credential-adjacent database errors.
    }
    if (this.stopped) {
      this.poolError();
      return;
    }
    const interval = this.options.runtimeIdentityIntervalMs ?? 1_000;
    this.identityTimer = setTimeout(
      () => void this.runIdentityLoop(),
      Math.max(0, interval - (performance.now() - startedAt)),
    );
  }
}

export function asTask1QueryPool(pool: Pool): Task1QueryPool {
  return pool as unknown as Task1QueryPool;
}

export interface Task1ReadinessService {
  close(): Promise<void>;
}

export function createTask1ReadinessDatabasePools(
  config: Task1ReadinessEnvironment,
  env: NodeJS.ProcessEnv = process.env,
  createPool: typeof createVerifiedPostgresPool = createVerifiedPostgresPool,
): { appPool: Pool; authorityPool: Pool } {
  const appPool = createPool(
    {
      connectionString: config.appDatabaseUrl,
      max: 2,
      connectionTimeoutMillis: 2_000,
      query_timeout: 2_000,
      statement_timeout: 1_500,
    },
    env,
  );
  const authorityPool = createPool(
    {
      connectionString: config.authorityDatabaseUrl,
      max: 2,
      connectionTimeoutMillis: 2_000,
      query_timeout: 900,
      statement_timeout: 750,
    },
    env,
  );
  return { appPool, authorityPool };
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolveListen, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolveListen();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '0.0.0.0');
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
}

export async function startTask1ReadinessService(
  env: NodeJS.ProcessEnv = process.env,
): Promise<Task1ReadinessService | undefined> {
  const config = parseTask1ReadinessEnvironment(env);
  if (!config) return undefined;

  const material = loadTask1ProofTlsMaterial({
    certFile: config.certFile,
    keyFile: config.keyFile,
    expectedDnsName: config.proofDnsName,
  });
  const { appPool, authorityPool } = createTask1ReadinessDatabasePools(config, env);
  let server: Server | undefined;
  let runtime: Task1ReadinessRuntime | undefined;
  try {
    const databaseIdentity = await readTask1DatabaseIdentity(asTask1QueryPool(authorityPool));
    const proof = new Task1ReadinessProof({
      nowMonotonicMs: () => performance.now(),
      installationId: databaseIdentity.installationId,
      databasePeerBindingSha256: databaseIdentity.databasePeerBindingSha256,
      expectedPhase: config.phase,
      expectedImageDigest: config.imageDigest,
      expectedConfigurationSha256: config.configurationSha256,
    });
    server = createTask1ProofHttpsServer(proof, material);
    await listen(server, config.port);
    runtime = new Task1ReadinessRuntime({
      proof,
      appPool: asTask1QueryPool(appPool),
      authorityPool: asTask1QueryPool(authorityPool),
    });
    runtime.start();
  } catch (error) {
    runtime?.stop();
    if (server?.listening) await closeServer(server).catch(() => undefined);
    await Promise.allSettled([appPool.end(), authorityPool.end()]);
    throw error;
  }

  let closePromise: Promise<void> | undefined;
  return {
    close(): Promise<void> {
      closePromise ??= (async () => {
        runtime?.stop();
        await Promise.allSettled([
          server?.listening ? closeServer(server) : Promise.resolve(),
          appPool.end(),
          authorityPool.end(),
        ]);
      })();
      return closePromise;
    },
  };
}

export { TASK1_READINESS_PROOF_PATH };
