import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  CAPABILITY_AUTHORITY_REQUIRED,
  CAPABILITY_JWKS_JSON_ENV,
  CAPABILITY_KEY_ID_ENV,
  CAPABILITY_PRIVATE_KEY_PEM_ENV,
  createCapabilityAuthority,
} from '@praetor/kernel';
import { InMemoryKernelRepository } from '@praetor/kernel/testing/inMemoryRepository';
import type { CompensationOutboxPort } from '@praetor/kernel';
import { EnvAdapterCredentialProvider } from '@praetor/action-adapters';
import {
  canonicalCompensationHash,
  sealGovernedCompensationAuthorization,
} from '../../kernel/src/ops/compensationAuthority.js';
import {
  assertEgressAllowlistBeforeDaemonStart,
  assertEgressUrlAllowed,
  cellTier,
  parseEgressAllowlist,
} from './egress.js';
import {
  assertAdapterOpsSchedulerModeForbidden,
  assertDurableCapabilityStores,
  assertNonOwnerDatabaseRole,
  assertNonOwnerDatabaseUrl,
  ADAPTER_OPS_EVIDENCE_AUTHORITY_UNAVAILABLE,
  ADAPTER_OPS_COMPENSATION_TERMINAL_AUTHORITY_UNAVAILABLE,
  ADAPTER_OPS_COMPENSATION_WORKER_ID,
  ADAPTER_OPS_DURABLE_CLAIM_AUTHORITY_REQUIRED,
  ADAPTER_OPS_RECONCILE_WORKER_ID,
  type AdapterOpsWorkerRegistry,
  ADAPTER_OPS_SCHEDULER_MODE_FORBIDDEN,
  CAPABILITY_DURABLE_STORES_REQUIRED,
  COMMANDER_CELL_TENANT_ID_REQUIRED,
  createAdapterOpsEvidenceSigner,
  createAdapterOpsWiring,
  EVIDENCE_SIGNING_KEY_ID_ENV,
  EVIDENCE_SIGNING_PRIVATE_KEY_PEM_ENV,
  issueCompensationCapabilityToken,
  OWNER_DATABASE_ROLE_REJECTED,
  productionCapabilityBrokerOptions,
  registerAdapterOpsDaemonWorkers,
  requireAdapterOpsEvidenceAuthorityAvailability,
  requireAdapterOpsEvidenceAuthority,
  requireAdapterOpsCompensationTerminalEvidenceAuthority,
  requireCompensationAuthority,
  resolveAdapterOpsInstanceId,
  WORKER_TENANT_SCOPE_REQUIRED,
} from './wiring.js';

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

const CAPABILITY_ENV_KEYS = [
  CAPABILITY_PRIVATE_KEY_PEM_ENV,
  CAPABILITY_KEY_ID_ENV,
  CAPABILITY_JWKS_JSON_ENV,
  'COMMANDER_REQUIRE_CAPABILITY_AUTHORITY',
] as const;

const DATABASE_URL_ENV_KEYS = ['COMMANDER_KERNEL_DATABASE_URL', 'DATABASE_URL'] as const;

function snapshotCapabilityEnv(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const key of CAPABILITY_ENV_KEYS) out[key] = process.env[key];
  return out;
}

function snapshotDatabaseUrlEnv(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const key of DATABASE_URL_ENV_KEYS) out[key] = process.env[key];
  return out;
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function clearCapabilityEnv(): void {
  for (const key of CAPABILITY_ENV_KEYS) delete process.env[key];
}

function clearDatabaseUrlEnv(): void {
  for (const key of DATABASE_URL_ENV_KEYS) delete process.env[key];
}

class InMemoryAdapterOpsWorkerRegistry implements AdapterOpsWorkerRegistry {
  private readonly records = new Map<
    string,
    { id: string; generation: number; claimSecret: string }
  >();
  readonly previousSecrets: Array<string | undefined> = [];
  readonly heartbeats: string[] = [];
  readonly drains: string[] = [];

  async initialize(): Promise<void> {}

  async register(
    role: 'reconcile' | 'compensation',
    instanceId: string,
    _tenantIds: string[],
    previousClaimSecret?: string,
  ): Promise<{ id: string; generation: number; claimSecret: string }> {
    const id = `${role}:${instanceId}`;
    const generation = (this.records.get(id)?.generation ?? 0) + 1;
    const record = {
      id,
      generation,
      claimSecret: `${role === 'reconcile' ? 'r' : 'c'}`.repeat(43),
    };
    this.previousSecrets.push(previousClaimSecret);
    this.records.set(id, record);
    return record;
  }

  async heartbeat(workerId: string): Promise<void> {
    this.heartbeats.push(workerId);
  }

  async drain(workerId: string): Promise<void> {
    this.drains.push(workerId);
  }

  async get(
    workerId: string,
  ): Promise<{ id: string; generation: number; claimSecret: string } | null> {
    return this.records.get(workerId) ?? null;
  }
}

describe('adapter-ops run wiring', () => {
  it('creates SQLite wiring without inherited PostgreSQL URLs and restores them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ops-sqlite-inherited-urls-'));
    const dbPath = join(dir, 'kernel.sqlite');
    const ownerUrl = 'postgres://commander:commander@127.0.0.1:5432/commander';
    const initial = {
      COMMANDER_KERNEL_BACKEND: process.env.COMMANDER_KERNEL_BACKEND,
      COMMANDER_KERNEL_SQLITE_PATH: process.env.COMMANDER_KERNEL_SQLITE_PATH,
      ...snapshotDatabaseUrlEnv(),
      COMMANDER_CELL_TENANT_ID: process.env.COMMANDER_CELL_TENANT_ID,
      NODE_ENV: process.env.NODE_ENV,
      COMMANDER_ADAPTER_OPS_DEMO_OPEN: process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN,
      ...snapshotCapabilityEnv(),
    };
    try {
      process.env.COMMANDER_KERNEL_DATABASE_URL = ownerUrl;
      process.env.DATABASE_URL = ownerUrl;
      const saved = {
        COMMANDER_KERNEL_BACKEND: process.env.COMMANDER_KERNEL_BACKEND,
        COMMANDER_KERNEL_SQLITE_PATH: process.env.COMMANDER_KERNEL_SQLITE_PATH,
        ...snapshotDatabaseUrlEnv(),
        COMMANDER_CELL_TENANT_ID: process.env.COMMANDER_CELL_TENANT_ID,
        NODE_ENV: process.env.NODE_ENV,
        COMMANDER_ADAPTER_OPS_DEMO_OPEN: process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN,
        ...snapshotCapabilityEnv(),
      };
      clearDatabaseUrlEnv();
      process.env.COMMANDER_KERNEL_BACKEND = 'sqlite';
      process.env.COMMANDER_KERNEL_SQLITE_PATH = dbPath;
      process.env.COMMANDER_CELL_TENANT_ID = 'local';
      delete process.env.NODE_ENV;
      delete process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN;
      clearCapabilityEnv();
      try {
        const wiring = await createAdapterOpsWiring();
        await wiring.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
        restoreEnv(saved);
      }
      assert.equal(process.env.COMMANDER_KERNEL_DATABASE_URL, ownerUrl);
      assert.equal(process.env.DATABASE_URL, ownerUrl);
    } finally {
      restoreEnv(initial);
    }
  });

  it('loads adapter credential registrations from the process environment', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ops-adapter-credentials-'));
    const dbPath = join(dir, 'kernel.sqlite');
    const saved = {
      COMMANDER_KERNEL_BACKEND: process.env.COMMANDER_KERNEL_BACKEND,
      COMMANDER_KERNEL_SQLITE_PATH: process.env.COMMANDER_KERNEL_SQLITE_PATH,
      ...snapshotDatabaseUrlEnv(),
      COMMANDER_CELL_TENANT_ID: process.env.COMMANDER_CELL_TENANT_ID,
      NODE_ENV: process.env.NODE_ENV,
      COMMANDER_ADAPTER_OPS_DEMO_OPEN: process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN,
      ...snapshotCapabilityEnv(),
    };
    const originalFromProcessEnv = EnvAdapterCredentialProvider.fromProcessEnv;
    let calls = 0;
    EnvAdapterCredentialProvider.fromProcessEnv = () => {
      calls += 1;
      return new EnvAdapterCredentialProvider({ cellTenantId: 'local' });
    };
    clearDatabaseUrlEnv();
    process.env.COMMANDER_KERNEL_BACKEND = 'sqlite';
    process.env.COMMANDER_KERNEL_SQLITE_PATH = dbPath;
    process.env.COMMANDER_CELL_TENANT_ID = 'local';
    delete process.env.NODE_ENV;
    delete process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN;
    clearCapabilityEnv();
    try {
      const wiring = await createAdapterOpsWiring();
      await wiring.close();
      assert.equal(calls, 1);
    } finally {
      EnvAdapterCredentialProvider.fromProcessEnv = originalFromProcessEnv;
      rmSync(dir, { recursive: true, force: true });
      restoreEnv(saved);
    }
  });

  it('starts reconciliation and compensation against sqlite kernel', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ops-run-'));
    const dbPath = join(dir, 'kernel.sqlite');
    const saved = {
      COMMANDER_KERNEL_BACKEND: process.env.COMMANDER_KERNEL_BACKEND,
      COMMANDER_KERNEL_SQLITE_PATH: process.env.COMMANDER_KERNEL_SQLITE_PATH,
      ...snapshotDatabaseUrlEnv(),
      COMMANDER_CELL_TENANT_ID: process.env.COMMANDER_CELL_TENANT_ID,
      NODE_ENV: process.env.NODE_ENV,
      COMMANDER_ADAPTER_OPS_DEMO_OPEN: process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN,
      ...snapshotCapabilityEnv(),
    };
    clearDatabaseUrlEnv();
    process.env.COMMANDER_KERNEL_BACKEND = 'sqlite';
    process.env.COMMANDER_KERNEL_SQLITE_PATH = dbPath;
    process.env.COMMANDER_CELL_TENANT_ID = 'local';
    delete process.env.NODE_ENV;
    delete process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN;
    clearCapabilityEnv();
    try {
      const wiring = await createAdapterOpsWiring();
      assert.equal(wiring.demoOpenHollowPep, false);
      assert.equal(await wiring.ping(), true);
      assert.equal(typeof wiring.operationsReadiness, 'function');
      wiring.reconciliation.start();
      wiring.compensation.start();
      assert.equal(typeof wiring.reconciliation.stop, 'function');
      await wiring.reconciliation.stop();
      await wiring.compensation.stop();
      await wiring.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      restoreEnv(saved);
    }
  });

  it('throws COMMANDER_CELL_TENANT_ID_REQUIRED when COMMANDER_CELL_TENANT_ID missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ops-no-tenant-'));
    const dbPath = join(dir, 'kernel.sqlite');
    const saved = {
      COMMANDER_KERNEL_BACKEND: process.env.COMMANDER_KERNEL_BACKEND,
      COMMANDER_KERNEL_SQLITE_PATH: process.env.COMMANDER_KERNEL_SQLITE_PATH,
      ...snapshotDatabaseUrlEnv(),
      COMMANDER_CELL_TENANT_ID: process.env.COMMANDER_CELL_TENANT_ID,
      NODE_ENV: process.env.NODE_ENV,
      COMMANDER_ADAPTER_OPS_DEMO_OPEN: process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN,
      ...snapshotCapabilityEnv(),
    };
    clearDatabaseUrlEnv();
    process.env.COMMANDER_KERNEL_BACKEND = 'sqlite';
    process.env.COMMANDER_KERNEL_SQLITE_PATH = dbPath;
    delete process.env.COMMANDER_CELL_TENANT_ID;
    delete process.env.NODE_ENV;
    delete process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN;
    clearCapabilityEnv();
    try {
      await assert.rejects(
        () => createAdapterOpsWiring(),
        (err: unknown) =>
          err instanceof Error && err.message.startsWith(COMMANDER_CELL_TENANT_ID_REQUIRED),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
      restoreEnv(saved);
    }
  });

  it('refuses production authority without PEM/JWKS/key id before egress', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ops-prod-auth-'));
    const dbPath = join(dir, 'kernel.sqlite');
    const saved = {
      NODE_ENV: process.env.NODE_ENV,
      COMMANDER_PROFILE: process.env.COMMANDER_PROFILE,
      COMMANDER_KERNEL_BACKEND: process.env.COMMANDER_KERNEL_BACKEND,
      COMMANDER_KERNEL_SQLITE_PATH: process.env.COMMANDER_KERNEL_SQLITE_PATH,
      COMMANDER_KERNEL_DATABASE_URL: process.env.COMMANDER_KERNEL_DATABASE_URL,
      DATABASE_URL: process.env.DATABASE_URL,
      COMMANDER_CELL_TENANT_ID: process.env.COMMANDER_CELL_TENANT_ID,
      COMMANDER_ADAPTER_OPS_DEMO_OPEN: process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN,
      ...snapshotCapabilityEnv(),
    };
    // Strict authority without NODE_ENV=production (sqlite refused in production).
    delete process.env.NODE_ENV;
    delete process.env.COMMANDER_PROFILE;
    process.env.COMMANDER_REQUIRE_CAPABILITY_AUTHORITY = '1';
    clearDatabaseUrlEnv();
    process.env.COMMANDER_KERNEL_BACKEND = 'sqlite';
    process.env.COMMANDER_KERNEL_SQLITE_PATH = dbPath;
    process.env.COMMANDER_CELL_TENANT_ID = 'local';
    delete process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN;
    delete process.env[CAPABILITY_PRIVATE_KEY_PEM_ENV];
    delete process.env[CAPABILITY_KEY_ID_ENV];
    delete process.env[CAPABILITY_JWKS_JSON_ENV];
    try {
      await assert.rejects(
        () => createAdapterOpsWiring(),
        (err: unknown) =>
          err instanceof Error && err.message.startsWith(CAPABILITY_AUTHORITY_REQUIRED),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
      restoreEnv(saved);
    }
  });

  it('refuses COMMANDER_ADAPTER_OPS_DEMO_OPEN=1 in production', async () => {
    const saved = {
      NODE_ENV: process.env.NODE_ENV,
      COMMANDER_PROFILE: process.env.COMMANDER_PROFILE,
      COMMANDER_CELL_TIER: process.env.COMMANDER_CELL_TIER,
      COMMANDER_ADAPTER_OPS_DEMO_OPEN: process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN,
      COMMANDER_KERNEL_BACKEND: process.env.COMMANDER_KERNEL_BACKEND,
      COMMANDER_KERNEL_DATABASE_URL: process.env.COMMANDER_KERNEL_DATABASE_URL,
    };
    process.env.NODE_ENV = 'production';
    process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN = '1';
    process.env.COMMANDER_KERNEL_BACKEND = 'postgres';
    process.env.COMMANDER_KERNEL_DATABASE_URL =
      'postgres://commander:commander@127.0.0.1:5432/commander';
    try {
      await assert.rejects(
        () => createAdapterOpsWiring(),
        /ADAPTER_OPS_DEMO_OPEN_FORBIDDEN_IN_PRODUCTION/,
      );
    } finally {
      restoreEnv(saved);
    }
  });

  it('refuses COMMANDER_ADAPTER_OPS_DEMO_OPEN=1 when COMMANDER_CELL_TIER=enterprise', async () => {
    const saved = {
      NODE_ENV: process.env.NODE_ENV,
      COMMANDER_PROFILE: process.env.COMMANDER_PROFILE,
      COMMANDER_CELL_TIER: process.env.COMMANDER_CELL_TIER,
      COMMANDER_ADAPTER_OPS_DEMO_OPEN: process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN,
      COMMANDER_KERNEL_BACKEND: process.env.COMMANDER_KERNEL_BACKEND,
      COMMANDER_KERNEL_DATABASE_URL: process.env.COMMANDER_KERNEL_DATABASE_URL,
    };
    delete process.env.NODE_ENV;
    delete process.env.COMMANDER_PROFILE;
    process.env.COMMANDER_CELL_TIER = 'enterprise';
    process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN = '1';
    process.env.COMMANDER_KERNEL_BACKEND = 'postgres';
    process.env.COMMANDER_KERNEL_DATABASE_URL =
      'postgres://commander:commander@127.0.0.1:5432/commander';
    try {
      await assert.rejects(
        () => createAdapterOpsWiring(),
        /ADAPTER_OPS_DEMO_OPEN_FORBIDDEN_IN_PRODUCTION/,
      );
    } finally {
      restoreEnv(saved);
    }
  });

  it('switches to hollow PEP when COMMANDER_ADAPTER_OPS_DEMO_OPEN=1 outside production', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ops-demo-open-'));
    const dbPath = join(dir, 'kernel.sqlite');
    const saved = {
      COMMANDER_KERNEL_BACKEND: process.env.COMMANDER_KERNEL_BACKEND,
      COMMANDER_KERNEL_SQLITE_PATH: process.env.COMMANDER_KERNEL_SQLITE_PATH,
      ...snapshotDatabaseUrlEnv(),
      COMMANDER_CELL_TENANT_ID: process.env.COMMANDER_CELL_TENANT_ID,
      NODE_ENV: process.env.NODE_ENV,
      COMMANDER_PROFILE: process.env.COMMANDER_PROFILE,
      COMMANDER_ADAPTER_OPS_DEMO_OPEN: process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN,
      ...snapshotCapabilityEnv(),
    };
    clearDatabaseUrlEnv();
    process.env.COMMANDER_KERNEL_BACKEND = 'sqlite';
    process.env.COMMANDER_KERNEL_SQLITE_PATH = dbPath;
    process.env.COMMANDER_CELL_TENANT_ID = 'local';
    delete process.env.NODE_ENV;
    delete process.env.COMMANDER_PROFILE;
    process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN = '1';
    clearCapabilityEnv();
    try {
      const wiring = await createAdapterOpsWiring();
      assert.equal(wiring.demoOpenHollowPep, true);
      await wiring.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      restoreEnv(saved);
    }
  });
});

describe('adapter-ops authority startup gates', () => {
  it('rejects startup when the PostgreSQL evidence RPC availability probe fails', async () => {
    await assert.rejects(
      () =>
        requireAdapterOpsEvidenceAuthorityAvailability({
          checkEvidenceRepositoryAvailability: async () => ({ ready: false }),
        }),
      (err: unknown) =>
        err instanceof Error && err.message === ADAPTER_OPS_EVIDENCE_AUTHORITY_UNAVAILABLE,
    );
    await assert.doesNotReject(() =>
      requireAdapterOpsEvidenceAuthorityAvailability({
        checkEvidenceRepositoryAvailability: async () => ({ ready: true }),
      }),
    );
  });

  it('rejects PostgreSQL runtime repositories without claim-bound evidence authority', () => {
    assert.throws(
      () => requireAdapterOpsEvidenceAuthority({}),
      (err: unknown) =>
        err instanceof Error && err.message === ADAPTER_OPS_EVIDENCE_AUTHORITY_UNAVAILABLE,
    );
  });

  it('rejects PostgreSQL compensation wiring without claim-bound terminal evidence RPCs', () => {
    assert.throws(
      () => requireAdapterOpsCompensationTerminalEvidenceAuthority({}),
      (err: unknown) =>
        err instanceof Error &&
        err.message === ADAPTER_OPS_COMPENSATION_TERMINAL_AUTHORITY_UNAVAILABLE,
    );
  });

  it('rejects missing private key before egress', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ops-miss-pem-'));
    const dbPath = join(dir, 'kernel.sqlite');
    const mat = ed25519Material('kid-ops');
    const saved = {
      NODE_ENV: process.env.NODE_ENV,
      COMMANDER_PROFILE: process.env.COMMANDER_PROFILE,
      COMMANDER_KERNEL_BACKEND: process.env.COMMANDER_KERNEL_BACKEND,
      COMMANDER_KERNEL_SQLITE_PATH: process.env.COMMANDER_KERNEL_SQLITE_PATH,
      ...snapshotDatabaseUrlEnv(),
      COMMANDER_CELL_TENANT_ID: process.env.COMMANDER_CELL_TENANT_ID,
      COMMANDER_ADAPTER_OPS_DEMO_OPEN: process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN,
      ...snapshotCapabilityEnv(),
    };
    delete process.env.NODE_ENV;
    delete process.env.COMMANDER_PROFILE;
    delete process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN;
    process.env.COMMANDER_REQUIRE_CAPABILITY_AUTHORITY = '1';
    clearDatabaseUrlEnv();
    process.env.COMMANDER_KERNEL_BACKEND = 'sqlite';
    process.env.COMMANDER_KERNEL_SQLITE_PATH = dbPath;
    process.env.COMMANDER_CELL_TENANT_ID = 'local';
    delete process.env[CAPABILITY_PRIVATE_KEY_PEM_ENV];
    process.env[CAPABILITY_KEY_ID_ENV] = mat.keyId;
    process.env[CAPABILITY_JWKS_JSON_ENV] = mat.jwksJson;
    try {
      await assert.rejects(
        () => createAdapterOpsWiring(),
        (err: unknown) =>
          err instanceof Error &&
          err.message.startsWith(CAPABILITY_AUTHORITY_REQUIRED) &&
          err.message.includes(CAPABILITY_PRIVATE_KEY_PEM_ENV),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
      restoreEnv(saved);
    }
  });

  it('rejects missing JWKS before egress', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ops-miss-jwks-'));
    const dbPath = join(dir, 'kernel.sqlite');
    const mat = ed25519Material('kid-ops');
    const saved = {
      NODE_ENV: process.env.NODE_ENV,
      COMMANDER_PROFILE: process.env.COMMANDER_PROFILE,
      COMMANDER_KERNEL_BACKEND: process.env.COMMANDER_KERNEL_BACKEND,
      COMMANDER_KERNEL_SQLITE_PATH: process.env.COMMANDER_KERNEL_SQLITE_PATH,
      ...snapshotDatabaseUrlEnv(),
      COMMANDER_CELL_TENANT_ID: process.env.COMMANDER_CELL_TENANT_ID,
      COMMANDER_ADAPTER_OPS_DEMO_OPEN: process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN,
      ...snapshotCapabilityEnv(),
    };
    delete process.env.NODE_ENV;
    delete process.env.COMMANDER_PROFILE;
    delete process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN;
    process.env.COMMANDER_REQUIRE_CAPABILITY_AUTHORITY = '1';
    clearDatabaseUrlEnv();
    process.env.COMMANDER_KERNEL_BACKEND = 'sqlite';
    process.env.COMMANDER_KERNEL_SQLITE_PATH = dbPath;
    process.env.COMMANDER_CELL_TENANT_ID = 'local';
    process.env[CAPABILITY_PRIVATE_KEY_PEM_ENV] = mat.privateKeyPem;
    process.env[CAPABILITY_KEY_ID_ENV] = mat.keyId;
    delete process.env[CAPABILITY_JWKS_JSON_ENV];
    try {
      await assert.rejects(
        () => createAdapterOpsWiring(),
        (err: unknown) =>
          err instanceof Error &&
          err.message.startsWith(CAPABILITY_AUTHORITY_REQUIRED) &&
          err.message.includes(CAPABILITY_JWKS_JSON_ENV),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
      restoreEnv(saved);
    }
  });

  it('rejects missing key id before egress', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ops-miss-kid-'));
    const dbPath = join(dir, 'kernel.sqlite');
    const mat = ed25519Material('kid-ops');
    const saved = {
      NODE_ENV: process.env.NODE_ENV,
      COMMANDER_PROFILE: process.env.COMMANDER_PROFILE,
      COMMANDER_KERNEL_BACKEND: process.env.COMMANDER_KERNEL_BACKEND,
      COMMANDER_KERNEL_SQLITE_PATH: process.env.COMMANDER_KERNEL_SQLITE_PATH,
      ...snapshotDatabaseUrlEnv(),
      COMMANDER_CELL_TENANT_ID: process.env.COMMANDER_CELL_TENANT_ID,
      COMMANDER_ADAPTER_OPS_DEMO_OPEN: process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN,
      ...snapshotCapabilityEnv(),
    };
    delete process.env.NODE_ENV;
    delete process.env.COMMANDER_PROFILE;
    delete process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN;
    process.env.COMMANDER_REQUIRE_CAPABILITY_AUTHORITY = '1';
    clearDatabaseUrlEnv();
    process.env.COMMANDER_KERNEL_BACKEND = 'sqlite';
    process.env.COMMANDER_KERNEL_SQLITE_PATH = dbPath;
    process.env.COMMANDER_CELL_TENANT_ID = 'local';
    process.env[CAPABILITY_PRIVATE_KEY_PEM_ENV] = mat.privateKeyPem;
    delete process.env[CAPABILITY_KEY_ID_ENV];
    process.env[CAPABILITY_JWKS_JSON_ENV] = mat.jwksJson;
    try {
      await assert.rejects(
        () => createAdapterOpsWiring(),
        (err: unknown) =>
          err instanceof Error &&
          err.message.startsWith(CAPABILITY_AUTHORITY_REQUIRED) &&
          err.message.includes(CAPABILITY_KEY_ID_ENV),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
      restoreEnv(saved);
    }
  });

  it('accepts only the dedicated adapter-ops DSN userinfo', () => {
    assert.throws(
      () =>
        assertNonOwnerDatabaseUrl(
          'postgres://commander_owner:commander_owner@postgres:5432/commander',
        ),
      (err: unknown) =>
        err instanceof Error && err.message.startsWith(OWNER_DATABASE_ROLE_REJECTED),
    );
    assert.throws(() =>
      assertNonOwnerDatabaseUrl(
        'postgres://commander_worker:commander_worker@postgres:5432/commander',
      ),
    );
    assert.doesNotThrow(() =>
      assertNonOwnerDatabaseUrl('postgres://commander_adapter_ops:secret@postgres:5432/commander'),
    );
  });

  it('accepts only the dedicated adapter-ops post-connect current_user', () => {
    assert.throws(
      () => assertNonOwnerDatabaseRole('commander_owner'),
      (err: unknown) =>
        err instanceof Error && err.message.startsWith(OWNER_DATABASE_ROLE_REJECTED),
    );
    assert.throws(
      () => assertNonOwnerDatabaseRole('commander_scheduler'),
      (err: unknown) =>
        err instanceof Error && err.message.startsWith(OWNER_DATABASE_ROLE_REJECTED),
    );
    assert.throws(() => assertNonOwnerDatabaseRole('commander_worker'));
    assert.doesNotThrow(() => assertNonOwnerDatabaseRole('commander_adapter_ops'));
  });

  it('rejects COMMANDER_KERNEL_SCHEDULER_MODE=1', () => {
    assert.throws(
      () => assertAdapterOpsSchedulerModeForbidden({ COMMANDER_KERNEL_SCHEDULER_MODE: '1' }),
      (err: unknown) =>
        err instanceof Error && err.message.startsWith(ADAPTER_OPS_SCHEDULER_MODE_FORBIDDEN),
    );
    assert.doesNotThrow(() =>
      assertAdapterOpsSchedulerModeForbidden({ COMMANDER_KERNEL_SCHEDULER_MODE: '0' }),
    );
  });

  it('rejects scheduler-role DSN userinfo', () => {
    assert.throws(
      () => assertNonOwnerDatabaseUrl('postgres://commander_scheduler:x@postgres:5432/commander'),
      (err: unknown) =>
        err instanceof Error && err.message.startsWith(OWNER_DATABASE_ROLE_REJECTED),
    );
  });

  it('rejects owner DSN via createAdapterOpsWiring before egress registry', async () => {
    const saved = {
      NODE_ENV: process.env.NODE_ENV,
      COMMANDER_PROFILE: process.env.COMMANDER_PROFILE,
      COMMANDER_KERNEL_BACKEND: process.env.COMMANDER_KERNEL_BACKEND,
      COMMANDER_KERNEL_DATABASE_URL: process.env.COMMANDER_KERNEL_DATABASE_URL,
      COMMANDER_ADAPTER_OPS_DEMO_OPEN: process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN,
      ...snapshotCapabilityEnv(),
    };
    delete process.env.NODE_ENV;
    delete process.env.COMMANDER_PROFILE;
    delete process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN;
    clearCapabilityEnv();
    process.env.COMMANDER_KERNEL_BACKEND = 'postgres';
    process.env.COMMANDER_KERNEL_DATABASE_URL =
      'postgres://commander_owner:commander_owner@127.0.0.1:5432/commander';
    try {
      await assert.rejects(
        () => createAdapterOpsWiring(),
        (err: unknown) =>
          err instanceof Error && err.message.startsWith(OWNER_DATABASE_ROLE_REJECTED),
      );
    } finally {
      restoreEnv(saved);
    }
  });

  it('rejects unavailable replay store before egress', () => {
    const mat = ed25519Material('kid-replay');
    const repo = new InMemoryKernelRepository();
    const capability = createCapabilityAuthority(
      {
        NODE_ENV: 'test',
        [CAPABILITY_PRIVATE_KEY_PEM_ENV]: mat.privateKeyPem,
        [CAPABILITY_KEY_ID_ENV]: mat.keyId,
        [CAPABILITY_JWKS_JSON_ENV]: mat.jwksJson,
      },
      repo,
    );
    assert.throws(
      () =>
        assertDurableCapabilityStores(capability, {
          isCapabilityRevoked: () => false,
          revokeCapability: async () => undefined,
        }),
      (err: unknown) =>
        err instanceof Error &&
        err.message.startsWith(CAPABILITY_DURABLE_STORES_REQUIRED) &&
        err.message.includes('consumeCapabilityReplay'),
    );
  });

  it('rejects unavailable revocation store before egress', () => {
    const mat = ed25519Material('kid-rev');
    const repo = new InMemoryKernelRepository();
    const capability = createCapabilityAuthority(
      {
        NODE_ENV: 'test',
        [CAPABILITY_PRIVATE_KEY_PEM_ENV]: mat.privateKeyPem,
        [CAPABILITY_KEY_ID_ENV]: mat.keyId,
        [CAPABILITY_JWKS_JSON_ENV]: mat.jwksJson,
      },
      repo,
    );
    assert.throws(
      () =>
        assertDurableCapabilityStores(capability, {
          consumeCapabilityReplay: async () => false,
        }),
      (err: unknown) =>
        err instanceof Error &&
        err.message.startsWith(CAPABILITY_DURABLE_STORES_REQUIRED) &&
        /isCapabilityRevoked|revokeCapability/.test(err.message),
    );
  });

  it('wires durable replay + revocations options from createCapabilityAuthority', () => {
    const mat = ed25519Material('kid-ok');
    const repo = new InMemoryKernelRepository();
    const capability = createCapabilityAuthority(
      {
        NODE_ENV: 'test',
        [CAPABILITY_PRIVATE_KEY_PEM_ENV]: mat.privateKeyPem,
        [CAPABILITY_KEY_ID_ENV]: mat.keyId,
        [CAPABILITY_JWKS_JSON_ENV]: mat.jwksJson,
      },
      repo,
    );
    assertDurableCapabilityStores(capability, repo);
    const opts = productionCapabilityBrokerOptions(
      capability,
      ADAPTER_OPS_COMPENSATION_WORKER_ID,
      3,
    );
    assert.ok(opts.replay);
    assert.equal(typeof opts.replay, 'function');
    assert.ok(opts.revocations);
    assert.equal(opts.requireDurableCapabilityStores, true);
    assert.equal(opts.localWorkerId, ADAPTER_OPS_COMPENSATION_WORKER_ID);
    assert.equal(opts.localWorkerGeneration, 3);
    assert.equal(capability.generated, false);
  });

  it('rejects replayForTenant factory that returns a non-consume store', () => {
    const mat = ed25519Material('kid-shape');
    const repo = new InMemoryKernelRepository();
    const capability = createCapabilityAuthority(
      {
        NODE_ENV: 'test',
        [CAPABILITY_PRIVATE_KEY_PEM_ENV]: mat.privateKeyPem,
        [CAPABILITY_KEY_ID_ENV]: mat.keyId,
        [CAPABILITY_JWKS_JSON_ENV]: mat.jwksJson,
      },
      repo,
    );
    assert.throws(
      () =>
        assertDurableCapabilityStores(
          {
            ...capability,
            replayForTenant: () => ({}) as never,
          },
          repo,
        ),
      (err: unknown) =>
        err instanceof Error &&
        err.message.startsWith(CAPABILITY_DURABLE_STORES_REQUIRED) &&
        err.message.includes('consume()'),
    );
  });
});

describe('adapter-ops P0 worker registry + compensation mint', () => {
  it('registers both daemon identities and pins compensation affinity', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ops-reg-'));
    const dbPath = join(dir, 'kernel.sqlite');
    const saved = {
      COMMANDER_KERNEL_BACKEND: process.env.COMMANDER_KERNEL_BACKEND,
      COMMANDER_KERNEL_SQLITE_PATH: process.env.COMMANDER_KERNEL_SQLITE_PATH,
      ...snapshotDatabaseUrlEnv(),
      COMMANDER_CELL_TENANT_ID: process.env.COMMANDER_CELL_TENANT_ID,
      COMMANDER_WORKER_TENANTS: process.env.COMMANDER_WORKER_TENANTS,
      COMMANDER_ADAPTER_OPS_INSTANCE_ID: process.env.COMMANDER_ADAPTER_OPS_INSTANCE_ID,
      COMMANDER_ADAPTER_OPS_CLAIM_SECRET_DIR: process.env.COMMANDER_ADAPTER_OPS_CLAIM_SECRET_DIR,
      NODE_ENV: process.env.NODE_ENV,
      COMMANDER_ADAPTER_OPS_DEMO_OPEN: process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN,
      ...snapshotCapabilityEnv(),
    };
    clearDatabaseUrlEnv();
    process.env.COMMANDER_KERNEL_BACKEND = 'sqlite';
    process.env.COMMANDER_KERNEL_SQLITE_PATH = dbPath;
    process.env.COMMANDER_CELL_TENANT_ID = 'local';
    process.env.COMMANDER_WORKER_TENANTS = 'tenant-a,tenant-b';
    process.env.COMMANDER_ADAPTER_OPS_INSTANCE_ID = 'pod-a';
    process.env.COMMANDER_ADAPTER_OPS_CLAIM_SECRET_DIR = join(dir, 'claim-secrets');
    delete process.env.NODE_ENV;
    delete process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN;
    clearCapabilityEnv();

    const workerRegistry = new InMemoryAdapterOpsWorkerRegistry();
    const registerCalls: string[] = [];
    const originalRegister = workerRegistry.register.bind(workerRegistry);
    workerRegistry.register = async (role, instanceId, tenantIds, previousClaimSecret) => {
      registerCalls.push(`${role}:${instanceId}`);
      return originalRegister(role, instanceId, tenantIds, previousClaimSecret);
    };

    try {
      const wiring = await createAdapterOpsWiring({ workerRegistry });
      assert.deepEqual(registerCalls.sort(), ['compensation:pod-a', 'reconcile:pod-a'].sort());
      assert.equal(wiring.compensationLocalWorkerId, 'compensation:pod-a');
      assert.equal(wiring.workers.compensation.id, 'compensation:pod-a');
      assert.equal(wiring.workers.reconcile.id, 'reconcile:pod-a');
      assert.ok(wiring.workers.reconcile.generation >= 1);
      assert.ok(wiring.workers.compensation.generation >= 1);
      assert.equal((await workerRegistry.get('reconcile:pod-a'))?.id, 'reconcile:pod-a');
      assert.equal((await workerRegistry.get('compensation:pod-a'))?.id, 'compensation:pod-a');
      await wiring.safeStop('test_invariant');
      await wiring.safeStop('duplicate_stop');
      assert.deepEqual(workerRegistry.drains.sort(), ['compensation:pod-a', 'reconcile:pod-a']);
      await wiring.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      restoreEnv(saved);
    }
  });

  it('fail-closed when registry required but COMMANDER_WORKER_TENANTS missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ops-tenants-'));
    const dbPath = join(dir, 'kernel.sqlite');
    const saved = {
      COMMANDER_KERNEL_BACKEND: process.env.COMMANDER_KERNEL_BACKEND,
      COMMANDER_KERNEL_SQLITE_PATH: process.env.COMMANDER_KERNEL_SQLITE_PATH,
      ...snapshotDatabaseUrlEnv(),
      COMMANDER_CELL_TENANT_ID: process.env.COMMANDER_CELL_TENANT_ID,
      COMMANDER_WORKER_TENANTS: process.env.COMMANDER_WORKER_TENANTS,
      NODE_ENV: process.env.NODE_ENV,
      COMMANDER_ADAPTER_OPS_DEMO_OPEN: process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN,
      ...snapshotCapabilityEnv(),
    };
    clearDatabaseUrlEnv();
    process.env.COMMANDER_KERNEL_BACKEND = 'sqlite';
    process.env.COMMANDER_KERNEL_SQLITE_PATH = dbPath;
    process.env.COMMANDER_CELL_TENANT_ID = 'local';
    delete process.env.COMMANDER_WORKER_TENANTS;
    delete process.env.NODE_ENV;
    delete process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN;
    clearCapabilityEnv();
    try {
      await assert.rejects(
        () => createAdapterOpsWiring({ workerRegistry: new InMemoryAdapterOpsWorkerRegistry() }),
        (err: unknown) =>
          err instanceof Error && err.message.startsWith(WORKER_TENANT_SCOPE_REQUIRED),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
      restoreEnv(saved);
    }
  });

  it('registerAdapterOpsDaemonWorkers writes both worker rows', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ops-worker-secrets-'));
    const registry = new InMemoryAdapterOpsWorkerRegistry();
    try {
      const result = await registerAdapterOpsDaemonWorkers(registry, ['tenant-a'], {
        instanceId: 'pod-b',
        claimSecretDir: dir,
      });
      assert.equal(result.reconcile.id, 'reconcile:pod-b');
      assert.equal(result.compensation.id, 'compensation:pod-b');
      assert.equal((await registry.get('reconcile:pod-b'))?.generation, 1);
      assert.equal((await registry.get('compensation:pod-b'))?.generation, 1);
      assert.ok(result.reconcile.claimSecret, 'reconcile register must return claimSecret');
      assert.ok(result.compensation.claimSecret, 'compensation register must return claimSecret');
      assert.notEqual(result.reconcile.claimSecret, result.compensation.claimSecret);

      const files = readdirSync(dir).sort();
      assert.equal(files.length, 2);
      for (const file of files) {
        assert.equal(statSync(join(dir, file)).mode & 0o777, 0o600);
      }

      await registerAdapterOpsDaemonWorkers(registry, ['tenant-a'], {
        instanceId: 'pod-b',
        claimSecretDir: dir,
      });
      assert.deepEqual(registry.previousSecrets, [
        undefined,
        undefined,
        'r'.repeat(43),
        'c'.repeat(43),
      ]);

      chmodSync(join(dir, files[0]!), 0o644);
      await assert.rejects(
        () =>
          registerAdapterOpsDaemonWorkers(registry, ['tenant-a'], {
            instanceId: 'pod-b',
            claimSecretDir: dir,
          }),
        /CLAIM_SECRET_FILE_INVALID/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps two Pod identities on four independent worker generations', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ops-worker-replicas-'));
    const registry = new InMemoryAdapterOpsWorkerRegistry();
    try {
      const podA = await registerAdapterOpsDaemonWorkers(registry, ['tenant-a'], {
        instanceId: 'adapter-ops-a',
        claimSecretDir: join(dir, 'a'),
      });
      const podB = await registerAdapterOpsDaemonWorkers(registry, ['tenant-a'], {
        instanceId: 'adapter-ops-b',
        claimSecretDir: join(dir, 'b'),
      });

      assert.deepEqual(
        [podA.reconcile.id, podA.compensation.id, podB.reconcile.id, podB.compensation.id].sort(),
        [
          'compensation:adapter-ops-a',
          'compensation:adapter-ops-b',
          'reconcile:adapter-ops-a',
          'reconcile:adapter-ops-b',
        ],
      );
      for (const workerId of [
        'reconcile:adapter-ops-a',
        'compensation:adapter-ops-a',
        'reconcile:adapter-ops-b',
        'compensation:adapter-ops-b',
      ]) {
        assert.equal((await registry.get(workerId))?.generation, 1);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('drains a partial registration when the second worker registration fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ops-worker-partial-'));
    const registry = new InMemoryAdapterOpsWorkerRegistry();
    const register = registry.register.bind(registry);
    registry.register = async (role, instanceId, tenantIds, previousClaimSecret) => {
      if (role === 'compensation') {
        throw Object.assign(new Error('second registration failed'), {
          code: 'SECOND_REGISTRATION_FAILED',
        });
      }
      return register(role, instanceId, tenantIds, previousClaimSecret);
    };
    try {
      await assert.rejects(
        () =>
          registerAdapterOpsDaemonWorkers(registry, ['tenant-a'], {
            instanceId: 'pod-partial',
            claimSecretDir: dir,
          }),
        { code: 'SECOND_REGISTRATION_FAILED' },
      );
      assert.deepEqual(registry.drains, ['reconcile:pod-partial']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('requires instanceId in enterprise and only defaults demo to local', () => {
    assert.equal(resolveAdapterOpsInstanceId({ COMMANDER_CELL_TIER: 'demo' }), 'local');
    assert.equal(
      resolveAdapterOpsInstanceId({
        COMMANDER_CELL_TIER: 'enterprise',
        COMMANDER_ADAPTER_OPS_INSTANCE_ID: 'pod-enterprise-1',
      }),
      'pod-enterprise-1',
    );
    assert.throws(
      () => resolveAdapterOpsInstanceId({ COMMANDER_CELL_TIER: 'enterprise' }),
      /ADAPTER_OPS_INSTANCE_ID_REQUIRED/,
    );
    for (const invalid of ['Pod-A', 'pod_a', 'pod:a', 'pod-a.']) {
      assert.throws(
        () =>
          resolveAdapterOpsInstanceId({
            COMMANDER_CELL_TIER: 'enterprise',
            COMMANDER_ADAPTER_OPS_INSTANCE_ID: invalid,
          }),
        /ADAPTER_OPS_INSTANCE_ID_REQUIRED/,
        invalid,
      );
    }
    assert.throws(
      () => resolveAdapterOpsInstanceId({ COMMANDER_CELL_TIER: 'standard' }),
      /ADAPTER_OPS_INSTANCE_ID_REQUIRED/,
    );
  });

  it('mints compensation only from persisted authority and caps token expiry', async () => {
    const mat = ed25519Material('kid-cmp');
    const repo = new InMemoryKernelRepository();
    const capability = createCapabilityAuthority(
      {
        NODE_ENV: 'test',
        [CAPABILITY_PRIVATE_KEY_PEM_ENV]: mat.privateKeyPem,
        [CAPABILITY_KEY_ID_ENV]: mat.keyId,
        [CAPABILITY_JWKS_JSON_ENV]: mat.jwksJson,
      },
      repo,
    );
    const request = {
      originalEffectId: 'effect-original',
      destination: 'k8s://cluster-a/default/deployments/api',
      forwardResponse: { originalRevision: '7' },
      compensationPatch: { targetRevision: '7' },
    };
    const now = new Date();
    const authorizationExpiresAt = new Date(now.getTime() + 30_000).toISOString();
    const authorization = sealGovernedCompensationAuthorization({
      schema: 'commander.compensation/v1' as const,
      authorizationId: 'authorization-7',
      requestId: 'request-8',
      tenantId: 'tenant-a',
      originalRunId: 'run-original',
      originalEffectId: 'effect-original',
      originalRunStateAtRequest: 'COMPENSATING',
      compensationRunId: 'run-compensation',
      compensationStepId: 'step-compensation',
      compensationEffectId: 'effect-compensation',
      compensationEffectType: 'compensate.kubernetes.deployment.rollback',
      compensationRequest: request,
      idempotencyKey: 'cmp:effect-original:1.0.0',
      forwardReceipt: { originalRevision: '7' },
      adapterVersion: '1.0.0',
      policyDecisionId: 'decision-persisted',
      policySnapshotId: 'snapshot-persisted',
      decisionEffect: 'allow' as const,
      authorizationExpiresAt,
      approvalBinding: null,
    });
    const token = issueCompensationCapabilityToken({
      issuer: capability.issuer,
      authorization,
      workerId: ADAPTER_OPS_COMPENSATION_WORKER_ID,
      workerGeneration: 2,
      now,
      ttlMs: 60_000,
    });
    const grant = await capability.verifier.verify(token);
    const governedGrant = grant as unknown as Record<string, unknown>;
    assert.equal(grant.tenantId, authorization.tenantId);
    assert.equal(grant.runId, authorization.compensationRunId);
    assert.equal(grant.stepId, authorization.compensationStepId);
    assert.deepEqual(grant.effectTypes, [authorization.compensationEffectType]);
    assert.equal(grant.requestHash, authorization.requestHash);
    assert.equal(grant.actionDigest, authorization.actionDigest);
    assert.equal(grant.policySnapshotId, authorization.policySnapshotId);
    assert.equal(grant.expiresAt, authorization.authorizationExpiresAt);
    assert.equal(governedGrant.policyDecisionId, authorization.policyDecisionId);
    assert.equal(governedGrant.authorizationId, authorization.authorizationId);
    assert.equal(governedGrant.requestId, authorization.requestId);
    assert.equal(governedGrant.adapterVersion, authorization.adapterVersion);
    assert.equal(governedGrant.decisionEffect, authorization.decisionEffect);
    assert.equal(governedGrant.approvalBinding, null);
    assert.equal(grant.workloadId, ADAPTER_OPS_COMPENSATION_WORKER_ID);
    assert.equal(grant.workerId, ADAPTER_OPS_COMPENSATION_WORKER_ID);
    assert.equal(grant.workerGeneration, 2);
    // jti must be opaque UUID (not deterministic ops-+Date.now()).
    assert.match(
      grant.jti,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('carries an approved durable compensation binding into the capability grant', async () => {
    const mat = ed25519Material('kid-cmp-approved');
    const repo = new InMemoryKernelRepository();
    const capability = createCapabilityAuthority(
      {
        NODE_ENV: 'test',
        [CAPABILITY_PRIVATE_KEY_PEM_ENV]: mat.privateKeyPem,
        [CAPABILITY_KEY_ID_ENV]: mat.keyId,
        [CAPABILITY_JWKS_JSON_ENV]: mat.jwksJson,
      },
      repo,
    );
    const approvalBinding = {
      approvalId: 'interaction-compensation-1',
      approverPrincipalId: 'reviewer-a',
      actionDigest: 'b'.repeat(64),
      policySnapshotId: 'snapshot-approved',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const durableAuthorization = {
      id: 'authorization-approved',
      tenantId: 'tenant-a',
      originalRunId: 'run-forward',
      originalEffectId: 'effect-forward',
      compensationEffectType: 'compensate.kubernetes.deployment.rollback',
      adapterVersion: '1.0.0',
      compensationPatch: { targetRevision: '2', reason: 'approved compensation' },
      forwardReceiptHash: 'a'.repeat(64),
      policyDecisionId: 'decision-approved',
      policySnapshotId: 'snapshot-approved',
      decision: 'require_approval' as const,
      actionDigest: approvalBinding.actionDigest,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      approvalInteractionId: approvalBinding.approvalId,
      approvalBinding,
    };
    const durableRequest = {
      id: 'request-approved',
      tenantId: 'tenant-a',
      originalRunId: 'run-forward',
      originalEffectId: 'effect-forward',
      compensationRunId: 'run-compensation',
      compensationStepId: 'step-compensation',
      adapterVersion: '1.0.0',
      compensationEffectType: durableAuthorization.compensationEffectType,
      destination: 'k8s://cluster-a/default/deployments/api',
      compensationPatch: durableAuthorization.compensationPatch,
      forwardReceiptHash: durableAuthorization.forwardReceiptHash,
      authorizationId: durableAuthorization.id,
      reconcilePolicy: {
        maxAttempts: 8,
        initialDelayMs: 30_000,
        maxDelayMs: 900_000,
        deadlineAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
      state: 'CLAIMED' as const,
      claimToken: 'request-claim-token',
      compensationEffectId: 'effect-compensation',
    };
    const token = issueCompensationCapabilityToken({
      issuer: capability.issuer,
      authorization: {
        authorization: durableAuthorization,
        request: durableRequest,
        forwardResponse: { originalRevision: '7' },
      },
      workerId: ADAPTER_OPS_COMPENSATION_WORKER_ID,
      workerGeneration: 2,
    });
    const grant = await capability.verifier.verify(token);
    assert.deepEqual(
      (grant as unknown as { approvalBinding?: typeof approvalBinding }).approvalBinding,
      approvalBinding,
    );
    assert.equal(
      grant.requestHash,
      canonicalCompensationHash({
        originalEffectId: durableRequest.originalEffectId,
        destination: durableRequest.destination,
        forwardResponse: { originalRevision: '7' },
        compensationPatch: durableRequest.compensationPatch,
      }),
    );
  });

  it('requires the complete governed compensation authority port', () => {
    const authority = {
      claimCompensationWork: async () => [],
      completeCompensationWork: async () => ({
        applied: true as const,
        disposition: 'COMPLETED' as const,
      }),
      handoffCompensationUnknown: async () => ({
        applied: true as const,
        disposition: 'HANDOFF_UNKNOWN' as const,
      }),
      escalateCompensationWork: async () => ({
        applied: true as const,
        disposition: 'ESCALATED' as const,
      }),
      parkCompensationUnknown: async () => ({ applied: true as const }),
      finalizeCompensation: async () => ({ applied: true as const }),
    };

    assert.equal(requireCompensationAuthority(authority), authority);
    assert.throws(
      () =>
        requireCompensationAuthority({
          claimCompensationWork: authority.claimCompensationWork,
          completeCompensationWork: authority.completeCompensationWork,
          handoffCompensationUnknown: authority.handoffCompensationUnknown,
        }),
      /COMPENSATION_AUTHORITY_UNAVAILABLE/,
    );
    assert.throws(
      () =>
        requireCompensationAuthority({
          claimOutboxByTopic: async () => [],
          markOutboxPublished: async () => true,
          retryOutbox: async () => true,
        }),
      /COMPENSATION_AUTHORITY_UNAVAILABLE/,
    );
  });
});

describe('adapter-ops egress fail-closed', () => {
  it('cellTier defaults to non-demo when COMMANDER_CELL_TIER is unset/empty', () => {
    assert.notEqual(cellTier({}), 'demo');
    assert.notEqual(cellTier({ COMMANDER_CELL_TIER: '' }), 'demo');
    assert.equal(cellTier({ COMMANDER_CELL_TIER: 'demo' }), 'demo');
    // Fail-closed default must trip the allowlist gate exactly like any other non-demo tier.
    assert.throws(
      () => assertEgressAllowlistBeforeDaemonStart(cellTier({}), []),
      /ADAPTER_OPS_EGRESS_ALLOWLIST_REQUIRED/,
    );
  });

  it('parses allowlist CSV', () => {
    assert.deepEqual(
      parseEgressAllowlist({
        COMMANDER_ADAPTER_EGRESS_ALLOWLIST: ' api.github.com, *.service-now.com ',
      }),
      ['api.github.com', '*.service-now.com'],
    );
  });

  it('adds the registered Kubernetes API hostname to the adapter allowlist', () => {
    assert.deepEqual(
      parseEgressAllowlist({
        COMMANDER_ADAPTER_EGRESS_ALLOWLIST: 'api.github.com',
        COMMANDER_KUBERNETES_SERVER: 'https://kubernetes.default.svc:443',
      }),
      ['api.github.com', 'kubernetes.default.svc'],
    );
  });

  it('blocks daemon start on non-demo without allowlist', () => {
    assert.throws(
      () => assertEgressAllowlistBeforeDaemonStart('enterprise', []),
      /ADAPTER_OPS_EGRESS_ALLOWLIST_REQUIRED/,
    );
    assert.throws(
      () => assertEgressAllowlistBeforeDaemonStart('standard', []),
      /ADAPTER_OPS_EGRESS_ALLOWLIST_REQUIRED/,
    );
  });

  it('allows demo tier with empty allowlist', () => {
    assert.doesNotThrow(() => assertEgressAllowlistBeforeDaemonStart('demo', []));
  });

  it('allows non-demo when allowlist is non-empty', () => {
    assert.doesNotThrow(() =>
      assertEgressAllowlistBeforeDaemonStart('enterprise', ['api.github.com']),
    );
  });

  it('denies transport hosts outside hostname allowlist', () => {
    assert.throws(
      () => assertEgressUrlAllowed('https://evil.example/x', ['api.github.com']),
      /ADAPTER_OPS_EGRESS_DENIED/,
    );
    assert.doesNotThrow(() =>
      assertEgressUrlAllowed('https://api.github.com/repos/o/r', ['api.github.com']),
    );
  });
});

/**
 * AO-01: safeStop drained the worker registrations first and then stopped the daemons
 * with `drain: false`, so the claim was released while a tick could still be executing.
 * The registry drain must happen after the in-flight tick has settled.
 */
describe('adapter-ops safeStop ordering (AO-01)', () => {
  it('waits for the in-flight tick before draining the worker registrations', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ops-safestop-'));
    const dbPath = join(dir, 'kernel.sqlite');
    const saved = {
      COMMANDER_KERNEL_BACKEND: process.env.COMMANDER_KERNEL_BACKEND,
      COMMANDER_KERNEL_SQLITE_PATH: process.env.COMMANDER_KERNEL_SQLITE_PATH,
      ...snapshotDatabaseUrlEnv(),
      COMMANDER_CELL_TENANT_ID: process.env.COMMANDER_CELL_TENANT_ID,
      COMMANDER_WORKER_TENANTS: process.env.COMMANDER_WORKER_TENANTS,
      COMMANDER_ADAPTER_OPS_INSTANCE_ID: process.env.COMMANDER_ADAPTER_OPS_INSTANCE_ID,
      COMMANDER_ADAPTER_OPS_CLAIM_SECRET_DIR: process.env.COMMANDER_ADAPTER_OPS_CLAIM_SECRET_DIR,
      NODE_ENV: process.env.NODE_ENV,
      COMMANDER_ADAPTER_OPS_DEMO_OPEN: process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN,
      ...snapshotCapabilityEnv(),
    };
    clearDatabaseUrlEnv();
    process.env.COMMANDER_KERNEL_BACKEND = 'sqlite';
    process.env.COMMANDER_KERNEL_SQLITE_PATH = dbPath;
    process.env.COMMANDER_CELL_TENANT_ID = 'local';
    process.env.COMMANDER_WORKER_TENANTS = 'tenant-a';
    process.env.COMMANDER_ADAPTER_OPS_INSTANCE_ID = 'pod-a';
    process.env.COMMANDER_ADAPTER_OPS_CLAIM_SECRET_DIR = join(dir, 'claim-secrets');
    delete process.env.NODE_ENV;
    delete process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN;
    clearCapabilityEnv();

    const workerRegistry = new InMemoryAdapterOpsWorkerRegistry();
    const events: string[] = [];
    const originalDrain = workerRegistry.drain.bind(workerRegistry);
    workerRegistry.drain = async (workerId: string) => {
      events.push(`drain:${workerId}`);
      return originalDrain(workerId);
    };

    let releaseClaim: () => void = () => {};
    const claimGate = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });
    const unused = async (): Promise<never> => {
      throw new Error('unexpected compensation authority call');
    };
    const compensationAuthority: CompensationOutboxPort = {
      claimCompensationWork: async () => {
        events.push('tick:claim-started');
        await claimGate;
        events.push('tick:claim-finished');
        return [];
      },
      parkCompensationUnknown: unused,
      finalizeCompensation: unused,
    };

    try {
      const wiring = await createAdapterOpsWiring({ workerRegistry, compensationAuthority });
      const tick = wiring.compensation.tick().catch(() => undefined);
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(events, ['tick:claim-started']);

      const stopping = wiring.safeStop('ws6_ordering');
      for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
      // The tick is still blocked in its claim: nothing may be drained yet.
      assert.deepEqual(events, ['tick:claim-started']);

      releaseClaim();
      await stopping;
      await tick;
      assert.deepEqual(events, [
        'tick:claim-started',
        'tick:claim-finished',
        'drain:reconcile:pod-a',
        'drain:compensation:pod-a',
      ]);
      assert.deepEqual(workerRegistry.drains.sort(), ['compensation:pod-a', 'reconcile:pod-a']);
      await wiring.close();
    } finally {
      // Never leave the gated claim hanging, even when an assertion above failed.
      releaseClaim();
      rmSync(dir, { recursive: true, force: true });
      restoreEnv(saved);
    }
  });
});

/**
 * AO-07 (bare `Number()` daemon knobs), AO-08 (non-durable claim authority),
 * AO-09 (evidence signer production signals) and AO-10 (registered identities
 * left behind by a later startup failure).
 */
describe('adapter-ops startup fail-closed gates (AO-07/08/09/10)', () => {
  const GATE_ENV_KEYS = [
    'COMMANDER_KERNEL_BACKEND',
    'COMMANDER_KERNEL_SQLITE_PATH',
    'COMMANDER_CELL_TENANT_ID',
    'COMMANDER_CELL_TIER',
    'COMMANDER_ENV',
    'COMMANDER_PROFILE',
    'COMMANDER_WORKER_TENANTS',
    'COMMANDER_ADAPTER_OPS_INSTANCE_ID',
    'COMMANDER_ADAPTER_OPS_CLAIM_SECRET_DIR',
    'COMMANDER_ADAPTER_OPS_DEMO_OPEN',
    'COMMANDER_REQUIRE_WORKLOAD_BINDING',
    'COMMANDER_RECONCILE_INTERVAL_MS',
    'COMMANDER_RECONCILE_BATCH_SIZE',
    'COMMANDER_RECONCILE_WORKER_GENERATION',
    'COMMANDER_RECONCILE_QUERY_TIMEOUT_MS',
    'COMMANDER_COMPENSATION_INTERVAL_MS',
    'COMMANDER_COMPENSATION_BATCH_SIZE',
    EVIDENCE_SIGNING_PRIVATE_KEY_PEM_ENV,
    EVIDENCE_SIGNING_KEY_ID_ENV,
    ...DATABASE_URL_ENV_KEYS,
  ] as const;

  function snapshotGateEnv(): Record<string, string | undefined> {
    const out: Record<string, string | undefined> = {};
    for (const key of GATE_ENV_KEYS) out[key] = process.env[key];
    return out;
  }

  function clearDaemonKnobs(): void {
    for (const key of [
      'COMMANDER_RECONCILE_INTERVAL_MS',
      'COMMANDER_RECONCILE_BATCH_SIZE',
      'COMMANDER_RECONCILE_WORKER_GENERATION',
      'COMMANDER_RECONCILE_QUERY_TIMEOUT_MS',
      'COMMANDER_COMPENSATION_INTERVAL_MS',
      'COMMANDER_COMPENSATION_BATCH_SIZE',
    ]) {
      delete process.env[key];
    }
  }

  function setSqliteEnv(dir: string): void {
    clearDatabaseUrlEnv();
    process.env.COMMANDER_KERNEL_BACKEND = 'sqlite';
    process.env.COMMANDER_KERNEL_SQLITE_PATH = join(dir, 'kernel.sqlite');
    process.env.COMMANDER_CELL_TENANT_ID = 'local';
    delete process.env.COMMANDER_CELL_TIER;
    delete process.env.COMMANDER_ENV;
    delete process.env.COMMANDER_PROFILE;
    delete process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN;
    delete process.env.COMMANDER_REQUIRE_WORKLOAD_BINDING;
    delete process.env.NODE_ENV;
    clearDaemonKnobs();
    clearCapabilityEnv();
    delete process.env[EVIDENCE_SIGNING_PRIVATE_KEY_PEM_ENV];
    delete process.env[EVIDENCE_SIGNING_KEY_ID_ENV];
  }

  it('rejects malformed daemon intervals, batch sizes and generation (AO-07)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ops-ao07-'));
    const saved = snapshotGateEnv();
    setSqliteEnv(dir);
    try {
      for (const [name, value] of [
        ['COMMANDER_RECONCILE_INTERVAL_MS', 'abc'],
        ['COMMANDER_RECONCILE_INTERVAL_MS', '0'],
        ['COMMANDER_RECONCILE_INTERVAL_MS', '-5'],
        ['COMMANDER_COMPENSATION_INTERVAL_MS', 'NaN'],
        ['COMMANDER_RECONCILE_BATCH_SIZE', '0'],
        ['COMMANDER_COMPENSATION_BATCH_SIZE', '1.5'],
        ['COMMANDER_RECONCILE_WORKER_GENERATION', 'gen-1'],
      ] as const) {
        clearDaemonKnobs();
        process.env[name] = value;
        await assert.rejects(
          () => createAdapterOpsWiring(),
          /must be a positive integer/,
          `${name}=${value}`,
        );
      }
      // A budget at the kernel's fixed 60s claim lease is refused by the daemon.
      clearDaemonKnobs();
      process.env.COMMANDER_RECONCILE_QUERY_TIMEOUT_MS = '60000';
      await assert.rejects(() => createAdapterOpsWiring(), /RECONCILE_QUERY_TIMEOUT_INVALID/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      restoreEnv(saved);
    }
  });

  it('accepts valid knobs but reports no durable claim authority without a registry (AO-08)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ops-ao08-'));
    const saved = snapshotGateEnv();
    setSqliteEnv(dir);
    process.env.COMMANDER_RECONCILE_INTERVAL_MS = '2500';
    try {
      const wiring = await createAdapterOpsWiring();
      // Non-demo without a durable registry: the readiness gate must NOT be a
      // no-op, and no fabricated claim secret may be presented as an identity.
      assert.equal(wiring.requiresDurableClaim, true);
      assert.equal(wiring.workers.reconcile.claimSecret, undefined);
      assert.equal(wiring.workers.compensation.claimSecret, undefined);
      await wiring.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      restoreEnv(saved);
    }
  });

  it('refuses a production-signal start without a durable worker registry (AO-08)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ops-ao08-prod-'));
    const saved = snapshotGateEnv();
    setSqliteEnv(dir);
    const material = ed25519Material('kid-ao08');
    // REQUIRE_WORKLOAD_BINDING is an adapter-ops production signal but not a
    // kernel backend signal, so sqlite is still allowed to reach the gate.
    process.env[EVIDENCE_SIGNING_PRIVATE_KEY_PEM_ENV] = material.privateKeyPem;
    process.env[EVIDENCE_SIGNING_KEY_ID_ENV] = material.keyId;
    process.env.COMMANDER_REQUIRE_WORKLOAD_BINDING = '1';
    try {
      await assert.rejects(
        () => createAdapterOpsWiring(),
        (error: unknown) =>
          error instanceof Error &&
          error.message.startsWith(ADAPTER_OPS_DURABLE_CLAIM_AUTHORITY_REQUIRED),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
      restoreEnv(saved);
    }
  });

  it('requires a signing key for every production/enterprise signal (AO-09)', () => {
    for (const env of [
      { NODE_ENV: 'production' },
      { COMMANDER_ENV: 'production' },
      { COMMANDER_PROFILE: 'enterprise' },
      { COMMANDER_CELL_TIER: 'enterprise' },
      { COMMANDER_REQUIRE_WORKLOAD_BINDING: '1' },
    ] as NodeJS.ProcessEnv[]) {
      assert.throws(
        () => createAdapterOpsEvidenceSigner(env),
        /EVIDENCE_SIGNING_KEY_REQUIRED/,
        JSON.stringify(env),
      );
    }
    assert.equal(createAdapterOpsEvidenceSigner({ NODE_ENV: 'development' }), null);
  });

  it('drains registered identities when startup fails after registration (AO-10)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ops-ao10-'));
    const saved = snapshotGateEnv();
    setSqliteEnv(dir);
    process.env.COMMANDER_WORKER_TENANTS = 'tenant-a';
    process.env.COMMANDER_ADAPTER_OPS_INSTANCE_ID = 'pod-a';
    process.env.COMMANDER_ADAPTER_OPS_CLAIM_SECRET_DIR = join(dir, 'claim-secrets');
    // Registration succeeds; the next step (daemon construction) must be
    // preceded by a failure that revokes both identities.
    process.env.COMMANDER_RECONCILE_INTERVAL_MS = 'not-a-number';
    const workerRegistry = new InMemoryAdapterOpsWorkerRegistry();
    try {
      await assert.rejects(
        () => createAdapterOpsWiring({ workerRegistry }),
        /must be a positive integer/,
      );
      assert.deepEqual(workerRegistry.drains.sort(), ['compensation:pod-a', 'reconcile:pod-a']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      restoreEnv(saved);
    }
  });
});
