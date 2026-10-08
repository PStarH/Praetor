import assert from 'node:assert/strict';
import { createHash, createHmac, generateKeyPairSync, sign } from 'node:crypto';
import { describe, it } from 'node:test';
import { actionGatewayPolicySnapshot } from '@praetor/contracts';
import { canonicalBytes } from './canonical.js';
import { parseShadowManifest, parseShadowObservation } from './contracts.js';
import { observationDigest } from './evaluator.js';
import { ShadowRepository, type ShadowSqlClient, type ShadowSqlPool } from './repository.js';
import { SHADOW_SCHEMA_SQL } from './schema.js';

type Response = { rows?: Record<string, unknown>[]; rowCount?: number };

class RecordingClient implements ShadowSqlClient {
  readonly calls: Array<{ sql: string; values: unknown[] }> = [];
  released = false;
  constructor(private readonly respond: (sql: string) => Response = () => ({})) {}
  async query(sql: string, values: unknown[] = []) {
    this.calls.push({ sql, values });
    if (sql === 'SELECT session_user AS ingestion_role')
      return { rows: [{ ingestion_role: 'test_ingestion' }], rowCount: 1 };
    const response = this.respond(sql);
    return { rows: response.rows ?? [], rowCount: response.rowCount ?? 0 };
  }
  release(): void {
    this.released = true;
  }
}

class RecordingPool implements ShadowSqlPool {
  constructor(readonly client: RecordingClient) {}
  async connect(): Promise<ShadowSqlClient> {
    return this.client;
  }
  query(sql: string, values: unknown[] = []) {
    return this.client.query(sql, values);
  }
}

const snapshot = actionGatewayPolicySnapshot();
const keyPair = generateKeyPairSync('ed25519');
const attestationKey = Buffer.alloc(32, 17);

function expectedAttestation(operation: string, values: unknown[]): string {
  const hmac = createHmac('sha256', attestationKey);
  for (const value of ['commander.shadow-ingestion/v1', operation, 'test_ingestion', ...values]) {
    const bytes = value === null ? null : Buffer.from(String(value), 'utf8');
    const length = Buffer.alloc(4);
    length.writeInt32BE(bytes?.length ?? -1);
    hmac.update(length);
    if (bytes) hmac.update(bytes);
  }
  return hmac.digest('hex');
}

function observation() {
  return parseShadowObservation({
    schema: 'commander.shadow-observation/v1',
    campaignId: 'campaign-1',
    tenantId: 'tenant-1',
    producerId: 'producer-1',
    batchId: 'batch-1',
    index: 0,
    observationId: 'observation-1',
    occurredAt: '2026-09-01T00:00:00.000Z',
    workflow: 'kubernetes.deployment.rollback',
    effectType: 'connector.kubernetes.deployment.rollback',
    tool: 'kubernetes.deployment.rollback',
    destination: 'k8s://cluster-1/namespace-1/deployments/api',
    productionDecision: 'require_approval',
    productionReasonCode: 'REGISTERED_ADAPTER_POLICY',
  });
}

function manifest() {
  const unsigned = {
    schema: 'commander.shadow-manifest/v1',
    campaignId: 'campaign-1',
    tenantId: 'tenant-1',
    producerId: 'producer-1',
    policyId: snapshot.policyId,
    policyDigest: snapshot.descriptorDigest,
    batchId: 'batch-1',
    closesAt: '2026-09-02T00:00:00.000Z',
    records: [
      { index: 0, observationId: 'observation-1', digest: observationDigest(observation()) },
    ],
    keyId: 'manifest-key-1',
  };
  return parseShadowManifest({
    ...unsigned,
    signature: sign(null, canonicalBytes(unsigned), keyPair.privateKey).toString('base64url'),
  });
}

function repository(client: RecordingClient): ShadowRepository {
  return new ShadowRepository(new RecordingPool(client), {
    retentionDays: 14,
    ingestionAttestationKey: attestationKey,
    trustedManifestPublicKeys: new Map([
      [
        'manifest-key-1',
        {
          algorithm: 'Ed25519',
          keyId: 'manifest-key-1',
          status: 'active',
          publicKey: keyPair.publicKey,
        },
      ],
    ]),
  });
}

describe('shadow PostgreSQL repository contract', () => {
  it('verifies manifest authority and policy before opening a transaction', async () => {
    const client = new RecordingClient();
    const invalid = { ...manifest(), signature: Buffer.alloc(64, 2).toString('base64url') };
    await assert.rejects(
      repository(client).registerManifest('tenant-1', invalid),
      /SHADOW_MANIFEST_SIGNATURE_INVALID/,
    );
    assert.deepEqual(client.calls, []);
  });

  it('rejects revoked manifest trust before opening a transaction', async () => {
    const client = new RecordingClient();
    const repo = new ShadowRepository(new RecordingPool(client), {
      retentionDays: 14,
      trustedManifestPublicKeys: new Map([
        [
          'manifest-key-1',
          {
            algorithm: 'Ed25519',
            keyId: 'manifest-key-1',
            status: 'revoked',
            publicKey: keyPair.publicKey,
          },
        ],
      ]),
    });
    await assert.rejects(
      repo.registerManifest('tenant-1', manifest()),
      /SHADOW_MANIFEST_KEY_REVOKED/,
    );
    assert.deepEqual(client.calls, []);
  });

  it('registers expected records in one tenant-bound transaction', async () => {
    const client = new RecordingClient();
    await repository(client).registerManifest('tenant-1', manifest());
    assert.equal(client.calls[0]?.sql, 'BEGIN');
    assert.equal(client.calls.at(-1)?.sql, 'COMMIT');
    assert.equal(client.released, true);
    const registration = client.calls.find((call) => /register_manifest/.test(call.sql));
    assert.ok(registration);
    assert.equal(registration.values.length, 11, 'manifest writes require application attestation');
    assert.equal(
      registration.values.at(-1),
      expectedAttestation('register_manifest', registration.values.slice(0, -1)),
    );
    assert.equal(registration.values.includes('tenant-1'), true);
    assert.equal(registration.values.includes('campaign-1'), true);
    assert.equal(registration.values.includes('batch-1'), true);
    assert.equal(
      client.calls.some((call) => /\b(?:INSERT|UPDATE|DELETE)\b/.test(call.sql)),
      false,
    );
  });

  it('requires authenticated database mutation entrypoints without a public signing oracle', () => {
    for (const name of ['register_manifest', 'record_attempt', 'record_observation']) {
      const body = SHADOW_SCHEMA_SQL.split(`CREATE FUNCTION commander_shadow.${name}(`)[1]!.split(
        'CREATE FUNCTION',
      )[0]!;
      assert.match(body, /p_attestation text/);
      assert.match(body, /PERFORM commander_shadow.verify_ingestion_attestation/);
    }
    assert.match(SHADOW_SCHEMA_SQL, /CREATE TABLE commander_shadow.ingestion_attestation_keys/);
    assert.doesNotMatch(SHADOW_SCHEMA_SQL, /GRANT[^;]*ingestion_attestation_keys/);
    assert.doesNotMatch(
      SHADOW_SCHEMA_SQL,
      /GRANT EXECUTE ON FUNCTION commander_shadow.verify_ingestion_attestation/,
    );
  });

  it('uses advisory serialization without requiring ingestion table UPDATE privileges', async () => {
    const campaignRow = {
      state: 'open',
      producer_id: 'producer-1',
      policy_id: snapshot.policyId,
      policy_digest: snapshot.descriptorDigest,
    };
    const expectedRow = {
      digest: observationDigest(observation()),
      observation_id: 'observation-1',
      status: 'pending',
      closes_at: '2026-09-02T00:00:00.000Z',
      batch_state: 'open',
      is_due: false,
    };
    const client = new RecordingClient((sql) => {
      if (/FROM commander_shadow\.campaigns/i.test(sql))
        return { rows: [campaignRow], rowCount: 1 };
      if (/FROM commander_shadow\.expected_records/i.test(sql))
        return { rows: [expectedRow], rowCount: 1 };
      return {};
    });
    const repo = repository(client);
    await repo.importObservation('tenant-1', observation());
    const lock = client.calls.findIndex((call) => /pg_advisory_xact_lock/.test(call.sql));
    const insert = client.calls.findIndex((call) => /record_observation/i.test(call.sql));
    const write = client.calls[insert]!;
    assert.equal(write.values.length, 14);
    assert.equal(
      write.values.at(-1),
      expectedAttestation('record_observation', write.values.slice(0, -1)),
    );
    assert.ok(lock > 0 && insert > lock);
    assert.equal(
      client.calls.some((call) => /FOR UPDATE/i.test(call.sql)),
      false,
      'ingestion role has no direct UPDATE privilege; locking belongs in definer functions',
    );

    client.calls.length = 0;
    await repo.withdrawCampaign('tenant-1', 'campaign-1');
    assert.ok(client.calls.some((call) => /tenant_id[\s\S]*FOR UPDATE/i.test(call.sql)));
    assert.ok(
      client.calls.some((call) =>
        /DELETE FROM commander_shadow\.(observations|batches)/i.test(call.sql),
      ),
    );
    assert.equal(client.calls.at(-1)?.sql, 'COMMIT');
  });

  it('returns the persisted decision on identical retry and identifies changed content as conflict', async () => {
    const storedDigest = observationDigest(observation());
    const client = new RecordingClient((sql) => {
      if (/FROM commander_shadow\.campaigns/i.test(sql))
        return {
          rows: [
            {
              state: 'open',
              producer_id: 'producer-1',
              policy_id: snapshot.policyId,
              policy_digest: snapshot.descriptorDigest,
            },
          ],
          rowCount: 1,
        };
      if (/FROM commander_shadow\.expected_records/i.test(sql))
        return {
          rows: [
            {
              digest: storedDigest,
              observation_id: 'observation-1',
              status: 'compared',
              closes_at: '2026-09-02T00:00:00.000Z',
              batch_state: 'open',
              is_due: false,
            },
          ],
          rowCount: 1,
        };
      if (/FROM commander_shadow\.observations/i.test(sql))
        return {
          rows: [
            {
              digest: storedDigest,
              hypothetical_decision: 'require_approval',
              hypothetical_decision_id: 'action-gateway-manifest-require_approval',
              hypothetical_reason_code: 'REGISTERED_ADAPTER_POLICY',
              comparison: 'match',
            },
          ],
          rowCount: 1,
        };
      return {};
    });
    const retry = await repository(client).importObservation('tenant-1', observation());
    assert.equal(retry.idempotent, true);
    assert.equal(retry.evaluation.decisionId, 'action-gateway-manifest-require_approval');

    await assert.rejects(
      repository(client).importObservation('tenant-1', {
        ...observation(),
        productionDecision: 'deny',
      }),
      /SHADOW_OBSERVATION_CONFLICT/,
    );
  });

  it('rolls back and propagates database failures without fallback', async () => {
    const failure = new Error('database unavailable');
    const client = new RecordingClient((sql) => {
      if (/register_manifest/i.test(sql)) throw failure;
      return {};
    });
    await assert.rejects(repository(client).registerManifest('tenant-1', manifest()), failure);
    assert.equal(client.calls.at(-1)?.sql, 'ROLLBACK');
    assert.equal(client.released, true);
  });

  it('places tenant predicates on every report and readiness data query', async () => {
    const client = new RecordingClient();
    const repo = repository(client);
    await repo.readReport('tenant-1', 'campaign-1');
    for (const call of client.calls.filter((call) => /SELECT/.test(call.sql))) {
      assert.match(call.sql, /tenant_id/i);
      assert.equal(call.values.includes('tenant-1'), true);
    }
  });

  it('releases a connection when BEGIN fails without issuing ROLLBACK', async () => {
    const client = new RecordingClient((sql) => {
      if (sql === 'BEGIN') throw new Error('begin failed');
      return {};
    });
    await assert.rejects(repository(client).runRetention('tenant-1'), /begin failed/);
    assert.equal(client.released, true);
    assert.deepEqual(
      client.calls.map((call) => call.sql),
      ['BEGIN'],
    );
  });

  it('only successful retention initializes cleanup readiness', async () => {
    const client = new RecordingClient();
    await repository(client).registerManifest('tenant-1', manifest());
    assert.equal(
      client.calls.some((call) => /cleanup_state/.test(call.sql)),
      false,
    );
    client.calls.length = 0;
    await repository(client).runRetention('tenant-1');
    assert.ok(
      client.calls.some((call) =>
        /INSERT INTO commander_shadow.cleanup_state[\s\S]*ON CONFLICT/.test(call.sql),
      ),
    );
    assert.doesNotMatch(
      SHADOW_SCHEMA_SQL,
      /GRANT SELECT, INSERT, UPDATE[^;]*cleanup_state[^;]*TO commander_shadow_ingestion/,
    );
    assert.match(
      SHADOW_SCHEMA_SQL,
      /GRANT SELECT, INSERT ON commander_shadow\.cleanup_state TO commander_shadow_retention;[\s\S]*GRANT UPDATE \(last_completed_at\) ON commander_shadow\.cleanup_state TO commander_shadow_retention/,
    );
  });

  it('counts only campaigns actually deleted after the locking re-check', async () => {
    let lockedChecks = 0;
    const client = new RecordingClient((sql) => {
      if (/ORDER BY campaign_id/.test(sql))
        return {
          rows: [{ campaign_id: 'campaign-1' }, { campaign_id: 'campaign-2' }],
          rowCount: 2,
        };
      if (/FOR UPDATE/.test(sql)) {
        lockedChecks += 1;
        // campaign-2 is deleted by a concurrent worker after the candidate scan.
        return lockedChecks === 1
          ? { rows: [{ campaign_id: 'campaign-1' }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (/DELETE FROM commander_shadow\.campaigns/.test(sql)) return { rowCount: 1 };
      return {};
    });
    assert.equal(await repository(client).runRetention('tenant-1'), 1);
    assert.equal(lockedChecks, 2);
    assert.equal(
      client.calls.filter((call) => /DELETE FROM commander_shadow\.campaigns/.test(call.sql))
        .length,
      1,
    );
  });

  it('gates retention candidates and the locking re-check on withdrawal', async () => {
    const client = new RecordingClient((sql) => {
      if (/ORDER BY campaign_id/.test(sql))
        return { rows: [{ campaign_id: 'campaign-1' }], rowCount: 1 };
      if (/FOR UPDATE/.test(sql)) return { rows: [{ campaign_id: 'campaign-1' }], rowCount: 1 };
      if (/DELETE FROM commander_shadow\.campaigns/.test(sql)) return { rowCount: 1 };
      return {};
    });
    assert.equal(await repository(client).runRetention('tenant-1'), 1);
    const candidate = client.calls.find((call) => /ORDER BY campaign_id/.test(call.sql));
    assert.ok(candidate);
    assert.match(candidate.sql, /AND state = 'withdrawn'/);
    const locked = client.calls.find((call) => /FOR UPDATE/.test(call.sql));
    assert.ok(locked);
    assert.match(locked.sql, /AND state = 'withdrawn' FOR UPDATE/);
  });

  it('never deletes an expired campaign that is still open', async () => {
    // The table holds exactly one expired campaign and it is still open, so a
    // state-gated query matches nothing while the ungated query returns it.
    const client = new RecordingClient((sql) => {
      if (/state = 'withdrawn'/.test(sql)) return { rows: [], rowCount: 0 };
      if (/ORDER BY campaign_id/.test(sql))
        return { rows: [{ campaign_id: 'campaign-1' }], rowCount: 1 };
      if (/FOR UPDATE/.test(sql)) return { rows: [{ campaign_id: 'campaign-1' }], rowCount: 1 };
      if (/DELETE FROM commander_shadow\.campaigns/.test(sql)) return { rowCount: 1 };
      return {};
    });
    assert.equal(await repository(client).runRetention('tenant-1'), 0);
    assert.equal(
      client.calls.some((call) => /DELETE FROM commander_shadow\.campaigns/.test(call.sql)),
      false,
    );
  });

  it('checks operation-specific runtime roles and lets retention run while cleanup is overdue', async () => {
    const cases = [
      ['manifest-register', 'commander_shadow_ingestion', true],
      ['import', 'commander_shadow_ingestion', true],
      ['batch-close', 'commander_shadow_ingestion', true],
      ['report-export', 'commander_shadow_reader', true],
      ['campaign-withdraw', 'commander_shadow_retention', true],
      ['retention-run', 'commander_shadow_retention', false],
      ['status', 'commander_shadow_ingestion', true],
    ] as const;
    for (const [operation, role, checksFreshness] of cases) {
      const client = new RecordingClient((sql) => {
        if (/FROM pg_roles/.test(sql))
          return {
            rows: [
              {
                safe_runtime_role: true,
                tenant_access: true,
                schema_usage: true,
                schema_create: false,
                version_read: true,
                operation_privileges: true,
              },
            ],
          };
        if (/schema_version/.test(sql)) return { rows: [{ version: 1 }] };
        return { rows: [] };
      });
      const result = await repository(client).readiness('tenant-1', 90, operation);
      assert.equal(result.ready, operation === 'retention-run', operation);
      const privilegeCheck = client.calls.find((call) => /FROM pg_roles/.test(call.sql));
      assert.ok(privilegeCheck, operation);
      assert.ok(privilegeCheck.values.includes(role), operation);
      assert.match(privilegeCheck.sql, /rolsuper|rolcreaterole|nspowner|relowner/, operation);
      assert.equal(
        client.calls.some((call) =>
          /SELECT last_completed_at FROM commander_shadow\.cleanup_state/.test(call.sql),
        ),
        checksFreshness,
        operation,
      );
    }
  });

  it('limits remaining direct mutations to retention operations', () => {
    assert.doesNotMatch(
      SHADOW_SCHEMA_SQL,
      /GRANT SELECT, INSERT, UPDATE ON commander_shadow\.(?:campaigns|batches|expected_records|observations)/,
    );
    assert.doesNotMatch(
      SHADOW_SCHEMA_SQL,
      /GRANT SELECT, UPDATE, DELETE ON commander_shadow\.(?:campaigns|batches|expected_records|observations)/,
    );
    assert.doesNotMatch(
      SHADOW_SCHEMA_SQL,
      /GRANT (?:INSERT|UPDATE|DELETE)[^;]*TO commander_shadow_ingestion/,
    );
    assert.match(
      SHADOW_SCHEMA_SQL,
      /GRANT UPDATE \(state, withdrawn_at, producer_id, policy_id, policy_digest\)[\s\S]*ON commander_shadow\.campaigns TO commander_shadow_retention/,
    );
  });

  it('confines ingestion writes to fixed-search-path security-definer functions', () => {
    const ingestionGrants = SHADOW_SCHEMA_SQL.split(';').filter((statement) =>
      /TO commander_shadow_ingestion\s*$/m.test(statement),
    );
    for (const statement of ingestionGrants) {
      assert.doesNotMatch(statement, /\b(?:INSERT|UPDATE|DELETE)\b/);
    }
    for (const functionName of [
      'register_manifest',
      'record_attempt',
      'record_observation',
      'close_batch',
    ]) {
      assert.match(
        SHADOW_SCHEMA_SQL,
        new RegExp(
          `CREATE FUNCTION commander_shadow\\.${functionName}\\([\\s\\S]*?SECURITY DEFINER[\\s\\S]*?SET search_path = pg_catalog`,
        ),
      );
      assert.match(
        SHADOW_SCHEMA_SQL,
        new RegExp(`GRANT EXECUTE ON FUNCTION commander_shadow\\.${functionName}\\(`),
      );
    }
    assert.match(
      SHADOW_SCHEMA_SQL,
      /REVOKE ALL ON FUNCTION commander_shadow\.tenant_access_allowed[\s\S]*commander_shadow\.verify_ingestion_attestation[\s\S]*commander_shadow\.close_batch\(text, text, text\) FROM PUBLIC/,
    );
  });

  it('keeps database validation fail-closed and aligned with the manifest record bound', () => {
    assert.match(
      SHADOW_SCHEMA_SQL,
      /jsonb_array_length\(p_manifest->'records'\) NOT BETWEEN 1 AND 10000/,
    );
    assert.match(SHADOW_SCHEMA_SQL, /COALESCE\(p_manifest->>'schema', ''\)/);
    assert.match(SHADOW_SCHEMA_SQL, /tenant_access_allowed\(p_tenant_id\) IS NOT TRUE/);
    assert.match(
      SHADOW_SCHEMA_SQL,
      /GRANT SELECT ON commander_shadow\.cleanup_state TO commander_shadow_ingestion, commander_shadow_reader/,
    );
  });

  it('cannot let a NULL campaign identity defeat the conflict guard', () => {
    const registration = SHADOW_SCHEMA_SQL.split(
      'CREATE FUNCTION commander_shadow.register_manifest(',
    )[1]!.split('CREATE FUNCTION')[0]!;
    assert.match(registration, /v_campaign\.producer_id IS DISTINCT FROM p_producer_id/);
    assert.match(registration, /v_campaign\.policy_id IS DISTINCT FROM p_policy_id/);
    assert.match(registration, /v_campaign\.policy_digest IS DISTINCT FROM p_policy_digest/);
    assert.doesNotMatch(registration, /v_campaign\.(?:producer_id|policy_id|policy_digest) <>/);
    const campaigns = SHADOW_SCHEMA_SQL.split(
      'CREATE TABLE commander_shadow.campaigns (',
    )[1]!.split('CREATE TABLE')[0]!;
    assert.match(
      campaigns,
      /CHECK \(\s*state = 'withdrawn'\s*OR \(producer_id IS NOT NULL AND policy_id IS NOT NULL AND policy_digest IS NOT NULL\)\s*\)/,
    );
  });

  it('isolates hashed deletion audit writes by the bound tenant', () => {
    assert.match(
      SHADOW_SCHEMA_SQL,
      /ALTER TABLE commander_shadow\.deletion_audit FORCE ROW LEVEL SECURITY/,
    );
    assert.match(
      SHADOW_SCHEMA_SQL,
      /CREATE POLICY deletion_audit_tenant_isolation[\s\S]*tenant_id_hash = encode\(sha256/,
    );
  });

  it('preserves terminal rejection evidence against calls to the ingestion write API', () => {
    const attemptSql = SHADOW_SCHEMA_SQL.split(
      'CREATE FUNCTION commander_shadow.record_attempt(',
    )[1]!.split('CREATE FUNCTION')[0]!;
    assert.match(attemptSql, /AND e\.status = 'pending'/);
    assert.match(
      attemptSql,
      /attempt_digest = p_attempt_digest[\s\S]*attempt_code = p_attempt_code/,
    );
    assert.match(SHADOW_SCHEMA_SQL, /e\.status <> 'rejected'/);
  });

  it('rejects role authority reachable through membership as well as direct ownership', async () => {
    const client = new RecordingClient();
    await repository(client).readiness('tenant-1', 90, 'import');
    const sql = client.calls.find((call) => /FROM pg_roles/.test(call.sql))!.sql;
    assert.match(sql, /pg_has_role\(session_user, privileged\.oid, 'MEMBER'\)/);
    assert.match(sql, /pg_has_role\(session_user, c\.relowner, 'MEMBER'\)/);
    assert.match(sql, /pg_has_role\(session_user, n\.nspowner, 'MEMBER'\)/);
  });

  it('forces tenant-bound RLS on every tenant table', () => {
    for (const table of [
      'campaigns',
      'batches',
      'expected_records',
      'observations',
      'cleanup_state',
    ]) {
      assert.match(
        SHADOW_SCHEMA_SQL,
        new RegExp(
          `ALTER TABLE commander_shadow\\.${table} ENABLE ROW LEVEL SECURITY;[\\s\\S]*?ALTER TABLE commander_shadow\\.${table} FORCE ROW LEVEL SECURITY;`,
        ),
      );
      assert.match(
        SHADOW_SCHEMA_SQL,
        new RegExp(
          `CREATE POLICY ${table}_tenant_isolation ON commander_shadow\\.${table}[\\s\\S]*?tenant_access_allowed\\(tenant_id\\)[\\s\\S]*?WITH CHECK \\(commander_shadow\\.tenant_access_allowed\\(tenant_id\\)\\)`,
        ),
      );
    }
    assert.match(SHADOW_SCHEMA_SQL, /session_user/);
    assert.match(SHADOW_SCHEMA_SQL, /current_setting\('commander_shadow\.tenant_id', true\)/);
  });

  it('binds the tenant transaction-locally before report data access', async () => {
    const client = new RecordingClient();
    await repository(client).readReport('tenant-1', 'campaign-1');
    assert.equal(client.calls[0]?.sql, 'BEGIN');
    assert.match(
      client.calls[1]?.sql ?? '',
      /set_config\('commander_shadow\.tenant_id', \$1, true\)/,
    );
    assert.deepEqual(client.calls[1]?.values, ['tenant-1']);
    assert.ok(
      client.calls.slice(2).every((call) => !/\b(?:SET|set_config)\b/.test(call.sql)),
      'tenant binding must be established exactly once before data access',
    );
  });

  it('reads report data on one transaction and holds a campaign lock', async () => {
    const client = new RecordingClient();
    await repository(client).readReport('tenant-1', 'campaign-1');
    assert.equal(client.calls[0]?.sql, 'BEGIN');
    assert.ok(client.calls.some((call) => /pg_advisory_xact_lock_shared/.test(call.sql)));
    assert.equal(client.calls.at(-1)?.sql, 'COMMIT');
    assert.equal(client.released, true);
  });

  it('uses the database deadline for close and admission', async () => {
    const client = new RecordingClient((sql) => {
      if (/FROM commander_shadow.campaigns/.test(sql))
        return { rows: [{ state: 'open', producer_id: 'producer-1' }] };
      if (/FROM commander_shadow.expected_records/.test(sql))
        return {
          rows: [{ batch_state: 'open', is_due: true, closes_at: '2999-01-01T00:00:00.000Z' }],
        };
      if (/FROM commander_shadow.batches/.test(sql))
        return { rows: [{ state: 'open', is_due: false, closes_at: '2000-01-01T00:00:00.000Z' }] };
      return {};
    });
    await assert.rejects(
      repository(client).importObservation('tenant-1', observation()),
      /SHADOW_BATCH_CLOSED/,
    );
    await assert.rejects(
      repository(client).closeDueBatch('tenant-1', 'campaign-1', 'batch-1'),
      /SHADOW_BATCH_NOT_DUE/,
    );
  });

  it('does not mutate the expected record when submitted content misses the manifest digest', async () => {
    const client = new RecordingClient((sql) => {
      if (/FROM commander_shadow.campaigns/.test(sql))
        return {
          rows: [
            {
              state: 'open',
              producer_id: 'producer-1',
              policy_id: snapshot.policyId,
              policy_digest: snapshot.descriptorDigest,
            },
          ],
        };
      if (/FROM commander_shadow.expected_records/.test(sql))
        return {
          rows: [
            {
              batch_state: 'open',
              is_due: false,
              observation_id: 'observation-1',
              digest: observationDigest(observation()),
            },
          ],
        };
      return {};
    });
    await assert.rejects(
      repository(client).importObservation('tenant-1', {
        ...observation(),
        destination: 'k8s://different/ns/deployments/api',
      }),
      /SHADOW_DIGEST_MISMATCH/,
    );
    assert.equal(client.calls.at(-1)?.sql, 'ROLLBACK');
    const rejected = client.calls.find((call) => /record_attempt/.test(call.sql));
    assert.equal(rejected, undefined);
  });

  it('records schema-invalid arrived content when its manifest digest matches', async () => {
    const raw = { ...observation(), productionDecision: 'invalid', secret: 'must-not-store' };
    const rawDigest = createHash('sha256').update(canonicalBytes(raw)).digest('hex');
    const client = new RecordingClient((sql) => {
      if (/FROM commander_shadow.campaigns/.test(sql))
        return {
          rows: [
            {
              state: 'open',
              producer_id: 'producer-1',
              policy_id: snapshot.policyId,
              policy_digest: snapshot.descriptorDigest,
            },
          ],
        };
      if (/FROM commander_shadow.expected_records/.test(sql))
        return {
          rows: [
            {
              batch_state: 'open',
              is_due: false,
              observation_id: 'observation-1',
              digest: rawDigest,
            },
          ],
        };
      return {};
    });
    await assert.rejects(
      repository(client).importObservation('tenant-1', raw),
      /SHADOW_UNKNOWN_FIELD/,
    );
    assert.equal(client.calls.at(-1)?.sql, 'COMMIT');
    const rejected = client.calls.find((call) => /record_attempt/.test(call.sql));
    assert.ok(rejected);
    assert.ok(rejected.values.includes('rejected'));
    assert.ok(rejected.values.includes('SHADOW_UNKNOWN_FIELD'));
    assert.equal(rejected.values.length, 8);
    assert.equal(
      rejected.values.at(-1),
      expectedAttestation('record_attempt', rejected.values.slice(0, -1)),
    );
    assert.equal(JSON.stringify(client.calls).includes('must-not-store'), false);
  });

  it('accounts for digest-bound sensitive data as a rejected attempt without persisting it', async () => {
    const raw = { ...observation(), productionReasonCode: 'notify-ops@example.com' };
    const rawDigest = createHash('sha256').update(canonicalBytes(raw)).digest('hex');
    const client = new RecordingClient((sql) => {
      if (/FROM commander_shadow\.campaigns/.test(sql))
        return {
          rows: [
            {
              state: 'open',
              producer_id: 'producer-1',
              policy_id: snapshot.policyId,
              policy_digest: snapshot.descriptorDigest,
            },
          ],
        };
      if (/FROM commander_shadow\.expected_records/.test(sql))
        return {
          rows: [
            {
              batch_state: 'open',
              is_due: false,
              observation_id: 'observation-1',
              digest: rawDigest,
            },
          ],
        };
      return {};
    });

    await assert.rejects(
      repository(client).importObservation('tenant-1', raw),
      /SHADOW_SENSITIVE_DATA/,
    );
    const rejected = client.calls.find((call) => /record_attempt/.test(call.sql));
    assert.ok(rejected);
    assert.ok(rejected.values.includes('SHADOW_SENSITIVE_DATA'));
    assert.equal(JSON.stringify(client.calls).includes('notify-ops@example.com'), false);
  });

  it('refuses unbound or malformed identities before accessing PostgreSQL', async () => {
    const client = new RecordingClient();
    for (const raw of [
      null,
      { ...observation(), index: -1 },
      { ...observation(), campaignId: 'invalid campaign' },
    ]) {
      await assert.rejects(repository(client).importObservation('tenant-1', raw), /SHADOW_INVALID/);
    }
    assert.equal(client.calls.length, 0);
  });

  it('persists evaluation failures separately and lets a later valid retry replace an attempt', async () => {
    let failed = true;
    const client = new RecordingClient((sql) => {
      if (/FROM commander_shadow.campaigns/.test(sql))
        return {
          rows: [
            {
              state: 'open',
              producer_id: 'producer-1',
              policy_id: snapshot.policyId,
              policy_digest: failed ? 'bad-pin' : snapshot.descriptorDigest,
            },
          ],
        };
      if (/FROM commander_shadow.expected_records/.test(sql))
        return {
          rows: [
            {
              status: 'failed',
              batch_state: 'open',
              is_due: false,
              observation_id: 'observation-1',
              digest: observationDigest(observation()),
            },
          ],
        };
      return {};
    });
    await assert.rejects(
      repository(client).importObservation('tenant-1', observation()),
      /SHADOW_EVALUATION_FAILED/,
    );
    assert.ok(client.calls.some((call) => call.values.includes('failed')));
    assert.equal(client.calls.at(-1)?.sql, 'COMMIT');
    failed = false;
    assert.equal(
      (await repository(client).importObservation('tenant-1', observation())).comparison,
      'match',
    );
    assert.ok(client.calls.some((call) => /record_observation/.test(call.sql)));
  });
});
