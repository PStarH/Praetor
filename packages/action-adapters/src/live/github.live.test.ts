/**
 * L4-02 GitHub live adapter proof (opt-in).
 *
 * Requires: LIVE_GITHUB=1, COMMANDER_SANDBOX_TOKEN|GITHUB_TOKEN|GITHUB_PAT,
 * COMMANDER_CELL_TENANT_ID, GITHUB_TEST_OWNER, GITHUB_TEST_REPO.
 *
 * Opt-out suites skip. Explicit opt-in without prerequisites fails; neither
 * these adapter tests nor their cleanup establish Gateway approval/restart proof.
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { GITHUB_PULL_REQUEST_CREATE_DESCRIPTOR } from '@praetor/contracts';
import { createGitHubPullRequestCreateAdapter, EnvAdapterCredentialProvider } from '../index.js';
import {
  createGitHubResponseCutFetch,
  GitHubResponseCutError,
  type GitHubResponseCutState,
} from './githubResponseCut.js';

const tenantId = process.env.COMMANDER_CELL_TENANT_ID ?? '';
const owner = process.env.GITHUB_TEST_OWNER ?? '';
const repo = process.env.GITHUB_TEST_REPO ?? '';
const token =
  process.env.COMMANDER_SANDBOX_TOKEN ?? process.env.GITHUB_TOKEN ?? process.env.GITHUB_PAT ?? '';
const destination = owner && repo ? `github://${owner}/${repo}/pulls` : '';

/** Live writes require the exact sandbox repository, never a naming prefix. */
export function isAllowlistedGitHubTestRepository(
  repositoryOwner: string,
  repositoryName: string,
  approvedRepository = process.env.COMMANDER_LIVE_APPROVED_REPO ?? '',
): boolean {
  return (
    Boolean(repositoryOwner && repositoryName) &&
    approvedRepository === `${repositoryOwner}/${repositoryName}`
  );
}

const head = process.env.GITHUB_TEST_HEAD ?? '';
const base = process.env.GITHUB_TEST_BASE ?? '';
const responseCutHead = process.env.GITHUB_RESPONSE_CUT_HEAD ?? '';
const liveRequested = process.env.LIVE_GITHUB === '1';
const responseCutRequested = process.env.LIVE_GITHUB_RESPONSE_CUT === '1';
const prerequisites = [
  ...(!liveRequested ? ['LIVE_GITHUB=1'] : []),
  ...(!tenantId ? ['COMMANDER_CELL_TENANT_ID'] : []),
  ...(!token ? ['COMMANDER_SANDBOX_TOKEN or GITHUB_TOKEN'] : []),
  ...(!owner || !repo ? ['GITHUB_TEST_OWNER and GITHUB_TEST_REPO'] : []),
  ...(!isAllowlistedGitHubTestRepository(owner, repo)
    ? ['exact COMMANDER_LIVE_APPROVED_REPO']
    : []),
  ...(!(process.env.COMMANDER_GITHUB_REPOSITORIES ?? '')
    .split(',')
    .map((value) => value.trim())
    .includes(`${owner}/${repo}`)
    ? ['COMMANDER_GITHUB_REPOSITORIES']
    : []),
  ...(!head || !base || head === base || head.includes(':') || base.includes(':')
    ? ['distinct prepared GITHUB_TEST_HEAD and GITHUB_TEST_BASE']
    : []),
  ...(responseCutRequested &&
  (!responseCutHead ||
    responseCutHead === head ||
    responseCutHead === base ||
    responseCutHead.includes(':'))
    ? ['distinct prepared GITHUB_RESPONSE_CUT_HEAD']
    : []),
];
const liveEnabled = liveRequested && prerequisites.length === 0;
const responseCutEnabled = liveEnabled && responseCutRequested;
const idempotencyKey = `live-github-${Date.now()}`;
const responseCutIdempotencyKey = `live-github-response-cut-${Date.now()}`;

if (liveRequested || responseCutRequested) {
  it('explicit live selection has all prerequisites', () => {
    assert.equal(
      prerequisites.length,
      0,
      `GITHUB_LIVE_PREREQUISITES_MISSING: ${prerequisites.join(', ')}`,
    );
  });
}

function liveCredentials(): EnvAdapterCredentialProvider {
  return new EnvAdapterCredentialProvider({
    cellTenantId: tenantId,
    ...(process.env.COMMANDER_SANDBOX_TOKEN ? { githubTokenEnv: 'COMMANDER_SANDBOX_TOKEN' } : {}),
  });
}

const remotePrNumbers: number[] = [];

function printCleanup(): void {
  if (remotePrNumbers.length === 0) return;
  console.error(
    `[LIVE_CLEANUP] adapter=github prNumbers=${remotePrNumbers.join(',')} repo=${owner}/${repo}`,
  );
}

describe('GitHub live target preflight', () => {
  it('rejects a non-test repository without an exact approval', () => {
    assert.equal(isAllowlistedGitHubTestRepository('PStarH', 'Commander', ''), false);
    assert.equal(
      isAllowlistedGitHubTestRepository('PStarH', 'Commander', 'other/test-repo'),
      false,
    );
  });

  it('rejects the commander-live- prefix without exact repository approval', () => {
    assert.equal(isAllowlistedGitHubTestRepository('attacker', 'commander-live-x', ''), false);
    assert.equal(isAllowlistedGitHubTestRepository('PStarH', 'commander-live-demo', ''), false);
  });

  it('accepts only the exact approved repository', () => {
    assert.equal(isAllowlistedGitHubTestRepository('PStarH', 'commander-live-demo', ''), false);
    assert.equal(
      isAllowlistedGitHubTestRepository('PStarH', 'private-test', 'PStarH/private-test'),
      true,
    );
  });
});

describe(
  'L4-02 GitHub live adapter',
  { skip: liveEnabled ? false : 'missing LIVE_GITHUB creds or explicit test-repo allowlist' },
  () => {
    after(() => {
      printCleanup();
    });

    it('create → queryOutcome → compensate → queryCompensationOutcome', async () => {
      const credentials = liveCredentials();
      const adapter = createGitHubPullRequestCreateAdapter({ credentials });
      const signal = AbortSignal.timeout(60_000);
      try {
        const created = await adapter.execute({
          tenantId,
          effectId: 'eff-live-gh-1',
          idempotencyKey,
          destination,
          args: {
            title: 'L4-B live chaos PR',
            body: 'Live test',
            head,
            base,
          },
          signal,
        });
        const remotePrNumber = Number(created.prNumber);
        assert.ok(Number.isFinite(remotePrNumber));
        remotePrNumbers.push(remotePrNumber);

        const outcome = await adapter.queryOutcome({
          tenantId,
          effectId: 'eff-live-gh-1',
          idempotencyKey,
          destination,
          request: { args: { title: 'L4-B live chaos PR', body: 'Live test', head, base } },
        });
        assert.equal(outcome.status, 'APPLIED');
        assert.equal(outcome.response?.prNumber, remotePrNumber);

        const compensated = await adapter.compensate({
          tenantId,
          effectId: 'eff-live-gh-cmp',
          originalEffectId: 'eff-live-gh-1',
          idempotencyKey: `cmp:eff-live-gh-1:${GITHUB_PULL_REQUEST_CREATE_DESCRIPTOR.adapterVersion}`,
          destination,
          forwardResponse: created,
          compensationPatch: {},
          signal,
        });
        assert.equal(compensated.state, 'closed');

        const compensationOutcome = await adapter.queryCompensationOutcome({
          tenantId,
          effectId: 'eff-live-gh-cmp',
          idempotencyKey: `cmp:eff-live-gh-1:${GITHUB_PULL_REQUEST_CREATE_DESCRIPTOR.adapterVersion}`,
          destination,
          request: { forwardResponse: created },
          compensationResponse: compensated,
        });
        assert.equal(compensationOutcome.status, 'APPLIED');
        assert.equal(compensationOutcome.response?.state, 'closed');
      } catch (error) {
        printCleanup();
        throw error;
      }
    });
  },
);

describe(
  'L4-04 GitHub response-cut live adapter',
  {
    skip: responseCutEnabled
      ? false
      : 'requires LIVE_GITHUB_RESPONSE_CUT=1 and a fresh GITHUB_RESPONSE_CUT_HEAD',
  },
  () => {
    after(() => {
      printCleanup();
    });

    it('cuts only after GitHub accepts the create and then queries one PR', async () => {
      const credentials = liveCredentials();
      const observed: GitHubResponseCutState = {
        createRequestCount: 0,
        remoteCommitConfirmed: false,
        responseCutInjected: false,
      };
      const adapter = createGitHubPullRequestCreateAdapter({
        credentials,
        fetch: createGitHubResponseCutFetch(globalThis.fetch.bind(globalThis), observed),
      });
      const signal = AbortSignal.timeout(60_000);

      try {
        await assert.rejects(
          () =>
            adapter.execute({
              tenantId,
              effectId: 'eff-live-gh-response-cut',
              idempotencyKey: responseCutIdempotencyKey,
              destination,
              args: {
                title: 'L4-B live response-cut PR',
                body: 'Live response-cut test',
                head: responseCutHead,
                base,
              },
              signal,
            }),
          (error: unknown) => error instanceof GitHubResponseCutError,
        );
        assert.equal(observed.postStatus, 201);
        assert.equal(observed.remoteCommitConfirmed, true);
        assert.equal(observed.responseCutInjected, true);

        const outcome = await adapter.queryOutcome({
          tenantId,
          effectId: 'eff-live-gh-response-cut',
          idempotencyKey: responseCutIdempotencyKey,
          destination,
          request: {
            args: {
              title: 'L4-B live response-cut PR',
              body: 'Live response-cut test',
              head: responseCutHead,
              base,
            },
          },
          signal,
        });
        assert.equal(outcome.status, 'APPLIED');
        if (outcome.status !== 'APPLIED') throw new Error('response-cut PR was not observable');
        const remotePrNumber = Number(outcome.response.prNumber);
        assert.ok(Number.isFinite(remotePrNumber));
        remotePrNumbers.push(remotePrNumber);

        const compensated = await adapter.compensate({
          tenantId,
          effectId: 'eff-live-gh-response-cut-cmp',
          originalEffectId: 'eff-live-gh-response-cut',
          idempotencyKey: `cmp:eff-live-gh-response-cut:${GITHUB_PULL_REQUEST_CREATE_DESCRIPTOR.adapterVersion}`,
          destination,
          forwardResponse: outcome.response,
          compensationPatch: {},
          signal,
        });
        assert.equal(compensated.state, 'closed');
        assert.equal(observed.createRequestCount, 1);
      } catch (error) {
        printCleanup();
        throw error;
      }
    });
  },
);
