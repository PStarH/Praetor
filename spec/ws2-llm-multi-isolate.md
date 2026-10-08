# WS2 Follow-up：LLM Invoke 多 Isolate / 多 Worker 派发（方案 C）

**状态：C-α IMPLEMENTED（M1 on `feat/ws2-llm-c-alpha`；C-β/C-γ 仍 follow-up）**  
**日期：2026-07-17**  
**上游：** `spec/ws2-effect-monopoly.md` §1（LLM 出口 PARTIAL；进程内 `LLM_INVOKE_REGISTRY` 为已知遗留）  
**非目标（本轮不做实现，只定计划）：** 不改动生产默认路径；评审通过后再开实现 PR。  
**评审：** 安全/多租户 · 分布式 · WS2 架构 — 三路一致 **APPROVE_WITH_CHANGES**；共识见 §10–§11。

---

## 0. 问题陈述

今日路径（`packages/worker-plane/src/llmBrokerBridge.ts`）：

1. `wrapProviderWithEffectBroker` 在 **admit 前** 把 `() => provider.call(frozenRequest)` 放进进程全局 `Map`（`LLM_INVOKE_REGISTRY`），键为 `effectId`。
2. `EffectBroker.execute` → `EffectExecutor` → `dispatchLlmEffect` 用 `effectId` 取回调并执行。
3. Ledger / capability request 只存 `contentHash` + 元数据，**不存 prompt**（DLP）。

失效条件：

| 场景 | 结果 |
|------|------|
| 同进程多租户并发 | 仅靠 UUID；无 `tenantId` 键控 / 校验，隔离靠运气 |
| `admit` 与 `executeAdmitted` 跨 ALS / 延迟执行 | 回调可能已删或 ALS 丢失 |
| execute 被调度到 **另一 isolate / worker** | registry miss → LLM 永久失败 |
| Worker 崩溃后 replay | 无本地回调；只能依赖幂等/缓存 response，不能重放 provider.call |

方案 A/B（同进程租户键控 / 拆分 admit-execute）不能覆盖跨 worker。**方案 C** 要让 `llm.*` 在多 isolate、多 worker、多租户下仍满足 WS2「唯一出口」且不把 prompt 写上 ledger。

---

## 1. 目标与非目标

### 1.1 目标

1. **Affinity（粘性）**：`llm.*` 的 `execute` 必须在持有 invoke 能力的同一 worker/isolate 上发生，或走显式密封通道（见 §3）。
2. **Multi-tenant fail-closed**：注册、查找、执行全程携带并校验 `tenantId`（与 capability grant / lease 一致）；跨租户 lookup 拒绝。
3. **DLP 不退化**：raw messages / tools args **不得**进入 effect ledger、audit 明文、OTel gen_ai.*；跨节点传输须密封 + 短 TTL + 租户密钥域。
4. **与现有合约对齐**：仍走 `EffectBroker.admit` → execute → `completeEffect`；`requireRequestBinding` + `contentHash` 保留；默认 `llm.*` allow + 工具 deny-default 不变。
5. **可观测与可回滚**：miss / tamper / affinity 违反有明确错误码；可 kill-switch 回退「同进程 only」。

### 1.2 非目标

- 不把 LLM provider 凭证集中到 control-plane 代调用（避免变成第二出口）。
- 不在本设计中重做 API/Gateway LLM 路径（仍为独立 follow-up）。
- 不要求跨 region 的 prompt 热迁移；崩溃后允许 **不可重放 provider.call**（用 UNKNOWN / 幂等 cached response 处理）。

---

## 2. 约束（硬）

来自仓库既有合约：

- ADR 005 / WS2：外部副作用唯一 PEP = EffectBroker。
- PII / DLP：ledger 仅 `contentHash`；Authorization 永不进明文日志。
- Lease + fencing：step 执行绑定 `workerId` + `fencingEpoch`。
- Capability：call-time mint，`requestHash` 绑 admitted body（含 `effectId` + `contentHash`）。
- Local-First：优先复用 kernel / outbox / lease，不引入新的「全局共享裸 Map」跨进程幻想。

---

## 3. 方案树（C 内部三种形态）

### C1 — Execute Affinity（推荐主路径）

**思想：** 不把闭包搬走；把 **execute 粘回注册方**。

```text
Worker-A (holds frozenRequest + provider)
  wrap.call → register local (tenant-scoped)
           → broker.admit (durable ledger: metadata+hash only)
           → broker.executeAdmitted  【强制同进程 / 同 lease.workerId】
           → dispatch → provider.call
           → completeEffect
```

规则：

- `llm.*` **禁止**「admit 在 A、execute 在 B」。
- `executeAdmitted` 校验：`admission.lease.workerId === localWorkerId` 且 fencing 有效；否则 `LLM_AFFINITY_VIOLATION`（fail-closed）。
- 进程内 registry 升级为 **tenant-scoped**：键 `` `${tenantId}:${effectId}` ``，dispatch 时再校验 grant.tenantId。
- 同进程 `broker.execute`（admit+execute 一体）天然满足；拆分 API 时调用方必须 sticky。

**优点：** 无 prompt 出进程；改动面小；与 lease 模型一致。  
**缺点：** 不能把 LLM execute 卸载到专用 inference worker（除非该 worker 自己 wrap+admit+execute）。

### C2 — Sealed Invoke Envelope（跨节点例外通道）

**思想：** 当必须跨 isolate 时，传输 **密封信封**，不是明文 registry。

```text
Worker-A: seal(payload) → 短 TTL 对象（内存 / 租户 scoped store）
Control / Worker-B: execute 仅带 sealRef + contentHash
Worker-A 或持钥方: unseal → verify contentHash → provider.call
```

密封要求：

- AEAD（租户密钥或 worker 配对密钥）；AAD = `tenantId|effectId|contentHash|exp`。
- TTL ≤ capability TTL（建议 ≤ 60s）；单次 unwrap（one-shot）。
- Store 键必须含 `tenantId`；跨租户 get → 拒绝。
- **禁止**把 plaintext prompt 写入 Postgres effect 行 / audit details。

**优点：** 支持「admission 中心化、invoke 仍受控」。  
**缺点：** 新密钥与 store 生命周期；攻击面上升；实现与运维成本高。

### C3 — Inference Worker 自持 Broker（拓扑约束）

**思想：** LLM 只在「有 provider + broker」的 worker 上完整走 admit→execute；调度器把 **agent step** sticky 到该类 worker，而不是拆 effect。

```text
Scheduler: step.kind=agent → claim 到 llm-capable pool（标签）
Worker: 全链路本地 registry / C1
```

**优点：** 与 C1 正交，几乎无协议变更。  
**缺点：** 依赖调度/池标签；混部 worker 时需拒绝无 provider 的 claim。

---

## 4. 推荐组合

**Phase C-α（必做）：C1 + 租户键控 registry + affinity 校验**  
覆盖：多租户同进程、admit/execute 拆分误用、误调度到他 worker。

**Phase C-β（可选）：C3 调度粘性**  
覆盖：多 pool / 专用 inference 节点，无需密封通道。

**Phase C-γ（仅在有跨节点 execute 硬需求时）：C2**  
默认 **不开**；用 feature flag + 安全评审门禁。

回退开关：`COMMANDER_LLM_INVOKE_MODE=local-affinity|sealed|disabled`  
- unset / `local-affinity`：C-α 本地 registry。  
- `disabled` / `sealed` / 未知值：构造期 fail-closed（C-γ 未落地前禁止静默降级）。

---

## 5. 多租户与「其他部分」对齐点

| 组件 | 对齐动作 |
|------|----------|
| `LlmEffectAuth` / ALS | 注册条目绑定 `tenantId, runId, stepId, workerId, contentHash`；dispatch 全量比对 |
| Capability grant | `grant.tenantId` 必须 = registry entry.tenantId，否则 `TENANT_MISMATCH` |
| `EffectBroker` admissionStore | **进程内、非权威**（权威 = kernel ledger）；与 LLM registry 共享「split admit/execute = 同 worker」不变量；**禁止**对 `llm.*` 做跨进程 admission rehydrate 后 execute |
| Kernel ledger | 继续只存 metadata+hash；complete 写 response 摘要（已有 DLP 规则） |
| Lease / fencing | affinity 校验全集：`workerId` + `fencingEpoch` + `lease.token` + `workerGeneration`（对齐 kernel `live()`）；失效 → 拒执行 |
| Broker `localWorkerId` | 构造注入（来自 bootstrap `COMMANDER_WORKER_ID` / worker 注册）；`executeAdmitted` 入口比对 |
| `tenantContext` | wrap/dispatch 可选 assert 与 ALS tenant 一致（多租户开启时） |
| Outbox / compensation | LLM 通常无补偿；若未来有，不得假设 registry 仍在 → UNKNOWN 路径 |
| API/Gateway LLM | 本 spec 不实现；但其未来接入必须复用同一 affinity 合约，禁止第二套全局 Map |

---

## 6. 错误码（建议）

| Code | 层 | 何时 |
|------|----|------|
| `WORKER_AFFINITY_VIOLATION` | broker `executeAdmitted` | lease worker / fencing 与 `localWorkerId` 不一致（全类型；admission 在但 worker 错） |
| `ADMISSION_NOT_FOUND` | broker | 本进程从未 admit 或 admission 已 consume |
| `LLM_INVOKE_MISS` | bridge | 本地 registry 无条目或已 one-shot 消费 |
| `LLM_INVOKE_EXPIRED` | bridge | registry 条目超过 `expiresAt`（consume 后拒） |
| `LLM_TENANT_MISMATCH` | bridge | grant/registry/ALS tenant 不一致 |
| `LLM_CONTENT_HASH_MISMATCH` | bridge | invoke 前 hash 漂移 |
| `LLM_LEASE_MISMATCH` | bridge | registry 与 dispatch 的 fencingEpoch / leaseToken 不一致 |
| `LLM_SEAL_EXPIRED` | C2 only | 密封信封过期 |
| `LLM_INVOKE_MODE_DISABLED` | wrap 构造期 | `disabled` / `sealed` / 未知 mode |

优先级：admission → worker affinity → tenant/registry → invoke。全部 fail-closed；不重试到随机 worker。

---

## 7. 数据形状（C-α）

```ts
type LlmInvokeKey = `${string}:${string}`; // tenantId:effectId

interface LlmInvokeEntry {
  tenantId: string;
  effectId: string;
  runId: string;
  stepId: string;
  workerId: string;
  fencingEpoch: number;
  leaseToken: string;
  contentHash: string;
  /** one-shot */
  invoke: () => Promise<LLMResponse>;
  expiresAt: number;
}
```

- Registry **模块私有** + 测试 hook；禁止从 `@praetor/worker-plane` 公开导出可变 Map。
- `tenantId` **只**来自 `admission.grant`（经 optional `executionContext`），禁止从 `request` 读取。
- **One-shot：** `dispatchLlmEffect` 在 invoke **前** delete entry；wrap 的 `finally` 仅作泄漏清理。
- `expiresAt` ≤ capability TTL；定期 sweep 防 prompt 闭包常驻。

**API 演进（最小，不改 `EffectExecutor` 公共强制签名）：**

1. `EffectBroker` options/构造注入 `localWorkerId`（+ optional `localWorkerGeneration`）。
2. `executeAdmitted`：对**全部**类型校验 lease ↔ local worker；对 `llm.*` 额外经 bridge 租户+registry。
3. `executor.execute` 增加 **optional** `executionContext?: { tenantId, workerId, workerGeneration?, effectId }`（向后兼容）。
4. worker-plane bootstrap 闭包调用 `dispatchLlmEffect({ ..., tenantId, workerId })`。

---

## 8. 测试计划（评审后实现）

1. **单测：** 租户 A 注册、租户 B 同 effectId（或伪造 request.tenantId）→ `LLM_TENANT_MISMATCH`。
2. **单测：** 注册 workerId=w1，dispatch 声明 w2 → `LLM_AFFINITY_VIOLATION`。
3. **单测：** one-shot 二次 dispatch → `LLM_INVOKE_MISS`。
4. **单测：** contentHash 漂移 → 既有 tamper 错误。
5. **集成：** `broker.execute` 同进程多租户并发 N 路无串扰。
6. **负面：** `admit` 后跨进程 `executeAdmitted`（模拟）→ affinity 拒绝，而非 registry miss 含糊错误。
7. **门禁：** 生产源码不得再出现未租户键控的 `LLM_INVOKE_REGISTRY.set`。

---

## 9. 里程碑

| 里程碑 | 交付 | 退出标准 |
|--------|------|----------|
| M0 | 本 spec 评审通过（swarm + 人工） | 无未裁决的开放问题阻塞 C-α |
| M1 | C-α 实现 + 测试 | §8.1–8.5 绿；ws2-effect-monopoly §1 状态更新 |
| M2 | C-β 调度标签（若需要多 pool） | agent step 不会 claim 到无 LLM wrap 的 worker |
| M3 | C-γ 设计冻结或明确 WONTFIX | 若做：威胁模型 + 密钥 runbook；默认关 |

---

## 10. 开放问题 — Swarm 裁决（已闭合）

| # | 问题 | 裁决 |
|---|------|------|
| 1 | Executor 扩展 vs llm 子接口 | **不改强制签名**；optional `executionContext` + bootstrap 闭包；`tenantId` 仅来自 grant |
| 2 | AdmissionStore 文档 | **本 spec §5 硬约束** + monopoly 交叉引用；不另开 WS2 章 |
| 3 | C2 存储默认 | **进程内 one-shot**；C-γ 默认 **WONTFIX**；Redis 仅显式 opt-in |
| 4 | 崩溃 in-flight | **`COMPLETION_UNKNOWN` / `COMPLETION_UNCONFIRMED`**；禁止同 effectId 重放 provider.call；客户端 **新 effectId + 新 idempotencyKey** |
| 5 | 全类型 vs 仅 llm affinity | **Broker 层**：全部 `executeAdmitted` 做 lease↔localWorker 校验；**Bridge 层**：tenant+registry **仅 `llm.*`** |

---

## 11. 冻结范围（M1）

1. **只做 C-α**；C-β = M2（M1 写清运维 invariant：agent worker 必须带 broker+wrap）；C-γ = 默认 WONTFIX。
2. Affinity gate 在 **`executeAdmitted` 入口**（先于 executor）；错误用 `WORKER_AFFINITY_VIOLATION`。
3. Registry 租户键控 + one-shot-at-dispatch + 私有化导出。
4. 崩溃 → UNKNOWN；幂等仅返回已 COMPLETED 的 cached response。
5. C2 若未来启用：unseal **仅**在 broker 调度的 executor 回调内；禁止 Postgres effect 行存 plaintext。
6. Registry 是 EffectExecutor 实现细节，**不是**第二 PEP。

---

## 12. 验收定义（C-α Done）

- [x] 无跨租户 invoke（测试证明）；`tenantId` 不可从 request 伪造
- [x] 跨 worker `executeAdmitted` → `WORKER_AFFINITY_VIOLATION`（非含糊 miss）；affinity 失败 consume admission（不泄漏）
- [x] one-shot 二次 dispatch → `LLM_INVOKE_MISS`
- [x] `LLM_INVOKE_REGISTRY` 不再从 package 公开导出
- [x] ledger / audit 仍仅 metadata+contentHash（既有 bridge 行为保留）
- [x] `COMMANDER_LLM_INVOKE_MODE`：仅 `unset|local-affinity` 建 wrap；`disabled|sealed|未知` 构造期 fail-closed
- [x] registry `expiresAt` 在 dispatch 校验（过期 → `LLM_INVOKE_EXPIRED` + 删除）
- [x] `ws2-effect-monopoly.md` §1 分层状态 + 链到本 spec；AdmissionStore 注释去掉「distributed reload」误导
- [x] §8.5 多租户并发隔离（`Promise.all` 三租户）
- [x] UNKNOWN + 新 effectId 重试：`COMPLETION_UNCONFIRMED` 后同 effectId → `LLM_INVOKE_MISS`；新 effectId 可重试
- [x] affinity 校验 `fencingEpoch` + `lease.token`（结构 fail-closed）+ registry/dispatch 比对；bootstrap `onRegistered` → `bindLocalWorkerGeneration`
- [x] broker `AbortSignal` 竞态取消 dispatch（`LLMProvider.call` 无 signal 时仍 fail dispatch promise）

---

## 13. 修订记录

| 日期 | 变更 |
|------|------|
| 2026-07-17 | 初稿：方案 C 分解为 C1/C2/C3；推荐 C-α；提交 swarm 评审 |
| 2026-07-17 | Swarm 三路 APPROVE_WITH_CHANGES；闭合 §10；冻结 M1=C-α；错误码分层；AdmissionStore/localWorkerId 硬约束 |
| 2026-07-17 | M1 落地：`c6c16978` effect-broker affinity；`f011a568` tenant-scoped registry + kill-switch |
| 2026-07-17 | Review fixes：affinity consume admission；invoke mode fail-closed；expiresAt 校验；并发测；fencing 标已知缺口 |
| 2026-07-17 | 残留风险闭合：fencing/token + generation bind；signal abort；UNKNOWN 重试测；monopoly 历史 bullet |
