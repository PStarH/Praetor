<p align="center">
  <a href="https://github.com/PStarH/Commander/actions/workflows/ci.yml?query=branch%3Amaster"><img src="https://img.shields.io/github/actions/workflow/status/PStarH/Commander/ci.yml?branch=master&style=flat-square&label=CI&logo=github" /></a>
  <img src="https://img.shields.io/github/license/PStarH/Commander?style=flat-square&color=EAB308" />
</p>

<h1 align="center">Commander</h1>
<p align="center"><strong>面向 Coding 与 DevOps AI 智能体的审批与状态恢复平面</strong></p>
<p align="center">
  <em>杜绝重复外部变更 · 网络丢包与超时安全恢复 · 密码学签名存证链</em>
</p>

> **状态：Alpha。** Commander 是一个开源评估系统与试点框架。目前尚未通过生产就绪认证；详见 [GitHub 试点边界](docs/pilot/github/README.md) 与 [ENTERPRISE_READINESS.md](ENTERPRISE_READINESS.md)。

<p align="center">
  <a href="#快速上手"><img src="https://img.shields.io/badge/TRY_NOW-000?style=for-the-badge" /></a>
  <a href="#ai-智能体面临的分布式系统挑战"><img src="https://img.shields.io/badge/WHY_COMMANDER-000?style=for-the-badge" /></a>
  <a href="https://pstarh.github.io/commander-docs/zh/"><img src="https://img.shields.io/badge/DOCS-000?style=for-the-badge" /></a>
</p>

---

## AI 智能体面临的分布式系统挑战

```
   ┌────────────────────────────────────────────────────────┐
   │             AI 智能体框架与大语言模型                  │
   │  Claude Code · Cursor · OpenAI Agents · LangGraph      │
   └──────────────────────────┬─────────────────────────────┘
                              │ 1. 提议变更（智能体不直接持有写权限凭据）
                              ▼
   ┌────────────────────────────────────────────────────────┐
   │             Commander 治理与恢复控制面                 │
   │  ┌─────────────────────────┐ ┌──────────────────────┐  │
   │  │ 重试前预检 (幂等性保证) │ │ 人类双阶段密码学审批 │  │
   │  │ (Query-Before-Retry)    │ │ (Cryptographic Hash) │  │
   │  └─────────────────────────┘ └──────────────────────┘  │
   │  ┌─────────────────────────┐ ┌──────────────────────┐  │
   │  │ 持久化 PostgreSQL 内核  │ │ 防篡改数字签名存证   │  │
   │  │ (崩溃安全 Step Lease)   │ │ (Ed25519 Signed JWS) │  │
   │  └─────────────────────────┘ └──────────────────────┘  │
   └──────────────────────────┬─────────────────────────────┘
                              │ 2. 受治理执行与自动事务补偿
                              ▼
   ┌────────────────────────────────────────────────────────┐
   │             外部基础设施与目标系统                     │
   │    GitHub (PR/Issue) · Kubernetes · 云端基础资源       │
   └────────────────────────────────────────────────────────┘
```

当 AI 智能体（如 Claude Code、OpenAI Agents SDK 或企业自研编码智能体）尝试执行外部写操作时（如创建 GitHub Pull Request、回滚 Kubernetes 部署或变更云设施），**网络连接中断或工作节点崩溃会使系统陷入不确定状态**：

外部写操作究竟成功了吗？写入了几次？实际提交的内容是什么？

盲目重试会导致重复 PR、重复交易或状态污染；直接放弃又会留下孤立的外部副作用。

| 核心挑战 | 传统智能体朴素执行 | Commander 受治理执行 |
| --- | --- | --- |
| **响应丢失**（如创建 PR 时遭遇 504 超时） | 重新规划或盲目重试 → **产生重复 PR 与脏变更** | **重试前预检（Query-Before-Retry）**：基于操作身份查询远端结果，避免重复执行 |
| **节点中途崩溃** | 状态丢失或归零重跑，产生不可控的悬空变更 | **持久化 PostgreSQL Kernel**：租约安全回收，新 Worker 无缝接管与恢复 |
| **凭据暴露风险** | 智能体进程直接持有写权限 API Token / GitHub 密钥 | **严格职责边界**：智能体仅具备提议（Propose）权限，写凭据严格隔离在 Worker 平面 |
| **人类审批确认** | 纯文本确认或无约束的确认按钮 | **密码学参数绑定**：审批不可变锁定请求摘要与策略快照 |
| **审计与存证归因** | 终端易失日志 | **Ed25519 签名存证**：JWS 签名收据，支持第三方独立验证 |
| **回滚与撤销** | 临时补丁脚本或无法安全回滚 | **受治理的补偿机制**：要求独立的人类授权绑定与专属收据 |

深入阅读工程论文：[为什么智能体的外部写操作不能盲目重试？](docs/content/why-retrying-ai-agent-external-actions-is-unsafe.md)。

---

## 什么是 Commander

智能体请求创建一个 Pull Request。人类批准了它。GitHub 接受了写入——但工作节点（Worker）丢失了响应。操作是否真正发生了？下一个 Worker 该做什么？

Commander 将已批准的请求及其执行状态保存在一起。其 GitHub 适配器能够在响应丢失后查询匹配结果，在证据不明确时保留未决结果，并且只能通过经单独授权的补偿操作关闭未合并的 PR。

首个试点有意保持聚焦：**基于同仓库现有分支创建 PR**。它不生成或推送代码，不合并 PR，也不部署到生产环境。分支内容仍需通过 GitHub 的常规审查与检查。

- [运行 GitHub 试点](docs/pilot/github/README.md)：提议 → 批准 → 检查 → 单独授权关闭。
- [为什么不仅使用 GitHub 原生权限和 Actions 审批？](docs/pilot/github/native-controls.md)：原生控制通常已经足够；只有当统一的操作身份、恢复机制和存证链有明确价值时才使用 Commander。
- [安全边界与限制](docs/pilot/github/threat-model.md)：关联标记不是数字签名，外部副作用无法保证全局绝对 Exactly-Once。

适配器契约与 CLI 包含自动化本地测试。一个手动触发的 CI 任务针对单一沙箱仓库，在真实的 GitHub API 上运行真实 Gateway、Worker 和 PostgreSQL：测试代理切断或保留创建响应，Worker 被终止并重启，重启后的新 Worker 找到已存在的 PR 而不是创建重复 PR。丢失的响应由该测试代理注入，并非自然网络故障。此处不代表任何采纳承诺或生产就绪声明。下文同样提供既有的本地智能体运行时与只读审查工具。

---

## 运行时路径

GitHub 试点使用 **Enterprise Gateway**，这是一条仍处于 **alpha** 阶段的持久化服务端路径。**Local CLI** 是独立的本地智能体运行时；其模拟演示并不能证明 Gateway 的受治理写入行为。

|                    | Local CLI                                                                     | Enterprise Gateway                                                     |
| ------------------ | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **入口**           | `commander review --real`（首个提供商试用）；其他命令仍为 alpha               | `POST /v1/runs`（经由 `apps/api`）                                     |
| **状态**           | 本地 SQLite / JSON (`.commander_state/`)                                      | Postgres kernel (`runs`/`steps`/`events`/outbox/leases)                |
| **认证**           | 无（单用户）                                                                  | `COMMANDER_API_KEY` + JWT 租户声明                                     |
| **多租户**         | 无（隐式 `__default__`）                                                      | Alpha — kernel RLS + 租户感知单例；存储隔离为 opt-in                   |
| **持久化 Kernel**  | 否                                                                            | 是（生产环境 / 设置 Postgres DSN 时自动开启）                           |
| **状态**           | Alpha 本地评估工具 — 尚未达到生产就绪                                         | Alpha — 尚未在真实后端经过实战检验                                     |

以下首用户路径是基于源码的 **E0 模拟演示**。它不需要凭据，不向提供商或目标系统发起写入，且与基于真实提供商的 Local CLI 使用及 E1 Enterprise Gateway 试点路径相互独立。克隆、安装和构建仍会在本机写入检出目录、依赖缓存和构建产物。

---

## 快速上手

### ⚡ 4 条探索路径（60 秒内上手）

| 体验路径 | 执行命令 | 核心验证内容 |
| --- | --- | --- |
| **1. 零依赖模拟演示** | `pnpm demo:l4-a` | 多智能体研讨拓扑、5 层质量门禁评估、内存级闭环执行（无需配置 API Key） |
| **2. 真实 Provider 只读代码审查** | `pnpm exec tsx packages/core/src/cliEntry.ts review --commit HEAD --real --provider=openai` | 基于真实 LLM 与质量门禁对本地 Git diff 进行严格只读审查 |
| **3. Web 交互式控制台** | `pnpm gui` | 启动浏览器仪表盘 (`:5173`)：实时拓扑流、DLQ 观测与审批队列 |
| **4. 受治理动作离线契约测试** | `pnpm test:github:offline` | 130 项断言离线验证断网丢失响应后的幂等反查与两阶段签批 |

### 📦 4 行代码无缝接入 (Python SDK)

```python
from commander_sdk import CommanderClient

# 连接 Commander 治理控制面
client = CommanderClient(base_url="http://localhost:4000")

# 提议一项受重试前预检与人类数字签批保护的外部变更
run = client.runs.create(
    task="审查认证模块 diff 并提议修复 PR",
    require_approval=True
)
print(f"任务 {run.run_id} 已发起，等待签批状态: {run.approval_required}")
```

针对全新的 GitHub 操作路径，请遵循 [试点指南](docs/pilot/github/README.md)。该指南将无凭据契约测试、已配置的 Gateway 演示与可选择执行的真实 GitHub 适配器测试清晰分隔。下方的本地运行时演示依然是独立的模拟示例。其动画展示的是本地 CLI，并非 GitHub 审批或响应丢失恢复的录屏。

<p align="center">
  <img src="docs/assets/commander-watch-demo.svg" alt="本地 CLI 帮助动画。这不是 GitHub 恢复的录屏。" width="100%">
</p>

### E0 模拟演示（推荐首次运行）

使用 Node.js 22.x 和 pnpm 9（Corepack 会选择仓库固定的 pnpm 版本）。该生命周期完全从源码检出目录运行：

克隆和全新安装仍需要正常访问 GitHub 和 npm 注册表。`--offline` 标志表示不向提供商发起请求，并不代表完全无网络的安装过程。

```bash
git clone https://github.com/PStarH/Commander.git
cd Commander
corepack enable
pnpm install --frozen-lockfile
pnpm build

pnpm exec tsx packages/core/src/cliEntry.ts --help
pnpm exec tsx packages/core/src/cliEntry.ts doctor --offline
pnpm demo:l4-a
```

`doctor --offline` 检查本地前置条件，不联系 LLM 提供商。`demo:l4-a` 使用模拟/内存依赖和本机回环服务器；它不调用真实提供商，也不执行外部写入。演示进程拥有并会自动停止其回环服务器，因此无需外部资源清理命令。命令成功退出即完成 E0 清理。

跑通此路径仅作为开发/演示证据。它不是已发布的包安装，不是 E1 受治理写入证明，也不是 Commander 达到生产就绪的凭证。

### 真实 Provider 的受控只读代码审查（首个真实 Provider 试用）

```bash
# 显式选择一家提供商
export OPENAI_API_KEY=sk-...
pnpm exec tsx packages/core/src/cliEntry.ts review \
  --commit HEAD --real --provider=openai

# 或使用 Anthropic
export ANTHROPIC_API_KEY=sk-ant-...
pnpm exec tsx packages/core/src/cliEntry.ts review \
  --commit HEAD --real --provider=anthropic
```

此命令读取选定的 Git diff 和本地审查指引，最多向显式选定的提供商发送 15,000 个 diff 字符，并将提供商响应限制在 4,000 tokens 与 8 MiB 内。Commander 在 120 秒后中止提供商传输，并在 JSON 解析前拒绝超过 8 MiB 的响应正文。提供商/模型未分配任何执行工具，因此无法发起命令执行、文件修改、网络浏览或目标系统写入。CLI 本身运行固定的只读 `git diff` 命令，并在系统临时目录中更新跨进程速率限制状态。

输出会标识 `source=real`、提供商、模型、端点主机、提示词字节数、截断 diff 的实际覆盖比例以及完成响应上限。凭据缺失、空 diff、提供商错误、超时、超限响应和无效结构化输出均会以非零状态退出，绝不静默回退至模拟审查。

Diff 和审查指引会离开本机，可能包含仓库敏感材料，并受提供商保留政策约束。使用前请先阅读 [PRIVACY.md](PRIVACY.md)。普通 `commander run`、`pnpm gui`、MCP、SDK 以及 Enterprise Gateway 流程不属于此首用户路径，不得表述为只读或生产就绪。

### Enterprise Gateway（alpha）

本首用户指南有意不提供可直接运行的 Gateway 命令：该路径需要额外的密钥、PostgreSQL 以及运维控制。企业评估请使用 [Shadow 试点阶段 A](docs/pilot/shadow/README.md)，该试点仅评估历史观察样本，不执行外部 rollback。受门控的 [实时写入参考](docs/enterprise/quickstart.md) 必须与 [ENTERPRISE_READINESS.md](ENTERPRISE_READINESS.md) 对照阅读。限定边界的 E1 设计伙伴工作流仍由 [上线就绪 Runbook](docs/runbooks/design-partner-launch-readiness.md) 严格门控。启动开发版 Gateway 并不构成外部写入的授权或证明，共享多租户使用仍处于 alpha 阶段。

---

## 核心特性

### 推理引擎（Deliberation Engine）

任务分类、复杂度评估和拓扑选择——全自动完成。Commander 将任务分类（CODING / RESEARCH / ANALYSIS / FACTUAL），估算复杂度，并从 5 种标准拓扑中选择：SINGLE、CHAIN、DISPATCH、ORCHESTRATOR、REVIEW。一行简短任务使用 1 个智能体；跨仓库全面审计可扩展到 15 个智能体。

### 实时流式传输（Live Streaming）

智能体事件、工具调用和配置的门控决策会实时流式传输到终端或 SSE 端点。不是事后轮询，不是事后日志。你可以逐步检查已发出的工作轨迹。

```
┌─ Deliberation ──────────────────────────────────────────────┐
│ Task: "audit this repo for security issues"                  │
│ Classification: ANALYSIS · Complexity: 7/10                  │
│ Topology: DISPATCH (3 agents)                                │
├─ Agent α (security-scanner) ─────────────────────────────────┤
│ [event] Scanning package.json for known CVEs...              │
│ [tool] npm audit · 2 critical, 5 moderate                    │
│ [gate] ACCURACY ✓ · COMPLETENESS ✓                           │
├─ Agent β (code-reviewer) ────────────────────────────────────┤
│ [event] Checking for hardcoded secrets...                    │
│ [tool] grep · found 1 potential secret in config.ts          │
│ [gate] SAFETY ⚠ · Potential secret detected                  │
├─ Agent γ (dependency-checker) ───────────────────────────────┤
│ [event] Analyzing license compliance...                      │
│ [tool] license-check · No GPL/AGPL dependencies              │
│ [gate] COMPLETENESS ✓ · ACCURACY ✓                           │
├─ Synthesizer ────────────────────────────────────────────────┤
│ Merging 3 agent outputs...                                   │
│ Leader synthesis · 4 findings, 2 critical                    │
└──────────────────────────────────────────────────────────────┘
```

### 25 个提供商与自动故障转移

设置任意一个 API 密钥。Commander 自动检测提供商；若调用失败，则按可配置链回退。OpenAI → Anthropic → DeepSeek → Groq → Ollama —— 你定义顺序，Commander 处理路由。

OpenAI · Anthropic · Google · Azure · DeepSeek · GLM · MiMo · Xiaomi · Groq · Together · Perplexity · Fireworks · Replicate · Mistral · Cohere · OpenRouter · xAI · Anyscale · DeepInfra · Agnes · Ollama · vLLM · AWS Bedrock · StepFun · MiniMax

### 配置的质量门控（Quality Gates）

在启用验证管线的路径上，Commander 在返回结果前运行以下 5 项配置的检查：

| 门控 | 检查内容 |
| ------------- | ------------------------------------------- |
| 幻觉检测 (Hallucination) | 基于 LLM-as-Judge 检测编造的事实 |
| 一致性 (Consistency) | 跨智能体一致性，杜绝自相矛盾 |
| 完整性 (Completeness) | 覆盖所有必需维度 |
| 准确性 (Accuracy) | 对照源材料的事实正确性 |
| 安全性 (Safety) | 内容扫描与提示注入检测 |

如果输出未能通过配置的门控，系统会重试或附带完整上下文报告失败。

### 弹性与容错（Resilience）

| 能力 | 实现机制 |
| ----------------- | ------------------------------------------------------------------ |
| 断路器 (Circuit Breakers) | 三态（CLOSED/OPEN/HALF-OPEN），单提供商错误率跟踪 |
| 死信队列 (Dead Letter Queue) | 追加写入 NDJSON，7 种分类，支持重放 |
| Saga 补偿 (Saga Compensation) | 注册补偿步骤；外部回滚无法绝对保证 |
| 检查点 (Checkpointing) | SQLite + WAL，崩溃安全恢复（目标 <5s） |
| 语义缓存 (Semantic Caching) | SHA-256 精确匹配 + 余弦相似度去重 |

### 安全体系（Security）

AES-256-GCM 加密密钥库。进程内防篡改 HMAC 审计链（外部 WORM/KMS 存证待补齐）。基于权能令牌的 RBAC。ISO 42001 / NIST AI RMF 合规**报告脚手架**（生成报告工具，非认证证书）。红队评估框架（47 个场景，8 类攻击）。基于请求上下文的租户作用域（AsyncLocalStorage）；存储层隔离为 opt-in —— Enterprise Gateway，alpha。

### 自我优化（Self-Optimization）

基于 Thompson Sampling 与 Reflexion 的元学习器跨运行调优智能体配置。它学习哪种拓扑最适合何种任务类型、哪个提供商速度最快、以及哪种参数组合产生最高质量的结果。在记录 5 次以上运行后激活。

---

## 架构

```
                        ┌──────────────────────────────┐
                        │      DELIBERATION ENGINE      │
                        │  Task classification          │
                        │  Complexity estimation        │
                        │  Topology selection           │
                        └──────────┬───────────────────┘
                                   │
                        ┌──────────▼───────────────────┐
                        │       TOPOLOGY ROUTER          │
                        │  SINGLE · CHAIN · DISPATCH     │
                        │  ORCHESTRATOR · REVIEW          │
                        └──────────┬───────────────────┘
                                   │
                ┌──────────────────┼──────────────────┐
                ▼                   ▼                   ▼
         ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
         │   AGENT 1    │   │   AGENT 2    │   │   AGENT N    │
         │  LLM → Tool  │   │  LLM → Tool  │   │  LLM → Tool  │
         │  → Verify    │   │  → Verify    │   │  → Verify    │
         └──────┬───────┘   └──────┬───────┘   └──────┬───────┘
                └──────────────────┼──────────────────┘
                                   ▼
                        ┌──────────────────────────────┐
                        │         SYNTHESIS              │
                        │  Merge · Resolve conflicts    │
                        └──────────┬───────────────────┘
                                   ▼
                        ┌──────────────────────────────┐
                        │       QUALITY GATES           │
                        │  Hallucination · Consistency  │
                        │  Completeness · Accuracy     │
                        │  Safety                      │
                        └──────────┬───────────────────┘
                                   ▼
                                RESULT
```

---

## Web 控制台

Commander 包含基于 Web 的控制台，用于可视化监控、基于对话的智能体交互和治理：

```bash
# 需要 PostgreSQL 以及显式设置的 JWT_SECRET 和 ADMIN_PASSWORD；详见 docs/deploy.md。
# 在 :4000 启动 API，在 :5173 启动 Web，随后打开浏览器。
pnpm gui
```

打开 `http://localhost:5173`。控制台路由清单：

| 路由 | 页面说明 |
| ---------------------------- | --------------------------------------------------------------------------------------- |
| `/`                          | 仪表盘 — 战报、Token 趋势、实时拓扑、智能体花名册、任务看板 |
| `/agents`                    | 智能体花名册 |
| `/missions`                  | 任务看板与审批队列 |
| `/execution`                 | 实时执行动态源 |
| `/memory`                    | 记忆浏览器与检索 |
| `/governance`                | 审批队列与策略统一配置 |
| `/security`                  | 安全态势 — ISO 42001 / NIST AI RMF **报告脚手架**（生成报告工具，非认证证书） |
| `/slo`                       | SLO 监控面板 |
| `/chat`                      | 对话交互界面，支持智能体实时流式输出 |
| `/dlq`                       | 死信队列管理与重放 |
| `/audit`                     | 审计日志 |
| `/cost`                      | 成本与 Token 用量报告 |
| `/knowledge`                 | 知识库管理 |
| `/alerts`                    | 告警中心 |
| `/onboarding`                | 首次使用引导 |
| `/users`                     | 用户管理 |
| `/settings`, `/settings/sso` | 系统设置与 OIDC/SSO 单点登录配置 |
| `/workflows`                 | 工作流列表与调度 |
| `/poc`                       | POC / 演示视图 |
| `/research`                  | 调研视图 |
| `/actions`                   | Action Gateway 队列（审批 / 拒绝 / 补偿） |

当使用 Compose 的 `web` profile 而非 `pnpm gui` 运行时，控制台运行在 `http://localhost:3000`。

---

## 可靠性目标

| 目标 | 预期指标 | 实现机制 |
| ------------------- | ---- | -------------------------- |
| 检查点恢复 | <5s  | SQLite + WAL               |
| 提供商故障转移 | <10s | 自动回退链 |
| Saga 补偿 | <30s | 补偿调度器 |
| DLQ 队列处理 | <60s | 追加写入 NDJSON，支持重放 |

---

## 基准测试

> 以下所有基准测试均运行在**模拟/脚本化测试套件**或作为 **CI 基线**。它们衡量的是测试工具本身，而非生产环境 SLA 或 SOC 审计凭证。

| 套件 | 覆盖范围 | 结果 |
| ----------------- | ----------------------------------------- | ------------------------------------------------- |
| 混沌工程 (Chaos Engineering) | 200 个合成案例 + 55 个变异案例（共 255） | 测试套件入口；结果见基准矩阵保留数据 |
| 红队 (Red Team) | 47 个场景、8 类攻击 | 所列用例均已阻断（模拟套件） |
| AgentDojo | 12 个安全测试案例 | 所列用例均已阻断（模拟套件） |
| GAIA Spine | 核心能力基准 | 已调度快速/离线运行；完整 fixture 待补齐 |
| SLO | API 可用性 99.95%、P95 调度延迟 <5s | CI 基线，非生产环境 SLA |

完整矩阵：[BENCHMARK.md](BENCHMARK.md)

---

## 健康检查

```bash
curl http://localhost:4000/health          # 基础存活探针 (200 / 503)
curl http://localhost:4000/health/detailed # 全组件详细状态
curl http://localhost:4000/ready           # 就绪探针 (DB, kernel, 存储)
curl http://localhost:4000/v1/health       # Gateway 收敛就绪探针
curl http://localhost:4000/metrics         # Prometheus 指标
curl http://localhost:4000/system/status   # 运行时模块摘要
```

不存在 `/readyz` 或 `/livez` 别名 —— API 就绪端点为 `/ready`。

监控项：内存、断路器、DLQ 容量、检查点延迟、待处理补偿、事件总线积压、提供商可用性、磁盘空间。

---

## 为什么选择 Commander

一旦智能体的操作触达外部系统，超时或崩溃就会留下三个悬而未决的问题：操作是否发生、发生了几次、携带了什么载荷。盲目重试可能导致重复写入；直接放弃可能丢失操作。

Commander 将已批准的请求及其执行状态保存在智能体外部，在响应模糊时查询真实结果，并在证据不确定时停留在明确的未知状态。撤销副作用是单独发起并需单独批准的操作。

GitHub 原生权限和 Actions 审批等控制手段通常已足够。Commander 适用于需要在智能体与工作节点间维护统一审批与恢复记录的团队。

---

## 文档体系

- [docs/architecture/](docs/architecture/000-index.md) — 架构决策记录（ADR：V2 资源模型、状态机、持久化、身份体系、Effect Broker、Worker 协议、事件语义）
- [docs/getting-started.md](docs/getting-started.md) — 快速上手指南
- [docs/deploy.md](docs/deploy.md) — 部署指南
- [docs/v2-migration-guide.md](docs/v2-migration-guide.md) — 架构 V2 迁移指南
- [docs/slo.md](docs/slo.md) — SLO 指标定义
- [docs/content/why-retrying-ai-agent-external-actions-is-unsafe.md](docs/content/why-retrying-ai-agent-external-actions-is-unsafe.md) — 故障模型解析：为什么重试 AI Agent 的外部操作是不安全的
- [SECURITY.md](SECURITY.md) — 安全模型、威胁模型与合规
- [BENCHMARK.md](BENCHMARK.md) — 完整基准测试矩阵与方法学
- [CHANGELOG.md](CHANGELOG.md) — 发布历史记录

## 公共边界与反馈

- **真实 vs 模拟：** 新手引导任务结果仅在 UI/API 报告 `source=real` 时为真实执行；回退与 POC 均为模拟/演示数据。
- **隐私：** 提示词可能会发送给所选 LLM 提供商，本地追踪、记忆、审计数据及可选的 OpenTelemetry 导出可能被持久化。录入敏感数据前请参阅 [PRIVACY.md](PRIVACY.md)。
- **Bug 报告：** 请提交 [GitHub issue](https://github.com/PStarH/Commander/issues)，并提前脱敏提示词、日志、配置、PII 和密钥。
- **问题与建议：** 请提交 [GitHub issue](https://github.com/PStarH/Commander/issues)。
- **安全漏洞：** 请遵循 [SECURITY.md](SECURITY.md) 流程私下披露；请勿提交公开 issue。

---

## 许可证

MIT。详见 [LICENSE](LICENSE) 与 [COPYRIGHT.md](COPYRIGHT.md)。

---

<p align="center">
  <sub>为触达外部系统的智能体操作提供审批与恢复。</sub>
</p>
