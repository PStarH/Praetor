import { createHash, createHmac } from 'node:crypto';
import { actionGatewayPolicySnapshot } from '@praetor/contracts';
import { canonicalBytes, sha256Hex, verifyEd25519 } from './canonical.js';
import {
  parseShadowObservation,
  parseShadowObservationBinding,
  ShadowContractError,
  type ShadowManifestV1,
  type ShadowObservationV1,
} from './contracts.js';
import { compareShadowDecision, type ShadowComparison } from './comparison.js';
import { evaluateShadowObservation, type ShadowEvaluation } from './evaluator.js';
import { SHADOW_SCHEMA_VERSION } from './schema.js';
import type { ShadowManifestTrust } from './report.js';
import type { Pool, PoolClient } from 'pg';

export interface ShadowSqlResult {
  rows: Record<string, unknown>[];
  rowCount: number | null;
}

export interface ShadowSqlClient {
  query(sql: string, values?: unknown[]): Promise<ShadowSqlResult>;
  release(): void;
}

export interface ShadowSqlPool {
  connect(): Promise<ShadowSqlClient>;
  query(sql: string, values?: unknown[]): Promise<ShadowSqlResult>;
}

function clientAdapter(client: PoolClient): ShadowSqlClient {
  return {
    async query(sql, values = []) {
      const result = await client.query(sql, values);
      return { rows: result.rows, rowCount: result.rowCount };
    },
    release() {
      client.release();
    },
  };
}

export function asShadowSqlPool(pool: Pool): ShadowSqlPool {
  return {
    async connect() {
      return clientAdapter(await pool.connect());
    },
    async query(sql, values = []) {
      const result = await pool.query(sql, values);
      return { rows: result.rows, rowCount: result.rowCount };
    },
  };
}

export interface ShadowRepositoryOptions {
  retentionDays: number;
  ingestionAttestationKey?: Buffer;
  trustedManifestPublicKeys: ReadonlyMap<string, ShadowManifestTrust>;
}

export interface ShadowImportResult {
  idempotent: boolean;
  evaluation: ShadowEvaluation;
  comparison: ShadowComparison;
}

export interface ShadowCampaignReportData {
  campaign: Record<string, unknown> | null;
  batches: Record<string, unknown>[];
  records: Record<string, unknown>[];
}

export type ShadowDatabaseOperation =
  | 'manifest-register'
  | 'import'
  | 'batch-close'
  | 'report-export'
  | 'campaign-withdraw'
  | 'retention-run'
  | 'status';

function operationPrivilegeSql(operation: ShadowDatabaseOperation): { role: string; sql: string } {
  switch (operation) {
    case 'manifest-register':
      return {
        role: 'commander_shadow_ingestion',
        sql: `has_table_privilege(current_user, 'commander_shadow.campaigns', 'SELECT')
          AND has_table_privilege(current_user, 'commander_shadow.batches', 'SELECT')
          AND has_function_privilege(current_user,
            'commander_shadow.register_manifest(text,text,text,text,text,text,text,text,timestamp with time zone,timestamp with time zone,text)',
            'EXECUTE')`,
      };
    case 'import':
      return {
        role: 'commander_shadow_ingestion',
        sql: `has_table_privilege(current_user, 'commander_shadow.campaigns', 'SELECT')
          AND has_table_privilege(current_user, 'commander_shadow.batches', 'SELECT')
          AND has_table_privilege(current_user, 'commander_shadow.expected_records', 'SELECT')
          AND has_table_privilege(current_user, 'commander_shadow.observations', 'SELECT')
          AND has_function_privilege(current_user,
            'commander_shadow.record_attempt(text,text,text,integer,text,text,text,text)', 'EXECUTE')
          AND has_function_privilege(current_user,
            'commander_shadow.record_observation(text,text,text,integer,text,text,text,text,text,text,text,text,text,text)',
            'EXECUTE')`,
      };
    case 'batch-close':
      return {
        role: 'commander_shadow_ingestion',
        sql: `has_table_privilege(current_user, 'commander_shadow.campaigns', 'SELECT')
          AND has_table_privilege(current_user, 'commander_shadow.batches', 'SELECT')
          AND has_function_privilege(current_user,
            'commander_shadow.close_batch(text,text,text)', 'EXECUTE')`,
      };
    case 'report-export':
      return {
        role: 'commander_shadow_reader',
        sql: `has_table_privilege(current_user, 'commander_shadow.campaigns', 'SELECT')
          AND has_table_privilege(current_user, 'commander_shadow.batches', 'SELECT')
          AND has_table_privilege(current_user, 'commander_shadow.expected_records', 'SELECT')
          AND has_table_privilege(current_user, 'commander_shadow.observations', 'SELECT')`,
      };
    case 'campaign-withdraw':
      return {
        role: 'commander_shadow_retention',
        sql: `has_table_privilege(current_user, 'commander_shadow.campaigns', 'SELECT')
          AND has_column_privilege(current_user, 'commander_shadow.campaigns', 'state', 'UPDATE')
          AND has_column_privilege(current_user, 'commander_shadow.campaigns', 'withdrawn_at', 'UPDATE')
          AND has_column_privilege(current_user, 'commander_shadow.campaigns', 'producer_id', 'UPDATE')
          AND has_column_privilege(current_user, 'commander_shadow.campaigns', 'policy_id', 'UPDATE')
          AND has_column_privilege(current_user, 'commander_shadow.campaigns', 'policy_digest', 'UPDATE')
          AND has_table_privilege(current_user, 'commander_shadow.batches', 'DELETE')
          AND has_table_privilege(current_user, 'commander_shadow.observations', 'DELETE')
          AND has_table_privilege(current_user, 'commander_shadow.deletion_audit', 'INSERT')`,
      };
    case 'retention-run':
      return {
        role: 'commander_shadow_retention',
        sql: `has_table_privilege(current_user, 'commander_shadow.campaigns', 'SELECT')
          AND has_table_privilege(current_user, 'commander_shadow.campaigns', 'DELETE')
          AND has_table_privilege(current_user, 'commander_shadow.deletion_audit', 'INSERT')
          AND has_table_privilege(current_user, 'commander_shadow.cleanup_state', 'SELECT')
          AND has_table_privilege(current_user, 'commander_shadow.cleanup_state', 'INSERT')
          AND has_column_privilege(current_user, 'commander_shadow.cleanup_state', 'last_completed_at', 'UPDATE')`,
      };
    case 'status':
      return { role: 'commander_shadow_ingestion', sql: 'TRUE' };
  }
}

async function transaction<T>(
  pool: ShadowSqlPool,
  tenantId: string,
  operation: (client: ShadowSqlClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let begun = false;
  try {
    await client.query('BEGIN');
    begun = true;
    await client.query("SELECT set_config('commander_shadow.tenant_id', $1, true)", [tenantId]);
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    if (begun)
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'SHADOW_TRANSACTION_ROLLBACK_FAILED');
      }
    throw error;
  } finally {
    client.release();
  }
}

function requireTenant(tenantId: string, recordTenantId?: string): void {
  if (!tenantId || (recordTenantId !== undefined && tenantId !== recordTenantId)) {
    throw new Error('SHADOW_TENANT_MISMATCH');
  }
}

function rowString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw new Error('SHADOW_DATABASE_ROW_INVALID');
  return value;
}

function campaignHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

// Shared advisory locks let the SELECT-only reader serialize with campaign writes.
// Every writer takes the same lock before row locks; hash collisions only add waiting.
async function lockCampaign(
  client: ShadowSqlClient,
  tenantId: string,
  campaignId: string,
  shared = false,
): Promise<void> {
  await client.query(
    `SELECT ${shared ? 'pg_advisory_xact_lock_shared' : 'pg_advisory_xact_lock'}(
       hashtextextended(json_build_array($1::text, $2::text)::text, 0)) AS tenant_id`,
    [tenantId, campaignId],
  );
}

export class ShadowRepository {
  constructor(
    private readonly pool: ShadowSqlPool,
    private readonly options: ShadowRepositoryOptions,
  ) {}

  private async attest(
    client: ShadowSqlClient,
    operation: 'register_manifest' | 'record_attempt' | 'record_observation',
    values: (string | number | null)[],
  ): Promise<string> {
    const key = this.options.ingestionAttestationKey;
    if (!key || key.length !== 32) throw new Error('SHADOW_INGESTION_ATTESTATION_KEY_REQUIRED');
    const result = await client.query('SELECT session_user AS ingestion_role');
    const role = result.rows[0] && rowString(result.rows[0], 'ingestion_role');
    if (!role) throw new Error('SHADOW_INGESTION_ROLE_REQUIRED');
    const hmac = createHmac('sha256', key);
    // Signed int32 byte lengths distinguish boundaries, UTF-8, empty strings and null.
    for (const value of ['commander.shadow-ingestion/v1', operation, role, ...values]) {
      const bytes = value === null ? null : Buffer.from(String(value), 'utf8');
      const length = Buffer.alloc(4);
      length.writeInt32BE(bytes?.length ?? -1);
      hmac.update(length);
      if (bytes) hmac.update(bytes);
    }
    return hmac.digest('hex');
  }

  async registerManifest(
    tenantId: string,
    manifest: ShadowManifestV1,
  ): Promise<{ idempotent: boolean }> {
    requireTenant(tenantId, manifest.tenantId);
    const trustedKey = this.options.trustedManifestPublicKeys.get(manifest.keyId);
    if (!trustedKey) throw new Error('SHADOW_MANIFEST_KEY_UNTRUSTED');
    if (trustedKey.status === 'revoked') throw new Error('SHADOW_MANIFEST_KEY_REVOKED');
    if (
      trustedKey.status !== 'active' ||
      trustedKey.algorithm !== 'Ed25519' ||
      trustedKey.keyId !== manifest.keyId ||
      trustedKey.publicKey.asymmetricKeyType !== 'ed25519'
    ) {
      throw new Error('SHADOW_MANIFEST_KEY_INVALID');
    }
    const { signature, ...signedBody } = manifest;
    if (!verifyEd25519(signedBody, signature, trustedKey.publicKey)) {
      throw new Error('SHADOW_MANIFEST_SIGNATURE_INVALID');
    }
    const snapshot = actionGatewayPolicySnapshot();
    if (
      manifest.policyId !== snapshot.policyId ||
      manifest.policyDigest !== snapshot.descriptorDigest
    ) {
      throw new Error('SHADOW_POLICY_MISMATCH');
    }
    const manifestDigest = sha256Hex(canonicalBytes(manifest));
    const retentionUntil = new Date(
      Date.parse(manifest.closesAt) + this.options.retentionDays * 24 * 60 * 60 * 1000,
    ).toISOString();

    return transaction(this.pool, tenantId, async (client) => {
      await lockCampaign(client, tenantId, manifest.campaignId);
      const values = [
        tenantId,
        manifest.campaignId,
        manifest.producerId,
        manifest.policyId,
        manifest.policyDigest,
        manifest.batchId,
        canonicalBytes(manifest).toString('utf8'),
        manifestDigest,
        manifest.closesAt,
        retentionUntil,
      ];
      const registered = await client.query(
        `SELECT commander_shadow.register_manifest(
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11
         ) AS idempotent`,
        [...values, await this.attest(client, 'register_manifest', values)],
      );
      return { idempotent: registered.rows[0]?.idempotent === true };
    });
  }

  async importObservation(tenantId: string, rawObservation: unknown): Promise<ShadowImportResult> {
    const observation = parseShadowObservationBinding(rawObservation);
    requireTenant(tenantId, observation.tenantId);
    const result = await transaction<ShadowImportResult | { error: string }>(
      this.pool,
      tenantId,
      async (client) => {
        await lockCampaign(client, tenantId, observation.campaignId);
        const campaignResult = await client.query(
          `SELECT producer_id, policy_id, policy_digest, state
           FROM commander_shadow.campaigns
          WHERE tenant_id=$1 AND campaign_id=$2`,
          [tenantId, observation.campaignId],
        );
        const campaign = campaignResult.rows[0];
        if (!campaign) throw new Error('SHADOW_CAMPAIGN_NOT_FOUND');
        if (campaign.state !== 'open') throw new Error('SHADOW_CAMPAIGN_CLOSED');
        if (campaign.producer_id !== observation.producerId)
          throw new Error('SHADOW_PRODUCER_MISMATCH');

        const expectedResult = await client.query(
          `SELECT e.digest, e.observation_id, e.status, b.closes_at,
                b.closes_at <= clock_timestamp() AS is_due, b.state AS batch_state
           FROM commander_shadow.expected_records e
          JOIN commander_shadow.batches b USING (tenant_id, campaign_id, batch_id)
          WHERE e.tenant_id=$1 AND e.campaign_id=$2 AND e.batch_id=$3 AND e.record_index=$4`,
          [tenantId, observation.campaignId, observation.batchId, observation.index],
        );
        const expected = expectedResult.rows[0];
        if (!expected) throw new Error('SHADOW_EXPECTED_RECORD_NOT_FOUND');
        if (expected.batch_state !== 'open' || expected.is_due !== false) {
          throw new Error('SHADOW_BATCH_CLOSED');
        }
        if (expected.observation_id !== observation.observationId)
          throw new Error('SHADOW_OBSERVATION_ID_MISMATCH');
        const digest = sha256Hex(canonicalBytes(rawObservation));

        const existing = await client.query(
          `SELECT digest, hypothetical_decision, hypothetical_decision_id,
                hypothetical_reason_code, comparison
           FROM commander_shadow.observations
          WHERE tenant_id=$1 AND campaign_id=$2 AND batch_id=$3 AND record_index=$4`,
          [tenantId, observation.campaignId, observation.batchId, observation.index],
        );
        if (existing.rows[0]) {
          if (existing.rows[0].digest !== digest) throw new Error('SHADOW_OBSERVATION_CONFLICT');
          return {
            idempotent: true,
            evaluation: {
              decision: rowString(
                existing.rows[0],
                'hypothetical_decision',
              ) as ShadowEvaluation['decision'],
              decisionId: rowString(existing.rows[0], 'hypothetical_decision_id'),
              reasonCode: rowString(existing.rows[0], 'hypothetical_reason_code'),
              policyId: actionGatewayPolicySnapshot().policyId,
              policyDigest: rowString(campaign, 'policy_digest'),
            },
            comparison: rowString(existing.rows[0], 'comparison') as ShadowComparison,
          };
        }
        const recordAttempt = async (status: 'rejected' | 'failed', code: string) => {
          const values = [
            tenantId,
            observation.campaignId,
            observation.batchId,
            observation.index,
            digest,
            code,
            status,
          ];
          await client.query(`SELECT commander_shadow.record_attempt($1,$2,$3,$4,$5,$6,$7,$8)`, [
            ...values,
            await this.attest(client, 'record_attempt', values),
          ]);
          return { error: code };
        };
        if (expected.digest !== digest) throw new Error('SHADOW_DIGEST_MISMATCH');
        let evaluation: ShadowEvaluation;
        let parsed: ShadowObservationV1;
        try {
          parsed = parseShadowObservation(rawObservation);
          evaluation = evaluateShadowObservation(parsed, {
            policyId: rowString(campaign, 'policy_id'),
            policyDigest: rowString(campaign, 'policy_digest'),
            expectedDigest: rowString(expected, 'digest'),
          });
        } catch (error) {
          if (error instanceof ShadowContractError) return recordAttempt('rejected', error.code);
          if (error instanceof Error && error.message === 'SHADOW_UNSUPPORTED_ACTION')
            return recordAttempt('rejected', 'SHADOW_UNSUPPORTED_ACTION');
          return recordAttempt('failed', 'SHADOW_EVALUATION_FAILED');
        }
        const comparison = compareShadowDecision(parsed.productionDecision, evaluation.decision);
        const values = [
          tenantId,
          observation.campaignId,
          observation.batchId,
          observation.index,
          observation.observationId,
          digest,
          canonicalBytes(parsed).toString('utf8'),
          evaluation.decision,
          evaluation.decisionId,
          evaluation.reasonCode,
          parsed.productionDecision,
          parsed.productionReasonCode ?? null,
          comparison,
        ];
        await client.query(
          `SELECT commander_shadow.record_observation(
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14
           )`,
          [...values, await this.attest(client, 'record_observation', values)],
        );
        return { idempotent: false, evaluation, comparison };
      },
    );
    if ('error' in result) throw new Error(result.error);
    return result;
  }

  async closeDueBatch(tenantId: string, campaignId: string, batchId: string): Promise<void> {
    requireTenant(tenantId);
    await transaction(this.pool, tenantId, async (client) => {
      await lockCampaign(client, tenantId, campaignId);
      const campaign = await client.query(
        `SELECT state FROM commander_shadow.campaigns
          WHERE tenant_id=$1 AND campaign_id=$2`,
        [tenantId, campaignId],
      );
      if (!campaign.rows[0] || campaign.rows[0].state !== 'open')
        throw new Error('SHADOW_CAMPAIGN_NOT_OPEN');
      const batch = await client.query(
        `SELECT state, closes_at, closes_at <= clock_timestamp() AS is_due FROM commander_shadow.batches
          WHERE tenant_id=$1 AND campaign_id=$2 AND batch_id=$3`,
        [tenantId, campaignId, batchId],
      );
      if (!batch.rows[0]) throw new Error('SHADOW_BATCH_NOT_FOUND');
      if (batch.rows[0].is_due !== true) throw new Error('SHADOW_BATCH_NOT_DUE');
      if (batch.rows[0].state === 'closed') return;
      await client.query(`SELECT commander_shadow.close_batch($1,$2,$3)`, [
        tenantId,
        campaignId,
        batchId,
      ]);
    });
  }

  async readReport(tenantId: string, campaignId: string): Promise<ShadowCampaignReportData> {
    requireTenant(tenantId);
    return transaction(this.pool, tenantId, async (client) => {
      await lockCampaign(client, tenantId, campaignId, true);
      const campaign = await client.query(
        `SELECT campaign_id, producer_id, policy_id, policy_digest, state, retention_until, created_at
         FROM commander_shadow.campaigns WHERE tenant_id=$1 AND campaign_id=$2`,
        [tenantId, campaignId],
      );
      const batches = await client.query(
        `SELECT batch_id, manifest, manifest_digest, closes_at, state, closed_at
         FROM commander_shadow.batches WHERE tenant_id=$1 AND campaign_id=$2 ORDER BY batch_id`,
        [tenantId, campaignId],
      );
      const records = await client.query(
        `SELECT e.batch_id, e.record_index, e.observation_id, e.digest, e.status,
              e.attempt_digest, e.attempt_code, e.attempted_at,
              o.canonical_observation, o.hypothetical_decision, o.hypothetical_reason_code,
              o.hypothetical_decision_id,
              o.production_decision, o.production_reason_code, o.comparison
         FROM commander_shadow.expected_records e
         LEFT JOIN commander_shadow.observations o
           USING (tenant_id, campaign_id, batch_id, record_index)
        WHERE e.tenant_id=$1 AND e.campaign_id=$2 ORDER BY e.batch_id, e.record_index`,
        [tenantId, campaignId],
      );
      return { campaign: campaign.rows[0] ?? null, batches: batches.rows, records: records.rows };
    });
  }

  async withdrawCampaign(tenantId: string, campaignId: string): Promise<void> {
    requireTenant(tenantId);
    await transaction(this.pool, tenantId, async (client) => {
      await lockCampaign(client, tenantId, campaignId);
      const campaign = await client.query(
        `SELECT state FROM commander_shadow.campaigns
          WHERE tenant_id=$1 AND campaign_id=$2 FOR UPDATE`,
        [tenantId, campaignId],
      );
      if (!campaign.rows[0]) throw new Error('SHADOW_CAMPAIGN_NOT_FOUND');
      if (campaign.rows[0].state === 'withdrawn') return;
      await client.query(
        `UPDATE commander_shadow.campaigns
            SET state='withdrawn', producer_id=NULL, policy_id=NULL, policy_digest=NULL,
                withdrawn_at=clock_timestamp()
          WHERE tenant_id=$1 AND campaign_id=$2`,
        [tenantId, campaignId],
      );
      await client.query(
        `DELETE FROM commander_shadow.observations WHERE tenant_id=$1 AND campaign_id=$2`,
        [tenantId, campaignId],
      );
      await client.query(
        `DELETE FROM commander_shadow.batches WHERE tenant_id=$1 AND campaign_id=$2`,
        [tenantId, campaignId],
      );
      await client.query(
        `INSERT INTO commander_shadow.deletion_audit
           (tenant_id_hash, campaign_id_hash, reason) VALUES ($1,$2,'withdrawal')`,
        [campaignHash(tenantId), campaignHash(campaignId)],
      );
    });
  }

  async runRetention(tenantId: string): Promise<number> {
    requireTenant(tenantId);
    return transaction(this.pool, tenantId, async (client) => {
      // Only withdrawn campaigns are deletable: an open campaign's shadow evidence
      // must survive its retention deadline until the customer withdraws it.
      const expired = await client.query(
        `SELECT campaign_id FROM commander_shadow.campaigns
          WHERE tenant_id=$1 AND retention_until <= clock_timestamp()
            AND state = 'withdrawn' ORDER BY campaign_id`,
        [tenantId],
      );
      let deleted = 0;
      for (const row of expired.rows) {
        const campaignId = rowString(row, 'campaign_id');
        await lockCampaign(client, tenantId, campaignId);
        const locked = await client.query(
          `SELECT campaign_id FROM commander_shadow.campaigns
            WHERE tenant_id=$1 AND campaign_id=$2 AND retention_until <= clock_timestamp()
              AND state = 'withdrawn' FOR UPDATE`,
          [tenantId, campaignId],
        );
        if (locked.rows.length === 0) continue;
        await client.query(
          `INSERT INTO commander_shadow.deletion_audit
             (tenant_id_hash, campaign_id_hash, reason) VALUES ($1,$2,'retention')`,
          [campaignHash(tenantId), campaignHash(campaignId)],
        );
        const removal = await client.query(
          `DELETE FROM commander_shadow.campaigns WHERE tenant_id=$1 AND campaign_id=$2`,
          [tenantId, campaignId],
        );
        deleted += removal.rowCount ?? 0;
      }
      await client.query(
        `INSERT INTO commander_shadow.cleanup_state (tenant_id, last_completed_at)
         VALUES ($1, clock_timestamp()) ON CONFLICT (tenant_id)
         DO UPDATE SET last_completed_at=EXCLUDED.last_completed_at`,
        [tenantId],
      );
      return deleted;
    });
  }

  async readiness(
    tenantId: string,
    cleanupFreshnessMinutes: number,
    operation: ShadowDatabaseOperation,
  ): Promise<{ ready: boolean; code: string }> {
    requireTenant(tenantId);
    const required = operationPrivilegeSql(operation);
    return transaction(this.pool, tenantId, async (client) => {
      const privileges = await client.query(
        `SELECT pg_has_role(current_user, $2, 'MEMBER')
                AND NOT EXISTS (
                  SELECT 1 FROM pg_roles privileged
                   WHERE pg_has_role(session_user, privileged.oid, 'MEMBER')
                     AND (privileged.rolsuper OR privileged.rolcreaterole OR privileged.rolcreatedb
                          OR privileged.rolreplication OR privileged.rolbypassrls)
                )
                AND NOT pg_has_role(session_user, n.nspowner, 'MEMBER')
                AND NOT EXISTS (
                  SELECT 1 FROM pg_class c WHERE c.relnamespace=n.oid
                    AND pg_has_role(session_user, c.relowner, 'MEMBER')
                )
                AND NOT pg_has_role(session_user, 'commander_shadow_installer', 'MEMBER')
                AS safe_runtime_role,
              commander_shadow.tenant_access_allowed($1) AS tenant_access,
              has_schema_privilege(current_user, 'commander_shadow', 'USAGE') AS schema_usage,
              has_schema_privilege(current_user, 'commander_shadow', 'CREATE') AS schema_create,
              has_table_privilege(current_user, 'commander_shadow.schema_version', 'SELECT') AS version_read,
              (${required.sql}) AS operation_privileges
         FROM pg_roles r
         JOIN pg_namespace n ON n.nspname='commander_shadow'
        WHERE r.rolname=current_user AND $1::text IS NOT NULL`,
        [tenantId, required.role],
      );
      const privilegeRow = privileges.rows[0];
      if (
        !privilegeRow ||
        privilegeRow.safe_runtime_role !== true ||
        privilegeRow.tenant_access !== true ||
        privilegeRow.schema_usage !== true ||
        privilegeRow.schema_create !== false ||
        privilegeRow.version_read !== true ||
        privilegeRow.operation_privileges !== true
      )
        return { ready: false, code: 'SHADOW_DATABASE_PRIVILEGES_INVALID' };
      const version = await client.query(
        `SELECT version FROM commander_shadow.schema_version WHERE version=$1`,
        [SHADOW_SCHEMA_VERSION],
      );
      if (version.rows.length !== 1) return { ready: false, code: 'SHADOW_SCHEMA_NOT_READY' };
      if (operation === 'retention-run') return { ready: true, code: 'SHADOW_READY' };
      const cleanup = await client.query(
        `SELECT last_completed_at FROM commander_shadow.cleanup_state
        WHERE tenant_id=$1
          AND last_completed_at >= clock_timestamp() - ($2 * interval '1 minute')`,
        [tenantId, cleanupFreshnessMinutes],
      );
      if (cleanup.rows.length !== 1) return { ready: false, code: 'SHADOW_CLEANUP_OVERDUE' };
      return { ready: true, code: 'SHADOW_READY' };
    });
  }
}
