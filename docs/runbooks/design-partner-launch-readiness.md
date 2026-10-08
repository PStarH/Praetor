# Design Partner Launch Readiness Runbook

**Status:** Normative during the feature freeze
**Target:** Technical readiness for one bounded E1 design-partner write pilot
**Expected duration:** 6-8 weeks for one focused technical owner
**Primary workflow:** Governed Kubernetes deployment rollback
**Initial deployment model:** One dedicated Commander deployment per partner

## 1. Outcome

This runbook turns Commander from a broad agent framework into a credible
design-partner offer for one narrow problem:

> Commander places high-risk agent actions behind a durable identity, policy,
> approval, effect, recovery, and evidence path so an ambiguous failure does not
> cause an unapproved or duplicate external write.

Completion authorizes technical promotion and E1 governed-write readiness. It
does not gate E0 interviews or read-only discovery, and it does not authorize a
general-availability, multi-tenant SaaS, SOC 2, or "zero failure" claim. Customer
field evidence is produced only after a bounded write pilot and customer review.

The launch profile is a dedicated, self-hosted deployment for a single partner.
Multi-tenant SaaS remains alpha and is not part of the initial offer.

E0-CONTACT may begin immediately with no credentials. E0-SHADOW may begin after
the read-only data boundary, consent, redaction, retention, and withdrawal rules
are agreed. G1-G8 are technical readiness gates for E1 and `PROVEN` claims; they
are not prerequisites for first customer contact.

## 2. Freeze Contract

### Allowed work

- Correctness, security, reliability, and operability fixes on the V2 path.
- Removal or simplification of code that weakens the primary workflow.
- Tests, fault drivers, benchmark harnesses, and evidence generation.
- Packaging, installation, release automation, and onboarding.
- Documentation and claim correction.
- Instrumentation required to measure the launch gates in this runbook.

### Prohibited work

- New providers, topologies, generic tools, memory systems, UI pages, or agent
  personas.
- New compliance reporters or checklist-only enterprise features.
- New workflow types before governed Kubernetes rollback is promotion-ready.
- Performance work without a measured launch-gate bottleneck.
- Refactors that do not close a gate in this document.

Every pull request must name the gate it closes. A change with no gate does not
merge during the freeze.

## 3. Product Boundary

### In scope

The golden workflow is a rollback of one Kubernetes `Deployment` in a disposable
or partner-owned sandbox namespace:

1. An agent or operator proposes a target revision.
2. Commander binds identity, tenant, destination, policy, and approval to one
   immutable action digest.
3. EffectBroker authorizes the external write and issues a fenced effect lease.
4. The Kubernetes adapter applies the rollback through the standard Kubernetes
   API.
5. Commander queries outcome before retrying an ambiguous operation.
6. Commander completes, compensates, or escalates the durable action.
7. Commander emits independently verifiable terminal evidence.

### Out of scope for the first campaign

- Autonomous production rollbacks without human approval.
- Shared multi-tenant hosted SaaS.
- General agent quality, coding ability, or research benchmarks.
- Claims that Commander reveals private model chain-of-thought.
- Claims that default quality gates prove factual correctness.
- More external action types, even when an adapter already exists.

Existing capabilities may remain available, but they do not appear in the first
headline, demo, benchmark conclusion, or design-partner success criteria.

## 4. Current Blockers

Treat this list as the initial queue. Re-check it at the start of the freeze.

- The default-branch and scheduled GitHub Actions are not consistently green.
- `pnpm arch:guard` currently reports an API-to-core boundary violation.
- `@praetor/core` is not published and there is no tagged GitHub release.
- The scheduled GAIA job currently fails before meaningful scoring because the
  SQLite native binding is unavailable on the runner.
- `scripts/action-operations-proof.ts` has no wired production campaign driver.
- `scripts/design-partner-proof.ts` validates a campaign but the repository does
  not provide the real external-process driver needed to produce it.
- `docs/baselines/ws9/summary.json` is `FAIL`. The committed summary records the
  live-fire environment gate failing (`postgres-non-owner-role`, `rls-with-check`,
  `vault-reachable`), so no case evidence was produced (`32/32` missing); earlier
  recorded runs failed because most cases were `simulated`. This does not block the
  dedicated-deployment offer, but it blocks any public multi-tenant production claim.
- Several public quality claims are stronger than the default implementation.

No blocker may be hidden by a skipped test, a fixture labelled as live evidence,
or a reduced threshold.

## 5. Launch Gates

All gates are fail-closed. "Mostly green" is not a pass.

### E0 source-demo lane (available before E1)

The first-user E0 lifecycle is deliberately narrower than these launch gates.
From a clean `master` source checkout, using Node 22.x and pnpm
9, run:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm exec tsx packages/core/src/cliEntry.ts --help
pnpm exec tsx packages/core/src/cliEntry.ts doctor --offline
pnpm demo:l4-a
```

This path requires no provider credential. `doctor --offline` must not contact a
provider. `demo:l4-a` is simulated/in-memory, performs no provider or
target-system write, and automatically stops the loopback servers it starts.
Clone, install, and build still write the local checkout, dependency cache, and
build output. No external infrastructure teardown is required; successful
command exit is the teardown boundary.

E0 completion is development/demo evidence only. It does not satisfy G2's
published-artifact install requirement, any E1 governed-write gate, or a
`PROVEN` or production-readiness claim. Provider-backed Local CLI use and the E1
dedicated-pilot path require their own consent, credentials, controls, and
evidence.

### G0 - Scope and claim integrity

Deliverables:

- README headline and first demo describe governed, recoverable agent actions.
- "Every output is verified", factual-accuracy, private thought streaming, and
  unproven multi-tenant production claims are removed or qualified.
- Repository description, README translations, website, and package metadata use
  the same provider count, benchmark status, version, and maturity labels.
- A claim registry maps every numeric or security claim to a reproducible
  artifact, command, commit, and evidence level.
- Simulated evidence is visibly labelled `simulated` and is never cited as field
  or live evidence.

Acceptance:

- No public claim lacks an evidence pointer.
- No alpha capability appears as available for production.
- `pnpm exec tsx scripts/ws9-honesty-gate.ts` passes for the claims that remain.

### G1 - Default branch is trustworthy

Required local gates from a clean checkout:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm lint
pnpm test
pnpm test:contract
pnpm arch:guard
pnpm test:deploy-gates
pnpm p0:kernel-e2e
```

Required CI evidence:

- All required default-branch jobs pass on Node 22.
- All scheduled benchmark workflows complete successfully for seven consecutive
  days.
- Native dependencies are built and exercised in CI; a missing binding is a hard
  failure during install or preflight, not during a benchmark.
- Dependency audit has zero known high or critical production vulnerabilities.
- Branch protection requires the canonical gate set and prevents direct merge on
  red.

Acceptance:

- Seven consecutive green daily snapshots are linked from the release evidence.
- There are no unexplained skips in required suites.
- The release candidate commit has a clean working tree.

### G2 - Install and first run work outside the repository

Decide and document the public package names before implementation. If the npm
scope cannot be owned, rename before the first release; do not publish an
uninstallable placeholder.

Deliverables:

- Publish the minimum package dependency closure needed by the CLI, or bundle it
  so users do not receive unresolved `workspace:*` dependencies.
- Create a signed/tagged GitHub release with checksums, changelog, supported Node
  versions, known limitations, and rollback instructions.
- Add a fresh-environment smoke job that installs only published artifacts.
- Provide one command that starts the dedicated pilot stack and one command that
  removes it.

Acceptance environments:

- Fresh Ubuntu runner, Node 22.
- Fresh macOS runner, Node 22.
- Linux container with no repository checkout and no pnpm global state.

Acceptance:

- Install, `--help`, `doctor`, golden demo, and teardown all exit zero.
- Time from install command to visible successful evidence is under 10 minutes,
  excluding image download time.
- No secret is requested until a step that needs it.

### G3 - One durable authority path

The V2 Gateway, Postgres kernel, worker plane, EffectBroker, adapter-ops, and
Kubernetes adapter must form one path. A production-mode fallback to V1 local
state is a failure.

Required proofs:

```bash
pnpm proof:authority
pnpm p0:full-loop
pnpm proof:action-operations -- --provider github --fault-campaign full --output <dir>
```

The action-operations command currently lacks a production campaign driver.
Wiring a real sandbox driver is part of this gate. GitHub remains a supporting
adapter proof; the launch benchmark uses the Kubernetes driver described in G5.

Acceptance invariants:

- Gateway is the only public HTTP authority.
- Every run, step, effect, lease, terminal disposition, and evidence record is
  durable in PostgreSQL.
- Worker and adapter-ops use distinct workload identities and database roles.
- Effect-producing paths cannot bypass EffectBroker.
- A stale lease or fencing epoch cannot write.
- Startup and readiness fail closed when kernel, policy, signing, or adapter
  dependencies are unavailable.
- All proof artifacts identify the clean commit, lockfile hash, image digests,
  schema/contract version, and environment.

### G4 - Verifiable evidence and recovery

Deliverables:

- Every terminal action has an immutable action digest, policy snapshot, approval
  reference, effect disposition, external-system observation, and signed receipt.
- Receipts verify in a separate process using retained public keys.
- Key rotation verifies pre-rotation and post-rotation receipts and rejects a
  revoked signer.
- Backup/restore preserves receipts, evidence anchors, identity, and outcome
  accounting.
- Unknown outcomes are durable, visible, and never converted into an automatic
  retry without an outcome query.

Required drills:

```bash
pnpm rotate:verify
pnpm dr:verify
```

Acceptance:

- Receipt verification success: 100% of terminal benchmark cases.
- Evidence persistence success: 100% of terminal benchmark cases.
- Signed terminal evidence is available within 60 seconds for every case.
- Every ambiguous outcome is resolved or escalated within 5 minutes.
- Restore report is `PASS`/`PROVEN`, with measured RPO and RTO recorded.
- Retained public evidence contains no credentials, prompts, raw payloads, tokens,
  private keys, database URLs, or customer data.

### G5 - Governed rollback benchmark

Build one canonical benchmark command during the freeze:

```bash
pnpm benchmark:governed-rollback -- \
  --environment kind \
  --repetitions 100 \
  --output artifacts/governed-rollback
```

`benchmark:governed-rollback` is a planned command and does not exist yet. It
must orchestrate the existing production path rather than call kernel or adapter
internals directly.

#### Environment contract

- Fresh Kind cluster and dedicated namespace.
- Real Kubernetes API and `kubernetes.deployment.rollback` adapter.
- Real PostgreSQL with non-owner roles.
- Separate Gateway, worker, kernel-ops, and adapter-ops processes or containers.
- External-process fault driver with its own identity.
- Images pinned by digest.
- Clean release-candidate commit and frozen dependency lock.
- Fixed benchmark manifest committed before the scored run.

Mocked Kubernetes, in-memory repositories, same-process drivers, dirty source,
or direct repository calls may be used for development but cannot produce a
scored artifact.

#### Scenario matrix

Run every existing design-partner scenario 100 times, split across at least three
fresh environment rebuilds:

| Scenario                | Expected outcome                                      | External writes |
| ----------------------- | ----------------------------------------------------- | --------------: |
| `tenant_isolation`      | denied                                                |               0 |
| `identity`              | denied                                                |               0 |
| `policy_binding`        | denied                                                |               0 |
| `approval_binding`      | denied                                                |               0 |
| `mutation_resistance`   | denied                                                |               0 |
| `lease_fencing`         | one fenced rollback completes                         |               1 |
| `idempotency`           | replay returns the original outcome                   |               1 |
| `ambiguous_completion`  | query confirms the committed rollback                 |               1 |
| `confirmed_not_applied` | query permits one controlled retry or terminal no-op  |               1 |
| `irreducible_unknown`   | escalated; no blind retry                             |               1 |
| `compensation`          | separately authorized compensation completes          |               2 |
| `kill_switch`           | denied before adapter invocation                      |               0 |
| `evidence`              | terminal evidence persists or the action fails closed |               1 |
| `recovery`              | process restart resumes from durable state            |               1 |
| `backup_restore`        | restored state and receipt verify                     |               1 |

Inject each declared lifecycle fault through the external driver:

- `before_remote_request`
- `after_remote_commit`
- `before_local_complete`
- `during_outcome_query`
- `during_compensation`
- `during_evidence_persist`

The benchmark must include this compound fault as a named, non-optional case:
the Kubernetes API accepts the rollback, PostgreSQL fails while persisting the
terminal evidence, and the worker or operations process restarts. The expected
result is one logical rollback (one marker patch plus one rollback patch), a
durable `COMPLETION_UNKNOWN` state, a query-only reconciliation, and one
independently verifiable terminal receipt.
An `APPLIED` query must complete the existing effect without invoking the write
adapter again; an unprovable query must remain `UNKNOWN` or escalate.

#### Primary metrics and thresholds

| Metric                                |                          Launch threshold |
| ------------------------------------- | ----------------------------------------: |
| Consequential duplicate writes        |                                         0 |
| Denied-scenario external writes       |                                         0 |
| Stale-lease writes                    |                                         0 |
| Kill-switch bypasses                  |                                         0 |
| Cross-scope writes                    |                                         0 |
| Unverified terminal receipts          |                                         0 |
| Terminal cases missing evidence       |                                         0 |
| Ambiguous cases without outcome query |                                         0 |
| Unknown resolution/escalation         |                     100% within 5 minutes |
| Proposal/admission latency            | p95 under 1 second, excluding IdP latency |
| Terminal evidence latency             |                    100% within 60 seconds |

Report exact counts such as "0 duplicate writes in 1,500 scored trials." Do not
turn a zero observed count into a claim that the true failure rate is zero.

#### Comparative experiment

Run the same action intents, target cluster, adapter, and fault schedule in three
arms:

1. Direct tool invocation with retry on timeout.
2. OpenAI Agents SDK direct tool invocation with the same retry policy.
3. OpenAI Agents SDK with the action routed through Commander.

The comparison measures the contribution of the control plane, not the quality
of the model or a defect in another SDK. Pin model, prompt, tool schema, seed
where supported, and recorded action intents. Publish all configuration and
measure:

- duplicate writes;
- incorrect terminal dispositions;
- unresolved unknowns;
- recovery time;
- evidence completeness;
- p50/p95 admission and end-to-end latency;
- incremental compute and token cost.

No result is publishable unless all arms finish and all raw results are retained.
Unexpectedly strong baseline results remain in the report.

#### Live-model end-to-end check

After the deterministic campaign passes, run 50 live-model trials with the same
pinned model and tool schema:

- 25 golden-path proposals.
- 25 response-loss-after-commit proposals.

The model may choose or describe an action, but it cannot bypass the governed
action path. Publish model/version, date, prompt set hash, token usage, cost, and
all failed or ungraded trials.

#### Benchmark integrity rules

- Pre-register thresholds, repetitions, fault seeds, and exclusions in a
  versioned manifest before running the release candidate.
- Store raw events, metrics, receipts, verification output, environment manifest,
  and hashes.
- Calculate p50/p95 from raw samples and publish 95% confidence intervals for
  proportions.
- Never discard warmup or failed runs after seeing results. Define exclusions in
  the manifest.
- Reproduce the final result once in GitHub Actions and once on a clean local or
  independent machine.
- A benchmark job that cannot start is red, not "ungraded" and not a retained
  green baseline.

### G6 - Security floor for a dedicated pilot

The first offer is dedicated deployment, so the full WS9 multi-tenant campaign
is not a launch blocker. The following security floor is mandatory:

- Zero open P0/P1 findings in the scoped production path.
- Zero high or critical production dependency advisories.
- Production execution cannot fall back to host execution or a soft sandbox.
- Secrets are supplied through the documented secret path and are absent from
  logs and retained evidence.
- Policy, approval, destination, and arguments are digest-bound before execution.
- Network egress is allowlisted for the Kubernetes API and required services.
- Audit/evidence failure blocks the effect or leaves a durable actionable state.
- Threat model covers credential theft, confused deputy, replay, stale worker,
  response loss, malicious tool output, and evidence tampering.

Run WS9 as an honesty check. Until every required WS9 case is live and the
summary verdict is `PASS`, public material must say:

> Dedicated deployment for design partners. Shared multi-tenant SaaS is alpha
> and not included in this pilot.

### G7 - Design-partner experience

Deliverables:

- A 10-minute self-hosted quickstart using a disposable Kind namespace.
- A 90-second recorded demo showing response loss after remote commit, worker
  restart, outcome query, no duplicate rollback, and verified receipt.
- An operator view for approval, current action state, unknown outcome,
  compensation, kill switch, and evidence download. Use existing UI surfaces;
  do not add unrelated pages.
- A one-page architecture and data-flow description.
- A pilot security note, data-retention note, teardown procedure, and limitations
  list.
- A bounded pilot agreement template with one workflow, one namespace, named
  approvers, escalation owner, success metrics, and kill criteria.
- A support runbook covering install, health, logs, backup, restore, key rotation,
  rollback, and removal.

Acceptance usability test:

- A technically competent person who did not build the workflow follows only the
  public quickstart.
- They install, submit, approve, observe, verify evidence, trigger the kill
  switch, and tear down without private guidance.
- Every confusion or undocumented recovery step becomes a blocker or a doc fix.

### G8 - Release evidence bundle

Create one immutable evidence bundle for the release candidate containing:

- release tag, commit, clean-source attestation, lockfile hash, and image digests;
- CI and seven-day scheduled-workflow links;
- install-smoke reports for all acceptance environments;
- authority, action-operations, DR, rotation, and governed-rollback manifests;
- raw benchmark metrics and the pre-registered benchmark manifest;
- signed receipt samples and independent verification output;
- threat model and scoped security review;
- claim registry and known limitations;
- SBOM, dependency audit, license inventory, and checksums;
- quickstart usability-test notes.

Public evidence must be sanitized. Raw private artifacts stay in access-controlled
CI storage. Publish hashes so a retained artifact can be matched to the reviewed
run without exposing secrets or customer data.

## 6. Technical Proof and Field Proof

Use the existing proof vocabulary precisely:

- `PROVEN`: clean-source technical campaign passed against a real external
  system, including DR and signing rotation.
- `FIELD-PROVEN`: a real design partner ran the workflow and signed the customer
  acceptance artifact with zero critical bypasses.

E0 contact does not require `PROVEN`. An E1 governed-write launch requires
`PROVEN`, not `FIELD-PROVEN`; the latter is impossible before a partner exists.

Generate technical proof with:

```bash
pnpm design-partner:proof -- \
  --config <release-proof-config.json> \
  --output <evidence-directory>
```

After a partner observation window, generate field review with:

```bash
pnpm design-partner:proof -- \
  --technical-manifest <manifest.json> \
  --customer-acceptance <acceptance.json> \
  --customer-public-key <partner-public-key.pem> \
  --output <field-evidence-directory>
```

Do not describe technical proof as customer adoption.

## 7. Execution Sequence

### Week 0 - Freeze and delete misleading surface

- Publish the freeze contract.
- Select governed Kubernetes rollback as the only primary workflow.
- Correct claims and repository metadata.
- Turn every current red CI/benchmark result into a tracked blocker.
- Mark multi-tenant SaaS and broad quality claims out of scope.

Exit: G0 passes and every subsequent gate has a named owner and artifact path.

### Week 1 - Green branch and distribution

- Fix architecture guard, dependency audit, native binding installation, and
  scheduled workflows.
- Define the canonical CI gate set.
- Resolve npm scope and dependency closure.
- Add clean install and teardown smoke tests.

Exit: G1 and G2 pass once; the seven-day observation window starts.

### Week 2 - Close the production path

- Remove or block effect bypasses and legacy fallbacks.
- Wire the real action-operations campaign driver.
- Prove distinct identities, roles, leases, fencing, and readiness.
- Run authority and full-loop proofs from clean source.

Exit: G3 passes with real PostgreSQL and retained evidence.

### Week 3 - Evidence, recovery, and fault driver

- Complete signed receipt verification, rotation, and DR evidence.
- Build the external-process Kind/Kubernetes fault driver.
- Make all 15 scenarios and six fault points observable.
- Verify retained artifacts are sanitized and hashed.

Exit: G4 passes and one full unscored campaign completes.

### Week 4 - Scored benchmark

- Commit the benchmark manifest before the scored run.
- Run the deterministic three-arm campaign.
- Run the live-model end-to-end check.
- Reproduce on GitHub Actions and a second clean environment.
- Generate the public report from raw artifacts.

Exit: G5 and G6 pass without threshold changes.

### Week 5 - Onboarding and release candidate

- Finish quickstart, demo, operator workflow, pilot template, and support docs.
- Run the independent usability test.
- Build the release evidence bundle.
- Start or complete the seven-day green observation window.

Exit: G7 and G8 pass.

### Week 6-8 - Buffer, independent review, and E1 readiness

- Fix only launch blockers found by independent review.
- Re-run affected proof and benchmark gates from clean source.
- Tag the release and freeze its evidence bundle.
- Confirm the E1 bounded-write offer only after a buyer, action, reviewer, and
  paid pilot/LOI exist from the parallel E0 lane.

## 8. Promotion-Ready Review

Use a planned aggregate command once the underlying gates exist:

```bash
pnpm launch:verify -- --release <tag> --evidence <bundle-directory>
```

`launch:verify` exists and validates the source attestation, image and lockfile
identifiers, gate verdict schemas, artifact hashes, and retained-evidence secret
scan. It does not re-implement the underlying tests, and its successful exit is
only one input to the ship decision; every applicable gate and independent
review must also pass.

The release is promotion-ready only when every answer is yes:

- [ ] Is the public offer one governed workflow for one clear user?
- [ ] Are the default branch and scheduled workflows green for seven days?
- [ ] Can a new user install published artifacts without cloning the repository?
- [ ] Does the production path have one durable authority and no effect bypass?
- [ ] Did all 1,500 deterministic scenarios meet their exact write counts?
- [ ] Were there zero consequential duplicate writes and zero kill-switch bypasses?
- [ ] Did every terminal case produce independently verified evidence?
- [ ] Did every ambiguous case query outcome before any retry?
- [ ] Did DR and signer rotation pass from clean source?
- [ ] Are comparative results complete, reproducible, and honestly framed?
- [ ] Does the security floor pass with no open P0/P1 issue?
- [ ] Did an independent reader complete quickstart and teardown unaided?
- [ ] Does every public claim point to evidence in the release bundle?
- [ ] Are all limitations, including dedicated deployment and multi-tenant alpha,
      visible before installation?

One "no" means do not launch. Fix the failed gate; do not weaken the checklist.

## 9. Initial Public Message

Use a claim no stronger than the release evidence:

> Commander is a self-hosted control layer for high-risk AI agent actions. Its
> first design-partner workflow governs Kubernetes deployment rollback with
> approval binding, durable idempotency, outcome reconciliation, compensation,
> kill switches, and independently verifiable evidence.

The first call to action is a bounded design-partner pilot, not a general signup:

> We are recruiting platform and SRE teams willing to test one approval-gated
> rollback workflow in a dedicated sandbox namespace. The pilot has explicit
> kill criteria, publishes measured reliability evidence, and does not require
> autonomous production access.

Do not lead with provider count, topology count, total test count, code size,
generic multi-agent intelligence, or acquisition intent. Lead with the incident
the system prevents and the evidence that it prevented it.

## 10. After Recruitment Starts

For each partner:

1. Select one reversible, consequential workflow and one escalation owner.
2. Agree on external-write, latency, recovery, evidence, and kill thresholds.
3. Start in a dedicated sandbox namespace with mandatory approval.
4. Run shadow/dry-run traffic before authorizing a real write.
5. Collect signed customer acceptance only after the agreed observation window.
6. Publish a case study only with partner approval and exact measured counts.

The next product direction is chosen from repeated partner blockers. Feature
development does not resume merely because the launch gates passed.

## 11. Shadow Pilot Phase A Readiness

For a customer-cloud historical evaluation, use the materials in
[`docs/pilot/shadow`](../pilot/shadow/README.md) before any sample is prepared.
The engagement is limited to `kubernetes.deployment.rollback`, customer-operated
PostgreSQL evidence, and a declared historical sample. It has no effect-producing
runtime path.

- [ ] The customer charter names platform, security, policy, sample, retention,
      deletion, export, usefulness, mismatch-adjudication, and stop-condition
      owners.
- [ ] A fixed `policyId` and `policyDigest`, observation window, and 1–30 day
      retention period are recorded.
- [ ] The data-boundary review excludes prohibited free-form content and missing
      facts are represented as `null`.
- [ ] PostgreSQL TLS, schema version, tenant binding, key configuration, and
      cleanup freshness pass readiness before manifest registration.
- [ ] The customer accepts the report limitations: signatures bind the report
      body, but do not establish sample completeness or rollback outcomes.
- [ ] Legal/DPA review is owned as an external review, not inferred from a
      command exit status.
