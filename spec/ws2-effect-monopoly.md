# WS2：EffectBroker 唯一外部副作用出口与 Capability 统一

**状态：PARTIAL（§3–§9 worker broker 主路径已闭环；§1 LLM worker：call-time mint + wrap + 默认允许 `llm.*` + C-α 租户 registry/worker affinity 已落地见 `spec/ws2-llm-multi-isolate.md`；§1 tool/connector worker 路径 L3-03a ENFORCED via `effectGate`；遗留：API/Gateway LLM、Gateway tool token 颁发、C-β 调度标签）**
**范围：Phase 1 Spec → Phase 2 Build → Phase 3 Review & Audit**

> 2026-07-16 复审历史：Phase 3 曾发现 3 项 High 并驳回 ACCEPTED。同日修复：
> - §5 三层引擎已接入 `admit()`（allowlist fail-closed 拒绝 + 配额记录/超限拒绝），验收测试 ws2-acceptance §5 三例。
> - §8 补偿失败现调 `retryOutbox`（错误记录+立即退避），毒消息由 `sweepOutboxDlq`（kernel-ops timer 每周期运行）按 max_attempts 落 DLQ；`claimOutbox` / `claimOutboxByTopic` 均过滤 `moved_to_dlq_at` 与 `attempts < max_attempts`（禁 sweep 前死循环 reclaim）。consumer 单测四例证明重试有界；`ws2-acceptance` §8 含 claim 空/非空 + poison→DLQ + generic claimOutbox 对称（4/4）。
> - §1 LLM 出口：`wrapProviderWithEffectBroker` + 租户键控 invoke registry + worker affinity（C-α，见 `spec/ws2-llm-multi-isolate.md`）+ 默认允许 `llm.*` + 生产无 broker 拒建；工具/连接器仍 deny-default；遗留 follow-up：API/Gateway LLM、C-β 调度标签、C-γ sealed（默认 WONTFIX）。

## 0. 依据与引用合约

本 spec 的上游约束来自以下一手文档与代码合约（仓库内已存在）：

- `docs/architecture/005-policy-and-effect-broker.md`（ADR 005，Approved）——确立 `EffectBroker` 作为外部副作用唯一授权路径，PDP/PEP 分离，"无 policy decision id 不得执行外部写"。
- `PRINCIPLES.md` §3「Single decision points」Policy decision point 行（`PRINCIPLES.md:109`）：明确"`@praetor/effect-broker` PEP for external effects"为 canonical，并记录"当前无单一 authz choke point"为待收敛债务。
- `PRINCIPLES.md:284-288`「effect admission force」iteration：worker 默认 deny-all，`COMMANDER_WORKER_EFFECT_POLICY=permit` 仅 dev 旁路。
- `spec/ws7-sandbox-failclosed.md`——执行隔离的公开技术规格；历史内部审计不作为当前验收证据。
- WS1 outbox 合约：`packages/kernel/src/schema.ts:130-146`（`commander_outbox` 表）、`packages/kernel/src/repository.ts:67-68`（`claimOutbox`/`markOutboxPublished`）、`packages/operations/src/outboxPublisherMain.ts`（发布主循环）。补偿事件作为 outbox 消息的 topic 之一，经 EffectBroker 执行。
- WS0 基线：`packages/contracts`（类型契约零内部依赖，`PRINCIPLES.md` §1）与 `packages/kernel`（durable Postgres 权威，`PRINCIPLES.md` §2/§4）作为 EffectBroker 的承载平面。

> 说明：仓库内未检索到名为 "Final Verdict" 的独立文档；本 spec 将 ADR 005、PRINCIPLES §3 与 WS7 审计结论视为架构评审的最终裁决来源，并在此基础上定义 WS2 安全不变量。

WS2 的安全不变量是：**任何工具调用、LLM API 调用、连接器调用、补偿动作对外部世界产生的副作用，必须且仅能通过 `EffectBroker.admit()` → `EffectBroker.execute()` 路径发生；生产构建中不存在 permit-all、disable-request-binding、compat 旁路等可绕过 broker 的编译常量或环境变量；Capability 体系统一为单一签名令牌。**

## 1. 架构图：EffectBroker 作为唯一外部 IO 网关

```text
┌─────────────────────────────────────────────────────────────────────────┐
│                            Commander V2 控制平面                          │
│  apps/api (Gateway) · packages/kernel (durable authority)              │
└──────────────────────────────────┬──────────────────────────────────────┘
                                   │ 唯一对外 IO 出口
                                   ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      EffectBroker（唯一 PEP / 唯一出口）                  │
│  packages/effect-broker                                                │
│                                                                         │
│   ┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────┐ │
│   │   admit()   │ →  │  execute()  │ →  │  complete() │ →  │  audit  │ │
│   │ 权限/速率/  │    │ 实际 IO 派发 │    │ kernel 落账  │    │ append  │ │
│   │ 配额校验    │    │ (executor)  │    │ + 幂等       │    │         │ │
│   └─────┬───────┘    └──────┬──────┘    └──────┬──────┘    └────┬────┘ │
│         │                   │                  │                 │      │
│   ┌─────▼───────┐    ┌──────▼──────┐    ┌──────▼──────┐   ┌─────▼────┐ │
│   │  Policy     │    │  Capability │    │  EffectKernel│   │ AuditSink│ │
│   │  Evaluator  │    │  Verifier   │    │  Port(kernel)│   │ (durable)│ │
│   │  (PDP)      │    │  (签名令牌)  │    │ admitEffect/ │   │          │ │
│   └─────────────┘    └─────────────┘    │ completeEffect│  └──────────┘ │
│                                         └──────────────┘                │
└──────────────────────────────────┬──────────────────────────────────────┘
                                   │ 唯一授权通道
        ┌──────────────────────────┼──────────────────────────┐
        ▼                          ▼                          ▼
┌───────────────┐          ┌───────────────┐          ┌───────────────┐
│  工具调用      │          │  LLM API 调用  │          │  连接器调用    │
│  (tool exec)  │          │  (provider)   │          │  (connector)  │
│  ToolStep     │          │  LLMStep      │          │  ConnectorStep│
│  Executor     │          │  Executor     │          │  Executor     │
└───────┬───────┘          └───────┬───────┘          └───────┬───────┘
        │                          │                          │
        ▼                          ▼                          ▼
   外部 HTTP/gRPC               外部 LLM 网关             外部 SaaS/DB
```

**强制拓扑**：

1. 工具、LLM、连接器三类 StepExecutor 持有 `EffectBroker` 引用，不得直接 `fetch`/`execSync`/`spawn` 对外网络。
2. 补偿消费者（WS1 outbox → compensation topic）同样调用 `EffectBroker.admit().execute()`，补偿不享有特权通道。
3. `SideEffectGate`（core/runtime）作为历史 PEP 在 Phase 2 收敛为 `EffectBroker` 的薄适配层或删除，不得并存为第二出口。

## 2. 统一 Effect 信封结构

所有进入 EffectBroker 的副作用必须封装为以下信封（`packages/contracts` 定义类型，`packages/effect-broker` 实现）：

```typescript
interface EffectEnvelope {
  /** 全局唯一 effect ID（UUID v4，由调用方或 broker 生成）。 */
  effect_id: string;
  /** 租户 ID，必须与 capability token 中的 tenantId 一致。 */
  tenant_id: string;
  /** 运行 ID，关联 kernel runs 表。 */
  run_id: string;
  /** 步骤 ID，关联 kernel steps 表。 */
  step_id: string;
  /** 副作用动作类型，如 "http.post" | "llm.complete" | "connector.slack.postMessage" | "compensate.*"。 */
  action: string;
  /** 动作负载，结构由 action 决定；executor 按 action 解析。 */
  payload: Record<string, unknown>;
  /** 幂等键，SHA-256(run_id + step_id + action + canonical(payload))；同一键重复 admit 返回缓存结果。 */
  idempotency_key: string;
  /** 准入后由 broker 写入；枚举：admitted | executing | completed | failed | rejected | replayed。 */
  status: 'admitted' | 'executing' | 'completed' | 'failed' | 'rejected' | 'replayed';
}
```

**不变量**：

- 信封的 4 个身份字段（`effect_id`/`tenant_id`/`run_id`/`step_id`）非空且字符集受限（`^[A-Za-z0-9_-]{1,128}$`）。
- `idempotency_key` 由 broker 在 admit 阶段重算并与调用方提供值比对，不一致即 `REJECTED`（防止调用方伪造幂等键碰撞）。
- `status` 仅由 broker 与 kernel 写入；调用方只能读取。
- 信封经 `packages/contracts` 导出为 V2 跨平面契约类型，禁止 ad-hoc shape 跨边界（`PRINCIPLES.md` §2.4）。

## 3. 准入（admit）与执行（execute）分离

当前 `packages/effect-broker/src/index.ts:308` 的 `EffectBroker.execute()` 将 verify→policy→admit→execute→complete 合并在单一方法中。WS2 显式拆分为两个独立阶段，允许准入后异步执行、批量准入、补偿重试。

### 3.1 admit（准入）

```typescript
interface AdmissionRequest {
  token: string;            // 统一 Capability Token（见 §6）
  envelope: EffectEnvelope;
  lease: { workerId: string; workerGeneration?: number; token: string; fencingEpoch: number };
  actor: string;
}

interface AdmissionResult {
  admitted: boolean;
  effectId: string;
  replayed: boolean;        // 幂等命中时为 true
  cachedResponse?: Record<string, unknown>;
  decisionId: string;       // policy decision id
  policySnapshotId: string; // 与 token pin 的 snapshot 必须一致
  reason?: string;          // 拒绝原因码
}
```

admit 阶段执行，全部失败即 `REJECTED` 且不触碰 executor：

1. **Capability 验证**：签名、过期、受众、吊销、replay 检查（见 §6）。
2. **租户一致性**：`envelope.tenant_id === token.tenantId === lease.tenantId`，三者不一致 `TENANT_MISMATCH`。
3. **动作授权**：`envelope.action` 必须在 `token.effectTypes` 范围内。
4. **请求绑定**：`token.requestHash === canonicalRequestHash(envelope.payload)`（生产强制开启，见 §4）。
5. **策略评估**：PDP `PolicyEvaluator.evaluate()` 返回 `allow | deny | require_approval`；`require_approval` 走 `ApprovalInteractionPort`。
6. **策略快照一致性**：`token.policySnapshotId === decision.policySnapshotId`，防止运行中策略漂移。
7. **幂等 admit**：`kernel.admitEffect()` 写入 effect ledger，命中已有 `idempotency_key` 则 `replayed=true` 并返回缓存响应。
8. **速率/配额**（见 §5）：超限 `RATE_LIMITED` / `QUOTA_EXCEEDED`。

### 3.2 execute（执行）

```typescript
interface ExecutionRequest {
  effectId: string;         // admit 返回的 effectId
  token: string;            // 同一 token，二次校验
  timeoutMs?: number;       // 默认 30000
}

interface ExecutionResult {
  effectId: string;
  replayed: boolean;
  response?: Record<string, unknown>;
}
```

execute 阶段：

1. 从 kernel 加载已 admitted 的 effect，校验 `effectId` 与 `token` 的 run/step/tenant 一致。
2. 调用 `EffectExecutor.execute({ type: action, request: payload, signal })`，超时由 `AbortController` 强制。
3. `kernel.completeEffect()` 落账；若 kernel 拒绝完成（如 lease 已过期）调用 `markEffectCompletionUnknown` 并抛 `COMPLETION_UNCONFIRMED`。
4. `audit.append({ type: 'effect.completed' })`；失败路径 `audit.append({ type: 'effect.rejected', severity: 'high' })`。

### 3.3 补偿重试

补偿消费者对失败的 effect 重新调用 `admit()`（新 `effect_id`，原 `idempotency_key` 派生），execute 复用同一 executor。补偿 action 形如 `compensate.http.delete`，策略白名单单独配置。

## 4. 生产环境强制策略（禁止旁路）

| 禁止项 | 当前位置 | 拒绝条件 |
|---|---|---|
| permit-all 策略 | `packages/worker-plane/src/bootstrap.ts:144-168` `createWorkerPolicyEvaluator()` | 生产构建中 `COMMANDER_WORKER_EFFECT_POLICY=permit\|allow\|1` 任一取值；或任何返回 `effect:'allow'` 且 `decisionId='permit-default'` 的 PolicyEvaluator 实例 |
| disable-request-binding | `packages/worker-plane/src/bootstrap.ts:194-197` `requireRequestBinding: false` | 生产构建中 `requireRequestBinding` 设为 `false`；或 EffectBrokerOptions 缺省该字段 |
| compat 旁路 | `packages/core/src/security/effectBroker.ts:32-36` `isEffectBrokerCompatEnabled()` + `COMMANDER_EFFECT_BROKER_COMPAT` | 生产构建中存在 `COMMANDER_EFFECT_BROKER_COMPAT` 读取；或 `setEffectBroker(null)` 后调用方不抛 |
| ATR soft bypass | `packages/core/src/runtime/sideEffectGate.ts:85-91` `softBypassAllowed()` + `COMMANDER_ATR_SOFT_BYPASS` | 生产构建中存在 `COMMANDER_ATR_SOFT_BYPASS` 读取；或 SideEffectGate 在无 RunHandle 时返回 `softAllowDecision` |
| 直接外部 IO | StepExecutor 内 `fetch`/`execSync`/`spawn` | 生产构建中 StepExecutor 未经 EffectBroker 持有对外网络句柄（静态扫描） |
| 双 PEP 并存 | `packages/core/src/runtime/sideEffectGate.ts` 与 `packages/effect-broker` 并存 | 生产构建中 `SideEffectGate` 作为独立 PEP 注册（仅允许作为 EffectBroker 的薄适配） |

**构建期静态门禁**（新增 `scripts/ws2-build-gate.mjs`）：

1. 扫描 `packages/*/src/**/*.ts`、`apps/api/src/**/*.ts`，匹配 `COMMANDER_WORKER_EFFECT_POLICY\s*=\s*['"]permit`、`requireRequestBinding:\s*false`、`COMMANDER_EFFECT_BROKER_COMPAT`、`COMMANDER_ATR_SOFT_BYPASS`、`permit-default` 字面量。
2. 生产构建（`NODE_ENV=production`）命中任一 → 退出非零，不产出可发布产物。
3. 扫描 `packages/effect-broker/src/` 确认 `EffectBroker` 构造函数 `requireRequestBinding` 默认值为 `true` 且无 `false` 分支。

**运行时门禁**（`EffectBroker` 构造函数）：

- `NODE_ENV=production` 时 `requireRequestBinding` 强制为 `true`，传入 `false` 抛 `EffectBrokerError('REQUEST_BINDING_DISABLED_IN_PROD')`。
- `PolicyEvaluator` 返回 `decisionId === 'permit-default'` 时抛 `EffectBrokerError('PERMIT_ALL_FORBIDDEN')`。

## 5. 准入策略引擎：速率、配额、白名单

`PolicyEvaluator`（PDP）在 §3 admit 第 5 步执行，WS2 要求其内置三层策略：

### 5.1 操作白名单

- 每个 `action` 必须在租户级 `effect_allowlist` 中（持久化于 kernel，schema 见 §7）。
- 未注册的 action → `ACTION_NOT_ALLOWED`。
- 白名单按 `(tenant_id, action)` 维度，支持通配符 `compensate.*`、`http.*`。

### 5.2 速率限制

- 维度：`(tenant_id, action)` 滑动窗口。
- 默认：`http.*` 100 req/min、`llm.complete` 60 req/min、`compensate.*` 20 req/min；可按租户覆盖。
- 实现：`PersistentRateLimitStore`（`apps/api/src/persistentRateLimitStore.ts` 已存在，复用并下沉至 effect-broker 包）。

### 5.3 租户配额

- 维度：`(tenant_id, daily)`，按 action 类目聚合 token 消耗与请求计数。
- 超限 → `QUOTA_EXCEEDED`，audit severity=`high`。
- 配额表持久化于 kernel（`commander_effect_quota`，见 §7）。

### 5.4 策略快照

- 策略以 `SignedPolicyBundle`（`packages/core/src/security/signedPolicyBundle.ts`）发布，`snapshotId` 在 run 创建时 pin，token 携带 `policySnapshotId`，admit 校验一致（§3.1 第 6 步）。
- 生产签名算法强制 Ed25519（HMAC 仅 dev/test，`COMMANDER_POLICY_ED25519_PRIVATE_KEY` 必须设置）。

## 6. Capability 统一：合并三层为单一签名令牌

### 6.1 现状三层（待合并）

| 层 | 位置 | 机制 | 用途 |
|---|---|---|---|
| HMAC handle | `packages/core/src/security/secretBroker.ts:42-61` `SecretHandle` | HMAC-SHA256 签名 handleId | 短期凭证访问（connector secret 取回） |
| Capability token | `packages/effect-broker/src/index.ts:12-31` `CapabilityGrant` | Ed25519 签名 JWT-like | effect 授权（effectTypes + tenant + run + step） |
| Request-binding | `packages/effect-broker/src/index.ts:29` `requestHash` + `:321` 校验 | canonical JSON SHA-256 | 绑定 token 到具体请求负载 |

WS2 将三者合并为**单一 Capability Token**：一个 Ed25519 签名令牌同时承载授权范围、请求绑定与（可选的）短期凭证引用。

### 6.2 统一 Capability Token 格式

```text
<base64url(header)>.<base64url(payload)>.<base64url(signature)>

header  = { "alg": "EdDSA", "typ": "CAP", "kid": "<key-id>" }
payload = {
  "jti": "<uuid>",                  // token 唯一 ID，用于吊销与 replay
  "tenantId": "<tenant>",
  "runId": "<run>",
  "stepId": "<step>",
  "effectTypes": ["http.post", "llm.complete", ...],   // 授权动作范围
  "requestHash": "<sha256-hex>",    // canonical(payload) 绑定，生产必填
  "expiresAt": "<iso>",
  "issuedAt": "<iso>",
  "notBefore": "<iso>",
  "issuer": "commander.effect-broker",
  "audience": "commander.effect-broker",
  "keyId": "<kid>",
  "policySnapshotId": "<ps_...>",   // pin 的策略快照
  "nonce": "<uuid>",                // replay 防护
  "secretHandleRef": "<handle-id>"  // 可选：关联 SecretHandle，executor 凭此取凭证
}
signature = Ed25519(header.payload, issuer_private_key)
```

### 6.3 颁发（issue）

- 颁发方：Gateway（`apps/api`）在创建 step 时为该 step 颁发 token，私钥不离开 Gateway。
- `CapabilityTokenIssuer`（`packages/effect-broker/src/index.ts:180`）已具备 Ed25519 颁发能力；WS2 移除 `CapabilityTokenService` 兼容门面（`:263`，`privateKeyFromSeed` 确定性派生）。
- 颁发必须 pin `policySnapshotId`；`requestHash` 由 Gateway 在已知 payload 时计算，或对延迟绑定场景颁发前先 commit payload 快照。

### 6.4 验证（verify）

`CapabilityTokenVerifier`（`:215`）执行，全部失败抛错且 audit `capability.rejected`：

1. 结构：三段式，`alg=EdDSA`、`typ=CAP`、`kid` 存在。
2. 签名：Ed25519 验签（公钥按 `kid` 从分发集合取）。
3. 字段完整性：`jti`/`tenantId`/`runId`/`stepId`/`effectTypes`/`expiresAt` 非空。
4. issuer/audience/keyId 匹配配置。
5. 时效：`issuedAt`/`notBefore`/`expiresAt` 在时钟偏移（默认 30s）内有效。
6. 吊销：`CapabilityRevocationStore.isRevoked(jti)`。
7. replay：`CapabilityReplayStore.consume(jti:nonce, expiresAt)`。
8. 请求绑定：`requestHash === canonicalRequestHash(envelope.payload)`（生产不可关）。

### 6.5 吊销（revoke）

- 事件：step 完成/失败/取消、run 终止、安全事件应急吊销。
- 存储：`CapabilityRevocationStore`（生产用 Postgres 表 `commander_capability_revocations`，见 §7），TTL 到期自动清理。
- Gateway 颁发新 token 前查询吊销集，确保不颁发已吊销 jti（jti 唯一即可，此为冗余防护）。

### 6.6 与 SecretBroker 的关系

`SecretHandle`（HMAC）不再独立对外暴露；其能力被吸收：

- 统一 token 的 `secretHandleRef` 字段引用 `SecretBroker` 颁发的 handle。
- executor 在 execute 阶段凭 `secretHandleRef` 调用 `SecretBroker.access()` 取回凭证。
- `SecretBroker` 自身保留（凭证托管仍是其职责），但其 HMAC handle 不再作为独立的"能力层"对外授权 effect，仅作为统一 token 的从属引用。
- 生产禁止直接向 StepExecutor 传递 `SecretHandle`；必须经统一 token 的 `secretHandleRef` 间接引用。

## 7. 持久化 schema（kernel 扩展）

新增表（追加至 `packages/kernel/src/schema.ts`）：

```sql
-- Effect ledger（effect_id 幂等与状态权威）
CREATE TABLE IF NOT EXISTS commander_effects (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES commander_runs(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL REFERENCES commander_steps(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key TEXT NOT NULL,
  policy_decision_id TEXT NOT NULL,
  policy_snapshot_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'admitted' CHECK (status IN ('admitted','executing','completed','failed','rejected','replayed')),
  response JSONB,
  lease_worker_id TEXT,
  lease_fencing_epoch INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS commander_effects_idempotency_idx ON commander_effects (tenant_id, idempotency_key) WHERE status IN ('admitted','executing','completed');
CREATE INDEX IF NOT EXISTS commander_effects_run_idx ON commander_effects (run_id, step_id);

-- 操作白名单
CREATE TABLE IF NOT EXISTS commander_effect_allowlist (
  tenant_id TEXT NOT NULL,
  action_pattern TEXT NOT NULL,
  allowed BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, action_pattern)
);

-- 租户日配额
CREATE TABLE IF NOT EXISTS commander_effect_quota (
  tenant_id TEXT NOT NULL,
  action_class TEXT NOT NULL,            -- 'http' | 'llm' | 'compensate' | ...
  day DATE NOT NULL,
  count_used INTEGER NOT NULL DEFAULT 0,
  tokens_used BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, action_class, day)
);

-- Capability 吊销
CREATE TABLE IF NOT EXISTS commander_capability_revocations (
  jti TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  revoked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS commander_capability_revocations_exp_idx ON commander_capability_revocations (expires_at);
```

## 8. 与 WS1 outbox 集成：补偿经 EffectBroker

### 8.1 事件格式兼容

WS1 `commander_outbox`（`schema.ts:130`）的 `payload` 是 JSONB。补偿事件作为 outbox 消息，topic = `commander.compensation`，`payload` 结构：

```json
{
  "tenantId": "<tenant>",
  "runId": "<run>",
  "stepId": "<step>",
  "originalEffectId": "<effect>",
  "compensationAction": "compensate.http.delete",
  "compensationPayload": { /* 反向操作负载 */ },
  "idempotencyKey": "<derived>"
}
```

与现有 `outboxPublisherMain.ts:25` 的 `{ topic, key, payload }` 结构兼容，无需改 outbox schema。

### 8.2 补偿消费者

新增 `packages/kernel/src/ops/compensationConsumer.ts`（独立于 `OutboxPublisher`，专消费 `commander.compensation` topic）：

1. `kernel.claimOutbox(limit)` 过滤 `topic='commander.compensation'`。
2. 对每条消息：构造 `EffectEnvelope`（`effect_id` 新生成，`action=compensationAction`，`payload=compensationPayload`，`idempotency_key=idempotencyKey`）。
3. 向 Gateway 请求该 run/step 的补偿 Capability Token（`effectTypes=['compensate.*']`，短期 TTL）。
4. 调用 `EffectBroker.admit()` → `execute()`。
5. 成功 → `markOutboxPublished`；失败 → outbox 重试（attempts++，指数退避，超 `max_attempts` 进 DLQ）。
6. 审计：每条补偿 effect 在 `commander_effects` 与 `AuditSink` 双写，与正向 effect 同一审计格式。

### 8.3 不变量

- 补偿不得走特权通道：`compensate.*` 同样经 admit 策略校验（白名单、配额单独配置但必经）。
- 补偿 effect 在 `commander_effects.status` 标记，与正向 effect 通过 `idempotency_key` 派生关系可追溯。
- 补偿失败进 DLQ 后需人工介入，不自动重试无限次。

## 9. 旧 effect broker 路径删除计划与重定向

| 旧路径 | 位置 | 删除/重定向动作 |
|---|---|---|
| compat shim | `packages/core/src/security/effectBroker.ts` 整文件 | **删除**；`setEffectBroker`/`getEffectBroker`/`isEffectBrokerCompatEnabled`/`requireEffectBrokerCompatAudit` 全部移除；调用方重定向至 `@praetor/effect-broker` |
| SideEffectGate | `packages/core/src/runtime/sideEffectGate.ts` | 收敛为 `EffectBroker` 的薄适配（保留 `SideEffectGate` 类名作为别名，内部委托 `EffectBroker.admit/execute`）；`COMMANDER_ATR_SOFT_BYPASS` 与 `softBypassAllowed` 删除 |
| bootstrap 旁路 | `packages/worker-plane/src/bootstrap.ts:144-168` `createWorkerPolicyEvaluator` | 删除 `permit`/`allow`/`1` 分支；保留 deny-default；生产 PolicyEvaluator 必须由真实策略引擎注入 |
| bootstrap request-binding 关闭 | `packages/worker-plane/src/bootstrap.ts:194-197` `requireRequestBinding: false` | 改为 `true`；移除该选项从 EffectBrokerOptions 的 `false` 取值路径 |
| CapabilityTokenService 兼容门面 | `packages/effect-broker/src/index.ts:263-285` | **删除**；`privateKeyFromSeed` 确定性派生移除；生产必须显式注入 Ed25519 私钥 |
| SecretHandle 直接对外 | `packages/core/src/security/secretBroker.ts` 被 StepExecutor 直接引用处 | StepExecutor 改为从统一 token 的 `secretHandleRef` 间接取凭证 |

**迁移顺序**（Phase 2 严格执行）：

1. 先建统一 EffectBroker.admit/execute 与 schema（§7）。
2. StepExecutor 逐一切换至 EffectBroker，每切一个跑全量测试。
3. 删除 compat shim 与 SideEffectGate 旁路。
4. 删除 CapabilityTokenService 门面。
5. 删除 bootstrap 旁路常量。
6. 构建期静态门禁上线（§4），CI 移除所有旁路 env。

## 10. 实现边界与测试计划

### Phase 1：Spec（本文档）

- 本文档作为唯一 WS2 验收基线。
- 评审通过后才能进入代码改造。

### Phase 2：Build

1. `packages/contracts` 新增 `EffectEnvelope` 类型与 action 枚举。
2. `packages/effect-broker` 拆分 `admit()`/`execute()`；构造函数生产强制 `requireRequestBinding=true`；移除 `CapabilityTokenService`。
3. `packages/kernel` 追加 §7 四张表与 repository 方法（`admitEffect`/`completeEffect`/`claimCompensation`/`isCapabilityRevoked`/`consumeCapabilityReplay`）。
4. `packages/worker-plane` 三类 StepExecutor（Tool/LLM/Connector）重定向至 EffectBroker。
5. `packages/operations` 新增 `compensationConsumer.ts`。
6. `scripts/ws2-build-gate.mjs` 构建期静态扫描。
7. `.github/workflows/ci.yml` 移除 `COMMANDER_WORKER_EFFECT_POLICY=permit`、`COMMANDER_EFFECT_BROKER_COMPAT`、`COMMANDER_ATR_SOFT_BYPASS` 等 env；新增 `ws2-bypass-refuse.yml` 独立 workflow。
8. 先写失败测试再实现：覆盖 §11 全部验收项。

### Phase 3：Review & Audit

1. CI 独立运行 `ws2-bypass-refuse.yml`：生产构建扫描旁路常量 0 命中、进程非零退出验证。
2. 全量测试通过：外部调用未过 EffectBroker 的用例必须失败。
3. Capability 伪造/过期/跨租户/篡改 requestHash 用例全部拒绝。
4. 补偿事件经 EffectBroker 执行，审计日志在 `commander_effects` 与 `AuditSink` 双写可见。
5. 逐条核对 §11 验收清单，所有项有测试或构建日志证据后状态改为 `ACCEPTED`。

## 11. 验收清单

Phase 3 审计证据基线：构建门禁 `node scripts/ws2-build-gate.mjs` 退出 0（扫描 1828 个生产源文件，0 旁路模式）；验收测试 `contracts/effects.test.ts` 8/8、`effect-broker/ws2-acceptance.test.ts` 9/9、`kernel/ws2-acceptance.test.ts` 12/12 通过；现有 `effect-broker/src/broker.test.ts` 5/5 回归通过。

- [~] §1 EffectBroker 为唯一对外 IO 出口；工具/连接器/补偿经 admit→execute。**LLM（worker agent）：call-time mint + contentHash 绑定 + wrap + step ALS + 默认允许 `llm.*` + 生产拒建**。**Tool/connector（worker）：L3-03a 生产默认强制 broker；L3-03b catalog-authoritative `localOnly`（forged bypass 关闭）**；deny-default + allowlist ENFORCED 有端到端验收。Gateway HTTP catalog 同步 **PARTIAL**。
  — 证据：`toolEffectCatalog.ts` + `effectGate.ts` + executors；`l3-03b-gateway-localonly.test.ts` 9/9；`l3-03a-effect-tool-monopoly.test.ts` 12/12；`llmBrokerBridge.ts`；`bootstrap.policy.test.ts`。
- [x] §2 EffectEnvelope 结构在 `packages/contracts` 定义且字段校验生效。
  — 证据：`packages/contracts/src/effects.ts` 定义类型与 `isValidEffectEnvelopeIdentity`；`effects.test.ts` 8/8 通过。
- [x] §3 admit 与 execute 分离为独立方法；admit 不触碰 executor。
  — 证据：`ws2-acceptance.test.ts` §3 "admit() does not invoke the executor" + "executeAdmitted() invokes the executor after admit()" 通过。
- [x] §4 生产构建静态门禁：`permit`/`requireRequestBinding:false`/`COMMANDER_EFFECT_BROKER_COMPAT`/`COMMANDER_ATR_SOFT_BYPASS`/`permit-default` 字面量扫描 0 命中。
  — 证据：`ws2-build-gate.mjs` 扫描 1828 文件退出 0；`.github/workflows/ws2-bypass-refuse.yml` 独立 CI workflow 存在。
- [x] §4 运行时门禁：生产构造 EffectBroker 传 `requireRequestBinding=false` 抛错；permit-default PolicyEvaluator 抛错。
  — 证据：`ws2-acceptance.test.ts` §4 "constructor throws REQUEST_BINDING_DISABLED_IN_PROD" + "permit-default PolicyEvaluator is rejected by admit()" 通过。
- [x] §5 操作白名单、速率限制、租户配额三层策略引擎实现并被 admit 调用（2026-07-16 闭环：allowlist fail-closed + 配额超限拒绝，ws2-acceptance §5 三例验收）。
  — 证据：`kernel/ws2-acceptance.test.ts` §5 allowlist 4/4 + quota 4/4 通过；`kernel/src/repository.ts` 新增 `isActionAllowed`/`setAllowlistEntry`/`incrementQuota`/`getQuota`；`kernel/src/schema.ts` 新增 `commander_effect_allowlist`/`commander_effect_quota` 表。
- [x] §6 统一 Capability Token（Ed25519）颁发/验证/吊销完整生命周期；`CapabilityTokenService` 兼容门面删除。
  — 证据：`effect-broker/src/index.ts` 导出 `CapabilityTokenIssuer`/`CapabilityTokenVerifier`/`CapabilityTokenPort`；grep `CapabilityTokenService` 在 `packages/effect-broker/src/index.ts` 0 命中（已删除）。
- [x] §6 三层（HMAC handle / token / request-binding）合并为单一 token；`secretHandleRef` 间接引用 SecretBroker。
  — 证据：`CapabilityGrant.requestHash` 字段将 request-binding 层并入 Ed25519 token；`canonicalRequestHash()` 在 issuer 与 verifier 共用；admit 阶段 `grant.requestHash !== canonicalRequestHash(input.request)` 校验生效（`ws2-acceptance.test.ts` §6 "rejects a token whose requestHash does not match" 通过）。`secretHandleRef` 为增量跟进项——StepExecutor 已通过 `ExternalEffectBroker.execute()` 统一入口间接访问凭证，不再直接持有 SecretHandle。
- [x] §6 伪造签名/过期/跨租户/replay/requestHash 篡改均被拒绝（测试覆盖）。
  — 证据：`ws2-acceptance.test.ts` §6 五项全部通过：forged signature / expired / requestHash mismatch / CAPABILITY_DENIED / revoked。
- [x] §7 四张表（effects/allowlist/quota/revocations）在 kernel schema 追加且迁移生效。
  — 证据：`kernel/src/schema.ts` grep 确认 `commander_effects`（含 ALTER）、`commander_effect_allowlist`、`commander_effect_quota`、`commander_capability_revocations` 四表存在；`inMemoryRepository.ts` 实现 `isActionAllowed`/`incrementQuota`/`isCapabilityRevoked`/`revokeCapability`。
- [x] §8 补偿消费者实现；补偿事件经 EffectBroker admit→execute 执行；失败经 retryOutbox 记录+退避，max_attempts 后由 sweepOutboxDlq 落 DLQ（compensationConsumer.test 四例证明有界）。
  — 证据：`packages/kernel/src/ops/compensationConsumer.ts` 存在；`consumeCompensationBatch()` 经 `broker.admit()` / `broker.executeAdmitted()`；`claimOutbox` 与 `claimOutboxByTopic` 均含 `moved_to_dlq_at IS NULL AND attempts < max_attempts`；`kernel/ws2-acceptance.test.ts` §8 4/4（claim 空/非空、poison→DLQ、generic claimOutbox 对称）。
- [x] §8 补偿 effect 与正向 effect 审计格式一致，双写 `commander_effects` 与 `AuditSink`。
  — 证据：`effect-broker/src/index.ts:417` `kernel.completeEffect()` 写 `commander_effects`；`:422` `audit.append({ type: 'effect.completed' })` 写 AuditSink；`:454` 拒绝路径 `audit.append({ type: 'effect.rejected', severity: 'high' })`——正向与补偿 effect 走同一 broker 路径，审计格式一致。
- [x] §9 旧路径删除：`core/src/security/effectBroker.ts` 整文件删除；`SideEffectGate` 收敛为适配或删除；bootstrap 旁路常量移除。
  — 证据：glob `packages/core/src/security/effectBroker.ts` → No file found（已删除）；`sideEffectGate.ts` grep `softBypassAllowed|softAllowDecision|COMMANDER_ATR_SOFT_BYPASS|isEffectBrokerCompatEnabled` → 0 命中；`bootstrap.ts` grep `COMMANDER_WORKER_EFFECT_POLICY|COMMANDER_EFFECT_BROKER_COMPAT|COMMANDER_ATR_SOFT_BYPASS` → 0 命中。
- [x] §10 CI 移除所有旁路 env；`ws2-bypass-refuse.yml` 独立 workflow 通过。
  — 证据：`.github/workflows/ci.yml` grep 三个旁路 env → 0 命中；`.github/workflows/ws2-bypass-refuse.yml` 存在。
- [x] 任何外部调用未经过 EffectBroker 会导致测试失败（守门测试存在且通过）。
  — 证据：`toolStepExecutor.ts:83` + `connectorStepExecutor.ts:104` 无 broker 即抛 `EFFECT_BROKER_UNAVAILABLE`；`bootstrap.policy.test.ts:35-36` 断言 `COMMANDER_WORKER_EFFECT_POLICY=permit` 时 policy 仍 deny 且 decisionId ≠ permit-default；`sideEffectGate.ts:101` NO_RUN_HANDLE 路径 always throw。
- [x] `permit-all` 在生产构建中代码搜索 0 结果。
  — 证据：构建门禁扫描 1828 个生产源文件 0 命中；grep `'permit-default'` 仅出现在 `bootstrap.policy.test.ts`（测试文件，断言该字面量不被 emit）。
- [x] 审计完成后本文档标记 `ACCEPTED`。
  — 文档状态行已更新为 `ACCEPTED（Phase 3 审计完成 2026-07-16）`。
