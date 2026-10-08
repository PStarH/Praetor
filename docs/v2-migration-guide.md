# Commander V2 Migration Guide

This document guides operators and developers through the migration from
legacy V1 execution paths to the Architecture V2 durable execution kernel.

## Overview

Architecture V2 enforces a strict separation between the **control plane**
(Gateway API) and the **execution plane** (Worker Service). In V2:

- The Gateway **schedules** durable work but **never executes** agents.
- Workers claim steps from the kernel and execute them in isolation.
- All state lives in PostgreSQL, not in pod-local files or process memory.

## Environment Variables

| Variable                           | Default                      | Description                                                                                                                                                                                                                          |
| ---------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `COMMANDER_V2_MODE`                | `0`                          | Set to `1` to enable V2 mode (disables legacy routes).                                                                                                                                                                               |
| `COMMANDER_KERNEL_ENABLED`         | auto                         | Durable `/v1` kernel: unset = **auto** (ON when `NODE_ENV=production`, `COMMANDER_V2_MODE=1`, or a kernel DSN is set); `1`/`true`/`on` force ON; `0`/`false`/`off` force OFF (non-prod escape hatch only — production refuses `=0`). |
| `NODE_ENV`                         | —                            | When set to `production`, V2 mode is automatically enabled.                                                                                                                                                                          |
| `COMMANDER_LEGACY_EXECUTION`       | `0`                          | Set to `1` to re-enable legacy routes in V2 mode (temporary bridge).                                                                                                                                                                 |
| `DATABASE_URL`                     | —                            | PostgreSQL connection string (required for V2 kernel).                                                                                                                                                                               |
| `COMMANDER_KERNEL_DATABASE_URL`    | falls back to `DATABASE_URL` | Preferred DSN for the shared execution kernel.                                                                                                                                                                                       |
| `COMMANDER_WORKER_BOOTSTRAP`       | —                            | Path to worker bootstrap module (default: `@praetor/worker-plane/bootstrap`).                                                                                                                                                      |
| `COMMANDER_WORKER_KIND`            | `agent`                      | Worker type: `agent`, `tool`, `evaluator`.                                                                                                                                                                                           |
| `COMMANDER_WORKER_CAPABILITIES`    | `agent`                      | Comma-separated capability list.                                                                                                                                                                                                     |
| `COMMANDER_WORKER_MAX_CONCURRENCY` | `10`                         | Maximum concurrent steps per worker.                                                                                                                                                                                                 |
| `COMMANDER_WORKER_TENANTS`         | `*`                          | Comma-separated tenant IDs, or `*` for all.                                                                                                                                                                                          |
| `COMMANDER_WORKER_AUTH_TOKEN`      | —                            | Worker authentication token (required).                                                                                                                                                                                              |
| `COMMANDER_PLUGIN_SANDBOX`         | `in_process`                 | Sandbox mode: `in_process`, `subprocess`, `required`.                                                                                                                                                                                |

### Dual path (temporary)

| Surface                     | Authority                                 | Notes                                                                                                   |
| --------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `POST/GET /v1/runs*`        | Shared durable kernel (`packages/kernel`) | Fail closed with `KERNEL_UNAVAILABLE` when kernel is not configured. Never writes through WarRoomStore. |
| War Room missions / UI logs | `WarRoomStore`                            | Non-`/v1` mission store only. Demoted; not the durable run authority.                                   |

## Route Migration

### Legacy Routes

| Legacy Route                     | Current state                     | V2 Replacement                    |
| -------------------------------- | --------------------------------- | --------------------------------- |
| `POST /api/orchestrator/execute` | Present, gated by legacy-execution | `POST /v1/runs`                   |
| `POST /api/state-machine/*`      | Present, gated; `approve`/`reject` exempt | `POST /v1/runs` with a WorkGraph |
| `POST /api/runs/*`               | Returns `410 LEGACY_EXECUTION_GONE` | `POST /v1/runs`                  |
| `POST /api/runtime/execute`      | **Already removed** — no such route | `POST /v1/runs`                  |
| `POST /api/chat`                 | **Already removed** — router is not mounted | `POST /v1/runs` with an agent step |
| `POST /api/webhook/:platform/:id`| **Already removed** — router is not mounted | `POST /v1/runs`, triggered by your own webhook handler |
| `POST /api/pause/:runId`, `/resume`, `/cancel` | **Already removed** | `POST /v1/runs/:runId/{pause,resume,cancel}` |

The "already removed" rows are routers that exist in the source tree but are
never mounted by `apps/api/src/index.ts`, so they 404 regardless of V2 mode.
They are listed only so that a V1 client owner knows what replaced them.

### V2 API Endpoints

| Endpoint                     | Method | Description                        |
| ---------------------------- | ------ | ---------------------------------- |
| `/v1/runs`                   | POST   | Submit a new run with a WorkGraph. |
| `/v1/runs/:runId`            | GET    | Get run detail.                    |
| `/v1/runs/:runId/status`     | GET    | Get run status.                    |
| `/v1/runs/:runId/events`     | GET    | Get event log for a run.           |
| `/v1/runs/:runId/pause`      | POST   | Pause a running run.               |
| `/v1/runs/:runId/resume`     | POST   | Resume a paused run.               |
| `/v1/runs/:runId/cancel`     | POST   | Cancel a run.                      |
| `/v1/privacy/erasure`        | POST   | Erasure request.                   |
| `/v1/actions/*`              | —      | Governed action surface (12 routes: kill switches, simulate, propose, approve/reject, compensations, reconcile, evidence). |
| `/v1/projects*`              | GET    | Read-only project views.           |
| `/v1/health`                 | GET    | Gateway-narrowed readiness.        |
| `/v1/openapi.json`           | GET    | OpenAPI 3.1 document.              |
| `/metrics`                   | GET    | Prometheus metrics.                |
| `/health`, `/ready`          | GET    | Liveness and readiness.            |

> **Note:** there is no `/v1/runs/:runId/steps`, `/v1/interactions/:runId`, or
> top-level `/v1/slo`, `/v1/alerts`, `/v1/incidents` route. Step and interaction
> data is reached through the action and observability surfaces. SLO status is
> served by the observability API at
> `GET /api/v1/observability/slos`.

## Storage Migration

### Pod-Local → PostgreSQL

| Legacy Storage                         | V2 Storage                                                                        | Migration                                                    |
| -------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `.commander/api_state.db` (SQLite)     | PostgreSQL `api_*` tables (`api_tasks`, `api_artifacts`, `api_governance_checkpoints`, `api_governance_configs`) | Set `API_STORE_BACKEND=postgres` + `DATABASE_URL`, then run the kernel migration (`node packages/kernel/dist/migrate.js`, or the `kernel-migrate` Compose service). |
| `.commander/api_keys.json`             | PostgreSQL `commander_auth_api_keys`                                             | Export existing keys, import via control-plane API.          |
| `.commander_state/` checkpoints        | PostgreSQL `commander_runs` + `commander_steps`                                   | Old checkpoints are incompatible; runs must be re-submitted. |
| In-memory `Map<string, ChatHistory[]>` | PostgreSQL event sourcing                                                         | Chat history is reconstructed from event log.                |
| `.commander/webhooks.json`             | **still `.commander/webhooks.json`** (no Postgres migration)                      | IM (DingTalk/Feishu/WeCom) and outgoing webhook configs remain file-backed in `apps/api/src/webhookEndpoints.ts`. Copy the file with the rest of your pod-local state if you move hosts; it is per-replica, not shared. |

## Worker Deployment

### Starting a Worker

```bash
# Set required environment variables
export DATABASE_URL="postgresql://user:pass@host:5432/commander"
export COMMANDER_KERNEL_DATABASE_URL="postgresql://user:pass@host:5432/commander"
export COMMANDER_WORKER_AUTH_TOKEN="your-secret-token"
export COMMANDER_WORKER_AUTH_SUBJECT="worker-1"
export COMMANDER_WORKER_CAPABILITIES="agent,tool"
export COMMANDER_WORKER_MAX_CONCURRENCY=10
export COMMANDER_WORKER_TENANTS="tenant-a,tenant-b"

# The worker is fail-closed: it requires a bootstrap module exporting
# createWorkerService(). There is no permissive default.
export COMMANDER_WORKER_BOOTSTRAP=/path/to/your/worker-bootstrap.js

# Start the worker (binary from @praetor/worker-plane)
commander-worker
```

`COMMANDER_WORKER_TENANTS` must be an explicit list — never `*`.

### Worker Authentication

Workers register with a bearer token plus a subject claim
(`COMMANDER_WORKER_AUTH_TOKEN`, `COMMANDER_WORKER_AUTH_SUBJECT`). The bootstrap
refuses to start when the token is missing
(`packages/worker-plane/src/bootstrap.ts:251-253`).

The worker registry enforces:

1. Token validity (timing-safe comparison)
2. Tenant scope — workers can only claim steps for authorized tenants
3. Capability scope — workers can only execute matching step kinds

mTLS worker registration is **not yet** implemented. For multi-cluster or
zero-trust environments, front the worker with your own authenticated transport.

## Plugin Sandbox Configuration

| Mode         | Description                                              | Use Case               |
| ------------ | -------------------------------------------------------- | ---------------------- |
| `in_process` | Execute directly in worker process (no isolation).       | Development only.      |
| `subprocess` | Execute in OS-level sandbox (seccomp/bubblewrap/Docker). | Production.            |
| `required`   | Fail-closed if no sandbox backend is available.          | Enterprise production. |

```bash
# Production sandbox configuration
export COMMANDER_PLUGIN_SANDBOX=required
export COMMANDER_PLUGIN_SANDBOX_SOFT=0  # No soft fallback
```

## Step-by-Step Migration

1. **Set up PostgreSQL** and run schema migrations:

   ```bash
   export DATABASE_URL="postgresql://..."
   export COMMANDER_KERNEL_BACKEND=postgres
   node packages/kernel/dist/migrate.js
   ```

   In Compose, this is the one-shot `kernel-migrate` service
   (`docker compose --profile v2 up kernel-migrate`).

2. **Enable V2 mode** (non-disruptive — legacy routes still work):

   ```bash
   export COMMANDER_V2_MODE=1
   export COMMANDER_LEGACY_EXECUTION=1  # temporary bridge
   ```

3. **Start workers** alongside the Gateway:

   ```bash
   export DATABASE_URL="..."
   export COMMANDER_WORKER_AUTH_TOKEN="..."
   export COMMANDER_WORKER_BOOTSTRAP=/path/to/your/worker-bootstrap.js
   commander-worker
   ```

4. **Migrate clients** to V2 API (`POST /v1/runs`).

5. **Disable legacy routes**:

   ```bash
   export COMMANDER_LEGACY_EXECUTION=0  # or simply unset it
   ```

6. **Verify** no legacy routes are accessible (the API listens on `4000`, not
   `3000` — `3000` is the web console in the Compose deployment):

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' http://localhost:4000/api/runtime/execute
   # 404 — this route was never mounted
   curl -s -o /dev/null -w '%{http_code}\n' http://localhost:4000/api/runs
   # 410 — legacy execution gone
   ```

## Verification Checklist

- [ ] `DATABASE_URL` is set and PostgreSQL is reachable.
- [ ] `COMMANDER_V2_MODE=1` is set.
- [ ] At least one worker is registered in the kernel `commander_workers` table.
- [ ] `POST /v1/runs` returns `202 Accepted` with a run ID (or `200` for an idempotent replay).
- [ ] Steps transition from `PENDING` → `RUNNING` → `SUCCEEDED`.
- [ ] `/metrics` exposes `commander_runs_total`, `commander_dlq_entries_total`,
      `commander_step_latency_ms_*`, and the process gauges
      (`commander_heap_used_bytes`, `commander_rss_bytes`,
      `commander_uptime_seconds`, `commander_heap_percent`).

> There is **no** `commander_workers_active` metric. Worker liveness lives in the
> kernel `commander_workers` table and is not exported to Prometheus, so any
> alert or panel based on that name will never produce data.
- [ ] Legacy routes (`/api/runtime`, `/api/orchestrator`) return `404`.
- [ ] SLO dashboard at `/slo` shows 6 SLOs.
- [ ] Prometheus alerting rules are loaded.
- [ ] DR backup script runs successfully (`tsx scripts/dr-backup-verify.ts --full`).
