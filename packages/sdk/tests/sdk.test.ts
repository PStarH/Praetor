import { describe, it } from 'node:test';
import assert from 'node:assert';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { CommanderClient } from '../src/commanderClient';
import {
  CommanderGatewayClient,
  CommanderGatewayError,
  verifyActionEvidence,
} from '../src/v1/client';

void describe('@praetor/sdk — types', () => {
  void it('types are valid — CommanderClientConfig', () => {
    const config: import('../src/types').CommanderClientConfig = {
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'gpt-4o',
      tokenBudget: 32000,
      baseUrl: 'https://api.openai.com',
    };
    assert.equal(config.provider, 'openai');
    assert.equal(config.tokenBudget, 32000);
  });

  void it('types are valid — ExecutionResult', () => {
    const result: import('../src/types').ExecutionResult = {
      status: 'SUCCESS',
      summary: 'Test run completed',
      steps: [],
      totalTokenUsage: 1000,
      totalDurationMs: 5000,
      error: undefined,
    };
    assert.equal(result.status, 'SUCCESS');
    assert.equal(result.totalTokenUsage, 1000);
  });

  void it('types are valid — ExecutionEvent', () => {
    const event: import('../src/types').ExecutionEvent = {
      type: 'agent.started',
      timestamp: new Date().toISOString(),
      data: { agentId: 'test' },
    };
    assert.equal(event.type, 'agent.started');
  });

  void it('types are valid — SystemStatus', () => {
    const status: import('../src/types').SystemStatus = {
      provider: 'openai',
      model: 'gpt-4o',
      uptime: '120s',
      totalRuns: 5,
      activeSessions: 1,
      memoryUsage: 123456789,
    };
    assert.equal(status.totalRuns, 5);
  });

  void it('types are valid — ExecutionStepSummary', () => {
    const step: import('../src/types').ExecutionStepSummary = {
      stepNumber: 1,
      action: 'test step',
      status: 'completed',
      tokenUsage: 500,
      durationMs: 1000,
    };
    assert.equal(step.stepNumber, 1);
    assert.equal(step.tokenUsage, 500);
  });
});

void describe('@praetor/sdk — CommanderClient', () => {
  void it('can be instantiated with default config', () => {
    const client = new CommanderClient();
    assert.ok(client);
    assert.equal(client.isConnected, false);
  });

  void it('throws on run before connect', async () => {
    const client = new CommanderClient();
    await assert.rejects(() => client.run('test task'), /not connected/);
  });

  void it('throws on plan before connect', async () => {
    const client = new CommanderClient();
    await assert.rejects(() => client.plan('test task'), /not connected/);
  });

  void it('returns empty session list before any runs', () => {
    const client = new CommanderClient();
    const sessions = client.listSessions();
    assert.deepEqual(sessions, []);
  });

  void it('detects no provider from empty env', () => {
    const client = new CommanderClient();
    // Private method — just verify the constructor works without env keys
    assert.equal(client.isConnected, false);
  });

  void describe('memory (best-effort)', () => {
    void it('queryMemory returns an array without throwing when not connected', () => {
      const client = new CommanderClient();
      const results = client.queryMemory({ keywords: ['test'], limit: 5 });
      assert.ok(Array.isArray(results));
    });

    void it('getMemoryStats returns zeroed stats when not connected', async () => {
      const client = new CommanderClient();
      const stats = await client.getMemoryStats();
      assert.equal(stats.workingCount, 0);
      assert.equal(stats.episodicCount, 0);
      assert.equal(stats.longTermCount, 0);
      assert.equal(stats.totalCount, 0);
    });

    void it('getStats is a live alias for getMemoryStats', async () => {
      const client = new CommanderClient();
      const stats = await client.getStats();
      assert.equal(stats.totalCount, 0);
      assert.equal(stats.workingCount, 0);
    });
  });
});

const actionFixtures = {
  input: {
    source: 'sdk-test',
    package: 'demo.package',
    model: 'demo-model',
    tool: 'ticket.create',
    destination: 'demo://tickets',
    effectType: 'demo.ticket.create',
    args: { title: 'Reset password' },
    idempotencyKey: 'action-key-0001',
  },
  simulation: {
    simulationId: 'sim-1',
    decisionId: 'action-gateway-allow',
    effect: 'allow',
    reason: 'allowed',
    policySnapshotId: 'action-gateway-mvp-v1',
    actionDigest: 'a'.repeat(64),
  },
  action: {
    runId: 'run-action-1',
    stepId: 'step-1',
    effectId: 'effect-1',
    state: 'PROPOSED',
    decision: {
      effect: 'allow',
      decisionId: 'action-gateway-allow',
      reason: 'allowed',
      policySnapshotId: 'action-gateway-mvp-v1',
    },
    simulation: {
      simulationId: 'sim-1',
      decisionId: 'action-gateway-allow',
      effect: 'allow',
      reason: 'allowed',
      policySnapshotId: 'action-gateway-mvp-v1',
      actionDigest: 'a'.repeat(64),
    },
    actionDigest: 'a'.repeat(64),
    policySnapshotId: 'action-gateway-mvp-v1',
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
  },
};

void describe('@praetor/sdk — Gateway V1 client', () => {
  void it('submits a durable run with idempotency and preserves 202 semantics', async () => {
    let captured: RequestInit | undefined;
    const client = new CommanderGatewayClient({
      baseUrl: 'https://commander.example/',
      apiKey: 'key',
      fetch: async (_url: string, init?: RequestInit) => {
        captured = init;
        return new Response(
          JSON.stringify({
            run: {
              id: 'run-1',
              status: 'pending',
              tenantId: 'tenant-a',
              createdAt: 'now',
              updatedAt: 'now',
              intentHash: 'i',
              workGraphHash: 'g',
              workGraphVersion: 'v1',
              policySnapshotId: 'p1',
            },
            idempotentReplay: false,
          }),
          { status: 202, headers: { 'content-type': 'application/json' } },
        );
      },
    });
    const result = await client.submitRun({
      goal: 'reconcile invoices',
      policySnapshotId: 'p1',
      idempotencyKey: 'idem-key-0001',
    });
    assert.equal(result.accepted, true);
    assert.equal(result.run.id, 'run-1');
    assert.equal(new Headers(captured?.headers).get('idempotency-key'), 'idem-key-0001');
  });

  void it('simulateAction posts the governed action envelope', async () => {
    let url = '';
    let captured: RequestInit | undefined;
    const client = new CommanderGatewayClient({
      baseUrl: 'https://commander.example',
      apiKey: 'key',
      fetch: async (requestUrl: string, init?: RequestInit) => {
        url = requestUrl;
        captured = init;
        return new Response(JSON.stringify({ simulation: actionFixtures.simulation }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const result = await client.simulateAction(actionFixtures.input);
    assert.equal(url, 'https://commander.example/v1/actions/simulate');
    assert.equal(captured?.method, 'POST');
    assert.deepEqual(JSON.parse(String(captured?.body)), actionFixtures.input);
    assert.equal(result.simulation.simulationId, 'sim-1');
  });

  void it('proposeAction posts with Idempotency-Key header', async () => {
    let captured: RequestInit | undefined;
    const client = new CommanderGatewayClient({
      baseUrl: 'https://commander.example',
      apiKey: 'key',
      fetch: async (_url: string, init?: RequestInit) => {
        captured = init;
        return new Response(
          JSON.stringify({ action: actionFixtures.action, idempotentReplay: false }),
          { status: 202, headers: { 'content-type': 'application/json' } },
        );
      },
    });
    const result = await client.proposeAction(actionFixtures.input);
    assert.equal(result.accepted, true);
    assert.equal(result.action.runId, 'run-action-1');
    assert.equal(new Headers(captured?.headers).get('idempotency-key'), 'action-key-0001');
    assert.deepEqual(JSON.parse(String(captured?.body)), actionFixtures.input);
  });

  void it('getAction loads a governed action by run id', async () => {
    let url = '';
    const client = new CommanderGatewayClient({
      baseUrl: 'https://commander.example',
      apiKey: 'key',
      fetch: async (requestUrl: string) => {
        url = requestUrl;
        return new Response(JSON.stringify({ action: actionFixtures.action }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const result = await client.getAction('run-action-1');
    assert.equal(url, 'https://commander.example/v1/actions/run-action-1');
    assert.equal(result.runId, 'run-action-1');
  });

  void it('approveAction posts approval bindings', async () => {
    let url = '';
    let captured: RequestInit | undefined;
    const client = new CommanderGatewayClient({
      baseUrl: 'https://commander.example',
      apiKey: 'key',
      fetch: async (requestUrl: string, init?: RequestInit) => {
        url = requestUrl;
        captured = init;
        return new Response(JSON.stringify({ action: actionFixtures.action }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const approval = {
      actionDigest: actionFixtures.action.actionDigest,
      simulationId: actionFixtures.action.simulation.simulationId,
      policySnapshotId: actionFixtures.action.policySnapshotId,
    };
    const result = await client.approveAction('run-action-1', approval, 'approve-action-0001');
    assert.equal(url, 'https://commander.example/v1/actions/run-action-1/approve');
    assert.deepEqual(JSON.parse(String(captured?.body)), approval);
    assert.equal(new Headers(captured?.headers).get('idempotency-key'), 'approve-action-0001');
    assert.equal(result.runId, 'run-action-1');
  });

  void it('rejectAction posts optional reason', async () => {
    let captured: RequestInit | undefined;
    const client = new CommanderGatewayClient({
      baseUrl: 'https://commander.example',
      apiKey: 'key',
      fetch: async (_url: string, init?: RequestInit) => {
        captured = init;
        return new Response(
          JSON.stringify({ action: { ...actionFixtures.action, state: 'FAILED' } }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      },
    });
    const result = await client.rejectAction(
      'run-action-1',
      { reason: 'too risky' },
      'reject-action-0001',
    );
    assert.equal(result.state, 'FAILED');
    assert.deepEqual(JSON.parse(String(captured?.body)), { reason: 'too risky' });
    assert.equal(new Headers(captured?.headers).get('idempotency-key'), 'reject-action-0001');
  });

  void it('reconcileAction posts to reconcile endpoint', async () => {
    let url = '';
    const client = new CommanderGatewayClient({
      baseUrl: 'https://commander.example',
      apiKey: 'key',
      fetch: async (requestUrl: string, init?: RequestInit) => {
        url = requestUrl;
        return new Response(
          JSON.stringify({ error: { code: 'RECONCILER_NOT_CONFIGURED' }, effectId: 'effect-1' }),
          { status: 501, headers: { 'content-type': 'application/json' } },
        );
      },
    });
    await assert.rejects(
      () => client.reconcileAction('run-action-1', 'reconcile-action-0001'),
      (error: { status: number }) => error.status === 501,
    );
    assert.equal(url, 'https://commander.example/v1/actions/run-action-1/reconcile');
  });

  void it('getActionEvidence loads evidence bundle', async () => {
    let url = '';
    const client = new CommanderGatewayClient({
      baseUrl: 'https://commander.example',
      apiKey: 'key',
      fetch: async (requestUrl: string) => {
        url = requestUrl;
        return new Response(
          JSON.stringify({
            receipt: { bundleId: 'bundle-1', scope: { runId: 'run-action-1' } },
            verification: { ok: true },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });
    const result = await client.getActionEvidence('run-action-1');
    assert.equal(url, 'https://commander.example/v1/actions/run-action-1/evidence');
    assert.equal(result.receipt.bundleId, 'bundle-1');
    assert.equal(result.verification.ok, true);
  });

  void it('requests and approves a compensation through the action gateway', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new CommanderGatewayClient({
      baseUrl: 'https://commander.example',
      apiKey: 'key',
      fetch: async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        const body = url.endsWith('/compensations')
          ? {
              authorization: { id: 'authorization-1', actionDigest: 'b'.repeat(64) },
              replayed: false,
              state: 'AWAITING_APPROVAL',
            }
          : {
              interaction: { id: 'interaction-1', status: 'answered' },
              accepted: true,
              request: { id: 'request-1', state: 'AUTHORIZED' },
              replayed: false,
            };
        return new Response(JSON.stringify(body), {
          status: 202,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const input = {
      originalEffectId: 'effect-1',
      adapterVersion: 'demo.adapter.v1',
      compensationEffectType: 'compensate.demo.ticket.create',
      compensationPatch: { ticketId: 'ticket-1' },
      forwardReceiptHash: 'a'.repeat(64),
    };

    const requested = await client.requestActionCompensation(
      'run-action-1',
      input,
      'compensation-request-1',
    );
    const approved = await client.approveActionCompensation(
      'run-action-1',
      'authorization-1',
      { actionDigest: 'b'.repeat(64), policySnapshotId: 'policy-1' },
      'compensation-approve-1',
    );

    assert.equal(requested.state, 'AWAITING_APPROVAL');
    assert.equal(approved.accepted, true);
    assert.deepEqual(
      calls.map(({ url }) => url),
      [
        'https://commander.example/v1/actions/run-action-1/compensations',
        'https://commander.example/v1/actions/run-action-1/compensations/authorization-1/approve',
      ],
    );
    assert.deepEqual(
      calls.map(({ init }) => new Headers(init?.headers).get('idempotency-key')),
      ['compensation-request-1', 'compensation-approve-1'],
    );
    assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), input);
  });

  void it('reconcileAction preserves the canonical 202 result', async () => {
    const fixture = {
      effectId: 'effect-1',
      state: 'COMPLETION_UNKNOWN',
      reconcileAfter: '2026-07-29T08:30:00.000Z',
      alreadyScheduled: true,
      scheduled: true,
    };
    const client = new CommanderGatewayClient({
      baseUrl: 'https://commander.example',
      fetch: async () =>
        new Response(JSON.stringify(fixture), {
          status: 202,
          headers: { 'content-type': 'application/json' },
        }),
    });

    assert.deepEqual(
      await client.reconcileAction('run-action-1', 'reconcile-action-0002'),
      fixture,
    );
  });

  void it('preserves HTTP status and gateway error code', async () => {
    const client = new CommanderGatewayClient({
      baseUrl: 'https://commander.example',
      fetch: async () =>
        new Response(
          JSON.stringify({
            error: { code: 'NO_RECONCILABLE_EFFECT', message: 'No pending effect.' },
          }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        ),
    });

    await assert.rejects(
      () => client.reconcileAction('run-action-1', 'reconcile-action-0003'),
      (error: InstanceType<typeof CommanderGatewayError>) =>
        error.status === 409 &&
        error.code === 'NO_RECONCILABLE_EFFECT' &&
        error.message === 'No pending effect.',
    );
  });

  void it('lists, updates, and removes kill switches using canonical paths', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fixture = {
      tenantId: 'tenant-a',
      scope: 'tool',
      value: 'ticket.create',
      enabled: true,
      reason: 'incident response',
      actor: 'operator-1',
      updatedAt: '2026-07-29T08:00:00.000Z',
    };
    const client = new CommanderGatewayClient({
      baseUrl: 'https://commander.example',
      fetch: async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (init?.method === 'DELETE') return new Response(null, { status: 204 });
        return new Response(
          JSON.stringify(
            init?.method === 'PUT' ? { killSwitch: fixture } : { killSwitches: [fixture] },
          ),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });

    assert.deepEqual(await client.listKillSwitches(), [fixture]);
    assert.deepEqual(
      await client.putKillSwitch(
        'tool',
        'ticket.create',
        { enabled: true, reason: 'incident response' },
        'kill-put-0001',
      ),
      fixture,
    );
    await client.removeKillSwitch('tool', 'ticket.create', 'kill-delete-0001');

    assert.deepEqual(
      calls.map(({ url, init }) => [url, init?.method ?? 'GET']),
      [
        ['https://commander.example/v1/actions/kill-switches', 'GET'],
        ['https://commander.example/v1/actions/kill-switches/tool/ticket.create', 'PUT'],
        ['https://commander.example/v1/actions/kill-switches/tool/ticket.create', 'DELETE'],
      ],
    );
    assert.deepEqual(JSON.parse(String(calls[1].init?.body)), {
      enabled: true,
      reason: 'incident response',
    });
    assert.equal(new Headers(calls[1].init?.headers).get('idempotency-key'), 'kill-put-0001');
    assert.equal(new Headers(calls[2].init?.headers).get('idempotency-key'), 'kill-delete-0001');
  });

  void it('verifies an evidence receipt against JWKS without fetching', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const protectedHeader = Buffer.from(
      JSON.stringify({ alg: 'EdDSA', kid: 'evidence-key-1', typ: 'JWT' }),
    ).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ runId: 'run-action-1', contentHash: 'a'.repeat(64) }),
    ).toString('base64url');
    const signingInput = `${protectedHeader}.${payload}`;
    const receipt = `${signingInput}.${sign(null, Buffer.from(signingInput), privateKey).toString('base64url')}`;
    const jwks = {
      keys: [
        {
          ...publicKey.export({ format: 'jwk' }),
          kid: 'evidence-key-1',
          alg: 'EdDSA',
          use: 'sig',
        },
      ],
    };

    assert.deepEqual(verifyActionEvidence(receipt, jwks), {
      valid: true,
      payload: { runId: 'run-action-1', contentHash: 'a'.repeat(64) },
    });
    const receiptParts = receipt.split('.');
    const forgedSignature = Buffer.from(receiptParts[2], 'base64url');
    forgedSignature[0] ^= 1;
    const forgedReceipt = `${receiptParts[0]}.${receiptParts[1]}.${forgedSignature.toString('base64url')}`;
    assert.equal(verifyActionEvidence(forgedReceipt, jwks).valid, false);

    // The negative cases the audit found missing: a signed header claiming
    // `alg:none`, an unknown `kid`, and a receipt signed by the wrong key.
    const signWithHeader = (
      header: Record<string, unknown>,
      key: KeyObject = privateKey,
    ): string => {
      const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
      const input = `${encodedHeader}.${payload}`;
      return `${input}.${sign(null, Buffer.from(input), key).toString('base64url')}`;
    };

    const algNone = verifyActionEvidence(
      signWithHeader({ alg: 'none', kid: 'evidence-key-1', typ: 'JWT' }),
      jwks,
    );
    assert.equal(algNone.valid, false);
    assert.equal(algNone.valid ? undefined : algNone.error.code, 'EVIDENCE_RECEIPT_INVALID');

    const unknownKid = verifyActionEvidence(
      signWithHeader({ alg: 'EdDSA', kid: 'unknown-key', typ: 'JWT' }),
      jwks,
    );
    assert.equal(unknownKid.valid, false);
    assert.equal(unknownKid.valid ? undefined : unknownKid.error.code, 'EVIDENCE_KEY_NOT_FOUND');

    const wrongKey = generateKeyPairSync('ed25519');
    const wrongKeyReceipt = verifyActionEvidence(
      signWithHeader({ alg: 'EdDSA', kid: 'evidence-key-1', typ: 'JWT' }, wrongKey.privateKey),
      jwks,
    );
    assert.equal(wrongKeyReceipt.valid, false);
    assert.equal(
      wrongKeyReceipt.valid ? undefined : wrongKeyReceipt.error.code,
      'EVIDENCE_SIGNATURE_INVALID',
    );
  });
});
