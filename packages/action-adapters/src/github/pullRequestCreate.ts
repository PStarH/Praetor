import { githubPrBodyMarker, GITHUB_PULL_REQUEST_CREATE_DESCRIPTOR } from '@praetor/contracts';
import { AdapterExecutionError } from '@praetor/effect-broker';
import type { EffectRemoteOutcome } from '@praetor/effect-broker';
import {
  assertOkResponse,
  adapterFetch,
  readJsonResponse,
  requireArrayResponse,
  type FetchFn,
} from '../http.js';
import type { ActionAdapter, AdapterCredentialProvider } from '../types.js';
import { parseGitHubDestination } from '../types.js';

interface GitHubCreateArgs {
  title: string;
  body: string;
  head: string;
  base: string;
}

interface GitHubCreateReceipt extends Record<string, unknown> {
  prNumber: number;
  url: string;
  state: 'open' | 'closed';
  idempotencyKey: string;
  destination: string;
  head: string;
  base: string;
  headSha: string;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function failure(code: string, message: string, uncertain = false): AdapterExecutionError {
  return new AdapterExecutionError(message, {
    code,
    commitState: uncertain ? 'UNKNOWN' : 'NOT_COMMITTED',
    retryMode: uncertain ? 'QUERY_FIRST' : 'NEVER',
  });
}

function unknownOutcome(code = 'RECONCILE_OUTCOME_NOT_YET_VISIBLE'): EffectRemoteOutcome {
  return { status: 'UNKNOWN', error: { code, message: 'Remote outcome is not yet provable' } };
}

function queryFailure(error: unknown, signal: AbortSignal): EffectRemoteOutcome {
  return unknownOutcome(
    signal.aborted
      ? 'GITHUB_QUERY_ABORTED'
      : error instanceof AdapterExecutionError
        ? error.code
        : 'GITHUB_QUERY_UNAVAILABLE',
  );
}

function operationSignal(caller?: AbortSignal): AbortSignal {
  const deadline = AbortSignal.timeout(10_000);
  return caller ? AbortSignal.any([caller, deadline]) : deadline;
}

function branch(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !/[\s:]/.test(value);
}

function parseArgs(value: unknown): GitHubCreateArgs {
  const args = object(value);
  if (
    !args ||
    typeof args.title !== 'string' ||
    !args.title.trim() ||
    typeof args.body !== 'string' ||
    /<!--\s*commander-action:/i.test(args.body) ||
    !branch(args.head) ||
    !branch(args.base) ||
    args.head === args.base
  ) {
    throw failure(
      'GITHUB_CREATE_ARGS_INVALID',
      'Expected title, body and distinct same-repository head/base branches',
    );
  }
  return { title: args.title, body: args.body, head: args.head, base: args.base };
}

function markedBody(args: GitHubCreateArgs, marker: string): string {
  return args.body ? `${args.body}\n\n${marker}` : marker;
}

function validPullUrl(value: unknown, destination: string, number: number): value is string {
  if (typeof value !== 'string') return false;
  const { owner, repo } = parseGitHubDestination(destination);
  try {
    const url = new URL(value);
    return (
      url.origin === 'https://github.com' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname.toLowerCase() === `/${owner}/${repo}/pull/${number}`.toLowerCase()
    );
  } catch {
    return false;
  }
}

function requirePull(value: unknown): Record<string, unknown> {
  const pull = object(value);
  if (
    !pull ||
    typeof pull.number !== 'number' ||
    !Number.isSafeInteger(pull.number) ||
    pull.number <= 0 ||
    (pull.state !== 'open' && pull.state !== 'closed') ||
    typeof pull.html_url !== 'string' ||
    (typeof pull.body !== 'string' && pull.body !== null)
  ) {
    throw failure(
      'ADAPTER_RESPONSE_BODY_INVALID',
      'GitHub returned an incomplete pull request',
      true,
    );
  }
  return pull;
}

function pullAuthorLogin(pull: Record<string, unknown>): string | undefined {
  const login = object(pull.user)?.login;
  return typeof login === 'string' && login.length > 0 ? login : undefined;
}

function sameGitHubLogin(actual: string | undefined, expected: string): boolean {
  return typeof actual === 'string' && actual.toLowerCase() === expected.toLowerCase();
}

function receiptFor(
  pull: Record<string, unknown>,
  destination: string,
  key: string,
  actorLogin: string,
): GitHubCreateReceipt {
  const author = pullAuthorLogin(pull);
  if (!author) {
    throw failure(
      'GITHUB_ACTOR_UNKNOWN',
      'Cannot prove the pull request was opened by the credential user',
      true,
    );
  }
  if (!sameGitHubLogin(author, actorLogin)) {
    throw failure(
      'GITHUB_ACTOR_MISMATCH',
      'Pull request was not opened by the credential user',
      true,
    );
  }
  const { owner, repo } = parseGitHubDestination(destination);
  const repository = `${owner}/${repo}`.toLowerCase();
  const head = object(pull.head);
  const base = object(pull.base);
  const headRepo = object(head?.repo)?.full_name;
  const baseRepo = object(base?.repo)?.full_name;
  if (
    typeof pull.number !== 'number' ||
    !validPullUrl(pull.html_url, destination, pull.number) ||
    (pull.state !== 'open' && pull.state !== 'closed') ||
    !branch(head?.ref) ||
    !branch(base?.ref) ||
    typeof head?.sha !== 'string' ||
    !/^[a-f0-9]{40}$/i.test(head.sha) ||
    typeof headRepo !== 'string' ||
    headRepo.toLowerCase() !== repository ||
    typeof baseRepo !== 'string' ||
    baseRepo.toLowerCase() !== repository
  ) {
    throw failure(
      'GITHUB_RECEIPT_INVALID',
      'Cannot prove a same-repository pull-request receipt',
      true,
    );
  }
  return {
    prNumber: pull.number,
    url: pull.html_url,
    state: pull.state,
    idempotencyKey: key,
    destination,
    head: head.ref,
    base: base.ref,
    headSha: head.sha,
  };
}

function matchesRequest(
  pull: Record<string, unknown>,
  args: GitHubCreateArgs,
  body: string,
): boolean {
  return (
    pull.title === args.title &&
    pull.body === body &&
    object(pull.head)?.ref === args.head &&
    object(pull.base)?.ref === args.base
  );
}

function parseForwardReceipt(value: unknown, destination: string): GitHubCreateReceipt {
  const receipt = object(value);
  if (!receipt || typeof receipt.idempotencyKey !== 'string' || !receipt.idempotencyKey.trim()) {
    throw failure(
      'GITHUB_COMPENSATE_MISSING_ORIGINAL_KEY',
      'Compensation requires the original idempotency key',
    );
  }
  if (
    typeof receipt.prNumber !== 'number' ||
    !Number.isSafeInteger(receipt.prNumber) ||
    receipt.prNumber <= 0 ||
    !validPullUrl(receipt.url, destination, receipt.prNumber) ||
    receipt.destination !== destination ||
    !branch(receipt.head) ||
    !branch(receipt.base) ||
    typeof receipt.headSha !== 'string' ||
    !/^[a-f0-9]{40}$/i.test(receipt.headSha) ||
    (receipt.state !== 'open' && receipt.state !== 'closed')
  ) {
    throw failure(
      'GITHUB_COMPENSATE_RECEIPT_INVALID',
      'Compensation requires a complete forward receipt for this destination',
    );
  }
  return {
    prNumber: receipt.prNumber,
    url: receipt.url,
    state: receipt.state,
    idempotencyKey: receipt.idempotencyKey,
    destination,
    head: receipt.head,
    base: receipt.base,
    headSha: receipt.headSha,
  };
}

function verifyCompensationPull(
  pull: Record<string, unknown>,
  forward: GitHubCreateReceipt,
  tenantId: string,
  token: string,
  actorLogin: string,
): GitHubCreateReceipt {
  const observed = receiptFor(pull, forward.destination, forward.idempotencyKey, actorLogin);
  if (
    observed.prNumber !== forward.prNumber ||
    observed.head !== forward.head ||
    observed.base !== forward.base
  ) {
    throw failure(
      'GITHUB_COMPENSATE_RECEIPT_MISMATCH',
      'Compensation refused: PR does not match the forward receipt',
    );
  }
  if (
    typeof pull.body !== 'string' ||
    !pull.body.includes(githubPrBodyMarker(tenantId, forward.idempotencyKey, token))
  ) {
    throw failure('GITHUB_COMPENSATE_MARKER_MISMATCH', 'Compensation refused: PR marker mismatch');
  }
  if (pull.merged === true || typeof pull.merged_at === 'string') {
    throw failure('GITHUB_COMPENSATE_MERGED', 'Compensation cannot undo a merged PR');
  }
  if (pull.merged !== false || pull.merged_at !== null) {
    throw failure(
      'GITHUB_COMPENSATE_MERGE_STATE_UNKNOWN',
      'Cannot establish that the PR is unmerged',
      true,
    );
  }
  return observed;
}

export interface GitHubPullRequestCreateAdapterOptions {
  credentials: AdapterCredentialProvider;
  fetch?: FetchFn;
}

export function createGitHubPullRequestCreateAdapter(
  options: GitHubPullRequestCreateAdapterOptions,
): ActionAdapter {
  const rawFetch = options.fetch ?? globalThis.fetch.bind(globalThis);

  async function request(
    url: string,
    token: string,
    signal: AbortSignal,
    method = 'GET',
    body?: unknown,
  ): Promise<Response> {
    signal.throwIfAborted();
    const response = await adapterFetch(rawFetch, url, {
      method,
      signal,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    signal.throwIfAborted();
    await assertOkResponse(response, `GitHub ${method}`);
    return response;
  }

  function pullsUrl(destination: string): string {
    const { owner, repo } = parseGitHubDestination(destination);
    return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`;
  }

  async function credentialLogin(token: string, signal: AbortSignal): Promise<string> {
    const response = await request('https://api.github.com/user', token, signal);
    const body = object(await readJsonResponse(response));
    const login = body && typeof body.login === 'string' ? body.login : '';
    if (!login) {
      throw failure('GITHUB_ACTOR_UNKNOWN', 'GitHub credential user login is missing', true);
    }
    return login;
  }

  async function listByMarker(
    destination: string,
    token: string,
    signal: AbortSignal,
    marker: string,
    args: GitHubCreateArgs,
    actorLogin: string,
  ): Promise<Record<string, unknown>[]> {
    // The broker/ledger binds the key to the immutable approved request. Scope
    // lookup to its branches so unrelated repository history cannot starve it.
    const endpoint = pullsUrl(destination);
    const { owner } = parseGitHubDestination(destination);
    const params = new URLSearchParams({
      state: 'all',
      per_page: '100',
      head: `${owner}:${args.head}`,
      base: args.base,
    });
    let url = `${endpoint}?${params}`;
    const seen = new Set<string>();
    const candidates: Record<string, unknown>[] = [];
    for (let page = 0; page < 10; page += 1) {
      if (seen.has(url))
        throw failure('GITHUB_PAGINATION_INVALID', 'Cyclic GitHub pagination', true);
      seen.add(url);
      const response = await request(url, token, signal);
      const pulls = requireArrayResponse(await readJsonResponse(response), 'GitHub list pulls').map(
        requirePull,
      );
      signal.throwIfAborted();
      candidates.push(
        ...pulls.filter(
          (pull) =>
            typeof pull.body === 'string' &&
            pull.body.includes(marker) &&
            sameGitHubLogin(pullAuthorLogin(pull), actorLogin),
        ),
      );
      const link = response.headers.get('link');
      if (!link) return candidates;
      const links = link.split(',').map((part) => {
        const match = part.match(
          /^\s*<([^>]+)>\s*;\s*rel\s*=\s*(?:"([a-zA-Z\s]+)"|([a-zA-Z]+))\s*$/,
        );
        if (!match)
          throw failure('GITHUB_PAGINATION_INVALID', 'Malformed GitHub Link header', true);
        return { url: match[1]!, relations: (match[2] ?? match[3]!).toLowerCase().split(/\s+/) };
      });
      const nextLinks = links.filter((link) => link.relations.includes('next'));
      if (nextLinks.length === 0) return candidates;
      const rawNext = nextLinks.length === 1 ? nextLinks[0]!.url : undefined;
      let next: URL;
      try {
        if (!rawNext) throw new Error('Invalid next link');
        next = new URL(rawNext);
      } catch {
        throw failure('GITHUB_PAGINATION_INVALID', 'Invalid GitHub next link', true);
      }
      if (
        next.origin !== 'https://api.github.com' ||
        next.pathname !== new URL(endpoint).pathname ||
        next.username ||
        next.password ||
        next.hash ||
        !/^[1-9]\d*$/.test(next.searchParams.get('page') ?? '') ||
        [...next.searchParams].some(
          ([key, value]) => key !== 'page' && (!params.has(key) || value !== params.get(key)),
        ) ||
        [...next.searchParams.keys()].some((key) => next.searchParams.getAll(key).length !== 1)
      ) {
        throw failure(
          'GITHUB_PAGINATION_INVALID',
          'GitHub next link changed the query boundary',
          true,
        );
      }
      const pageParams = new URLSearchParams(params);
      pageParams.set('page', next.searchParams.get('page')!);
      url = `${endpoint}?${pageParams}`;
    }
    throw failure('GITHUB_PAGINATION_LIMIT', 'GitHub lookup exceeded ten pages', true);
  }

  async function getPull(
    destination: string,
    number: number,
    token: string,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const response = await request(`${pullsUrl(destination)}/${number}`, token, signal);
    const pull = requirePull(await readJsonResponse(response));
    signal.throwIfAborted();
    return pull;
  }

  return {
    descriptor: GITHUB_PULL_REQUEST_CREATE_DESCRIPTOR,

    async execute(input) {
      const signal = operationSignal(input.signal);
      const args = parseArgs(input.args);
      const endpoint = pullsUrl(input.destination);
      const token = await options.credentials.getGitHubToken(input.tenantId, input.destination);
      const actorLogin = await credentialLogin(token, signal);
      const marker = githubPrBodyMarker(input.tenantId, input.idempotencyKey, token);
      const body = markedBody(args, marker);
      const existing = await listByMarker(
        input.destination,
        token,
        signal,
        marker,
        args,
        actorLogin,
      );
      if (existing.length > 1)
        throw failure('GITHUB_MULTI_MARKER', 'Multiple PRs matched the marker', true);
      if (existing.length === 1) {
        const pull = existing[0]!;
        if (!matchesRequest(pull, args, body)) {
          throw failure(
            'GITHUB_IDEMPOTENCY_CONFLICT',
            'GitHub idempotency key was reused with a different pull-request request',
            true,
          );
        }
        return receiptFor(pull, input.destination, input.idempotencyKey, actorLogin);
      }
      const response = await request(endpoint, token, signal, 'POST', { ...args, body });
      const created = requirePull(await readJsonResponse(response));
      signal.throwIfAborted();
      if (!matchesRequest(created, args, body))
        throw failure(
          'GITHUB_CREATE_RESPONSE_MISMATCH',
          'Created PR does not match the approved request',
          true,
        );
      return receiptFor(created, input.destination, input.idempotencyKey, actorLogin);
    },

    async queryOutcome(input) {
      const signal = operationSignal(input.signal);
      try {
        const args = parseArgs(input.request.args);
        const token = await options.credentials.getGitHubToken(input.tenantId, input.destination);
        const actorLogin = await credentialLogin(token, signal);
        const marker = githubPrBodyMarker(input.tenantId, input.idempotencyKey, token);
        const pulls = await listByMarker(
          input.destination,
          token,
          signal,
          marker,
          args,
          actorLogin,
        );
        if (pulls.length !== 1) return unknownOutcome();
        const pull = pulls[0]!;
        if (!matchesRequest(pull, args, markedBody(args, marker)))
          return unknownOutcome('GITHUB_IDEMPOTENCY_CONFLICT');
        return {
          status: 'APPLIED',
          response: receiptFor(pull, input.destination, input.idempotencyKey, actorLogin),
        };
      } catch (error) {
        return queryFailure(error, signal);
      }
    },

    async compensate(input) {
      const signal = operationSignal(input.signal);
      const forward = parseForwardReceipt(input.forwardResponse, input.destination);
      const token = await options.credentials.getGitHubToken(input.tenantId, input.destination);
      const actorLogin = await credentialLogin(token, signal);
      const existing = await getPull(input.destination, forward.prNumber, token, signal);
      const observed = verifyCompensationPull(existing, forward, input.tenantId, token, actorLogin);
      if (observed.state === 'closed') return observed;
      const patched = await request(
        `${pullsUrl(input.destination)}/${forward.prNumber}`,
        token,
        signal,
        'PATCH',
        { state: 'closed' },
      );
      // PATCH cannot atomically exclude an external merge. Re-read the remote
      // state; once we wrote, a failed verification must remain UNKNOWN.
      try {
        await patched.body?.cancel();
        const closed = await getPull(input.destination, forward.prNumber, token, signal);
        const receipt = verifyCompensationPull(closed, forward, input.tenantId, token, actorLogin);
        if (receipt.state !== 'closed')
          throw failure('GITHUB_COMPENSATE_NOT_CLOSED', 'PR is still open', true);
        return receipt;
      } catch {
        throw failure(
          'GITHUB_COMPENSATE_OUTCOME_UNCERTAIN',
          'Could not verify that the PR is closed and unmerged after PATCH',
          true,
        );
      }
    },

    async queryCompensationOutcome(input) {
      const signal = operationSignal(input.signal);
      try {
        const forward = parseForwardReceipt(input.request.forwardResponse, input.destination);
        const token = await options.credentials.getGitHubToken(input.tenantId, input.destination);
        const actorLogin = await credentialLogin(token, signal);
        const pull = await getPull(input.destination, forward.prNumber, token, signal);
        const receipt = verifyCompensationPull(pull, forward, input.tenantId, token, actorLogin);
        return receipt.state === 'closed'
          ? { status: 'APPLIED', response: receipt }
          : unknownOutcome();
      } catch (error) {
        return queryFailure(error, signal);
      }
    },
  };
}
