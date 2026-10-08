#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { runKernelMigrations, seedWorkerAllowedTenants } from '@praetor/kernel';
import { createVerifiedPostgresPool } from '@praetor/postgres-runtime';
import { PostgresWorkerRegistry } from '@praetor/worker-plane';
import type { Pool } from 'pg';
import { runTask1ClosureMigrations } from '../packages/kernel/src/migrations.js';
import {
  collectExternalAcceptanceBuildMetadata,
  type ExternalAcceptanceBuildMetadata,
} from './openai-agents-mcp-build-metadata.js';
import { createOpenAIAgentsMcpFetch } from './openai-agents-mcp-fetch.js';
import { verifyEvidenceReceipt } from './verify-evidence.js';

const ROOT = resolve(import.meta.dirname, '..');
const TENANT = 'external-agents-acceptance';
const TIMEOUT_MS = 120_000;

type JsonRecord = Record<string, unknown>;

type AcceptanceMode = 'deterministic' | 'live';

interface LiveProposalConfig {
  apiKey: string;
  model: string;
  modelApi: 'responses' | 'chat_completions';
  modelBaseUrl: string;
}

interface ManagedProcess {
  name: string;
  child: ChildProcess;
  output: string[];
  initialOutput: string[];
}

interface FakeKubernetesState {
  rollbackWrites: number;
  compensationWrites: number;
  outcomeQueries: number;
  responseLost: boolean;
  forwardCommitPending: boolean;
  forwardCommittedAt: string | null;
}

const processes: ManagedProcess[] = [];
let currentStage = 'configuration';
let acceptanceMode: AcceptanceMode = 'deterministic';
let buildMetadata: ExternalAcceptanceBuildMetadata | undefined;

const ARTIFACT_NAMES = {
  deterministic: 'deterministic-acceptance.json',
  deterministicFailure: 'deterministic-acceptance-failure.json',
  live: 'live-acceptance.json',
  liveFailure: 'live-acceptance-failure.json',
} as const;

function hasValue(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

function readLiveProposalConfig(env: NodeJS.ProcessEnv): LiveProposalConfig | undefined {
  const values = {
    apiKey: env.OPENAI_API_KEY,
    model: env.OPENAI_AGENTS_MCP_LIVE_MODEL,
    modelApi: env.OPENAI_AGENTS_MCP_LIVE_API,
    modelBaseUrl: env.OPENAI_AGENTS_MCP_LIVE_BASE_URL,
  };
  const supplied = Object.values(values).map(hasValue);
  if (supplied.some(Boolean) && !supplied.every(Boolean)) {
    throw new Error('OPENAI_AGENTS_MCP_LIVE_CONFIGURATION_INCOMPLETE');
  }
  if (!supplied.every(Boolean)) return undefined;
  if (values.modelApi !== 'responses' && values.modelApi !== 'chat_completions') {
    throw new Error('OPENAI_AGENTS_MCP_LIVE_API_INVALID');
  }
  try {
    new URL(values.modelBaseUrl!);
  } catch {
    throw new Error('OPENAI_AGENTS_MCP_LIVE_BASE_URL_INVALID');
  }
  return {
    apiKey: values.apiKey!,
    model: values.model!,
    modelApi: values.modelApi,
    modelBaseUrl: values.modelBaseUrl!,
  };
}

function runtimeEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key]) => key !== 'OPENAI_API_KEY' && !key.startsWith('OPENAI_AGENTS_MCP_LIVE_'),
    ),
  );
}

function artifactPath(mode: AcceptanceMode, failure = false): string {
  const name =
    mode === 'live'
      ? failure
        ? ARTIFACT_NAMES.liveFailure
        : ARTIFACT_NAMES.live
      : failure
        ? ARTIFACT_NAMES.deterministicFailure
        : ARTIFACT_NAMES.deterministic;
  return resolve(ROOT, 'artifacts', 'openai-agents-mcp', name);
}

function stage(name: string): void {
  currentStage = name;
  process.stderr.write(`[openai-agents-mcp-acceptance] ${name}\n`);
}

function record(value: unknown, code: string): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  return value as JsonRecord;
}

function string(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(code);
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as JsonRecord;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(',')}}`;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function secret(): string {
  return randomBytes(32).toString('hex');
}

function databaseUrl(role: string, password: string, port: number): string {
  return `postgres://${role}:${password}@localhost:${port}/fixture?sslmode=verify-full`;
}

async function allocatePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolvePromise, reject) =>
    server.close((error) => (error ? reject(error) : resolvePromise())),
  );
  return port;
}

function startProcess(name: string, command: string, args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(command, args, {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const managed: ManagedProcess = { name, child, output: [], initialOutput: [] };
  const capture = (chunk: Buffer | string) => {
    const text = String(chunk);
    if (managed.initialOutput.length < 40) managed.initialOutput.push(text);
    managed.output.push(text);
    if (managed.output.length > 200) managed.output.shift();
  };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  processes.push(managed);
  return managed;
}

function processFailure(process: ManagedProcess): string {
  return `${process.name} exited unexpectedly\n${process.output.join('').slice(-4_000)}`;
}

function sanitizedProcessTail(process: ManagedProcess): string {
  const sanitize = (value: string) =>
    value
      .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[REDACTED_DATABASE_URL]')
      .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, '[REDACTED_PEM]')
      .replace(/\b(?:Bearer|token|secret|api[_-]?key)\s*[:=]\s*\S+/gi, '$1=[REDACTED]');
  const head = sanitize(process.initialOutput.join('').slice(0, 4_000));
  const tail = sanitize(process.output.join('').slice(-8_000));
  return `${head}\n...[process output elided]...\n${tail}`;
}

async function waitFor<T>(description: string, observe: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() <= deadline) {
    const value = await observe();
    if (value !== undefined) return value;
    await sleep(100);
  }
  throw new Error(`ACCEPTANCE_TIMEOUT:${description}`);
}

async function waitForHealth(process: ManagedProcess, url: string): Promise<void> {
  await waitFor(`${process.name} health`, async () => {
    if (process.child.exitCode !== null) throw new Error(processFailure(process));
    try {
      return (await fetch(url)).ok ? true : undefined;
    } catch {
      return undefined;
    }
  });
}

async function stopProcess(process: ManagedProcess, signal: NodeJS.Signals): Promise<void> {
  if (process.child.exitCode !== null || process.child.signalCode !== null) return;
  process.child.kill(signal);
  await new Promise<void>((resolvePromise) => process.child.once('exit', () => resolvePromise()));
}

async function cleanup(): Promise<void> {
  for (const process of [...processes].reverse()) {
    try {
      await Promise.race([stopProcess(process, 'SIGTERM'), sleep(3_000)]);
      if (process.child.exitCode === null && process.child.signalCode === null) {
        process.child.kill('SIGKILL');
      }
    } catch {
      // Preserve the acceptance failure.
    }
  }
}

function signingMaterial(prefix: string) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const keyId = `${prefix}-${randomUUID()}`;
  const jwk = publicKey.export({ format: 'jwk' });
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    keyId,
    jwks: { keys: [{ ...jwk, kid: keyId, alg: 'EdDSA', use: 'sig' }] },
  };
}

async function fakeState(baseUrl: string): Promise<FakeKubernetesState> {
  const response = await fetch(`${baseUrl}/state`);
  assert.equal(response.status, 200);
  return (await response.json()) as FakeKubernetesState;
}

async function externalJson(
  externalFetch: typeof fetch,
  baseUrl: string,
  path: string,
  init?: RequestInit,
): Promise<JsonRecord> {
  const response = await externalFetch(new URL(path, `${baseUrl}/`), init);
  const payload = record(await response.json(), 'EXTERNAL_MCP_RESPONSE_INVALID');
  if (!response.ok) {
    throw new Error(`EXTERNAL_MCP_REQUEST_FAILED:${response.status}:${JSON.stringify(payload)}`);
  }
  return payload;
}

async function actionState(
  externalFetch: typeof fetch,
  apiBaseUrl: string,
  runId: string,
): Promise<string> {
  const payload = await externalJson(externalFetch, apiBaseUrl, `v1/actions/${runId}`);
  return string(record(payload.action, 'ACTION_REQUIRED').state, 'ACTION_STATE_REQUIRED');
}

async function queryOne(pool: Pool, sql: string, values: unknown[]): Promise<JsonRecord> {
  const result = await pool.query(sql, values);
  assert.equal(result.rows.length, 1);
  return result.rows[0] as JsonRecord;
}

async function evidenceDiagnostics(
  pool: Pool,
  runId: string,
  effectId: string,
): Promise<JsonRecord> {
  const [state, receipts, events, functions] = await Promise.all([
    queryOne(
      pool,
      `SELECT r.state AS run_state, s.state AS step_state, s.version AS step_version,
              e.state AS effect_state, e.response AS effect_response,
              e.reconcile_disposition, e.reconcile_attempts,
              e.reconcile_claim_worker_id, e.reconcile_claim_worker_generation,
              e.reconcile_claim_expires_at, e.reconcile_last_error,
              e.action_digest, e.policy_snapshot_id
         FROM commander_runs r
         JOIN commander_steps s ON s.run_id=r.id
         JOIN commander_effects e ON e.run_id=r.id
        WHERE r.id=$1 AND e.id=$2`,
      [runId, effectId],
    ),
    pool.query(
      `SELECT bundle_id, run_id, action_digest, content_hash,
              anchored_at IS NOT NULL AS anchored, body->>'terminalDisposition' AS disposition,
              body #>> '{scope,effectId}' AS body_effect_id,
              body #>> '{effects,0,state}' AS first_effect_state
         FROM commander_evidence_receipts
        WHERE tenant_id=$1 AND run_id=$2
        ORDER BY created_at`,
      [TENANT, runId],
    ),
    pool.query(
      `SELECT type, aggregate_id, payload
         FROM commander_events
        WHERE tenant_id=$1 AND run_id=$2
        ORDER BY occurred_at, sequence`,
      [TENANT, runId],
    ),
    pool.query(
      `SELECT oid::regprocedure AS signature, md5(prosrc) AS source_md5
         FROM pg_proc
        WHERE oid::regprocedure::text IN (
          'public.read_adapter_ops_evidence_context(text,bigint,text,text,text,text,text)',
          'public.complete_reconcile_effect(text,text,text,bigint,text,text,jsonb,jsonb)',
          'public.apply_reconcile_effect_with_evidence_v1(text,text,text,text,bigint,text,text,jsonb,jsonb)'
        )
        ORDER BY signature`,
      [],
    ),
  ]);
  return {
    state,
    receipts: receipts.rows,
    events: events.rows.map((row) => ({
      type: row.type,
      aggregateId: row.aggregate_id,
      payload: row.payload,
    })),
    functions: functions.rows,
  };
}

async function main(): Promise<void> {
  stage('configuration');
  assert.equal(process.versions.node.split('.')[0], '22', 'OPENAI_AGENTS_MCP_NODE_22_REQUIRED');
  buildMetadata = await collectExternalAcceptanceBuildMetadata(ROOT);
  acceptanceMode = Object.entries(process.env).some(
    ([key, value]) =>
      (key === 'OPENAI_API_KEY' || key.startsWith('OPENAI_AGENTS_MCP_LIVE_')) && hasValue(value),
  )
    ? 'live'
    : 'deterministic';
  const liveProposal = readLiveProposalConfig(process.env);
  acceptanceMode = liveProposal ? 'live' : 'deterministic';
  const fixtureStateDir = resolve(
    string(process.env.OPENAI_AGENTS_MCP_FIXTURE_STATE_DIR, 'FIXTURE_STATE_DIR_REQUIRED'),
  );
  const postgresPort = Number(
    string(process.env.OPENAI_AGENTS_MCP_POSTGRES_PORT, 'POSTGRES_PORT_REQUIRED'),
  );
  assert.ok(Number.isInteger(postgresPort) && postgresPort > 0 && postgresPort <= 65_535);
  const passwords = {
    owner: string(process.env.FIXTURE_OWNER_PASSWORD, 'FIXTURE_OWNER_PASSWORD_REQUIRED'),
    app: string(process.env.FIXTURE_APP_PASSWORD, 'FIXTURE_APP_PASSWORD_REQUIRED'),
    authority: string(
      process.env.FIXTURE_TENANT_AUTHORITY_PASSWORD,
      'FIXTURE_TENANT_AUTHORITY_PASSWORD_REQUIRED',
    ),
    scheduler: string(
      process.env.FIXTURE_SCHEDULER_PASSWORD,
      'FIXTURE_SCHEDULER_PASSWORD_REQUIRED',
    ),
    worker: string(process.env.FIXTURE_WORKER_PASSWORD, 'FIXTURE_WORKER_PASSWORD_REQUIRED'),
    adapter: string(
      process.env.FIXTURE_ADAPTER_OPS_PASSWORD,
      'FIXTURE_ADAPTER_OPS_PASSWORD_REQUIRED',
    ),
  };
  const caFile = resolve(fixtureStateDir, 'ca.crt');
  const certificateFile = resolve(fixtureStateDir, 'postgres.crt');
  const certificateKeyFile = resolve(fixtureStateDir, 'postgres.key');
  const spki = string(
    process.env.COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256,
    'DATABASE_SPKI_REQUIRED',
  );
  const tlsEnv = {
    COMMANDER_DATABASE_TLS_CA_FILE: caFile,
    COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256: spki,
    NODE_EXTRA_CA_CERTS: caFile,
  };
  const ownerUrl = databaseUrl('commander_owner', passwords.owner, postgresPort);
  const appUrl = databaseUrl('commander_app', passwords.app, postgresPort);
  const authorityUrl = databaseUrl('commander_tenant_authority', passwords.authority, postgresPort);
  const schedulerUrl = databaseUrl('commander_scheduler', passwords.scheduler, postgresPort);
  const workerUrl = databaseUrl('commander_worker', passwords.worker, postgresPort);
  const adapterUrl = databaseUrl('commander_adapter_ops', passwords.adapter, postgresPort);

  const ownerPool = createVerifiedPostgresPool(
    { connectionString: ownerUrl, max: 4 },
    { ...runtimeEnvironment(process.env), ...tlsEnv },
  );
  try {
    stage('migrations');
    await runKernelMigrations(ownerPool);
    await runTask1ClosureMigrations(ownerPool, 'expand');
    await runTask1ClosureMigrations(ownerPool, 'enforce');
    await runKernelMigrations(ownerPool);
    await seedWorkerAllowedTenants(ownerPool, [TENANT]);
    await ownerPool.query(
      `INSERT INTO commander_tenant_authority_allowed_tenants (tenant_id)
       VALUES ($1)
       ON CONFLICT (tenant_id) DO UPDATE SET enabled = true`,
      [TENANT],
    );
    await ownerPool.query(
      `INSERT INTO commander_effect_allowlist (tenant_id, action_pattern, allowed)
       VALUES ($1, $2, true), ($1, $3, true)
       ON CONFLICT (tenant_id, action_pattern) DO UPDATE SET allowed = true`,
      [
        TENANT,
        'connector.kubernetes.deployment.rollback',
        'compensate.kubernetes.deployment.rollback',
      ],
    );

    const apiPort = await allocatePort();
    const workerPort = await allocatePort();
    const replacementWorkerPort = await allocatePort();
    const kernelOpsPort = await allocatePort();
    const adapterOpsPort = await allocatePort();
    const fakeKubernetesPort = await allocatePort();
    const apiBaseUrl = `http://127.0.0.1:${apiPort}`;
    const fakeKubernetesUrl = `https://localhost:${fakeKubernetesPort}`;
    const apiKey = secret();
    const workerToken = secret();
    const capability = signingMaterial('acceptance-capability');
    const evidence = signingMaterial('acceptance-evidence');
    const invocationLog = resolve(
      fixtureStateDir,
      acceptanceMode === 'live'
        ? 'external-invocations-live.ndjson'
        : 'external-invocations.ndjson',
    );
    const artifactFile = artifactPath(acceptanceMode);
    const claimDir = resolve(fixtureStateDir, 'adapter-ops-claims');
    const adapterOpsInstanceId = `external-acceptance-${randomUUID()}`;
    await mkdir(claimDir, { recursive: true });
    await mkdir(resolve(ROOT, 'artifacts', 'openai-agents-mcp'), { recursive: true });
    await writeFile(invocationLog, '', 'utf8');

    const common = {
      ...runtimeEnvironment(process.env),
      ...tlsEnv,
      NODE_ENV: 'development',
      COMMANDER_PROFILE: 'enterprise',
      COMMANDER_CELL_TIER: 'enterprise',
      COMMANDER_KERNEL_BACKEND: 'postgres',
      COMMANDER_CELL_TENANT_ID: TENANT,
      COMMANDER_WORKER_TENANTS: TENANT,
      COMMANDER_TENANT_CONTEXT_PHASE: 'enforce',
      COMMANDER_TENANT_AUTHORITY_DATABASE_URL: authorityUrl,
      COMMANDER_CAPABILITY_PRIVATE_KEY_PEM: capability.privateKeyPem,
      COMMANDER_CAPABILITY_KEY_ID: capability.keyId,
      COMMANDER_CAPABILITY_JWKS_JSON: JSON.stringify(capability.jwks),
      COMMANDER_EVIDENCE_SIGNING_PRIVATE_KEY_PEM: evidence.privateKeyPem,
      COMMANDER_EVIDENCE_SIGNING_KEY_ID: evidence.keyId,
      COMMANDER_ADAPTER_EGRESS_ALLOWLIST: 'localhost',
      COMMANDER_KUBERNETES_SERVER: fakeKubernetesUrl,
      COMMANDER_KUBERNETES_CLUSTER: 'fake',
      COMMANDER_KUBERNETES_NAMESPACES: 'commander',
      COMMANDER_KUBERNETES_TOKEN_ENV: 'COMMANDER_KUBERNETES_BEARER_TOKEN',
      COMMANDER_KUBERNETES_BEARER_TOKEN: 'fixture-token',
    };

    stage('fake-kubernetes');
    const fakeKubernetes = startProcess(
      'fake-kubernetes',
      process.execPath,
      ['--import', 'tsx', resolve(ROOT, 'scripts/openai-agents-mcp-fake-kubernetes.ts')],
      {
        ...common,
        OPENAI_AGENTS_MCP_FAKE_KUBERNETES_PORT: String(fakeKubernetesPort),
        OPENAI_AGENTS_MCP_FAKE_KUBERNETES_CERT_FILE: certificateFile,
        OPENAI_AGENTS_MCP_FAKE_KUBERNETES_KEY_FILE: certificateKeyFile,
        OPENAI_AGENTS_MCP_FAKE_KUBERNETES_HOLD_FORWARD_RESPONSE: '1',
      },
    );
    await waitForHealth(fakeKubernetes, `${fakeKubernetesUrl}/state`);

    stage('api');
    const api = startProcess('api', process.execPath, [resolve(ROOT, 'apps/api/dist/index.js')], {
      ...common,
      PORT: String(apiPort),
      COMMANDER_KERNEL_ENABLED: '1',
      DATABASE_URL: appUrl,
      COMMANDER_KERNEL_DATABASE_URL: appUrl,
      COMMANDER_DEFAULT_TENANT_ID: TENANT,
      COMMANDER_DEFAULT_POLICY_SNAPSHOT_ID: 'action-gateway-mvp-v1',
      COMMANDER_MEMORY_STORE: 'in-memory',
      API_STORE_BACKEND: 'memory',
      API_KEYS: `${apiKey}:external-acceptance:admin;actions:approve`,
      TENANT_API_KEYS: `${TENANT}:${apiKey}`,
      COMMANDER_EVIDENCE_JWKS_JSON: JSON.stringify(evidence.jwks),
      COMMANDER_CAPABILITY_TOKEN_KEY: secret(),
      COMMANDER_INTEGRITY_KEY: secret(),
    });
    await waitForHealth(api, `${apiBaseUrl}/health`);

    const workerEnv = {
      ...common,
      DATABASE_URL: workerUrl,
      COMMANDER_WORKER_BOOTSTRAP: 'packages/worker-plane/dist/bootstrap.js',
      COMMANDER_WORKER_ID: 'external-acceptance-worker',
      COMMANDER_WORKER_KIND: 'tool',
      COMMANDER_WORKER_CAPABILITIES: 'tool',
      COMMANDER_WORKER_AUTH_TOKEN: workerToken,
      COMMANDER_WORKER_POLL_MS: '100',
      COMMANDER_WORKER_HEARTBEAT_MS: '250',
      COMMANDER_WORKER_LEASE_TTL_MS: '15000',
    };
    stage('initial-worker');
    const worker = startProcess(
      'worker-initial',
      process.execPath,
      [resolve(ROOT, 'packages/worker-plane/dist/main.js')],
      { ...workerEnv, COMMANDER_WORKER_HEALTH_PORT: String(workerPort) },
    );
    await waitForHealth(worker, `http://127.0.0.1:${workerPort}/health`);
    const initialRegistration = await waitFor('initial worker registration', async () => {
      const result = await ownerPool.query(
        `SELECT generation::integer, status FROM commander_workers WHERE id=$1`,
        ['external-acceptance-worker'],
      );
      const row = result.rows[0] as JsonRecord | undefined;
      return row?.status === 'ACTIVE' ? row : undefined;
    });

    const adapterOpsEnv = {
      ...common,
      COMMANDER_KERNEL_DATABASE_URL: adapterUrl,
      COMMANDER_ADAPTER_OPS_INSTANCE_ID: adapterOpsInstanceId,
      COMMANDER_ADAPTER_OPS_HEALTH_PORT: String(adapterOpsPort),
      COMMANDER_ADAPTER_OPS_CLAIM_SECRET_DIR: claimDir,
    };
    stage('operations-readiness');
    const readinessAdapterOps = startProcess(
      'adapter-ops-readiness',
      process.execPath,
      [resolve(ROOT, 'packages/adapter-ops/dist/run.js')],
      {
        ...adapterOpsEnv,
        COMMANDER_RECONCILE_INTERVAL_MS: '1000',
        COMMANDER_COMPENSATION_INTERVAL_MS: '1000',
      },
    );
    await waitForHealth(readinessAdapterOps, `http://127.0.0.1:${adapterOpsPort}/ready`);

    stage('external-proposal');
    const externalFetch = createOpenAIAgentsMcpFetch({
      gatewayUrl: apiBaseUrl,
      apiKey,
      tenantId: TENANT,
      timeoutMs: TIMEOUT_MS,
      cwd: ROOT,
      evidenceLogFile: invocationLog,
      ...(liveProposal ? { liveProposal } : {}),
    });
    const idempotencyKey = `external-acceptance-${randomUUID()}`;
    const proposed = await externalJson(externalFetch, apiBaseUrl, 'v1/actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
      body: JSON.stringify({
        source: 'external-openai-agents-sdk',
        package: '@praetor/action-adapters',
        model: liveProposal?.model ?? 'deterministic-test-model',
        tool: 'kubernetes.deployment.rollback',
        destination: 'k8s://fake/commander/deployments/api',
        effectType: 'connector.kubernetes.deployment.rollback',
        args: { targetRevision: '1', reason: 'external acceptance crash recovery' },
        idempotencyKey,
      }),
    });
    const proposedAction = record(proposed.action, 'PROPOSED_ACTION_REQUIRED');
    const simulation = record(proposedAction.simulation, 'SIMULATION_REQUIRED');
    assert.equal(proposedAction.state, 'AWAITING_APPROVAL');
    const runId = string(proposedAction.runId, 'RUN_ID_REQUIRED');
    const effectId = string(proposedAction.effectId, 'EFFECT_ID_REQUIRED');
    const actionDigest = string(proposedAction.actionDigest, 'ACTION_DIGEST_REQUIRED');
    const approved = await externalJson(externalFetch, apiBaseUrl, `v1/actions/${runId}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actionDigest,
        simulationId: string(simulation.simulationId, 'SIMULATION_ID_REQUIRED'),
        policySnapshotId: string(simulation.policySnapshotId, 'POLICY_SNAPSHOT_REQUIRED'),
      }),
    });
    assert.ok(
      ['ADMITTED', 'RUNNING'].includes(
        string(
          record(approved.action, 'APPROVED_ACTION_REQUIRED').state,
          'APPROVED_STATE_REQUIRED',
        ),
      ),
    );

    stage('post-commit-crash');
    let committed: FakeKubernetesState;
    const forwardWaitStartedAt = Date.now();
    try {
      committed = await waitFor('remote forward commit', async () => {
        const state = await fakeState(fakeKubernetesUrl);
        const terminal = await queryOne(
          ownerPool,
          `SELECT r.state AS run_state, s.state AS step_state,
                  s.error->>'code' AS step_error_code,
                  s.error->>'message' AS step_error_message
             FROM commander_runs r
             JOIN commander_steps s ON s.run_id=r.id
            WHERE r.id=$1`,
          [runId],
        );
        if (terminal.run_state === 'FAILED' || terminal.step_state === 'FAILED') {
          throw new Error(`FORWARD_STEP_FAILED:${JSON.stringify(terminal)}`);
        }
        if (Date.now() - forwardWaitStartedAt > 30_000 && terminal.step_state === 'RUNNING') {
          throw new Error('FORWARD_EFFECT_ADMISSION_TIMEOUT');
        }
        return state.rollbackWrites === 1 && state.forwardCommitPending ? state : undefined;
      });
    } catch (error) {
      const [remote, durable, activity] = await Promise.all([
        fakeState(fakeKubernetesUrl),
        queryOne(
          ownerPool,
          `SELECT r.state AS run_state, s.state AS step_state, s.attempt,
                  e.state AS effect_state, e.reconcile_disposition
             FROM commander_runs r
             JOIN commander_steps s ON s.run_id=r.id
             LEFT JOIN commander_effects e ON e.run_id=r.id
            WHERE r.id=$1`,
          [runId],
        ),
        ownerPool.query(
          `SELECT usename, state, wait_event_type, wait_event
             FROM pg_stat_activity
            WHERE datname=current_database() AND usename IN
                  ('commander_worker','commander_app','commander_adapter_ops')
            ORDER BY usename, pid`,
        ),
      ]);
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}:` +
          JSON.stringify({
            remote,
            durable,
            worker: {
              alive: worker.child.exitCode === null && worker.child.signalCode === null,
              exitCode: worker.child.exitCode,
              signalCode: worker.child.signalCode,
              output: sanitizedProcessTail(worker),
            },
            databaseActivity: activity.rows,
          }),
      );
    }
    await stopProcess(readinessAdapterOps, 'SIGTERM');
    stage('kernel-ops');
    const kernelOps = startProcess(
      'kernel-ops',
      process.execPath,
      [resolve(ROOT, 'packages/kernel/dist/ops/main.js')],
      {
        ...common,
        DATABASE_URL: schedulerUrl,
        COMMANDER_OPS_HEALTH_PORT: String(kernelOpsPort),
        COMMANDER_RECLAIM_INTERVAL_MS: '250',
        COMMANDER_TIMER_POLL_MS: '250',
        COMMANDER_OUTBOX_INTERVAL_MS: '250',
        COMMANDER_COMPENSATION_INTERVAL_MS: '250',
      },
    );
    await waitForHealth(kernelOps, `http://127.0.0.1:${kernelOpsPort}/health`);
    const killedPid = worker.child.pid;
    assert.ok(killedPid);
    await stopProcess(worker, 'SIGKILL');
    assert.equal(worker.child.signalCode, 'SIGKILL');

    try {
      await waitFor('lease reclaim to completion unknown', async () => {
        const state = await queryOne(
          ownerPool,
          `SELECT r.state AS run_state, s.state AS step_state, s.attempt,
                  s.lease_expires_at, e.state AS effect_state,
                  e.reconcile_disposition
             FROM commander_effects e
             JOIN commander_steps s ON s.id=e.step_id
             JOIN commander_runs r ON r.id=s.run_id
            WHERE e.id=$1`,
          [effectId],
        );
        return state.effect_state === 'COMPLETION_UNKNOWN' &&
          state.step_state === 'WAITING_FOR_RECONCILIATION'
          ? state
          : undefined;
      });
    } catch (error) {
      const [durable, activity] = await Promise.all([
        queryOne(
          ownerPool,
          `SELECT r.state AS run_state, s.state AS step_state, s.attempt,
                  s.lease_expires_at, e.state AS effect_state,
                  e.reconcile_disposition, e.reconcile_last_error
             FROM commander_effects e
             JOIN commander_steps s ON s.id=e.step_id
             JOIN commander_runs r ON r.id=s.run_id
            WHERE e.id=$1`,
          [effectId],
        ),
        ownerPool.query(
          `SELECT usename, state, wait_event_type, wait_event
             FROM pg_stat_activity
            WHERE datname=current_database()
              AND usename IN ('commander_scheduler','commander_worker')
            ORDER BY usename, pid`,
        ),
      ]);
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}:` +
          JSON.stringify({
            durable,
            kernelOps: sanitizedProcessTail(kernelOps),
            databaseActivity: activity.rows,
          }),
      );
    }
    assert.equal(await actionState(externalFetch, apiBaseUrl, runId), 'COMPLETION_UNKNOWN');

    stage('scheduler-worker-recovery');
    const schedulerPool = createVerifiedPostgresPool(
      { connectionString: schedulerUrl, max: 2 },
      { ...process.env, ...tlsEnv },
    );
    try {
      const registry = new PostgresWorkerRegistry(schedulerPool);
      await waitFor('stale worker marked offline', async () => {
        await registry.markStale(new Date(Date.now() - 1_000));
        const row = await queryOne(ownerPool, `SELECT status FROM commander_workers WHERE id=$1`, [
          'external-acceptance-worker',
        ]);
        return row.status === 'OFFLINE' ? row : undefined;
      });
    } finally {
      await schedulerPool.end();
    }

    stage('external-reconciliation-request');
    const reconcileRequestedAt = new Date().toISOString();
    const reconcileResponse = await externalJson(
      externalFetch,
      apiBaseUrl,
      `v1/actions/${runId}/reconcile`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    );
    assert.equal(reconcileResponse.scheduled, true);

    stage('replacement-worker');
    const replacement = startProcess(
      'worker-replacement',
      process.execPath,
      [resolve(ROOT, 'packages/worker-plane/dist/main.js')],
      { ...workerEnv, COMMANDER_WORKER_HEALTH_PORT: String(replacementWorkerPort) },
    );
    await waitForHealth(replacement, `http://127.0.0.1:${replacementWorkerPort}/health`);
    const replacementRegistration = await waitFor('replacement worker registration', async () => {
      const result = await ownerPool.query(
        `SELECT generation::integer, status FROM commander_workers WHERE id=$1`,
        ['external-acceptance-worker'],
      );
      const row = result.rows[0] as JsonRecord | undefined;
      return row?.status === 'ACTIVE' &&
        Number(row.generation) > Number(initialRegistration.generation)
        ? row
        : undefined;
    });
    assert.ok(Number(replacementRegistration.generation) > Number(initialRegistration.generation));

    stage('adapter-ops-reconciliation');
    const adapterOps = startProcess(
      'adapter-ops',
      process.execPath,
      [resolve(ROOT, 'packages/adapter-ops/dist/run.js')],
      {
        ...adapterOpsEnv,
        COMMANDER_RECONCILE_INTERVAL_MS: '100',
        COMMANDER_COMPENSATION_INTERVAL_MS: '100',
      },
    );
    await waitForHealth(adapterOps, `http://127.0.0.1:${adapterOpsPort}/ready`);
    try {
      await waitFor('reconciled action success', async () => {
        const row = await queryOne(
          ownerPool,
          `SELECT r.state AS run_state, s.state AS step_state, e.state AS effect_state,
                  e.reconcile_disposition
             FROM commander_runs r
             JOIN commander_steps s ON s.run_id=r.id
             JOIN commander_effects e ON e.run_id=r.id
            WHERE r.id=$1`,
          [runId],
        );
        return row.run_state === 'SUCCEEDED' &&
          row.step_state === 'SUCCEEDED' &&
          row.effect_state === 'COMPLETED' &&
          row.reconcile_disposition === 'CONFIRMED_APPLIED'
          ? row
          : undefined;
      });
    } catch (error) {
      const [durable, workers, remote, activity] = await Promise.all([
        queryOne(
          ownerPool,
          `SELECT r.state AS run_state, s.state AS step_state, s.version AS step_version,
                  e.state AS effect_state, e.reconcile_disposition,
                  e.reconcile_attempts, e.reconcile_after, e.reconcile_last_error,
                  e.reconcile_claim_worker_id, e.reconcile_claim_worker_generation
             FROM commander_runs r
             JOIN commander_steps s ON s.run_id=r.id
             JOIN commander_effects e ON e.run_id=r.id
            WHERE r.id=$1`,
          [runId],
        ),
        ownerPool.query(
          `SELECT id, generation::integer, status, capabilities, tenant_ids,
                  last_heartbeat_at
             FROM commander_workers
            WHERE identity_subject='db:commander_adapter_ops'
            ORDER BY id`,
        ),
        fakeState(fakeKubernetesUrl),
        ownerPool.query(
          `SELECT usename, state, wait_event_type, wait_event
             FROM pg_stat_activity
            WHERE datname=current_database()
            ORDER BY usename, pid`,
        ),
      ]);
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}:` +
          JSON.stringify({
            durable,
            workers: workers.rows,
            remote,
            adapterOps: sanitizedProcessTail(adapterOps),
            databaseActivity: activity.rows,
          }),
      );
    }
    assert.equal(await actionState(externalFetch, apiBaseUrl, runId), 'SUCCEEDED');
    const reconciledRemote = await fakeState(fakeKubernetesUrl);
    assert.equal(reconciledRemote.rollbackWrites, 1);
    assert.ok(reconciledRemote.outcomeQueries > committed.outcomeQueries);

    let forwardEvidence: JsonRecord;
    try {
      forwardEvidence = await externalJson(
        externalFetch,
        apiBaseUrl,
        `v1/actions/${runId}/evidence`,
      );
    } catch (error) {
      const diagnostics = await evidenceDiagnostics(ownerPool, runId, effectId);
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}:EVIDENCE_DIAGNOSTICS=${JSON.stringify(diagnostics)}`,
      );
    }
    const forwardReceipt = record(forwardEvidence.receipt, 'FORWARD_RECEIPT_REQUIRED');
    assert.equal(record(forwardEvidence.verification, 'FORWARD_VERIFICATION_REQUIRED').ok, true);
    assert.equal(verifyEvidenceReceipt(forwardReceipt as never, evidence.jwks as never).ok, true);

    const forwardResponse = await queryOne(
      ownerPool,
      `SELECT response FROM commander_effects WHERE id=$1`,
      [effectId],
    );
    stage('external-compensation');
    let compensationRequested: JsonRecord;
    try {
      compensationRequested = await externalJson(
        externalFetch,
        apiBaseUrl,
        `v1/actions/${runId}/compensations`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            originalEffectId: effectId,
            adapterVersion: '1.0.0',
            compensationEffectType: 'compensate.kubernetes.deployment.rollback',
            compensationPatch: {
              targetRevision: '2',
              reason: 'external acceptance compensation',
            },
            forwardReceiptHash: sha256(forwardResponse.response),
          }),
        },
      );
    } catch (error) {
      const [runDiagnostic, effectDiagnostic, contextsDiagnostic] = await Promise.all([
        ownerPool.query(
          `SELECT id, tenant_id, state, metadata->'actionGateway' AS action_gateway
             FROM commander_runs WHERE id=$1`,
          [runId],
        ),
        ownerPool.query(
          `SELECT id, run_id, tenant_id, type, state, response IS NOT NULL AS response_present
             FROM commander_effects WHERE id=$1`,
          [effectId],
        ),
        ownerPool.query(
          `SELECT context_id, tenant_id, bound_at, closed_at, expires_at,
                  target_backend_pid, target_xid
             FROM commander_app_tenant_contexts
            WHERE tenant_id=$1 ORDER BY issued_at DESC LIMIT 5`,
          [TENANT],
        ),
      ]);
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}:` +
          `EXTERNAL_COMPENSATION_DIAGNOSTICS=${JSON.stringify({
            runId,
            effectId,
            tenantId: TENANT,
            runs: runDiagnostic.rows,
            effects: effectDiagnostic.rows,
            tenantContexts: contextsDiagnostic.rows,
            api: sanitizedProcessTail(api),
          })}`,
      );
    }
    assert.equal(compensationRequested.state, 'AWAITING_APPROVAL');
    stage('external-compensation-approval');
    const authorization = record(
      compensationRequested.authorization,
      'COMPENSATION_AUTHORIZATION_REQUIRED',
    );
    const authorizationId = string(authorization.id, 'AUTHORIZATION_ID_REQUIRED');
    let compensationApproved: JsonRecord;
    try {
      compensationApproved = await externalJson(
        externalFetch,
        apiBaseUrl,
        `v1/actions/${runId}/compensations/${authorizationId}/approve`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            actionDigest: string(authorization.actionDigest, 'COMPENSATION_DIGEST_REQUIRED'),
            policySnapshotId: string(
              authorization.policySnapshotId,
              'COMPENSATION_POLICY_REQUIRED',
            ),
          }),
        },
      );
    } catch (error) {
      const [runDiagnostic, effectDiagnostic, authorizationDiagnostic, interactionDiagnostic] =
        await Promise.all([
          ownerPool.query(
            `SELECT id, tenant_id, state, metadata->'actionGateway' AS action_gateway
               FROM commander_runs WHERE id=$1`,
            [runId],
          ),
          ownerPool.query(
            `SELECT id, run_id, tenant_id, type, state, response IS NOT NULL AS response_present
               FROM commander_effects WHERE id=$1`,
            [effectId],
          ),
          ownerPool.query(
            `SELECT id, tenant_id, original_run_id, original_effect_id, decision,
                    action_digest, approval_interaction_id
               FROM commander_compensation_authorizations WHERE id=$1`,
            [authorizationId],
          ),
          ownerPool.query(
            `SELECT id, run_id, tenant_id, status, response
               FROM commander_interactions WHERE id=$1`,
            [authorization.approvalInteractionId],
          ),
        ]);
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}:` +
          `EXTERNAL_COMPENSATION_APPROVAL_DIAGNOSTICS=${JSON.stringify({
            runId,
            effectId,
            authorizationId,
            tenantId: TENANT,
            runs: runDiagnostic.rows,
            effects: effectDiagnostic.rows,
            authorizations: authorizationDiagnostic.rows,
            interactions: interactionDiagnostic.rows,
            api: sanitizedProcessTail(api),
          })}`,
      );
    }
    assert.equal(compensationApproved.accepted, true);
    const compensationRequest = record(
      compensationApproved.request,
      'COMPENSATION_REQUEST_REQUIRED',
    );
    const compensationRunId = string(
      compensationRequest.compensationRunId,
      'COMPENSATION_RUN_ID_REQUIRED',
    );
    let compensated: Map<string, string>;
    try {
      compensated = await waitFor('compensation terminal state', async () => {
        const result = await ownerPool.query(
          `SELECT id, state FROM commander_runs WHERE id=ANY($1::text[])`,
          [[runId, compensationRunId]],
        );
        const states = new Map(result.rows.map((row) => [row.id as string, row.state as string]));
        return states.get(runId) === 'COMPENSATED' && states.get(compensationRunId) === 'SUCCEEDED'
          ? states
          : undefined;
      });
    } catch (error) {
      const [runs, requests, workers, functions, outbox] = await Promise.all([
        ownerPool.query(
          `SELECT id, state, version FROM commander_runs WHERE id=ANY($1::text[]) ORDER BY id`,
          [[runId, compensationRunId]],
        ),
        ownerPool.query(
          `SELECT id, state, compensation_run_id, compensation_effect_id,
                  claim_worker_id, claim_worker_generation, claim_expires_at,
                  claim_token IS NOT NULL AS claim_present, escalation_reason
             FROM commander_compensation_requests
            WHERE compensation_run_id=$1`,
          [compensationRunId],
        ),
        ownerPool.query(
          `SELECT id, generation, status, registered_at, last_heartbeat_at,
                  capabilities, tenant_ids
             FROM commander_workers
            WHERE identity_subject='db:commander_adapter_ops'
            ORDER BY id`,
        ),
        ownerPool.query(
          `SELECT oid::regprocedure::text AS signature, md5(prosrc) AS source_md5
             FROM pg_proc
            WHERE proname IN (
              'claim_compensation_request_v2',
              'claim_compensation_request',
              'claim_compensation_request_internal_v1'
            )
            ORDER BY signature`,
        ),
        ownerPool.query(
          `SELECT id, topic, published_at, claimed_at, attempts, last_error
             FROM commander_outbox
            WHERE topic='commander.kernel.compensation.requested'
            ORDER BY created_at DESC
            LIMIT 3`,
        ),
      ]);
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}:COMPENSATION_DIAGNOSTICS=${JSON.stringify(
          {
            runs: runs.rows,
            requests: requests.rows,
            workers: workers.rows,
            functions: functions.rows,
            outbox: outbox.rows,
            adapterProcess: sanitizedProcessTail(adapterOps),
          },
        )}`,
      );
    }
    assert.equal(compensated.get(runId), 'COMPENSATED');
    const finalRemote = await fakeState(fakeKubernetesUrl);
    assert.equal(finalRemote.rollbackWrites, 1);
    assert.equal(finalRemote.compensationWrites, 1);

    const compensationEvidence = await externalJson(
      externalFetch,
      apiBaseUrl,
      `v1/actions/${compensationRunId}/evidence`,
    );
    const compensationReceipt = record(
      compensationEvidence.receipt,
      'COMPENSATION_RECEIPT_REQUIRED',
    );
    assert.equal(
      record(compensationEvidence.verification, 'COMPENSATION_VERIFICATION_REQUIRED').ok,
      true,
    );
    assert.equal(
      verifyEvidenceReceipt(compensationReceipt as never, evidence.jwks as never).ok,
      true,
    );

    stage('evidence-verification');
    const invocationRecords = (await readFile(invocationLog, 'utf8'))
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => record(JSON.parse(line) as unknown, 'INVOCATION_RECORD_INVALID'));
    assert.ok(invocationRecords.length >= 8);
    const liveInvocationRecords = invocationRecords.filter(
      (entry) => typeof entry.openaiRequestOrTraceId === 'string',
    );
    const deterministicInvocationRecords = invocationRecords.filter(
      (entry) => typeof entry.openaiRequestOrTraceId !== 'string',
    );
    if (liveProposal) {
      assert.equal(liveInvocationRecords.length, 1);
      const liveInvocation = liveInvocationRecords[0]!;
      assert.equal(liveInvocation.model, liveProposal.model);
      assert.equal(liveInvocation.actionId, runId);
      assert.deepEqual(Object.keys(liveInvocation).sort(), [
        'actionId',
        'model',
        'openaiRequestOrTraceId',
        'receiptVerified',
        'state',
        'timestamp',
      ]);
    } else {
      assert.equal(liveInvocationRecords.length, 0);
    }
    assert.ok(deterministicInvocationRecords.every((entry) => entry.transport === 'mcp-stdio'));
    const agentPids = [
      ...new Set(
        deterministicInvocationRecords.map((entry) => entry.agentPid).filter(Number.isSafeInteger),
      ),
    ] as number[];
    assert.ok(agentPids.length >= 8);
    assert.ok(agentPids.every((pid) => pid !== process.pid));
    const tools = deterministicInvocationRecords.map((entry) =>
      string(entry.toolName, 'TOOL_NAME_REQUIRED'),
    );
    const orderedMcpTools = liveProposal ? ['commander_action_propose', ...tools] : tools;
    for (const required of [
      'commander_action_propose',
      'commander_action_approve',
      'commander_action_get',
      'commander_action_reconcile',
      'commander_action_evidence',
      'commander_action_compensation_request',
      'commander_action_compensation_approve',
    ]) {
      assert.ok(orderedMcpTools.includes(required), `MISSING_EXTERNAL_TOOL:${required}`);
    }

    const liveRequestOrTraceId = liveInvocationRecords[0]?.openaiRequestOrTraceId;
    assert.equal(
      liveProposal ? typeof liveRequestOrTraceId : liveRequestOrTraceId,
      liveProposal ? 'string' : undefined,
    );
    const artifact = {
      schema:
        acceptanceMode === 'live'
          ? 'commander-openai-agents-mcp-live-acceptance/v1'
          : 'commander-openai-agents-mcp-deterministic-acceptance/v1',
      generatedAt: new Date().toISOString(),
      verdict: 'PROVEN',
      runtime: liveProposal
        ? {
            name: 'openai-agents-sdk',
            node: process.version,
            model: liveProposal.model,
            modelApi: liveProposal.modelApi,
            agentsSdkVersion: '0.14.3',
            mcpServerVersion: '0.2.0',
            mcpProtocolVersion: '2024-11-05',
            openaiRequestOrTraceId: liveRequestOrTraceId,
            agentPids,
            transport: 'mcp-stdio',
            networkModelRequests: 1,
            build: buildMetadata,
          }
        : {
            name: 'openai-agents-sdk',
            node: process.version,
            model: 'deterministic-test-model',
            agentPids,
            transport: 'mcp-stdio',
            networkModelRequests: 0,
            build: buildMetadata,
          },
      action: {
        runId,
        effectId,
        actionDigest,
        states: ['AWAITING_APPROVAL', 'RUNNING', 'COMPLETION_UNKNOWN', 'SUCCEEDED', 'COMPENSATED'],
      },
      crashRecovery: {
        remoteCommittedAt: committed.forwardCommittedAt,
        killedWorkerPid: killedPid,
        killedSignal: 'SIGKILL',
        initialGeneration: initialRegistration.generation,
        replacementWorkerPid: replacement.child.pid,
        replacementGeneration: replacementRegistration.generation,
      },
      reconciliation: {
        requestedViaMcpAt: reconcileRequestedAt,
        outcome: 'CONFIRMED_APPLIED',
        queryCountDelta: finalRemote.outcomeQueries - committed.outcomeQueries,
        writesDuringReconciliation: finalRemote.rollbackWrites - committed.rollbackWrites,
      },
      compensation: {
        runId: compensationRunId,
        state: 'SUCCEEDED',
        originalRunState: 'COMPENSATED',
        writes: finalRemote.compensationWrites,
      },
      receipts: {
        forward: { verified: true, hash: sha256(forwardReceipt) },
        compensation: { verified: true, hash: sha256(compensationReceipt) },
      },
      orderedMcpTools,
    };
    assert.equal(artifact.reconciliation.writesDuringReconciliation, 0);
    await writeFile(artifactFile, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    await rm(artifactPath(acceptanceMode, true), { force: true });
    stage('complete');
    process.stdout.write(`${JSON.stringify(artifact)}\n`);
  } finally {
    await cleanup();
    await ownerPool.end();
  }
}

void main().catch(async (error) => {
  const outputDirectory = resolve(ROOT, 'artifacts', 'openai-agents-mcp');
  await mkdir(outputDirectory, { recursive: true });
  const errorMessage =
    acceptanceMode === 'live'
      ? 'LIVE_ACCEPTANCE_FAILED'
      : error instanceof Error
        ? error.message
        : String(error);
  await writeFile(
    artifactPath(acceptanceMode, true),
    `${JSON.stringify(
      {
        schema: 'commander-openai-agents-mcp-acceptance-failure/v1',
        stage: currentStage,
        error: errorMessage,
        build: buildMetadata,
        processes: processes.map((process) => ({
          name: process.name,
          pid: process.child.pid,
          exitCode: process.child.exitCode,
          signalCode: process.child.signalCode,
          output: sanitizedProcessTail(process),
        })),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  await cleanup();
  process.stderr.write(
    `${acceptanceMode === 'live' ? `${errorMessage}:${currentStage}` : error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
