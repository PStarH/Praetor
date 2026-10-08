# L3-05：一 Run 权威（去双语义）

**状态：PARTIAL（§2 `/v1` kernel-only ENFORCED；§3 WarRoom/ATR 降级守卫 ENFORCED；§4 CLI/`/v1` 历史语义 PARTIAL）**
**范围：Phase 1 Spec → Phase 2 Build → Phase 3 Review & Audit**
**关联：** WS3/L3-06（Gateway `/v1` only）、PRINCIPLES §2/§4、`docs/v2-migration-guide.md` §Dual path

---

## 1. 问题定义与 Thesis

**Thesis：** 唯一 durable run authority = `packages/kernel`（Postgres）。`WarRoomStore` 与 core ATR `RunLedger` 降级为 projection / 非 `/v1` mission UI / worker 本地 settlement，不得静默成为 `/v1` 或企业产品路径的 run 权威。

**安全不变量：**

1. `POST/GET /v1/runs*` 只读写 kernel；kernel 缺失 → HTTP 503 `KERNEL_UNAVAILABLE`（fail-closed），**禁止** WarRoomStore / mission / execution_logs 回退。
2. WarRoom 写入端点不得在企业 profile 下变更 mission 状态并冒充 run 提交面（WS3 §5 已 410）。
3. ATR `RunLedger` 的 SQLite settlement 语义不得被 Gateway `/v1` 路由引用或镜像为第二权威。
4. 企业客户端（SDK `CommanderGatewayClient`）与 Gateway `/v1` 共享 contracts `RunState`；CLI Local SKU 路径在收敛前必须被显式标注为 **非** `/v1` 权威。

---

## 2. 现状审计：dual surfaces（一手证据）

| Surface | 路径 / 模块 | 角色 | `/v1` 权威？ | 证据 |
|---|---|---|---|---|
| **Kernel Postgres** | `packages/kernel` → `v1GatewayKernel.ts` | Durable runs/steps/events | **是（canonical）** | `index.ts:542-545` 挂载 `createV1GatewayRouter(getV1KernelGateway)` |
| **V1 Gateway handlers** | `v1GatewayEndpoints.ts` | 调度 + 查询，不执行 Agent | **是（唯一 HTTP 提交面）** | 全路由 `resolveKernel()`；无 `store` import |
| **WarRoomStore** | `apps/api/src/store.ts` | missions + execution_logs UI | **否** | `store.ts:1031-1032`；enterprise 写入 410（`warRoomDemotion.test.ts`） |
| **WarRoom /v1 只读** | `projectEndpoints.ts` `{ readOnly: true }` | 运维快照 | **否（projection）** | `index.ts:557-561` |
| **WarRoom `/v1/.../run-context`** | `projectEndpoints.ts` | 从 WarRoom 组装 UI 上下文；无 query `runId` 时**合成** `projectId-timestamp` | **否（非 kernel；易与 `/v1/runs/:id` 混淆）** | `projectEndpoints.ts` runMeta；enterprise 仍可达 |
| **ATR RunLedger** | `core/src/atr/runLedger.ts` | Worker 本地 settlement / idempotency | **否（V1 路径零引用）** | `apps/api` 无 `runLedger` import；状态机与 contracts 不同（§4） |
| **ATR Scheduler listRuns** | `core/src/atr/scheduler.ts` | 进程内 ATR 运行列表 | **否** | 仅 core/ATR HTTP；非 Gateway `/v1` |
| **Gateway saga/replay/pipeline runs** | `sagaEndpoints` / `replayEndpoints` / `pipelineEndpoints` | 本地 saga / 回放 / legacy pipeline | **否** | enterprise `/api/*` 410；standard 仍可达 |
| **`/v2/runs*` bench** | `v2/v2BenchEndpoints.ts` | 内存 benchmark ledger | **否** | standard profile；非 durable |
| **CLI saga listRuns** | `cli/commands/saga.ts` | `.commander/sagas/` 文件快照 | **否** | 本地 saga 存储，非 kernel |
| **CLI history** | `cli/commands/history.ts` | `StateCheckpointer` 本地 session | **否** | 非 kernel |
| **CLI intentLog** | `runtime/intentLog.ts` | 调试 intent 索引 | **否** | `debug.ts` 专用 |
| **Legacy execute** | `legacyExecutionGuard` 保护路径 | 进程内 AgentRuntime | **否（默认 OFF）** | `PRINCIPLES.md` §2 |

**已关闭的 gap（L3-06 / 既有）：**

- Production 拒绝无 kernel 启动（`index.ts:857-876`）。
- `/v1` 全路由 kernel-null → 503（`v1GatewayEndpoints.test.ts:98-103`）。
- Enterprise profile WarRoom 写入 410（`warRoomDemotion.test.ts`）。

**残余 gap（本 spec 标记 PARTIAL，不假装已统一）：**

- CLI `commander run` / saga / history / ATR 仍使用 core 本地存储与 **不同** RunState 词汇（ATR: `EXECUTING`/`COMMITTED` vs contracts: `RUNNING`/`SUCCEEDED`）。
- `GET /v1/projects/:id/run-context` 合成非 kernel `runId`（UI 上下文；不得当作 `GET /v1/runs/:id` 权威）。
- WarRoomStore 在 standard profile 仍可写 mission（x-legacy），与 kernel run 无自动投影。
- RunLedger 仍在 worker/agent 路径作为 settlement 层存在（正确角色，但非零 flag durable）。
- Gateway `/api/saga|replay|pipeline/runs*` 与 `/v2/runs*`（bench）在 standard 仍为独立 run 面。

---

## 3. 降级方案与 ENFORCED 子集

### 3.1 `/v1` — kernel-only（ENFORCED）

| 场景 | 行为 | 错误码 |
|---|---|---|
| kernel 未初始化 / disabled | 503 | `KERNEL_UNAVAILABLE` |
| Production + `COMMANDER_KERNEL_ENABLED=0` | 启动拒绝 | boot error |
| Production + 无 DSN / gateway null | 启动拒绝 | boot error |
| Idempotency 冲突 | 409 | `IDEMPOTENCY_KEY_CONFLICT` |

**禁止：** `v1GatewayEndpoints.ts` / `v1GatewayKernel.ts` import `./store` 或 `WarRoomStore`；`/v1/runs` 处理器内 `new AgentRuntime`。

### 3.2 WarRoom — mission UI projection（ENFORCED demotion）

- Enterprise：写入端点 410 + `x-legacy`（WS3）。
- `/v1` 子树：`readOnly: true`，无 POST/PATCH mission（`warRoomDemotion.test.ts`）。
- `/ready`：WarRoom 仅 `degraded` 探针，不作 hard gate（`healthProbes.ts`）。

### 3.3 ATR RunLedger — worker settlement only（ENFORCED boundary）

- Gateway `apps/api` **不得** import `runLedger` / `RunLedger`。
- 模块头注释声明：非 `/v1` durable run authority；权威在 kernel Postgres。
- ATR `RunState` 与 `@praetor/contracts` `RunState` 并存视为 **已知双轨**（§4），不得新增 Gateway 路由读取 ATR ledger 作为 run 历史。

---

## 4. CLI / SDK / `/v1` 历史语义

### 4.1 ENFORCED（已对齐）

| 客户端 | 入口 | 状态词汇 | 持久化 |
|---|---|---|---|
| SDK `CommanderGatewayClient` | `POST/GET /v1/runs*` | contracts `RunState` | kernel（远端） |
| Gateway `/v1` | 同上 | `renderRun().state` from kernel | kernel |

**证据：** `packages/sdk/src/v1/client.ts`；`v1GatewayEndpoints.ts` 使用 `isTerminalRunState` from contracts。

### 4.2 PARTIAL（残余 dual surfaces — 诚实清单）

| 客户端 | 入口 | 状态词汇 | 与 `/v1` 关系 |
|---|---|---|---|
| CLI `commander saga` | 本地 `.commander/sagas/` | saga snapshot `state` | 独立；非 kernel |
| CLI `commander debug intent` | `intentLog` | ad-hoc | 调试 only |
| ATR scheduler / RunLedger | `.commander/atr_ledger.db` | ATR `RunState`（EXECUTING/COMMITTED/…） | worker settlement；**非** Gateway 历史 |
| WarRoom missions | JSON/SQLite war-room | mission `status` | UI board；非 run id 空间 |

**收敛 follow-up（不在本 PR）：** CLI enterprise 子命令或 `commander runs` 薄包装调用 SDK `/v1`；ATR→kernel 投影或删除 ATR run 表对外 API。

---

## 5. 测试计划

### Phase 2 Build

1. `apps/api/test/oneRunAuthority.test.ts` — `/v1` 无 WarRoom 回退、源码边界、SDK 路径、kernel wiring。
2. `packages/core/tests/architecture/oneRunAuthority.invariants.test.ts` — RunLedger demotion 注释、CLI SKU 诚实、migration guide dual path。
3. 接入 `pnpm test:arch` 与 `apps/api` test suite。

### Phase 3 Audit

- [x] §3.1 `/v1` 源码不引用 WarRoomStore；kernel-null → 503。
- [x] §3.2 enterprise WarRoom 写入 410（继承 WS3 测试）。
- [x] §3.3 `apps/api` 无 RunLedger import。
- [x] §4.1 SDK 调用 `/v1/runs` + contracts 状态。
- [~] §4.2 CLI/ATR dual surfaces 文档化 + 测试断言 **PARTIAL**（不假装已统一）。

---

## 6. 验收清单

- [x] §2 dual surfaces 审计表完成。
- [x] §3.1 `/v1` kernel-only ENFORCED（`oneRunAuthority.test.ts` + 既有 `v1GatewayEndpoints.test.ts`）。
- [x] §3.2 WarRoom demotion ENFORCED（继承 `warRoomDemotion.test.ts`）。
- [x] §3.3 ATR/Gateway 边界 ENFORCED（architecture + api 测试）。
- [~] §4 CLI/`/v1` 同历史语义 — **PARTIAL**（SDK/Gateway ENFORCED；CLI saga/ATR/intent 列明残余）。
- [x] `docs/v2-migration-guide.md` §Dual path 与 spec 一致。
- [x] 主仓 gitignored 状态笔记 `.internal/docs/status/2026-07-17-l3bc-loop-state.md` 标记 L3-05 **DONE (PARTIAL)**（不进版本控制；worktree 可能另有副本）。

---

## 7. 不在范围

- 删除整个 WarRoom UI 或 ATR RunLedger（L3-C 后续）。
- CLI `commander runs submit` 新子命令（WS8 / L4 follow-up）。
- WarRoom→kernel 自动投影 pipeline。
