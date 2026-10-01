# Commander — Deployment Guide

Commander's API keeps its five authentication authorities (users, API keys,
refresh tokens, auth failures, rate limits) in PostgreSQL with **no
local/SQLite/in-memory fallback**: `apps/api/src/authDb.ts` fails closed with
`AUTH_DATABASE_URL_REQUIRED` when `DATABASE_URL` is absent, in every
`NODE_ENV`. The API also requires that DSN to authenticate as the
`commander_app` role (`AUTH_DATABASE_ROLE_INVALID` otherwise).

Consequently the **base profile is not a runnable deployment by itself**. A bare
`docker compose up` starts only the `api` service, and that container exits at
startup with `COMMANDER_API_STARTUP_FAILED: AUTH_DATABASE_URL_REQUIRED`, because
the base file deliberately injects no DSN. Use the `v2` or `cell` profile — both
wire `DATABASE_URL=postgres://commander_app:…@postgres:5432/commander` — for a
stack that actually boots. The web console, the database, the worker plane,
distributed execution, observability, and tracing stacks are opt-in via Docker
Compose **profiles**.

> **Alpha / non-production-ready:** this guide documents a self-hosted development
> and evaluation path. The checklist below does not establish production readiness,
> tenant isolation, an SLA, or a data-processing agreement. Review
> [`PRIVACY.md`](../PRIVACY.md) and [`ENTERPRISE_READINESS.md`](../ENTERPRISE_READINESS.md)
> before a pilot.

## Quick start (single-box)

`.env.example` is a **template, not a working configuration**: it ships with
blank required secrets, so `cp .env.example .env` alone will not start the API.
Fill in every required value before bringing the stack up.

```bash
cp .env.example .env
# Edit .env: set all required API startup credentials and at least one LLM provider key
docker compose up                  # api only — exits with AUTH_DATABASE_URL_REQUIRED, see above
docker compose --profile web up    # api + web console (same exit)
```

For a stack that boots, use the `v2` or `cell` profile (each wires the
`commander_app` DSN and Postgres). Both are kernel-on, and the kernel refuses to
connect without pinned database TLS, so generate that material first:

```bash
sh deploy/docker/kernel-tls/generate-certificates.sh ./.commander/db-tls
export COMMANDER_DATABASE_TLS_HOST_DIR="$PWD/.commander/db-tls"
export COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256=<printed by the generator>

docker compose -f docker-compose.yml -f docker-compose.v2.yml -f docker-compose.kernel-tls.yml --profile v2 up -d --build
```

`createVerifiedPostgresPool` (`packages/postgres-runtime`) is the only sanctioned
pool factory, and it verifies the CA, the DSN hostname, and a pinned server
public key. The `api`, `worker`, `kernel-ops` and `kernel-migrate` services each
build one, so with no material they exit during startup with
`COMMANDER_DATABASE_TLS_CA_FILE_REQUIRED`. `docker-compose.kernel-tls.yml` carries
that material and MUST be passed as the third `-f` file for both profiles; it is
not a separate stack. Running `v2` or `cell` without exporting the two variables
fails compose interpolation before anything starts. (`include:` is deliberately
not used: `docker compose up` rejects the merged service definitions with
`services.<name> conflicts with imported resource`, even though `docker compose
config` accepts them.)

`docker compose up` with no profile starts:

- `api` on `127.0.0.1:4000` (Commander execution engine + War Room REST API),
  backed by local SQLite with the shared kernel explicitly disabled. It publishes
  on loopback only. It carries **no** `DATABASE_URL`, so it cannot satisfy the
  mandatory PostgreSQL auth authorities and exits during startup.

Adding `--profile web` (alias `--profile gui`) also starts:

- `web` on `127.0.0.1:3000` (Agent dashboard UI; nginx reverse-proxies to `api`)

`web` has `depends_on: api: condition: service_healthy`, so it starts only after
the API health check passes. The `web` image is built from the tracked
[`apps/web/Dockerfile`](../apps/web/Dockerfile) — never from the repository-root
`Dockerfile`, which is gitignored and therefore absent from a fresh clone.

State is persisted in named volumes (`commander_local_state` for the SQLite API
state plus `commander_state`, `commander_traces`, `commander_memory`,
`commander_results`).

For a production-shaped stack (Postgres + kernel + worker plane) use the `v2`
profile rather than combining the local base with the worker profile:

```bash
docker compose -f docker-compose.yml -f docker-compose.v2.yml -f docker-compose.kernel-tls.yml --profile v2 up -d --build
```

The `v2` and `cell` overrides set `NODE_ENV=production`, enable the shared kernel,
supply the role DSNs (`sslmode=verify-full`, wired by
`docker-compose.kernel-tls.yml`), require the Ed25519 authority key material **and**
the pinned database TLS material from the quick start above, and gate the API and
worker on the owner migration completing. The base file stays local-only, so
`--profile worker` on its own adds workers against a still-local API — use `v2` or
`cell` for an end-to-end kernel-backed run.

### Owner migration and the tenant-authority closure

`kernel-migrate` runs as the `commander_owner` role and is the only component
allowed to change schema. It applies **two** stages: the immutable baseline
descriptor set, then the phase-bound Task-1 closure, and finally re-applies the
forward set so post-closure descriptors land in the same run.

That second stage is not optional. Until the canonical *enforce* closure row is
recorded, the forward set is truncated to the pre-closure baseline — which does
**not** include the auth-persistence schema (`commander_auth_users`, API keys,
refresh tokens, auth failures, rate limits). An API started against a
baseline-only database dies with
`COMMANDER_API_STARTUP_FAILED: relation "commander_auth_users" does not exist`,
even though the migration reported success. This is why every path that starts
migrations as a long-lived service passes the closure action explicitly — the
Compose `kernel-migrate` service, the Helm owner Job, and the production Compose
driver all do.

`COMMANDER_TENANT_AUTHORITY_CUTOVER_PHASE` selects the phase and defaults to
`enforce` (the fresh-install phase, matching the chart default
`tenantAuthority.cutoverPhase`). A legacy upgrade that must sequence an
`expand` phase before `enforce` overrides it for the first run.

## Verifying a deployment

`pnpm verify:deployment` is a static gate that needs no Docker, Helm, or
cluster. It proves the documented paths are internally consistent with the
current code — compose build sources and bind-mount sources exist, are
git-tracked, and are not gitignored, build targets resolve, Dockerfiles install
the full workspace dependency closure, every `${VAR:?…}` required by the
single-box compose files is documented as an **uncommented** assignment in
`.env.example` (a commented `# VAR=` line does not count), Helm `.Values`
references and helpers resolve, the documented health routes are mounted, and
the npm scripts this guide requires exist.

It runs as part of `pnpm test:deploy-gates`.

## Opt-in profiles

| Profile | Adds | When to enable |
|---|---|---|
| `web` / `gui` | Web console (host port 3000) | You want the browser dashboard |
| `database` | PostgreSQL | You need a durable local database |
| `worker` | `postgres`, `kernel-migrate`, `worker`, `kernel-ops`, `adapter-ops` | Distributed execution; needs Postgres + Ed25519 keys. The base `api` stays local, so prefer `v2`/`cell` for an end-to-end kernel-backed run |
| `distributed` | Redis | Multi-node EventBus fan-out, >1 api replica |
| `observability` | Prometheus + Grafana | Metrics collection + dashboards |
| `tracing` | Jaeger | OTLP distributed tracing of LLM + tool calls |
| `v2` | Full V2 stack via `docker-compose.v2.yml` (kernel-on, so it also needs the pinned database TLS material) | Kernel/worker-plane evaluation |
| `cell` | Cell topology via `docker-compose.cell.yml` (same TLS requirement) | Sandboxed cell deployment |

Profiles compose freely:

```bash
# Single-box with the web console
docker compose --profile web up

# Single-box with metrics dashboard
docker compose --profile observability up

# Optional ops stack (Redis + metrics + tracing) — not a certified multi-tenant SaaS deploy
docker compose --profile distributed --profile observability --profile tracing up

# Durable V2 stack (adds Postgres + worker plane; needs the pinned TLS material
# exported first — see the quick start)
docker compose -f docker-compose.yml -f docker-compose.v2.yml -f docker-compose.kernel-tls.yml --profile v2 up -d --build
```

The root `package.json` wraps only three combinations: `pnpm docker:up` (api),
`pnpm docker:v2`, and `pnpm docker:cell`. Everything else is the raw
`docker compose` invocation above.

## Service endpoints (default ports)

| Service | Port | URL | Notes |
|---|---|---|---|
| api | 4000 | http://localhost:4000 | Bearer-auth via `COMMANDER_API_KEY` |
| web | 3000 | http://localhost:3000 | Reverse-proxied to api |
| Redis | 6379 | redis://redis:6379 | `distributed` profile only |
| Prometheus | 9090 | http://localhost:9090 | `observability` profile |
| Grafana | 3001 | http://localhost:3001 | `observability` profile, admin/admin default |
| Jaeger UI | 16686 | http://localhost:16686 | `tracing` profile |
| OTLP (HTTP) | 4318 | — | `tracing` profile, used by api exporter |
| OTLP (gRPC) | 4317 | — | `tracing` profile |

## Health checks

Long-running compose services expose healthchecks. The `api` service serves
`/health` (liveness), `/ready` (readiness), `/health/detailed`, `/v1/health`,
`/metrics`, and `/system/status`. There is no `/readyz` or `/livez` alias.
**kernel-ops** (worker/v2 profiles) serves
`GET /health` (process up) and `GET /ready` (the loops kernel-ops owns —
reclaim, timer, outbox, compensation probe — plus Postgres `SELECT 1`)
on `COMMANDER_OPS_HEALTH_PORT` (compose default `8081`; `expose`
and the in-container healthcheck use the same variable). Helm values may
choose another port and must keep probes in sync. The Helm chart
wires matching `livenessProbe` / `readinessProbe` on the kernel-ops
Deployment. The `web` service waits for `api` to become healthy
(`depends_on: condition: service_healthy`), and `grafana` waits for
`prometheus`. A single `docker compose up --profile observability` therefore
boots in dependency order without manual orchestration.

Probe ownership matters when reading readiness: kernel-ops reports readiness for
the loops it actually runs and surfaces `compensationMode` /
`compensationDraining` as detail fields only (its default wiring is probe-only,
so it is not the compensation drain owner). The real EffectBroker-backed drain
readiness belongs to **adapter-ops**: `/ready` is its drain gate, `/health`
reflects its ops-loop health, and `/livez` is the process-only liveness route
(used as the chart's `livenessProbe`) so a transient database or claim outage
does not trigger a restart storm.

The Helm chart follows the same split for the api Deployment. With the
PostgreSQL backend, `readinessProbe` is an exec probe against the
tenant-authority proof listener (`tenantAuthority.apiProof.port`, default
`9443`, path `/ready/tenant-authority/v1`) because that listener also proves the
runtime identity. Without that backend the probe is a plain `httpGet` on
`api.health.readinessPath` (default `/ready`) over the `http` port. `startupProbe`
and `livenessProbe` always use `api.health.livenessPath` (default `/health`) on
`http`.

Default compose is the **local / single-box** path. Durable multi-tenant
Enterprise Gateway needs a Postgres DSN + `/v1` kernel and remains **alpha**
(`ENTERPRISE_READINESS.md`).

## Environment variables

See `.env.example` for the full list. Highlights:

- `COMMANDER_API_KEY` — required, fail-fast if unset. Generate with `openssl rand -hex 32`.
- `COMMANDER_MASTER_KEY`, `JWT_SECRET`, `COMMANDER_CAPABILITY_TOKEN_KEY`, and `COMMANDER_INTEGRITY_KEY` — required API secrets. Generate each with `openssl rand -hex 32`.
- `COMMANDER_AUDIT_CHAIN_KEY` — HMAC master key for the tamper-evident audit chain. Required in production: the ledger refuses to start (and rejects the public dev key) rather than emitting cryptographically invalid tamper-evidence. Generate with `openssl rand -hex 32`.
- `COMMANDER_MANIFEST_KEY` — HMAC key for the chain manifest. Required only when `COMMANDER_AUDIT_MANIFEST_DIR` enables the manifest + verify timer, and it must be **distinct** from `COMMANDER_AUDIT_CHAIN_KEY`.
- `ADMIN_PASSWORD` — required for the initial admin account; use at least 16 random characters.
- `API_HOST` — listener interface. The API defaults to `127.0.0.1`; Docker and Helm set `0.0.0.0` explicitly.
- `COMMANDER_EVENT_BUS_BACKEND=redis` — switch from in-memory to Redis-backed EventBus (requires `distributed` profile).
- `COMMANDER_EVENT_BUS_REDIS_URL` — Redis connection URL (defaults to `redis://redis:6379`, the compose service name).
- `OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4318` — point the OTLP exporter at the Jaeger collector (requires `tracing` profile).
- `GRAFANA_ADMIN_PASSWORD` — change from the default `admin` in production.

## Production hardening checklist (not a readiness sign-off)

1. **Set all API startup credentials**: `COMMANDER_API_KEY`, `COMMANDER_MASTER_KEY`, `JWT_SECRET`, `COMMANDER_CAPABILITY_TOKEN_KEY`, `COMMANDER_INTEGRITY_KEY`, `COMMANDER_AUDIT_CHAIN_KEY`, and `ADMIN_PASSWORD`.
2. **Set `API_HOST=127.0.0.1`** when running the API directly behind a reverse proxy / TLS terminator.
3. **Set `CORS_ORIGINS`** explicitly — never use `*` in production.
4. **Enable `distributed` profile** when running >1 api replica (Redis is required for cross-node EventBus consistency).
5. **Change `GRAFANA_ADMIN_PASSWORD`** from the default `admin`.
6. **Configure log persistence**: set `COMMANDER_LOG_PERSIST=true` and rotate the volume (the system auto-degrades to Error-only logging at 10000 entries of backlog).
7. **Back up the `commander_state` volume** — it contains the EventSourcingEngine WAL and is the source of truth for crash recovery.

## Extending Commander

### Adding an LLM provider

One step: append a `registerProvider()` call in
[packages/core/src/runtime/providers/providerRegistry.ts](../packages/core/src/runtime/providers/providerRegistry.ts).
The registry derives `PROVIDER_ORDER` / `ENV_MAP` / `DEFAULT_URLS` / `DEFAULT_MODELS` /
`DISPLAY_NAMES` / `API_TYPE` and the factory chain automatically. No other files need
to change. See [packages/core/tests/providerRegistry.test.ts](../packages/core/tests/providerRegistry.test.ts)
for the contract that locks this in place.

### Adding an HTTP endpoint

One step: append a `registerRouter()` call in the manifest section of
[apps/api/src/index.ts](../apps/api/src/index.ts). No scattered `app.use()` needed —
`mountRegisteredRouters(app)` mounts everything in registration order. See
[apps/api/test/routerRegistry.test.ts](../apps/api/test/routerRegistry.test.ts) for the contract.

### Adding a plugin

Implement the `CommanderPlugin` interface (see
[packages/core/src/pluginTypes.ts](../packages/core/src/pluginTypes.ts) for the full
hook surface: 21 hook callbacks / 19 `HookManager` fire points, config schema,
tool adapter). Register via
`getHookManager().register(plugin)` at boot. Third-party plugins are sandboxed
through `buildSandboxedLoadContext` so their permissions stay strictly below
the host's (see `packages/core/tests/pluginPermissions.test.ts`).

## Helm (Kubernetes)

A Helm chart is provided at [deploy/helm/commander](../deploy/helm/commander) for
Kubernetes deployments with HPA, ingress, network policies, and a Redis
StatefulSet. Read [deploy/helm/commander/values.yaml](../deploy/helm/commander/values.yaml)
for the full configuration surface. Do not use the legacy tree at `helm/commander`
(kept for reference only; worker tenants must be an explicit list, never `*`).

API cells may still set `COMMANDER_CAPABILITY_TOKEN_KEY` (HMAC) for the API
surface only. Worker and adapter-ops authority uses Ed25519 PEM/JWKS/key id —
never the HMAC env on those components.

The chart does not accept a `commander.apiKey` value and does not generate API
startup secrets outside the disposable `demo` tier. For any non-demo tier
(`team`, `enterprise`) the release **fails to render** unless you supply either
`api.secrets.existingSecret` or all of the individual secret references
(`COMMANDER_API_KEY`, `COMMANDER_MASTER_KEY`, `JWT_SECRET`,
`COMMANDER_CAPABILITY_TOKEN_KEY`, `COMMANDER_INTEGRITY_KEY`,
`COMMANDER_AUDIT_CHAIN_KEY`, `ADMIN_PASSWORD`).
The same fail-fast applies to `worker.authTokenSecret` when `worker.enabled=true`,
and `web.enabled=true` is rejected because the chart renders no web workload.
Create the Secret (or the individual references) before installing:

```bash
# Pre-create the API startup Secret, then reference it.
kubectl create secret generic commander-api-secrets \
  --from-literal=COMMANDER_API_KEY="$(openssl rand -hex 32)" \
  --from-literal=COMMANDER_MASTER_KEY="$(openssl rand -hex 32)" \
  --from-literal=JWT_SECRET="$(openssl rand -hex 32)" \
  --from-literal=COMMANDER_CAPABILITY_TOKEN_KEY="$(openssl rand -hex 32)" \
  --from-literal=COMMANDER_INTEGRITY_KEY="$(openssl rand -hex 32)" \
  --from-literal=COMMANDER_AUDIT_CHAIN_KEY="$(openssl rand -hex 32)" \
  --from-literal=ADMIN_PASSWORD="$(openssl rand -base64 24)"
```

Supplying the API startup secrets alone is **not** sufficient to install a
non-demo tier. The API is a production process and refuses to start without the
durable shared kernel, so a release that renders `config.nodeEnv=production`
while `database.enabled=false` / `database.backend=sqlite` now **fails at
template time** with an actionable message instead of producing a Deployment
that CrashLoops in the cluster. A non-demo tier therefore also needs the
PostgreSQL + tenant-authority lifecycle material (owner / app /
tenant-authority DSNs, the database TLS CA, and the API proof certificate)
described in the next section — or `config.nodeEnv` set to a non-production
value for a local-first evaluation deployment.

Render a disposable smoke release with the `demo` overlay (chart-created
ephemeral secrets, bundled PostgreSQL):

```bash
helm template cell-demo deploy/helm/commander \
  -f deploy/helm/commander/values-demo.yaml \
  --set image.tag=test \
  --set tenantAuthority.proofOwnerSecret=cell-demo-proof-owner-r1 \
  --set tenantAuthority.releaseProjectionConfigMap=cell-demo-release-projection-r1
```

For a real install, use the tenant cutover entrypoint in the next section rather
than a bare `helm install`.

The lifecycle harness pins **Helm 3.17.3**; the chart's post-renderer contract is
not compatible with Helm 4.

### Tenant-authority Helm lifecycle

The PostgreSQL tenant-authority path is a staged lifecycle, not a raw `helm
rollback` workflow. Pre-create all six role DSNs under their final Secret keys,
the public database CA/SPKI material, and the API proof certificate material.
Persistent bundled PostgreSQL also requires an externally managed stable
database Secret before Helm starts; chart-generated credentials are restricted
to disposable bundled storage.

Before `expand`, a cluster administrator creates the network admission
prerequisite. The deployment operator then performs its read-only verification
stage. After a fully Ready context-aware expand release, the cluster
administrator creates the workload admission prerequisite and the operator
again verifies it read-only. Kubernetes 1.33 operators must not create or
update admission policies or bindings.

Use the tenant cutover entrypoint supplied by the lifecycle integration rather
than direct release commands. Its Helm invocation is cluster-connected and
always uses `--atomic --wait --wait-for-jobs --timeout 10m`; a native
`helm rollback` is unsupported. The required integration-owner package script
entries are `helm:stamp-chart-content-digest`, `helm:tenant-cutover`,
`helm:render-tenant-authority-workload-guard`,
`helm:install-tenant-authority-admission-prerequisites`,
`helm:prepare-tenant-authority-prerequisites`, `helm:recover-tenant-authority`,
`helm:adopt-database-secret`, `test:helm:lifecycle:static`, and
`test:helm:lifecycle:kind`.
