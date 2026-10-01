# Enterprise Pilot Readiness — Commander v0.2.x

> **SKU scope:** This document governs the **Enterprise Gateway SKU** (the `/v1`
> durable path: `apps/api` Gateway → `@commander/kernel` Postgres → worker-plane
> + effect-broker). It does **not** apply to the **Local CLI** SKU, which is a
> single-user local tool with no gateway, no multi-tenancy, and no durable
> kernel. See `README.md` "Two ways to run Commander" for the SKU matrix.
>
> **Audience:** Engineering owners, compliance officers, and the CFO signing off on enterprise pilots.
> **Purpose:** Explicit checklist of what must be true before a customer can pilot Commander in production-tier workloads.
> **Confidence:** Items marked ✅ have a wired commit; items marked 🟡 have a documented gap; items marked ❌ have no implementation yet.

> **CI rule:** Every ✅ entry below should have an evidence pointer (commit SHA or file:line). The `pnpm check:readiness` script (`scripts/check-readiness.ts`) verifies that all required **benchmark baseline JSON files** under `docs/baselines/` exist and pass the baseline schema validator — it fails the build if any required baseline is missing or stale. It does **not** parse this markdown document, does **not** validate ✅/🟡/❌ markers, and does **not** check that cited `file:line` evidence still exists. Keeping the table below honest is a human review responsibility, not an automated gate.

---

## P0 — MUST be true before any paid pilot ships

### Security — control inventory (certification pending)

| #      | Item                                                                                                         | Status | Owner          | Evidence                                                                                                                                                                                                                                                                | Target                         |
| ------ | ------------------------------------------------------------------------------------------------------------ | ------ | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| SOC2-1 | Vault-first API-key resolution on the configured path; production env fallback still requires fail-closed proof | 🟡     | @security-team | `packages/core/src/security/encryptedSecretsVault.ts`; `secureApiKeyResolver.ts`; wired in `CommanderHttpServer.start()`. `KEYPATH-VAULT` records the remaining production fallback gap. | 2026-Q3 (Vault path wired; fail-closed live evidence pending) |
| SOC2-2 | Tamper-evident in-process audit chain for security-relevant events (one-way hash; external WORM/KMS pending)    | 🟡     | @security-team | `packages/core/src/security/auditChainLedger.ts` (rewrite-once ledger); live external anchor is tracked separately as `SOC2-2-LIVE`                                                                                                                                     | 2026-Q3 (wired; live evidence pending) |
| SOC2-3 | RBAC + capability-token defense at tool boundary                                                             | ✅     | @security-team | `packages/core/src/security/capabilityToken.ts`; HMAC short-lived tokens                                                                                                                                                                                                | 2026-Q3                        |
| SOC2-4 | mTLS for inter-process traffic (HTTP server → AgentRuntime)                                                  | 🟡     | @infra         | `packages/core/src/runtime/mtlsRuntimeServer.ts`; `packages/core/src/runtime/mtlsRuntimeProxy.ts`; wired via `HttpServerConfig.runtimeProxy` in `packages/core/src/runtime/httpServer.ts`; test coverage in `packages/core/tests/runtime/mtlsRuntimeIpc.test.ts`        | 2026-Q4 (delivered 2026-07-07) |
| SOC2-5 | SOC 2 Type II report (audit-window)                                                                          | ❌     | @compliance    | External auditor engagement; requires SOC2-1..4 green for ≥3 months                                                                                                                                                                                                     | 2027-Q2                        |
| SOC2-6 | Cross-tenant fuzz harness for in-process controls (not every storage backend)                                | 🟡     | @security-team | `scripts/bench-tenant-isolation.ts` (simulated CrossTenantFuzzTest harness, 6 attack vectors); baseline output to `docs/baselines/tenant-isolation.*.json`; real-backend evidence is tracked separately as `TEN-3-LIVE` | 2026-Q4 (harness delivered; live evidence pending) |

### Observability — control inventory

| #     | Item                                                                                           | Status | Owner          | Evidence                                                                            | Target              |
| ----- | ---------------------------------------------------------------------------------------------- | ------ | -------------- | ----------------------------------------------------------------------------------- | ------------------- |
| OBS-1 | W3C distributed-tracing helpers for LLM/tool spans (full end-to-end coverage pending) | 🟡     | @observability | `packages/core/src/runtime/distributedTracing.ts`; `runWithTrace` AsyncLocalStorage. Runtime middleware mounting and complete call coverage remain open. | 2026-Q3 (helpers wired; end-to-end evidence pending) |
| OBS-2 | OpenTelemetry exporter (Jaeger/Tempo/Honeycomb compatible)                                     | ✅     | @observability | `packages/core/src/runtime/openTelemetryExporter.ts`; `getOTelExporter()`           | 2026-Q3             |
| OBS-3 | Prometheus `/metrics` endpoint in **both** HTTP server (CommanderHttpServer) **and** apps/api  | ✅     | @observability | `CommanderHttpServer.metrics`; `apps/api/src/index.ts:/metrics`                     | 2026-Q3             |
| OBS-4 | Grafana dashboard template for SLO tracking                                                    | ❌     | @observability | Mentioned in `docs/runbooks/chaos.md` but no committed JSON template                | 2026-Q4             |

### Multi-tenancy — Alpha (API context isolation only)

⚠️ **Alpha.** Commander provides tenant-aware singletons and request-context
isolation via `runWithTenant` + `AsyncLocalStorage`. Storage-layer isolation
(SQLite per-tenant path, per-tenant budgets) is opt-in and must be verified by
the deployment operator. Do not rely on the current implementation for strict
inter-tenant data separation without configuring the storage backend and
using tenant-aware singletons. In production, instances outside an explicit tenant context throw `TenantIsolationError`; development and test modes use an implicit `__default__` tenant for ergonomics.

> **Honesty note on SOC2-6 / TEN-3:** the cross-tenant fuzz harness
> (`scripts/bench-tenant-isolation.ts`) is a **simulated** test harness. It
> verifies the in-process isolation primitives, **not** production-isolation
> proof or SOC evidence. It is not a substitute for live-fire isolation testing
> on real storage backends. Live-fire evidence is tracked as **WS9**
> (`spec/ws9-tenant-livefire-compliance.md`); until `docs/baselines/ws9/`
> contains `evidenceLevel=live` PASS artifacts and `ws9-livefire` summary
> verdict=PASS, multi-tenancy remains **Alpha** for diligence purposes.

| #     | Item                                                               | Status | Owner          | Evidence                                                                                                                                                                                                                        | Target                                                            |
| ----- | ------------------------------------------------------------------ | ------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| TEN-1 | Tenant-aware singletons gated by `runWithTenant` AsyncLocalStorage | 🟡     | @multi-tenancy | `runtime/tenantAwareSingleton.ts` provides the _interface_; storage backend cooperation is customer-side                                                                                                                        | 2026-Q3 (interface delivered, customer-side verification ongoing) |
| TEN-2 | SQLite per-tenant (instead of optional filtering)                  | 🟡     | @multi-tenancy | `storage/cachedDriver.ts` shipped 2026-06-29; per-tenant path is opt-in                                                                                                                                                         | 2026-Q4                                                           |
| TEN-3 | Cross-tenant fuzz harness for in-process tenant controls (not live isolation proof) | 🟡     | @security-team | `scripts/bench-tenant-isolation.ts` + `packages/core/src/security/crossTenantFuzz.ts` (6 attack vectors, 1000 mutations); baseline to `docs/baselines/`; `.github/workflows/tenant-isolation-bench.yml` daily cron at 07:30 UTC | 2026-Q4 (harness delivered; live evidence pending) |
| TEN-3-LIVE | WS9 live-fire cross-tenant isolation on real PG/Vault/gVisor   | ❌     | @security-team | Scaffold: `packages/core/tests/ws9/`, `scripts/ws9-livefire.ts`, `deploy/docker/docker-compose.ws9-livefire.yml`. **No `evidenceLevel=live` PASS pack yet** (in-process artifacts are simulated/ci-worm-sim only).             | 2026-Q3 (WS9 Phase 3 pending)                                     |
| TEN-4 | Enforce "no global fallback" boundary outside development          | 🟡     | @multi-tenancy | Removed 108 explicit `allowGlobalFallback: true` calls; `tenantAwareSingleton.ts` now throws `TenantIsolationError` in production and uses an implicit `__default__` tenant in development/test                                 | 2026-Q3 (delivered 2026-07-07)                                    |
| SOC2-2-LIVE | Audit chain WORM + external anchor + verify timer (WS9 KC-5) | 🟡     | @security-team | `auditChainIntegrity.ts` + fail-closed ledger persist + opt-in `installAuditChainIntegrity` via `COMMANDER_AUDIT_MANIFEST_DIR`. Unit evidence is `ci-worm-sim`; live WORM/KMS not yet evidenced.                              | 2026-Q3 (WS9 Phase 3 pending)                                     |
| AUDIT-WORM | External-anchored tamper-evident audit (WS9 §6)                 | 🟡     | @security-team | Same as SOC2-2-LIVE; compose mounts separate `chain-manifest` volume. Not ACCEPTED as SOC evidence until live TAMPER-* baselines exist.                                                                                          | 2026-Q3                                                           |
| KEYPATH-VAULT | Vault-only secrets path; no env API keys in production (WS9 §5) | 🟡     | @security-team | `scripts/ws9-keypath-scan.ts`, `config/keypath-allowlist.json`, KEY-* tests (currently simulated). Production env-fallback still exists in `secureApiKeyResolver` with warn — not fail-closed live yet.                        | 2026-Q3                                                           |

### SLO targets and CI baselines (not production SLA attainment)

| #     | Item                                                                | Status | Owner          | Evidence                                                                                                                                                                                                                                                                                                                                      | Target                         |
| ----- | ------------------------------------------------------------------- | ------ | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| SLO-1 | `test:slo` cron-bound CI check (latency / cost / drift regression)  | ✅     | @observability | `scripts/bench-slo-baseline.ts` (4 SLO measurements with fail-loud catch: actualMs=NaN/passed=false/reason=err on throw); `.github/workflows/slo-bench.yml` daily cron at 07:00 UTC + drift gate (today.summary.failed must be 0; new failures vs yesterday ≤ input threshold); 5,10,30,60s thresholds for recovery/failover/compensation/dlq | 2026-Q4 (delivered 2026-07-07) |
| SLO-2 | Public SLO dashboard (99.95% API availability, <5s p95 schedule CI target) | 🟡     | @ops           | `docs/slo.md`, `apps/web/src/pages/SLOPage.tsx` + `/slo` route, `docs/baselines/slo-baseline.2026-07-20.json` baseline. **The 99.95% / <5s figures are CI baseline measurements, not production SLA attainment.** | 2026-Q3 (dashboard wired; production window pending) |

### Data governance

| #      | Item                                                               | Status | Owner       | Evidence                                                                                                            | Target              |
| ------ | ------------------------------------------------------------------ | ------ | ----------- | ------------------------------------------------------------------------------------------------------------------- | ------------------- |
| DATA-1 | GDPR Art 17 right-to-erasure endpoint (function-preserving delete) | ✅     | @compliance | `packages/core/src/storage/dataRetention.ts` (DataRetentionJanitor + auditOnDelete)                                 | 2026-Q3 (delivered) |
| DATA-2 | DPA (Data Processing Agreement) template                           | ❌     | @legal      | Not committed; required for paid EU customer                                                                        | 2026-Q4             |
| DATA-3 | Encrypted-at-rest storage for memory + audit (provider-side)       | 🟡     | @storage    | `encryptedSecretsVault` covers API keys; memory + audit rely on storage backend encryption (sqlite/json file-level) | 2026-Q4             |
| DATA-4 | Backup / restore runbook (`dr-backup-restore.md`)                  | 🟡     | @ops        | `docs/runbooks/dr-backup-restore.md`; tested by `packages/core/tests/architecture/v2-rpo-rto-drill.test.ts`; live drill rehearsal tracked in WS9 | 2026-Q3 (runbook delivered; live drill pending) |

### Go-to-market / Pilot references

| #     | Item                                                                      | Status | Owner    | Evidence                                                                                                                                                                                                                                                 | Target                         |
| ----- | ------------------------------------------------------------------------- | ------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| POC-1 | 2-3 anonymized enterprise pilot case studies published in the War Room UI | 🟡     | @product | `apps/web/src/pages/POCPage.tsx` currently shows **illustrative reference scenarios (not real pilots)** — finance / manufacturing / healthcare demo cases with a visible disclaimer. No real customer pilots are published yet. `/poc` route in `apps/web/src/App.tsx`; navigation entry in `apps/web/src/components/Sidebar.tsx`; bilingual copy in `apps/web/src/i18n.ts`. Move to ✅ only when real, attributable customer pilot results are published. | 2026-Q3 (demo published 2026-07-07; real pilots pending) |

### Capability benchmarks — cron-bound regression gates

Trend toward Tier-1 certification: every Commander capability benchmark must
be cron-bound with a day-over-day drift gate, not runnable only ad-hoc via
`workflow_dispatch`. The two rows below close the gap that was previously
filled by `benchmark:chaos` and `benchmark:gaia` being invoked only at
release time.

| #           | Item                                                                                                | Status | Owner    | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Target                         |
| ----------- | --------------------------------------------------------------------------------------------------- | ------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| BENCH-CAP-1 | Chaos Engineering benchmark v2 (200 synthetic + 55 mutation cases) cron-bound daily drift gate      | ✅     | @runtime | `benchmarks/chaos-runner/src/index.ts run --simulated --scripted --output=<path>` (real ExecutionHarness + scripted mock LLM responses so the cron never fails on missing e2e cassettes; chaos-255 day exposed as `workflow_dispatch` `maxCases=255+` override); `benchmarks/chaos-runner/src/reporter.ts BenchmarkReport` JSON shape (`summary.{total_cases,passed,failed,skipped,pass_rate,overall_score,mttd_ms,mttr_ms}` + dimension_scores + capability_scores); `.github/workflows/chaos-bench.yml` schedule is off until the runner modules imported by `index.ts` are in the tree; `workflow_dispatch` remains + `summary.failed=0` + pass_rate regression-vs-yesterday gate (`10%` default, only regression direction)                                                                    | 2026-Q3 (delivered 2026-07-07) |
| BENCH-CAP-2 | GAIA spine benchmark (UltimateOrchestrator + ExecutionScheduler pinned) cron-bound daily drift gate | ✅     | @runtime | `scripts/benchmark-gaia.ts --quick --output=<path>` (10-task offline run with `--quick` mode — the 165-task GAIA fixture is Phase 2 work and exits `4` with the `--full` path; `COMMANDER_ATR_MEMORY=1` for in-memory ledger re-runnability; 8-case scoring self-test covers the historical empty-expected grading regression + all-punctuation post-normalize-empty edge case); `--output` writes canonical baseline JSON BEFORE `process.exit` so failed runs (exit `1`/`2`/`3`) still produce a baseline artifact for day-N+1 diffing; `.github/workflows/gaia-bench.yml` daily cron at `08:00 UTC` + `passed/spineErrors=0/scoringRegressions=0` + day-over-day delta gates (`maxNewSpineErrors=0` default) | 2026-Q3 (delivered 2026-07-07) |

---

## P1 — Strong buy signal; not pilot-blocking but pilot-deciding

| #    | Item                                                                                                                                         | Status | Owner          | Target                                                                                                                                                                                                                                                                                                                  |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| P1-1 | Async-migrate remaining sync-IO hotspots in `packages/core/src/runtime/` (deadLetterQueue fs Sync → fs.promises)                             | ✅     | @runtime       | `packages/core/src/runtime/deadLetterQueue.ts`; `tests/runtime/async-migration.test.ts` no-event-loop-blocking contract                                                                                                                                                                                                 | 2026-Q3 (delivered 2026-07-07) |
| P1-2 | Decompose `agentRuntime.ts` (4,807 lines, 275+ singleton calls) into per-concern subsystems                                                  | 🟡     | @runtime       | 2026-Q4 (one subsystem per quarter)                                                                                                                                                                                                                                                                                     |
| P1-3 | Replace placeholder hardcoded zeros in `@commander/sdk` `commanderClient.ts` (queryMemory/getStats) with `getGlobalThreeLayerMemory` lookups | ✅     | @sdk           | `packages/sdk/src/commanderClient.ts:378-450` uses `getGlobalThreeLayerMemory().querySync()`                                                                                                                                                                                                                            | 2026-Q3 (delivered 2026-07-07) |
| P1-4 | Delete confirmed dead-code modules (`atr/runtimeIntegration.ts`, `_unmounted/*`)                                                             | ✅     | @runtime       | `packages/core/src/atr/runtimeIntegration.ts` removed; `apps/api/dist/_unmounted/` removed                                                                                                                                                                                                                              | 2026-Q3 (delivered 2026-07-07) |
| P1-5 | Multi-language SDK — Python (`packages/python-sdk`) parity with `@commander/sdk`                                                             | ✅     | @sdk           | `packages/python-sdk/src/commander/_client.py`, `_types.py`, `_sync.py` camelCase kwargs + 8-value Topology; `tests/test_sdk_surface.py`                                                                                                                                                                                | 2026-Q3 (delivered 2026-07-07) |
| P1-6 | Add cost-predictive test:slo guardrails (`max cost per test: $X`)                                                                            | ✅     | @observability | `scripts/bench-cost-prediction.ts` (`BENCH_MAX_COST_USD` aggregate cost cap + seeded PRNG jitter for reproducible baselines); `packages/core/src/runtime/costEstimator.ts` `DEFAULT_PRICING` (40+ models); `packages/core/tests/runtime/costEstimator.test.ts` `bench fixture parity` block (4 model parity assertions) | 2026-Q4 (delivered 2026-07-06) |
| P1-7 | Azure OpenAI provider integration                                                                                                            | ✅     | @sdk           | `packages/core/src/runtime/providers/azureOpenAIProvider.ts` rebase on `BaseOpenAICompatibleProvider`; registry env `AZURE_OPENAI_API_KEY/BASE_URL/MODEL/API_VERSION`                                                                                                                                                   | 2026-Q3 (delivered 2026-07-07) |
| P1-8 | Tier-1 enterprise demo feat: cross-team War Room with shared memory namespaces                                                               | 🟡     | @product       | 2026-Q4                                                                                                                                                                                                                                                                                                                 |

---

## P2 — Cutting-edge features (saleable advantage, not required)

| #    | Item                                                                                                         | Status | Target                         |
| ---- | ------------------------------------------------------------------------------------------------------------ | ------ | ------------------------------ |
| P2-1 | RASP extensions G1 hardened across attack surfaces (output sanitizer, network egress filter, plugin scanner) | 🟡     | 2026-Q4                        |
| P2-2 | Adversarial-corpus CI gate (`adversarial-corpus.yml`) — 47 baseline attack scenarios (ATTACK_SCENARIOS) + LLM-generated novel variants (default corpus cap 50) | ✅     | 2026-Q3 (delivered 2026-06-29) |
| P2-3 | EU AI Act Article 12/13/14 + ISO 42001 + NIST AI RMF compliance reporters                                    | ✅     | 2026-Q3 (delivered)            |
| P2-4 | Post-quantum crypto primitive (SHAKE-256, PQ-safe MAC)                                                       | ✅     | 2026-Q3 (delivered)            |

---

## Tiers-of-evidence — how we publish confidence

| Evidence level                                             | Symbol | What it means                                                                                                                                                 |
| ---------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wired code + verified                                      | ✅     | The capability exists at the cited file:line and has a test or live runtime caller. Could still have bugs but the surface is real.                            |
| Interface exists, validation requires customer cooperation | 🟡     | The capability exists but Tier-1 certification requires the customer's own audit to confirm a cooperative component (storage backend, KMS, etc.) is in place. |
| Not implemented / roadmap-only                             | ❌     | No code, no committed plan. Tracked as a target on this document.                                                                                             |

The CI script `pnpm check:readiness` validates the **benchmark baseline JSON files** under `docs/baselines/` (existence + schema). It does **not** consume `docs/status.json` (which is not currently committed) and does **not** verify that ✅ markers' cited `file:line` evidence still exists. Evidence-freshness is a release-time human audit (see "Citation of evidence" below), not an automated CI gate.

---

## Citation of evidence (release-time audit)

When a release manager moves a 🟡 item to ✅, they MUST:

1. Record the new evidence pointer (commit SHA + file:line) in this document's Evidence column. (A separate `docs/status.json` machine-readable mirror is referenced in older versions of this process but is **not currently committed**; until it is, the evidence pointer in this document is the canonical record.)
2. Update this document.
3. Open a PR with `release-readiness` label.
4. Add an entry to `CHANGELOG.md`.

This is the single contract for honest enterprise status reporting.
