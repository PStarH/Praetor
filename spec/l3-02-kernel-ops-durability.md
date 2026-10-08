# L3-02：Kernel ops 耐久（reclaim / timer / outbox / compensation）

**状态：DONE**
**范围：Phase 1 Spec → Phase 2 Build → Phase 3 Review & Audit**
**分支：** `feat/l3-02-kernel-ops`（base `master` @ a9d2cf9a）

## 0. Done when（来自分层计划）

| 条目 | 含义 |
|------|------|
| D1 | reclaim + timer + outbox + compensation **始终开启**于生产 ops 路径 |
| D2 | write-path transition validation 在缺失处补齐 |
| D3 | pause tenant scope 在缺失处补齐 |
| D4 | `/ready` 证明 ops loops 存活，而非仅 process + `SELECT 1` |
| D5 | compose / production 路径运行 ops；存在非测试 caller |
| D6 | 测试绿；证据标签 EXISTS / WIRED / ENFORCED / PROVEN |

## 1. 当前差距（Phase 1 审计）

| Done when | 现状 | 差距 |
|-----------|------|------|
| D1 | `main.ts` 已 wiring 四组件；`KernelOpsRuntime` 中 `compensation?` 可选 | compensation 应 required；outbox 无独立 health |
| D2 | `postgres.ts` write path 已调用 `assertRunTransition` / `assertStepTransition`（claim/complete/fail/reclaim/pause/finishRun） | **无差距** — 不新增 |
| D3 | `pauseTenant` 已实现 tenant-scoped pause + integration test | **无差距** — 不新增 |
| D4 | `/ready` 仅查 `compensation.isHealthy()` + `SELECT 1` | reclaim / timer / outbox 未纳入 readiness |
| D5 | `docker-compose*.yml`、`helm/kernel-ops-deployment.yaml`、`Dockerfile.ops`、`start:ops` | **已 WIRED** — 不新增 topology |
| D6 | 各 daemon 单测存在；缺统一 readiness 验收 | 需 opsRuntime + daemon health 测试 |

## 2. 非目标

- 不引入新分布式协调（无 leader election、无新 broker topology）
- 不改 EffectBroker / worker 执行路径
- 不扩展 `/ready` JSON schema 为多组件诊断面板（boolean fail-closed 足够）
- 不重写 `postgres.ts` 已有 transition / tenant-pause 逻辑
- 不 push / 不 merge master

## 3. 具体文件变更

| 文件 | 变更 |
|------|------|
| `packages/kernel/src/ops/reclaimDaemon.ts` | `started` + `lastOkAt` + `isHealthy()` |
| `packages/kernel/src/ops/timerWakeupWorker.ts` | 同上；`start()` 立即 tick（与 reclaim 对齐） |
| `packages/kernel/src/ops/opsRuntime.ts` | `compensation` required；`lastOutboxOkAt`；`isReady()` |
| `packages/kernel/src/ops/main.ts` | `/ready` → `runtime.isReady()` + DB ping |
| `packages/kernel/src/ops/*.test.ts` | health / readiness 验收 |
| `spec/l3-02-kernel-ops-durability.md` | 本文件 |
| `.internal/docs/status/2026-07-17-l3bc-loop-state.md` | L3-02 DONE + SHAs + 证据 |

## 4. 验收测试

1. **ReclaimDaemon**：start 后首次 tick 成功 → `isHealthy()` true；stop 后 false
2. **TimerWakeupWorker**：同上
3. **KernelOpsRuntime**：四 loop mock 均 healthy → `isReady()` true；任一 stale → false
4. **KernelOpsRuntime**：缺少 compensation 构造应 type-error（required field）
5. **现有测试套件**：`pnpm --filter @praetor/kernel test` 全绿

## 5. 风险

| 风险 | 缓解 |
|------|------|
| `/ready` 在首 tick 完成前 503（K8s 慢启动） | helm/docker 已有 `start_period` / `initialDelaySeconds` |
| outbox publish 空 batch 仍算成功 tick | publish resolve 即更新 `lastOutboxOkAt`（空 outbox 仍证明 loop 存活） |
| Timer 初始 tick 与 interval 重叠 | 沿用 reclaim 的 inFlight 去重 |

## 6. Spec audit

**Verdict: APPROVE**

- Done when D2/D3 经代码审计已满足，spec 明确 out-of-scope，无 scope creep
- D4 通过统一 `isReady()` 闭环，不发明新 health 子系统
- 验收测试覆盖四 loop + type-level compensation required
- 无与项目 thesis（Local-first、minimal diff）矛盾之处

**Phase 3 代码审计（实施后）**

- P1/P2：无 — 已修复测试中对 `isHealthy()` 需 `start()` 生命周期的断言
- P3 residual：
  - `docker-compose.yml` kernel-ops healthcheck 仍探测 `/health` 非 `/ready`（pre-existing；helm readiness 已用 `/ready`）
  - `main.ts` compensation 为 probe-only（非 EffectBroker 全 drain），符合 WS2 边界
  - `/ready` JSON 不暴露 per-loop 诊断字段（spec 非目标）

**最终状态：DONE（honest subset）**
