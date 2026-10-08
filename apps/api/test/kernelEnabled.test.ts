import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  canonicalGatewaySubmissionHash,
  legacyGatewaySubmissionHash,
  canonicalWorkGraphHash,
  createV1KernelGateway,
  deriveGatewayRunId,
  getKernelDatabaseUrl,
  isCommanderKernelEnabled,
  isCommanderKernelExplicitlyDisabled,
} from '../src/v1GatewayKernel';
import { InMemoryKernelRepository } from '@praetor/kernel/testing/inMemoryRepository';

describe('isCommanderKernelEnabled', () => {
  it('defaults OFF without DSN outside production', () => {
    assert.equal(
      isCommanderKernelEnabled({
        NODE_ENV: 'development',
      } as NodeJS.ProcessEnv),
      false,
    );
  });

  it('defaults ON when DATABASE_URL is set (even without explicit flag)', () => {
    assert.equal(
      isCommanderKernelEnabled({
        NODE_ENV: 'development',
        DATABASE_URL: 'postgres://commander:commander@127.0.0.1:5432/commander',
      } as NodeJS.ProcessEnv),
      true,
    );
  });

  it('defaults ON when COMMANDER_KERNEL_DATABASE_URL is set', () => {
    assert.equal(
      isCommanderKernelEnabled({
        NODE_ENV: 'development',
        COMMANDER_KERNEL_DATABASE_URL: 'postgres://kernel@127.0.0.1:5432/kernel',
      } as NodeJS.ProcessEnv),
      true,
    );
  });

  it('defaults ON when PRAETOR_KERNEL_DATABASE_URL is set', () => {
    assert.equal(
      isCommanderKernelEnabled({
        NODE_ENV: 'development',
        PRAETOR_KERNEL_DATABASE_URL: 'postgres://kernel@127.0.0.1:5432/kernel',
      } as NodeJS.ProcessEnv),
      true,
    );
  });

  it('defaults ON in production without explicit flag (flag no longer pure opt-in)', () => {
    assert.equal(
      isCommanderKernelEnabled({
        NODE_ENV: 'production',
      } as NodeJS.ProcessEnv),
      true,
    );
  });

  it('honors explicit off even in production (startServer must refuse this)', () => {
    assert.equal(
      isCommanderKernelEnabled({
        NODE_ENV: 'production',
        COMMANDER_KERNEL_ENABLED: '0',
        DATABASE_URL: 'postgres://x',
      } as NodeJS.ProcessEnv),
      false,
    );
    assert.equal(
      isCommanderKernelExplicitlyDisabled({
        NODE_ENV: 'production',
        COMMANDER_KERNEL_ENABLED: '0',
      } as NodeJS.ProcessEnv),
      true,
    );
  });

  it('honors explicit on without DSN (init will still require DSN)', () => {
    assert.equal(
      isCommanderKernelEnabled({
        NODE_ENV: 'development',
        COMMANDER_KERNEL_ENABLED: '1',
      } as NodeJS.ProcessEnv),
      true,
    );
  });

  it('defaults ON under COMMANDER_V2_MODE=1', () => {
    assert.equal(
      isCommanderKernelEnabled({
        NODE_ENV: 'development',
        COMMANDER_V2_MODE: '1',
      } as NodeJS.ProcessEnv),
      true,
    );
  });

  it('treats empty COMMANDER_KERNEL_ENABLED as auto (not off)', () => {
    assert.equal(
      isCommanderKernelEnabled({
        NODE_ENV: 'development',
        COMMANDER_KERNEL_ENABLED: '',
        DATABASE_URL: 'postgres://x',
      } as NodeJS.ProcessEnv),
      true,
    );
  });

  it('accepts true/on/yes and false/off/no aliases', () => {
    assert.equal(
      isCommanderKernelEnabled({ COMMANDER_KERNEL_ENABLED: 'true' } as NodeJS.ProcessEnv),
      true,
    );
    assert.equal(
      isCommanderKernelEnabled({ COMMANDER_KERNEL_ENABLED: 'on' } as NodeJS.ProcessEnv),
      true,
    );
    assert.equal(
      isCommanderKernelEnabled({
        NODE_ENV: 'production',
        COMMANDER_KERNEL_ENABLED: 'false',
      } as NodeJS.ProcessEnv),
      false,
    );
    assert.equal(
      isCommanderKernelEnabled({
        NODE_ENV: 'production',
        COMMANDER_KERNEL_ENABLED: 'off',
      } as NodeJS.ProcessEnv),
      false,
    );
  });
});

describe('getKernelDatabaseUrl', () => {
  it('prefers COMMANDER_KERNEL_DATABASE_URL over DATABASE_URL', () => {
    assert.equal(
      getKernelDatabaseUrl({
        COMMANDER_KERNEL_DATABASE_URL: 'postgres://kernel',
        DATABASE_URL: 'postgres://shared',
      } as NodeJS.ProcessEnv),
      'postgres://kernel',
    );
  });

  it('falls back to DATABASE_URL', () => {
    assert.equal(
      getKernelDatabaseUrl({
        DATABASE_URL: 'postgres://shared',
      } as NodeJS.ProcessEnv),
      'postgres://shared',
    );
  });

  it('returns empty string when neither is set', () => {
    assert.equal(getKernelDatabaseUrl({} as NodeJS.ProcessEnv), '');
  });
});

describe('canonicalWorkGraphHash', () => {
  it('binds the complete deterministic initial state and interaction semantics', () => {
    const base = [
      {
        id: 'step-approval',
        kind: 'tool',
        initialState: 'WAITING_FOR_HUMAN' as const,
        interaction: {
          id: 'interaction-approval',
          prompt: 'Approve action?',
          expiresAt: '2030-01-01T00:00:00.000Z',
        },
        input: { b: 2, a: 1 },
      },
    ];
    const baseHash = canonicalWorkGraphHash(base);

    assert.notEqual(
      canonicalWorkGraphHash([
        {
          ...base[0],
          initialState: 'PENDING',
        },
      ]),
      baseHash,
    );
    assert.notEqual(
      canonicalWorkGraphHash([
        {
          ...base[0],
          interaction: { ...base[0].interaction, id: 'interaction-other' },
        },
      ]),
      baseHash,
    );
    assert.notEqual(
      canonicalWorkGraphHash([
        {
          ...base[0],
          interaction: { ...base[0].interaction, prompt: 'Approve a different action?' },
        },
      ]),
      baseHash,
    );
    assert.notEqual(
      canonicalWorkGraphHash([
        {
          ...base[0],
          interaction: { ...base[0].interaction, expiresAt: '2031-01-01T00:00:00.000Z' },
        },
      ]),
      baseHash,
    );
    assert.equal(
      canonicalWorkGraphHash([
        {
          ...base[0],
          input: { a: 1, b: 2 },
        },
      ]),
      baseHash,
    );
    assert.equal(
      canonicalWorkGraphHash([{ id: 'step-default', kind: 'agent' }]),
      canonicalWorkGraphHash([{ id: 'step-default', kind: 'agent', initialState: 'PENDING' }]),
    );
  });
});

describe('legacy submission hash replay', () => {
  it('replays when stored submissionHash uses the legacy JSON.stringify algorithm', async () => {
    const repo = new InMemoryKernelRepository();
    const gateway = createV1KernelGateway(repo);
    const input = {
      tenantId: 'tenant-a',
      idempotencyKey: 'legacy-replay-key',
      goal: 'legacy replay goal',
      steps: [{ id: 'step-legacy', kind: 'tool' as const, input: { args: { x: 1 } } }],
      workGraphVersion: 'v1',
      policySnapshotId: 'policy-v1',
      metadata: { source: 'test' },
      actor: 'tester',
    };
    const runId = deriveGatewayRunId(input.tenantId, input.idempotencyKey);
    await repo.createRun(
      {
        id: runId,
        tenantId: input.tenantId,
        intentHash: 'intent',
        workGraphHash: canonicalWorkGraphHash(input.steps),
        workGraphVersion: input.workGraphVersion,
        policySnapshotId: input.policySnapshotId,
        metadata: {
          ...input.metadata,
          goal: input.goal,
          submissionHash: legacyGatewaySubmissionHash(input),
          idempotencyKey: input.idempotencyKey,
        },
        steps: input.steps,
      },
      input.actor,
    );
    const replay = await gateway.submit(input);
    assert.equal(replay.created, false);
    assert.equal(replay.run.id, runId);
  });
});

describe('gateway submission idempotency hash', () => {
  it('ignores nested object key order throughout the submission', () => {
    const first = {
      goal: 'canonical replay',
      steps: [
        {
          id: 'step-canonical',
          kind: 'tool',
          input: { args: { outer: { b: 2, a: 1 }, z: true } },
        },
      ],
      workGraphVersion: 'v1',
      policySnapshotId: 'policy-v1',
      metadata: { actionGateway: { nested: { second: 2, first: 1 } } },
    };
    const reordered = {
      policySnapshotId: 'policy-v1',
      metadata: { actionGateway: { nested: { first: 1, second: 2 } } },
      workGraphVersion: 'v1',
      steps: [
        {
          kind: 'tool',
          id: 'step-canonical',
          input: { args: { z: true, outer: { a: 1, b: 2 } } },
        },
      ],
      goal: 'canonical replay',
    };
    assert.equal(canonicalGatewaySubmissionHash(first), canonicalGatewaySubmissionHash(reordered));
  });
});
