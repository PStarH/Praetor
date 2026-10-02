<p align="center">
  <a href="https://github.com/PStarH/Commander/actions/workflows/ci.yml?query=branch%3Amaster"><img src="https://img.shields.io/github/actions/workflow/status/PStarH/Commander/ci.yml?branch=master&style=flat-square&label=CI&logo=github" /></a>
  <img src="https://img.shields.io/github/license/PStarH/Commander?style=flat-square&color=EAB308" />
</p>

<h1 align="center">Commander</h1>
<p align="center"><strong>Approval and recovery for Coding / DevOps agents — GitHub pilot · alpha</strong></p>

> **Alpha notice:** Commander is not production-ready. Treat outputs, benchmarks,
> POC scenarios, and dashboard values as development or demo signals. Do not use
> it for unattended production workloads or sensitive data without your own review.

<p align="center">
  <code>pnpm demo:github --help</code><br>
  <sub>A step-by-step GitHub action pilot using the real Gateway. Requires a configured deployment for external writes.</sub>
</p>

<p align="center">
  <a href="#quick-start"><img src="https://img.shields.io/badge/TRY_NOW-000?style=for-the-badge" /></a>
  <a href="https://github.com/PStarH/Commander/stargazers"><img src="https://img.shields.io/github/stars/PStarH/Commander?style=social" /></a>
  <a href="https://github.com/PStarH/commander-docs"><img src="https://img.shields.io/badge/DOCS-000?style=for-the-badge" /></a>
</p>

---

## What is Commander

An agent asks to open a pull request. A human approves it. GitHub accepts the
write—but the worker loses the response. Did it happen, and what should the
next worker do?

Commander keeps the approved request and its execution state together. Its
GitHub adapter can query for a matching result after response loss, preserve an
unresolved outcome when the evidence is ambiguous, and close an unmerged PR
only through a separately authorized compensation action.

The first pilot is intentionally narrow: **same-repository PR creation from
existing branches**. It does not generate or push code, merge PRs, or deploy to
production. Branch contents still need GitHub review and checks.

- [Run the GitHub pilot](docs/pilot/github/README.md): propose → approve → inspect → separately authorize close.
- [Why not just GitHub permissions and Actions approval?](docs/pilot/github/native-controls.md): native controls are often enough; use Commander when shared action identity, recovery and evidence justify the integration.
- [Security boundary and limitations](docs/pilot/github/threat-model.md): a correlation marker is not a signature, and external effects are not universally exactly-once.

The adapter contracts and CLI have automated local tests. A manually
dispatched CI job runs the real Gateway, worker and PostgreSQL against the
real GitHub API for one sandbox repository: a test proxy drops or holds the
create response, the worker is killed and restarted, and the new worker finds
the existing PR instead of creating a second one. The lost response is
injected by that proxy, not a natural network fault. No adoption or
production-readiness claim is implied. The existing local agent runtime and
read-only review tools are also available below.

---

## Runtime paths

The GitHub pilot uses the **Enterprise Gateway**, a durable server path that
is still **alpha**. The **Local CLI** is a separate local agent runtime; its
simulated demo does not prove the Gateway's governed-write behavior.

|                    | Local CLI                                                                     | Enterprise Gateway                                                     |
| ------------------ | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **Entry**          | `commander review --real` (first provider trial); other commands remain alpha | `POST /v1/runs` via `apps/api`                                         |
| **State**          | Local SQLite / JSON (`.commander_state/`)                                     | Postgres kernel (`runs`/`steps`/`events`/outbox/leases)                |
| **Auth**           | None (single user)                                                            | `COMMANDER_API_KEY` + JWT tenant claims                                |
| **Tenancy**        | None (implicit `__default__`)                                                 | Alpha — kernel RLS + tenant-aware singletons; storage isolation opt-in |
| **Durable kernel** | No                                                                            | Yes (auto-on in production / when a Postgres DSN is set)               |
| **Status**         | Alpha local evaluation tool — not production-ready                            | Alpha — not yet live-fire-proven on real backends                      |

The first-user path below is a source-based **E0 simulated demo**. It needs no
credentials, makes no provider or target-system writes, and is separate from
provider-backed Local CLI use and the E1 Enterprise Gateway pilot path. Clone,
install, and build still write the checkout, dependency cache, and build output
on your machine.

---

## Quick Start

For the new GitHub action path, follow the [pilot guide](docs/pilot/github/README.md).
It separates credential-free contract tests from the configured Gateway demo
and the opt-in real GitHub adapter tests. The local runtime demo below remains
a separate simulated example. Its animation is the local CLI, not a recording
of GitHub approval or response-loss recovery.

<p align="center">
  <img src="docs/assets/commander-watch-demo.svg" alt="Local CLI help animation. This is not a GitHub recovery recording." width="100%">
</p>

### E0 simulated demo (recommended first run)

Use Node.js 22.x and pnpm 9 (Corepack selects the repository's pinned pnpm
version). This lifecycle runs entirely from a source checkout:

The clone and a cold install need ordinary access to GitHub and the package
registry. The `--offline` flag means no provider request, not a network-free
installation.

```bash
git clone https://github.com/PStarH/Commander.git
cd Commander
corepack enable
pnpm install --frozen-lockfile
pnpm build

pnpm exec tsx packages/core/src/cliEntry.ts --help
pnpm exec tsx packages/core/src/cliEntry.ts doctor --offline
pnpm demo:l4-a
```

`doctor --offline` checks local prerequisites without contacting an LLM
provider. `demo:l4-a` uses simulated/in-memory dependencies and loopback
servers; it does not invoke a real provider or perform an external write. The
demo owns and automatically stops its loopback servers, so there is no external
resource teardown command. Successful command exit completes E0 teardown.

Passing this path is development/demo evidence only. It is not a published
package install, an E1 governed-write proof, or evidence that Commander is
production-ready.

### Provider-backed read-only review (first real-provider trial)

```bash
# Choose one provider explicitly.
export OPENAI_API_KEY=sk-...
pnpm exec tsx packages/core/src/cliEntry.ts review \
  --commit HEAD --real --provider=openai

# Or use Anthropic.
export ANTHROPIC_API_KEY=sk-ant-...
pnpm exec tsx packages/core/src/cliEntry.ts review \
  --commit HEAD --real --provider=anthropic
```

This command reads the selected Git diff and local review guidelines, sends at
most 15,000 diff characters to the explicitly selected provider, and caps the
provider response at 4,000 tokens. Commander aborts provider transport after
120 seconds and rejects a response body over 8 MiB before JSON parsing. The
provider/model receives no
execution tools, so it cannot initiate commands, file edits, web browsing, or
target-system writes. The CLI itself runs fixed, read-only `git diff` commands
and updates cross-process rate-limit state in the system temporary directory.
Output identifies `source=real`, provider, model, endpoint host, prompt byte
count, the actual represented portion of a truncated diff, and the
completed-response cap. Missing credentials, empty diffs, provider errors,
timeouts, oversized responses, and
invalid structured output fail with a nonzero exit status instead of falling
back to a simulated review.

The diff and guidelines leave your machine, may contain repository-sensitive
material, and are subject to provider retention. Read [PRIVACY.md](PRIVACY.md)
first. Ordinary `commander run`, `pnpm gui`, MCP, SDK, and Enterprise Gateway
flows are not part of this first-user path and must not be presented as
read-only or production-ready.

### Enterprise Gateway (alpha)

This first-user guide intentionally does not provide a runnable Gateway command:
the path requires additional secrets, PostgreSQL, and operational controls.
For enterprise evaluation, use [Shadow Pilot Phase A](docs/pilot/shadow/README.md),
which evaluates historical observations and performs no external rollback.
The gated [live-write reference](docs/enterprise/quickstart.md) must be read with
[ENTERPRISE_READINESS.md](ENTERPRISE_READINESS.md). The bounded E1
design-partner workflow remains gated by the
[launch-readiness runbook](docs/runbooks/design-partner-launch-readiness.md).
Starting a development Gateway is not authorization or proof for external
writes, and shared multi-tenant use remains alpha.

---

## Key Features

### Deliberation Engine

Task classification, complexity estimation, and topology selection — all automatic. Commander classifies your task (CODING / RESEARCH / ANALYSIS / FACTUAL), estimates complexity, and picks from 5 canonical topologies: SINGLE, CHAIN, DISPATCH, ORCHESTRATOR, REVIEW. A one-line task uses 1 agent. A cross-repository audit can fan out to 15 agents.

### Live Streaming

Agent events, tool calls, and configured gate decisions stream to your terminal or SSE endpoint. Not polling. Not logs after the fact. You can inspect the emitted work trace step by step.

```
┌─ Deliberation ──────────────────────────────────────────────┐
│ Task: "audit this repo for security issues"                  │
│ Classification: ANALYSIS · Complexity: 7/10                  │
│ Topology: DISPATCH (3 agents)                                │
├─ Agent α (security-scanner) ─────────────────────────────────┤
│ [event] Scanning package.json for known CVEs...              │
│ [tool] npm audit · 2 critical, 5 moderate                    │
│ [gate] ACCURACY ✓ · COMPLETENESS ✓                           │
├─ Agent β (code-reviewer) ────────────────────────────────────┤
│ [event] Checking for hardcoded secrets...                    │
│ [tool] grep · found 1 potential secret in config.ts          │
│ [gate] SAFETY ⚠ · Potential secret detected                  │
├─ Agent γ (dependency-checker) ───────────────────────────────┤
│ [event] Analyzing license compliance...                      │
│ [tool] license-check · No GPL/AGPL dependencies              │
│ [gate] COMPLETENESS ✓ · ACCURACY ✓                           │
├─ Synthesizer ────────────────────────────────────────────────┤
│ Merging 3 agent outputs...                                   │
│ Leader synthesis · 4 findings, 2 critical                    │
└──────────────────────────────────────────────────────────────┘
```

### 25 Providers with Auto-Failover

Set any one API key. Commander detects your provider, and if it fails, falls through a configurable chain. OpenAI → Anthropic → DeepSeek → Groq → Ollama — you define the order, Commander handles the routing.

OpenAI · Anthropic · Google · Azure · DeepSeek · GLM · MiMo · Xiaomi · Groq · Together · Perplexity · Fireworks · Replicate · Mistral · Cohere · OpenRouter · xAI · Anyscale · DeepInfra · Agnes · Ollama · vLLM · AWS Bedrock · StepFun · MiniMax

### Configured Quality Gates

On paths with the verification pipeline enabled, Commander runs these 5 configured checks before returning a result:

| Gate          | What it checks                              |
| ------------- | ------------------------------------------- |
| Hallucination | LLM-as-Judge detection of fabricated facts  |
| Consistency   | Cross-agent agreement, no contradictions    |
| Completeness  | All required dimensions covered             |
| Accuracy      | Factual correctness against source material |
| Safety        | Content scanning, injection detection       |

If the output fails a configured gate, the system retries or reports the failure with full context.

### Resilience

| Capability        | Implementation                                                     |
| ----------------- | ------------------------------------------------------------------ |
| Circuit Breakers  | 3-state (CLOSED/OPEN/HALF-OPEN), per-provider error rate tracking  |
| Dead Letter Queue | Append-only NDJSON, 7 categories, replay support                   |
| Saga Compensation | Registered compensation steps; external rollback is not guaranteed |
| Checkpointing     | SQLite + WAL, crash-safe recovery (<5s target)                     |
| Semantic Caching  | SHA-256 exact + cosine-similarity deduplication                    |

### Security

AES-256-GCM encrypted secrets vault. Tamper-evident in-process HMAC audit chain (external WORM/KMS evidence pending). RBAC with capability tokens. ISO 42001 / NIST AI RMF compliance **reporting scaffolds** (reporters, not certification). Red team framework (47 scenarios, 8 attack categories). Request-context tenant scoping (AsyncLocalStorage); storage-layer isolation is opt-in — Enterprise Gateway, alpha.

### Self-Optimization

A meta-learner using Thompson Sampling and Reflexion tunes agent configurations across runs. It learns which topologies work best for which task types, which providers are fastest, and which parameter combinations produce the highest quality results. Activates after 5+ recorded runs.

---

## Architecture

```
                        ┌──────────────────────────────┐
                        │      DELIBERATION ENGINE      │
                        │  Task classification          │
                        │  Complexity estimation        │
                        │  Topology selection           │
                        └──────────┬───────────────────┘
                                   │
                        ┌──────────▼───────────────────┐
                        │       TOPOLOGY ROUTER          │
                        │  SINGLE · CHAIN · DISPATCH     │
                        │  ORCHESTRATOR · REVIEW          │
                        └──────────┬───────────────────┘
                                   │
               ┌───────────────────┼───────────────────┐
               ▼                   ▼                   ▼
        ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
        │   AGENT 1    │   │   AGENT 2    │   │   AGENT N    │
        │  LLM → Tool  │   │  LLM → Tool  │   │  LLM → Tool  │
        │  → Verify    │   │  → Verify    │   │  → Verify    │
        └──────┬───────┘   └──────┬───────┘   └──────┬───────┘
               └──────────────────┼──────────────────┘
                                  ▼
                        ┌──────────────────────────────┐
                        │         SYNTHESIS              │
                        │  Merge · Resolve conflicts    │
                        └──────────┬───────────────────┘
                                   ▼
                        ┌──────────────────────────────┐
                        │       QUALITY GATES           │
                        │  Hallucination · Consistency  │
                        │  Completeness · Accuracy     │
                        │  Safety                      │
                        └──────────┬───────────────────┘
                                   ▼
                              RESULT
```

---

## Web Console

Commander includes a web-based control console for visual monitoring, chat-based agent interaction, and governance:

```bash
# Requires PostgreSQL plus explicit JWT_SECRET and ADMIN_PASSWORD; see docs/deploy.md.
# Starts API on :4000 and Web on :5173, then opens the browser.
pnpm gui
```

Open `http://localhost:5173`. The console routes are:

| Route                        | Page                                                                                    |
| ---------------------------- | --------------------------------------------------------------------------------------- |
| `/`                          | Dashboard — battle report, token trends, live topology, agent roster, mission board     |
| `/agents`                    | Agent roster                                                                            |
| `/missions`                  | Mission board and approvals                                                             |
| `/execution`                 | Real-time execution feed                                                                |
| `/memory`                    | Memory browser and search                                                               |
| `/governance`                | Approval queue and policy configuration                                                 |
| `/security`                  | Security posture — ISO 42001 / NIST AI RMF **reporting** (reporters, not certification) |
| `/slo`                       | SLO panel                                                                               |
| `/chat`                      | Conversational interface with real-time agent streaming                                 |
| `/dlq`                       | Dead letter queue management with replay                                                |
| `/audit`                     | Audit log                                                                               |
| `/cost`                      | Cost and token reporting                                                                |
| `/knowledge`                 | Knowledge base                                                                          |
| `/alerts`                    | Alerts                                                                                  |
| `/onboarding`                | First-run onboarding                                                                    |
| `/users`                     | User administration                                                                     |
| `/settings`, `/settings/sso` | Settings and OIDC/SSO configuration                                                     |
| `/workflows`                 | Workflow list and scheduling                                                            |
| `/poc`                       | POC/demo views                                                                          |
| `/research`                  | Research view                                                                           |
| `/actions`                   | Action Gateway queue (approve / reject / compensate)                                    |

When running the Compose `web` profile instead of `pnpm gui`, the same console
is served on `http://localhost:3000`.

---

## Reliability Targets

| Target              | Goal | Mechanism                  |
| ------------------- | ---- | -------------------------- |
| Checkpoint Recovery | <5s  | SQLite + WAL               |
| Provider Failover   | <10s | Automatic fallback chain   |
| Saga Compensation   | <30s | Compensation scheduler     |
| DLQ Processing      | <60s | Append-only NDJSON, replay |

---

## Benchmarks

> All benchmarks below run in **simulated/scripted harnesses** or as **CI
> baselines**. They measure the harness, not a production SLA or SOC evidence.

| Suite             | Coverage                                  | Result                                            |
| ----------------- | ----------------------------------------- | ------------------------------------------------- |
| Chaos Engineering | 200 synthetic + 55 mutation (=255)        | Harness entry; see the retained baseline matrix   |
| Red Team          | 47 scenarios, 8 attack categories         | all listed cases blocked (simulated harness)      |
| AgentDojo         | 12 security test cases                    | all listed cases blocked (simulated harness)      |
| GAIA Spine        | Core capability benchmark                 | Scheduled quick/offline run; full fixture pending |
| SLO               | 99.95% API availability, <5s p95 schedule | CI baseline, not production SLA                   |

Full matrix: [BENCHMARK.md](BENCHMARK.md)

---

## Health Check

```bash
curl http://localhost:4000/health          # Basic liveness (200 / 503)
curl http://localhost:4000/health/detailed # All components
curl http://localhost:4000/ready           # Readiness (DB, kernel, stores)
curl http://localhost:4000/v1/health       # Gateway-narrowed readiness
curl http://localhost:4000/metrics         # Prometheus
curl http://localhost:4000/system/status   # Runtime module summary
```

There is no `/readyz` or `/livez` alias — readiness is `/ready`.

Monitors: memory, circuit breakers, DLQ size, checkpoint staleness, pending compensations, event bus backlog, provider availability, disk space.

---

## Why Commander

Once an agent's action reaches an external system, a timeout or crash can leave three questions open: did it happen, how many times, and with what payload. Retrying blindly can duplicate the write; giving up can lose it.

Commander records the approved request and its execution state outside the agent, looks up the outcome after an ambiguous response, and stops in an explicit unknown state when the evidence is not conclusive. Undoing an effect is a separate, separately approved action.

Native controls such as GitHub permissions and Actions approvals are often enough. Commander is for teams that need one approval and recovery record across agents and workers.

---

## Documentation

- [docs/architecture/](docs/architecture/000-index.md) — Architecture Decision Records (V2 resource model, state machine, persistence, identity, effect broker, worker protocol, event semantics)
- [docs/getting-started.md](docs/getting-started.md) — Quick start
- [docs/deploy.md](docs/deploy.md) — Deployment
- [docs/v2-migration-guide.md](docs/v2-migration-guide.md) — Architecture V2 migration
- [docs/slo.md](docs/slo.md) — SLO definitions
- [docs/content/why-retrying-ai-agent-external-actions-is-unsafe.md](docs/content/why-retrying-ai-agent-external-actions-is-unsafe.md) — Failure model: why retrying an AI agent's external action is unsafe
- [SECURITY.md](SECURITY.md) — Security model, threat model, compliance
- [BENCHMARK.md](BENCHMARK.md) — Full benchmark matrix and methodology
- [CHANGELOG.md](CHANGELOG.md) — Release history

## Public boundaries and feedback

- **Real vs simulated:** onboarding task results are real only when the UI/API
  reports `source=real`; fallbacks and POC figures are simulated/demo data.
- **Privacy:** prompts may be sent to the selected LLM provider, and local traces,
  memory, audit data, and optional OpenTelemetry exports may be persisted. See
  [PRIVACY.md](PRIVACY.md) before entering sensitive data.
- **Bugs:** open a [GitHub issue](https://github.com/PStarH/Commander/issues) and
  redact prompts, logs, configuration, PII, and secrets first.
- **Questions and proposals:** open a [GitHub issue](https://github.com/PStarH/Commander/issues).
- **Security vulnerabilities:** follow [SECURITY.md](SECURITY.md); do not open a public issue.

---

## License

MIT. See [LICENSE](LICENSE) and [COPYRIGHT.md](COPYRIGHT.md).

---

<p align="center">
  <sub>Approval and recovery for agent actions that reach external systems.</sub>
</p>
