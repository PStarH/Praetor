import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type { SqlClient } from './postgres.js';
import { PostgresKernelRepository } from './postgres.js';
import {
  assertEvidenceRecordBoundToEffect,
  type KernelEvidenceRecord,
  type KernelEvidenceSignature,
} from './evidenceRepository.js';
import {
  generateWorkerClaimSecret,
  hashWorkerClaimSecret,
  verifyWorkerClaimSecret,
} from './claimSecret.js';
import type {
  ClaimStepRequest,
  AdmitEffectRequest,
  AdmitEffectResult,
  KernelEffect,
  KernelRunState,
  KernelStep,
  KernelStepState,
  MarkEffectCompletionUnknownRequest,
  OperationsReadiness,
  ParkEffectCompletionUnknownInput,
  ParkEffectCompletionUnknownResult,
  ReconcileClaimAuth,
  ReconcileMutationResult,
  ReconcileQueryError,
  RequestReconcileInput,
  RequestReconcileResult,
  RequestCompensationInput,
  RequestCompensationResult,
  CompensationAuthorizationRecord,
  KernelCompensationRequest,
  ClaimCompensationRequestInput,
  ClaimedCompensationRequest,
  FinalizeCompensationInput,
  ParkCompensationUnknownInput as ParkCompensationRequestUnknownInput,
  CompensationMutationResult,
} from './types.js';
import { OPERATIONS_HEARTBEAT_TTL_MS } from './types.js';
import { assertRunTransition, assertStepTransition } from './transitionValidation.js';
import { deriveEffectIdempotencyKey } from '@praetor/effect-broker';
import {
  SQLITE_KERNEL_17_TO_18_MIGRATION_SQL,
  SQLITE_KERNEL_PREVIOUS_SCHEMA_VERSION,
  SQLITE_KERNEL_SCHEMA_SQL,
  SQLITE_KERNEL_SCHEMA_VERSION,
} from './sqliteSchema.js';
import { createSqlitePool } from './sqlitePool.js';
import {
  KERNEL_COMPENSATION_TOPIC,
  type ClaimedCompensationWork,
  type CompensationClaimAuth,
} from './ops/compensationConsumer.js';
import { createReconcilePolicy, nextReconcileAfter } from './reconcilePolicy.js';
import {
  canonicalCompensationHash,
  sealGovernedCompensationAuthorization,
  validateGovernedCompensationAuthorization,
  type GovernedCompensationAuthorization,
} from './ops/compensationAuthority.js';
import { durableCompensationMetadataAuthorization } from './ops/compensationPersistence.js';
import {
  reqString,
  reqInteger,
  reqStringArray,
  reqJsonObject,
  reqOptionalJsonObject,
  reqEnum,
  STEP_STATES,
  EFFECT_STATES,
  TIMER_TYPES,
  TIMER_STATES,
} from './sqliteRowGuards.js';

export interface SqliteKernelRepositoryOptions {
  /** File path; :memory: only in tests when allowMemory=true */
  path: string;
  allowMemory?: boolean;
  wal?: boolean;
  busyTimeoutMs?: number;
  synchronous?: 'FULL' | 'NORMAL';
  schedulerMode?: boolean;
}

function fromStepAdapter(row: Record<string, unknown>): KernelStep {
  const lease =
    row.lease_token && row.lease_worker_id && row.lease_expires_at
      ? {
          workerId: reqString('commander_steps', row, 'lease_worker_id'),
          workerGeneration: reqInteger('commander_steps', row, 'lease_worker_generation'),
          token: reqString('commander_steps', row, 'lease_token'),
          fencingEpoch: reqInteger('commander_steps', row, 'fencing_epoch'),
          expiresAt: reqString('commander_steps', row, 'lease_expires_at'),
        }
      : undefined;
  return {
    id: reqString('commander_steps', row, 'id'),
    runId: reqString('commander_steps', row, 'run_id'),
    tenantId: reqString('commander_steps', row, 'tenant_id'),
    kind: reqString('commander_steps', row, 'kind'),
    state: reqEnum('commander_steps', row, 'state', STEP_STATES),
    version: reqInteger('commander_steps', row, 'version'),
    attempt: reqInteger('commander_steps', row, 'attempt'),
    maxAttempts: reqInteger('commander_steps', row, 'max_attempts'),
    priority: reqInteger('commander_steps', row, 'priority'),
    dependencies: reqStringArray('commander_steps', row, 'dependencies'),
    input: reqJsonObject('commander_steps', row, 'input'),
    output: reqOptionalJsonObject('commander_steps', row, 'output'),
    error: reqOptionalJsonObject<KernelStep['error']>('commander_steps', row, 'error'),
    scheduledAt: reqString('commander_steps', row, 'scheduled_at'),
    lease,
    createdAt: reqString('commander_steps', row, 'created_at'),
    updatedAt: reqString('commander_steps', row, 'updated_at'),
  };
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function fromEffectAdapter(row: Record<string, unknown>): KernelEffect {
  return {
    id: reqString('commander_effects', row, 'id'),
    runId: reqString('commander_effects', row, 'run_id'),
    stepId: reqString('commander_effects', row, 'step_id'),
    tenantId: reqString('commander_effects', row, 'tenant_id'),
    type: reqString('commander_effects', row, 'type'),
    idempotencyKey: reqString('commander_effects', row, 'idempotency_key'),
    requestHash: reqString('commander_effects', row, 'request_hash'),
    policyDecisionId: reqString('commander_effects', row, 'policy_decision_id'),
    policySnapshotId: String(row.policy_snapshot_id || 'legacy-unbound'),
    actionDigest: String(row.action_digest || row.request_hash),
    leaseWorkerId: String(row.lease_worker_id || 'legacy-unbound'),
    leaseWorkerGeneration: Number(row.lease_worker_generation ?? 0),
    leaseFencingEpoch: Number(row.lease_fencing_epoch ?? 0),
    state: reqEnum('commander_effects', row, 'state', EFFECT_STATES),
    request: reqJsonObject('commander_effects', row, 'request'),
    response:
      row.response == null ? undefined : (parseJsonValue(row.response) as Record<string, unknown>),
    createdAt: new Date(String(row.created_at)).toISOString(),
    completedAt: row.completed_at ? new Date(String(row.completed_at)).toISOString() : undefined,
    reconcileAttempts: Number(row.reconcile_attempts ?? 0),
    governedActionDeadlineAt: row.governed_action_deadline_at
      ? new Date(String(row.governed_action_deadline_at)).toISOString()
      : null,
    reconcilePolicy:
      row.reconcile_max_attempts == null ||
      row.reconcile_initial_delay_ms == null ||
      row.reconcile_max_delay_ms == null ||
      row.reconcile_deadline_at == null
        ? null
        : {
            maxAttempts: Number(row.reconcile_max_attempts),
            initialDelayMs: Number(row.reconcile_initial_delay_ms),
            maxDelayMs: Number(row.reconcile_max_delay_ms),
            deadlineAt: new Date(String(row.reconcile_deadline_at)).toISOString(),
          },
    reconcileDisposition:
      (row.reconcile_disposition as KernelEffect['reconcileDisposition']) ?? null,
    reconcileAfter: row.reconcile_after
      ? new Date(String(row.reconcile_after)).toISOString()
      : null,
    reconcileObservedAt: row.reconcile_observed_at
      ? new Date(String(row.reconcile_observed_at)).toISOString()
      : null,
    reconcileClaimToken: (row.reconcile_claim_token as string | null) ?? null,
    reconcileClaimExpiresAt: row.reconcile_claim_expires_at
      ? new Date(String(row.reconcile_claim_expires_at)).toISOString()
      : null,
    reconcileClaimedAt: row.reconcile_claimed_at
      ? new Date(String(row.reconcile_claimed_at)).toISOString()
      : null,
    reconcileClaimWorkerId: (row.reconcile_claim_worker_id as string | null) ?? null,
    reconcileClaimWorkerGeneration:
      row.reconcile_claim_worker_generation == null
        ? null
        : Number(row.reconcile_claim_worker_generation),
    reconcileLastError:
      row.reconcile_last_error == null
        ? null
        : (parseJsonValue(row.reconcile_last_error) as KernelEffect['reconcileLastError']),
    reconcileEscalatedAt: row.reconcile_escalated_at
      ? new Date(String(row.reconcile_escalated_at)).toISOString()
      : null,
    reconcileEscalationCode:
      (row.reconcile_escalation_code as KernelEffect['reconcileEscalationCode']) ?? null,
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function evidenceFromSqlite(row: Record<string, unknown>): KernelEvidenceRecord {
  return {
    tenantId: String(row.tenant_id),
    runId: String(row.run_id),
    bundleId: String(row.bundle_id),
    actionDigest: String(row.action_digest),
    body: parseJsonValue(row.body) as Record<string, unknown>,
    contentHash: String(row.content_hash),
    signature: parseJsonValue(row.signature) as KernelEvidenceSignature,
    createdAt: new Date(String(row.created_at)).toISOString(),
    anchoredAt: row.anchored_at ? new Date(String(row.anchored_at)).toISOString() : null,
    retentionUntil: new Date(String(row.retention_until)).toISOString(),
  };
}

/** SQLite implementation of KernelRepository — single-writer, BEGIN IMMEDIATE claims. */
export class SqliteKernelRepository extends PostgresKernelRepository {
  private readonly db: Database.Database;
  /**
   * Claim-path scheduler flag. Distinct from parent `options.schedulerMode`, which
   * must stay true so Postgres `enforceAppRole` (session_user::text) is never
   * applied to the SQLite pool.
   */
  private readonly claimSchedulerMode: boolean;

  protected override enforceAtomicOperationsReadiness(): boolean {
    return false;
  }

  constructor(private readonly sqliteOptions: SqliteKernelRepositoryOptions) {
    if (sqliteOptions.path === ':memory:' && !sqliteOptions.allowMemory) {
      throw new Error(':memory: SQLite path requires explicit allowMemory test flag');
    }
    const parentDir = dirname(sqliteOptions.path);
    if (sqliteOptions.path !== ':memory:' && parentDir && parentDir !== '.') {
      mkdirSync(parentDir, { recursive: true, mode: 0o700 });
    }
    const db = new Database(sqliteOptions.path);
    const claimSchedulerMode = sqliteOptions.schedulerMode ?? true;
    // Always pass schedulerMode:true to parent — enforceAppRole is PG-LOGIN only.
    super(createSqlitePool(db), { schedulerMode: true });
    this.db = db;
    this.claimSchedulerMode = claimSchedulerMode;
  }

  async initialize(): Promise<void> {
    const wal = this.sqliteOptions.wal ?? true;
    const busyTimeoutMs = this.sqliteOptions.busyTimeoutMs ?? 5000;
    const synchronous = this.sqliteOptions.synchronous ?? 'NORMAL';
    this.db.pragma('foreign_keys = ON');
    if (wal && this.sqliteOptions.path !== ':memory:') {
      this.db.pragma('journal_mode = WAL');
    }
    this.db.pragma(`busy_timeout = ${busyTimeoutMs}`);
    this.db.pragma(`synchronous = ${synchronous}`);
    this.db.pragma('foreign_keys = OFF');
    this.db.pragma('legacy_alter_table = ON');
    try {
      this.db.transaction(() => {
        const hasVersionTable = Boolean(
          this.db
            .prepare(
              `SELECT 1 FROM sqlite_master WHERE type='table' AND name='commander_kernel_schema'`,
            )
            .get(),
        );
        const versions = hasVersionTable
          ? (this.db
              .prepare('SELECT version FROM commander_kernel_schema')
              .pluck()
              .all() as string[])
          : [];
        if (
          versions.includes(SQLITE_KERNEL_PREVIOUS_SCHEMA_VERSION) &&
          !versions.includes(SQLITE_KERNEL_SCHEMA_VERSION)
        ) {
          this.db.exec(SQLITE_KERNEL_17_TO_18_MIGRATION_SQL);
        }
        this.db.exec(SQLITE_KERNEL_SCHEMA_SQL);
        this.migrateCapabilityRevocationsPk();
        this.db
          .prepare(`INSERT OR IGNORE INTO commander_kernel_schema (version) VALUES (?)`)
          .run(SQLITE_KERNEL_SCHEMA_VERSION);
        const violations = this.db.pragma('foreign_key_check') as unknown[];
        if (violations.length > 0) throw new Error('SQLITE_KERNEL_FOREIGN_KEY_CHECK_FAILED');
      })();
    } finally {
      this.db.pragma('legacy_alter_table = OFF');
      this.db.pragma('foreign_keys = ON');
    }
    if (this.sqliteOptions.path !== ':memory:' && existsSync(this.sqliteOptions.path)) {
      chmodSync(this.sqliteOptions.path, 0o600);
      const dir = dirname(this.sqliteOptions.path);
      if (dir && existsSync(dir)) chmodSync(dir, 0o700);
    }
  }

  close(): void {
    this.db.close();
  }

  override async appendEvidence(record: KernelEvidenceRecord): Promise<{ inserted: boolean }> {
    return this.db.transaction(() => {
      const result = this.db
        .prepare(
          `INSERT OR IGNORE INTO commander_evidence_receipts
             (tenant_id, run_id, bundle_id, action_digest, body, content_hash, signature,
              created_at, anchored_at, retention_until)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          record.tenantId,
          record.runId,
          record.bundleId,
          record.actionDigest,
          JSON.stringify(record.body),
          record.contentHash,
          JSON.stringify(record.signature),
          record.createdAt,
          record.anchoredAt,
          record.retentionUntil,
        );
      if (result.changes === 1) return { inserted: true };
      const existing = this.db
        .prepare(
          `SELECT * FROM commander_evidence_receipts
           WHERE tenant_id=? AND bundle_id=?`,
        )
        .get(record.tenantId, record.bundleId) as Record<string, unknown> | undefined;
      if (!existing || canonicalJson(evidenceFromSqlite(existing)) !== canonicalJson(record)) {
        throw new Error('EVIDENCE_CONFLICT');
      }
      return { inserted: false };
    })();
  }

  private async appendSqliteEvidenceInTransaction(
    client: SqlClient,
    record: KernelEvidenceRecord,
  ): Promise<{ inserted: boolean }> {
    const result = await client.query(
      `INSERT OR IGNORE INTO commander_evidence_receipts
         (tenant_id, run_id, bundle_id, action_digest, body, content_hash, signature,
          created_at, anchored_at, retention_until)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        record.tenantId,
        record.runId,
        record.bundleId,
        record.actionDigest,
        record.body,
        record.contentHash,
        record.signature,
        record.createdAt,
        record.anchoredAt,
        record.retentionUntil,
      ],
    );
    if ((result.rowCount ?? 0) === 1) return { inserted: true };
    const existing = await client.query<Record<string, unknown>>(
      `SELECT * FROM commander_evidence_receipts WHERE tenant_id=? AND bundle_id=?`,
      [record.tenantId, record.bundleId],
    );
    if (
      !existing.rows[0] ||
      canonicalJson(evidenceFromSqlite(existing.rows[0])) !== canonicalJson(record)
    ) {
      throw new Error('EVIDENCE_CONFLICT');
    }
    return { inserted: false };
  }

  override async getEvidence(
    runId: string,
    tenantId: string,
  ): Promise<KernelEvidenceRecord | null> {
    const row = this.db
      .prepare(
        `SELECT * FROM commander_evidence_receipts
         WHERE run_id=? AND tenant_id=?
         ORDER BY created_at DESC, bundle_id DESC LIMIT 1`,
      )
      .get(runId, tenantId) as Record<string, unknown> | undefined;
    return row ? evidenceFromSqlite(row) : null;
  }

  override async listEvidence(tenantId: string): Promise<KernelEvidenceRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM commander_evidence_receipts
         WHERE tenant_id=? ORDER BY created_at, bundle_id`,
      )
      .all(tenantId) as Array<Record<string, unknown>>;
    return rows.map(evidenceFromSqlite);
  }

  /**
   * Rebuild capability revocations when legacy global-jti PRIMARY KEY is present.
   * New installs already use PRIMARY KEY (tenant_id, jti) from SQLITE_KERNEL_SCHEMA_SQL.
   */
  private migrateCapabilityRevocationsPk(): void {
    const cols = this.db
      .prepare(`PRAGMA table_info(commander_capability_revocations)`)
      .all() as Array<{
      name: string;
      pk: number;
    }>;
    if (cols.length === 0) return;
    const pkCols = cols
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name);
    if (!(pkCols.length === 1 && pkCols[0] === 'jti')) return;
    this.db.exec(`
      CREATE TABLE commander_capability_revocations_new (
        tenant_id TEXT NOT NULL,
        jti TEXT NOT NULL,
        revoked_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL,
        reason TEXT,
        PRIMARY KEY (tenant_id, jti)
      );
      INSERT OR IGNORE INTO commander_capability_revocations_new (tenant_id, jti, revoked_at, expires_at, reason)
        SELECT tenant_id, jti, revoked_at, expires_at, reason FROM commander_capability_revocations;
      DROP TABLE commander_capability_revocations;
      ALTER TABLE commander_capability_revocations_new RENAME TO commander_capability_revocations;
      CREATE INDEX IF NOT EXISTS commander_capability_revocations_exp_idx
        ON commander_capability_revocations (expires_at);
    `);
  }

  /**
   * Test helper: register/replace a worker row for claim/fencing contract tests.
   * `tenantIds` is the durable authz set read by worker-mode `claimNextStep`.
   * Returns the plaintext claim secret (required on worker-mode claims).
   */
  seedTestWorker(
    workerId: string,
    tenantIds: string[],
    generation = 1,
    options?: {
      status?: 'ACTIVE' | 'DRAINING' | 'OFFLINE';
      claimSecret?: string;
      capabilities?: string[];
      registeredAt?: Date;
      lastHeartbeatAt?: Date;
      identitySubject?: string;
    },
  ): string {
    const status = options?.status ?? 'ACTIVE';
    const claimSecret = options?.claimSecret ?? generateWorkerClaimSecret();
    this.db
      .prepare(
        `INSERT INTO commander_workers (id,kind,version,capabilities,max_concurrency,status,generation,active_steps,identity_subject,tenant_ids,registered_at,last_heartbeat_at)
       VALUES (?,?,?,?,?,?,?,0,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         status=excluded.status,
         generation=excluded.generation,
         capabilities=excluded.capabilities,
         identity_subject=excluded.identity_subject,
         tenant_ids=excluded.tenant_ids,
         registered_at=excluded.registered_at,
         last_heartbeat_at=excluded.last_heartbeat_at`,
      )
      .run(
        workerId,
        'agent',
        'test',
        JSON.stringify(options?.capabilities ?? ['agent', 'tool']),
        10,
        status,
        generation,
        options?.identitySubject ?? workerId,
        JSON.stringify(tenantIds),
        (options?.registeredAt ?? new Date()).toISOString(),
        (options?.lastHeartbeatAt ?? new Date()).toISOString(),
      );
    this.db
      .prepare(
        `INSERT INTO commander_worker_claim_secrets (worker_id, generation, secret_hash, updated_at)
       VALUES (?,?,?,datetime('now'))
       ON CONFLICT(worker_id) DO UPDATE SET
         generation=excluded.generation,
         secret_hash=excluded.secret_hash,
         updated_at=datetime('now')`,
      )
      .run(workerId, generation, hashWorkerClaimSecret(claimSecret));
    return claimSecret;
  }

  override async getOperationsReadiness(
    tenantId: string,
    at = new Date(),
  ): Promise<OperationsReadiness> {
    const threshold = new Date(at.getTime() - OPERATIONS_HEARTBEAT_TTL_MS).toISOString();
    const rows = this.db
      .prepare(
        `SELECT capabilities, COUNT(*) AS count
       FROM commander_workers
       WHERE status='ACTIVE'
         AND identity_subject='db:commander_adapter_ops'
         AND EXISTS (SELECT 1 FROM json_each(tenant_ids) WHERE value = ?)
         AND last_heartbeat_at > registered_at
         AND last_heartbeat_at >= ?
         AND capabilities IN ('["effect.reconcile"]', '["effect.compensate"]')
       GROUP BY capabilities`,
      )
      .all(tenantId, threshold) as Array<{ capabilities: string; count: number }>;
    const reconciliationWorkers = Number(
      rows.find((row) => row.capabilities === '["effect.reconcile"]')?.count ?? 0,
    );
    const compensationWorkers = Number(
      rows.find((row) => row.capabilities === '["effect.compensate"]')?.count ?? 0,
    );
    return {
      ready: reconciliationWorkers > 0 && compensationWorkers > 0,
      ...(reconciliationWorkers === 0
        ? { reason: 'RECONCILIATION_DRAIN_UNAVAILABLE' as const }
        : compensationWorkers === 0
          ? { reason: 'COMPENSATION_DRAIN_UNAVAILABLE' as const }
          : {}),
      reconciliationWorkers,
      compensationWorkers,
      checkedAt: at.toISOString(),
    };
  }

  protected override async withTransaction<T>(
    fn: (client: SqlClient) => Promise<T>,
    tenantIds: string[] = [],
  ): Promise<T> {
    if (tenantIds.length === 0 && !this.claimSchedulerMode) {
      throw new Error(
        'Kernel write must explicitly carry tenant scope (or use a scheduler-mode repository)',
      );
    }
    this.db.prepare('BEGIN IMMEDIATE').run();
    const client = await this.pool.connect();
    try {
      const value = await fn(client);
      this.db.prepare('COMMIT').run();
      return value;
    } catch (error) {
      try {
        this.db.prepare('ROLLBACK').run();
      } catch {
        /* preserve root cause */
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Resolve durable worker tenant scope (PG claim_next_step parity).
   * Returns null when fail-closed (missing/inactive/stale/empty/`*` authz).
   * Open-ended durable `*` is forbidden — do not expand.
   */
  private resolveDurableWorkerTenantScope(
    workerId: string,
    workerGeneration: number,
    claimSecret?: string,
  ): { tenantIds: string[]; openEnded: boolean } | null {
    if (!claimSecret || claimSecret.length === 0) return null;
    const secretRow = this.db
      .prepare(
        `SELECT secret_hash FROM commander_worker_claim_secrets WHERE worker_id = ? AND generation = ?`,
      )
      .get(workerId, workerGeneration) as { secret_hash: Buffer | Uint8Array } | undefined;
    if (!secretRow || !verifyWorkerClaimSecret(claimSecret, Buffer.from(secretRow.secret_hash))) {
      return null;
    }
    const worker = this.db
      .prepare(`SELECT tenant_ids, status, generation FROM commander_workers WHERE id = ?`)
      .get(workerId) as { tenant_ids: string; status: string; generation: number } | undefined;
    if (!worker || worker.status !== 'ACTIVE' || Number(worker.generation) !== workerGeneration) {
      return null;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(worker.tenant_ids || '[]');
    } catch {
      return null;
    }
    if (!Array.isArray(raw)) return null;
    const parsed = raw.filter((t): t is string => typeof t === 'string' && t.length > 0);
    // Product decision: durable '*' fail-closed (parity with claim_* DEFINER).
    if (parsed.includes('*')) return null;
    if (parsed.length === 0) return null;
    return { tenantIds: parsed, openEnded: false };
  }

  private workerHasAnyCapability(workerId: string, capabilities: readonly string[]): boolean {
    const row = this.db
      .prepare(`SELECT capabilities FROM commander_workers WHERE id=? AND status='ACTIVE'`)
      .get(workerId) as { capabilities: string } | undefined;
    if (!row) return false;
    try {
      const values = JSON.parse(row.capabilities) as unknown;
      return (
        Array.isArray(values) && capabilities.some((capability) => values.includes(capability))
      );
    } catch {
      return false;
    }
  }

  private workerHasExactCapability(workerId: string, capability: string): boolean {
    const row = this.db
      .prepare(
        `SELECT capabilities, identity_subject FROM commander_workers WHERE id=? AND status='ACTIVE'`,
      )
      .get(workerId) as { capabilities: string; identity_subject: string } | undefined;
    if (!row || row.identity_subject !== 'db:commander_adapter_ops') return false;
    try {
      const values = JSON.parse(row.capabilities) as unknown;
      return Array.isArray(values) && values.length === 1 && values[0] === capability;
    } catch {
      return false;
    }
  }

  override async claimNextStep(request: ClaimStepRequest): Promise<KernelStep | null> {
    const now = request.now ?? new Date();
    const expiry = new Date(now.getTime() + request.leaseTtlMs);
    const token = randomUUID();
    const workerGeneration = request.workerGeneration ?? -1;
    const capabilities = request.capabilities ?? [];
    const capsJson = JSON.stringify(capabilities);

    // Worker path (PG claim_next_step parity): ignore caller tenantIds/tenantId;
    // authorize solely from durable commander_workers.tenant_ids.
    let tenantIds: string[];
    let openEnded: boolean;
    if (!this.claimSchedulerMode) {
      const scope = this.resolveDurableWorkerTenantScope(
        request.workerId,
        workerGeneration,
        request.claimSecret,
      );
      if (!scope) return null;
      tenantIds = scope.tenantIds;
      openEnded = scope.openEnded;
    } else {
      tenantIds = request.tenantIds ?? (request.tenantId ? [request.tenantId] : []);
      openEnded = tenantIds.length === 0;
    }

    const txScope = openEnded ? ['*'] : tenantIds;
    return this.withTransaction(async (client) => {
      // Re-check durable authz inside the transaction (worker-mode).
      if (!this.claimSchedulerMode) {
        const scope = this.resolveDurableWorkerTenantScope(
          request.workerId,
          workerGeneration,
          request.claimSecret,
        );
        if (!scope) return null;
        if (!scope.openEnded && scope.tenantIds.length === 0) return null;
        tenantIds = scope.tenantIds;
        openEnded = scope.openEnded;
      }

      const filterTenants = openEnded ? [] : tenantIds;
      const tenantClause =
        filterTenants.length === 0
          ? ''
          : ` AND s.tenant_id IN (${filterTenants.map(() => '?').join(',')})`;
      const selectSql = `SELECT s.id, s.state AS previous_state FROM commander_steps s JOIN commander_runs r ON r.id=s.run_id AND r.tenant_id=s.tenant_id
           JOIN commander_workers w ON w.id=? AND w.generation=? AND w.status='ACTIVE'
           JOIN commander_tenant_execution_usage u ON u.tenant_id=s.tenant_id
           JOIN commander_tenant_execution_control c ON c.tenant_id=s.tenant_id
           LEFT JOIN commander_tenant_execution_limits l ON l.tenant_id=s.tenant_id
           WHERE s.state IN ('PENDING','RETRY_WAIT') AND s.scheduled_at <= ?
             AND r.state IN ('PENDING','RUNNING')
             AND json_extract(r.metadata, '$.compensationRequestId') IS NULL${tenantClause}
             AND c.paused=0
             AND (? = '[]' OR s.kind IN (SELECT value FROM json_each(?)))
             AND u.running_steps < COALESCE(l.max_concurrent_steps, 2147483647)
             AND NOT EXISTS (
               SELECT 1 FROM json_each(s.dependencies) d
               JOIN commander_steps prerequisite ON prerequisite.id=d.value AND prerequisite.tenant_id=s.tenant_id
               WHERE prerequisite.state NOT IN ('SUCCEEDED','SKIPPED')
             )
           ORDER BY u.running_steps ASC,
                    MAX(s.priority + CAST((julianday(?) - julianday(s.scheduled_at)) * 24 * 60 AS INTEGER), 1000) DESC,
                    s.scheduled_at ASC, s.created_at ASC LIMIT 1`;

      const selectValues: unknown[] = [
        request.workerId,
        workerGeneration,
        now.toISOString(),
        ...filterTenants,
        capsJson,
        capsJson,
        now.toISOString(),
      ];

      const candidate = await client.query<{ id: string; previous_state: KernelStepState }>(
        selectSql,
        selectValues,
      );
      if (!candidate.rows[0]) return null;
      const previousState = candidate.rows[0].previous_state;
      const stepId = candidate.rows[0].id;

      const updateResult = await client.query<Record<string, unknown>>(
        `UPDATE commander_steps SET state='RUNNING', attempt=attempt+1, version=version+1,
           lease_worker_id=?, lease_worker_generation=?, lease_token=?, fencing_epoch=fencing_epoch+1, lease_expires_at=?, updated_at=?
         WHERE id=? AND state IN ('PENDING','RETRY_WAIT') RETURNING *`,
        [
          request.workerId,
          workerGeneration,
          token,
          expiry.toISOString(),
          now.toISOString(),
          stepId,
        ],
      );
      const row = updateResult.rows[0];
      if (!row) return null;
      const step = fromStepAdapter(row);
      assertStepTransition(previousState, step.state);
      await client.query(
        `UPDATE commander_tenant_execution_usage SET running_steps=running_steps+1, updated_at=? WHERE tenant_id=?`,
        [now.toISOString(), step.tenantId],
      );
      assertRunTransition('PENDING', 'RUNNING');
      await client.query(
        `UPDATE commander_runs SET state='RUNNING', version=version+1, updated_at=? WHERE id=? AND tenant_id=? AND state='PENDING'`,
        [now.toISOString(), step.runId, step.tenantId],
      );
      await this.appendEvent(client, {
        aggregateType: 'step',
        aggregateId: step.id,
        sequence: step.version,
        type: 'step.claimed',
        tenantId: step.tenantId,
        runId: step.runId,
        stepId: step.id,
        actor: request.workerId,
        payload: { attempt: step.attempt, fencingEpoch: step.lease!.fencingEpoch },
      });
      return step;
    }, txScope);
  }

  override async claimOutbox(
    limit: number,
    now = new Date(),
  ): Promise<import('./types.js').KernelOutboxMessage[]> {
    const token = randomUUID();
    const staleBefore = new Date(now.getTime() - 60_000).toISOString();
    return this.withTransaction(async (client) => {
      const candidates = await client.query<{ id: string }>(
        `SELECT id FROM commander_outbox
           WHERE published_at IS NULL AND moved_to_dlq_at IS NULL AND attempts < max_attempts
           AND topic <> ? AND available_at <= ? AND (claimed_at IS NULL OR claimed_at < ?)
         ORDER BY created_at LIMIT ?`,
        [KERNEL_COMPENSATION_TOPIC, now.toISOString(), staleBefore, limit],
      );
      if (candidates.rows.length === 0) return [];
      const ids = candidates.rows.map((r) => r.id);
      const placeholders = ids.map(() => '?').join(',');
      const result = await client.query<Record<string, unknown>>(
        `UPDATE commander_outbox SET claimed_at=?, claim_token=?, attempts=attempts+1
         WHERE id IN (${placeholders}) RETURNING *`,
        [now.toISOString(), token, ...ids],
      );
      return result.rows.map((row) => ({
        id: row.id as string,
        eventId: row.event_id as string,
        tenantId: row.tenant_id as string,
        topic: row.topic as string,
        key: row.key as string,
        payload:
          typeof row.payload === 'string'
            ? JSON.parse(row.payload)
            : ((row.payload as Record<string, unknown>) ?? {}),
        attempts: Number(row.attempts),
        availableAt: String(row.available_at),
        publishedAt: row.published_at ? String(row.published_at) : undefined,
        claimToken: token,
        createdAt: String(row.created_at),
      }));
    });
  }

  override async claimOutboxByTopic(
    topic: string,
    limit: number,
    now = new Date(),
    authz?: { workerId: string; workerGeneration: number; claimSecret: string },
  ): Promise<import('./types.js').KernelOutboxMessage[]> {
    const token = randomUUID();
    const staleBefore = new Date(now.getTime() - 60_000).toISOString();

    let tenantFilter: string[] | null = null;
    let txScope: string[];
    if (!this.claimSchedulerMode) {
      const workerId = authz?.workerId?.trim();
      if (!workerId) {
        throw new Error('claimOutboxByTopic requires workerId on the worker LOGIN path');
      }
      if (typeof authz?.workerGeneration !== 'number' || !Number.isFinite(authz.workerGeneration)) {
        throw new Error(
          'claimOutboxByTopic requires finite workerGeneration on the worker LOGIN path',
        );
      }
      if (!authz.claimSecret) {
        throw new Error('claimOutboxByTopic requires claimSecret on the worker LOGIN path');
      }
      const scope = this.resolveDurableWorkerTenantScope(
        workerId,
        authz.workerGeneration,
        authz.claimSecret,
      );
      if (!scope) return [];
      tenantFilter = scope.openEnded ? null : scope.tenantIds;
      if (tenantFilter !== null && tenantFilter.length === 0) return [];
      txScope = scope.openEnded ? ['*'] : scope.tenantIds;
    } else {
      txScope = ['*'];
    }

    return this.withTransaction(async (client) => {
      const candidates = await client.query<{ id: string }>(
        tenantFilter === null
          ? `SELECT id FROM commander_outbox
             WHERE topic=? AND published_at IS NULL AND moved_to_dlq_at IS NULL AND attempts < max_attempts
               AND available_at <= ? AND (claimed_at IS NULL OR claimed_at < ?)
             ORDER BY created_at LIMIT ?`
          : `SELECT id FROM commander_outbox
             WHERE topic=? AND published_at IS NULL AND moved_to_dlq_at IS NULL AND attempts < max_attempts
               AND available_at <= ? AND (claimed_at IS NULL OR claimed_at < ?)
               AND tenant_id IN (${tenantFilter.map(() => '?').join(',')})
             ORDER BY created_at LIMIT ?`,
        tenantFilter === null
          ? [topic, now.toISOString(), staleBefore, limit]
          : [topic, now.toISOString(), staleBefore, ...tenantFilter, limit],
      );
      if (candidates.rows.length === 0) return [];
      const ids = candidates.rows.map((r) => r.id);
      const placeholders = ids.map(() => '?').join(',');
      const result = await client.query<Record<string, unknown>>(
        `UPDATE commander_outbox SET claimed_at=?, claim_token=?, attempts=attempts+1
         WHERE id IN (${placeholders}) RETURNING *`,
        [now.toISOString(), token, ...ids],
      );
      return result.rows.map((row) => ({
        id: row.id as string,
        eventId: row.event_id as string,
        tenantId: row.tenant_id as string,
        topic: row.topic as string,
        key: row.key as string,
        payload:
          typeof row.payload === 'string'
            ? JSON.parse(row.payload)
            : ((row.payload as Record<string, unknown>) ?? {}),
        attempts: Number(row.attempts),
        availableAt: String(row.available_at),
        publishedAt: row.published_at ? String(row.published_at) : undefined,
        claimToken: token,
        createdAt: String(row.created_at),
      }));
    }, txScope);
  }

  override async createCompensationAuthorization(
    authorization: CompensationAuthorizationRecord,
  ): Promise<{ authorization: CompensationAuthorizationRecord; replayed: boolean }> {
    return this.withTransaction(
      async (client) => {
        const effectResult = await client.query<Record<string, unknown>>(
          `SELECT * FROM commander_effects WHERE id=? AND run_id=? AND tenant_id=?
          AND state='COMPLETED' AND type NOT LIKE 'compensate.%'`,
          [authorization.originalEffectId, authorization.originalRunId, authorization.tenantId],
        );
        const effect = effectResult.rows[0];
        if (!effect) throw new Error('FORWARD_EFFECT_NOT_FOUND');
        const response =
          typeof effect.response === 'string'
            ? JSON.parse(effect.response)
            : (effect.response ?? {});
        if (canonicalCompensationHash(response) !== authorization.forwardReceiptHash) {
          throw new Error('FORWARD_RECEIPT_MISMATCH');
        }
        if (
          canonicalCompensationHash({
            type: authorization.compensationEffectType,
            originalEffectId: authorization.originalEffectId,
            adapterVersion: authorization.adapterVersion,
            destination: reqJsonObject('commander_effects', effect, 'request').destination,
            forwardResponse: response,
            compensationPatch: authorization.compensationPatch,
          }) !== authorization.actionDigest
        )
          throw new Error('ACTION_DIGEST_MISMATCH');
        const existingResult = await client.query<Record<string, unknown>>(
          'SELECT * FROM commander_compensation_authorizations WHERE id=? AND tenant_id=?',
          [authorization.id, authorization.tenantId],
        );
        const existing = existingResult.rows[0]
          ? this.compensationAuthorizationFromRow(existingResult.rows[0])
          : null;
        if (existing) {
          if (JSON.stringify(existing) !== JSON.stringify(authorization))
            throw new Error('COMPENSATION_AUTHORIZATION_CONFLICT');
          return { authorization: existing, replayed: true };
        }
        await client.query(
          `INSERT INTO commander_compensation_authorizations(
          id,tenant_id,original_run_id,original_effect_id,compensation_effect_type,adapter_version,
          compensation_patch,forward_receipt_hash,policy_decision_id,policy_snapshot_id,decision,
          action_digest,expires_at,approval_interaction_id
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            authorization.id,
            authorization.tenantId,
            authorization.originalRunId,
            authorization.originalEffectId,
            authorization.compensationEffectType,
            authorization.adapterVersion,
            authorization.compensationPatch,
            authorization.forwardReceiptHash,
            authorization.policyDecisionId,
            authorization.policySnapshotId,
            authorization.decision,
            authorization.actionDigest,
            authorization.expiresAt,
            authorization.approvalInteractionId ?? null,
          ],
        );
        return { authorization: structuredClone(authorization), replayed: false };
      },
      [authorization.tenantId],
    );
  }

  override async getCompensationAuthorization(
    authorizationId: string,
    tenantId: string,
  ): Promise<CompensationAuthorizationRecord | null> {
    return this.withTransaction(
      async (client) => {
        const result = await client.query<Record<string, unknown>>(
          'SELECT * FROM commander_compensation_authorizations WHERE id=? AND tenant_id=?',
          [authorizationId, tenantId],
        );
        const row = result.rows[0];
        if (!row) return null;
        return this.compensationAuthorizationFromRow(row);
      },
      [tenantId],
    );
  }

  private compensationAuthorizationFromRow(
    row: Record<string, unknown>,
  ): CompensationAuthorizationRecord {
    return {
      id: String(row.id),
      tenantId: String(row.tenant_id),
      originalRunId: String(row.original_run_id),
      originalEffectId: String(row.original_effect_id),
      compensationEffectType: String(row.compensation_effect_type),
      adapterVersion: String(row.adapter_version),
      compensationPatch: parseJsonValue(row.compensation_patch) as Record<string, unknown>,
      forwardReceiptHash: String(row.forward_receipt_hash),
      policyDecisionId: String(row.policy_decision_id),
      policySnapshotId: String(row.policy_snapshot_id),
      decision: row.decision as CompensationAuthorizationRecord['decision'],
      actionDigest: String(row.action_digest),
      expiresAt: String(row.expires_at),
      ...(row.approval_interaction_id
        ? { approvalInteractionId: String(row.approval_interaction_id) }
        : {}),
    };
  }

  override async requestCompensation(
    input: RequestCompensationInput,
  ): Promise<RequestCompensationResult> {
    return this.requestCompensationByAuthorization(input);
  }

  private async requestCompensationByAuthorization(
    input: RequestCompensationInput,
  ): Promise<RequestCompensationResult> {
    const authorizationId =
      typeof input.authorizationId === 'string' ? input.authorizationId.trim() : '';
    const missingId = `request_${canonicalCompensationHash({
      tenantId: input.tenantId,
      authorizationId,
    }).slice(0, 40)}`;
    if (!authorizationId) {
      return { accepted: false, requestId: missingId, reason: 'AUTHORIZATION_NOT_FOUND' };
    }
    const authorization = await this.getCompensationAuthorization(authorizationId, input.tenantId);
    if (!authorization)
      return { accepted: false, requestId: missingId, reason: 'AUTHORIZATION_NOT_FOUND' };
    const requestId = `request_${canonicalCompensationHash({
      tenantId: authorization.tenantId,
      originalEffectId: authorization.originalEffectId,
      adapterVersion: authorization.adapterVersion,
      actionDigest: authorization.actionDigest,
    }).slice(0, 40)}`;
    return this.withTransaction(
      async (client) => {
        const existingResult = await client.query<Record<string, unknown>>(
          'SELECT * FROM commander_compensation_requests WHERE id=?',
          [requestId],
        );
        if (existingResult.rows[0]) {
          const request = this.compensationRequestFromRow(existingResult.rows[0]);
          return request.authorizationId === authorization.id
            ? { accepted: true, request, replayed: true }
            : { accepted: false, requestId, reason: 'ACTION_DIGEST_MISMATCH' };
        }
        const effectResult = await client.query<Record<string, unknown>>(
          `SELECT * FROM commander_effects WHERE id=? AND run_id=? AND tenant_id=?
         AND state='COMPLETED' AND type NOT LIKE 'compensate.%'`,
          [authorization.originalEffectId, authorization.originalRunId, input.tenantId],
        );
        const effect = effectResult.rows[0];
        if (!effect) return { accepted: false, requestId, reason: 'FORWARD_EFFECT_NOT_FOUND' };
        const originalRunResult = await client.query<{ state: string }>(
          'SELECT state FROM commander_runs WHERE id=? AND tenant_id=?',
          [authorization.originalRunId, input.tenantId],
        );
        const originalRunState = originalRunResult.rows[0]?.state;
        if (!originalRunState)
          return { accepted: false, requestId, reason: 'FORWARD_EFFECT_NOT_FOUND' };
        const effectRequest = reqJsonObject('commander_effects', effect, 'request');
        const destination = effectRequest.destination;
        if (typeof destination !== 'string' || destination.length === 0) {
          return { accepted: false, requestId, reason: 'FORWARD_EFFECT_NOT_FOUND' };
        }
        const response = effect.response ?? {};
        if (canonicalCompensationHash(response) !== authorization.forwardReceiptHash)
          return { accepted: false, requestId, reason: 'FORWARD_RECEIPT_MISMATCH' };
        if (
          canonicalCompensationHash({
            type: authorization.compensationEffectType,
            originalEffectId: authorization.originalEffectId,
            adapterVersion: authorization.adapterVersion,
            destination,
            forwardResponse: response,
            compensationPatch: authorization.compensationPatch,
          }) !== authorization.actionDigest
        )
          return { accepted: false, requestId, reason: 'ACTION_DIGEST_MISMATCH' };
        if (authorization.decision === 'deny')
          return { accepted: false, requestId, reason: 'POLICY_DENIED' };
        if (Date.parse(authorization.expiresAt) <= Date.now())
          return { accepted: false, requestId, reason: 'AUTHORIZATION_EXPIRED' };
        if (authorization.decision === 'require_approval') {
          if (!authorization.approvalInteractionId)
            return { accepted: false, requestId, reason: 'APPROVAL_REQUIRED' };
          const approved = await client.query<Record<string, unknown>>(
            `SELECT * FROM commander_interactions WHERE id=? AND tenant_id=? AND run_id=?
           AND status='answered' AND expires_at>datetime('now')`,
            [authorization.approvalInteractionId, input.tenantId, authorization.originalRunId],
          );
          const binding = approved.rows[0]?.response as Record<string, unknown> | undefined;
          if (
            !binding ||
            binding.approved !== true ||
            binding.authorizationId !== authorization.id ||
            binding.actionDigest !== authorization.actionDigest ||
            binding.policyDecisionId !== authorization.policyDecisionId ||
            binding.policySnapshotId !== authorization.policySnapshotId
          )
            return { accepted: false, requestId, reason: 'APPROVAL_BINDING_MISMATCH' };
        }
        const compensationRunId = `run_${canonicalCompensationHash({ requestId, purpose: 'compensation' }).slice(0, 40)}`;
        const compensationStepId = `step_${canonicalCompensationHash({ requestId, purpose: 'compensation' }).slice(0, 32)}`;
        const compensationEffectId = `effect_${canonicalCompensationHash({
          requestId,
          originalEffectId: authorization.originalEffectId,
        }).slice(0, 40)}`;
        const reconcilePolicy = createReconcilePolicy({ unknownAt: new Date().toISOString() });
        const workGraphHash = canonicalCompensationHash({ compensationStepId });
        const metadataAuthorization = durableCompensationMetadataAuthorization({
          authorization,
          requestId,
          compensationRunId,
          compensationStepId,
          compensationEffectId,
          originalRunStateAtRequest: originalRunState as KernelRunState,
          originalEffect: {
            request: effectRequest,
            response: parseJsonValue(effect.response) as Record<string, unknown>,
          },
        });
        await client.query(
          `INSERT INTO commander_runs(
             id,tenant_id,intent_hash,work_graph_hash,work_graph_version,policy_snapshot_id,state,metadata
           ) VALUES(?,?,?,?,?,?,'PENDING',?)`,
          [
            compensationRunId,
            input.tenantId,
            canonicalCompensationHash({ requestId, purpose: 'intent' }),
            workGraphHash,
            'action-gateway-compensation/v2',
            authorization.policySnapshotId,
            {
              compensationRequestId: requestId,
              authorizationId: authorization.id,
              compensation: { authorization: metadataAuthorization, disposition: 'PENDING' },
            },
          ],
        );
        await client.query(
          `INSERT OR IGNORE INTO commander_tenant_execution_usage(tenant_id) VALUES(?)`,
          [input.tenantId],
        );
        await client.query(
          `INSERT OR IGNORE INTO commander_tenant_execution_control(tenant_id,actor)
           VALUES(?,'kernel')`,
          [input.tenantId],
        );
        await client.query(
          `INSERT INTO commander_steps(
             id,run_id,tenant_id,kind,state,max_attempts,priority,dependencies,input,scheduled_at
           ) VALUES(?,?,?,'tool','PENDING',1,0,?,?,?)`,
          [
            compensationStepId,
            compensationRunId,
            input.tenantId,
            [],
            { requestId, authorization: metadataAuthorization },
            new Date(Date.now() - 1_000).toISOString(),
          ],
        );
        await this.appendEvent(client, {
          aggregateType: 'run',
          aggregateId: compensationRunId,
          sequence: 1,
          type: 'run.created',
          tenantId: input.tenantId,
          runId: compensationRunId,
          actor: input.actor,
          payload: { workGraphHash, stepCount: 1 },
        });
        await client.query(
          `INSERT INTO commander_compensation_requests(
        id,tenant_id,original_run_id,original_effect_id,compensation_run_id,compensation_step_id,
        adapter_version,compensation_effect_type,compensation_patch,forward_receipt_hash,authorization_id,reconcile_policy,state
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            requestId,
            input.tenantId,
            authorization.originalRunId,
            authorization.originalEffectId,
            compensationRunId,
            compensationStepId,
            authorization.adapterVersion,
            authorization.compensationEffectType,
            authorization.compensationPatch,
            authorization.forwardReceiptHash,
            authorization.id,
            reconcilePolicy,
            'AUTHORIZED',
          ],
        );
        const eventId = randomUUID();
        const outboxId = randomUUID();
        const createdAt = new Date().toISOString();
        await client.query(
          `INSERT INTO commander_events(id,aggregate_type,aggregate_id,sequence,type,tenant_id,run_id,step_id,actor,schema_version,payload,occurred_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            eventId,
            'effect',
            requestId,
            1,
            'kernel.compensation.requested',
            input.tenantId,
            compensationRunId,
            compensationStepId,
            input.actor,
            'v2',
            {
              requestId,
              authorizationId: authorization.id,
              actionDigest: authorization.actionDigest,
            },
            createdAt,
          ],
        );
        await client.query(
          `INSERT INTO commander_outbox(id,event_id,tenant_id,topic,key,payload,created_at,available_at)
        VALUES(?,?,?,?,?,?,?,?)`,
          [
            outboxId,
            eventId,
            input.tenantId,
            KERNEL_COMPENSATION_TOPIC,
            requestId,
            {
              requestId,
              authorizationId: authorization.id,
              tenantId: input.tenantId,
              actionDigest: authorization.actionDigest,
            },
            createdAt,
            createdAt,
          ],
        );
        const request: KernelCompensationRequest = {
          id: requestId,
          tenantId: input.tenantId,
          originalRunId: authorization.originalRunId,
          originalEffectId: authorization.originalEffectId,
          compensationRunId,
          compensationStepId,
          adapterVersion: authorization.adapterVersion,
          compensationEffectType: authorization.compensationEffectType,
          destination,
          compensationPatch: authorization.compensationPatch,
          forwardReceiptHash: authorization.forwardReceiptHash,
          authorizationId: authorization.id,
          reconcilePolicy,
          state: 'AUTHORIZED',
          compensationEffectId,
        };
        return { accepted: true, request, replayed: false };
      },
      [input.tenantId],
    );
  }

  private compensationRequestFromRow(row: Record<string, unknown>): KernelCompensationRequest {
    return {
      id: String(row.id),
      tenantId: String(row.tenant_id),
      originalRunId: String(row.original_run_id),
      originalEffectId: String(row.original_effect_id),
      compensationRunId: String(row.compensation_run_id),
      compensationStepId: String(row.compensation_step_id),
      adapterVersion: String(row.adapter_version),
      compensationEffectType: String(row.compensation_effect_type),
      destination: typeof row.destination === 'string' ? row.destination : '',
      compensationPatch: parseJsonValue(row.compensation_patch) as Record<string, unknown>,
      forwardReceiptHash: String(row.forward_receipt_hash),
      authorizationId: String(row.authorization_id),
      reconcilePolicy: parseJsonValue(
        row.reconcile_policy,
      ) as KernelCompensationRequest['reconcilePolicy'],
      state: row.state as KernelCompensationRequest['state'],
      ...(row.claim_worker_id ? { claimWorkerId: String(row.claim_worker_id) } : {}),
      ...(row.claim_worker_generation != null
        ? { claimWorkerGeneration: Number(row.claim_worker_generation) }
        : {}),
      ...(row.claim_token ? { claimToken: String(row.claim_token) } : {}),
      ...(row.claim_expires_at ? { claimExpiresAt: String(row.claim_expires_at) } : {}),
      ...(row.compensation_effect_id
        ? { compensationEffectId: String(row.compensation_effect_id) }
        : {}),
    };
  }

  override async admitEffect(request: AdmitEffectRequest): Promise<AdmitEffectResult> {
    if (!request.type.toLowerCase().startsWith('compensate.')) return super.admitEffect(request);
    return this.withTransaction(
      async (client) => {
        const binding = request.compensationBinding;
        if (!binding) return { admitted: false, reason: 'COMPENSATION_ADMISSION_UNAVAILABLE' };
        const stepResult = await client.query<Record<string, unknown>>(
          `SELECT * FROM commander_steps WHERE id=? AND run_id=? AND tenant_id=?`,
          [request.stepId, request.runId, request.tenantId],
        );
        const runResult = await client.query<Record<string, unknown>>(
          `SELECT * FROM commander_runs WHERE id=? AND tenant_id=?`,
          [request.runId, request.tenantId],
        );
        const workerResult = await client.query<Record<string, unknown>>(
          `SELECT * FROM commander_workers WHERE id=? AND generation=? AND status='ACTIVE'`,
          [request.lease.workerId, request.lease.workerGeneration],
        );
        const outboxResult = await client.query<Record<string, unknown>>(
          `SELECT * FROM commander_outbox
         WHERE tenant_id=? AND topic=? AND claim_token=? AND published_at IS NULL`,
          [request.tenantId, KERNEL_COMPENSATION_TOPIC, binding.claimToken],
        );
        const step = stepResult.rows[0];
        const run = runResult.rows[0];
        const worker = workerResult.rows[0];
        const outbox = outboxResult.rows[0];
        const metadata = run ? (parseJsonValue(run.metadata) as Record<string, unknown>) : null;
        const evidence = (metadata?.compensation as Record<string, unknown> | undefined)
          ?.authorization;
        const stepInput = step ? (parseJsonValue(step.input) as Record<string, unknown>) : null;
        const workerTenants = worker ? (parseJsonValue(worker.tenant_ids) as unknown) : null;
        const rawPayload = outbox ? parseJsonValue(outbox.payload) : null;
        const payload =
          rawPayload && typeof rawPayload === 'object' && !Array.isArray(rawPayload)
            ? (rawPayload as Record<string, unknown>)
            : null;
        const payloadRequestId = typeof payload?.requestId === 'string' ? payload.requestId : null;
        const payloadAuthorizationId =
          typeof payload?.authorizationId === 'string' ? payload.authorizationId : null;
        const payloadTenantId = typeof payload?.tenantId === 'string' ? payload.tenantId : null;
        const payloadActionDigest =
          typeof payload?.actionDigest === 'string' ? payload.actionDigest : null;
        // Mirror claimCompensationWork / admit_compensation_effect: the durable
        // compensation request is the resolution root, then its authorization
        // row, then the completed forward effect. The compact outbox payload is
        // only a cross-check; it is never authoritative.
        const requestResult = payloadRequestId
          ? await client.query<Record<string, unknown>>(
              `SELECT * FROM commander_compensation_requests WHERE id=? AND tenant_id=?`,
              [payloadRequestId, request.tenantId],
            )
          : { rows: [] as Record<string, unknown>[] };
        const durableRequest = requestResult.rows[0]
          ? this.compensationRequestFromRow(requestResult.rows[0])
          : null;
        const authorizationResult = durableRequest
          ? await client.query<Record<string, unknown>>(
              `SELECT * FROM commander_compensation_authorizations WHERE id=? AND tenant_id=?`,
              [durableRequest.authorizationId, request.tenantId],
            )
          : { rows: [] as Record<string, unknown>[] };
        const durableAuthorization = authorizationResult.rows[0]
          ? this.compensationAuthorizationFromRow(authorizationResult.rows[0])
          : null;
        const originalEffectResult = durableRequest
          ? await client.query<Record<string, unknown>>(
              `SELECT * FROM commander_effects WHERE id=? AND tenant_id=? AND state='COMPLETED'`,
              [durableRequest.originalEffectId, request.tenantId],
            )
          : { rows: [] as Record<string, unknown>[] };
        const originalEffect = originalEffectResult.rows[0];
        if (
          !step ||
          !run ||
          !worker ||
          !outbox ||
          !payload ||
          !durableRequest ||
          !durableAuthorization ||
          !originalEffect ||
          !evidence ||
          run.state !== 'COMPENSATING' ||
          step.state !== 'RUNNING' ||
          !this.workerHasExactCapability(request.lease.workerId, 'effect.compensate') ||
          !Array.isArray(workerTenants) ||
          !workerTenants.includes(request.tenantId) ||
          canonicalJson(stepInput?.authorization) !== canonicalJson(evidence) ||
          payloadTenantId !== request.tenantId ||
          payloadRequestId !== durableRequest.id ||
          payloadAuthorizationId !== durableAuthorization.id ||
          payloadActionDigest !== durableAuthorization.actionDigest ||
          durableRequest.tenantId !== request.tenantId ||
          durableRequest.authorizationId !== durableAuthorization.id ||
          step.lease_worker_id !== request.lease.workerId ||
          Number(step.lease_worker_generation) !== request.lease.workerGeneration ||
          step.lease_token !== request.lease.token ||
          Number(step.fencing_epoch) !== request.lease.fencingEpoch ||
          !step.lease_expires_at ||
          Date.parse(String(step.lease_expires_at)) <= Date.now()
        ) {
          return { admitted: false, reason: 'COMPENSATION_ADMISSION_UNAVAILABLE' };
        }
        const governed = this.governedCompensationAuthorizationFromDurableEvidence({
          evidence,
          request: durableRequest,
          durableAuthorization,
          originalEffect,
        });
        if (
          !governed ||
          binding.authorizationId !== governed.authorizationId ||
          binding.requestId !== governed.requestId ||
          binding.claimToken !== request.lease.token ||
          request.id !== governed.compensationEffectId ||
          request.runId !== governed.compensationRunId ||
          request.stepId !== governed.compensationStepId ||
          request.type !== governed.compensationEffectType ||
          request.idempotencyKey !== governed.idempotencyKey ||
          request.policyDecisionId !== governed.policyDecisionId ||
          request.policySnapshotId !== governed.policySnapshotId ||
          request.actionDigest !== governed.actionDigest ||
          canonicalJson(request.request) !== canonicalJson(governed.compensationRequest)
        ) {
          return { admitted: false, reason: 'COMPENSATION_ADMISSION_UNAVAILABLE' };
        }
        const existingResult = await client.query<Record<string, unknown>>(
          `SELECT * FROM commander_effects WHERE tenant_id=? AND idempotency_key=?`,
          [request.tenantId, request.idempotencyKey],
        );
        const existing = existingResult.rows[0];
        const requestHash = sha256(canonicalJson(request.request));
        if (existing) {
          const exact =
            existing.id === request.id &&
            existing.run_id === request.runId &&
            existing.step_id === request.stepId &&
            existing.type === request.type &&
            existing.request_hash === requestHash &&
            existing.policy_decision_id === request.policyDecisionId &&
            existing.policy_snapshot_id === request.policySnapshotId &&
            existing.action_digest === request.actionDigest;
          return exact
            ? { admitted: true, replayed: true, effect: fromEffectAdapter(existing) }
            : { admitted: false, reason: 'IDEMPOTENCY_CONFLICT' };
        }
        const inserted = await client.query<Record<string, unknown>>(
          `INSERT INTO commander_effects(
           id,run_id,step_id,tenant_id,type,idempotency_key,request_hash,policy_decision_id,
           policy_snapshot_id,action_digest,lease_worker_id,lease_worker_generation,
           lease_fencing_epoch,state,request
         ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'ADMITTED',?) RETURNING *`,
          [
            request.id,
            request.runId,
            request.stepId,
            request.tenantId,
            request.type,
            request.idempotencyKey,
            requestHash,
            request.policyDecisionId,
            request.policySnapshotId,
            request.actionDigest,
            request.lease.workerId,
            request.lease.workerGeneration,
            request.lease.fencingEpoch,
            request.request,
          ],
        );
        return { admitted: true, replayed: false, effect: fromEffectAdapter(inserted.rows[0]!) };
      },
      [request.tenantId],
    );
  }

  override async claimCompensationRequest(
    input: ClaimCompensationRequestInput,
  ): Promise<ClaimedCompensationRequest | null> {
    const scope = this.resolveDurableWorkerTenantScope(
      input.workerId,
      input.workerGeneration,
      input.claimSecret,
    );
    if (!scope || !this.workerHasExactCapability(input.workerId, 'effect.compensate')) return null;
    return this.withTransaction(async (client) => {
      const result = await client.query<Record<string, unknown>>(
        'SELECT * FROM commander_compensation_requests WHERE id=?',
        [input.requestId],
      );
      const row = result.rows[0];
      if (!row || !scope.tenantIds.includes(String(row.tenant_id))) return null;
      const request = this.compensationRequestFromRow(row);
      const messageResult = await client.query<Record<string, unknown>>(
        `SELECT * FROM commander_outbox WHERE id=? AND tenant_id=?
         AND topic=? AND published_at IS NULL`,
        [input.outboxMessageId, request.tenantId, KERNEL_COMPENSATION_TOPIC],
      );
      const message = messageResult.rows[0];
      const authorizationResult = await client.query<Record<string, unknown>>(
        'SELECT * FROM commander_compensation_authorizations WHERE id=? AND tenant_id=?',
        [request.authorizationId, request.tenantId],
      );
      const authorization = authorizationResult.rows[0]
        ? this.compensationAuthorizationFromRow(authorizationResult.rows[0])
        : null;
      const effectResult = await client.query<Record<string, unknown>>(
        `SELECT * FROM commander_effects WHERE id=? AND tenant_id=? AND state='COMPLETED'`,
        [request.originalEffectId, request.tenantId],
      );
      const originalEffect = effectResult.rows[0];
      const originalRequest = originalEffect
        ? reqJsonObject('commander_effects', originalEffect, 'request')
        : undefined;
      request.destination =
        typeof originalRequest?.destination === 'string' ? originalRequest.destination : '';
      const payload = message?.payload as Record<string, unknown> | undefined;
      if (
        !message ||
        !authorization ||
        !originalEffect ||
        payload?.requestId !== request.id ||
        payload.authorizationId !== authorization.id ||
        payload.actionDigest !== authorization.actionDigest ||
        canonicalCompensationHash(originalEffect.response ?? {}) !==
          authorization.forwardReceiptHash
      )
        return null;
      const at = input.now ?? new Date();
      if (
        request.state === 'CLAIMED' &&
        request.claimExpiresAt &&
        Date.parse(request.claimExpiresAt) > at.getTime() &&
        request.claimWorkerId !== input.workerId
      )
        return null;
      if (!['AUTHORIZED', 'CLAIMED'].includes(request.state)) return null;
      const stepResult = await client.query<Record<string, unknown>>(
        'SELECT * FROM commander_steps WHERE id=? AND tenant_id=?',
        [request.compensationStepId, request.tenantId],
      );
      const step = stepResult.rows[0];
      if (!step) return null;
      const claimToken = randomUUID();
      const expiresAt = new Date(at.getTime() + (input.leaseTtlMs ?? 60_000)).toISOString();
      const fencingEpoch = Number(step.fencing_epoch) + 1;
      const effectId =
        request.compensationEffectId ??
        `effect_${canonicalCompensationHash({ requestId: request.id, originalEffectId: request.originalEffectId }).slice(0, 40)}`;
      await client.query(
        `UPDATE commander_compensation_requests SET state='CLAIMED',claim_worker_id=?,
        claim_worker_generation=?,claim_token=?,claim_expires_at=?,compensation_effect_id=?,updated_at=? WHERE id=?`,
        [
          input.workerId,
          input.workerGeneration,
          claimToken,
          expiresAt,
          effectId,
          at.toISOString(),
          request.id,
        ],
      );
      await client.query(
        `UPDATE commander_runs SET state='COMPENSATING',updated_at=? WHERE id=? AND tenant_id=?`,
        [at.toISOString(), request.compensationRunId, request.tenantId],
      );
      await client.query(
        `UPDATE commander_steps SET state='RUNNING',version=version+1,lease_worker_id=?,
        lease_worker_generation=?,lease_token=?,fencing_epoch=?,lease_expires_at=?,updated_at=? WHERE id=? AND tenant_id=?`,
        [
          input.workerId,
          input.workerGeneration,
          claimToken,
          fencingEpoch,
          expiresAt,
          at.toISOString(),
          request.compensationStepId,
          request.tenantId,
        ],
      );
      await client.query(
        `UPDATE commander_outbox SET claimed_at=?,claim_token=?,attempts=attempts+1 WHERE id=?`,
        [at.toISOString(), claimToken, input.outboxMessageId],
      );
      request.state = 'CLAIMED';
      request.claimWorkerId = input.workerId;
      request.claimWorkerGeneration = input.workerGeneration;
      request.claimToken = claimToken;
      request.claimExpiresAt = expiresAt;
      request.compensationEffectId = effectId;
      return {
        request,
        authorization,
        forwardResponse: originalEffect.response as Record<string, unknown>,
        lease: {
          workerId: input.workerId,
          workerGeneration: input.workerGeneration,
          token: claimToken,
          fencingEpoch,
          expiresAt,
        },
        outboxMessageId: input.outboxMessageId,
        outboxClaimToken: claimToken,
      };
    }, scope.tenantIds);
  }

  override async admitCompensationEffect(
    input: AdmitEffectRequest & {
      requestId: string;
      outboxMessageId: string;
      outboxClaimToken: string;
    },
  ): Promise<AdmitEffectResult> {
    return this.withTransaction(
      async (client) => {
        const requestResult = await client.query<Record<string, unknown>>(
          'SELECT * FROM commander_compensation_requests WHERE id=?',
          [input.requestId],
        );
        const row = requestResult.rows[0];
        if (!row) return { admitted: false, reason: 'COMPENSATION_ADMISSION_UNAVAILABLE' } as const;
        const request = this.compensationRequestFromRow(row);
        const authorization = await this.getCompensationAuthorization(
          request.authorizationId,
          request.tenantId,
        );
        const effectResult = await client.query<Record<string, unknown>>(
          'SELECT request,response FROM commander_effects WHERE id=? AND tenant_id=?',
          [request.originalEffectId, request.tenantId],
        );
        const originalEffect = effectResult.rows[0];
        const originalRequest = originalEffect
          ? reqJsonObject('commander_effects', originalEffect, 'request')
          : undefined;
        request.destination =
          typeof originalRequest?.destination === 'string' ? originalRequest.destination : '';
        const forwardResponse = originalEffect?.response;
        if (
          !authorization ||
          request.state !== 'CLAIMED' ||
          request.compensationEffectId !== input.id ||
          request.claimToken !== input.outboxClaimToken ||
          input.type !== authorization.compensationEffectType ||
          input.actionDigest !== authorization.actionDigest ||
          input.policyDecisionId !== authorization.policyDecisionId ||
          input.policySnapshotId !== authorization.policySnapshotId ||
          JSON.stringify(input.request) !==
            JSON.stringify({
              originalEffectId: request.originalEffectId,
              destination: originalRequest?.destination,
              forwardResponse,
              compensationPatch: authorization.compensationPatch,
            })
        )
          return { admitted: false, reason: 'COMPENSATION_ADMISSION_UNAVAILABLE' } as const;
        return super.admitEffect(input);
      },
      [input.tenantId],
    );
  }

  override async parkCompensationUnknown(
    input: ParkCompensationRequestUnknownInput,
  ): Promise<CompensationMutationResult> {
    return this.applyTask3CompensationDisposition(input, 'COMPLETION_UNKNOWN', input.error);
  }

  override async finalizeCompensation(
    input: FinalizeCompensationInput,
  ): Promise<CompensationMutationResult> {
    return this.applyTask3CompensationDisposition(input, input.disposition, input.response ?? {});
  }

  private async applyTask3CompensationDisposition(
    input: ParkCompensationRequestUnknownInput | FinalizeCompensationInput,
    disposition: import('./types.js').CompensationDisposition,
    payload: Record<string, unknown>,
  ): Promise<CompensationMutationResult> {
    const scope = this.resolveDurableWorkerTenantScope(
      input.workerId,
      input.workerGeneration,
      input.claimSecret,
    );
    if (!scope || !scope.tenantIds.includes(input.tenantId))
      return { applied: false, reason: 'WORKER_FENCED' };
    return this.withTransaction(async (client) => {
      const requestResult = await client.query<Record<string, unknown>>(
        'SELECT * FROM commander_compensation_requests WHERE id=? AND tenant_id=?',
        [input.requestId, input.tenantId],
      );
      const row = requestResult.rows[0];
      if (!row) return { applied: false, reason: 'NOT_FOUND' };
      const request = this.compensationRequestFromRow(row);
      const outbox = await client.query<Record<string, unknown>>(
        'SELECT * FROM commander_outbox WHERE id=? AND tenant_id=?',
        [input.outboxMessageId, input.tenantId],
      );
      if (
        request.compensationEffectId !== input.effectId ||
        request.claimToken !== input.outboxClaimToken ||
        outbox.rows[0]?.claim_token !== input.outboxClaimToken
      )
        return { applied: false, reason: 'CLAIM_NOT_OWNED' };
      const effectResult = await client.query<Record<string, unknown>>(
        'SELECT * FROM commander_effects WHERE id=? AND tenant_id=?',
        [input.effectId, input.tenantId],
      );
      const effect = effectResult.rows[0];
      if (!effect) {
        if (disposition !== 'ESCALATED' || ('evidence' in input && input.evidence)) {
          return { applied: false, reason: 'PRE_ADMISSION_ESCALATION_ONLY' };
        }
        const at = new Date().toISOString();
        await client.query(
          `UPDATE commander_compensation_requests SET state='ESCALATED',updated_at=? WHERE id=?`,
          [at, request.id],
        );
        await client.query(
          `UPDATE commander_steps SET state='WAITING_FOR_HUMAN',lease_worker_id=NULL,
             lease_worker_generation=0,lease_token=NULL,lease_expires_at=NULL WHERE id=?`,
          [request.compensationStepId],
        );
        await client.query(
          `UPDATE commander_runs SET state='COMPENSATING',terminal_at=NULL,updated_at=? WHERE id=?`,
          [at, request.compensationRunId],
        );
        await client.query(
          `UPDATE commander_outbox SET published_at=?,claimed_at=NULL,claim_token=NULL WHERE id=?`,
          [at, input.outboxMessageId],
        );
        return { applied: true, disposition: 'ESCALATED', replayed: false };
      }
      if (disposition !== 'COMPLETION_UNKNOWN') {
        if (!('evidence' in input) || !input.evidence) {
          return { applied: false, reason: 'TERMINAL_EVIDENCE_REQUIRED' };
        }
        if (disposition === 'COMPLETED' && effect.state !== 'COMPLETED') {
          return { applied: false, reason: 'EFFECT_NOT_COMPLETED' };
        }
        if (
          disposition === 'CONFIRMED_NOT_APPLIED' &&
          !['COMPLETION_UNKNOWN', 'CONFIRMED_NOT_APPLIED'].includes(String(effect.state))
        ) {
          return { applied: false, reason: 'EFFECT_NOT_UNKNOWN' };
        }
        if (disposition === 'ESCALATED' && effect.state !== 'COMPLETION_UNKNOWN') {
          return { applied: false, reason: 'EFFECT_NOT_UNKNOWN' };
        }
        const current = fromEffectAdapter(effect);
        const projected = {
          ...current,
          state:
            disposition === 'COMPLETED'
              ? current.state
              : disposition === 'CONFIRMED_NOT_APPLIED'
                ? ('CONFIRMED_NOT_APPLIED' as const)
                : ('COMPLETION_UNKNOWN' as const),
        };
        assertEvidenceRecordBoundToEffect(input.evidence, projected);
        await this.appendSqliteEvidenceInTransaction(client, input.evidence);
      }
      if (disposition === 'COMPLETION_UNKNOWN') {
        if (!['ADMITTED', 'COMPLETION_UNKNOWN'].includes(String(effect.state)))
          return { applied: false, reason: 'EFFECT_NOT_ADMITTED_OR_UNKNOWN' };
        await client.query(
          `UPDATE commander_effects SET state='COMPLETION_UNKNOWN',response=?,reconcile_policy=?,reconcile_disposition='PENDING',reconcile_after=? WHERE id=?`,
          [payload, request.reconcilePolicy, new Date().toISOString(), input.effectId],
        );
        await client.query(
          `UPDATE commander_compensation_requests SET state='COMPLETION_UNKNOWN',updated_at=? WHERE id=?`,
          [new Date().toISOString(), request.id],
        );
        await client.query(
          `UPDATE commander_steps SET state='WAITING_FOR_RECONCILIATION',lease_worker_id=NULL,lease_worker_generation=0,lease_token=NULL,lease_expires_at=NULL WHERE id=?`,
          [request.compensationStepId],
        );
      } else if (disposition === 'COMPLETED') {
        await client.query(
          `UPDATE commander_compensation_requests SET state='COMPLETED',updated_at=? WHERE id=?`,
          [new Date().toISOString(), request.id],
        );
        await client.query(
          `UPDATE commander_steps SET state='SUCCEEDED',output=?,lease_worker_id=NULL,lease_worker_generation=0,lease_token=NULL,lease_expires_at=NULL WHERE id=?`,
          [payload, request.compensationStepId],
        );
        await client.query(
          `UPDATE commander_runs SET state='SUCCEEDED',terminal_at=?,updated_at=? WHERE id=?`,
          [new Date().toISOString(), new Date().toISOString(), request.compensationRunId],
        );
        await client.query(
          `UPDATE commander_runs SET state='COMPENSATED',terminal_at=?,updated_at=? WHERE id=? AND state='COMPENSATING'`,
          [new Date().toISOString(), new Date().toISOString(), request.originalRunId],
        );
      } else if (disposition === 'CONFIRMED_NOT_APPLIED') {
        await client.query(
          `UPDATE commander_effects SET state='CONFIRMED_NOT_APPLIED',response=?,completed_at=? WHERE id=?`,
          [payload, new Date().toISOString(), input.effectId],
        );
        await client.query(
          `UPDATE commander_compensation_requests SET state='CONFIRMED_NOT_APPLIED',updated_at=? WHERE id=?`,
          [new Date().toISOString(), request.id],
        );
        await client.query(
          `UPDATE commander_steps SET state='FAILED',lease_worker_id=NULL,lease_worker_generation=0,lease_token=NULL,lease_expires_at=NULL WHERE id=?`,
          [request.compensationStepId],
        );
        await client.query(
          `UPDATE commander_runs SET state='FAILED',terminal_at=?,updated_at=? WHERE id=?`,
          [new Date().toISOString(), new Date().toISOString(), request.compensationRunId],
        );
      } else {
        await client.query(
          `UPDATE commander_compensation_requests SET state='ESCALATED',updated_at=? WHERE id=?`,
          [new Date().toISOString(), request.id],
        );
        await client.query(
          `UPDATE commander_steps SET state='WAITING_FOR_HUMAN',lease_worker_id=NULL,lease_worker_generation=0,lease_token=NULL,lease_expires_at=NULL WHERE id=?`,
          [request.compensationStepId],
        );
        await client.query(
          `UPDATE commander_effects SET reconcile_disposition='ESCALATED',
             reconcile_escalated_at=?,reconcile_escalation_code=?,reconcile_after=NULL
           WHERE id=? AND tenant_id=?`,
          [
            new Date().toISOString(),
            'COMPENSATION_QUERY_UNSUPPORTED',
            input.effectId,
            input.tenantId,
          ],
        );
      }
      await client.query(
        `UPDATE commander_outbox SET published_at=?,claimed_at=NULL,claim_token=NULL WHERE id=?`,
        [new Date().toISOString(), input.outboxMessageId],
      );
      return { applied: true, disposition, replayed: false };
    }, scope.tenantIds);
  }

  /**
   * Rebuild the sealed governed authorization from the durable records the
   * producer wrote — the compensation request row, its authorization row, the
   * completed forward effect and the run-metadata evidence copy. Every compact
   * outbox field is cross-checked against those rows; the outbox payload is
   * never authoritative. The durable row stores the action digest used by the
   * request/admission path, so the governed authorization is re-sealed from the
   * durable content instead of trusting a caller-supplied digest.
   */
  private governedCompensationAuthorizationFromDurableEvidence(input: {
    evidence: unknown;
    request: KernelCompensationRequest;
    durableAuthorization: CompensationAuthorizationRecord;
    originalEffect: Record<string, unknown>;
  }): GovernedCompensationAuthorization | null {
    const evidence =
      input.evidence && typeof input.evidence === 'object' && !Array.isArray(input.evidence)
        ? (input.evidence as Record<string, unknown>)
        : null;
    if (!evidence) return null;
    const { request, durableAuthorization } = input;
    const originalRequest = reqJsonObject('commander_effects', input.originalEffect, 'request');
    const forwardResponse = (parseJsonValue(input.originalEffect.response) ?? {}) as Record<
      string,
      unknown
    >;
    const compensationRequest = {
      originalEffectId: request.originalEffectId,
      destination: originalRequest.destination,
      forwardResponse,
      compensationPatch: durableAuthorization.compensationPatch,
    };
    if (
      evidence.schema !== 'commander.compensation/v1' ||
      typeof evidence.originalRunStateAtRequest !== 'string' ||
      evidence.originalRunStateAtRequest.length === 0 ||
      typeof evidence.compensationEffectId !== 'string' ||
      evidence.compensationEffectId.length === 0 ||
      evidence.authorizationId !== durableAuthorization.id ||
      evidence.requestId !== request.id ||
      evidence.tenantId !== request.tenantId ||
      evidence.originalRunId !== request.originalRunId ||
      evidence.originalEffectId !== request.originalEffectId ||
      evidence.compensationRunId !== request.compensationRunId ||
      evidence.compensationStepId !== request.compensationStepId ||
      evidence.compensationEffectType !== durableAuthorization.compensationEffectType ||
      evidence.adapterVersion !== durableAuthorization.adapterVersion ||
      evidence.policyDecisionId !== durableAuthorization.policyDecisionId ||
      evidence.policySnapshotId !== durableAuthorization.policySnapshotId ||
      evidence.decisionEffect !== durableAuthorization.decision ||
      evidence.authorizationExpiresAt !== durableAuthorization.expiresAt ||
      evidence.forwardReceiptHash !== durableAuthorization.forwardReceiptHash ||
      evidence.actionDigest !== durableAuthorization.actionDigest ||
      canonicalJson(evidence.compensationRequest) !== canonicalJson(compensationRequest) ||
      canonicalJson(evidence.forwardReceipt ?? null) !== canonicalJson(forwardResponse) ||
      canonicalJson(evidence.approvalBinding ?? null) !==
        canonicalJson(durableAuthorization.approvalBinding ?? null) ||
      durableAuthorization.originalRunId !== request.originalRunId ||
      durableAuthorization.originalEffectId !== request.originalEffectId ||
      durableAuthorization.compensationEffectType !== request.compensationEffectType ||
      durableAuthorization.adapterVersion !== request.adapterVersion ||
      durableAuthorization.forwardReceiptHash !== request.forwardReceiptHash ||
      canonicalJson(durableAuthorization.compensationPatch) !==
        canonicalJson(parseJsonValue(request.compensationPatch)) ||
      canonicalCompensationHash(forwardResponse) !== durableAuthorization.forwardReceiptHash
    ) {
      return null;
    }
    const sealed = sealGovernedCompensationAuthorization({
      schema: 'commander.compensation/v1',
      authorizationId: durableAuthorization.id,
      requestId: request.id,
      tenantId: request.tenantId,
      originalRunId: request.originalRunId,
      originalEffectId: request.originalEffectId,
      originalRunStateAtRequest: evidence.originalRunStateAtRequest,
      compensationRunId: request.compensationRunId,
      compensationStepId: request.compensationStepId,
      compensationEffectId: evidence.compensationEffectId,
      compensationEffectType: durableAuthorization.compensationEffectType,
      compensationRequest,
      idempotencyKey: deriveEffectIdempotencyKey({
        tenantId: request.tenantId,
        runId: request.compensationRunId,
        stepId: request.compensationStepId,
        effectId: evidence.compensationEffectId,
        request: compensationRequest,
      }),
      forwardReceipt: forwardResponse,
      adapterVersion: durableAuthorization.adapterVersion,
      policyDecisionId: durableAuthorization.policyDecisionId,
      policySnapshotId: durableAuthorization.policySnapshotId,
      decisionEffect: durableAuthorization.decision,
      authorizationExpiresAt: durableAuthorization.expiresAt,
      approvalBinding: durableAuthorization.approvalBinding ?? null,
    });
    const validation = validateGovernedCompensationAuthorization(sealed);
    return validation.valid
      ? { ...validation.authorization, actionDigest: durableAuthorization.actionDigest }
      : null;
  }

  override async claimCompensationWork(
    input: CompensationClaimAuth & { topic: typeof KERNEL_COMPENSATION_TOPIC; limit: number },
  ): Promise<ClaimedCompensationWork[]> {
    if (input.topic !== KERNEL_COMPENSATION_TOPIC) return [];
    const scope = this.resolveDurableWorkerTenantScope(
      input.workerId,
      input.workerGeneration,
      input.claimSecret,
    );
    if (
      !scope ||
      !this.workerHasExactCapability(input.workerId, 'effect.compensate') ||
      input.limit <= 0
    ) {
      return [];
    }
    return this.withTransaction(async (client) => {
      const at = new Date();
      const atIso = at.toISOString();
      const staleBefore = new Date(at.getTime() - 60_000).toISOString();
      const candidates = await client.query<Record<string, unknown>>(
        `SELECT * FROM commander_outbox
         WHERE topic=? AND published_at IS NULL AND moved_to_dlq_at IS NULL
           AND attempts < max_attempts AND available_at <= ?
           AND (claimed_at IS NULL OR claimed_at <= ?)
           AND tenant_id IN (${scope.tenantIds.map(() => '?').join(',')})
         ORDER BY created_at,id LIMIT ?`,
        [input.topic, atIso, staleBefore, ...scope.tenantIds, input.limit],
      );
      const claimed: ClaimedCompensationWork[] = [];
      for (const message of candidates.rows) {
        const rawPayload = parseJsonValue(message.payload);
        const payload =
          rawPayload && typeof rawPayload === 'object' && !Array.isArray(rawPayload)
            ? (rawPayload as Record<string, unknown>)
            : null;
        const payloadRequestId = typeof payload?.requestId === 'string' ? payload.requestId : null;
        const payloadAuthorizationId =
          typeof payload?.authorizationId === 'string' ? payload.authorizationId : null;
        const payloadTenantId = typeof payload?.tenantId === 'string' ? payload.tenantId : null;
        const payloadActionDigest =
          typeof payload?.actionDigest === 'string' ? payload.actionDigest : null;
        // Mirror claim_compensation_request_v2: resolve from the durable
        // compensation request, then its sealed authorization row, then the
        // forward effect. The compact outbox payload is only a cross-check.
        const requestResult = payloadRequestId
          ? await client.query<Record<string, unknown>>(
              `SELECT * FROM commander_compensation_requests WHERE id=? AND tenant_id=?`,
              [payloadRequestId, message.tenant_id],
            )
          : { rows: [] as Record<string, unknown>[] };
        const requestRow = requestResult.rows[0];
        const request = requestRow ? this.compensationRequestFromRow(requestRow) : null;
        if (request && !request.compensationEffectId) {
          request.compensationEffectId = `effect_${canonicalCompensationHash({ requestId: request.id, originalEffectId: request.originalEffectId }).slice(0, 40)}`;
        }
        const authorizationResult = request
          ? await client.query<Record<string, unknown>>(
              `SELECT * FROM commander_compensation_authorizations WHERE id=? AND tenant_id=?`,
              [request.authorizationId, message.tenant_id],
            )
          : { rows: [] as Record<string, unknown>[] };
        const durableAuthorization = authorizationResult.rows[0]
          ? this.compensationAuthorizationFromRow(authorizationResult.rows[0])
          : null;
        const runResult = request
          ? await client.query<Record<string, unknown>>(
              `SELECT * FROM commander_runs WHERE id=? AND tenant_id=?`,
              [request.compensationRunId, message.tenant_id],
            )
          : { rows: [] as Record<string, unknown>[] };
        const stepResult = request
          ? await client.query<Record<string, unknown>>(
              `SELECT * FROM commander_steps WHERE id=? AND run_id=? AND tenant_id=?`,
              [request.compensationStepId, request.compensationRunId, message.tenant_id],
            )
          : { rows: [] as Record<string, unknown>[] };
        const effectResult = request
          ? await client.query<Record<string, unknown>>(
              `SELECT * FROM commander_effects WHERE id=? AND tenant_id=? AND state='COMPLETED'`,
              [request.originalEffectId, message.tenant_id],
            )
          : { rows: [] as Record<string, unknown>[] };
        const run = runResult.rows[0];
        const step = stepResult.rows[0];
        const originalEffect = effectResult.rows[0];
        if (request && originalEffect) {
          const originalRequest = reqJsonObject('commander_effects', originalEffect, 'request');
          request.destination =
            typeof originalRequest.destination === 'string' ? originalRequest.destination : '';
        }
        const runAuthorization = run
          ? (
              (parseJsonValue(run.metadata) as Record<string, unknown>).compensation as
                Record<string, unknown> | undefined
            )?.authorization
          : null;
        const stepAuthorization = step
          ? (parseJsonValue(step.input) as Record<string, unknown>).authorization
          : null;
        const authorization =
          request && durableAuthorization && originalEffect && runAuthorization
            ? this.governedCompensationAuthorizationFromDurableEvidence({
                evidence: runAuthorization,
                request,
                durableAuthorization,
                originalEffect,
              })
            : null;
        if (
          !payload ||
          !request ||
          !durableAuthorization ||
          !authorization ||
          payloadTenantId !== message.tenant_id ||
          payloadRequestId !== request.id ||
          payloadAuthorizationId !== durableAuthorization.id ||
          payloadActionDigest !== durableAuthorization.actionDigest ||
          request.tenantId !== message.tenant_id ||
          request.authorizationId !== durableAuthorization.id ||
          !run ||
          !step ||
          run.state !== 'PENDING' ||
          step.state !== 'PENDING' ||
          !runAuthorization ||
          !stepAuthorization ||
          canonicalJson(runAuthorization) !== canonicalJson(stepAuthorization)
        ) {
          await client.query(
            `UPDATE commander_outbox
             SET published_at=?,claimed_at=NULL,claim_token=NULL WHERE id=?`,
            [atIso, message.id],
          );
          if (run) {
            const metadata = parseJsonValue(run.metadata) as Record<string, unknown>;
            const compensation = (metadata.compensation ?? {}) as Record<string, unknown>;
            compensation.disposition = 'ESCALATED';
            compensation.escalationReason = 'COMPENSATION_AUTHORIZATION_REQUIRED';
            metadata.compensation = compensation;
            await client.query(
              `UPDATE commander_runs SET state='FAILED',version=version+1,metadata=?,
                 updated_at=?,terminal_at=? WHERE id=? AND tenant_id=? AND state IN ('PENDING','RUNNING')`,
              [metadata, atIso, atIso, run.id, message.tenant_id],
            );
          }
          if (step) {
            await client.query(
              `UPDATE commander_steps SET state='FAILED',version=version+1,error=?,updated_at=?
               WHERE id=? AND tenant_id=? AND state NOT IN ('SUCCEEDED','FAILED','CANCELLED','SKIPPED')`,
              [
                {
                  code: 'COMPENSATION_AUTHORIZATION_REQUIRED',
                  message: 'Governed compensation authorization is missing or stale',
                  retryable: false,
                },
                atIso,
                step.id,
                message.tenant_id,
              ],
            );
          }
          continue;
        }
        const claimToken = randomUUID();
        const fencingEpoch = Number(step.fencing_epoch ?? 0) + 1;
        const expiresAt = new Date(
          Math.min(at.getTime() + 60_000, Date.parse(authorization.authorizationExpiresAt)),
        ).toISOString();
        await client.query(
          `UPDATE commander_outbox SET claimed_at=?,claim_token=?,attempts=attempts+1 WHERE id=?`,
          [atIso, claimToken, message.id],
        );
        // COMPENSATING, not RUNNING: claim_compensation_request (the SQL
        // authority) and claimCompensationRequest both move the compensation run
        // to COMPENSATING here, this method's own settlement only advances a run
        // that is COMPENSATING (`WHERE ... AND state='COMPENSATING'`), and the
        // governed-completion path requires it. Writing RUNNING here left every
        // batch-claimed compensation unable to settle.
        await client.query(
          `UPDATE commander_runs SET state='COMPENSATING',version=version+1,updated_at=?
           WHERE id=? AND tenant_id=? AND state IN ('PENDING','COMPENSATING')`,
          [atIso, run.id, message.tenant_id],
        );
        await client.query(
          `UPDATE commander_runs SET state='COMPENSATING',terminal_at=NULL,version=version+1,
             updated_at=? WHERE id=? AND tenant_id=? AND state<>'COMPENSATING'`,
          [atIso, request.originalRunId, message.tenant_id],
        );
        await client.query(
          `UPDATE commander_steps SET state='RUNNING',version=version+1,attempt=attempt+1,
             lease_worker_id=?,lease_worker_generation=?,lease_token=?,fencing_epoch=?,
             lease_expires_at=?,updated_at=?
           WHERE id=? AND tenant_id=? AND state='PENDING'`,
          [
            input.workerId,
            input.workerGeneration,
            claimToken,
            fencingEpoch,
            expiresAt,
            atIso,
            step.id,
            message.tenant_id,
          ],
        );
        // Stamp the durable request's ownership exactly as claimCompensationRequest
        // does; the settlement path validates request.claimToken against the
        // outbox claim token and refuses otherwise as CLAIM_NOT_OWNED.
        await client.query(
          `UPDATE commander_compensation_requests SET state='CLAIMED',claim_worker_id=?,
             claim_worker_generation=?,claim_token=?,claim_expires_at=?,compensation_effect_id=?,
             updated_at=? WHERE id=? AND tenant_id=?`,
          [
            input.workerId,
            input.workerGeneration,
            claimToken,
            expiresAt,
            request.compensationEffectId,
            atIso,
            request.id,
            message.tenant_id,
          ],
        );
        await client.query(
          `UPDATE commander_tenant_execution_usage
           SET running_steps=running_steps+1,updated_at=? WHERE tenant_id=?`,
          [atIso, message.tenant_id],
        );
        request.state = 'CLAIMED';
        request.claimWorkerId = input.workerId;
        request.claimWorkerGeneration = input.workerGeneration;
        request.claimToken = claimToken;
        request.claimExpiresAt = expiresAt;
        // Keep the batch claim identical to claimCompensationRequest and the
        // Postgres implementation: the consumer receives durable request data
        // plus the outbox identity and claim token.
        claimed.push({
          request: { ...request, state: 'CLAIMED' },
          authorization: durableAuthorization,
          forwardResponse: (originalEffect.response ?? {}) as Record<string, unknown>,
          lease: {
            workerId: input.workerId,
            workerGeneration: input.workerGeneration,
            token: claimToken,
            fencingEpoch,
            expiresAt,
          },
          outboxMessageId: String(message.id),
          outboxClaimToken: claimToken,
        });
      }
      return claimed;
    }, scope.tenantIds);
  }

  override async markEffectCompletionUnknown(
    request: MarkEffectCompletionUnknownRequest,
  ): Promise<KernelEffect | null> {
    return this.withTransaction(
      async (client) => {
        const effectResult = await client.query<Record<string, unknown>>(
          `SELECT * FROM commander_effects WHERE id=? AND tenant_id=?`,
          [request.effectId, request.tenantId],
        );
        const effect = effectResult.rows[0];
        if (!effect || effect.state !== 'ADMITTED') return null;
        const stepResult = await client.query<Record<string, unknown>>(
          `SELECT * FROM commander_steps WHERE id=? AND run_id=? AND tenant_id=?`,
          [effect.step_id, effect.run_id, request.tenantId],
        );
        const runResult = await client.query<{ state: string }>(
          `SELECT state FROM commander_runs WHERE id=? AND tenant_id=?`,
          [effect.run_id, request.tenantId],
        );
        const step = stepResult.rows[0];
        if (!step || step.state !== 'RUNNING' || runResult.rows[0]?.state !== 'RUNNING')
          return null;
        if (
          request.lease &&
          (step.lease_worker_id !== request.lease.workerId ||
            Number(step.lease_worker_generation) !== request.lease.workerGeneration ||
            step.lease_token !== request.lease.token ||
            Number(step.fencing_epoch) !== request.lease.fencingEpoch ||
            !step.lease_expires_at ||
            Date.parse(String(step.lease_expires_at)) <= Date.now())
        ) {
          return null;
        }
        const unknownAt = new Date().toISOString();
        const policy = createReconcilePolicy({
          unknownAt,
          governedActionDeadlineAt: request.governedActionDeadlineAt,
        });
        const updated = await client.query<Record<string, unknown>>(
          `UPDATE commander_effects
         SET state='COMPLETION_UNKNOWN', response=?, governed_action_deadline_at=?,
             reconcile_max_attempts=?, reconcile_initial_delay_ms=?, reconcile_max_delay_ms=?,
             reconcile_deadline_at=?, reconcile_disposition='PENDING', reconcile_after=?,
             reconcile_observed_at=NULL, reconcile_attempts=0, reconcile_last_error=NULL,
             reconcile_escalated_at=NULL, reconcile_escalation_code=NULL,
             reconcile_claim_token=NULL, reconcile_claim_expires_at=NULL,
             reconcile_claimed_at=NULL, reconcile_claim_worker_id=NULL,
             reconcile_claim_worker_generation=NULL
         WHERE id=? AND tenant_id=? AND state='ADMITTED'
         RETURNING *`,
          [
            { completionUnknownReason: request.reason },
            request.governedActionDeadlineAt ?? null,
            policy.maxAttempts,
            policy.initialDelayMs,
            policy.maxDelayMs,
            policy.deadlineAt,
            unknownAt,
            request.effectId,
            request.tenantId,
          ],
        );
        if (!updated.rows[0]) return null;
        await client.query(
          `UPDATE commander_steps
         SET state='WAITING_FOR_RECONCILIATION', version=version+1, updated_at=?,
             lease_worker_id=NULL, lease_token=NULL, lease_expires_at=NULL
         WHERE id=? AND tenant_id=? AND state='RUNNING'`,
          [unknownAt, effect.step_id, request.tenantId],
        );
        await client.query(
          `UPDATE commander_tenant_execution_usage
         SET running_steps=MAX(0, running_steps-1), updated_at=? WHERE tenant_id=?`,
          [unknownAt, request.tenantId],
        );
        const sequence = await this.nextEffectEventSequence(client, request.effectId);
        await this.appendEvent(client, {
          aggregateType: 'effect',
          aggregateId: request.effectId,
          sequence,
          type: 'effect.completion_unknown',
          tenantId: request.tenantId,
          runId: String(effect.run_id),
          stepId: String(effect.step_id),
          actor: request.actor,
          payload: { reason: request.reason },
        });
        return fromEffectAdapter(updated.rows[0]);
      },
      [request.tenantId],
    );
  }

  override async parkEffectCompletionUnknown(
    input: ParkEffectCompletionUnknownInput,
  ): Promise<ParkEffectCompletionUnknownResult> {
    return this.withTransaction(
      async (client) => {
        const scope = this.resolveDurableWorkerTenantScope(
          input.workerId,
          input.workerGeneration,
          input.claimSecret,
        );
        if (
          !scope?.tenantIds.includes(input.tenantId) ||
          !this.workerHasAnyCapability(input.workerId, ['effect.execute', 'tool'])
        ) {
          return { parked: false, reason: 'LEASE_FENCED' };
        }
        const effectResult = await client.query<Record<string, unknown>>(
          `SELECT * FROM commander_effects WHERE id=? AND tenant_id=?`,
          [input.effectId, input.tenantId],
        );
        const effect = effectResult.rows[0];
        if (!effect) return { parked: false, reason: 'NOT_FOUND' };
        const leaseTokenHash = sha256(input.leaseToken);
        if (effect.state === 'COMPLETION_UNKNOWN') {
          const replayed =
            effect.completion_unknown_worker_id === input.workerId &&
            Number(effect.completion_unknown_worker_generation) === input.workerGeneration &&
            effect.completion_unknown_lease_token_hash === leaseTokenHash &&
            Number(effect.completion_unknown_fencing_epoch) === input.fencingEpoch;
          return replayed
            ? { parked: true, replayed: true, effect: fromEffectAdapter(effect) }
            : { parked: false, reason: 'ADMISSION_BINDING_MISMATCH' };
        }
        if (effect.state !== 'ADMITTED') {
          return { parked: false, reason: 'NOT_ADMITTED_OR_UNKNOWN' };
        }
        const stepResult = await client.query<Record<string, unknown>>(
          `SELECT * FROM commander_steps WHERE id=? AND run_id=? AND tenant_id=?`,
          [effect.step_id, effect.run_id, input.tenantId],
        );
        const step = stepResult.rows[0];
        if (!step) return { parked: false, reason: 'NOT_FOUND' };
        if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'SKIPPED'].includes(String(step.state))) {
          return { parked: false, reason: 'STEP_TERMINAL_RACE' };
        }
        if (
          step.state !== 'RUNNING' ||
          step.lease_worker_id !== input.workerId ||
          Number(step.lease_worker_generation) !== input.workerGeneration ||
          step.lease_token !== input.leaseToken ||
          Number(step.fencing_epoch) !== input.fencingEpoch ||
          !step.lease_expires_at ||
          Date.parse(String(step.lease_expires_at)) <= Date.now() ||
          effect.lease_worker_id !== input.workerId ||
          Number(effect.lease_worker_generation) !== input.workerGeneration ||
          Number(effect.lease_fencing_epoch) !== input.fencingEpoch
        ) {
          return { parked: false, reason: 'ADMISSION_BINDING_MISMATCH' };
        }
        const unknownAt = new Date().toISOString();
        const policy = createReconcilePolicy({
          unknownAt,
          governedActionDeadlineAt: input.governedActionDeadlineAt,
        });
        const updated = await client.query<Record<string, unknown>>(
          `UPDATE commander_effects
         SET state='COMPLETION_UNKNOWN', response=?, governed_action_deadline_at=?,
             reconcile_max_attempts=?, reconcile_initial_delay_ms=?, reconcile_max_delay_ms=?,
             reconcile_deadline_at=?, reconcile_disposition='PENDING', reconcile_after=?,
             reconcile_observed_at=NULL, reconcile_attempts=0, reconcile_last_error=?,
             reconcile_escalated_at=NULL, reconcile_escalation_code=NULL,
             reconcile_claim_token=NULL, reconcile_claim_expires_at=NULL,
             reconcile_claimed_at=NULL, reconcile_claim_worker_id=NULL,
             reconcile_claim_worker_generation=NULL,
             completion_unknown_worker_id=?, completion_unknown_worker_generation=?,
             completion_unknown_lease_token_hash=?, completion_unknown_fencing_epoch=?
         WHERE id=? AND tenant_id=? AND state='ADMITTED'
         RETURNING *`,
          [
            { completionUnknownError: input.error },
            input.governedActionDeadlineAt ?? null,
            policy.maxAttempts,
            policy.initialDelayMs,
            policy.maxDelayMs,
            policy.deadlineAt,
            unknownAt,
            input.error,
            input.workerId,
            input.workerGeneration,
            leaseTokenHash,
            input.fencingEpoch,
            input.effectId,
            input.tenantId,
          ],
        );
        if (!updated.rows[0]) return { parked: false, reason: 'NOT_ADMITTED_OR_UNKNOWN' };
        await client.query(
          `UPDATE commander_steps
         SET state='WAITING_FOR_RECONCILIATION', version=version+1, updated_at=?,
             lease_worker_id=NULL, lease_token=NULL, lease_expires_at=NULL
         WHERE id=? AND tenant_id=? AND state='RUNNING'`,
          [unknownAt, effect.step_id, input.tenantId],
        );
        await client.query(
          `UPDATE commander_tenant_execution_usage
         SET running_steps=MAX(0, running_steps-1), updated_at=? WHERE tenant_id=?`,
          [unknownAt, input.tenantId],
        );
        const sequence = await this.nextEffectEventSequence(client, input.effectId);
        await this.appendEvent(client, {
          aggregateType: 'effect',
          aggregateId: input.effectId,
          sequence,
          type: 'effect.completion_unknown',
          tenantId: input.tenantId,
          runId: String(effect.run_id),
          stepId: String(effect.step_id),
          actor: input.workerId,
          payload: { error: input.error },
        });
        return { parked: true, replayed: false, effect: fromEffectAdapter(updated.rows[0]) };
      },
      [input.tenantId],
    );
  }

  override async requestReconcile(input: RequestReconcileInput): Promise<RequestReconcileResult> {
    const requestedAt = new Date();
    return this.withTransaction(
      async (client) => {
        const selected = await client.query<{
          id: string;
          run_id: string;
          step_id: string;
          state: string;
          reconcile_disposition: string | null;
          reconcile_after: string | null;
          reconcile_deadline_at: string | null;
          reconcile_escalated_at: string | null;
          reconcile_attempts: number;
        }>(
          `SELECT id, run_id, step_id, state, reconcile_disposition, reconcile_after,
                reconcile_deadline_at, reconcile_escalated_at, reconcile_attempts
         FROM commander_effects WHERE id=? AND tenant_id=?`,
          [input.effectId, input.tenantId],
        );
        const effect = selected.rows[0];
        if (!effect) return { scheduled: false, reason: 'NOT_FOUND' };
        if (effect.state !== 'COMPLETION_UNKNOWN') {
          return { scheduled: false, reason: 'NOT_UNKNOWN' };
        }
        if (effect.reconcile_disposition === 'ESCALATED' || effect.reconcile_escalated_at) {
          return { scheduled: false, reason: 'ESCALATED' };
        }
        if (effect.reconcile_disposition !== 'PENDING') {
          return { scheduled: false, reason: 'NOT_UNKNOWN' };
        }
        if (
          !effect.reconcile_deadline_at ||
          Date.parse(effect.reconcile_deadline_at) <= requestedAt.getTime()
        ) {
          return { scheduled: false, reason: 'DEADLINE_EXPIRED' };
        }
        const prior = effect.reconcile_after;
        const alreadyScheduled = prior !== null && Date.parse(prior) <= requestedAt.getTime();
        const reconcileAfter = new Date(
          Math.min(
            prior === null ? requestedAt.getTime() : Date.parse(prior),
            requestedAt.getTime(),
          ),
        ).toISOString();
        const updated = await client.query(
          `UPDATE commander_effects SET reconcile_after=?
         WHERE id=? AND tenant_id=? AND state='COMPLETION_UNKNOWN'
           AND reconcile_disposition='PENDING' AND reconcile_escalated_at IS NULL
           AND reconcile_deadline_at > ?`,
          [reconcileAfter, effect.id, input.tenantId, requestedAt.toISOString()],
        );
        if (updated.rowCount !== 1) return { scheduled: false, reason: 'NOT_UNKNOWN' };
        if (!alreadyScheduled) {
          const nextSequence = await client.query<{ sequence: number }>(
            `SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
           FROM commander_events WHERE aggregate_type='effect' AND aggregate_id=?`,
            [effect.id],
          );
          await this.appendEvent(client, {
            aggregateType: 'effect',
            aggregateId: effect.id,
            sequence: Number(nextSequence.rows[0]?.sequence ?? 1),
            type: 'effect.reconcile_requested',
            tenantId: input.tenantId,
            runId: effect.run_id,
            stepId: effect.step_id,
            actor: input.actor,
            payload: { reconcileAfter },
          });
        }
        return {
          scheduled: true,
          effectId: effect.id,
          state: 'COMPLETION_UNKNOWN',
          reconcileAfter,
          alreadyScheduled,
        };
      },
      [input.tenantId],
    );
  }

  override async claimReconcileEffects(
    input: import('./types.js').ClaimReconcileEffectsInput,
  ): Promise<import('./types.js').ClaimedReconcileEffect[]> {
    const at = input.now ?? new Date();
    const claimTtlMs = input.claimTtlMs ?? 60_000;
    const claimToken = randomUUID();
    const claimExpiresAt = new Date(at.getTime() + claimTtlMs).toISOString();
    const workerGeneration = input.workerGeneration ?? -1;
    const claimWorkerId = input.workerId?.trim() || 'scheduler';
    const claimWorkerGeneration = input.workerGeneration ?? 1;

    // Worker path (PG claim_reconcile_effects parity): authorize solely from
    // durable commander_workers.tenant_ids — fail-closed when missing/empty/stale.
    let tenantFilter: string[] | null = null; // null = open-ended (*)
    let txScope: string[];
    if (!this.claimSchedulerMode) {
      const workerId = input.workerId?.trim();
      if (!workerId) {
        throw new Error('claimReconcileEffects requires workerId on the worker LOGIN path');
      }
      const scope = this.resolveDurableWorkerTenantScope(
        workerId,
        workerGeneration,
        input.claimSecret,
      );
      if (!scope) return [];
      tenantFilter = scope.openEnded ? null : scope.tenantIds;
      if (tenantFilter !== null && tenantFilter.length === 0) return [];
      txScope = scope.openEnded ? ['*'] : scope.tenantIds;
    } else {
      txScope = ['*'];
    }

    return this.withTransaction(async (client) => {
      if (!this.claimSchedulerMode) {
        const workerId = input.workerId!.trim();
        const scope = this.resolveDurableWorkerTenantScope(
          workerId,
          workerGeneration,
          input.claimSecret,
        );
        if (!scope) return [];
        tenantFilter = scope.openEnded ? null : scope.tenantIds;
        if (tenantFilter !== null && tenantFilter.length === 0) return [];
      }

      const filterTenants = tenantFilter ?? [];
      const tenantClause =
        tenantFilter === null
          ? ''
          : ` AND tenant_id IN (${filterTenants.map(() => '?').join(',')})`;
      const candidates = await client.query<{ id: string }>(
        `SELECT id FROM commander_effects
         WHERE state='COMPLETION_UNKNOWN' AND reconcile_disposition='PENDING'
           AND reconcile_escalated_at IS NULL AND reconcile_deadline_at > ?
           AND reconcile_attempts < reconcile_max_attempts
           AND reconcile_after IS NOT NULL AND reconcile_after <= ?
           AND (reconcile_claim_expires_at IS NULL OR reconcile_claim_expires_at < ?)${tenantClause}
         ORDER BY reconcile_after ASC LIMIT ?`,
        [at.toISOString(), at.toISOString(), at.toISOString(), ...filterTenants, input.limit],
      );
      if (candidates.rows.length === 0) return [];
      const ids = candidates.rows.map((r) => r.id);
      const placeholders = ids.map(() => '?').join(',');
      const result = await client.query<Record<string, unknown>>(
        `UPDATE commander_effects
         SET reconcile_claim_token=?, reconcile_claim_expires_at=?, reconcile_claimed_at=?,
             reconcile_claim_worker_id=?, reconcile_claim_worker_generation=?
         WHERE id IN (${placeholders}) AND state='COMPLETION_UNKNOWN'
           AND reconcile_disposition='PENDING' AND reconcile_deadline_at > ?
         RETURNING *`,
        [
          claimToken,
          claimExpiresAt,
          at.toISOString(),
          claimWorkerId,
          claimWorkerGeneration,
          ...ids,
          at.toISOString(),
        ],
      );
      return result.rows.map((row) => ({
        effect: fromEffectAdapter(row),
        claimToken,
      }));
    }, txScope);
  }

  override async completeReconcileEffect(
    input: ReconcileClaimAuth & { response: Record<string, unknown> },
  ): Promise<ReconcileMutationResult> {
    return this.applyReconcileMutation(input, 'COMPLETE', input.response);
  }

  override async confirmEffectNotApplied(
    input: ReconcileClaimAuth & { response: Record<string, unknown> },
  ): Promise<ReconcileMutationResult> {
    return this.applyReconcileMutation(input, 'CONFIRM_NOT_APPLIED', input.response);
  }

  override async rescheduleReconcileEffect(
    input: ReconcileClaimAuth & { lastError: ReconcileQueryError },
  ): Promise<ReconcileMutationResult> {
    return this.applyReconcileMutation(input, 'RESCHEDULE', input.lastError);
  }

  override async escalateReconcileEffect(
    input: ReconcileClaimAuth & {
      reason:
        | 'RECONCILE_ADAPTER_NOT_FOUND'
        | 'RECONCILE_QUERY_UNSUPPORTED'
        | 'COMPENSATION_QUERY_UNSUPPORTED'
        | 'RECONCILE_POLICY_BACKFILL_REVIEW_REQUIRED';
    },
  ): Promise<ReconcileMutationResult> {
    return this.applyReconcileMutation(input, 'ESCALATE', input.reason);
  }

  private async applyReconcileMutation(
    input: ReconcileClaimAuth,
    mutation: 'COMPLETE' | 'CONFIRM_NOT_APPLIED' | 'RESCHEDULE' | 'ESCALATE',
    payload: Record<string, unknown> | ReconcileQueryError | string,
  ): Promise<ReconcileMutationResult> {
    return this.withTransaction(
      async (client) => {
        const scope = this.resolveDurableWorkerTenantScope(
          input.workerId,
          input.workerGeneration,
          input.claimSecret,
        );
        if (
          !scope?.tenantIds.includes(input.tenantId) ||
          !this.workerHasAnyCapability(input.workerId, ['effect.reconcile'])
        ) {
          return { applied: false, reason: 'WORKER_FENCED' };
        }
        const selected = await client.query<Record<string, unknown>>(
          `SELECT e.*, s.state AS step_state, r.state AS run_state
         FROM commander_effects e
         JOIN commander_steps s ON s.id=e.step_id AND s.tenant_id=e.tenant_id
         JOIN commander_runs r ON r.id=e.run_id AND r.tenant_id=e.tenant_id
         WHERE e.id=? AND e.tenant_id=?`,
          [input.effectId, input.tenantId],
        );
        const effect = selected.rows[0];
        if (!effect) return { applied: false, reason: 'NOT_FOUND' };

        const claimTokenHash = sha256(input.claimToken);
        const requestFingerprint = sha256(
          canonicalJson({
            mutation,
            tenantId: input.tenantId,
            effectId: input.effectId,
            payload,
            evidenceContentHash: input.evidence?.contentHash ?? null,
          }),
        );
        if (!effect.reconcile_claim_token) {
          if (
            effect.reconcile_last_claim_token_hash === claimTokenHash &&
            effect.reconcile_last_claim_worker_id === input.workerId &&
            Number(effect.reconcile_last_claim_worker_generation) === input.workerGeneration
          ) {
            if (effect.reconcile_last_request_fingerprint !== requestFingerprint) {
              return { applied: false, reason: 'CLAIM_REPLAY_CONFLICT' };
            }
            const prior = parseJsonValue(effect.reconcile_last_result) as ReconcileMutationResult;
            return prior && prior.applied
              ? { ...prior, replayed: true }
              : { applied: false, reason: 'CLAIM_NOT_OWNED' };
          }
          return { applied: false, reason: 'CLAIM_NOT_OWNED' };
        }
        if (
          effect.reconcile_claim_token !== input.claimToken ||
          effect.reconcile_claim_worker_id !== input.workerId ||
          Number(effect.reconcile_claim_worker_generation) !== input.workerGeneration
        ) {
          return { applied: false, reason: 'CLAIM_NOT_OWNED' };
        }
        const observedAt = new Date().toISOString();
        if (
          !effect.reconcile_claim_expires_at ||
          Date.parse(String(effect.reconcile_claim_expires_at)) <= Date.parse(observedAt)
        ) {
          return { applied: false, reason: 'CLAIM_EXPIRED' };
        }
        if (effect.state !== 'COMPLETION_UNKNOWN' || effect.reconcile_disposition !== 'PENDING') {
          return { applied: false, reason: 'NOT_COMPLETION_UNKNOWN' };
        }
        if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'SKIPPED'].includes(String(effect.step_state))) {
          return {
            applied: false,
            reason: 'STEP_TERMINAL_RACE',
            stepState: effect.step_state as 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'SKIPPED',
          };
        }
        if (
          ['SUCCEEDED', 'FAILED', 'CANCELLED', 'COMPENSATED'].includes(String(effect.run_state))
        ) {
          return {
            applied: false,
            reason: 'RUN_TERMINAL_RACE',
            runState: effect.run_state as 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'COMPENSATED',
          };
        }

        const deadlineAt = String(effect.reconcile_deadline_at);
        const deadlineExpired = Date.parse(observedAt) >= Date.parse(deadlineAt);
        const nextAttempt = Number(effect.reconcile_attempts) + 1;
        const nextAfter = nextReconcileAfter(
          {
            maxAttempts: Number(effect.reconcile_max_attempts),
            initialDelayMs: Number(effect.reconcile_initial_delay_ms),
            maxDelayMs: Number(effect.reconcile_max_delay_ms),
            deadlineAt,
          },
          nextAttempt,
          observedAt,
        );
        const rescheduleEscalates =
          mutation === 'RESCHEDULE' &&
          (nextAttempt >= Number(effect.reconcile_max_attempts) ||
            Date.parse(nextAfter) >= Date.parse(deadlineAt));
        const projectedState =
          mutation === 'COMPLETE' && !deadlineExpired
            ? ('COMPLETED' as const)
            : mutation === 'CONFIRM_NOT_APPLIED' && !deadlineExpired
              ? ('CONFIRMED_NOT_APPLIED' as const)
              : mutation === 'ESCALATE' || deadlineExpired || rescheduleEscalates
                ? ('COMPLETION_UNKNOWN' as const)
                : null;
        if (projectedState) {
          if (!input.evidence) {
            return { applied: false, reason: 'TERMINAL_EVIDENCE_REQUIRED' };
          }
          assertEvidenceRecordBoundToEffect(input.evidence, {
            ...fromEffectAdapter(effect),
            state: projectedState,
          });
          await this.appendSqliteEvidenceInTransaction(client, input.evidence);
        }
        let disposition: Extract<ReconcileMutationResult, { applied: true }>['disposition'];
        let eventType: string;
        let attempts = Number(effect.reconcile_attempts);
        let reconcileAfter: string | null;
        let escalatedAt = effect.reconcile_escalated_at
          ? String(effect.reconcile_escalated_at)
          : null;

        if (mutation === 'COMPLETE' && !deadlineExpired) {
          await client.query(
            `UPDATE commander_effects
           SET state='COMPLETED', response=?, completed_at=?,
               reconcile_disposition='CONFIRMED_APPLIED', reconcile_observed_at=?,
               reconcile_after=NULL
           WHERE id=? AND tenant_id=?`,
            [payload, observedAt, observedAt, input.effectId, input.tenantId],
          );
          await client.query(
            `UPDATE commander_steps
           SET state='SUCCEEDED', output=?, error=NULL, version=version+1, updated_at=?
           WHERE id=? AND tenant_id=?`,
            [payload, observedAt, effect.step_id, input.tenantId],
          );
          reconcileAfter = null;
          disposition = 'COMPLETED';
          eventType = 'effect.reconciled_completed';
        } else if (mutation === 'CONFIRM_NOT_APPLIED' && !deadlineExpired) {
          await client.query(
            `UPDATE commander_effects
           SET state='CONFIRMED_NOT_APPLIED', response=?, completed_at=?,
               reconcile_disposition='CONFIRMED_NOT_APPLIED', reconcile_observed_at=?,
               reconcile_after=NULL
           WHERE id=? AND tenant_id=?`,
            [payload, observedAt, observedAt, input.effectId, input.tenantId],
          );
          await client.query(
            `UPDATE commander_steps
           SET state='FAILED', error=?, version=version+1, updated_at=?
           WHERE id=? AND tenant_id=?`,
            [
              {
                code: 'REMOTE_NOT_APPLIED',
                message: 'Remote outcome confirmed the action was not applied',
                retryable: false,
              },
              observedAt,
              effect.step_id,
              input.tenantId,
            ],
          );
          reconcileAfter = null;
          disposition = 'CONFIRMED_NOT_APPLIED';
          eventType = 'effect.confirmed_not_applied';
        } else if (mutation === 'RESCHEDULE' && !deadlineExpired) {
          attempts += 1;
          const policy = {
            maxAttempts: Number(effect.reconcile_max_attempts),
            initialDelayMs: Number(effect.reconcile_initial_delay_ms),
            maxDelayMs: Number(effect.reconcile_max_delay_ms),
            deadlineAt,
          };
          const mustEscalate =
            attempts >= policy.maxAttempts || Date.parse(nextAfter) >= Date.parse(deadlineAt);
          if (mustEscalate) {
            const code =
              attempts >= policy.maxAttempts
                ? 'RECONCILE_MAX_ATTEMPTS_EXHAUSTED'
                : 'RECONCILE_DEADLINE_EXPIRED';
            await client.query(
              `UPDATE commander_effects
             SET reconcile_attempts=?, reconcile_observed_at=?, reconcile_last_error=?,
                 reconcile_disposition='ESCALATED', reconcile_escalated_at=?,
                 reconcile_escalation_code=?, reconcile_after=NULL
             WHERE id=? AND tenant_id=?`,
              [attempts, observedAt, payload, observedAt, code, input.effectId, input.tenantId],
            );
            await client.query(
              `UPDATE commander_steps
             SET state='WAITING_FOR_HUMAN', version=version+1, updated_at=?
             WHERE id=? AND tenant_id=?`,
              [observedAt, effect.step_id, input.tenantId],
            );
            reconcileAfter = null;
            escalatedAt = observedAt;
            disposition = 'ESCALATED';
            eventType = 'effect.reconcile_escalated';
          } else {
            await client.query(
              `UPDATE commander_effects
             SET reconcile_attempts=?, reconcile_observed_at=?, reconcile_last_error=?,
                 reconcile_after=?
             WHERE id=? AND tenant_id=?`,
              [attempts, observedAt, payload, nextAfter, input.effectId, input.tenantId],
            );
            reconcileAfter = nextAfter;
            disposition = 'RESCHEDULED';
            eventType = 'effect.reconcile_rescheduled';
          }
        } else {
          attempts += 1;
          const escalationCode = deadlineExpired ? 'RECONCILE_DEADLINE_EXPIRED' : String(payload);
          await client.query(
            `UPDATE commander_effects
           SET reconcile_attempts=?, reconcile_observed_at=?,
               reconcile_disposition='ESCALATED', reconcile_escalated_at=?,
               reconcile_escalation_code=?, reconcile_after=NULL
           WHERE id=? AND tenant_id=?`,
            [attempts, observedAt, observedAt, escalationCode, input.effectId, input.tenantId],
          );
          await client.query(
            `UPDATE commander_steps
           SET state='WAITING_FOR_HUMAN', version=version+1, updated_at=?
           WHERE id=? AND tenant_id=?`,
            [observedAt, effect.step_id, input.tenantId],
          );
          reconcileAfter = null;
          escalatedAt = observedAt;
          disposition = 'ESCALATED';
          eventType = 'effect.reconcile_escalated';
        }

        const sequence = await this.nextEffectEventSequence(client, input.effectId);
        const eventId = await this.appendReconcileEvent(client, {
          aggregateId: input.effectId,
          sequence,
          type: eventType,
          tenantId: input.tenantId,
          runId: String(effect.run_id),
          stepId: String(effect.step_id),
          actor: input.workerId,
          payload: { disposition, requestFingerprint },
        });
        const current = await client.query<{ state: KernelEffect['state'] }>(
          `SELECT state FROM commander_effects WHERE id=? AND tenant_id=?`,
          [input.effectId, input.tenantId],
        );
        const receipt = {
          effectId: input.effectId,
          requestFingerprint,
          effectState: current.rows[0]!.state,
          reconcileAttempts: attempts,
          reconcileAfter,
          reconcileEscalatedAt: escalatedAt,
          eventId,
        };
        const result: Extract<ReconcileMutationResult, { applied: true }> = {
          applied: true,
          replayed: false,
          disposition,
          receipt,
        };
        await client.query(
          `UPDATE commander_effects
         SET reconcile_claim_token=NULL, reconcile_claim_expires_at=NULL,
             reconcile_claimed_at=NULL, reconcile_claim_worker_id=NULL,
             reconcile_claim_worker_generation=NULL,
             reconcile_last_claim_token_hash=?, reconcile_last_claim_worker_id=?,
             reconcile_last_claim_worker_generation=?, reconcile_last_request_fingerprint=?,
             reconcile_last_result=?
         WHERE id=? AND tenant_id=?`,
          [
            claimTokenHash,
            input.workerId,
            input.workerGeneration,
            requestFingerprint,
            result,
            input.effectId,
            input.tenantId,
          ],
        );
        if (disposition === 'COMPLETED' || disposition === 'CONFIRMED_NOT_APPLIED') {
          await this.finishRunAfterReconcile(
            client,
            String(effect.run_id),
            input.tenantId,
            input.workerId,
            observedAt,
          );
        }
        return result;
      },
      [input.tenantId],
    );
  }

  private async nextEffectEventSequence(client: SqlClient, effectId: string): Promise<number> {
    const result = await client.query<{ sequence: number }>(
      `SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
       FROM commander_events WHERE aggregate_type='effect' AND aggregate_id=?`,
      [effectId],
    );
    return Number(result.rows[0]?.sequence ?? 1);
  }

  private async appendReconcileEvent(
    client: SqlClient,
    event: {
      aggregateId: string;
      sequence: number;
      type: string;
      tenantId: string;
      runId: string;
      stepId: string;
      actor: string;
      payload: Record<string, unknown>;
    },
  ): Promise<string> {
    const eventId = randomUUID();
    await client.query(
      `INSERT INTO commander_events
         (id,aggregate_type,aggregate_id,sequence,type,tenant_id,run_id,step_id,actor,schema_version,payload)
       VALUES (?,'effect',?,?,?,?,?,?,?,'v2',?)`,
      [
        eventId,
        event.aggregateId,
        event.sequence,
        event.type,
        event.tenantId,
        event.runId,
        event.stepId,
        event.actor,
        event.payload,
      ],
    );
    await client.query(
      `INSERT INTO commander_outbox (id,event_id,tenant_id,topic,key,payload)
       VALUES (?,?,?,?,?,?)`,
      [
        randomUUID(),
        eventId,
        event.tenantId,
        `commander.${event.type}`,
        event.runId,
        {
          ...event.payload,
          eventId,
          type: event.type,
          runId: event.runId,
          stepId: event.stepId,
          tenantId: event.tenantId,
        },
      ],
    );
    return eventId;
  }

  private async finishRunAfterReconcile(
    client: SqlClient,
    runId: string,
    tenantId: string,
    actor: string,
    observedAt: string,
  ): Promise<void> {
    const states = await client.query<{ state: string }>(
      `SELECT state FROM commander_steps WHERE run_id=? AND tenant_id=?`,
      [runId, tenantId],
    );
    const terminalState = states.rows.some(({ state }) => state === 'FAILED')
      ? 'FAILED'
      : states.rows.length > 0 &&
          states.rows.every(({ state }) => ['SUCCEEDED', 'SKIPPED'].includes(state))
        ? 'SUCCEEDED'
        : null;
    if (!terminalState) return;
    if (await this.hasUnreceiptedConsequentialEffect(client, runId, tenantId)) return;
    const updated = await client.query<{ version: number }>(
      `UPDATE commander_runs
       SET state=?, version=version+1, updated_at=?, terminal_at=?
       WHERE id=? AND tenant_id=? AND state NOT IN ('FAILED','SUCCEEDED')
       RETURNING version`,
      [terminalState, observedAt, observedAt, runId, tenantId],
    );
    if (!updated.rows[0]) return;
    await this.appendEvent(client, {
      aggregateType: 'run',
      aggregateId: runId,
      sequence: Number(updated.rows[0].version),
      type: terminalState === 'FAILED' ? 'run.failed' : 'run.succeeded',
      tenantId,
      runId,
      actor,
      payload: {},
    });
  }

  override async claimExpiredTimers(
    now: Date = new Date(),
    limit: number = 100,
  ): Promise<import('./types.js').KernelTimer[]> {
    const claimToken = randomUUID();
    const staleBefore = new Date(now.getTime() - 60_000).toISOString();
    return this.withTransaction(async (client) => {
      const candidates = await client.query<{ id: string }>(
        `SELECT id FROM commander_timers
         WHERE (state='PENDING' OR (state='PROCESSING' AND claimed_at <= ?)) AND fires_at <= ?
         ORDER BY fires_at LIMIT ?`,
        [staleBefore, now.toISOString(), limit],
      );
      if (candidates.rows.length === 0) return [];
      const ids = candidates.rows.map((r) => r.id);
      const placeholders = ids.map(() => '?').join(',');
      const result = await client.query<Record<string, unknown>>(
        `UPDATE commander_timers SET state='PROCESSING', claim_token=?, claimed_at=?
         WHERE id IN (${placeholders}) RETURNING *`,
        [claimToken, now.toISOString(), ...ids],
      );
      return result.rows.map((row) => ({
        id: reqString('commander_timers', row, 'id'),
        runId: reqString('commander_timers', row, 'run_id'),
        stepId: reqString('commander_timers', row, 'step_id'),
        tenantId: reqString('commander_timers', row, 'tenant_id'),
        firesAt: reqString('commander_timers', row, 'fires_at'),
        timerType: reqEnum('commander_timers', row, 'timer_type', TIMER_TYPES),
        state: reqEnum('commander_timers', row, 'state', TIMER_STATES),
        payload: reqJsonObject('commander_timers', row, 'payload'),
        createdAt: reqString('commander_timers', row, 'created_at'),
        firedAt: row.fired_at ? String(row.fired_at) : undefined,
        claimToken: row.claim_token as string | undefined,
      }));
    });
  }
}
