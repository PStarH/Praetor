#!/usr/bin/env tsx
/**
 * P0 full loop: start Gateway (API dist) + mock worker, submit /v1/runs, wait for terminal.
 *
 * Requires:
 *   - PostgreSQL with kernel migrations reachable via a verified TLS DSN
 *     (`?sslmode=verify-full`, `COMMANDER_DATABASE_TLS_CA_FILE`, and
 *     `COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256`)
 *   - `AUTH_FAILURE_REDIS_URL` for the production API auth-failure authority
 *   - Built apps/api/dist and packages (worker-plane, kernel, core)
 *
 * Usage:
 *   pnpm p0:full-loop:tls
 *   # Or invoke directly after exporting the verified TLS/Redis variables:
 *   pnpm p0:full-loop
 *
 * Exit: 0 terminal success, 2 config, 3 timeout/non-success, 1 error
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolve } from 'node:path';
import {
  runKernelMigrations,
  runTask1ClosureMigrations,
  seedTenantAuthorityAllowedTenants,
  seedWorkerAllowedTenants,
} from '@praetor/kernel';
import { createVerifiedPostgresPool } from '@praetor/postgres-runtime';
import { hashSecret } from '../packages/core/src/runtime/apiCredentialHash';
import { buildP0RuntimeDatabaseUrls } from './p0-runtime-config.js';

const ROOT = resolve(import.meta.dirname, '..');
const PORT = Number(process.env.P0_PORT ?? 4012);
const API_BASE = `http://127.0.0.1:${PORT}`;
const API_KEY = process.env.P0_API_KEY ?? 'smoke-key-12345678';
const TENANT = process.env.P0_TENANT_ID ?? 'tenant-local';
const DB =
  process.env.COMMANDER_KERNEL_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://commander:commander@127.0.0.1:5433/commander';
const TIMEOUT_MS = Number(process.env.P0_TIMEOUT_MS ?? 90_000);

const children: ChildProcess[] = [];

function log(msg: string, detail?: unknown): void {
  const extra =
    detail === undefined ? '' : ` ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
  console.log(`[p0-full-loop] ${msg}${extra}`);
}

function killAll(): void {
  for (const child of children) {
    try {
      child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }
}

async function waitHealth(ms: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      const res = await fetch(`${API_BASE}/health`);
      if (res.ok) return;
    } catch {
      /* retry */
    }
    await sleep(250);
  }
  throw new Error(`API health not ready within ${ms}ms`);
}

async function main(): Promise<void> {
  log('migrate kernel schema');
  const pool = createVerifiedPostgresPool({ connectionString: DB, max: 2 });
  const appPassword = `p0-${randomUUID()}`;
  const authorityPassword = `p0-${randomUUID()}`;
  const workerPassword = `p0-${randomUUID()}`;
  try {
    await runKernelMigrations(pool);
    await runTask1ClosureMigrations(pool, 'enforce');
    // The first kernel pass intentionally stops at the pre-closure baseline.
    // Once the authenticated tenant closure is recorded, run the canonical
    // migration set again so post-closure schemas (including API auth
    // persistence) are installed before the production API starts.
    await runKernelMigrations(pool);
    // Production API-key authentication is PostgreSQL-authoritative. Seed the
    // harness key explicitly; API_KEYS is intentionally not a legacy bypass.
    await pool.query(
      `INSERT INTO commander_auth_api_keys
         (id, name, prefix, key_hash, scopes, tenant_id, enabled, revoked_at)
       VALUES ($1, $2, $3, $4, $5, $6, true, NULL)
       ON CONFLICT (key_hash) DO UPDATE
         SET enabled = true, revoked_at = NULL, tenant_id = EXCLUDED.tenant_id`,
      [
        'ak_p0_full_loop',
        'p0-full-loop',
        API_KEY.slice(0, 8),
        hashSecret(API_KEY),
        ['read', 'write'],
        TENANT,
      ],
    );
    await seedWorkerAllowedTenants(pool, [TENANT]);
    await seedTenantAuthorityAllowedTenants(pool, [TENANT]);
    await pool.query(`ALTER ROLE commander_app WITH LOGIN PASSWORD '${appPassword}'`);
    await pool.query(
      `ALTER ROLE commander_tenant_authority WITH LOGIN PASSWORD '${authorityPassword}'`,
    );
    await pool.query(`ALTER ROLE commander_worker WITH LOGIN PASSWORD '${workerPassword}'`);
  } finally {
    await pool.end();
  }
  const runtimeDatabaseUrls = buildP0RuntimeDatabaseUrls(DB, {
    app: appPassword,
    authority: authorityPassword,
    worker: workerPassword,
  });
  const appDatabaseUrl = new URL(runtimeDatabaseUrls.app);
  const workerDatabaseUrl = new URL(runtimeDatabaseUrls.worker);
  if (process.env.COMMANDER_DATABASE_TLS_CA_FILE) {
    appDatabaseUrl.searchParams.set('sslmode', 'verify-full');
    workerDatabaseUrl.searchParams.set('sslmode', 'verify-full');
  }
  runtimeDatabaseUrls.app = appDatabaseUrl.toString();
  runtimeDatabaseUrls.worker = workerDatabaseUrl.toString();

  const apiEnv = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(PORT),
    API_KEYS: API_KEY,
    TENANT_API_KEYS: `${TENANT}:${API_KEY}`,
    COMMANDER_API_KEY: API_KEY,
    COMMANDER_MASTER_KEY: process.env.COMMANDER_MASTER_KEY ?? randomBytes(32).toString('hex'),
    JWT_SECRET: process.env.JWT_SECRET ?? randomBytes(32).toString('hex'),
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD ?? randomBytes(32).toString('hex'),
    COMMANDER_CAPABILITY_TOKEN_KEY:
      process.env.COMMANDER_CAPABILITY_TOKEN_KEY ?? randomBytes(32).toString('hex'),
    COMMANDER_INTEGRITY_KEY: process.env.COMMANDER_INTEGRITY_KEY ?? randomBytes(32).toString('hex'),
    // Harness-local audit-chain key: this env is NODE_ENV=production, where the
    // ledger refuses the public dev key, so generate one per run instead.
    COMMANDER_AUDIT_CHAIN_KEY:
      process.env.COMMANDER_AUDIT_CHAIN_KEY ?? randomBytes(32).toString('hex'),
    COMMANDER_KERNEL_ENABLED: '1',
    DATABASE_URL: runtimeDatabaseUrls.app,
    COMMANDER_KERNEL_DATABASE_URL: runtimeDatabaseUrls.app,
    COMMANDER_TENANT_CONTEXT_PHASE: 'enforce',
    COMMANDER_TENANT_AUTHORITY_DATABASE_URL: runtimeDatabaseUrls.authority,
    COMMANDER_DEFAULT_POLICY_SNAPSHOT_ID:
      process.env.COMMANDER_DEFAULT_POLICY_SNAPSHOT_ID ?? 'policy-default-v1',
    COMMANDER_DEFAULT_TENANT_ID: TENANT,
    COMMANDER_DEFAULT_PROVIDER: 'mock',
    COMMANDER_DEFAULT_MODEL: 'mock-model',
    COMMANDER_MEMORY_STORE: 'in-memory',
    API_STORE_BACKEND: 'memory',
  };

  log('start API dist', { port: PORT });
  const api = spawn(process.execPath, [resolve(ROOT, 'apps/api/dist/index.js')], {
    cwd: ROOT,
    env: apiEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(api);
  api.stdout?.on('data', (b) => process.stdout.write(`[api] ${b}`));
  api.stderr?.on('data', (b) => process.stderr.write(`[api] ${b}`));
  api.on('exit', (code) => log('api exited', { code }));

  await waitHealth(30_000);
  log('API healthy');

  log('start mock worker');
  let workerExitedEarly: number | null = null;
  const worker = spawn(
    process.execPath,
    ['--import', 'tsx', resolve(ROOT, 'packages/worker-plane/src/main.ts')],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        DATABASE_URL: runtimeDatabaseUrls.worker,
        COMMANDER_KERNEL_DATABASE_URL: runtimeDatabaseUrls.worker,
        COMMANDER_WORKER_DATABASE_URL: runtimeDatabaseUrls.worker,
        COMMANDER_TENANT_CONTEXT_PHASE: '',
        COMMANDER_TENANT_AUTHORITY_DATABASE_URL: '',
        COMMANDER_WORKER_BOOTSTRAP: resolve(ROOT, 'scripts/p0-worker-bootstrap.ts'),
        COMMANDER_WORKER_AUTH_TOKEN: 'worker-token',
        COMMANDER_WORKER_TENANTS: TENANT,
        COMMANDER_WORKER_CAPABILITIES: 'agent',
        COMMANDER_WORKER_POLL_MS: '100',
        COMMANDER_DEFAULT_PROVIDER: 'mock',
        // Avoid interactive/git side-effects in CI sandboxes
        GIT_TERMINAL_PROMPT: '0',
        COMMANDER_INTERACTION_DB: ':memory:',
        NODE_ENV: 'development',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  children.push(worker);
  worker.stdout?.on('data', (b) => process.stdout.write(`[worker] ${b}`));
  worker.stderr?.on('data', (b) => process.stderr.write(`[worker] ${b}`));
  worker.on('exit', (code) => {
    workerExitedEarly = code ?? 1;
    log('worker exited', { code });
  });

  // Give bootstrap time to register + first poll; fail fast if process dies.
  for (let i = 0; i < 20; i++) {
    if (workerExitedEarly !== null) {
      throw new Error(`worker exited before ready (code=${workerExitedEarly})`);
    }
    await sleep(250);
  }

  const idem = `p0-full-${Date.now()}-${randomUUID().slice(0, 8)}`;
  log('submit run', { idem });
  const submit = await fetch(`${API_BASE}/v1/runs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': API_KEY,
      'Idempotency-Key': idem,
    },
    body: JSON.stringify({
      goal: 'P0 full loop — mock provider terminal proof',
      steps: [
        {
          kind: 'agent',
          input: {
            goal: 'P0 full loop — mock provider terminal proof',
            agentId: 'agent-default',
            definitionVersion: 'v1',
            providerSnapshot: { provider: 'mock', model: 'mock-model' },
          },
        },
      ],
    }),
  });
  const submitBody = (await submit.json()) as {
    run?: { id: string; state: string };
    error?: unknown;
  };
  log('submit response', { status: submit.status, body: submitBody });
  if (submit.status !== 202 && submit.status !== 200) {
    throw new Error(`submit failed: ${submit.status}`);
  }
  const runId = submitBody.run?.id;
  if (!runId) throw new Error('missing run id');

  const terminal = new Set([
    'SUCCEEDED',
    'FAILED',
    'CANCELLED',
    'succeeded',
    'failed',
    'cancelled',
  ]);
  const start = Date.now();
  let last = submitBody.run?.state ?? 'unknown';
  while (Date.now() - start < TIMEOUT_MS) {
    const got = await fetch(`${API_BASE}/v1/runs/${runId}`, {
      headers: { 'x-api-key': API_KEY },
    });
    const body = (await got.json()) as { run?: { state?: string }; error?: unknown };
    last = body.run?.state ?? last;
    log('poll', { state: last, ms: Date.now() - start });
    if (last && terminal.has(last)) {
      if (String(last).toUpperCase() === 'SUCCEEDED') {
        log('RESULT success', { runId, state: last });
        killAll();
        process.exit(0);
      }
      log('RESULT non-success terminal', { runId, state: last });
      killAll();
      process.exit(3);
    }
    await sleep(500);
  }

  log('TIMEOUT', {
    runId,
    last,
    hash: createHash('sha256').update(runId).digest('hex').slice(0, 8),
  });
  killAll();
  process.exit(3);
}

process.on('SIGINT', () => {
  killAll();
  process.exit(130);
});
process.on('SIGTERM', () => {
  killAll();
  process.exit(143);
});

main().catch((err) => {
  console.error('[p0-full-loop] fatal', err);
  killAll();
  process.exit(1);
});
