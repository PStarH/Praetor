# C/D CI Handoff

> 目的：把 Module C/D 的 live gate 从本机 VM/Colima 网络迁移到一个可复现的
> CI runner。本文只记录环境契约和产物位置，不包含密码、token、私钥或客户数据。
>
> 依据：`.github/workflows/ci.yml`、`docs/runbooks/design-partner-launch-readiness.md`、
> `scripts/kubernetes-rollback-kind.ts`、`scripts/dr-backup-verify.ts`。

## 0. Runner contract

使用 Linux x64 runner（Node 22、pnpm、Docker、kind、kubectl、Helm、`psql`、
`pg_dump`、`pg_restore`、`createdb`、`gpg`）。Kind 和 Compose 必须使用同一个
Docker daemon；不要让容器把宿主机的 `127.0.0.1` 当作数据库地址。

```bash
export EVIDENCE_ROOT="${GITHUB_WORKSPACE:-$PWD}/.internal/evidence/cd/${GITHUB_RUN_ID:-local}"
export KUBECONFIG="${RUNNER_TEMP:-/tmp}/cd-kubeconfig"
mkdir -p "$EVIDENCE_ROOT"/{g3,g4,g5,logs}

export DOCKER_HOST="${DOCKER_HOST:-unix:///var/run/docker.sock}"
docker info
```

CI 结束时上传以下路径（即使 gate 失败也上传）：
`$EVIDENCE_ROOT/**`、`artifacts/*.json`、`.superpowers/sdd/authority-closure-proof-latest.*`。

## 1. PostgreSQL variables

GitHub Actions 的 Postgres service 使用下列可审计的合成值；生产/专用 runner
把密码替换成 secret，但保持角色和变量语义不变：

```bash
export DATABASE_URL='postgres://commander:commander@localhost:5432/commander'
export COMMANDER_KERNEL_DATABASE_URL="$DATABASE_URL"
export OWNER_DSN="$DATABASE_URL"
export COMMANDER_TASK1_PG_URL="$DATABASE_URL"
```

- `DATABASE_URL`：G4 source DSN，必须能创建/读取 restore 所需对象；不要使用只读
  `commander_app` DSN。
- `COMMANDER_KERNEL_DATABASE_URL`：G3 authority/P0 使用的同一 source DSN。
- `OWNER_DSN`：`pnpm proof:authority` 的 owner DSN。
- `COMMANDER_TASK1_PG_URL`：`pnpm test:task1:postgres` 的 owner/admin DSN；未设置时
  `pnpm test:deploy-gates` 会在 Task 1 live gate 停止。
- G4 还必须提供一个**不同主机/端口/数据库名**且为空的 `RST_DATABASE_URL`，不能
  指向 source：

```bash
export RST_DATABASE_URL='postgres://commander_owner:<restore-password>@<restore-host>:5432/commander_dr'
```

启用 Task 1/TLS 的数据库必须同时注入：
`COMMANDER_DATABASE_TLS_CA_FILE`、`COMMANDER_DATABASE_TLS_CA_MOUNT_IDENTITY`、
`COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256`。没有这三项会得到
`COMMANDER_DATABASE_TLS_CA_FILE_REQUIRED`，不能用关闭 TLS 的本机数据库代替。

## 2. Kind/kubectl context

`scripts/kubernetes-rollback-kind.ts` 将 context 固定推导为
`kind-${COMMANDER_KUBERNETES_CLUSTER}`。CI 统一使用 `cd-ci`，所以唯一合法 context
是 `kind-cd-ci`：

```bash
export COMMANDER_KUBERNETES_CLUSTER=cd-ci
export COMMANDER_KIND_NODE_IMAGE='kindest/node:v1.33.2@sha256:18e6c8f260d51cda4bc32d9f1a4852f9e693c7b667aa14321996ed7c411fc121'

kind create cluster --name "$COMMANDER_KUBERNETES_CLUSTER" \
  --image "$COMMANDER_KIND_NODE_IMAGE" --wait 120s
kubectl --context kind-cd-ci config current-context
kubectl --context kind-cd-ci get nodes -o wide

export COMMANDER_KUBERNETES_WORKER_NAMESPACE=commander
export COMMANDER_KUBERNETES_WORKER_SELECTOR='app.kubernetes.io/component=worker'
export COMMANDER_KUBERNETES_PROOF_NAMESPACE=commander-rollback-proof
```

ARM64 runner 使用 `kindest/node:v1.33.2@sha256:2206121406df04dd321ea04919c7a1a3c3b12220770b4a62dc5e57e2cfab4dad`。
不要再创建 `kind-cd-20260801` 之类未登记的 context；本机此前的该 context 不存在。

## 3. GPG authorized public key

`docs/security/keys-rotation.md` §6.3 当前绑定的 key 指纹为：

```text
full:  09D0DB9C03667BEE
short:               09D0DB9C03667BEE
```

公钥不在仓库中，CI owner 必须通过受保护的 secret/artifact 提供 ASCII-armored
公钥（建议 secret 名 `COMMANDER_GPG_PUBLIC_KEY_ASC`），然后在 runner 上导入并核对
完整指纹：

```bash
printf '%s' "$COMMANDER_GPG_PUBLIC_KEY_ASC" > "$RUNNER_TEMP/commander-signoff-public.asc"
gpg --batch --import "$RUNNER_TEMP/commander-signoff-public.asc"
gpg --batch --fingerprint 09D0DB9C03667BEE
pnpm rotate:verify
```

期望：`verified=4 (min=4), failed=0, pending=0`，退出码为 0。不要把
`.internal/evidence/**/jwks.json` 当成 GPG key；那是应用 receipt 的 Ed25519 JWKS，
用途不同。当前本机状态是 `0/4`，因为 authorized public key 缺失。

## 4. Docker image pull environment

`kind`、`docker` 和 `kind load` 必须指向同一 daemon，并允许访问
`docker.io`、`kindest/node`、`registry.k8s.io`。先在 runner 预拉取并检查 digest：

```bash
docker pull "$COMMANDER_KIND_NODE_IMAGE"
docker pull registry.k8s.io/pause:3.10
docker image inspect "$COMMANDER_KIND_NODE_IMAGE" >/dev/null
```

Helm lifecycle 额外使用仓库脚本中固定 digest 的 Calico/Postgres images；不要把
未 pin 的 `kindest/node:v1.36.1` 作为替代。若企业网络不能直连 registry，应在同一
runner 的镜像缓存或受信任镜像 mirror 中预置**相同 digest**，再运行 `kind load`。

## 5. Retained evidence layout

所有 gate 都写入同一个 run-scoped `$EVIDENCE_ROOT`，不得写到个人 home 目录：

| Gate | 预期保留内容                                                                                                                                                                                        |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G3   | `.superpowers/sdd/authority-closure-proof-latest.json`、`.manifest.json`、`.log.json`、`.evidence.json`、`.source.json`；`$EVIDENCE_ROOT/g3/action-operations/` 下的三个 proof JSON；P0/action 日志 |
| G4   | `$EVIDENCE_ROOT/g4/dr/drill_<id>/dump.dump`、`jwks.json`、`drill-report.json`；`$EVIDENCE_ROOT/g4/rotate.log`                                                                                       |
| G5   | `artifacts/kubernetes-rollback-kind-*.json`、`artifacts/l4-b-cell-smoke-*.json`、`artifacts/l4-b-cell-compensation-e2e-*.json`，复制到 `$EVIDENCE_ROOT/g5/` 后再上传                                |

保留文件必须经过 sanitizer；不得出现 DSN、密码、token、prompt、raw provider
payload、私钥或客户数据。每个 artifact 旁边保留生成 commit、dirty 状态、image
digest、backend/topology、命令和 SHA-256。

## 6. Gate commands and expected products

### G3 - durable authority

```bash
set -o pipefail
(OWNER_DSN="$DATABASE_URL" COMMANDER_KERNEL_DATABASE_URL="$DATABASE_URL" \
  pnpm proof:authority) 2>&1 | tee "$EVIDENCE_ROOT/logs/g3-authority.log"
(DATABASE_URL="$DATABASE_URL" COMMANDER_KERNEL_DATABASE_URL="$DATABASE_URL" \
  pnpm p0:full-loop) 2>&1 | tee "$EVIDENCE_ROOT/logs/g3-p0-full-loop.log"
pnpm proof:action-operations -- --provider github --fault-campaign full \
  --output "$EVIDENCE_ROOT/g3/action-operations"
```

在第三条命令前，CI 必须为 production campaign 提供以下 preflight 变量（密码和
token 只来自 secret）：

```bash
export COMMANDER_ACTION_PROOF_DESTINATION='github://<owner>/<repo>/pulls'
export GITHUB_TOKEN='<github-sandbox-token>'
export COMMANDER_ACTION_PROOF_APP_DATABASE_URL='postgres://commander_app:<password>@<pg-host>:5432/commander'
export COMMANDER_ACTION_PROOF_ADAPTER_OPS_DATABASE_URL='postgres://commander_adapter_ops:<password>@<pg-host>:5432/commander'
export COMMANDER_ACTION_PROOF_OWNER_DATABASE_URL='postgres://commander_owner:<password>@<pg-host>:5432/commander'
export COMMANDER_ACTION_PROOF_GATEWAY_PID='<gateway-pid-or-container-id>'
export COMMANDER_ACTION_PROOF_KERNEL_OPS_PID='<kernel-ops-pid-or-container-id>'
export COMMANDER_ACTION_PROOF_ADAPTER_OPS_PID='<adapter-ops-pid-or-container-id>'
export COMMANDER_ACTION_PROOF_IMAGE='ghcr.io/<org>/<image>@sha256:<64-hex-digest>'
export COMMANDER_ACTION_PROOF_GATEWAY_URL='https://<gateway-host>'
export COMMANDER_ACTION_PROOF_TENANT='<proof-tenant>'
export COMMANDER_ACTION_PROOF_PROTOCOL_VERSION='<protocol-version>'
export COMMANDER_ACTION_PROOF_CONTRACT_VERSION='<contract-version>'
export COMMANDER_ACTION_PROOF_POLICY_VERSION='<policy-version>'
export COMMANDER_ACTION_PROOF_ADAPTER_VERSION='<adapter-version>'
export COMMANDER_SIGNED_EVIDENCE=1
```

期望：authority 为 `ENFORCED passed=true`；P0 日志出现 `RESULT success` 且退出 0；
action-operations 目录包含 `action-operations-proof.json`、
`action-operations-proof.log.json`、`action-operations-proof.evidence.json`，并且
三类 role DSN、三个不同 process/container identity、digest-pinned image、真实
GitHub sandbox 和 `COMMANDER_SIGNED_EVIDENCE=1` 已通过 preflight。当前仓库仍会在
最后一步返回 `ACTION_OPERATIONS_CAMPAIGN_DRIVER_UNAVAILABLE`；driver 接通前没有
G3 PROVEN artifact，不能用 unit/mock 结果替代。

### G4 - evidence, rotation, DR

```bash
set -o pipefail
pnpm rotate:verify 2>&1 | tee "$EVIDENCE_ROOT/g4/rotate.log"
DATABASE_URL="$DATABASE_URL" RST_DATABASE_URL="$RST_DATABASE_URL" \
  COMMANDER_DR_BACKUP_DIR="$EVIDENCE_ROOT/g4/dr" \
  pnpm dr:verify --full 2>&1 | tee "$EVIDENCE_ROOT/logs/g4-dr.log"
```

期望：rotation `verified=4/4` 且退出 0；DR report 为 `overall=PASS`，
`honestyLevel=ENFORCED`、`restore.independent=true`、`rpo.mode=measured`、所有
required lifecycle/evidence booleans 为 true，且 `evidenceReceiptsVerified` 等于
receipt 总数。`drill-report.json` 是唯一结果判定文件；`restore` 模式只能是
`DRAFT`，不能升级为 PASS。

### G5 - governed Kubernetes rollback

当前可执行的 proof ladder 是：

```bash
export COMMANDER_KUBERNETES_PROOF_API_URL='http://<gateway-host>:4000'
export COMMANDER_KUBERNETES_PROOF_TENANT_ID='cell-smoke-tenant'
export COMMANDER_API_KEY='<ci-api-key>'
export COMMANDER_EVIDENCE_JWKS_FILE="$EVIDENCE_ROOT/g5/jwks.json"

pnpm --filter @praetor/action-adapters test
pnpm exec tsx scripts/kubernetes-rollback-kind.ts --mode kind \
  --jwks "$COMMANDER_EVIDENCE_JWKS_FILE" 2>&1 | tee "$EVIDENCE_ROOT/logs/g5-kind.log"
KIND_ARTIFACT="$(find artifacts -type f -name 'kubernetes-rollback-kind-*.json' | sort | tail -1)"
test -n "$KIND_ARTIFACT"
CELL_SMOKE_COMPOSE_UP=1 pnpm cell:smoke -- --mode compose \
  --controlled-change-proof "$KIND_ARTIFACT"
pnpm cell:compensation-e2e -- --mode compose --up \
  --controlled-change-proof "$KIND_ARTIFACT"
```

期望 Kind artifact 的 `verdict=PROVEN`、`remoteOutcome=APPLIED`、
`duplicateWriteCount=0`、`writesDuringReconciliation=0`、
`compensationDisposition=APPLIED`、irreducible unknown 为 `ESCALATED`；两个 cell
artifact 的全部 health/step 为 true。设计文档中的 aggregate 命令
`pnpm benchmark:governed-rollback -- --environment kind --repetitions 100 --output artifacts/governed-rollback`
目前**尚未实现**，不要执行成功声明；实现后必须额外保留 manifest、raw events、
metrics、receipts、verification output、environment manifest 和 hashes。

## Handoff blockers

截至 2026-08-01，本机只具备代码和局部 `ENFORCED` 测试证据：GPG 公钥缺失、没有
`kind-cd-ci` context、DR 需要 TLS CA/SPKI 与独立 restore target、Action Operations
production driver 尚未接通。C/D 只需补齐上述 CI secret/service/registry/context，按本页
命令运行并上传 `$EVIDENCE_ROOT`，不再在本机 VM 网络上重试。
