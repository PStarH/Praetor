import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { Pool } from 'pg';
import { runKernelMigrations, runTask1ClosureMigrations } from './migrations.js';
import { PostgresKernelRepository, PostgresTenantContextAuthority } from './postgres.js';
import { seedWorkerAllowedTenants } from './seedWorkerClaimSecret.js';
import {
  governedCompensationAuthorizationInput,
  type LegacyGovernedCompensationInput,
} from './ops/compensationPersistence.js';
import {
  canonicalCompensationHash,
  sealGovernedCompensationAuthorization,
} from './ops/compensationAuthority.js';
import { KERNEL_COMPENSATION_TOPIC } from './ops/compensationConsumer.js';
import { buildTerminalEvidenceRecordFromKernel } from '@praetor/effect-broker';
import { deriveEffectIdempotencyKey } from '@praetor/effect-broker';

const adminUrl = process.env.COMMANDER_COMPENSATION_PG_URL;

// F-K1-9: this suite is the only live proof of the governed-compensation
// PostgreSQL authority and its RLS enforcement. It cannot run without a
// PostgreSQL 16 fixture, so the skip is named and reported loudly instead of
// vanishing from the run — absent environment is NOT_RUN, never PASS.
const LIVE_PG_SKIP_REASON =
  'NOT VERIFIED: COMMANDER_COMPENSATION_PG_URL is unset — governed compensation ' +
  'PostgreSQL authority / RLS proof did not run';

function compensationIdempotencyKey(claim: {
  request: {
    tenantId: string;
    compensationRunId: string;
    compensationStepId: string;
    compensationEffectId?: string;
    originalEffectId: string;
    destination: string;
    compensationPatch: Record<string, unknown>;
  };
  forwardResponse: Record<string, unknown>;
}): string {
  return deriveEffectIdempotencyKey({
    tenantId: claim.request.tenantId,
    runId: claim.request.compensationRunId,
    stepId: claim.request.compensationStepId,
    effectId: claim.request.compensationEffectId!,
    request: {
      originalEffectId: claim.request.originalEffectId,
      destination: claim.request.destination,
      forwardResponse: claim.forwardResponse,
      compensationPatch: claim.request.compensationPatch,
    },
  });
}
if (!adminUrl) {
  process.stderr.write(`[kernel:live-postgres] ${LIVE_PG_SKIP_REASON}\n`);
}

describe(
  'governed compensation PostgreSQL authority',
  {
    skip: adminUrl ? false : LIVE_PG_SKIP_REASON,
  },
  () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const databaseName = `commander_compensation_live_${suffix}`;
    const tenantA = `comp-a-${suffix}`;
    const tenantB = `comp-b-${suffix}`;
    const workerId = `worker-${suffix}`;
    const adapterInstance = `comp${suffix}`;
    const adapterId = `compensation:${adapterInstance}`;
    const passwords = {
      owner: `owner-${suffix}`,
      worker: `worker-${suffix}`,
      adapter: `adapter-${suffix}`,
      app: `app-${suffix}`,
      authority: `authority-${suffix}`,
    };

    let admin: Pool;
    let owner: Pool;
    let worker: Pool;
    let adapter: Pool;
    let app: Pool;
    let authority: Pool;
    let ownerRepository: PostgresKernelRepository;
    let workerRepository: PostgresKernelRepository;
    let adapterRepository: PostgresKernelRepository;
    let appRepository: PostgresKernelRepository;
    let workerGeneration: number;
    let workerSecret: string;
    let adapterGeneration: number;
    let adapterSecret: string;

    const url = (role?: string, password?: string): string => {
      const parsed = new URL(adminUrl!);
      parsed.pathname = `/${databaseName}`;
      if (role) parsed.username = role;
      if (password) parsed.password = password;
      return parsed.toString();
    };

    before(async () => {
      admin = new Pool({ connectionString: adminUrl, max: 2 });
      await admin.query(
        `ALTER ROLE commander_owner LOGIN NOSUPERUSER NOCREATEDB CREATEROLE INHERIT
         NOREPLICATION BYPASSRLS PASSWORD '${passwords.owner}';
       ALTER ROLE commander_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
         NOREPLICATION NOBYPASSRLS PASSWORD '${passwords.worker}';
       ALTER ROLE commander_adapter_ops LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
         NOREPLICATION NOBYPASSRLS PASSWORD '${passwords.adapter}';
       ALTER ROLE commander_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
         NOREPLICATION NOBYPASSRLS PASSWORD '${passwords.app}';
       ALTER ROLE commander_tenant_authority LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
         NOREPLICATION NOBYPASSRLS PASSWORD '${passwords.authority}'`,
      );
      await admin.query(`CREATE DATABASE "${databaseName}" OWNER commander_owner`);
      owner = new Pool({ connectionString: url('commander_owner', passwords.owner), max: 5 });
      await runKernelMigrations(owner);
      await runTask1ClosureMigrations(owner, 'expand');
      await runTask1ClosureMigrations(owner, 'enforce');
      await runKernelMigrations(owner);
      await seedWorkerAllowedTenants(owner, [tenantA, tenantB]);
      await owner.query(
        `INSERT INTO commander_tenant_authority_allowed_tenants (tenant_id)
       VALUES ($1), ($2)
       ON CONFLICT (tenant_id) DO UPDATE SET enabled = true`,
        [tenantA, tenantB],
      );

      worker = new Pool({ connectionString: url('commander_worker', passwords.worker), max: 3 });
      adapter = new Pool({
        connectionString: url('commander_adapter_ops', passwords.adapter),
        max: 3,
      });
      app = new Pool({ connectionString: url('commander_app', passwords.app), max: 3 });
      authority = new Pool({
        connectionString: url('commander_tenant_authority', passwords.authority),
        max: 2,
      });
      ownerRepository = new PostgresKernelRepository(owner, { schedulerMode: true });
      workerRepository = new PostgresKernelRepository(worker);
      adapterRepository = new PostgresKernelRepository(adapter, { adapterOpsMode: true });
      appRepository = new PostgresKernelRepository(app, {
        tenantContextAuthority: new PostgresTenantContextAuthority(authority),
        tenantContextPhase: 'enforce',
      });

      const workerRegistration = await worker.query<{
        registration: { generation: number; claim_secret: string };
      }>(
        `SELECT register_worker($1,'agent','comp-live','["agent"]','{}',1,$1,$2::jsonb,NULL)
         AS registration`,
        [workerId, JSON.stringify([tenantA])],
      );
      workerGeneration = Number(workerRegistration.rows[0]!.registration.generation);
      workerSecret = workerRegistration.rows[0]!.registration.claim_secret;
      const adapterRegistration = await adapter.query<{
        registration: { generation: number; claim_secret: string };
      }>(`SELECT register_adapter_ops_worker('compensation',$1,$2::jsonb,NULL) AS registration`, [
        adapterInstance,
        JSON.stringify([tenantA]),
      ]);
      adapterGeneration = Number(adapterRegistration.rows[0]!.registration.generation);
      adapterSecret = adapterRegistration.rows[0]!.registration.claim_secret;
    });

    after(async () => {
      await Promise.all([
        authority?.end(),
        app?.end(),
        adapter?.end(),
        worker?.end(),
        owner?.end(),
      ]);
      if (admin) {
        await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
        await admin.query(
          // Restore the documented steady state; see the note in
          // task2.postgres-live.test.ts. Revoking LOGIN on cluster-global roles here
          // deadlocks the next suite, which must connect as one of them to bootstrap.
          `ALTER ROLE commander_owner LOGIN CREATEROLE BYPASSRLS;
         ALTER ROLE commander_worker LOGIN;
         ALTER ROLE commander_adapter_ops LOGIN;
         ALTER ROLE commander_app LOGIN;
         ALTER ROLE commander_tenant_authority LOGIN`,
        );
        await admin.end();
      }
    });

    async function completedForwardEffect(label = 'context') {
      const runId = `run-forward-${label}-${suffix}`;
      const stepId = `step-forward-${label}-${suffix}`;
      const effectId = `effect-forward-${label}-${suffix}`;
      await ownerRepository.createRun(
        {
          id: runId,
          tenantId: tenantA,
          intentHash: 'intent-forward',
          workGraphHash: 'graph-forward',
          workGraphVersion: 'v1',
          policySnapshotId: 'policy-forward-v1',
          steps: [{ id: stepId, kind: 'agent' }],
        },
        'test-owner',
      );
      const step = await workerRepository.claimNextStep({
        workerId,
        workerGeneration,
        claimSecret: workerSecret,
        capabilities: ['agent'],
        leaseTtlMs: 60_000,
      });
      assert.ok(step?.lease);
      const request = { destination: 'ticket://tenant-a/INC-1', args: { severity: 'high' } };
      const admitted = await workerRepository.admitEffect({
        id: effectId,
        runId,
        stepId,
        tenantId: tenantA,
        type: 'read.ticket',
        idempotencyKey: `forward-${label}-${suffix}`,
        policyDecisionId: 'policy-decision-forward',
        policySnapshotId: 'policy-forward-v1',
        actionDigest: 'a'.repeat(64),
        request,
        lease: step.lease,
        actor: workerId,
      });
      assert.equal(admitted.admitted, true);
      const response = { providerId: 'INC-1', version: 7 };
      assert.ok(
        await workerRepository.completeEffect(effectId, tenantA, step.lease, response, workerId),
      );
      await owner.query(
        `UPDATE commander_steps SET state='SUCCEEDED',lease_worker_id=NULL,lease_worker_generation=0,
         lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1 AND tenant_id=$2`,
        [stepId, tenantA],
      );
      await owner.query(
        `UPDATE commander_runs SET state='SUCCEEDED',terminal_at=now(),updated_at=now()
         WHERE id=$1 AND tenant_id=$2`,
        [runId, tenantA],
      );
      return { runId, stepId, effectId, request, response };
    }

    async function claimGovernedCompensation(label: string) {
      const forward = await completedForwardEffect(label);
      const base: LegacyGovernedCompensationInput = {
        tenantId: tenantA,
        originalRunId: forward.runId,
        originalEffectId: forward.effectId,
        forwardReceipt: forward.response,
        adapterVersion: `demo-ticket/${label}/v1`,
        compensationEffectType: 'compensate.demo.ticket.create',
        compensationPatch: { status: 'cancelled', label },
        policyDecisionId: `policy-decision-compensation-${label}`,
        policySnapshotId: `policy-compensation-${label}-v1`,
        actionDigest: '',
        decisionEffect: 'allow',
        authorizationExpiresAt: new Date(Date.now() + 300_000).toISOString(),
        approvalBinding: null,
        actor: 'api-user',
      };
      const sealed = sealGovernedCompensationAuthorization(
        governedCompensationAuthorizationInput({
          request: base,
          originalRunStateAtRequest: 'SUCCEEDED',
          originalEffect: { request: forward.request, response: forward.response },
        }),
      );
      base.actionDigest = canonicalCompensationHash({
        type: base.compensationEffectType,
        originalEffectId: base.originalEffectId,
        adapterVersion: base.adapterVersion,
        destination: forward.request.destination,
        forwardResponse: base.forwardReceipt,
        compensationPatch: base.compensationPatch,
      });
      await appRepository.createCompensationAuthorization({
        id: sealed.authorizationId,
        tenantId: base.tenantId,
        originalRunId: base.originalRunId,
        originalEffectId: base.originalEffectId,
        compensationEffectType: base.compensationEffectType,
        adapterVersion: base.adapterVersion,
        compensationPatch: base.compensationPatch,
        forwardReceiptHash: sealed.forwardReceiptHash,
        policyDecisionId: base.policyDecisionId,
        policySnapshotId: base.policySnapshotId,
        decision: base.decisionEffect,
        actionDigest: base.actionDigest,
        expiresAt: base.authorizationExpiresAt,
      });
      const requested = await appRepository.requestCompensation({
        tenantId: tenantA,
        authorizationId: sealed.authorizationId,
        actor: base.actor,
      });
      assert.equal(requested.accepted, true);
      // Resolve this request's own outbox row: the RPC treats an empty
      // outboxMessageId as "any unpublished compensation outbox for the tenant",
      // which lets one test's un-consumed outbox poison the next claim.
      const outbox = await owner.query<{ id: string }>(
        `SELECT id FROM commander_outbox
          WHERE tenant_id=$1 AND topic='commander.kernel.compensation.requested'
            AND payload->>'requestId'=$2 AND published_at IS NULL`,
        [tenantA, requested.request.id],
      );
      assert.equal(outbox.rowCount, 1);
      const claim = await adapterRepository.claimCompensationRequest({
        requestId: requested.request.id,
        outboxMessageId: outbox.rows[0]!.id,
        workerId: adapterId,
        workerGeneration: adapterGeneration,
        claimSecret: adapterSecret,
      });
      assert.ok(claim && 'request' in claim);
      const compensationEffectId = claim.request.compensationEffectId;
      assert.ok(compensationEffectId);
      return { claim, compensationEffectId };
    }

    async function claimAdmittedCompensation(label: string) {
      const { claim, compensationEffectId } = await claimGovernedCompensation(label);
      const admitted = await adapterRepository.admitCompensationEffect({
        id: compensationEffectId,
        runId: claim.request.compensationRunId,
        stepId: claim.request.compensationStepId,
        tenantId: tenantA,
        type: claim.authorization.compensationEffectType,
        idempotencyKey: compensationIdempotencyKey(claim),
        policyDecisionId: claim.authorization.policyDecisionId,
        policySnapshotId: claim.authorization.policySnapshotId,
        actionDigest: claim.authorization.actionDigest,
        request: {
          originalEffectId: claim.request.originalEffectId,
          destination: claim.request.destination,
          forwardResponse: claim.forwardResponse,
          compensationPatch: claim.authorization.compensationPatch,
        },
        lease: claim.lease,
        requestId: claim.request.id,
        requestClaimToken: claim.request.claimToken!,
        outboxMessageId: claim.outboxMessageId,
        outboxClaimToken: claim.outboxClaimToken,
        actor: adapterId,
      });
      assert.equal(admitted.admitted, true);
      return { claim, compensationEffectId };
    }

    async function terminalEvidence(
      claim: Extract<
        Awaited<ReturnType<typeof adapterRepository.claimCompensationWork>>[number],
        { request: unknown }
      >,
      effectId: string,
      projectedState: 'COMPLETED' | 'FAILED',
      response: Record<string, unknown>,
    ) {
      const recordedAt = new Date().toISOString();
      return buildTerminalEvidenceRecordFromKernel({
        kernel: {
          getTerminalEvidenceContext: (contextEffectId, runId, tenantId, claimToken) =>
            adapterRepository.getAdapterOpsEvidenceContext({
              workerId: adapterId,
              workerGeneration: adapterGeneration,
              claimSecret: adapterSecret,
              tenantId,
              runId,
              effectId: contextEffectId,
              claimToken,
            }),
        },
        signer: {
          // F-K1-23: `verify` used to be `() => true`, so this suite could not
          // detect an evidence-signature binding regression at all. It now
          // recomputes the digest over the canonical body it is handed.
          sign: async (canonicalBody: string) => ({
            algorithm: 'Ed25519',
            keyId: 'compensation-live-test',
            signedAt: recordedAt,
            value: createHash('sha256').update(canonicalBody).digest('hex'),
          }),
          verify: (canonicalBody: string, signature: { value: string }) =>
            signature.value === createHash('sha256').update(canonicalBody).digest('hex'),
        },
        tenantId: tenantA,
        runId: claim.request.compensationRunId,
        effectId,
        projectedState,
        response,
        terminalEvent: {
          type: projectedState === 'COMPLETED' ? 'effect.completed' : 'effect.failed',
          severity: projectedState === 'COMPLETED' ? 'low' : 'high',
          details: projectedState === 'COMPLETED' ? {} : { errorCode: response.code },
        },
        recordedAt,
        retentionUntil: new Date(Date.parse(recordedAt) + 86_400_000).toISOString(),
        claimToken: claim.outboxClaimToken,
      });
    }

    it('binds compensation evidence context to immutable claim authority', async () => {
      const forward = await completedForwardEffect();
      const base: LegacyGovernedCompensationInput = {
        tenantId: tenantA,
        originalRunId: forward.runId,
        originalEffectId: forward.effectId,
        forwardReceipt: forward.response,
        adapterVersion: 'demo-ticket/v1',
        compensationEffectType: 'compensate.demo.ticket.create',
        compensationPatch: { status: 'cancelled' },
        policyDecisionId: 'policy-decision-compensation',
        policySnapshotId: 'policy-compensation-v1',
        actionDigest: '',
        decisionEffect: 'allow',
        authorizationExpiresAt: new Date(Date.now() + 300_000).toISOString(),
        approvalBinding: null,
        actor: 'api-user',
      };
      const sealed = sealGovernedCompensationAuthorization(
        governedCompensationAuthorizationInput({
          request: base,
          originalRunStateAtRequest: 'SUCCEEDED',
          originalEffect: { request: forward.request, response: forward.response },
        }),
      );
      base.actionDigest = canonicalCompensationHash({
        type: base.compensationEffectType,
        originalEffectId: base.originalEffectId,
        adapterVersion: base.adapterVersion,
        destination: forward.request.destination,
        forwardResponse: base.forwardReceipt,
        compensationPatch: base.compensationPatch,
      });
      await appRepository.createCompensationAuthorization({
        id: sealed.authorizationId,
        tenantId: base.tenantId,
        originalRunId: base.originalRunId,
        originalEffectId: base.originalEffectId,
        compensationEffectType: base.compensationEffectType,
        adapterVersion: base.adapterVersion,
        compensationPatch: base.compensationPatch,
        forwardReceiptHash: sealed.forwardReceiptHash,
        policyDecisionId: base.policyDecisionId,
        policySnapshotId: base.policySnapshotId,
        decision: base.decisionEffect,
        actionDigest: base.actionDigest,
        expiresAt: base.authorizationExpiresAt,
      });
      const requested = await appRepository.requestCompensation({
        tenantId: base.tenantId,
        authorizationId: sealed.authorizationId,
        actor: base.actor,
      });
      assert.equal(requested.accepted, true);

      const authorityTables = await owner.query<{
        authorization: string | null;
        request: string | null;
      }>(
        `SELECT to_regclass('public.commander_compensation_authorizations')::text AS authorization,
              to_regclass('public.commander_compensation_requests')::text AS request`,
      );
      assert.equal(authorityTables.rows[0]?.authorization, 'commander_compensation_authorizations');
      assert.equal(authorityTables.rows[0]?.request, 'commander_compensation_requests');

      await assert.rejects(
        app.query(`UPDATE commander_compensation_authorizations SET action_digest='tampered'`),
        /permission denied/i,
      );
      await assert.rejects(
        adapter.query(`INSERT INTO commander_compensation_authorizations DEFAULT VALUES`),
        /permission denied/i,
      );

      assert.deepEqual(
        await adapterRepository.claimCompensationWork({
          workerId: adapterId,
          workerGeneration: adapterGeneration + 1,
          claimSecret: adapterSecret,
          topic: KERNEL_COMPENSATION_TOPIC,
          limit: 10,
        }),
        [],
      );
      const claims = await adapterRepository.claimCompensationWork({
        workerId: adapterId,
        workerGeneration: adapterGeneration,
        claimSecret: adapterSecret,
        topic: KERNEL_COMPENSATION_TOPIC,
        limit: 10,
      });
      assert.equal(claims.length, 1);
      const claim = claims[0]!;
      assert.ok(claim, 'compensation claim must be present');
      if (!('request' in claim)) {
        throw new Error('compensation claim must be a durable claimed request');
      }
      const compensationEffectId = claim.request.compensationEffectId;
      assert.ok(
        compensationEffectId,
        'claimed compensation request must carry a compensation effect id',
      );
      const admitted = await adapterRepository.admitCompensationEffect({
        id: compensationEffectId,
        runId: claim.request.compensationRunId,
        stepId: claim.request.compensationStepId,
        tenantId: tenantA,
        type: claim.authorization.compensationEffectType,
        idempotencyKey: compensationIdempotencyKey(claim),
        policyDecisionId: claim.authorization.policyDecisionId,
        policySnapshotId: claim.authorization.policySnapshotId,
        actionDigest: claim.authorization.actionDigest,
        request: {
          originalEffectId: claim.request.originalEffectId,
          destination: claim.request.destination,
          forwardResponse: claim.forwardResponse,
          compensationPatch: claim.authorization.compensationPatch,
        },
        lease: claim.lease,
        requestId: claim.request.id,
        requestClaimToken: claim.request.claimToken!,
        outboxMessageId: claim.outboxMessageId,
        outboxClaimToken: claim.outboxClaimToken,
        actor: adapterId,
      });
      assert.equal(admitted.admitted, true);
      const evidenceContext = await adapterRepository.getAdapterOpsEvidenceContext({
        workerId: adapterId,
        workerGeneration: adapterGeneration,
        claimSecret: adapterSecret,
        tenantId: tenantA,
        runId: claim.request.compensationRunId,
        effectId: compensationEffectId,
        claimToken: claim.outboxClaimToken,
      });
      assert.equal(evidenceContext.effect.id, compensationEffectId);
      assert.equal(evidenceContext.evidence, null);
      await assert.rejects(
        adapterRepository.getAdapterOpsEvidenceContext({
          workerId: adapterId,
          workerGeneration: adapterGeneration,
          claimSecret: adapterSecret,
          tenantId: tenantA,
          runId: claim.request.compensationRunId,
          effectId: compensationEffectId,
          claimToken: '',
        }),
        /ADAPTER_OPS_EVIDENCE_CONTEXT_INVALID/,
      );
      await assert.rejects(
        adapterRepository.getAdapterOpsEvidenceContext({
          workerId: adapterId,
          workerGeneration: adapterGeneration,
          claimSecret: adapterSecret,
          tenantId: tenantA,
          runId: claim.request.compensationRunId,
          effectId: compensationEffectId,
          claimToken: `${claim.outboxClaimToken}-wrong`,
        }),
        /ADAPTER_OPS_EVIDENCE_CONTEXT_DENIED/,
      );
      await assert.rejects(
        adapterRepository.getAdapterOpsEvidenceContext({
          workerId: adapterId,
          workerGeneration: adapterGeneration,
          claimSecret: adapterSecret,
          tenantId: tenantA,
          runId: forward.runId,
          effectId: compensationEffectId,
          claimToken: claim.outboxClaimToken,
        }),
        /ADAPTER_OPS_EVIDENCE_CONTEXT_DENIED/,
      );
      await assert.rejects(
        adapterRepository.getAdapterOpsEvidenceContext({
          workerId: adapterId,
          workerGeneration: adapterGeneration,
          claimSecret: adapterSecret,
          tenantId: tenantA,
          runId: claim.request.compensationRunId,
          effectId: forward.effectId,
          claimToken: claim.outboxClaimToken,
        }),
        /ADAPTER_OPS_EVIDENCE_CONTEXT_DENIED/,
      );
      await assert.rejects(
        adapterRepository.getAdapterOpsEvidenceContext({
          workerId: adapterId,
          workerGeneration: adapterGeneration,
          claimSecret: adapterSecret,
          tenantId: tenantB,
          runId: claim.request.compensationRunId,
          effectId: compensationEffectId,
          claimToken: claim.outboxClaimToken,
        }),
        /ADAPTER_OPS_EVIDENCE_CONTEXT_DENIED/,
      );

      await owner.query(
        `UPDATE commander_compensation_requests
          SET claim_expires_at=clock_timestamp()-interval '1 second'
        WHERE id=$1 AND tenant_id=$2`,
        [claim.request.id, tenantA],
      );
      await assert.rejects(
        adapterRepository.getAdapterOpsEvidenceContext({
          workerId: adapterId,
          workerGeneration: adapterGeneration,
          claimSecret: adapterSecret,
          tenantId: tenantA,
          runId: claim.request.compensationRunId,
          effectId: compensationEffectId,
          claimToken: claim.outboxClaimToken,
        }),
        /ADAPTER_OPS_EVIDENCE_CONTEXT_DENIED/,
      );
      await owner.query(
        `UPDATE commander_compensation_requests
          SET claim_expires_at=clock_timestamp()+interval '60 seconds'
        WHERE id=$1 AND tenant_id=$2`,
        [claim.request.id, tenantA],
      );

      const outbox = await owner.query<{ payload: Record<string, unknown> }>(
        'SELECT payload FROM commander_outbox WHERE id=$1 AND tenant_id=$2',
        [claim.outboxMessageId, tenantA],
      );
      assert.ok(outbox.rows[0]);
      await owner.query(
        `UPDATE commander_outbox
          SET payload=jsonb_build_object('requestId','other-request','tenantId',$2::text)
        WHERE id=$1 AND tenant_id=$2`,
        [claim.outboxMessageId, tenantA],
      );
      await assert.rejects(
        adapterRepository.getAdapterOpsEvidenceContext({
          workerId: adapterId,
          workerGeneration: adapterGeneration,
          claimSecret: adapterSecret,
          tenantId: tenantA,
          runId: claim.request.compensationRunId,
          effectId: compensationEffectId,
          claimToken: claim.outboxClaimToken,
        }),
        /ADAPTER_OPS_EVIDENCE_CONTEXT_DENIED/,
      );
      await owner.query(
        'UPDATE commander_outbox SET payload=$1::jsonb WHERE id=$2 AND tenant_id=$3',
        [JSON.stringify(outbox.rows[0].payload), claim.outboxMessageId, tenantA],
      );

      const response = { compensated: true };
      const evidence = await terminalEvidence(claim, compensationEffectId, 'COMPLETED', response);
      const terminalInput = {
        workerId: adapterId,
        workerGeneration: adapterGeneration,
        claimSecret: adapterSecret,
        tenantId: tenantA,
        runId: claim.request.compensationRunId,
        stepId: claim.request.compensationStepId,
        effectId: compensationEffectId,
        requestId: claim.request.id,
        requestClaimToken: claim.request.claimToken!,
        outboxMessageId: claim.outboxMessageId,
        outboxClaimToken: claim.outboxClaimToken,
        lease: claim.lease,
        actor: adapterId,
        response,
        evidence,
      };
      assert.equal(
        await adapterRepository.completeCompensationEffectWithEvidence({
          ...terminalInput,
          requestId: `${claim.request.id}-wrong`,
        }),
        null,
      );
      assert.equal(
        await adapterRepository.completeCompensationEffectWithEvidence({
          ...terminalInput,
          lease: { ...terminalInput.lease, fencingEpoch: terminalInput.lease.fencingEpoch + 1 },
        }),
        null,
      );
      await assert.rejects(
        adapterRepository.completeCompensationEffectWithEvidence({
          ...terminalInput,
          evidence: { ...evidence, actionDigest: '0'.repeat(64) },
        }),
        /EVIDENCE_RECORD_BINDING_INVALID/,
      );
      const rejectedState = await owner.query<{
        state: string;
        receipts: string;
        events: string;
        outbox: string;
      }>(
        `SELECT effect.state,
              (SELECT count(*)::text FROM commander_evidence_receipts receipt
                WHERE receipt.tenant_id=effect.tenant_id
                  AND receipt.bundle_id='evidence_'||effect.id) AS receipts,
              (SELECT count(*)::text FROM commander_events event
                WHERE event.tenant_id=effect.tenant_id AND event.aggregate_id=effect.id
                  AND event.type='effect.completed') AS events,
              (SELECT count(*)::text FROM commander_outbox outbox
                JOIN commander_events event ON event.id=outbox.event_id
               WHERE outbox.tenant_id=effect.tenant_id AND event.aggregate_id=effect.id
                 AND event.type='effect.completed') AS outbox
         FROM commander_effects effect WHERE effect.id=$1 AND effect.tenant_id=$2`,
        [compensationEffectId, tenantA],
      );
      assert.deepEqual(rejectedState.rows[0], {
        state: 'ADMITTED',
        receipts: '0',
        events: '0',
        outbox: '0',
      });
      assert.equal(
        (await adapterRepository.completeCompensationEffectWithEvidence(terminalInput))?.state,
        'COMPLETED',
      );
      const completedWrites = await owner.query<{
        receipts: string;
        events: string;
        outbox: string;
      }>(
        `SELECT
         (SELECT count(*)::text FROM commander_evidence_receipts
           WHERE tenant_id=$2 AND bundle_id='evidence_'||$1) AS receipts,
         (SELECT count(*)::text FROM commander_events
           WHERE tenant_id=$2 AND aggregate_id=$1 AND type='effect.completed') AS events,
         (SELECT count(*)::text FROM commander_outbox o JOIN commander_events e ON e.id=o.event_id
           WHERE o.tenant_id=$2 AND e.aggregate_id=$1 AND e.type='effect.completed') AS outbox`,
        [compensationEffectId, tenantA],
      );
      assert.deepEqual(completedWrites.rows[0], { receipts: '1', events: '1', outbox: '1' });
      assert.deepEqual(
        await adapterRepository.finalizeCompensation({
          workerId: adapterId,
          workerGeneration: adapterGeneration,
          claimSecret: adapterSecret,
          tenantId: tenantA,
          requestId: claim.request.id,
          effectId: compensationEffectId,
          disposition: 'COMPLETED',
          actor: adapterId,
          outboxMessageId: claim.outboxMessageId,
          outboxClaimToken: claim.outboxClaimToken,
          response,
          evidence,
        }),
        { applied: true, disposition: 'COMPLETED', replayed: false },
      );
      const terminalRunEvents = await owner.query<{
        type: string;
        sequence: string;
        duplicate_count: string;
        run_version: string;
      }>(
        `SELECT event.type, event.sequence::text AS sequence,
              count(*) OVER (PARTITION BY event.aggregate_id, event.sequence)::text AS duplicate_count,
              run.version::text AS run_version
         FROM commander_events event
         JOIN commander_runs run
           ON run.id=event.aggregate_id AND run.tenant_id=event.tenant_id
        WHERE event.tenant_id=$1 AND event.aggregate_type='run'
          AND event.aggregate_id=$2
          AND event.type IN ('run.compensating','run.compensated')
        ORDER BY event.sequence`,
        [tenantA, claim.request.originalRunId],
      );
      assert.deepEqual(
        terminalRunEvents.rows.map(({ type }) => type),
        ['run.compensating', 'run.compensated'],
      );
      assert.equal(
        new Set(terminalRunEvents.rows.map(({ sequence }) => sequence)).size,
        terminalRunEvents.rows.length,
        'terminal run events must use distinct aggregate sequences',
      );
      assert.ok(
        terminalRunEvents.rows.every(({ duplicate_count }) => duplicate_count === '1'),
        'terminal run event sequences must be unique in durable history',
      );
      assert.equal(
        terminalRunEvents.rows.at(-1)?.sequence,
        terminalRunEvents.rows.at(-1)?.run_version,
        'the final terminal event must match the durable run version',
      );
      await assert.rejects(
        adapter.query('SELECT * FROM commander_effects WHERE tenant_id=$1', [tenantA]),
        /permission denied/i,
      );
    });

    it('admits a compensate.* effect through admitEffect from the compact producer payload', async () => {
      // The real producer (`request_compensation`) writes only a compact outbox
      // payload plus the durable compensation request/authorization rows — never
      // a sealed authorization in run metadata. `admitEffect` must resolve the
      // governed authorization from that durable evidence, exactly like the
      // dedicated `admitCompensationEffect` RPC does.
      const { claim, compensationEffectId } =
        await claimGovernedCompensation('admit-effect-router');
      const idempotencyKey = compensationIdempotencyKey(claim);
      const admitted = await adapterRepository.admitEffect({
        id: compensationEffectId,
        runId: claim.request.compensationRunId,
        stepId: claim.request.compensationStepId,
        tenantId: tenantA,
        type: claim.authorization.compensationEffectType,
        idempotencyKey,
        policyDecisionId: claim.authorization.policyDecisionId,
        policySnapshotId: claim.authorization.policySnapshotId,
        actionDigest: claim.authorization.actionDigest,
        request: {
          originalEffectId: claim.request.originalEffectId,
          destination: claim.request.destination,
          forwardResponse: claim.forwardResponse,
          compensationPatch: claim.authorization.compensationPatch,
        },
        lease: claim.lease,
        compensationBinding: {
          authorizationId: claim.authorization.id,
          requestId: claim.request.id,
          claimToken: claim.request.claimToken!,
          requestClaimToken: claim.request.claimToken!,
          outboxMessageId: claim.outboxMessageId,
          outboxClaimToken: claim.outboxClaimToken,
        },
        actor: adapterId,
      });
      assert.equal(admitted.admitted, true, JSON.stringify(admitted));
      const durable = await owner.query<{ state: string; idempotency_key: string }>(
        'SELECT state, idempotency_key FROM commander_effects WHERE id=$1 AND tenant_id=$2',
        [compensationEffectId, tenantA],
      );
      assert.deepEqual(durable.rows[0], { state: 'ADMITTED', idempotency_key: idempotencyKey });

      // Fail-closed: a tampered outbox claim token must be refused, not admitted.
      const refused = await adapterRepository.admitEffect({
        id: compensationEffectId,
        runId: claim.request.compensationRunId,
        stepId: claim.request.compensationStepId,
        tenantId: tenantA,
        type: claim.authorization.compensationEffectType,
        idempotencyKey,
        policyDecisionId: claim.authorization.policyDecisionId,
        policySnapshotId: claim.authorization.policySnapshotId,
        actionDigest: claim.authorization.actionDigest,
        request: {
          originalEffectId: claim.request.originalEffectId,
          destination: claim.request.destination,
          forwardResponse: claim.forwardResponse,
          compensationPatch: claim.authorization.compensationPatch,
        },
        lease: claim.lease,
        compensationBinding: {
          authorizationId: claim.authorization.id,
          requestId: claim.request.id,
          claimToken: claim.request.claimToken!,
          requestClaimToken: claim.request.claimToken!,
          outboxMessageId: claim.outboxMessageId,
          outboxClaimToken: `${claim.outboxClaimToken}-wrong`,
        },
        actor: adapterId,
      });
      assert.deepEqual(refused, { admitted: false, reason: 'COMPENSATION_ADMISSION_UNAVAILABLE' });
    });

    it('serializes concurrent terminal finalization into one durable outcome', async () => {
      const { claim, compensationEffectId } = await claimAdmittedCompensation('finalize-race');
      const response = { compensated: true, source: 'race' };
      const evidence = await terminalEvidence(claim, compensationEffectId, 'COMPLETED', response);
      const completionInput = {
        workerId: adapterId,
        workerGeneration: adapterGeneration,
        claimSecret: adapterSecret,
        tenantId: tenantA,
        runId: claim.request.compensationRunId,
        stepId: claim.request.compensationStepId,
        effectId: compensationEffectId,
        requestId: claim.request.id,
        requestClaimToken: claim.request.claimToken!,
        outboxMessageId: claim.outboxMessageId,
        outboxClaimToken: claim.outboxClaimToken,
        lease: claim.lease,
        actor: adapterId,
        response,
        evidence,
      };
      assert.equal(
        (await adapterRepository.completeCompensationEffectWithEvidence(completionInput))?.state,
        'COMPLETED',
      );

      const finalizationInput = {
        workerId: completionInput.workerId,
        workerGeneration: completionInput.workerGeneration,
        claimSecret: completionInput.claimSecret,
        tenantId: completionInput.tenantId,
        requestId: completionInput.requestId,
        effectId: completionInput.effectId,
        disposition: 'COMPLETED' as const,
        actor: completionInput.actor,
        outboxMessageId: completionInput.outboxMessageId,
        outboxClaimToken: completionInput.outboxClaimToken,
        response,
        evidence,
      };
      const results = await Promise.all([
        adapterRepository.finalizeCompensation(finalizationInput),
        adapterRepository.finalizeCompensation(finalizationInput),
      ]);
      // `CompensationMutationResult` is a discriminated union on `applied`, so
      // narrow before reading `replayed` — and say plainly that a refusal here
      // is a failure, rather than letting the type error hide that intent.
      assert.ok(
        results.every((result) => result.applied),
        `both concurrent finalizers must report applied, got ${JSON.stringify(results)}`,
      );
      assert.deepEqual(
        results.map((result) => (result.applied ? result.replayed : false)).sort(),
        [false, true],
        'one concurrent finalizer must apply and the other must replay',
      );

      const writes = await owner.query<{
        receipts: string;
        terminal_events: string;
        terminal_outbox: string;
        terminal_sequence: string;
        duplicate_sequences: string;
      }>(
        `SELECT
         (SELECT count(*)::text FROM commander_compensation_finalization_receipts
           WHERE outbox_message_id=$1) AS receipts,
         (SELECT count(*)::text FROM commander_events
           WHERE tenant_id=$2 AND aggregate_id=$3 AND type='compensation.completed') AS terminal_events,
         (SELECT count(*)::text FROM commander_outbox outbox
           JOIN commander_events event ON event.id=outbox.event_id
          WHERE outbox.tenant_id=$2 AND event.aggregate_id=$3 AND event.type='compensation.completed') AS terminal_outbox,
         (SELECT max(sequence)::text FROM commander_events
           WHERE tenant_id=$2 AND aggregate_type='effect' AND aggregate_id=$3
             AND type='compensation.completed') AS terminal_sequence,
         (SELECT (count(*) - count(DISTINCT sequence))::text FROM commander_events
           WHERE tenant_id=$2 AND aggregate_type='effect' AND aggregate_id=$3) AS duplicate_sequences`,
        [claim.outboxMessageId, tenantA, compensationEffectId],
      );
      assert.deepEqual(
        {
          receipts: writes.rows[0]?.receipts,
          terminal_events: writes.rows[0]?.terminal_events,
          terminal_outbox: writes.rows[0]?.terminal_outbox,
          duplicate_sequences: writes.rows[0]?.duplicate_sequences,
        },
        {
          receipts: '1',
          terminal_events: '1',
          terminal_outbox: '1',
          duplicate_sequences: '0',
        },
      );
      assert.ok(Number(writes.rows[0]?.terminal_sequence) > 0);
    });

    it('rejects stale leases in the legacy generic compensation completion fallback', async () => {
      const { claim, compensationEffectId } = await claimAdmittedCompensation('legacy-fenced');
      const completed = await ownerRepository.completeEffect(
        compensationEffectId,
        tenantA,
        { ...claim.lease, fencingEpoch: claim.lease.fencingEpoch + 1 },
        { compensated: true },
        adapterId,
      );

      assert.equal(completed, null, 'a stale compensation lease must not complete the effect');
      const state = await owner.query<{ state: string }>(
        'SELECT state FROM commander_effects WHERE id=$1 AND tenant_id=$2',
        [compensationEffectId, tenantA],
      );
      assert.equal(state.rows[0]?.state, 'ADMITTED');

      const validCompletion = await ownerRepository.completeEffect(
        compensationEffectId,
        tenantA,
        claim.lease,
        { compensated: true },
        adapterId,
      );
      assert.equal(validCompletion?.state, 'COMPLETED');
      const completionEvidence = await terminalEvidence(claim, compensationEffectId, 'COMPLETED', {
        compensated: true,
      });
      assert.deepEqual(
        await adapterRepository.finalizeCompensation({
          workerId: adapterId,
          workerGeneration: adapterGeneration,
          claimSecret: adapterSecret,
          tenantId: tenantA,
          requestId: claim.request.id,
          effectId: compensationEffectId,
          disposition: 'COMPLETED',
          actor: adapterId,
          outboxMessageId: claim.outboxMessageId,
          outboxClaimToken: claim.outboxClaimToken,
          response: { compensated: true },
          evidence: completionEvidence,
        }),
        { applied: true, disposition: 'COMPLETED', replayed: false },
      );
    });

    it('fails compensation effects with evidence through the fenced adapter-ops authority', async () => {
      const { claim, compensationEffectId } = await claimAdmittedCompensation('failed');
      const error = {
        code: 'REMOTE_REJECTED',
        message: 'provider rejected compensation',
        retryable: false,
      };
      const evidence = await terminalEvidence(claim, compensationEffectId, 'FAILED', error);
      const failed = await adapterRepository.failCompensationEffectWithEvidence({
        workerId: adapterId,
        workerGeneration: adapterGeneration,
        claimSecret: adapterSecret,
        tenantId: tenantA,
        runId: claim.request.compensationRunId,
        stepId: claim.request.compensationStepId,
        effectId: compensationEffectId,
        requestId: claim.request.id,
        requestClaimToken: claim.request.claimToken!,
        outboxMessageId: claim.outboxMessageId,
        outboxClaimToken: claim.outboxClaimToken,
        lease: claim.lease,
        actor: adapterId,
        error,
        evidence,
      });
      assert.equal(failed?.state, 'FAILED');
      const writes = await owner.query<{ receipts: string; events: string; outbox: string }>(
        `SELECT
         (SELECT count(*)::text FROM commander_evidence_receipts
           WHERE tenant_id=$2 AND bundle_id='evidence_'||$1) AS receipts,
         (SELECT count(*)::text FROM commander_events
           WHERE tenant_id=$2 AND aggregate_id=$1 AND type='effect.failed') AS events,
         (SELECT count(*)::text FROM commander_outbox o JOIN commander_events e ON e.id=o.event_id
           WHERE o.tenant_id=$2 AND e.aggregate_id=$1 AND e.type='effect.failed') AS outbox`,
        [compensationEffectId, tenantA],
      );
      assert.deepEqual(writes.rows[0], { receipts: '1', events: '1', outbox: '1' });
    });
  },
);
