import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import type { KernelRepository } from './repository.js';
import type {
  ClaimedCompensationRequest,
  CompensationAuthorizationRecord,
  KernelEffect,
  RequestCompensationInput,
} from './types.js';
import type { KernelEvidenceRecord } from './evidenceRepository.js';
import { canonicalCompensationHash } from './ops/compensationAuthority.js';
import { deriveEffectIdempotencyKey } from '@praetor/effect-broker';
import { InMemoryKernelRepository } from './testing/inMemoryRepository.js';
import { SqliteKernelRepository } from './sqlite.js';
import {
  KERNEL_COMPENSATION_TERMINAL_EVENT_SEQUENCE_REPAIR_SQL,
  KERNEL_SIGNED_EVIDENCE_AUTHORITY_CLOSURE_SQL,
} from './evidenceSchema.js';
import {
  KERNEL_COMPENSATION_APPROVAL_BINDING_SQL,
  KERNEL_COMPENSATION_AUTHORIZATION_READ_SQL,
  KERNEL_COMPENSATION_METADATA_BINDING_SQL,
  KERNEL_COMPENSATION_RECONCILIATION_CLOSURE_SQL,
  KERNEL_COMPENSATION_PERSISTENCE_SQL,
  KERNEL_COMPENSATION_TERMINAL_CLOSURE_SQL,
} from './compensationSchema.js';
import { KERNEL_TASK2_RECONCILIATION_RPCS_SQL } from './task2Reconciliation.js';
import { KERNEL_MIGRATIONS } from './migrations.js';

// F-K1-18: the block below asserts compensation authority by regexing SQL text.
// Text that is present but never applied is inert, so pin the bodies to the
// checksummed migration descriptors that actually execute them.
const assertRegisteredMigration = (sql: string): void => {
  const registered = KERNEL_MIGRATIONS.filter((migration) => migration.sql === sql);
  assert.equal(
    registered.length,
    1,
    'each authority body must be applied by exactly one registered migration',
  );
  assert.equal(
    registered[0]!.checksum,
    createHash('sha256').update(sql).digest('hex'),
    'the migration checksum must pin this exact body',
  );
};

const TENANT = 'tenant-compensation';

describe('compensation terminal evidence schema', () => {
  it('persists signed evidence before finalization and synchronizes escalation truth', () => {
    assert.match(
      KERNEL_COMPENSATION_TERMINAL_CLOSURE_SQL,
      /ALTER FUNCTION public\.claim_compensation_request\(\s*text,text,text,bigint,text\s*\)\s+RENAME TO claim_compensation_request_pre_terminal_closure/i,
      'terminal closure must wrap the campaign2 five-argument public claim wrapper',
    );
    assert.doesNotMatch(
      KERNEL_COMPENSATION_TERMINAL_CLOSURE_SQL,
      /ALTER FUNCTION public\.claim_compensation_request\(\s*text,text,text,bigint,text,integer,timestamptz/i,
      'the terminal closure must not target a removed seven-argument public signature',
    );
    assert.match(
      KERNEL_SIGNED_EVIDENCE_AUTHORITY_CLOSURE_SQL,
      /CREATE OR REPLACE FUNCTION public\.finalize_compensation\(p_input jsonb\)[\s\S]*commander_insert_reconcile_evidence_v1[\s\S]*apply_task3_compensation_mutation/i,
    );
    assert.match(
      KERNEL_SIGNED_EVIDENCE_AUTHORITY_CLOSURE_SQL,
      /p_disposition='ESCALATED'[\s\S]*reconcile_disposition='ESCALATED'[\s\S]*reconcile_escalated_at/i,
    );
    assert.match(KERNEL_SIGNED_EVIDENCE_AUTHORITY_CLOSURE_SQL, /TERMINAL_EVIDENCE_REQUIRED/i);
    assert.match(
      KERNEL_COMPENSATION_PERSISTENCE_SQL,
      /v_request\.compensation_effect_id<>p_input->>'effectId'[\s\S]*v_effect\.id IS NULL[\s\S]*p_disposition<>'ESCALATED'/i,
    );
    assert.match(
      KERNEL_COMPENSATION_TERMINAL_CLOSURE_SQL,
      /claim_compensation_request_pre_terminal_closure[\s\S]*v_original_run_id[\s\S]*state IN \('PENDING','RUNNING','PAUSED','SUCCEEDED','FAILED','CANCELLED','COMPENSATING'\)/i,
    );
    assert.match(
      KERNEL_COMPENSATION_TERMINAL_CLOSURE_SQL,
      /apply_task3_compensation_mutation_pre_terminal_closure[\s\S]*v_event_id[\s\S]*'compensation\.completed'/i,
    );
    assert.match(
      KERNEL_COMPENSATION_TERMINAL_CLOSURE_SQL,
      /CREATE FUNCTION public\.claim_compensation_request\(\s*p_request_id text,p_outbox_message_id text,p_worker_id text,p_worker_generation bigint,\s*p_claim_secret text\s*\)[\s\S]*v_now timestamptz\s*:=\s*clock_timestamp\(\)/i,
      'terminal wrapper must expose the existing five-argument public signature and own its DB clock',
    );
    assert.match(
      KERNEL_COMPENSATION_TERMINAL_CLOSURE_SQL,
      /v_now timestamptz\s*:=\s*clock_timestamp\(\)/i,
      'terminal wrapper must own its claim clock in the database',
    );
    assert.match(
      KERNEL_COMPENSATION_TERMINAL_CLOSURE_SQL,
      /v_result\s*:=\s*public\.claim_compensation_request_pre_terminal_closure\(\s*p_request_id,p_outbox_message_id,p_worker_id,p_worker_generation,\s*p_claim_secret\s*\)/i,
      'terminal wrapper must call the five-argument pre-terminal claim',
    );
    assert.match(
      KERNEL_COMPENSATION_TERMINAL_CLOSURE_SQL,
      /p_disposition NOT IN \('COMPLETED','CONFIRMED_NOT_APPLIED'\)[\s\S]*IF p_disposition='COMPLETED' THEN[\s\S]*ELSE[\s\S]*state='FAILED'[\s\S]*state='COMPENSATING'/i,
    );
    for (const eventType of [
      'run.compensating',
      'run.compensated',
      'run.succeeded',
      'run.failed',
      'step.succeeded',
      'step.failed',
    ]) {
      assert.match(KERNEL_COMPENSATION_TERMINAL_CLOSURE_SQL, new RegExp(`'${eventType}'`));
    }
    const completedBranch = KERNEL_COMPENSATION_TERMINAL_CLOSURE_SQL.match(
      /IF p_disposition='COMPLETED' THEN([\s\S]*?)\n\s*ELSE/i,
    )?.[1];
    assert.ok(completedBranch, 'terminal closure must define a COMPLETED branch');
    assert.match(
      completedBranch,
      /SELECT state,\s*version\s+INTO v_original_run_state,\s*v_original_run_version[\s\S]*?FROM public\.commander_runs[\s\S]*?WHERE id=v_request\.original_run_id[\s\S]*?AND tenant_id=v_request\.tenant_id[\s\S]*?FOR UPDATE/i,
      'terminal closure must lock and inspect the original run state before finalization',
    );
    assert.doesNotMatch(
      completedBranch,
      /SELECT state, version INTO v_original_run_state, v_original_run_version[\s\S]*?AND state='COMPENSATED'\s+FOR UPDATE/i,
      'the state read must not narrow admission to COMPENSATED only',
    );
    assert.match(
      completedBranch,
      /IF NOT FOUND OR v_original_run_state NOT IN \('COMPENSATING','COMPENSATED'\) THEN[\s\S]*COMPENSATION_ORIGINAL_RUN_TERMINAL_TRANSITION_REJECTED/i,
      'only COMPENSATING or already COMPENSATED originals may close',
    );
    const originalTransition = completedBranch.match(
      /IF v_original_run_state='COMPENSATING' THEN([\s\S]*?)END IF;/i,
    )?.[1];
    assert.ok(originalTransition, 'COMPENSATING originals need a guarded terminal transition');
    assert.match(
      originalTransition,
      /UPDATE public\.commander_runs\s+SET state='COMPENSATED',version=version\+1[\s\S]*?AND state='COMPENSATING'\s+RETURNING version INTO v_original_run_version/i,
      'the guarded transition must run exactly once for a COMPENSATING original',
    );
    const originalStateBranches = KERNEL_COMPENSATION_TERMINAL_CLOSURE_SQL.match(
      /IF v_original_run_state='COMPENSATING' THEN([\s\S]*?)ELSE([\s\S]*?)END IF;/i,
    )?.[1];
    const alreadyCompensatedBranch = KERNEL_COMPENSATION_TERMINAL_CLOSURE_SQL.match(
      /IF v_original_run_state='COMPENSATING' THEN([\s\S]*?)ELSE([\s\S]*?)END IF;/i,
    )?.[2];
    assert.ok(originalStateBranches, 'terminal closure must define the original state branches');
    assert.ok(
      alreadyCompensatedBranch,
      'terminal closure must define the already COMPENSATED branch',
    );
    assert.match(
      alreadyCompensatedBranch,
      /IF NOT v_original_run_event_present THEN[\s\S]*?UPDATE public\.commander_runs AS original_run[\s\S]*?SET version=original_run\.version\+1[\s\S]*?state='COMPENSATED'[\s\S]*?RETURNING version INTO v_original_run_version/i,
      'a pre-closed COMPENSATED original must advance once before appending its terminal event',
    );
    assert.match(
      KERNEL_COMPENSATION_TERMINAL_CLOSURE_SQL,
      /v_original_run_event_present\s+boolean/i,
      'terminal closure must track whether the original terminal event already exists',
    );
    assert.match(
      KERNEL_COMPENSATION_TERMINAL_CLOSURE_SQL,
      /SELECT EXISTS\s*\([\s\S]*?aggregate_type='run'[\s\S]*?aggregate_id=v_request\.original_run_id[\s\S]*?type='run\.compensated'[\s\S]*?\)\s+INTO v_original_run_event_present/i,
      'terminal closure must inspect the existing original run terminal event before allocating a sequence',
    );
    assert.match(
      KERNEL_COMPENSATION_TERMINAL_CLOSURE_SQL,
      /IF NOT v_original_run_event_present THEN[\s\S]*?INSERT INTO public\.commander_events\([\s\S]*?v_original_run_event_id[\s\S]*?v_original_run_event_type/i,
      'terminal closure must omit the original event insert when a terminal event is already present',
    );
    assert.doesNotMatch(
      KERNEL_COMPENSATION_PERSISTENCE_SQL,
      /UPDATE public\.commander_runs\s+SET state='COMPENSATED'[\s\S]*?WHERE id=v_request\.original_run_id[\s\S]*?AND state='COMPENSATED'\s+RETURNING version/i,
    );
    assert.match(KERNEL_COMPENSATION_TERMINAL_CLOSURE_SQL, /state='SUCCEEDED',version=version\+1/i);
    assert.match(KERNEL_COMPENSATION_TERMINAL_CLOSURE_SQL, /state='FAILED',version=version\+1/i);
    assert.doesNotMatch(
      KERNEL_COMPENSATION_PERSISTENCE_SQL,
      /pre_terminal_closure|COMPENSATION_TERMINAL_EVENT_CONTEXT_MISSING/i,
    );
    assert.doesNotMatch(
      KERNEL_COMPENSATION_TERMINAL_CLOSURE_SQL,
      /CREATE OR REPLACE FUNCTION public\.(?:finalize_compensation|park_compensation_unknown)/i,
      'the forward closure must preserve evidence-aware functions already installed on upgrades',
    );
    assert.match(
      KERNEL_COMPENSATION_RECONCILIATION_CLOSURE_SQL,
      /apply_reconcile_effect_with_evidence_pre_compensation_closure[\s\S]*CREATE FUNCTION public\.apply_reconcile_effect_with_evidence_v1/i,
      'generic reconciliation must be wrapped only after evidence-aware authority is installed',
    );
    assert.match(
      KERNEL_COMPENSATION_RECONCILIATION_CLOSURE_SQL,
      /v_effect\.type NOT LIKE 'compensate\.%'[\s\S]*commander_compensation_requests/i,
      'only compensation effects may enter the compensation reconciliation closure',
    );
    assert.match(
      KERNEL_COMPENSATION_RECONCILIATION_CLOSURE_SQL,
      /state='COMPLETED'[\s\S]*state='SUCCEEDED',version=version\+1[\s\S]*state='COMPENSATED',version=version\+1/i,
      'applied compensation reconciliation must close both runs',
    );
    assert.match(
      KERNEL_COMPENSATION_RECONCILIATION_CLOSURE_SQL,
      /state='CONFIRMED_NOT_APPLIED'[\s\S]*state='FAILED',version=version\+1[\s\S]*run\.failed/i,
      'not-applied compensation reconciliation must fail both runs',
    );
    assert.match(
      KERNEL_COMPENSATION_RECONCILIATION_CLOSURE_SQL,
      /compensation\.completed[\s\S]*commander\.compensation\.completed/i,
      'applied reconciliation must emit the canonical compensation terminal event',
    );
    assert.match(
      KERNEL_TASK2_RECONCILIATION_RPCS_SQL,
      /RECONCILE_QUERY_UNSUPPORTED'[\s\S]*COMPENSATION_QUERY_UNSUPPORTED'/i,
      "generic reconciliation must accept the daemon's compensation query escalation reason",
    );
  });

  it('allocates the next effect event sequence after a retry or recovery event', () => {
    assert.match(
      KERNEL_COMPENSATION_TERMINAL_EVENT_SEQUENCE_REPAIR_SQL,
      /SELECT\s+COALESCE\(MAX\(sequence\),\s*0\)\s*\+\s*1[\s\S]*FROM\s+public\.commander_events[\s\S]*aggregate_type\s*=\s*'effect'[\s\S]*aggregate_id\s*=\s*v_effect\.id/i,
      'compensation terminal evidence must allocate from the aggregate history',
    );
    assert.doesNotMatch(
      KERNEL_COMPENSATION_TERMINAL_EVENT_SEQUENCE_REPAIR_SQL,
      /aggregate_type, aggregate_id, sequence, type[\s\S]*VALUES\s*\([\s\S]*'effect'[\s\S]*,\s*2\s*,/i,
      'a fixed sequence collides after a prior terminal attempt or recovery event',
    );
  });

  it('exposes authorization reads only through the tenant-bound app RPC', () => {
    assert.match(
      KERNEL_COMPENSATION_AUTHORIZATION_READ_SQL,
      /CREATE OR REPLACE FUNCTION public\.get_compensation_authorization\(\s*p_authorization_id text,\s*p_tenant_id text\s*\) RETURNS jsonb[\s\S]*commander_authenticated_app_tenant\(\) IS DISTINCT FROM p_tenant_id/i,
    );
    assert.match(
      KERNEL_COMPENSATION_AUTHORIZATION_READ_SQL,
      /REVOKE ALL ON FUNCTION public\.get_compensation_authorization\(text, text\)[\s\S]*FROM PUBLIC, commander_app, commander_worker, commander_adapter_ops[\s\S]*GRANT EXECUTE ON FUNCTION public\.get_compensation_authorization\(text, text\) TO commander_app/i,
    );
    assert.doesNotMatch(
      KERNEL_COMPENSATION_AUTHORIZATION_READ_SQL,
      /GRANT SELECT[\s\S]*commander_compensation_authorizations/i,
    );
  });

  it('rejects cross-tenant authorization reads before selecting durable state', () => {
    const rpc = KERNEL_COMPENSATION_AUTHORIZATION_READ_SQL;
    assert.match(
      rpc,
      /IF session_user <> 'commander_app'[\s\S]*commander_authenticated_app_tenant\(\) IS DISTINCT FROM p_tenant_id[\s\S]*THEN\s+RETURN NULL/i,
    );
    assert.match(
      rpc,
      /WHERE id = p_authorization_id AND tenant_id = p_tenant_id/i,
      'the lookup must remain tenant-qualified even after the context guard',
    );
    assert.doesNotMatch(
      rpc,
      /GRANT\s+SELECT\s+ON\s+(?:TABLE\s+)?(?:public\.)?commander_compensation_authorizations\s+TO\s+commander_(?:app|adapter_ops)/i,
      'authorization rows remain inaccessible outside the SECURITY DEFINER RPC',
    );
  });

  it('binds the approval projection to the five-argument public claim wrapper', () => {
    assert.match(
      KERNEL_COMPENSATION_APPROVAL_BINDING_SQL,
      /v_result := public\.claim_compensation_request\(\s*p_request_id,p_outbox_message_id,p_worker_id,p_worker_generation,\s*p_claim_secret\s*\)/i,
    );
    assert.doesNotMatch(
      KERNEL_COMPENSATION_APPROVAL_BINDING_SQL,
      /v_result := public\.claim_compensation_request\([\s\S]*p_lease_ttl_ms,p_now/i,
      'the v2 projection must not call the internal seven-argument implementation through the five-argument wrapper name',
    );
  });

  it('keeps the original destination bound through durable claim and admission', () => {
    assert.match(
      KERNEL_COMPENSATION_PERSISTENCE_SQL,
      /'destination',\s*v_effect\.request->'destination'/i,
      'durable claim output must carry the original effect destination',
    );
    assert.match(
      KERNEL_COMPENSATION_PERSISTENCE_SQL,
      /v_request_payload\s*:=\s*jsonb_build_object\(\s*'originalEffectId',v_request\.original_effect_id,\s*'destination',\s*v_original\.request->'destination'/i,
      'compensation admission must compare the destination-bound payload',
    );
  });

  it('binds legacy durable requests to an independently addressable evidence target', () => {
    assert.match(
      KERNEL_COMPENSATION_METADATA_BINDING_SQL,
      /ALTER FUNCTION public\.request_compensation\(text,text,text\)[\s\S]*RENAME TO request_compensation_pre_metadata_binding/i,
    );
    for (const field of [
      'schema',
      'authorizationId',
      'requestId',
      'tenantId',
      'originalRunId',
      'originalEffectId',
      'compensationRunId',
      'compensationStepId',
      'compensationEffectId',
      'actionDigest',
    ]) {
      assert.match(
        KERNEL_COMPENSATION_METADATA_BINDING_SQL,
        new RegExp(`'${field}'`),
        `metadata binding must persist ${field}`,
      );
    }
    assert.match(
      KERNEL_COMPENSATION_METADATA_BINDING_SQL,
      /UPDATE public\.commander_runs[\s\S]*metadata=v_metadata[\s\S]*WHERE id=v_request->>'compensation_run_id'/i,
    );
    assert.match(
      KERNEL_COMPENSATION_METADATA_BINDING_SQL,
      /NULLIF\(v_request->>'compensation_effect_id',[\s\S]*'compensationRunId',v_request->>'compensation_run_id',[\s\S]*'compensationStepId',v_request->>'compensation_step_id'/i,
      'legacy request rows use snake_case identifiers before Postgres JSON projection',
    );
    assert.match(
      KERNEL_COMPENSATION_METADATA_BINDING_SQL,
      /WHERE id=v_request->>'compensation_run_id' AND tenant_id=p_tenant_id[\s\S]*UPDATE public\.commander_runs[\s\S]*WHERE id=v_request->>'compensation_run_id'/i,
      'metadata must be written to the durable compensation run returned by the legacy RPC',
    );
  });

  it('applies the terminal-closure and signed-evidence authority bodies as checksummed migrations', () => {
    assertRegisteredMigration(KERNEL_COMPENSATION_TERMINAL_CLOSURE_SQL);
    assertRegisteredMigration(KERNEL_SIGNED_EVIDENCE_AUTHORITY_CLOSURE_SQL);
  });
});

interface Harness {
  repository: KernelRepository;
  seedWorker(
    id: string,
    tenantIds: string[],
    generation: number,
    options?: {
      claimSecret?: string;
      capabilities?: string[];
      identitySubject?: string;
      registeredAt?: Date;
      lastHeartbeatAt?: Date;
    },
  ): string;
  close(): void;
}

async function createHarness(kind: 'memory' | 'sqlite'): Promise<Harness> {
  if (kind === 'memory') {
    const repository = new InMemoryKernelRepository({ schedulerMode: false });
    return {
      repository,
      seedWorker: repository.seedTestWorker.bind(repository),
      close: () => {},
    };
  }
  const repository = new SqliteKernelRepository({
    path: ':memory:',
    allowMemory: true,
    schedulerMode: false,
  });
  await repository.initialize();
  return {
    repository,
    seedWorker: repository.seedTestWorker.bind(repository),
    close: () => repository.close(),
  };
}

async function completedForwardEffect(harness: Harness, suffix: string): Promise<KernelEffect> {
  const { repository, seedWorker } = harness;
  const now = new Date();
  seedWorker('reconcile-worker', [TENANT], 1, {
    capabilities: ['effect.reconcile'],
    identitySubject: 'db:commander_adapter_ops',
    registeredAt: new Date(now.getTime() - 10_000),
    lastHeartbeatAt: new Date(now.getTime() - 1_000),
  });
  seedWorker('compensation-worker', [TENANT], 1, {
    claimSecret: 'compensation-secret',
    capabilities: ['effect.compensate'],
    identitySubject: 'db:commander_adapter_ops',
    registeredAt: new Date(now.getTime() - 10_000),
    lastHeartbeatAt: new Date(now.getTime() - 1_000),
  });
  const executionSecret = seedWorker('execution-worker', [TENANT], 1, {
    capabilities: ['agent', 'tool'],
  });
  const runId = `forward-run-${suffix}`;
  const stepId = `forward-step-${suffix}`;
  const effectId = `forward-effect-${suffix}`;
  await repository.createRun(
    {
      id: runId,
      tenantId: TENANT,
      intentHash: `intent-${suffix}`,
      workGraphHash: `graph-${suffix}`,
      workGraphVersion: 'v1',
      policySnapshotId: 'forward-policy-v1',
      steps: [{ id: stepId, kind: 'tool' }],
    },
    'test',
  );
  const claimed = await repository.claimNextStep({
    workerId: 'execution-worker',
    workerGeneration: 1,
    claimSecret: executionSecret,
    leaseTtlMs: 60_000,
    tenantId: TENANT,
    capabilities: ['agent', 'tool'],
  });
  assert.ok(claimed?.lease);
  const admitted = await repository.admitEffect({
    id: effectId,
    runId,
    stepId,
    tenantId: TENANT,
    type: 'http.post',
    idempotencyKey: `forward-idempotency-${suffix}`,
    policyDecisionId: 'forward-decision-v1',
    policySnapshotId: 'forward-policy-v1',
    actionDigest: 'f'.repeat(64),
    request: { destination: 'https://example.test/resource', body: { suffix } },
    lease: claimed.lease,
    actor: 'execution-worker',
  });
  assert.equal(admitted.admitted, true);
  const response = { remoteId: `remote-${suffix}`, status: 'created' };
  if (!admitted.admitted) throw new Error('forward effect admission failed');
  const completed = await repository.completeEffectWithEvidence(
    effectId,
    TENANT,
    claimed.lease,
    response,
    'execution-worker',
    terminalEvidenceFor({ ...admitted.effect, state: 'COMPLETED' }, 'effect.completed'),
  );
  assert.ok(completed);
  await repository.completeStep({
    stepId,
    tenantId: TENANT,
    expectedVersion: claimed.version,
    lease: claimed.lease,
    output: response,
    actor: 'execution-worker',
  });
  return completed;
}

function authorizationFor(effect: KernelEffect): CompensationAuthorizationRecord {
  const compensationPatch = { remoteId: effect.response!.remoteId };
  return {
    id: `authorization-${effect.id}`,
    tenantId: TENANT,
    originalRunId: effect.runId,
    originalEffectId: effect.id,
    compensationEffectType: 'compensate.http.post',
    adapterVersion: 'adapter-v1',
    compensationPatch,
    forwardReceiptHash: canonicalCompensationHash(effect.response!),
    policyDecisionId: 'compensation-decision-v1',
    policySnapshotId: 'compensation-policy-v1',
    decision: 'allow',
    actionDigest: canonicalCompensationHash({
      type: 'compensate.http.post',
      originalEffectId: effect.id,
      adapterVersion: 'adapter-v1',
      destination: effect.request.destination,
      forwardResponse: effect.response!,
      compensationPatch,
    }),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

function terminalEvidenceFor(
  effect: KernelEffect,
  auditEventType = 'compensation.completed',
  projectedState: 'COMPLETED' | 'CONFIRMED_NOT_APPLIED' = 'COMPLETED',
): KernelEvidenceRecord {
  const bundleId = `evidence_${effect.id}`;
  const contentHash = 'e'.repeat(64);
  const signature = {
    algorithm: 'Ed25519' as const,
    keyId: 'compensation-test-key',
    signedAt: '2026-08-05T00:00:00.000Z',
    value: 'compensation-test-signature',
  };
  return {
    tenantId: effect.tenantId,
    runId: effect.runId,
    bundleId,
    actionDigest: effect.actionDigest,
    body: {
      bodyVersion: 'commander.evidence-body/v1',
      bundleId,
      actionDigest: effect.actionDigest,
      contentHash,
      terminalDisposition: projectedState === 'COMPLETED' ? 'SUCCEEDED' : 'FAILED',
      scope: { tenantId: effect.tenantId, runId: effect.runId, effectId: effect.id },
      effects: [{ effectId: effect.id, state: projectedState }],
      auditEvents: [{ type: auditEventType }],
      signature,
    },
    contentHash,
    signature,
    createdAt: '2026-08-05T00:00:00.000Z',
    anchoredAt: '2026-08-05T00:00:01.000Z',
    retentionUntil: '2027-08-05T00:00:00.000Z',
  };
}

async function claimedCompensation(harness: Harness, suffix: string) {
  const original = await completedForwardEffect(harness, suffix);
  const authorization = authorizationFor(original);
  await harness.repository.createCompensationAuthorization(authorization);
  const requested = await harness.repository.requestCompensation({
    tenantId: TENANT,
    authorizationId: authorization.id,
    actor: 'action-gateway',
  });
  assert.equal(requested.accepted, true, JSON.stringify(requested));
  if (!requested.accepted) throw new Error('compensation request rejected');

  const messages = await harness.repository.claimOutboxByTopic(
    'commander.kernel.compensation.requested',
    1,
    new Date(),
    {
      workerId: 'compensation-worker',
      workerGeneration: 1,
      claimSecret: 'compensation-secret',
    },
  );
  assert.equal(messages.length, 1);
  const claimed = await harness.repository.claimCompensationRequest({
    requestId: requested.request.id,
    outboxMessageId: messages[0]!.id,
    workerId: 'compensation-worker',
    workerGeneration: 1,
    claimSecret: 'compensation-secret',
  });
  if (!claimed?.request.compensationEffectId) throw new Error('compensation claim rejected');
  const compensationEffectId = claimed.request.compensationEffectId;
  const admissionInput = {
    id: compensationEffectId,
    runId: claimed.request.compensationRunId,
    stepId: claimed.request.compensationStepId,
    tenantId: TENANT,
    type: claimed.authorization.compensationEffectType,
    idempotencyKey: deriveEffectIdempotencyKey({
      tenantId: claimed.request.tenantId,
      runId: claimed.request.compensationRunId,
      stepId: claimed.request.compensationStepId,
      effectId: compensationEffectId,
      request: {
        originalEffectId: claimed.request.originalEffectId,
        destination: claimed.request.destination,
        forwardResponse: claimed.forwardResponse,
        compensationPatch: claimed.authorization.compensationPatch,
      },
    }),
    policyDecisionId: claimed.authorization.policyDecisionId,
    policySnapshotId: claimed.authorization.policySnapshotId,
    actionDigest: claimed.authorization.actionDigest,
    request: {
      originalEffectId: claimed.request.originalEffectId,
      destination: claimed.request.destination,
      forwardResponse: claimed.forwardResponse,
      compensationPatch: claimed.authorization.compensationPatch,
    },
    lease: claimed.lease,
    requestId: claimed.request.id,
    requestClaimToken: claimed.request.claimToken!,
    outboxMessageId: claimed.outboxMessageId,
    outboxClaimToken: claimed.outboxClaimToken,
    actor: 'compensation-worker',
  };
  return { admissionInput, claimed, compensationEffectId, original };
}

async function admittedCompensation(harness: Harness, suffix: string) {
  const { admissionInput, claimed, compensationEffectId, original } = await claimedCompensation(
    harness,
    suffix,
  );
  assert.deepEqual(
    await harness.repository.admitCompensationEffect({
      ...admissionInput,
      runId: original.runId,
      stepId: original.stepId,
    }),
    { admitted: false, reason: 'COMPENSATION_ADMISSION_UNAVAILABLE' },
  );
  const admitted = await harness.repository.admitCompensationEffect(admissionInput);
  if (!admitted.admitted) throw new Error(`compensation admission rejected: ${admitted.reason}`);
  return { admitted: admitted.effect, claimed, compensationEffectId, original };
}

for (const kind of ['memory', 'sqlite'] as const) {
  describe(`separate compensation authority (${kind})`, () => {
    it('requires a persisted authorization reference and rejects the retired rich payload', async () => {
      const harness = await createHarness(kind);
      try {
        const original = await completedForwardEffect(harness, 'retired-payload');
        const legacyPayload = {
          tenantId: TENANT,
          originalRunId: original.runId,
          originalEffectId: original.id,
          forwardReceipt: original.response!,
          adapterVersion: 'adapter-v1',
          compensationEffectType: 'compensate.http.post',
          compensationPatch: { remoteId: original.response!.remoteId },
          policyDecisionId: 'compensation-decision-v1',
          policySnapshotId: 'compensation-policy-v1',
          actionDigest: 'caller-controlled',
          decisionEffect: 'allow',
          authorizationExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          approvalBinding: null,
          actor: 'caller',
        };

        const result = await harness.repository.requestCompensation(
          legacyPayload as unknown as RequestCompensationInput,
        );
        assert.equal(result.accepted, false);
        assert.equal(result.accepted ? null : result.reason, 'AUTHORIZATION_NOT_FOUND');
      } finally {
        harness.close();
      }
    });

    it('persists authorization before request and replays only the immutable reference', async () => {
      const harness = await createHarness(kind);
      try {
        const original = await completedForwardEffect(harness, 'canonical-reference');
        const authorization = authorizationFor(original);
        const created = await harness.repository.createCompensationAuthorization(authorization);
        assert.equal(created.replayed, false);

        const requested = await harness.repository.requestCompensation({
          tenantId: TENANT,
          authorizationId: authorization.id,
          actor: 'action-gateway',
        });
        assert.equal(requested.accepted, true, JSON.stringify(requested));
        if (!requested.accepted) return;
        assert.equal(requested.request.authorizationId, authorization.id);
        assert.equal(requested.request.originalEffectId, original.id);

        const compensationRun = await harness.repository.getRun(
          requested.request.compensationRunId,
          TENANT,
        );
        const compensationAuthorization = (
          compensationRun?.metadata.compensation as
            { authorization?: Record<string, unknown> } | undefined
        )?.authorization;
        assert.equal(compensationAuthorization?.schema, 'commander.compensation/v1');
        assert.equal(compensationAuthorization?.authorizationId, authorization.id);
        assert.equal(compensationAuthorization?.requestId, requested.request.id);
        assert.equal(compensationAuthorization?.tenantId, TENANT);
        assert.equal(compensationAuthorization?.originalRunId, original.runId);
        assert.equal(compensationAuthorization?.originalEffectId, original.id);
        assert.equal(
          compensationAuthorization?.compensationRunId,
          requested.request.compensationRunId,
        );
        assert.equal(
          compensationAuthorization?.compensationStepId,
          requested.request.compensationStepId,
        );
        assert.equal(
          compensationAuthorization?.compensationEffectId,
          `effect_${canonicalCompensationHash({
            requestId: requested.request.id,
            originalEffectId: original.id,
          }).slice(0, 40)}`,
        );
        assert.equal(compensationAuthorization?.actionDigest, authorization.actionDigest);

        const replay = await harness.repository.requestCompensation({
          tenantId: TENANT,
          authorizationId: authorization.id,
          actor: 'action-gateway',
        });
        assert.equal(replay.accepted && replay.replayed, true);
        assert.equal(
          await harness.repository.getCompensationAuthorization(authorization.id, 'tenant-other'),
          null,
        );
      } finally {
        harness.close();
      }
    });

    it('does not let a generic tool worker claim a governed compensation step', async () => {
      const harness = await createHarness(kind);
      try {
        const original = await completedForwardEffect(harness, `worker-isolation-${kind}`);
        const authorization = authorizationFor(original);
        await harness.repository.createCompensationAuthorization(authorization);
        const requested = await harness.repository.requestCompensation({
          tenantId: TENANT,
          authorizationId: authorization.id,
          actor: 'action-gateway',
        });
        assert.equal(requested.accepted, true, JSON.stringify(requested));
        if (!requested.accepted) return;

        const replacementSecret = harness.seedWorker('replacement-tool-worker', [TENANT], 1, {
          capabilities: ['tool'],
        });
        const claimed = await harness.repository.claimNextStep({
          workerId: 'replacement-tool-worker',
          workerGeneration: 1,
          claimSecret: replacementSecret,
          leaseTtlMs: 15_000,
          tenantId: TENANT,
          capabilities: ['tool'],
        });

        assert.equal(claimed, null);
        assert.equal(
          (await harness.repository.getRun(requested.request.compensationRunId, TENANT))?.state,
          'PENDING',
        );
        assert.equal(
          (await harness.repository.getStep(requested.request.compensationStepId, TENANT))?.state,
          'PENDING',
        );
      } finally {
        harness.close();
      }
    });

    it('atomically escalates a rejected claim before an effect is admitted', async () => {
      const harness = await createHarness(kind);
      try {
        const original = await completedForwardEffect(harness, `pre-admission-${kind}`);
        const authorization = authorizationFor(original);
        await harness.repository.createCompensationAuthorization(authorization);
        const requested = await harness.repository.requestCompensation({
          tenantId: TENANT,
          authorizationId: authorization.id,
          actor: 'action-gateway',
        });
        assert.equal(requested.accepted, true, JSON.stringify(requested));
        if (!requested.accepted) return;

        const messages = await harness.repository.claimOutboxByTopic(
          'commander.kernel.compensation.requested',
          1,
          new Date(),
          {
            workerId: 'compensation-worker',
            workerGeneration: 1,
            claimSecret: 'compensation-secret',
          },
        );
        assert.equal(messages.length, 1);
        const claimed = await harness.repository.claimCompensationRequest({
          requestId: requested.request.id,
          outboxMessageId: messages[0]!.id,
          workerId: 'compensation-worker',
          workerGeneration: 1,
          claimSecret: 'compensation-secret',
        });
        assert.ok(claimed?.request.compensationEffectId);

        const result = await harness.repository.finalizeCompensation({
          workerId: 'compensation-worker',
          workerGeneration: 1,
          claimSecret: 'compensation-secret',
          tenantId: TENANT,
          requestId: claimed.request.id,
          effectId: claimed.request.compensationEffectId,
          disposition: 'ESCALATED',
          actor: 'compensation-worker',
          outboxMessageId: claimed.outboxMessageId,
          outboxClaimToken: claimed.outboxClaimToken,
          response: { reason: 'COMPENSATION_ADAPTER_UNREGISTERED' },
        });

        assert.deepEqual(result, { applied: true, disposition: 'ESCALATED', replayed: false });
        assert.equal(
          await harness.repository.getEffect(claimed.request.compensationEffectId, TENANT),
          null,
        );
        assert.equal(
          (await harness.repository.getStep(claimed.request.compensationStepId, TENANT))?.state,
          'WAITING_FOR_HUMAN',
        );
        assert.equal(
          (await harness.repository.getRun(claimed.request.compensationRunId, TENANT))?.state,
          'COMPENSATING',
        );
        assert.equal(
          (
            await harness.repository.claimOutboxByTopic(
              'commander.kernel.compensation.requested',
              1,
              new Date('9999-12-31T23:59:59.999Z'),
              {
                workerId: 'compensation-worker',
                workerGeneration: 1,
                claimSecret: 'compensation-secret',
              },
            )
          ).length,
          0,
        );
      } finally {
        harness.close();
      }
    });
  });
}

describe('in-memory compensation transition history', () => {
  it('versions both runs and emits run.compensating when a request is first claimed', async () => {
    const harness = await createHarness('memory');
    try {
      const { claimed, original } = await claimedCompensation(harness, 'claim-transition-history');
      const compensationRun = await harness.repository.getRun(
        claimed.request.compensationRunId,
        TENANT,
      );
      const originalRun = await harness.repository.getRun(original.runId, TENANT);
      assert.equal(compensationRun?.version, 2);
      assert.equal(originalRun?.version, 4);

      const compensationEvents = await harness.repository.listEvents(
        claimed.request.compensationRunId,
        TENANT,
      );
      const originalEvents = await harness.repository.listEvents(original.runId, TENANT);
      assert.equal(
        compensationEvents.some(
          (event) =>
            event.aggregateType === 'run' &&
            event.aggregateId === claimed.request.compensationRunId &&
            event.sequence === compensationRun?.version &&
            event.type === 'run.compensating',
        ),
        true,
      );
      assert.equal(
        originalEvents.some(
          (event) =>
            event.aggregateType === 'run' &&
            event.aggregateId === original.runId &&
            event.sequence === originalRun?.version &&
            event.type === 'run.compensating',
        ),
        true,
      );
    } finally {
      harness.close();
    }
  });

  for (const disposition of ['COMPLETED', 'CONFIRMED_NOT_APPLIED'] as const) {
    it(`increments terminal aggregate versions and emits canonical events for ${disposition}`, async () => {
      const harness = await createHarness('memory');
      try {
        const { admitted, claimed, compensationEffectId, original } = await admittedCompensation(
          harness,
          `terminal-transition-history-${disposition}`,
        );
        if (disposition === 'COMPLETED') {
          const response = { compensated: true };
          const evidence = terminalEvidenceFor({ ...admitted, state: 'COMPLETED' });
          assert.ok(
            await harness.repository.completeEffectWithEvidence(
              compensationEffectId,
              TENANT,
              claimed.lease,
              response,
              'compensation-worker',
              evidence,
            ),
          );
          const beforeRun = await harness.repository.getRun(
            claimed.request.compensationRunId,
            TENANT,
          );
          const beforeOriginal = await harness.repository.getRun(original.runId, TENANT);
          const beforeStep = await harness.repository.getStep(
            claimed.request.compensationStepId,
            TENANT,
          );
          assert.deepEqual(
            await harness.repository.finalizeCompensation({
              workerId: 'compensation-worker',
              workerGeneration: 1,
              claimSecret: 'compensation-secret',
              tenantId: TENANT,
              requestId: claimed.request.id,
              effectId: compensationEffectId,
              disposition,
              actor: 'compensation-worker',
              outboxMessageId: claimed.outboxMessageId,
              outboxClaimToken: claimed.outboxClaimToken,
              response,
              evidence,
            }),
            { applied: true, disposition, replayed: false },
          );
          await assertTerminalTransitionHistory(
            harness,
            claimed,
            original.runId,
            beforeRun!.version,
            beforeOriginal!.version,
            beforeStep!.version,
            'SUCCEEDED',
            'COMPENSATED',
            'step.succeeded',
            'run.succeeded',
            'run.compensated',
          );
          return;
        }

        assert.ok(
          await harness.repository.markEffectCompletionUnknown({
            effectId: compensationEffectId,
            tenantId: TENANT,
            reason: 'transport result unknown',
            lease: claimed.lease,
            actor: 'compensation-worker',
          }),
        );
        const response = { status: 'not_applied' };
        const evidence = terminalEvidenceFor(
          { ...admitted, state: 'CONFIRMED_NOT_APPLIED' },
          'effect.confirmed_not_applied',
          'CONFIRMED_NOT_APPLIED',
        );
        const beforeRun = await harness.repository.getRun(
          claimed.request.compensationRunId,
          TENANT,
        );
        const beforeOriginal = await harness.repository.getRun(original.runId, TENANT);
        const beforeStep = await harness.repository.getStep(
          claimed.request.compensationStepId,
          TENANT,
        );
        assert.deepEqual(
          await harness.repository.finalizeCompensation({
            workerId: 'compensation-worker',
            workerGeneration: 1,
            claimSecret: 'compensation-secret',
            tenantId: TENANT,
            requestId: claimed.request.id,
            effectId: compensationEffectId,
            disposition,
            actor: 'compensation-worker',
            outboxMessageId: claimed.outboxMessageId,
            outboxClaimToken: claimed.outboxClaimToken,
            response,
            evidence,
          }),
          { applied: true, disposition, replayed: false },
        );
        await assertTerminalTransitionHistory(
          harness,
          claimed,
          original.runId,
          beforeRun!.version,
          beforeOriginal!.version,
          beforeStep!.version,
          'FAILED',
          'FAILED',
          'step.failed',
          'run.failed',
          'run.failed',
        );
      } finally {
        harness.close();
      }
    });
  }
});

async function assertTerminalTransitionHistory(
  harness: Harness,
  claimed: ClaimedCompensationRequest,
  originalRunId: string,
  previousCompensationRunVersion: number,
  previousOriginalRunVersion: number,
  previousStepVersion: number,
  compensationRunState: 'SUCCEEDED' | 'FAILED',
  originalRunState: 'COMPENSATED' | 'FAILED',
  stepEventType: 'step.succeeded' | 'step.failed',
  compensationRunEventType: 'run.succeeded' | 'run.failed',
  originalRunEventType: 'run.compensated' | 'run.failed',
): Promise<void> {
  const compensationRun = await harness.repository.getRun(
    claimed.request.compensationRunId,
    TENANT,
  );
  const originalRun = await harness.repository.getRun(originalRunId, TENANT);
  const step = await harness.repository.getStep(claimed.request.compensationStepId, TENANT);
  assert.equal(compensationRun?.state, compensationRunState);
  assert.equal(compensationRun?.version, previousCompensationRunVersion + 1);
  assert.equal(originalRun?.state, originalRunState);
  assert.equal(originalRun?.version, previousOriginalRunVersion + 1);
  assert.equal(step?.version, previousStepVersion + 1);

  const compensationEvents = await harness.repository.listEvents(
    claimed.request.compensationRunId,
    TENANT,
  );
  const originalEvents = await harness.repository.listEvents(originalRunId, TENANT);
  assert.equal(
    compensationEvents.some(
      (event) =>
        event.aggregateType === 'step' &&
        event.aggregateId === claimed.request.compensationStepId &&
        event.sequence === step?.version &&
        event.type === stepEventType,
    ),
    true,
  );
  assert.equal(
    compensationEvents.some(
      (event) =>
        event.aggregateType === 'run' &&
        event.aggregateId === claimed.request.compensationRunId &&
        event.sequence === compensationRun?.version &&
        event.type === compensationRunEventType,
    ),
    true,
  );
  assert.equal(
    originalEvents.some(
      (event) =>
        event.aggregateType === 'run' &&
        event.aggregateId === originalRunId &&
        event.sequence === originalRun?.version &&
        event.type === originalRunEventType,
    ),
    true,
  );
}
