# GitHub pilot: approve an agent action, then recover its result

Commander sits between a Coding / DevOps agent and an external write. The first
pilot action is **creating a pull request from an existing branch in the same
repository**. Your agent proposes the action; a separately authenticated human
approves the exact request. If a response is lost, the recovery path queries
GitHub using the persisted action identity and approved parameters.

This is an alpha pilot, not a general production-readiness claim. It does not
write code, push branches, merge PRs, dispatch Actions, or deploy Kubernetes.
GitHub reviews and checks still decide whether code should merge.

## Try the contract without credentials

From this source checkout, using Node 22 and the pinned pnpm version:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @praetor/contracts build
pnpm --filter @praetor/effect-broker build
pnpm test:github:offline
pnpm demo:github --help
```

The GitHub launch contracts job runs this sequence on a clean Ubuntu runner
with Node 22. It installs pnpm through `pnpm/action-setup` rather than
`corepack enable`. `demo:github --help` does not contact a Gateway.

The offline command runs real adapter code against synthetic GitHub responses
and real loopback HTTP servers. It tests lost-response lookup, request drift,
unsafe pagination, merge/close races, credential separation in the CLI, and
transport cancellation. **It creates no real PR and proves no PostgreSQL restart.**
A passing test suite is an engineering check, not a customer demo recording.

## Run against a configured Gateway

Use the existing [Gateway deployment](../../enterprise/quickstart.md) and
[readiness runbook](../../runbooks/design-partner-launch-readiness.md). The CLI
connects to that deployment; it does not silently start an in-memory replacement.
A PostgreSQL-backed API, worker, kernel-ops and adapter-ops must already be healthy,
with signed evidence configured and a policy requiring approval for both create
and compensation. There is no published one-command production installer here.

Prepare a sandbox repository and distinct existing head/base branches with a
real diff. Install a GitHub App only on that repository. Its execution token
needs Pull requests: write; branch preparation is a separate operator action.
Configure `COMMANDER_GITHUB_REPOSITORIES=owner/repository` on the execution
services. Keep the GitHub token in the worker/adapter-ops environment, outside
the agent process.

Create two Commander identities for the same tenant:

- **Agent:** proposal and read access, without `actions:approve`, admin or `*`.
- **Approver:** human identity with `actions:approve` and access to the tenant.

The following is an operator-driven API demo. Its proposal uses `model=none`;
it does not pretend a model made the decision. An actual agent can propose via
the existing [MCP consumer](../../../integrations/openai-agents-mcp/README.md),
with only the Agent credential.

### 1. Propose in the Agent process

Set `COMMANDER_GITHUB_DEMO_GATEWAY_URL`,
`COMMANDER_GITHUB_DEMO_TENANT_ID`, and
`COMMANDER_GITHUB_DEMO_AGENT_TOKEN` through your secret manager or shell.
Do not give this process the approver credential.

```sh
pnpm demo:github propose \
  --operation-id pilot-pr-001 \
  --destination github://YOUR_OWNER/YOUR_SANDBOX/pulls \
  --head pilot-fix --base main \
  --title 'Agent-proposed dependency fix' \
  --body 'Review the prepared branch before merging.'
```

Save the returned `runId`, `actionDigest`, `simulationId` and
`policySnapshotId`. The expected state is `AWAITING_APPROVAL`. Repeating the
same proposal with the same operation ID must resolve the same operation;
changing the request under that ID must be rejected. A new ID is a new action,
not semantic deduplication.

On this sandbox action, test that the Agent identity is refused:

```sh
pnpm demo:github verify-agent-boundary --run-id RUN_ID
```

Success means the API returned `403 ACTION_APPROVAL_FORBIDDEN`, not merely that
a button was hidden. This is an actual approval attempt: if you accidentally
provided an administrator token it could approve the sandbox action. A failed
boundary check means stop the demo and correct the identity scopes.

### 2. Approve in a separate human process

Use a separate process/session containing the Gateway URL and tenant ID, and
`COMMANDER_GITHUB_DEMO_APPROVER_TOKEN`. Do not expose that token to the Agent.
Review the PR proposal and prepared branch, then paste the exact binding from
step 1:

```sh
pnpm demo:github approve --run-id RUN_ID \
  --action-digest ACTION_DIGEST --simulation-id SIMULATION_ID \
  --policy-snapshot-id POLICY_SNAPSHOT_ID
```

Approval does not freeze branch contents. The branch can move, and the GitHub
adapter's `headSha` is an observation, not authorization of an immutable diff.

### 3. Observe and inspect evidence

Return to the Agent process:

```sh
pnpm demo:github status --run-id RUN_ID --wait-seconds 60
pnpm demo:github evidence --run-id RUN_ID
```

Inspect the PR in the sandbox repository by its head branch. The CLI currently
shows run/effect/bundle identifiers and the Gateway's safe evidence metadata;
it does not print the raw receipt, tokens or PR body. It relies on the Gateway's
evidence verification; it is not an independent offline signature verifier.

A lost response is **not** a reason to propose a new operation or rerun the
write with a new ID. Continue inspecting the original operation. Unreadable,
ambiguous or edited remote results remain unresolved for operator review.

When `status` returns `COMPLETION_UNKNOWN`, the JSON includes an `operator`
field. Staying in that state is the safe stop. The same field appears on
`evidence` when the Gateway reports one of these codes:

- `ADAPTER_HTTP_ERROR`: the remote call was rejected, including a revoked token. That does not prove the write is absent.
- `GITHUB_MULTI_MARKER`, `GITHUB_IDEMPOTENCY_CONFLICT`, `GITHUB_COMPENSATE_MARKER_MISMATCH`: the marker was duplicated or no longer matches. Do not pick a PR and write or close again.
- `GITHUB_PAGINATION_INVALID`, `GITHUB_PAGINATION_LIMIT`: the lookup did not see a complete result.
- `GITHUB_QUERY_ABORTED`: the lookup timed out. Inspect this run before another call.

None of these codes authorizes a new operation id.

### 4. Close only with a separate authorization

In the Agent process:

```sh
pnpm demo:github request-close --run-id RUN_ID
```

This reads the persisted forward receipt hash and requests compensation. It
must return `AWAITING_APPROVAL`. In the human process, use the new authorization
binding, not the original create approval:

```sh
pnpm demo:github approve-close --run-id RUN_ID \
  --authorization-id AUTHORIZATION_ID --action-digest CLOSE_ACTION_DIGEST \
  --policy-snapshot-id CLOSE_POLICY_SNAPSHOT_ID
```

Then inspect the returned compensation run:

```sh
pnpm demo:github status --run-id COMPENSATION_RUN_ID --compensation --wait-seconds 60
```

Closing cannot undo a merge, notifications, or triggered CI. There is no
implicit cleanup command: leaving a PR open is preferable to an unauthorized
close. If a response was lost, inspect the original operation before taking
manual action.

## What CI does and does not prove

| Evidence            | Entry point                                                      | Boundary                                                                                                       |
| ------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Offline regression  | `test:github:offline` / `github-launch-contract`                 | Synthetic GitHub/Gateway responses and loopback transport; no model, no external writes                        |
| Durable kernel/cell | Existing `kernel-postgres-integration`, `l4-b-cell-runtime` jobs | Real PostgreSQL/container wiring, synthetic GitHub peer; inspect the actual run result                         |
| Real GitHub adapter | Opt-in `github-sandbox-adapter` job                              | Actual create, response loss, read-only lookup and close; no Gateway approval or PG restart proof              |
| Complete live pilot | Pending                                                          | Independent identities + live GitHub + cut response + actual worker restart from the same PostgreSQL operation |

To configure the optional adapter job, create a `github-sandbox` Actions
Environment with required reviewer and branch restrictions. Set environment
secrets `COMMANDER_SANDBOX_APP_ID` and `COMMANDER_SANDBOX_APP_PRIVATE_KEY`, and variables:

- `COMMANDER_SANDBOX_OWNER`, `COMMANDER_SANDBOX_REPO`, `COMMANDER_LIVE_APPROVED_REPO` (exact `owner/repo`).
- `COMMANDER_SANDBOX_BASE`, `COMMANDER_SANDBOX_HEAD`, `COMMANDER_SANDBOX_RESPONSE_CUT_HEAD` (distinct prepared branches).

GitHub rejects secret and variable names that start with `GITHUB_`, so these names do not use that prefix.

Dispatch CI with `run_github_live_proof=true`. The job mints a short-lived App
token restricted to the exact sandbox. It can read that repository and write pull requests, and it cannot write repository contents.
It is not reachable from pull-request events. Explicit live selection with
missing prerequisites fails; ordinary offline runs may skip the live suites.
The job creates up to two test PRs and explicitly closes them as adapter test
operations, outside the governed demo. On failure, inspect the retained TAP
and sandbox PR list before rerunning. Artifacts bind the test to the commit SHA
and adapter version; they do not certify the whole product.

## Exercise recovery across a worker restart

The `l4-b-cell-runtime` CI job now includes `pnpm cell:github-recovery --up`.
It starts a disposable cell, seeds separate Agent and approver identities in the
real PostgreSQL auth store, and invokes the demo CLI in separate processes with
only each role's credential. The Agent must receive the actual approval denial.

The synthetic HTTPS provider commits a PR, sends 201 headers, and cuts its response
body. Once `COMPLETION_UNKNOWN` is persisted, the test kills and starts the worker,
then lets adapter-ops reconcile the original operation. It checks the same run,
effect, idempotency key and request hash, verifies evidence, replays the proposal,
and separately approves closing the unmerged PR. Exactly one create and one close
must reach the provider. A separate oracle credential stays outside the execution
services.

The same disposable cell then runs a second operation. The provider commits that
PR and leaves the 201 response open. The test kills the worker while the effect
is still `ADMITTED`, waits for lease reclaim to park `COMPLETION_UNKNOWN`, and
resumes reconciliation. The second create must stay at one call. This is still
the synthetic provider. It does not prove the same window against live GitHub.

**Run this command only on a disposable cell:** `--up` uses the existing cell reset,
including deleting its volumes and replacing `commander-postgres`. Do not run it
against an existing deployment you want to retain.

The artifact `artifacts/github-cell-recovery.json` records source SHA/dirty state,
adapter version, operation identities, worker start times, provider counts and
the actual pass/failure result. Adding this test is not a passing CI result;
inspect the artifact from the commit being evaluated. The provider remains
synthetic, and this is not a live GitHub or model-inference demonstration.

## Current trial boundary

The supported trial on this source tree is the credential-free contract above
and the synthetic cell recovery that CI runs, including the kill while a create
is committed and the effect is still `ADMITTED`. Live GitHub through the
Gateway, disaster-recovery rotation, and a recorded model call are outside that
trial. `pnpm cell:github-recovery --up` resets a disposable cell; it is not the
install command.

## Before calling this a public launch

Still required: a recorded end-to-end live Gateway run with two identities;
response loss followed by a real worker restart and original-operation recovery;
a fair native-tools comparison; and fresh-checkout trials by external developers.
No installation-time or adoption claim is justified until those trials happen.

Read [native controls](native-controls.md) before choosing Commander, and the
[threat model](threat-model.md) before configuring a pilot.
