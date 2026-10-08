import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { KERNEL_COMPENSATION_TOPIC, type RequestCompensationResult } from '@praetor/kernel';
import {
  adapterOpsCompensationMockPassed,
  notReadyControlledChangeEvidence,
  runAdapterOpsCompensationMock,
  runCellCompensationE2E,
  runComposeDemoCompensationFlow,
} from './l4-b-cell-compensation-e2e.js';

describe('l4-b-cell-compensation-e2e', () => {
  it('keeps Kubernetes controlled-change telemetry NOT_READY without a Kubernetes proof', () => {
    assert.equal(notReadyControlledChangeEvidence().proofVerdict, 'NOT_READY');
    assert.equal(notReadyControlledChangeEvidence().remoteOutcome, 'UNKNOWN');
  });

  it('mock mode proves adapter-ops compensation consumer (ENFORCED)', async () => {
    const evidence = await runAdapterOpsCompensationMock();
    assert.equal(evidence.consumed, 1, 'daemon must consume the governed compensation request');
    assert.equal(evidence.succeeded, 1, 'daemon must complete the governed compensation');
    assert.equal(evidence.escalated, 0, 'a valid authorization must not be escalated');
    assert.equal(evidence.executions, 1, 'compensation effect must execute exactly once');
    assert.equal(evidence.compensationEffectState, 'COMPLETED');
    assert.deepEqual(evidence.compensationEffectResponse, { state: 'closed' });
    assert.equal(evidence.compensationRunState, 'SUCCEEDED');
    assert.equal(evidence.remainingCompensationOutbox, 0, 'compensation outbox must be drained');
    assert.ok(evidence.genericClaimTopics.includes('commander.run.created'));
    assert.ok(!evidence.genericClaimTopics.includes(KERNEL_COMPENSATION_TOPIC));
    assert.equal(adapterOpsCompensationMockPassed(evidence), true);
  });

  it('runCellCompensationE2E mock verdict is ENFORCED-script-only when passing', async () => {
    const result = await runCellCompensationE2E({ mode: 'mock' });
    assert.equal(result.steps.S_mock_adapter_ops, true);
    assert.equal(result.passed, true);
    assert.equal(result.verdict, 'ENFORCED-script-only');
  });

  for (const scenario of [
    'success',
    'missing-receipt',
    'tamper-accepted',
    'replay-diverged',
    'request-replay-diverged',
    'approval-tamper-accepted',
  ] as const) {
    it(`canonical HTTP compensation flow: ${scenario}`, async () => {
      const originalFetch = globalThis.fetch;
      const requests: Array<{
        path: string;
        method: string;
        key: string | null;
        body: Record<string, unknown>;
      }> = [];
      const receiptHash = 'a'.repeat(64);
      let approvals = 0;
      let authorizations = 0;
      globalThis.fetch = async (input, init) => {
        const path = new URL(String(input)).pathname;
        const method = init?.method ?? 'GET';
        const body: Record<string, unknown> =
          typeof init?.body === 'string' ? JSON.parse(init.body) : {};
        requests.push({
          path,
          method,
          body,
          key: new Headers(init?.headers).get('Idempotency-Key'),
        });
        if (method === 'POST' && path === '/v1/actions') {
          assert.equal(body.effectType, 'connector.github.pull-request.create');
          assert.equal(body.destination, 'github://octo/repo/pulls');
          return Response.json(
            {
              action: {
                runId: 'forward-run',
                simulation: {
                  actionDigest: 'b'.repeat(64),
                  simulationId: 'simulation',
                  policySnapshotId: 'policy',
                },
              },
            },
            { status: 202 },
          );
        }
        if (path === '/v1/actions/forward-run/approve') return Response.json({}, { status: 200 });
        if (method === 'GET' && path === '/v1/actions/forward-run') {
          return Response.json({
            action: {
              state: 'SUCCEEDED',
              effectId: 'forward-effect',
              ...(scenario === 'missing-receipt' ? {} : { forwardReceiptHash: receiptHash }),
            },
          });
        }
        if (path === '/v1/actions/forward-run/compensations') {
          assert.equal(body.originalEffectId, 'forward-effect');
          assert.equal(body.adapterVersion, '1.1.0');
          assert.equal(body.compensationEffectType, 'compensate.github.pull-request.create');
          assert.deepEqual(body.compensationPatch, {});
          if (body.forwardReceiptHash !== receiptHash) {
            return Response.json(
              { error: { code: 'FORWARD_RECEIPT_MISMATCH' } },
              {
                status: scenario === 'tamper-accepted' ? 202 : 409,
              },
            );
          }
          authorizations += 1;
          return Response.json(
            {
              replayed: authorizations > 1,
              state: 'AWAITING_APPROVAL',
              authorization: {
                id:
                  scenario === 'replay-diverged' && authorizations > 1
                    ? 'other-authorization'
                    : 'authorization',
                actionDigest: 'c'.repeat(64),
                policySnapshotId: 'policy',
              },
            },
            { status: 202 },
          );
        }
        if (path === '/v1/actions/forward-run/compensations/authorization/approve') {
          if (body.actionDigest !== 'c'.repeat(64)) {
            return Response.json(
              { error: { code: 'APPROVAL_BINDING_MISMATCH' } },
              {
                status: scenario === 'approval-tamper-accepted' ? 202 : 409,
              },
            );
          }
          approvals += 1;
          return Response.json(
            {
              accepted: true,
              request: {
                id: 'request-id',
                tenantId: 'tenant-id',
                originalRunId: 'forward-run',
                originalEffectId: 'forward-effect',
                compensationStepId: 'compensation-step',
                adapterVersion: '1.1.0',
                compensationEffectType: 'compensate.github.pull-request.create',
                destination: 'github://octo/repo/pulls',
                compensationPatch: {},
                forwardReceiptHash: receiptHash,
                authorizationId: 'authorization',
                reconcilePolicy: {
                  maxAttempts: 3,
                  initialDelayMs: 1000,
                  maxDelayMs: 5000,
                  deadlineAt: '2026-10-01T00:00:00.000Z',
                },
                state: 'AUTHORIZED',
                compensationRunId:
                  scenario === 'request-replay-diverged' && approvals > 1
                    ? 'other-run'
                    : 'compensation-run',
              },
              replayed: approvals > 1,
            } satisfies RequestCompensationResult,
            { status: 202 },
          );
        }
        if (path === '/v1/runs/compensation-run/status')
          return Response.json({ state: 'SUCCEEDED' });
        assert.fail(`Unexpected request ${method} ${path}`);
      };
      try {
        const result = await runComposeDemoCompensationFlow('http://cell.test');
        assert.equal(result.compensated, scenario === 'success');
        if (scenario === 'success') {
          assert.equal(result.tamperRejected, true);
          assert.equal(result.authorizationReplayed, true);
          assert.equal(approvals, 2);
          assert.equal(result.requestReplayed, true);
          assert.equal(result.approvalTamperRejected, true);
          const writes = requests.filter((request) => request.method === 'POST');
          for (const write of writes) assert.match(write.key ?? '', /^[A-Za-z0-9._:-]{8,256}$/);
          assert.equal(requests.filter((request) => request.path === '/v1/actions').length, 1);
        }
        if (scenario === 'missing-receipt') assert.equal(approvals, 0);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  }

  it('does not claim PROVEN evidence for the compose harness', () => {
    const source = readFileSync(
      new URL('./l4-b-cell-compensation-e2e.ts', import.meta.url),
      'utf-8',
    );
    assert.doesNotMatch(source, /['"]PROVEN['"]/);
    assert.match(source, /verdict: passed \? 'ENFORCED' : 'BLOCKED'/);
  });
});
