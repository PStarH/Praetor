# L3-01 / WS0：立宪收口（Contracts Constitution Close-Out）

**状态：PARTIAL（WS0 可执行子集 ENFORCED；V1 整包债务与命名规则仍为 PARTIAL）**
**范围：Phase 1 Spec → Phase 2 Audit → Phase 3 Verification**
**分支策略：** `feat/l3-*` 集成分支在对应 spec 标注 ENFORCED 子集绿 + 本 spec Phase 3 证据齐全后方可合入 `master`；不得 force-push `master`；WS0 不得假标 ACCEPTED。

> WS0 主体已于 2026-07-15 在 `master` 落地（见 `PRINCIPLES.md` changelog）。L3-01 是**收口审计**：补齐 CI 诚实性、arch-guard 与 architecture-gate 配置同步、contracts freeze 文档与测试，并如实标注仍为债务的部分。

---

## 0. 依据

| 来源 | 约束 |
|---|---|
| `PRINCIPLES.md` §1 | `@praetor/contracts` 为零内部依赖叶节点 |
| `PRINCIPLES.md` §5 / §6 | 禁止 resurrect `control-plane` / `orchestration` 等工作区 package role |
| `PRINCIPLES.md` changelog 2026-07-15 | WS0 折叠 `@praetor/control-plane` → `packages/contracts/src/controlPlane.ts` |
| `scripts/arch-guard.sh` | V2 包图、import 方向、删除包引用、循环依赖 |
| `scripts/architecture-gate.config.json` | worker→core 桥接白名单（与 arch-guard **必须同步**） |
| `packages/contracts/snapshots/contract-snapshot.baseline.json` | 公开契约面 breaking-change 基线 |

---

## 1. ENFORCED vs PARTIAL 矩阵

| 不变量 | 状态 | 证据 |
|---|---|---|
| `packages/control-plane` 目录不可 resurrect | **ENFORCED** | `arch-guard.sh:14-15,83-85`；`architectureV2.invariants.test.ts:87`；fixture `arch-guard.test.ts` |
| `packages/orchestration` 目录不可 resurrect | **ENFORCED** | 同上 forbidden package pattern |
| 新建 `*orchestrator*` / `*security*` workspace package role | **ENFORCED** | `arch-guard.sh:14`；fixture tests |
| 源码 / manifest / lockfile 引用 `@praetor/control-plane\|orchestration` | **ENFORCED** | `arch-guard.sh:189-191,221-234`；fixture tests |
| `@praetor/contracts` 零内部 workspace 依赖 | **ENFORCED** | `arch-guard.sh:133-135`；`packages/contracts/package.json` |
| V2 包依赖方向（contracts→kernel→…） | **ENFORCED** | `arch-guard.sh:17-40,128-147` |
| V2 实现包（kernel/effect-broker/operations）禁止 import core | **ENFORCED** | `arch-guard.sh:215-217` |
| worker-plane→core 仅允许配置白名单桥接文件 | **ENFORCED** | `architecture-gate.config.json` `v2ImportExceptions`；`arch-guard.sh` 读取同一列表 |
| control-plane 类型 canonical 在 contracts | **ENFORCED** | `packages/contracts/src/controlPlane.ts`；`controlPlane.test.ts`；core 再导出测试 |
| contracts 公开面 breaking-change 冻结 | **ENFORCED** | `pnpm contract:check`；`contracts.test.ts` baseline drift test；CI step |
| CI 运行 arch-guard + arch-guard:test | **ENFORCED** | `.github/workflows/ci.yml:257-263`；`architectureV2.invariants.test.ts` |
| 禁止 wholesale `@praetor/core` barrel（apps/api 等） | **PARTIAL** | `PRINCIPLES.md` §1 gap；`architecture-gate.config.json` legacyImportExceptions 显式清单 |
| V1 模块/类 ambition 命名（ultimate/telos/hub…） | **PARTIAL** | `PRINCIPLES.md` §5；无 lint gate |
| §3 duplication count 上限 | **ENFORCED**（增长天花板） | `duplicationCountGuard.test.ts` — 独立 WS0 外但同 CI `test:arch` |

---

## 2. worker-plane→core 桥接诚实说明

WS0 允许 **显式列举** 的 worker-plane 文件 import `@praetor/core`（非 silent 扩张）：

1. `workerRuntimeAdapter.ts` — V1 runtime 执行桥（strangler）
2. `llmBrokerBridge.ts` / `llmBrokerBridge.test.ts` — WS2 LLM provider 类型与 EffectBroker 包装（type-only + invoke registry）

任何新增 worker→core 导入必须同时更新 `v2ImportExceptions` **且** 通过 `pnpm arch:guard`；不得仅改 gate 或仅改 guard。

---

## 3. Contracts freeze 故事

1. **Canonical 类型**：identity/policy/audit/sandbox 在 `packages/contracts/src/controlPlane.ts`，由 `packages/contracts/src/index.ts` 导出。
2. **Snapshot 基线**：`packages/contracts/snapshots/contract-snapshot.baseline.json` 记录 resources / run+step states / error codes / schema names。
3. **Breaking 定义**：仅 **删除**（resource/state/error/schema）算 breaking；新增字段/枚举值不算，需 `--update-baseline` 刷新。
4. **本地命令**：
   - `pnpm contract:check` — PR/CI 门禁
   - `pnpm contract:snapshot --update-baseline` —  intentional breaking 后刷新
5. **测试层**：
   - `packages/contracts/src/contracts.test.ts` — baseline drift
   - `packages/contracts/src/openapi-conformance.test.ts` — snapshot stability
   - `scripts/contract-snapshot-check.ts` — CLI 入口

---

## 4. 集成分支策略（诚实）

- L3 工作流使用 **isolated worktree + `feat/l3-XX-*` 分支**，base `master`。
- 合入条件：本 spec ENFORCED 行全部有 CI/测试证据；PARTIAL 行不得写为 ACCEPTED。
- WS0 **不阻塞** WS2/WS3 等后续 WS，但后续 WS spec 引用 WS0 时必须链接本文件而非已删除的 `.internal/spec/ws0-*`（若 internal 副本不存在，以 `spec/l3-01-ws0-constitution.md` 为准）。
- `COMMANDER_SKIP_PRECOMMIT=1` 仅用于 agent 迭代；合入前应跑 `pnpm arch:guard`、`pnpm contract:check`、`pnpm --filter @praetor/contracts test`。

---

## 5. Phase 3 验收清单

- [x] `pnpm arch:guard` 绿（真实仓库，非仅 fixture）
- [x] `pnpm arch:guard:test` ≥7 fixture cases（含 deleted package / bridge 负例）
- [x] `pnpm contract:check` 绿 + CI wired
- [x] `packages/contracts` baseline drift test
- [x] `architecture-gate.config.json` 与 `arch-guard.sh` 共享 `v2ImportExceptions`
- [x] loop state 更新 L3-01 DONE（可执行子集；非 ACCEPTED 整包；状态笔记在 gitignored `.internal/`）
- [x] InMemoryKernelRepository 仅经 `@praetor/kernel/testing/inMemoryRepository` 导出（禁止主 barrel）
- [ ] V1 core barrel 退役 — **超出 WS0 范围，保持 PARTIAL**
- [ ] `pnpm arch:gate` 整绿 — **PARTIAL**（WS3/WS1 遗留；CI 对该步 `continue-on-error`，不以假绿冒充 ACCEPTED）

---

## 6. 变更日志

- **2026-07-17 (L3-01 close-out)** — 修复 master 上 arch-guard 对 `llmBrokerBridge` / `bootstrap.policy.test.ts` 的误报路径；guard 读取 gate config 白名单；CI 补 `contract:check`；补 spec 与 baseline drift 测试。
