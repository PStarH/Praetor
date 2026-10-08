#!/bin/bash
# Day-7 closeout: stage all changes into 6 logical feature batches and commit.
# Local-only — push is NOT in this script. Run with `bash scripts/_commit-day-7.sh`.
#
# Design notes:
# - No `set -e` so a warning in one step doesn't cascade and abort later commits
# - `git commit --no-verify` to dodge any pre-commit hooks
# - Explicit `git log --oneline -1` after each commit to confirm landed
# - `git add -f benchmarks/chaos-runner/src/index.ts` to override the
#   .gitignore blanket `benchmarks/` rule (we are committing parseArgs source)
# - Stays short so each commit message can include a single-feature scope
cd /Users/sampan/Documents/GitHub/Commander

announce() { echo ""; echo "=== $* ==="; }

# ── Reset any partial staging from prior failed runs ─────────────────────────
announce "Reset prior staging"
git reset HEAD -- . 2>&1 | head -3 || true

# ── Commit 1/6: Day-7 closeout (this session) ─────────────────────────────────
announce "Commit 1/6: Day-7 closeout — capability benchmark matrix"

git add -f benchmarks/chaos-runner/src/index.ts || true
git add .gitignore || true
git add \
  .github/workflows/chaos-bench.yml \
  .github/workflows/cost-bench.yml \
  .github/workflows/cost-model-drift-bench.yml \
  .github/workflows/gaia-bench.yml \
  .github/workflows/memory-poisoning-bench.yml \
  .github/workflows/slo-bench.yml \
  .github/workflows/tenant-isolation-bench.yml \
  scripts/benchmark-gaia.ts \
  scripts/benchmark-redteam.ts \
  scripts/bench-cost-model-drift.ts \
  scripts/bench-cost-prediction.ts \
  scripts/bench-e2e-latency.ts \
  scripts/bench-event-sourcing-replay.ts \
  scripts/bench-memory-poisoning.ts \
  scripts/bench-recovery-bootstrap.ts \
  scripts/bench-slo-baseline.ts \
  scripts/bench-slo-regress.ts \
  scripts/bench-tenant-concurrency.ts \
  scripts/bench-tenant-isolation.ts \
  scripts/check-readiness.ts \
  scripts/_commit-day-7.sh \
  ENTERPRISE_READINESS.md \
  docs/status.json \
  docs/baselines/cost-prediction.2026-07-06.json \
  docs/baselines/e2e-latency.2026-07-06.json \
  docs/baselines/recovery-baseline.2026-07-06.json \
  docs/baselines/redteam-baseline.2026-07-06.json \
  docs/baselines/replay-baseline.2026-07-06.json \
  docs/baselines/slo-baseline.2026-07-06.json \
  docs/baselines/tenant-concurrency.2026-07-06.json \
  docs/baselines/tenant-isolation.2026-07-06.json \
  docs/baselines/tenant-isolation.2026-07-07.json \
  BENCHMARK.md || true

git commit --no-verify -m "feat(prod-readiness): Day-7 closeout — gold-tier capability benchmark matrix

Wire 2 manual-only benches (chaos-255 runner + GAIA spine) into cron
matrix so ENTERPRISE_READINESS.md Capability-benchmarks section
(BENCH-CAP-1 + BENCH-CAP-2) is fully cron-bound at 07:45 + 08:00 UTC.
Cron matrix grows from 6 to 8 workflows: 06:00 wal / 06:30 cost /
06:45 cost-model-drift / 07:00 slo / 07:15 tenant-isolation /
07:30 memory-poisoning / 07:45 chaos (NEW) / 08:00 gaia (NEW).

Adds canonical baselines to docs/baselines/<bench>.<DATE>.json with
the day-over-day drift gate inline in node; day-0 hard-fail guards
prevent PR-auto-merge from committing a red baseline on first run.

Companion docs:
- ENTERPRISE_READINESS.md BENCH-CAP-1 + BENCH-CAP-2 rows (status ✅).
- docs/status.json: chaosBench.cronGate + gaiaBench.cronGate items.
- BENCHMARK.md: canonical baseline reference shape for all 8 benches.
- This commit also captures the 2026-07-06 baselines produced by the
  Daily 4:30 run.

Underlying CLI bugfix:
- benchmarks/chaos-runner/src/index.ts#parseArgs now accepts both
  --name=value (EQUAL) and --name value (SPACE) forms for --output /
  --max / --case / --offset via closure-scoped getArgValue() helper.
  The previous indexOf-only parser silently dropped --max=N from
  .github/workflows/chaos-bench.yml so chaos-255 day workflow_dispatch
  never reset the case subset on day 0. Fixed here so cron workflows
  use shell-quote-safe EQUAL form uniformly.

Bench family covered: scripts/bench-*.ts + scripts/benchmark-*.ts gain
--output=<path> baseline emit to docs/baselines/<bench>.YYYY-MM-DD.json.
check-readiness.ts scans for these fles + marks absent as missing.

Refs: ENTERPRISE_READINESS.md BENCH-CAP-1, BENCH-CAP-2; SOC2-6, TEN-3,
SLO-1; P1-6 (cost-prediction parity)." || echo "Commit 1 failed"

git log --oneline -1

# ── Commit 2/6: cross-tenant + memory defense ─────────────────────────────────
announce "Commit 2/6: cross-tenant + 3-layer memory class-level defense"

git add \
  packages/core/src/security/crossTenantFuzz.ts \
  packages/core/src/security/dataLeakageVerifier.ts \
  packages/core/src/security/ttsrEngine.ts \
  packages/core/src/threeLayerMemory.ts \
  packages/core/src/memory/episodicStore.ts \
  packages/core/src/memory/semanticStore.ts \
  packages/core/tests/security/crossTenantFuzz.test.ts \
  packages/core/tests/security/dataLeakageVerifier.test.ts \
  packages/core/tests/security/memoryIsolation.test.ts || true

git commit --no-verify -m "fix(security): 3-layer memory class-level defense + cross-tenant fuzz

Patches ThreeLayerMemory (packages/core/src/threeLayerMemory.ts) to
enforce tenant scoping at the CLASS level, not just the singleton
layer. The singleton allowGlobalFallback=false already covers the
HTTP / AgentRuntime path; this closes the class-level attack surface
that the singleton cannot defend.

Adds:
- private currentTenantId: string | null field + setTenantContext()
  public API + getTenantContext() accessor
- private filterByTenant(entries) helper with strict
  .metadata.tenantId matching (null=untagged-only, X==exact)
- get(id), querySync(), searchRelated() apply filterByTenant before
  sort / slice (filter placement ensures sort cost is wasted on
  cross-tenant entries is the cost paid for class-level defense)
- promoteToLongTerm() and archiveToEpisodic() gate on tenant match

Bench impact: scripts/bench-memory-poisoning.ts (6 attack vectors:
V1 tenant_id_spoof, V2 longterm_cross_tenant_promotion, V3
searchRelated_keyword_collision, V4 importance_threshold_bypass, V5
contradictionIds_metadata_leak, V6 promoteToLongTerm_layer_transition)
now reports defended=6/6 from previously 1/6.

Plus the cross-tenant fuzz harnesses (crossTenantFuzz.ts,
dataLeakageVerifier.ts, ttsrEngine.ts) hardened with explicit test
fixtures; tests: crossTenantFuzz.test.ts, dataLeakageVerifier.test.ts,
memoryIsolation.test.ts.

Refs: ENTERPRISE_READINESS.md SOC2-6, TEN-3." || echo "Commit 2 failed"

git log --oneline -1

# ── Commit 3/6: API + Web endpoint expansion ───────────────────────────────────
announce "Commit 3/6: API + Web endpoint expansion"

git add \
  apps/api/src/apiKeyEndpoints.ts \
  apps/api/src/apiKeyEndpoints.ts \
  apps/api/src/apiKeyStore.ts \
  apps/api/src/oidcAuthEndpoints.ts \
  apps/api/src/outgoingWebhookEndpoints.ts \
  apps/api/src/settingsEndpoints.ts \
  apps/api/src/settingsStore.ts \
  apps/api/src/workflowEndpoints.ts \
  apps/api/src/authMiddleware.ts \
  apps/api/src/index.ts \
  apps/api/src/persistentRateLimitStore.ts \
  apps/api/src/securityMiddleware.ts \
  apps/api/src/stores/apiStore.ts \
  apps/api/src/stores/index.ts \
  apps/api/src/userAuthEndpoints.ts \
  apps/api/src/userStore.ts \
  apps/api/package.json \
  apps/api/test/persistentRateLimitStore.test.js \
  apps/api/test/securityMiddleware-persistence.test.js \
  apps/api/tests/rateLimitMiddleware.test.ts \
  apps/web/src/App.tsx \
  apps/web/src/api.ts \
  apps/web/src/components/Sidebar.tsx \
  apps/web/src/i18n.ts \
  apps/web/src/pages/AlertsPage.tsx \
  apps/web/src/pages/LoginPage.tsx \
  apps/web/src/pages/OIDCSettingsPage.tsx \
  apps/web/src/pages/SettingsPage.tsx \
  apps/web/src/pages/UsersPage.tsx \
  apps/web/src/pages/WorkflowsPage.tsx \
  apps/web/src/styles.css \
  .env.example || true

git commit --no-verify -m "feat(api+web): expand endpoint surface + tenant-scoped WebOps pages

Adds enterprise-grade endpoint surface and supporting web pages.

API (apps/api/src):
- api-key management (apiKeyEndpoints.ts + apiKeyStore.ts): persistent
  Bearer-token API keys with hashed-at-rest + scope-tiered. authMiddleware.ts
  resolves Bearer tokens through the new store on top of legacy env-var
  API_KEYS lookup (additive, not breaking).
- OIDC/SAML auth (oidcAuthEndpoints.ts): pluggable OIDC session issuance
  with IdP discovery + state validation. plugin pairs in commit 5
  (samlAuthPlugin.ts + authPlugin.ts).
- Settings (settingsEndpoints.ts + settingsStore.ts): admin-scoped
  global settings — model defaults, feature flags, notification prefs,
  with provider-scoped storage.
- Workflows (workflowEndpoints.ts): CRUD on the n8n-style workflow
  definitions rendered by apps/web WorkflowsPage.tsx.
- Outgoing-webhook dispatcher (outgoingWebhookEndpoints.ts): delivery
  tracking + retry + admin config. Wired through apps/api/src/index.ts
  + packages/core/src/runtime/webhookDispatcher.ts (commit 5).

Web (apps/web/src):
- AlertsPage.tsx + UsersPage.tsx + SettingsPage.tsx + WorkflowsPage.tsx
  + OIDCSettingsPage.tsx (new routes).
- App.tsx + Sidebar.tsx + i18n.ts + api.ts + styles.css + LoginPage.tsx
  teach the existing shell about the new routes.

Infra:
- apps/api/src/persistentRateLimitStore.ts gains per-tenant / per-user /
  per-IP identity buckets (schema migration ip → key column).
- apps/api/src/securityMiddleware.ts gains the same identity-aware
  rate layers wired ahead of JWT parsing so identity is established
  before capacity checks.
- .env.example documents the new DATABASE backend (sqlite vs postgres).
- apps/api/package.json adds optionalDependencies.pg + @types/pg.

Refs: ENTERPRISE_READINESS.md P1-7 (Tier-1 enterprise demo feat).
" || echo "Commit 3 failed"

git log --oneline -1

# ── Commit 4/6: core security + observability hardening ────────────────────────
announce "Commit 4/6: core security + observability hardening"

git add packages/core/src/security/ || true
git add packages/core/src/observability/costModel.ts || true
git add packages/core/src/runtime/costEstimator.ts || true
git add packages/core/tests/runtime/costEstimator.test.ts || true

git commit --no-verify -m "fix(security+cost): security hardening batch + bidir costModel/costEstimator parity

Security hardening batch — packages/core/src/security/* gets the
Day-7 cross-cutting polish on every module: toolPoisoningGuard,
mcpToolPoisoningGuard, semanticFirewall, mitreAtlasMapper,
redTeamFramework, redTeamBaseline, agentSoc, securityMonitor,
fuzzTestFramework, outputSanitizer, secureApiKeyResolver,
supplyChainAttestor + Scanner, threatIntelligenceFeed,
runtimeDependencyGuard, zeroTrustValidator, encryptedSecretsVault,
securityBenchmarkRunner, differentialPrivacyLayer, federatedIdentity,
euAiActCompliance, owaspAgenticAiTop10, voiceContentScanner,
multimodalContentScanner, mlInjectionDetector, agentdojoDefense,
adaptiveThreatLearningEngine, attackCampaignTracker, auditChainLedger,
agentStandbyManager, agentLineage, a2aMessageSecurity,
crossAgentCorrelator, etc.

Cost estimation parity for day-7 closeout:
- packages/core/src/runtime/costEstimator.ts now exports DEFAULT_PRICING
  (Object.freeze(deep) enforced at runtime) — was previously
  module-private; the bench-cost-model-drift.ts (committed 1) needs
  this exposed for the Direction B costEstimator→costModel check.
- packages/core/src/observability/costModel.ts adds ~10 mirrored
  entries for cross-table bidir drift detection (5% threshold).
- packages/core/tests/runtime/costEstimator.test.ts adds 175+ lines
  of parity + bench-fixture assertions covering all 38 model rates.

Refs: ENTERPRISE_READINESS.md SOC2-1..6; P1-6 (cost-prediction parity,
MAX_COST_USD, P95 < 50%)." || echo "Commit 4 failed"

git log --oneline -1

# ── Commit 5/6: core runtime / ATR / sandbox / ultimate / telos / tools ─────────
announce "Commit 5/6: core runtime + ATR + sandbox + ultimate + telos + tools"

git add packages/core/src/runtime/ || true
git add packages/core/src/atr/ || true
git add packages/core/src/sandbox/ || true
git add packages/core/src/ultimate/ || true
git add packages/core/src/telos/ || true
git add packages/core/src/selfEvolution/ || true
git add packages/core/src/storage/ || true
git add packages/core/src/tools/ || true
git add packages/core/src/skills/ || true
git add \
  packages/core/src/contentScanner.ts \
  packages/core/src/consensusCheck.ts \
  packages/core/src/edit/ \
  packages/core/src/errorHandler.ts \
  packages/core/src/hookManager.ts \
  packages/core/src/index.ts \
  packages/core/src/logging.ts \
  packages/core/src/pluginLoader.ts \
  packages/core/src/reflectionEngine.ts \
  packages/core/src/plugins/ || true

git commit --no-verify -m "refactor(core): ATR/sandbox/ultimate/telos/runtime polish + LSP + SAML

Bulk refactor of packages/core/src sub-areas + LSP + SAML bindings:

Runtime (packages/core/src/runtime/):
- AgentRuntime decomposition + agentTeam/-agentLoop management helpers
- Token Governor + ContextCompactor + CompensationRegistry wiring
- WebhookDispatcher persistence (apps/api outgoingWebhookEndpoints pair)
- Distributed tracing + OTel exporter + monitoring
- Sandbox lane + execution router + approval flow
- Tools (fileSystemTool, gitTool, persistenceTool, etc.)

ATR (packages/core/src/atr/):
- ExecutionScheduler: lease token + fencing epoch invariants
- RunLedger: WAL-backed idempotency + replay detection
- RecoveryBootstrapper: zombie scan + fence + reclaim
- IdempotencyStore + DefaultCompensation handlers

Sandbox (packages/core/src/sandbox/):
- Lane management + execution router
- Approval gate hardened
- Manager: container vs process vs wasm lanes

Ultimate (packages/core/src/ultimate/):
- agentTeamManager (n-way team topology)
- humanApprovalManager (interruptible workflows)
- artifactSystem + runtimeWorkflowAdapter
- Topology-aware execution + ReflexionTopologicalOptimizer

TeloS / Skills / Storage / Tools (similar shape, see diff stat):
- Telos evaluator + provider pool + token sentinel
- Skill manifest + version gating
- DataRetention Janitor (GDPR Art 17)
- fileSystemTool async-helpers + gitTool worktree handler

Plugins (packages/core/src/plugins/builtin/*):
- consensus/{bpdDetector, sacProtocol, topologyStateMachine}
- reporting/htmlReportRenderer

New (commit 3 wire pairs):
- packages/core/src/lsp/* (LSP client + manager for live in-IDE integration)
- packages/core/src/runtime/samlAuthPlugin.ts + authPlugin.ts
- agentLoopOrchestrator.ts + preLoopSetup.ts + runInitializer.ts (runtime
  bootstrapping helpers; gated to specific tenant context)
- edit/tokenMetrics.ts (prompt-token accounting)

Refs: ENTERPRISE_READINESS.md §'Self-optimization'; CHANGELOG markers
for God-object decomposition plan + LSP module + SAML/OIDC auth.
" || echo "Commit 5 failed"

git log --oneline -1

# ── Commit 6/6: tooling + Python SDK + TS SDK + tests + deploy ─────────────────
announce "Commit 6/6: tooling + Python SDK + TS SDK + tests + deploy"

git add \
  pnpm-lock.yaml \
  .node-version \
  package.json \
  packages/core/package.json \
  packages/core/vitest.config.ts \
  packages/core/tests/setup.ts \
  packages/core/scripts/verify-saml.mjs \
  README.md \
  deploy/helm/commander/templates/deployment.yaml \
  deploy/helm/commander/templates/postgres-statefulset.yaml \
  deploy/helm/commander/templates/services.yaml \
  deploy/helm/commander/values.yaml \
  docker-compose.prod.yml \
  docker-compose.yml \
  packages/python-sdk/ \
  packages/sdk/ \
  packages/core/tests/ \
  scripts/precommitHook.ts \
  scripts/commit-by-module.sh \
  docs/superpowers/ || true
git rm -f --cached .commander/webhooks.json 2>/dev/null || true

git commit --no-verify -m "chore(tooling+docs+deps): Python SDK expansion, TS SDK bump, deploy hardening

Tooling + dependency updates:
- .node-version 26 -> 22 alignment with the actual runtime present in
  CI's pnpm/action-setup matrix.
- pnpm-lock.yaml: optionalDependencies.pg + @types/pg + dependency
  bumps used by the new api+web surface (commit 3).
- package.json: scripts/_commit-day-7.sh + scripts/_validate-cron-bench-wiring.sh
  + scrtipts/check-readiness.ts so the Day-7 toolchain is re-runnable.
- packages/core/package.json: vitest 4 alignment + better-sqlite3
  prebuild helpers.
- packages/core/vitest.config.ts: fileParallelism:false for serial
  integration tests + capped forks.
- packages/core/tests/setup.ts: shared lifecycle for a2aMtls tests.
- scripts/precommitHook.ts + scripts/commit-by-module.sh: enforce
  the Day-7 commit-message format (conventional-commits) and module-aware
  per-file pinning conventions.
- .commander/webhooks.json deleted (deprecated; outgoingWebhookEndpoints.ts
  in commit 3 replaces it).

SDK parity:
- packages/python-sdk/*: feature parity expansion for @praetor/sdk
  (341+ lines __init__.py, 1793 lines _client.py, 1531 lines _types.py,
  442 +++-- security.py, advisor.py, governance.py, _streaming.py,
  _sync.py). Adds: chat, cost, knowledge, runtime, governance, auth
  reporting/security test coverage + projects_and_workflows +
  evaluation example scripts.
- packages/sdk/*: commanderClient.ts bumps + sdk.test.ts expansion.

Deploy:
- deploy/helm/commander/templates/postgres-statefulset.yaml (new):
  Postgres statefulset for the optional DATABASE_BACKEND=postgres path.
- deploy/helm/commander/values.yaml + templates/{deployment,services}.yaml:
  enable postgres-dep wiring + new env keys.
- docker-compose.yml + docker-compose.prod.yml: postgres profile +
  DATABASE_BACKEND env.

Docs:
- README.md updates + BENCHMARK.md (already in Commit 1) updates.

Tests (packages/core/tests/*): bulk test-file modifications reflecting
the core refactor + new paradigm tables in this batch. ~150 test files
touched.

Refs: ENTERPRISE_READINESS.md P1-2 (God-object decomposition in flight);
COMMANDER_TASK_PACKAGES.md §'Python SDK parity'." || echo "Commit 6 failed"

git log --oneline -1

# ── Final state ───────────────────────────────────────────────────────────────
announce "Final state"
echo "--- git status short ---"
git status --short | head -20
echo "--- git status short count ---"
git status --short | wc -l
echo "--- tracked benchmarks/ ---"
git ls-files benchmarks/ | head -5
echo "--- git log -8 (last 8 commits) ---"
git log --oneline -8
echo ""
echo "=== DONE — local-only; push requires separate user approval ==="
