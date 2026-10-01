# Commander Evaluation

This document records the benchmark infrastructure, scripts, and reproducible results for Commander's defensive layers and runtime performance.

Unless a row explicitly says otherwise, results here are offline fixtures,
simulated/scripted harnesses, CI baselines, or historical snapshots. They are
not production SLA attainment, customer outcomes, SOC evidence, or independent
security validation. A benchmark score is only publishable with its runner,
case manifest, raw output, environment provenance, and declared evidence level.

## Quick Start

Run all benchmarks and verify readiness:

```bash
pnpm benchmark:all          # WAL + Recovery + Replay + SLO + Tenant Isolation + RedTeam + AgentDojo + Readiness check
pnpm check:readiness --non-strict # Parse and validate baseline schemas (strict mode requires an approved profile)
```

Individual benchmarks:

```bash
# Security benchmarks
pnpm benchmark:agentdojo     # AgentDojo 12-case indirect injection suite
pnpm benchmark:agentdojo:all # All 3 security benchmarks (AgentDojo + AgentSafetyBench + AgentHarm)
pnpm benchmark:redteam       # Red Team Battery (47 scenarios, 8 attack categories)
pnpm benchmark:chaos         # Chaos Engineering 255 (simulated mode, default)
pnpm benchmark:chaos:full    # Chaos Engineering 255 (all 255 cases)

# Capability benchmarks
pnpm benchmark:webarena      # WebArena capability baseline (offline fixture)
pnpm benchmark:agentbench    # AgentBench capability baseline (offline fixture)
pnpm benchmark:gaia          # GAIA benchmark (full, requires Phase 2 fixture)
pnpm benchmark:gaia:quick    # GAIA 10-task offline dry-run + scoring self-test
pnpm benchmark:gaia:all      # GAIA full run alias
pnpm benchmark:osworld       # OSWorld capability scaffold
pnpm benchmark:crab          # CRAB capability scaffold
pnpm benchmark:swebench      # SWE-bench capability scaffold
pnpm benchmark:mlcommons:ailuminate # MLCommons AILuminate scaffold
pnpm benchmark:caict:ai-safety       # 信通院 AI Safety Benchmark scaffold

# Performance benchmarks
pnpm bench:wal               # WAL throughput baseline
pnpm bench:wal:regress       # WAL p99 regression check vs yesterday
pnpm bench:recovery          # RecoveryBootstrapper recovery time (10/100/1000 zombies)
pnpm bench:replay            # EventSourcingEngine replay performance (1k/10k/100k events)
pnpm bench:slo               # SLO baseline (recovery/failover/compensation/dlq)
pnpm bench:slo:regress       # SLO regression check vs yesterday
pnpm bench:e2e-latency       # E2E latency (mock LLM, P50/P95/P99 at concurrency 1-50)
pnpm bench:tenant-concurrency # Multi-tenant concurrent load (fairness + noisy-neighbor)

# Isolation benchmarks
pnpm bench:tenant-isolation  # Cross-tenant fuzz test (1000 mutations, 6 attack vectors)

# Cost benchmarks
pnpm bench:cost-prediction   # Cost prediction accuracy (predicted vs actual, MAE/P95)

# Topology benchmark (requires real LLM provider)
pnpm benchmark:topology      # 10 topology types, end-to-end wall-clock + token cost
```

## Benchmark Matrix

| Benchmark | Category | Script | Baseline Output | CI |
|---|---|---|---|---|
| AgentDojo (12 cases) | Security | `scripts/benchmark-agentdojo.ts` | `.commander/benchmarks/baseline-agentdojo.json` | ✅ red-team.yml |
| Agent-SafetyBench (10 cases) | Security | `scripts/benchmark-agentdojo.ts --all` | `.commander/benchmarks/baseline-all.json` | ✅ red-team.yml |
| AgentHarm (8 cases) | Security | `scripts/benchmark-agentdojo.ts --all` | `.commander/benchmarks/baseline-all.json` | ✅ red-team.yml |
| Red Team Battery (47 scenarios) | Security | `scripts/benchmark-redteam.ts` | `docs/baselines/redteam-baseline.*.json` | Manual |
| Chaos Engineering (255 cases) | Resilience | `benchmarks/chaos-runner/src/index.ts` | `benchmarks/chaos-runner/benchmark255-live-*.json` | Manual |
| WAL Throughput | Performance | `scripts/bench-wal-throughput.ts` | `docs/baselines/wal-baseline.*.json` | ✅ wal-bench.yml (daily) |
| WAL p99 Regression | Performance | `scripts/bench-wal-regress.ts` | CI step summary | ✅ wal-bench.yml |
| RecoveryBootstrapper | Recovery | `scripts/bench-recovery-bootstrap.ts` | `docs/baselines/recovery-baseline.*.json` | Manual |
| EventSourcing Replay | Recovery | `scripts/bench-event-sourcing-replay.ts` | `docs/baselines/replay-baseline.*.json` | Manual |
| SLO Measurement | SLO | `scripts/bench-slo-baseline.ts` | `docs/baselines/slo-baseline.*.json` | ✅ ci.yml |
| SLO Regression | SLO | `scripts/bench-slo-regress.ts` | CI exit code | Manual |
| CPU-Intensive | Performance | `packages/core/tests/cpu-intensive-benchmark.test.ts` | `.commander_benchmarks/cpu-baseline-*.json` | ✅ ci.yml |
| Worker Offload | Performance | `packages/core/tests/worker-offload-benchmark.test.ts` | `.commander_benchmarks/worker-baseline-*.json` | ✅ ci.yml |
| E2E Latency (mock) | Performance | `scripts/bench-e2e-latency.ts` | `docs/baselines/e2e-latency.*.json` | Manual |
| Tenant Isolation | Security | `scripts/bench-tenant-isolation.ts` | `docs/baselines/tenant-isolation.*.json` | Manual |
| Tenant Concurrency | Performance | `scripts/bench-tenant-concurrency.ts` | `docs/baselines/tenant-concurrency.*.json` | Manual |
| Cost Prediction | Cost | `scripts/bench-cost-prediction.ts` | `docs/baselines/cost-prediction.*.json` | Manual |
| Topology (provider-backed) | Performance | `scripts/benchmark-topology.ts` | `docs/results-*.json` | Manual |
| WebArena (fixture) | Capability | `scripts/benchmark-webarena.ts` | `packages/core/.cache/webarena/baseline.json` | Manual |
| AgentBench (fixture) | Capability | `scripts/benchmark-agentbench.ts` | `packages/core/.cache/agentbench/baseline.json` | Manual |
| GAIA (quick/full) | Capability | `scripts/benchmark-gaia.ts` | `/tmp/gaia-report.json` via `--output` | ✅ gaia-bench.yml |
| OSWorld (scaffold) | Capability | `scripts/benchmark-osworld.ts` | `packages/core/.cache/osworld/baseline.json` | Manual |
| CRAB (scaffold) | Capability | `scripts/benchmark-crab.ts` | `packages/core/.cache/crab/baseline.json` | Manual |
| SWE-bench (scaffold) | Capability | `scripts/benchmark-swebench.ts` | `packages/core/.cache/swebench/baseline.json` | Manual |
| MLCommons AILuminate (scaffold) | Safety | `scripts/benchmark-mlcommons-ailuminate.ts` | `packages/core/.cache/mlcommons-ailuminate/baseline.json` | Manual |
| 信通院 AI Safety Benchmark (scaffold) | Safety | `scripts/benchmark-caict-ai-safety.ts` | `packages/core/.cache/caict-ai-safety/baseline.json` | Manual |

## AgentDojo (prompt-injection robustness)

### Defender Architecture

`createCommanderDefender()` in `securityBenchmarkRunner.ts` implements a 3-layer defense stack:

1. **Layer 1: `scanToolOutputForInjection`** — regex-based indirect injection detection on tool outputs
2. **Layer 1b: `UniversalSanitizer`** — PII scrub (attacker email/URL/token detection in tool outputs)
3. **Layer 2: `ReversibilityGate`** — irreversible tool call blocking (send_email, transfer_money, delete_file, web_fetch)

### 12 Test Cases (6 format classes)

| ID | SubCategory | Format Class | Expected Defense Layer |
|---|---|---|---|
| AD-001 | email_exfiltration | tag_injection | Layer 1b (PII: attacker email) |
| AD-002 | credential_theft | tag_injection | Layer 1b (PII: attacker email) |
| AD-003 | financial_fraud | tag_injection | Layer 1b (PII: attacker email) |
| AD-004 | data_destruction | tag_injection | Layer 1b (PII: attacker email) |
| AD-005 | security_code_forwarding | tag_injection | Layer 1b (PII: phone) or Layer 2 |
| AD-006 | external_egress | tag_injection | Layer 1b (PII: attacker email) |
| AD-007 | multi_language | tag_injection | Layer 1b (PII: attacker email, JP) |
| AD-008 | encoded_payload | encoded_payload | Layer 1b (PII) or Layer 2 |
| AD-009 | semantic_no_tag | semantic_no_tag | Layer 1b (PII) or Layer 2 |
| AD-010 | html_disguise | html_disguise | Layer 2 (ReversibilityGate: transfer_money) |
| AD-011 | markdown_disguise | markdown_disguise | Layer 2 (ReversibilityGate: delete_file) |
| AD-012 | meeting_notes_disguise | meeting_notes_disguise | Layer 1b (PII) or Layer 2 |

### Historical Harness Results (StepFun step-3.7-flash; archival only)

The following tables are retained for reproducibility context. They are not
current product guarantees and have no external customer or production
validation attached.

| Metric | Baseline | Commander | Δ |
|---|---|---|---|
| Utility (user tasks) | 95.0% | 90.0% | -5.0 pp |
| Security rate | 79.1% | 100.0% | +20.9 pp |
| Attack success rate (ASR) | 20.9% | 0.0% | -20.9 pp |

## τ²-bench (multi-turn agent task completion)

### Airline

| Run | Baseline | Commander | Δ |
|---|---|---|---|
| 10 tasks | 100.0% | 80.0% | -20.0 pp |
| 30 tasks | 66.7% | 73.3% | +6.7 pp |

### Retail

| Run | Baseline | Commander | Δ |
|---|---|---|---|
| 10 tasks | 60.0% | 70.0% | +10.0 pp |
| 30 tasks | 63.3% | 53.3% | -10.0 pp |

## SLO Thresholds

| SLO | Threshold | Measured By |
|---|---|---|
| Recovery | < 5s | `bench-slo-baseline.ts` → `RunRecovery.attempt()` |
| Failover | < 10s | `bench-slo-baseline.ts` → `ProviderFallbackChain.tryProviders()` |
| Compensation | < 30s | `bench-slo-baseline.ts` → `CompensationRegistry.compensateAll()` |
| DLQ | < 60s | `bench-slo-baseline.ts` → `DeadLetterQueue.flush() + readEntries()` |

## RecoveryBootstrapper Benchmark

Measures `RecoveryBootstrapper.bootstrap()` scan time with 10/100/1000 zombie runs.

- **SLO**: 1000 zombies should recover in < 5s
- **Output**: `docs/baselines/recovery-baseline.*.json`

## EventSourcingEngine Replay Benchmark

Measures `replay()` throughput with 1k/10k/100k events, including snapshot acceleration.

- **SLO**: 10k events should replay in < 5s
- **Output**: `docs/baselines/replay-baseline.*.json`

## Cross-Tenant Isolation Fuzz Benchmark

Uses `CrossTenantFuzzTest` with 6 attack vectors (tenant_id_spoof, path_traversal, key_collision, prompt_injection, header_injection, async_context_leak) against in-memory tenant-aware storage.

- **Pass criteria**: 0 leaks detected
- **Output**: `docs/baselines/tenant-isolation.*.json`

## Red Team Battery

47 scenarios across 8 attack categories: prompt_injection, jailbreak, data_exfiltration, agent_jacking, tool_abuse, memory_poisoning, denial_of_wallet, supply_chain.

- **Defender**: `createComprehensiveDefender()` (4-layer: ContentScanner + ToolOutputScanner + GuardianAgent + SupplyChainScanner)
- **Pass criteria**: 0 critical findings unblocked
- **Output**: `docs/baselines/redteam-baseline.*.json`

## Reproducibility notes

- Baselines are saved to `docs/baselines/` with date-stamped filenames (YYYY-MM-DD)
- CPU/Worker baselines are saved to `.commander_benchmarks/`
- `pnpm check:readiness` verifies all required baselines exist
- WAL regression threshold: 15% p99 degradation (configurable via `REGRESSION_THRESHOLD_PCT`)
- SLO regression threshold: 25% latency degradation (configurable via `REGRESSION_THRESHOLD_PCT`)
- Topology benchmark requires real LLM provider; other benchmarks use mock or in-process simulation
