import assert from 'node:assert/strict';
import { createHash, createHmac, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { Pool } from 'pg';
import { actionGatewayPolicySnapshot } from '@praetor/contracts';
import { canonicalBytes } from './canonical.js';
import {
  parseShadowManifest,
  parseShadowObservation,
  type ShadowObservationV1,
} from './contracts.js';
import { observationDigest } from './evaluator.js';
import { asShadowSqlPool, ShadowRepository, type ShadowSqlPool } from './repository.js';
import { SHADOW_SCHEMA_SQL } from './schema.js';

const adminUrl = process.env.COMMANDER_SHADOW_PG_ADMIN_URL;
const ingestionAttestationKey = randomBytes(32);
const otherAttestationKey = randomBytes(32);

function attest(
  operation: string,
  fields: (string | number | null)[],
  role = 'commander_shadow_tenant_live_ingestion',
): string {
  const hmac = createHmac('sha256', ingestionAttestationKey);
  for (const field of ['commander.shadow-ingestion/v1', operation, role, ...fields]) {
    const bytes = field === null ? null : Buffer.from(String(field), 'utf8');
    const length = Buffer.alloc(4);
    length.writeInt32BE(bytes?.length ?? -1);
    hmac.update(length);
    if (bytes) hmac.update(bytes);
  }
  return hmac.digest('hex');
}
if (process.env.CI && !adminUrl) throw new Error('COMMANDER_SHADOW_PG_ADMIN_URL_REQUIRED');

describe('shadow PostgreSQL authority', { skip: !adminUrl }, () => {
  const passwords = {
    installer: 'shadow_installer_test',
    ingestion: 'shadow_ingestion_test',
    reader: 'shadow_reader_test',
    retention: 'shadow_retention_test',
  };
  const keys = generateKeyPairSync('ed25519');
  const snapshot = actionGatewayPolicySnapshot();
  const now = Date.now();
  let admin: Pool;
  let installer: Pool;
  let ingestion: Pool;
  let reader: Pool;
  let retention: Pool;
  let otherIngestion: Pool;

  function roleUrl(role: keyof typeof passwords): string {
    const url = new URL(adminUrl!);
    url.username =
      role === 'installer' ? 'commander_shadow_installer' : `commander_shadow_tenant_live_${role}`;
    url.password = passwords[role];
    return url.toString();
  }

  function repo(pool: Pool): ShadowRepository {
    return new ShadowRepository(asShadowSqlPool(pool), {
      ingestionAttestationKey:
        pool === otherIngestion ? otherAttestationKey : ingestionAttestationKey,
      retentionDays: 1,
      trustedManifestPublicKeys: new Map([
        [
          'manifest-key-1',
          {
            algorithm: 'Ed25519',
            keyId: 'manifest-key-1',
            status: 'active',
            publicKey: keys.publicKey,
          },
        ],
      ]),
    });
  }

  function observation(
    campaignId: string,
    batchId: string,
    index: number,
    overrides: Record<string, unknown> = {},
  ): ShadowObservationV1 {
    return parseShadowObservation({
      schema: 'commander.shadow-observation/v1',
      campaignId,
      tenantId: 'tenant-live',
      producerId: 'producer-live',
      batchId,
      index,
      observationId: `${campaignId}-observation-${index}`,
      occurredAt: new Date(now).toISOString(),
      workflow: 'kubernetes.deployment.rollback',
      effectType: 'connector.kubernetes.deployment.rollback',
      tool: 'kubernetes.deployment.rollback',
      destination: 'k8s://cluster/namespace/deployments/api',
      productionDecision: 'require_approval',
      productionReasonCode: 'REGISTERED_ADAPTER_POLICY',
      ...overrides,
    });
  }

  function manifest(
    campaignId: string,
    batchId: string,
    observations: ShadowObservationV1[],
    closesAt: string,
  ) {
    const unsigned = {
      schema: 'commander.shadow-manifest/v1',
      campaignId,
      tenantId: observations[0]!.tenantId,
      producerId: 'producer-live',
      policyId: snapshot.policyId,
      policyDigest: snapshot.descriptorDigest,
      batchId,
      closesAt,
      records: observations.map((record) => ({
        index: record.index,
        observationId: record.observationId,
        digest: observationDigest(record),
      })),
      keyId: 'manifest-key-1',
    };
    return parseShadowManifest({
      ...unsigned,
      signature: sign(null, canonicalBytes(unsigned), keys.privateKey).toString('base64url'),
    });
  }

  // The roles this suite creates, and a cleanup that removes them completely.
  //
  // Teardown used to be a flat list of statements in one query, which made the
  // whole run single-shot: PostgreSQL runs such a batch in one implicit
  // transaction, so a single failing DROP ROLE rolled back every other DROP and
  // left the roles behind. The next run then failed immediately with
  // `role "commander_shadow_installer" already exists`, and the pilot's own
  // acceptance gate could not be run twice against the same database -- only
  // against a fresh CI container. `DROP OWNED BY` is required before `DROP ROLE`
  // because it also revokes the database-level CONNECT/CREATE grants (that is
  // what a role's ACL entries need), and the whole thing is guarded so it is safe
  // to run when nothing exists yet.
  const shadowRoles = [
    'commander_shadow_tenant_live_ingestion',
    'commander_shadow_tenant_live_reader',
    'commander_shadow_tenant_live_retention',
    'commander_shadow_tenant_other_ingestion',
    'commander_shadow_ingestion',
    'commander_shadow_reader',
    'commander_shadow_retention',
    'commander_shadow_installer',
  ];

  async function removeShadowState(): Promise<void> {
    await admin.query(`
      DROP SCHEMA IF EXISTS commander_shadow CASCADE;
      DROP SCHEMA IF EXISTS shadow_other CASCADE;
    `);
    // One DO block, not one statement per role: a DO body cannot take bind
    // parameters (a bare $1 is parsed as a dollar-quote), so the fixed role list
    // is inlined as an array literal and iterated inside PL/pgSQL. The whole
    // cleanup is a single statement, so it cannot partially apply.
    await admin.query(`
      DO $cleanup$
      DECLARE r text;
      BEGIN
        FOREACH r IN ARRAY ARRAY[${shadowRoles.map((role) => `'${role}'`).join(', ')}]::text[] LOOP
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
            EXECUTE format('DROP OWNED BY %I CASCADE', r);
            EXECUTE format('DROP ROLE %I', r);
          END IF;
        END LOOP;
      END
      $cleanup$;
    `);
  }

  before(async () => {
    admin = new Pool({ connectionString: adminUrl, max: 2 });
    // Idempotent: a previous interrupted run must not poison this one.
    await removeShadowState();
    await admin.query(`
      CREATE ROLE commander_shadow_installer LOGIN PASSWORD '${passwords.installer}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
      CREATE ROLE commander_shadow_ingestion NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
      CREATE ROLE commander_shadow_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
      CREATE ROLE commander_shadow_retention NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
      CREATE ROLE commander_shadow_tenant_live_ingestion LOGIN PASSWORD '${passwords.ingestion}' NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS IN ROLE commander_shadow_ingestion;
      CREATE ROLE commander_shadow_tenant_live_reader LOGIN PASSWORD '${passwords.reader}' NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS IN ROLE commander_shadow_reader;
      CREATE ROLE commander_shadow_tenant_live_retention LOGIN PASSWORD '${passwords.retention}' NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS IN ROLE commander_shadow_retention;
      CREATE ROLE commander_shadow_tenant_other_ingestion LOGIN PASSWORD '${passwords.ingestion}' NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS IN ROLE commander_shadow_ingestion;
      -- The database name must not be hard-coded: this suite is the pilot's own
      -- acceptance gate, and it had only ever run against a database literally
      -- named "commander" (the CI service POSTGRES_DB). Against any other name --
      -- including the "shadow_database" the pilot guide tells the customer DBA to
      -- create -- the GRANT targeted a different database and the installer failed
      -- with "permission denied for database". CONNECT is granted explicitly
      -- because a hardened database revokes it from PUBLIC, which is exactly what
      -- this repository's own development database does.
      DO $$
      BEGIN
        EXECUTE format(
          'GRANT CONNECT ON DATABASE %I TO commander_shadow_installer, commander_shadow_ingestion, commander_shadow_reader, commander_shadow_retention, commander_shadow_tenant_live_ingestion, commander_shadow_tenant_live_reader, commander_shadow_tenant_live_retention, commander_shadow_tenant_other_ingestion',
          current_database()
        );
        EXECUTE format('GRANT CREATE ON DATABASE %I TO commander_shadow_installer', current_database());
      END
      $$;
      CREATE SCHEMA shadow_other;
      CREATE TABLE shadow_other.secret (value text);
      INSERT INTO shadow_other.secret VALUES ('not-visible');
    `);
    installer = new Pool({ connectionString: roleUrl('installer'), max: 1 });
    await installer.query(SHADOW_SCHEMA_SQL);
    await installer.query(
      `INSERT INTO commander_shadow.tenant_role_bindings (role_name, tenant_id)
       VALUES
         ('commander_shadow_tenant_live_ingestion', 'tenant-live'),
         ('commander_shadow_tenant_live_reader', 'tenant-live'),
         ('commander_shadow_tenant_live_retention', 'tenant-live'),
         ('commander_shadow_tenant_other_ingestion', 'tenant-other')`,
    );
    await installer.query(
      `INSERT INTO commander_shadow.ingestion_attestation_keys (role_name, key_bytes)
       VALUES ('commander_shadow_tenant_live_ingestion', $1),
              ('commander_shadow_tenant_other_ingestion', $2)`,
      [ingestionAttestationKey, otherAttestationKey],
    );
    ingestion = new Pool({ connectionString: roleUrl('ingestion'), max: 3 });
    reader = new Pool({ connectionString: roleUrl('reader'), max: 2 });
    retention = new Pool({ connectionString: roleUrl('retention'), max: 3 });
    const otherUrl = new URL(roleUrl('ingestion'));
    otherUrl.username = 'commander_shadow_tenant_other_ingestion';
    otherIngestion = new Pool({ connectionString: otherUrl.toString(), max: 1 });
  });

  after(async () => {
    await Promise.all([
      ingestion?.end(),
      reader?.end(),
      retention?.end(),
      installer?.end(),
      otherIngestion?.end(),
    ]);
    if (admin) {
      // No cluster-level residue: the previous flat batch could roll back and
      // leave roles behind, and it also hard-coded the database name in its
      // REVOKE. See removeShadowState().
      await removeShadowState();
      await admin.end();
    }
  });

  it('denies runtime DDL, role management, cross-schema reads, and cross-role writes', async () => {
    await assert.rejects(
      ingestion.query('CREATE TABLE commander_shadow.forbidden (id integer)'),
      /permission denied/i,
    );
    await assert.rejects(ingestion.query('CREATE ROLE shadow_forbidden'), /permission denied/i);
    await assert.rejects(
      ingestion.query('SELECT * FROM shadow_other.secret'),
      /permission denied/i,
    );
    await assert.rejects(
      reader.query(
        "INSERT INTO commander_shadow.campaigns VALUES ('t','c','p','x','d','open',clock_timestamp(),clock_timestamp(),NULL)",
      ),
      /permission denied/i,
    );
    await assert.rejects(
      retention.query('CREATE TABLE commander_shadow.forbidden_retention (id integer)'),
      /permission denied/i,
    );
    await assert.rejects(
      ingestion.query(
        "INSERT INTO commander_shadow.cleanup_state VALUES ('tenant-live',clock_timestamp())",
      ),
      /permission denied/i,
    );
    await assert.rejects(
      ingestion.query(
        'UPDATE commander_shadow.cleanup_state SET last_completed_at=clock_timestamp()',
      ),
      /permission denied/i,
    );
    await assert.rejects(
      ingestion.query(
        "UPDATE commander_shadow.campaigns SET policy_digest='tampered' WHERE tenant_id='tenant-live'",
      ),
      /permission denied/i,
    );
    await assert.rejects(
      ingestion.query(
        "UPDATE commander_shadow.observations SET hypothetical_decision='allow' WHERE tenant_id='tenant-live'",
      ),
      /permission denied/i,
    );
    await assert.rejects(
      ingestion.query(
        "UPDATE commander_shadow.expected_records SET status='missing', attempt_digest=NULL, attempt_code=NULL, attempted_at=NULL WHERE tenant_id='tenant-live'",
      ),
      /permission denied/i,
    );
    await assert.rejects(
      ingestion.query(
        "UPDATE commander_shadow.batches SET state='closed', closed_at=clock_timestamp() WHERE tenant_id='tenant-live'",
      ),
      /permission denied/i,
    );
    await assert.rejects(
      ingestion.query("DELETE FROM commander_shadow.observations WHERE tenant_id='tenant-live'"),
      /permission denied/i,
    );
    await assert.rejects(
      retention.query(
        "UPDATE commander_shadow.batches SET manifest='{}'::jsonb WHERE tenant_id='tenant-live'",
      ),
      /permission denied/i,
    );
  });

  it('persists registration and import across a fresh pool, supports identical retry, and rejects conflict', async () => {
    const input = observation('campaign-persist', 'batch-persist', 0);
    await repo(ingestion).registerManifest(
      'tenant-live',
      manifest('campaign-persist', 'batch-persist', [input], new Date(now + 60_000).toISOString()),
    );
    assert.deepEqual(await repo(reader).readiness('tenant-live', 120, 'report-export'), {
      ready: false,
      code: 'SHADOW_CLEANUP_OVERDUE',
    });
    const first = await repo(ingestion).importObservation('tenant-live', input);
    assert.equal(first.idempotent, false);
    await ingestion.end();
    ingestion = new Pool({ connectionString: roleUrl('ingestion'), max: 3 });
    const retry = await repo(ingestion).importObservation('tenant-live', input);
    assert.equal(retry.idempotent, true);
    assert.equal(retry.evaluation.decisionId, first.evaluation.decisionId);
    await assert.rejects(
      repo(ingestion).importObservation('tenant-live', { ...input, productionDecision: 'deny' }),
      /SHADOW_OBSERVATION_CONFLICT/,
    );
    assert.equal(
      (await repo(reader).readReport('tenant-live', 'campaign-persist')).records.length,
      1,
    );
  });

  it('rejects database-credential-only forgery and attestation rebinding before evidence changes', async () => {
    const input = observation('campaign-attested', 'batch-attested', 0);
    const declared = manifest(
      'campaign-attested',
      'batch-attested',
      [input],
      new Date(now + 60_000).toISOString(),
    );
    const manifestText = canonicalBytes(declared).toString('utf8');
    const manifestFields = [
      'tenant-live',
      declared.campaignId,
      declared.producerId,
      declared.policyId,
      declared.policyDigest,
      declared.batchId,
      manifestText,
      createHash('sha256').update(manifestText).digest('hex'),
      declared.closesAt,
      new Date(Date.parse(declared.closesAt) + 86_400_000).toISOString(),
    ];
    const attemptFields = [
      'tenant-live',
      declared.campaignId,
      declared.batchId,
      0,
      observationDigest(input),
      'SHADOW_SENSITIVE_DATA',
      'rejected',
    ];
    const observationFields = [
      'tenant-live',
      declared.campaignId,
      declared.batchId,
      0,
      input.observationId,
      observationDigest(input),
      canonicalBytes(input).toString('utf8'),
      'allow',
      'forged-id',
      'FORGED_REASON',
      input.productionDecision,
      input.productionReasonCode ?? null,
      'match',
    ];
    const call = async (
      operation: string,
      fields: (string | number | null)[],
      proof: string | null,
    ) => {
      const client = await ingestion.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('commander_shadow.tenant_id', 'tenant-live', true)");
        const values = [...fields, proof];
        await client.query(
          `SELECT commander_shadow.${operation}(${values.map((_, index) => `$${index + 1}`).join(',')})`,
          values,
        );
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    };
    for (const operation of ['register_manifest', 'record_attempt', 'record_observation']) {
      const fields =
        operation === 'register_manifest'
          ? manifestFields
          : operation === 'record_attempt'
            ? attemptFields
            : observationFields;
      for (const proof of [
        null,
        '',
        '00'.repeat(32),
        attest(operation, fields, 'different_ingestion_login'),
        attest('different_operation', fields),
      ]) {
        await assert.rejects(
          call(operation, fields, proof),
          /SHADOW_INGESTION_ATTESTATION_INVALID/,
        );
      }
      const proof = attest(operation, fields);
      for (let index = 0; index < fields.length; index++) {
        const changed = [...fields];
        changed[index] =
          typeof fields[index] === 'number'
            ? 1
            : operation === 'register_manifest' && index >= 8
              ? new Date(now + 120_000).toISOString()
              : `${fields[index] ?? ''}-changed`;
        await assert.rejects(
          call(operation, changed, proof),
          /SHADOW_INGESTION_ATTESTATION_INVALID/,
        );
      }
    }
    assert.equal(
      (await repo(reader).readReport('tenant-live', declared.campaignId)).campaign,
      null,
    );
    await repo(ingestion).registerManifest('tenant-live', declared);
    await assert.rejects(
      call('record_attempt', attemptFields, null),
      /SHADOW_INGESTION_ATTESTATION_INVALID/,
    );
    assert.equal(
      (await repo(reader).readReport('tenant-live', declared.campaignId)).records[0]?.status,
      'pending',
    );
    await repo(ingestion).importObservation('tenant-live', input);
    assert.equal(
      (await repo(reader).readReport('tenant-live', declared.campaignId)).records[0]?.status,
      'compared',
    );
    for (const pool of [ingestion, reader, retention]) {
      await assert.rejects(
        pool.query('SELECT key_bytes FROM commander_shadow.ingestion_attestation_keys'),
        /permission denied/,
      );
      await assert.rejects(
        pool.query(
          "SELECT commander_shadow.verify_ingestion_attestation('record_attempt', ARRAY['tenant-live'], NULL)",
        ),
        /permission denied/,
      );
    }
    await assert.rejects(
      ingestion.query(
        "SELECT commander_shadow.record_attempt('tenant-live','campaign-attested','batch-attested',0,$1,'FORGED','rejected')",
        [observationDigest(input)],
      ),
      /does not exist/,
    );
  });

  it('fails closed when the transaction tenant is absent or differs from the login binding', async () => {
    const other = observation('campaign-other', 'batch-other', 0, { tenantId: 'tenant-other' });
    await repo(otherIngestion).registerManifest(
      'tenant-other',
      manifest('campaign-other', 'batch-other', [other], new Date(now + 60_000).toISOString()),
    );
    await repo(otherIngestion).importObservation('tenant-other', other);
    assert.equal(
      (await repo(otherIngestion).readReport('tenant-other', 'campaign-other')).records.length,
      1,
    );
    assert.equal((await repo(reader).readReport('tenant-other', 'campaign-other')).campaign, null);
    const unbound = await reader.query(
      "SELECT count(*)::int AS count FROM commander_shadow.campaigns WHERE tenant_id='tenant-live'",
    );
    assert.equal(unbound.rows[0]?.count, 0);
    assert.equal(
      (await repo(reader).readReport('tenant-other', 'campaign-persist')).campaign,
      null,
    );

    const client = await ingestion.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('commander_shadow.tenant_id', 'tenant-other', true)");
      const hidden = await client.query(
        "SELECT count(*)::int AS count FROM commander_shadow.campaigns WHERE tenant_id='tenant-live'",
      );
      assert.equal(hidden.rows[0]?.count, 0);
      await assert.rejects(
        client.query(
          "SELECT commander_shadow.record_attempt('tenant-live','campaign-persist','batch-persist',0,$1,'FORGED','rejected',NULL)",
          [observationDigest(observation('campaign-persist', 'batch-persist', 0))],
        ),
        /SHADOW_INGESTION_ATTESTATION_INVALID/,
      );
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('denies cross-tenant mutation and audit forgery even with a spoofed tenant setting', async () => {
    for (const binding of ['tenant-live', 'tenant-other']) {
      const client = await retention.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('commander_shadow.tenant_id', $1, true)", [binding]);
        const updated = await client.query(
          "UPDATE commander_shadow.campaigns SET state='withdrawn' WHERE tenant_id='tenant-other'",
        );
        assert.equal(updated.rowCount, 0);
        const deleted = await client.query(
          "DELETE FROM commander_shadow.campaigns WHERE tenant_id='tenant-other'",
        );
        assert.equal(deleted.rowCount, 0);
        await assert.rejects(
          client.query(
            "INSERT INTO commander_shadow.deletion_audit (tenant_id_hash,campaign_id_hash,reason) VALUES ($1,$2,'withdrawal')",
            [
              createHash('sha256').update('tenant-other').digest('hex'),
              createHash('sha256').update('campaign-other').digest('hex'),
            ],
          ),
          /row-level security/i,
        );
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    }
    assert.equal(
      (await repo(otherIngestion).readReport('tenant-other', 'campaign-other')).records.length,
      1,
    );
  });

  it('rejects installer readiness and permits only operation-appropriate tenant roles', async () => {
    assert.equal(
      (await repo(installer).readiness('tenant-live', 120, 'manifest-register')).ready,
      false,
    );
    assert.equal(
      (await repo(reader).readiness('tenant-live', 120, 'manifest-register')).ready,
      false,
    );
    assert.equal(
      (await repo(retention).readiness('tenant-live', 120, 'retention-run')).ready,
      true,
    );
  });

  it('closes declared batches with complete terminal count reconciliation, including wholly missing batches', async () => {
    const first = observation('campaign-close', 'batch-partial', 0);
    const second = observation('campaign-close', 'batch-partial', 1);
    const closesAt = new Date(now + 60_000).toISOString();
    await repo(ingestion).registerManifest(
      'tenant-live',
      manifest('campaign-close', 'batch-partial', [first, second], closesAt),
    );
    await repo(ingestion).importObservation('tenant-live', first);
    await assert.rejects(
      repo(ingestion).closeDueBatch('tenant-live', 'campaign-close', 'batch-partial'),
      /SHADOW_BATCH_NOT_DUE/,
    );
    await admin.query(
      "UPDATE commander_shadow.batches SET closes_at=clock_timestamp()-interval '1 second' WHERE campaign_id='campaign-close'",
    );
    await repo(ingestion).closeDueBatch('tenant-live', 'campaign-close', 'batch-partial');
    const partial = await repo(reader).readReport('tenant-live', 'campaign-close');
    assert.deepEqual(
      partial.records.map((row) => row.status),
      ['compared', 'missing'],
    );

    const missing = [
      observation('campaign-missing', 'batch-missing', 0),
      observation('campaign-missing', 'batch-missing', 1),
    ];
    await repo(ingestion).registerManifest(
      'tenant-live',
      manifest('campaign-missing', 'batch-missing', missing, new Date(now - 60_000).toISOString()),
    );
    await assert.rejects(
      repo(ingestion).importObservation('tenant-live', missing[0]!),
      /SHADOW_BATCH_CLOSED/,
    );
    await repo(ingestion).closeDueBatch('tenant-live', 'campaign-missing', 'batch-missing');
    const absent = await repo(reader).readReport('tenant-live', 'campaign-missing');
    assert.deepEqual(
      absent.records.map((row) => row.status),
      ['missing', 'missing'],
    );
    assert.equal(absent.records.length, 2);
    await assert.rejects(
      repo(ingestion).importObservation('tenant-live', missing[0]!),
      /SHADOW_BATCH_CLOSED/,
    );
  });

  it('records rejected and failed arrivals, replaces attempts on retry, and preserves terminal counts at close', async () => {
    const inputs = [0, 1, 2, 3].map((index) =>
      observation('campaign-attempts', 'batch-attempts', index),
    );
    inputs.push({
      ...observation('campaign-attempts', 'batch-attempts', 4),
      destination: 'operator@example.com',
    });
    await repo(ingestion).registerManifest(
      'tenant-live',
      manifest('campaign-attempts', 'batch-attempts', inputs, new Date(now + 60_000).toISOString()),
    );
    await assert.rejects(
      repo(ingestion).importObservation('tenant-live', {
        ...inputs[0]!,
        productionDecision: 'deny',
      }),
      /SHADOW_DIGEST_MISMATCH/,
    );
    await assert.rejects(
      repo(ingestion).importObservation('tenant-live', {
        ...inputs[1]!,
        productionDecision: 'deny',
      }),
      /SHADOW_DIGEST_MISMATCH/,
    );
    await repo(ingestion).importObservation('tenant-live', inputs[1]!);
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(
        repo(ingestion).importObservation('tenant-live', inputs[4]!),
        /SHADOW_SENSITIVE_DATA/,
      );
    }
    const tamper = await ingestion.connect();
    try {
      await tamper.query('BEGIN');
      await tamper.query("SELECT set_config('commander_shadow.tenant_id', 'tenant-live', true)");
      await assert.rejects(
        tamper.query(
          "SELECT commander_shadow.record_attempt('tenant-live','campaign-attempts','batch-attempts',4,$1,'SHADOW_EVALUATION_FAILED','failed',$2)",
          [
            observationDigest(inputs[4]!),
            attest('record_attempt', [
              'tenant-live',
              'campaign-attempts',
              'batch-attempts',
              4,
              observationDigest(inputs[4]!),
              'SHADOW_EVALUATION_FAILED',
              'failed',
            ]),
          ],
        ),
        /SHADOW_ATTEMPT_NOT_WRITABLE/,
      );
    } finally {
      await tamper.query('ROLLBACK');
      tamper.release();
    }
    await assert.rejects(
      ingestion.query(
        "SELECT commander_shadow.close_batch(NULL,'campaign-attempts','batch-attempts')",
      ),
      /SHADOW_TENANT_NOT_BOUND/,
    );
    await admin.query(
      "UPDATE commander_shadow.campaigns SET policy_digest='broken-test-pin' WHERE campaign_id='campaign-attempts'",
    );
    await assert.rejects(
      repo(ingestion).importObservation('tenant-live', inputs[2]!),
      /SHADOW_EVALUATION_FAILED/,
    );
    await admin.query(
      "UPDATE commander_shadow.campaigns SET policy_digest=$1 WHERE campaign_id='campaign-attempts'",
      [snapshot.descriptorDigest],
    );
    await admin.query(
      "UPDATE commander_shadow.batches SET closes_at=clock_timestamp()-interval '1 second' WHERE campaign_id='campaign-attempts'",
    );
    await repo(ingestion).closeDueBatch('tenant-live', 'campaign-attempts', 'batch-attempts');
    const report = await repo(reader).readReport('tenant-live', 'campaign-attempts');
    assert.deepEqual(
      report.records.map((record) => record.status),
      ['missing', 'compared', 'failed', 'missing', 'rejected'],
    );
    assert.equal(report.records[0]?.attempt_code, null);
    assert.equal(report.records[0]?.canonical_observation, null);
    assert.equal(report.records[1]?.attempt_code, null);
    assert.equal(report.records[2]?.attempt_code, 'SHADOW_EVALUATION_FAILED');
    assert.equal(report.records[4]?.attempt_code, 'SHADOW_SENSITIVE_DATA');
    assert.equal(report.records[4]?.canonical_observation, null);
  });

  it('returns one complete report snapshot while a concurrent withdrawal waits', async () => {
    const input = observation('campaign-report-race', 'batch-report-race', 0);
    await repo(ingestion).registerManifest(
      'tenant-live',
      manifest(
        'campaign-report-race',
        'batch-report-race',
        [input],
        new Date(now + 60_000).toISOString(),
      ),
    );
    await repo(ingestion).importObservation('tenant-live', input);
    let releaseRead: () => void = () => {};
    let reachedRead: () => void = () => {};
    const readHeld = new Promise<void>((resolve) => {
      reachedRead = resolve;
    });
    const resumeRead = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const readerAdapter = asShadowSqlPool(reader);
    const heldReader: ShadowSqlPool = {
      query: (sql, values) => readerAdapter.query(sql, values),
      async connect() {
        const client = await readerAdapter.connect();
        return {
          release: () => client.release(),
          async query(sql, values) {
            const result = await client.query(sql, values);
            if (/FROM commander_shadow.campaigns/.test(sql)) {
              reachedRead();
              await resumeRead;
            }
            return result;
          },
        };
      },
    };
    const reportPromise = new ShadowRepository(heldReader, {
      retentionDays: 1,
      trustedManifestPublicKeys: new Map(),
    }).readReport('tenant-live', 'campaign-report-race');
    await readHeld;
    const withdrawal = repo(retention).withdrawCampaign('tenant-live', 'campaign-report-race');
    try {
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const result = await admin.query(
          "SELECT count(*)::int AS count FROM pg_stat_activity WHERE usename='commander_shadow_tenant_live_retention' AND wait_event='advisory' AND cardinality(pg_blocking_pids(pid))>0",
        );
        if (result.rows[0]?.count > 0) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(blocked, true, 'withdrawal must wait for the report transaction');
    } finally {
      releaseRead();
    }
    const report = await reportPromise;
    await withdrawal;
    assert.equal(report.campaign?.state, 'open');
    assert.equal(report.batches.length, 1);
    assert.equal(report.records.length, 1);
    const after = await repo(reader).readReport('tenant-live', 'campaign-report-race');
    assert.equal(after.campaign?.state, 'withdrawn');
    assert.equal(after.records.length, 0);
  });

  it('serializes concurrent withdrawal and import so no observation survives withdrawal', async () => {
    const input = observation('campaign-withdraw', 'batch-withdraw', 0);
    await repo(ingestion).registerManifest(
      'tenant-live',
      manifest(
        'campaign-withdraw',
        'batch-withdraw',
        [input],
        new Date(now + 60_000).toISOString(),
      ),
    );
    await Promise.allSettled([
      repo(ingestion).importObservation('tenant-live', input),
      repo(retention).withdrawCampaign('tenant-live', 'campaign-withdraw'),
    ]);
    const report = await repo(reader).readReport('tenant-live', 'campaign-withdraw');
    assert.equal(report.campaign?.state, 'withdrawn');
    assert.equal(report.records.length, 0);
  });

  it('keeps expired open campaigns and deletes them after withdrawal', async () => {
    const input = observation('campaign-expire', 'batch-expire', 0);
    await repo(ingestion).registerManifest(
      'tenant-live',
      manifest('campaign-expire', 'batch-expire', [input], new Date(now + 60_000).toISOString()),
    );
    await admin.query(
      "UPDATE commander_shadow.campaigns SET retention_until=clock_timestamp()-interval '1 minute' WHERE tenant_id='tenant-live' AND campaign_id='campaign-expire'",
    );
    assert.equal(await repo(retention).runRetention('tenant-live'), 0);
    assert.equal(
      (await repo(reader).readReport('tenant-live', 'campaign-expire')).campaign?.state,
      'open',
    );
    await repo(retention).withdrawCampaign('tenant-live', 'campaign-expire');
    assert.equal(await repo(retention).runRetention('tenant-live'), 1);
    assert.equal((await repo(reader).readReport('tenant-live', 'campaign-expire')).campaign, null);
    assert.equal((await repo(reader).readiness('tenant-live', 120, 'report-export')).ready, true);
  });

  it('accounts for the exact rows deleted when two retention workers race', async () => {
    const campaignIds = ['campaign-expire-a', 'campaign-expire-b', 'campaign-expire-c'];
    for (const [position, campaignId] of campaignIds.entries()) {
      const input = observation(campaignId, `batch-expire-${position}`, 0);
      await repo(ingestion).registerManifest(
        'tenant-live',
        manifest(
          campaignId,
          `batch-expire-${position}`,
          [input],
          new Date(now + 60_000).toISOString(),
        ),
      );
      // Retention only removes withdrawn campaigns, so withdraw before the race
      // makes the workers contend over rows that are actually deletable.
      await repo(retention).withdrawCampaign('tenant-live', campaignId);
    }
    await admin.query(
      `UPDATE commander_shadow.campaigns SET retention_until=clock_timestamp()-interval '1 minute'
        WHERE tenant_id='tenant-live' AND campaign_id = ANY($1::text[])`,
      [campaignIds],
    );

    // Hold the first campaign's advisory lock so both workers finish their
    // candidate scan and then queue behind that same lock. That makes the race
    // deterministic: without row-accurate accounting each worker reports the
    // full candidate list even though only one of them deletes it.
    const holder = await admin.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(
        'SELECT pg_advisory_xact_lock(hashtextextended(json_build_array($1::text,$2::text)::text,0))',
        ['tenant-live', campaignIds[0]],
      );
      const workers = [
        repo(retention).runRetention('tenant-live'),
        repo(retention).runRetention('tenant-live'),
      ];
      let blocked = 0;
      for (let attempt = 0; attempt < 200 && blocked < 2; attempt++) {
        const result = await admin.query(
          `SELECT count(*)::int AS count FROM pg_stat_activity
            WHERE usename='commander_shadow_tenant_live_retention'
              AND wait_event='advisory' AND cardinality(pg_blocking_pids(pid))>0`,
        );
        blocked = result.rows[0]?.count ?? 0;
        if (blocked < 2) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(blocked, 2, 'both retention workers must queue behind the held lock');
      await holder.query('ROLLBACK');
      const counts = await Promise.all(workers);
      const remaining = await admin.query(
        `SELECT count(*)::int AS count FROM commander_shadow.campaigns
          WHERE tenant_id='tenant-live' AND campaign_id = ANY($1::text[])`,
        [campaignIds],
      );
      assert.equal(remaining.rows[0]?.count, 0);
      assert.equal(counts[0]! + counts[1]!, campaignIds.length);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
  });
});
