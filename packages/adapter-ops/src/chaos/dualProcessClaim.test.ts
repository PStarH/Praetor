import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { type EvidenceSigner } from '@praetor/effect-broker';
import {
  PostgresKernelRepository,
  runKernelMigrations,
  seedWorkerAllowedTenants,
  type KernelRepository,
  type AdapterOpsEvidenceContextAuthority,
  type PostgresKernelRepositoryOptions,
  type SqlPool,
  type SqlQueryResult,
} from '../../../kernel/src/index.js';
import { runTask1ClosureMigrations } from '../../../kernel/src/migrations.js';
import { PostgresTenantContextAuthority } from '../../../kernel/src/postgres.js';
import { ReconciliationDaemon, type ReconciliationDaemonOptions } from '../reconciliationDaemon.js';

const TEST_EVIDENCE_SIGNER: EvidenceSigner = {
  sign: async () => ({
    algorithm: 'Ed25519',
    keyId: 'dual-process-test-key',
    signedAt: '2026-07-29T00:00:01.000Z',
    value: 'dual-process-test-signature',
  }),
  verify: () => true,
};

const ownerUrl = process.env.COMMANDER_TASK1_PG_URL?.trim();
const CHILD_FLAG = '--dual-process-claim-child';
const require = createRequire(import.meta.url);

interface LiveTestPool extends SqlPool {
  query<T = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<SqlQueryResult<T>>;
  end(): Promise<void>;
}

type LiveTestPoolConstructor = new (options: {
  connectionString: string;
  max: number;
}) => LiveTestPool;

const { Pool } = require('pg') as { Pool: LiveTestPoolConstructor };

interface TestRepositoryHandle {
  repository: KernelRepository;
  postgresPool: LiveTestPool;
  close(): Promise<void>;
}

function adaptReconciliationRepository(
  repository: KernelRepository,
): ReconciliationDaemonOptions['repository'] {
  return {
    listEffectsForRun: (runId, tenantId) => repository.listEffectsForRun(runId, tenantId),
    listEvents: (runId, tenantId) => repository.listEvents(runId, tenantId),
    claimReconcileEffects: (input) => repository.claimReconcileEffects(input),
    completeReconcileEffect: (input) => repository.completeReconcileEffect(input),
    confirmEffectNotApplied: (input) => repository.confirmEffectNotApplied(input),
    rescheduleReconcileEffect: (input) => repository.rescheduleReconcileEffect(input),
    escalateReconcileEffect: (input) =>
      repository.escalateReconcileEffect({
        ...input,
        reason:
          input.reason === 'COMPENSATION_QUERY_UNSUPPORTED'
            ? 'RECONCILE_QUERY_UNSUPPORTED'
            : input.reason,
      }),
  };
}

type Registration = { id: string; generation: number; claimSecret: string };

const DEPLOY_GATE_ROLES = [
  'commander_owner',
  'commander_app',
  'commander_tenant_authority',
  'commander_scheduler',
  'commander_worker',
  'commander_adapter_ops',
] as const;

const RUNTIME_DEPLOY_GATE_ROLES = DEPLOY_GATE_ROLES.filter((role) => role !== 'commander_owner');

type DeployGateRole = (typeof DEPLOY_GATE_ROLES)[number];

interface DeployGateRoleSnapshot {
  rolname: DeployGateRole;
  rolsuper: boolean;
  rolinherit: boolean;
  rolcreaterole: boolean;
  rolcreatedb: boolean;
  rolcanlogin: boolean;
  rolreplication: boolean;
  rolbypassrls: boolean;
  rolconnlimit: number;
  rolpassword: string | null;
  rolvaliduntil: Date | null;
}

interface DeployGateMembershipSnapshot {
  roleName: DeployGateRole;
  grantorName: string;
  adminOption: boolean;
  inheritOption: boolean;
  setOption: boolean;
}

interface DeployGateAuthoritySnapshot {
  roles: DeployGateRoleSnapshot[];
  memberships: DeployGateMembershipSnapshot[];
  testGrantor: string;
}

type ChildMessage =
  | { type: 'claimed'; registration: Registration; effectId: string; claimToken: string }
  | { type: 'survivor-ready'; registration: Registration; firstClaimed: number }
  | { type: 'survivor-done'; secondClaimed: number; completed: number }
  | { type: 'child-error'; message: string };

function databaseIdentifier(databaseName: string): string {
  if (!/^commander_dual_process_[a-z0-9_]+$/.test(databaseName)) {
    throw new Error('unsafe dual-process test database identifier');
  }
  return `"${databaseName}"`;
}

function databaseUrl(baseUrl: string, databaseName: string, role?: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  if (role) {
    url.username = role;
    url.password = role;
  }
  return url.toString();
}

function isDeployGateRole(value: string): value is DeployGateRole {
  return (DEPLOY_GATE_ROLES as readonly string[]).includes(value);
}

async function snapshotDeployGateAuthority(
  pool: LiveTestPool,
): Promise<DeployGateAuthoritySnapshot> {
  // pg_authid access is deliberate: this test changes role passwords and cannot
  // safely restore an existing role unless its original verifier is readable.
  const roles = await pool.query<Omit<DeployGateRoleSnapshot, 'rolname'> & { rolname: string }>(
    `SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin,
            rolreplication, rolbypassrls, rolconnlimit, rolpassword, rolvaliduntil
       FROM pg_catalog.pg_authid
      WHERE rolname = ANY($1::text[])
      ORDER BY rolname`,
    [DEPLOY_GATE_ROLES],
  );
  const memberships = await pool.query<{
    role_name: string;
    grantor_name: string;
    admin_option: boolean;
    inherit_option: boolean;
    set_option: boolean;
  }>(
    `SELECT role.rolname AS role_name,
            grantor.rolname AS grantor_name,
            membership.admin_option,
            membership.inherit_option,
            membership.set_option
       FROM pg_catalog.pg_auth_members AS membership
       JOIN pg_catalog.pg_roles AS role ON role.oid = membership.roleid
       JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
       JOIN pg_catalog.pg_roles AS grantor ON grantor.oid = membership.grantor
      WHERE role.rolname = ANY($1::text[])
        AND member.rolname = 'commander_owner'
      ORDER BY role.rolname, grantor.rolname`,
    [RUNTIME_DEPLOY_GATE_ROLES],
  );
  const identity = await pool.query<{ current_user: string }>('SELECT current_user');

  return {
    roles: roles.rows.map((role) => {
      if (!isDeployGateRole(role.rolname)) {
        throw new Error(`unexpected deploy-gate role snapshot: ${role.rolname}`);
      }
      return { ...role, rolname: role.rolname };
    }),
    memberships: memberships.rows.map((membership) => {
      if (!isDeployGateRole(membership.role_name)) {
        throw new Error(`unexpected deploy-gate membership snapshot: ${membership.role_name}`);
      }
      return {
        roleName: membership.role_name,
        grantorName: membership.grantor_name,
        adminOption: membership.admin_option,
        inheritOption: membership.inherit_option,
        setOption: membership.set_option,
      };
    }),
    testGrantor: identity.rows[0]!.current_user,
  };
}

async function restoreDeployGateAuthority(
  pool: LiveTestPool,
  snapshot: DeployGateAuthoritySnapshot,
): Promise<void> {
  const originalRoles = new Set(snapshot.roles.map((role) => role.rolname));

  for (const role of RUNTIME_DEPLOY_GATE_ROLES) {
    // The test grants this edge as its own database identity. CASCADE is necessary
    // because a pre-existing commander_owner grant can depend on that admin option.
    const revoked = await pool.query<{ statement: string }>(
      `SELECT format(
         'REVOKE %I FROM commander_owner GRANTED BY %I CASCADE',
         $1::text,
         $2::text
       ) AS statement`,
      [role, snapshot.testGrantor],
    );
    await pool.query(revoked.rows[0]!.statement);
  }

  for (const role of snapshot.roles) {
    const restored = await pool.query<{ statement: string }>(
      `SELECT format(
         'ALTER ROLE %I WITH %s %s %s %s %s %s %s CONNECTION LIMIT %s PASSWORD %L%s',
         $1::text,
         CASE WHEN $2 THEN 'SUPERUSER' ELSE 'NOSUPERUSER' END,
         CASE WHEN $3 THEN 'INHERIT' ELSE 'NOINHERIT' END,
         CASE WHEN $4 THEN 'CREATEROLE' ELSE 'NOCREATEROLE' END,
         CASE WHEN $5 THEN 'CREATEDB' ELSE 'NOCREATEDB' END,
         CASE WHEN $6 THEN 'LOGIN' ELSE 'NOLOGIN' END,
         CASE WHEN $7 THEN 'REPLICATION' ELSE 'NOREPLICATION' END,
         CASE WHEN $8 THEN 'BYPASSRLS' ELSE 'NOBYPASSRLS' END,
         $9::integer,
         $10::text,
         CASE
           WHEN $11::timestamptz IS NULL THEN ''
           ELSE format(' VALID UNTIL %L', $11::timestamptz)
         END
       ) AS statement`,
      [
        role.rolname,
        role.rolsuper,
        role.rolinherit,
        role.rolcreaterole,
        role.rolcreatedb,
        role.rolcanlogin,
        role.rolreplication,
        role.rolbypassrls,
        role.rolconnlimit,
        role.rolpassword,
        role.rolvaliduntil,
      ],
    );
    await pool.query(restored.rows[0]!.statement);
  }

  for (const membership of [...snapshot.memberships].sort((left, right) => {
    if (left.grantorName === 'commander_owner' && right.grantorName !== 'commander_owner') {
      return 1;
    }
    if (right.grantorName === 'commander_owner' && left.grantorName !== 'commander_owner') {
      return -1;
    }
    return left.grantorName.localeCompare(right.grantorName);
  })) {
    const granted = await pool.query<{ statement: string }>(
      `SELECT format(
         'GRANT %I TO commander_owner WITH%sINHERIT %s, SET %s GRANTED BY %I',
         $1::text,
         CASE WHEN $2 THEN ' ADMIN OPTION, ' ELSE ' ' END,
         CASE WHEN $3 THEN 'TRUE' ELSE 'FALSE' END,
         CASE WHEN $4 THEN 'TRUE' ELSE 'FALSE' END,
         $5::text
       ) AS statement`,
      [
        membership.roleName,
        membership.adminOption,
        membership.inheritOption,
        membership.setOption,
        membership.grantorName,
      ],
    );
    await pool.query(granted.rows[0]!.statement);
  }

  for (const role of RUNTIME_DEPLOY_GATE_ROLES) {
    if (!originalRoles.has(role)) await pool.query(`DROP ROLE ${role}`);
  }
  if (!originalRoles.has('commander_owner')) await pool.query('DROP ROLE commander_owner');
}

function repositoryHandle(
  databaseUrl: string,
  options: PostgresKernelRepositoryOptions = {},
): TestRepositoryHandle {
  const postgresPool = new Pool({ connectionString: databaseUrl, max: 8 });
  return {
    repository: new PostgresKernelRepository(postgresPool, options),
    postgresPool,
    close: () => postgresPool.end(),
  };
}

function adapterHandle(databaseUrl: string): TestRepositoryHandle {
  return repositoryHandle(databaseUrl, { adapterOpsMode: true });
}

async function registerReconciliationWorker(
  handle: TestRepositoryHandle,
  instanceId: string,
  tenantId: string,
  previousClaimSecret?: string,
): Promise<Registration> {
  const result = await handle.postgresPool!.query<{
    registration: { id: string; generation: number | string; claim_secret: string };
  }>(`SELECT register_adapter_ops_worker('reconcile',$1,$2::jsonb,$3::text) AS registration`, [
    instanceId,
    JSON.stringify([tenantId]),
    previousClaimSecret ?? null,
  ]);
  const registration = result.rows[0]!.registration;
  return {
    id: registration.id,
    generation: Number(registration.generation),
    claimSecret: registration.claim_secret,
  };
}

async function runClaimantChild(config: {
  databaseUrl: string;
  instanceId: string;
  tenantId: string;
}): Promise<void> {
  const handle = await adapterHandle(config.databaseUrl);
  try {
    const registration = await registerReconciliationWorker(
      handle,
      config.instanceId,
      config.tenantId,
    );
    const claims = await handle.repository.claimReconcileEffects({
      workerId: registration.id,
      workerGeneration: registration.generation,
      claimSecret: registration.claimSecret,
      limit: 1,
      claimTtlMs: 1_200,
    });
    assert.equal(claims.length, 1);
    process.send?.({
      type: 'claimed',
      registration,
      effectId: claims[0]!.effect.id,
      claimToken: claims[0]!.claimToken,
    } satisfies ChildMessage);
    await new Promise<void>(() => undefined);
  } finally {
    await handle.close();
  }
}

async function runSurvivorChild(config: {
  databaseUrl: string;
  instanceId: string;
  tenantId: string;
  queryUrl: string;
}): Promise<void> {
  const handle = await adapterHandle(config.databaseUrl);
  try {
    const registration = await registerReconciliationWorker(
      handle,
      config.instanceId,
      config.tenantId,
    );
    const daemon = new ReconciliationDaemon({
      repository: adaptReconciliationRepository(handle.repository),
      terminalEvidenceContext: {
        getTerminalEvidenceContext: (effectId, runId, tenantId, claimToken) =>
          (
            handle.repository as KernelRepository & AdapterOpsEvidenceContextAuthority
          ).getAdapterOpsEvidenceContext({
            workerId: registration.id,
            workerGeneration: registration.generation,
            claimSecret: registration.claimSecret,
            tenantId,
            runId,
            effectId,
            claimToken,
          }),
      },
      registry: {
        resolve: () => ({}),
        outcomeQuerierFor: () => ({ queryOutcome: async () => ({ status: 'APPLIED' }) }) as never,
      },
      brokerFactory: () => ({
        reconcileUnknown: async () => {
          const response = await fetch(config.queryUrl, { method: 'GET' });
          assert.equal(response.status, 200);
          return { status: 'APPLIED', response: { observed: true } };
        },
      }),
      evidenceSigner: TEST_EVIDENCE_SIGNER,
      pollIntervalMs: 60_000,
      batchSize: 1,
      workerId: registration.id,
      workerGeneration: registration.generation,
      claimSecret: registration.claimSecret,
    });
    const first = await daemon.tick();
    process.send?.({
      type: 'survivor-ready',
      registration,
      firstClaimed: first.claimed,
    } satisfies ChildMessage);
    await new Promise<void>((resolve) => {
      process.once('message', (message) => {
        if (message === 'resume') resolve();
      });
    });
    const second = await daemon.tick();
    process.send?.({
      type: 'survivor-done',
      secondClaimed: second.claimed,
      completed: second.completed,
    } satisfies ChildMessage);
  } finally {
    await handle.close();
  }
}

async function runChild(): Promise<void> {
  const encoded = process.argv[process.argv.indexOf(CHILD_FLAG) + 1];
  if (!encoded) throw new Error('child configuration is required');
  const config = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as
    | ({ role: 'claimant' } & Parameters<typeof runClaimantChild>[0])
    | ({ role: 'survivor' } & Parameters<typeof runSurvivorChild>[0]);
  if (config.role === 'claimant') await runClaimantChild(config);
  else await runSurvivorChild(config);
}

function spawnChild(config: object): ChildProcess {
  return fork(
    fileURLToPath(import.meta.url),
    [CHILD_FLAG, Buffer.from(JSON.stringify(config)).toString('base64url')],
    {
      cwd: process.cwd(),
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  );
}

function nextMessage<T extends ChildMessage['type']>(
  child: ChildProcess,
  type: T,
  timeoutMs = 15_000,
): Promise<Extract<ChildMessage, { type: T }>> {
  return new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ${type}: ${stderr}`));
    }, timeoutMs);
    const onMessage = (message: ChildMessage) => {
      if (message.type === 'child-error') {
        cleanup();
        reject(new Error(message.message));
      } else if (message.type === type) {
        cleanup();
        resolve(message as Extract<ChildMessage, { type: T }>);
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`child exited before ${type}: code=${code} signal=${signal} ${stderr}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
    };
    child.on('message', onMessage);
    child.on('exit', onExit);
  });
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', () => resolve()));
}

if (process.argv.includes(CHILD_FLAG)) {
  void runChild().then(
    () => {
      process.exitCode = 0;
    },
    (error) => {
      process.send?.({
        type: 'child-error',
        message: error instanceof Error ? (error.stack ?? error.message) : String(error),
      } satisfies ChildMessage);
      process.exitCode = 1;
    },
  );
} else {
  describe('adapter-ops real PostgreSQL dual-process reconciliation', { skip: !ownerUrl }, () => {
    const suffix = `${process.pid}-${randomUUID().replaceAll('-', '').slice(0, 10)}`;
    const databaseName = `commander_dual_process_${suffix.replaceAll('-', '_')}`;
    const tenantId = `dual-process-${suffix}`;
    const forwardWorkerId = `dual-forward-${suffix}`;
    const instanceA = `dual-a-${suffix}`.toLowerCase();
    const instanceB = `dual-b-${suffix}`.toLowerCase();
    const ownerDatabaseUrl = databaseUrl(ownerUrl!, databaseName, 'commander_owner');
    const appDatabaseUrl = databaseUrl(ownerUrl!, databaseName, 'commander_app');
    const authorityDatabaseUrl = databaseUrl(ownerUrl!, databaseName, 'commander_tenant_authority');
    const adapterDatabaseUrl = databaseUrl(ownerUrl!, databaseName, 'commander_adapter_ops');
    const workerDatabaseUrl = databaseUrl(ownerUrl!, databaseName, 'commander_worker');
    let adminPool: LiveTestPool | undefined;
    let authorityPool: LiveTestPool;
    let ownerHandle: TestRepositoryHandle;
    let appHandle: TestRepositoryHandle;
    let workerHandle: TestRepositoryHandle;
    let adapterParentHandle: TestRepositoryHandle;
    let effectId: string;
    let claimant: ChildProcess | undefined;
    let survivor: ChildProcess | undefined;
    let deployGateAuthoritySnapshot: DeployGateAuthoritySnapshot | undefined;

    before(async () => {
      adminPool = new Pool({ connectionString: ownerUrl!, max: 2 });
      deployGateAuthoritySnapshot = await snapshotDeployGateAuthority(adminPool);
      // The CI service starts with only its bootstrap user. Create the
      // least-authority roles before altering them and running migrations.
      for (const role of DEPLOY_GATE_ROLES) {
        await adminPool.query(
          `DO $do$ BEGIN
             IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = '${role}') THEN
               CREATE ROLE ${role};
             END IF;
           END $do$;`,
        );
      }
      await adminPool.query(
        `ALTER ROLE commander_owner LOGIN NOSUPERUSER NOCREATEDB CREATEROLE INHERIT
           NOREPLICATION BYPASSRLS PASSWORD 'commander_owner'`,
      );
      for (const role of RUNTIME_DEPLOY_GATE_ROLES) {
        await adminPool.query(
          `ALTER ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
             NOREPLICATION NOBYPASSRLS PASSWORD '${role}'`,
        );
        await adminPool.query(
          `GRANT ${role} TO commander_owner WITH ADMIN OPTION, INHERIT FALSE, SET TRUE`,
        );
      }
      await adminPool.query(
        `CREATE DATABASE ${databaseIdentifier(databaseName)} OWNER commander_owner`,
      );
      ownerHandle = repositoryHandle(ownerDatabaseUrl, { schedulerMode: true });
      await runKernelMigrations(ownerHandle.postgresPool!);
      await runTask1ClosureMigrations(ownerHandle.postgresPool, 'expand');
      await runTask1ClosureMigrations(ownerHandle.postgresPool, 'enforce');
      await runKernelMigrations(ownerHandle.postgresPool);
      await seedWorkerAllowedTenants(ownerHandle.postgresPool!, [tenantId]);
      await ownerHandle.postgresPool.query(
        'INSERT INTO public.commander_tenant_authority_allowed_tenants (tenant_id) VALUES ($1)',
        [tenantId],
      );
      authorityPool = new Pool({ connectionString: authorityDatabaseUrl, max: 2 });
      appHandle = repositoryHandle(appDatabaseUrl, {
        tenantContextPhase: 'enforce',
        tenantContextAuthority: new PostgresTenantContextAuthority(authorityPool),
      });
      workerHandle = repositoryHandle(workerDatabaseUrl);
      adapterParentHandle = adapterHandle(adapterDatabaseUrl);

      const worker = await workerHandle.postgresPool!.query<{
        registration: { generation: number | string; claim_secret: string };
      }>(
        `SELECT register_worker($1,'tool','dual-process','["tool","effect.execute"]','{}',1,$1,$2::jsonb,NULL) AS registration`,
        [forwardWorkerId, JSON.stringify([tenantId])],
      );
      const workerGeneration = Number(worker.rows[0]!.registration.generation);
      const workerClaimSecret = worker.rows[0]!.registration.claim_secret;
      const runId = `dual-run-${suffix}`;
      const stepId = `dual-step-${suffix}`;
      effectId = `dual-effect-${suffix}`;
      await ownerHandle.repository.createRun(
        {
          id: runId,
          tenantId,
          intentHash: `dual-intent-${suffix}`,
          workGraphHash: `dual-graph-${suffix}`,
          workGraphVersion: 'v1',
          policySnapshotId: 'dual-policy-v1',
          steps: [{ id: stepId, kind: 'tool', maxAttempts: 1 }],
        },
        'dual-process-test',
      );
      const step = await workerHandle.repository.claimNextStep({
        workerId: forwardWorkerId,
        workerGeneration,
        claimSecret: workerClaimSecret,
        capabilities: ['tool'],
        leaseTtlMs: 60_000,
      });
      assert.ok(step?.lease);
      const admitted = await workerHandle.repository.admitEffect({
        id: effectId,
        runId,
        stepId,
        tenantId,
        type: 'read.cache',
        idempotencyKey: `dual-idempotency-${suffix}`,
        policyDecisionId: 'dual-policy-decision',
        policySnapshotId: 'dual-policy-v1',
        actionDigest: 'd'.repeat(64),
        request: { destination: 'cache://dual-process', key: suffix },
        lease: step.lease,
        actor: forwardWorkerId,
      });
      assert.equal(admitted.admitted, true);
      const parked = await workerHandle.repository.parkEffectCompletionUnknown({
        tenantId,
        effectId,
        workerId: forwardWorkerId,
        workerGeneration,
        claimSecret: workerClaimSecret,
        leaseToken: step.lease.token,
        fencingEpoch: step.lease.fencingEpoch,
        error: { code: 'REMOTE_RESPONSE_LOST', message: 'Remote response lost after commit' },
      });
      assert.equal(parked.parked, true);
      const requested = await appHandle.repository.requestReconcile({
        tenantId,
        effectId,
        actor: 'dual-process-test',
      });
      assert.equal(requested.scheduled, true);
    });

    after(async () => {
      claimant?.kill('SIGKILL');
      survivor?.kill('SIGKILL');
      await Promise.allSettled([
        adapterParentHandle?.close(),
        workerHandle?.close(),
        appHandle?.close(),
        authorityPool?.end(),
        ownerHandle?.close(),
      ]);
      if (adminPool) {
        try {
          await adminPool.query(`DROP DATABASE IF EXISTS ${databaseIdentifier(databaseName)}`);
          if (!deployGateAuthoritySnapshot) {
            throw new Error('deploy-gate authority snapshot was not captured');
          }
          await restoreDeployGateAuthority(adminPool, deployGateAuthoritySnapshot);
        } finally {
          await adminPool.end();
        }
      }
    });

    it('fences a killed owner and lets a distinct survivor query once after claim expiry', async () => {
      let forwardWrites = 1;
      let outcomeQueries = 0;
      const server = createServer((request, response) => {
        if (request.method === 'GET' && request.url === '/outcome') {
          outcomeQueries += 1;
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end('{"status":"APPLIED"}');
          return;
        }
        forwardWrites += 1;
        response.writeHead(405).end();
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      assert.ok(address && typeof address === 'object');

      try {
        claimant = spawnChild({
          role: 'claimant',
          databaseUrl: adapterDatabaseUrl,
          instanceId: instanceA,
          tenantId,
        });
        const claim = await nextMessage(claimant, 'claimed');
        assert.equal(claim.effectId, effectId);
        assert.equal(claim.registration.id, `reconcile:${instanceA}`);
        const claimantExit = waitForExit(claimant);
        claimant.kill('SIGKILL');
        await claimantExit;

        const replacementA = await registerReconciliationWorker(
          adapterParentHandle,
          instanceA,
          tenantId,
          claim.registration.claimSecret,
        );
        assert.equal(replacementA.generation, claim.registration.generation + 1);
        await assert.rejects(
          adapterParentHandle.repository.listEffectsForRun(`dual-run-${suffix}`, tenantId),
          /permission denied/i,
        );
        await assert.rejects(
          (
            adapterParentHandle.repository as KernelRepository & AdapterOpsEvidenceContextAuthority
          ).getAdapterOpsEvidenceContext({
            workerId: claim.registration.id,
            workerGeneration: claim.registration.generation,
            claimSecret: claim.registration.claimSecret,
            tenantId,
            runId: `dual-run-${suffix}`,
            effectId,
            claimToken: claim.claimToken,
          }),
          /ADAPTER_OPS_EVIDENCE_CONTEXT_DENIED/,
        );
        const staleCompletion = await adapterParentHandle.repository.completeReconcileEffect({
          tenantId,
          effectId,
          workerId: claim.registration.id,
          workerGeneration: claim.registration.generation,
          claimSecret: claim.registration.claimSecret,
          claimToken: claim.claimToken,
          response: { stale: true },
        });
        assert.deepEqual(staleCompletion, { applied: false, reason: 'WORKER_FENCED' });

        survivor = spawnChild({
          role: 'survivor',
          databaseUrl: adapterDatabaseUrl,
          instanceId: instanceB,
          tenantId,
          queryUrl: `http://127.0.0.1:${address.port}/outcome`,
        });
        const ready = await nextMessage(survivor, 'survivor-ready');
        assert.equal(ready.registration.id, `reconcile:${instanceB}`);
        assert.equal(ready.registration.generation, 1);
        assert.equal(ready.firstClaimed, 0, 'unexpired claim must remain exclusive');

        await ownerHandle.postgresPool!.query(
          `UPDATE commander_effects
              SET reconcile_claim_expires_at = clock_timestamp() - interval '1 millisecond'
            WHERE id = $1 AND tenant_id = $2`,
          [effectId, tenantId],
        );
        const survivorExit = waitForExit(survivor);
        const donePromise = nextMessage(survivor, 'survivor-done');
        survivor.send('resume');
        const done = await donePromise;
        assert.equal(done.secondClaimed, 1);
        assert.equal(done.completed, 1);
        await survivorExit;

        const effect = await ownerHandle.repository.getEffect(effectId, tenantId);
        assert.equal(effect?.state, 'COMPLETED');
        assert.equal(outcomeQueries, 1);
        assert.equal(forwardWrites, 1, 'reconciliation must never retry the consequential write');
        const workers = await ownerHandle.postgresPool!.query<{ id: string; generation: string }>(
          `SELECT id, generation::text FROM commander_workers
            WHERE id = ANY($1::text[]) ORDER BY id`,
          [[`reconcile:${instanceA}`, `reconcile:${instanceB}`]],
        );
        assert.deepEqual(workers.rows, [
          { id: `reconcile:${instanceA}`, generation: String(replacementA.generation) },
          { id: `reconcile:${instanceB}`, generation: '1' },
        ]);
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    });
  });
}
