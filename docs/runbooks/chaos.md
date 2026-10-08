# Chaos Engineering Runbook

## Running Chaos Tests

There is no `commander chaos` command. `packages/core/src/cli/commands/chaos.ts`
exports a `runChaosCli()` helper, but it is not registered in
`packages/core/src/cliEntry.ts`, has no callers, and the file has no top-level
entry point — running it directly executes nothing. Drive the layers through the
suites below instead.

```bash
# Layer suites (L1/L2/L3/L4) + orchestrator/recovery-verifier contract.
# These are opt-in: they are deliberately absent from vitest.config.ts's
# `include`, so a bare `vitest run tests/chaos` finds nothing and the suite is
# reached through its own config.
pnpm --filter @praetor/core test:chaos:layers

# End-to-end failure-injection suite (provider fallback, SQLite failure, OOM)
pnpm --filter @praetor/core test:chaos

# Benchmark harness (simulated fault campaigns, scored)
pnpm benchmark:chaos
pnpm benchmark:chaos:full          # --max 255
pnpm benchmark:chaos:stats
```

For a full end-to-end pass that includes the gap-discovery loop and the chaos
orchestrator, run the smoke test at
`packages/core/src/smoke/smokeTestE2E.ts`.

## Layers

- **L1 (LLM)**: Provider-level fault injection (rate limits, timeouts, etc.)
- **L2 (Tool)**: 10 failure modes (http_5xx, http_4xx, disk_full, oom, process_crash, state_corrupt, dependency_unavailable, time_drift, auth_expired, http_timeout)
- **L3 (System)**: Process/disk/CPU/memory faults
- **L4 (Tenant)**: Multi-tenant blast radius enforcement

## Adding New Scenarios

1. Add fault config to the layer module under `packages/core/src/chaos/`
   (`l1LlmLayer.ts` / `l2ToolLayer.ts` / `l3SystemLayer.ts` / `l4TenantLayer.ts`).
2. Write the test under `packages/core/tests/chaos/`.
3. Wire it into the dispatcher in `packages/core/src/chaos/orchestrator.ts`.
   Note that `runLayer()` is currently a stub that only reports the scenario's
   first `faultType`; it does not yet arm the layers, so a new scenario also
   needs the dispatch logic that actually injects the fault.

## Recovery Verification

`ChaosOrchestrator.run()` calls `RecoveryVerifier.verifyAndRecover()` after each
layer run. The verifier awaits the `bootstrap` callback injected through
`OrchestratorDeps`; if that callback throws, it returns
`recoverySucceeded: false` and the layer result records the failure. Note that
`RecoveryBootstrapper.bootstrap()` — the callback wired in by the CLI helper — is
a *synchronous* zombie-run scan that logs and returns a summary rather than
throwing, so with that wiring `recoverySucceeded` is effectively always `true`.

A failed recovery is not written to a report object. `onGapDetected` fires on
the `GapCallback` only when a fault was actually injected **and** recovery
failed; healthy runs and successful recoveries are not gaps. The CLI helper
prints one `recovery OK|FAILED` line per layer.

## Governed Rollback Pilot

The design-partner proof injects named lifecycle faults at
`before_remote_request`, `after_remote_commit`, `before_local_complete`,
`during_outcome_query`, `during_compensation`, and `during_evidence_persist`.
A timeout never authorizes a second write: the operator queries the Kubernetes
marker and revision, then resolves or escalates the durable unknown. Any tenant
isolation failure, digest mismatch, duplicate write, missing receipt, or unknown
older than 5 minutes activates the scoped kill switch and ends the trial.
