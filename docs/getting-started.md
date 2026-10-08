# Commander 快速开始

先用不需要凭据的 E0 模拟路径验证安装，再按需运行 provider-backed CLI 或 Web
Console。

> **Alpha / 非生产就绪：** 本文是开发与评估路径。provider-backed 任务会把 prompt
> 发送给你选择的提供商；模拟结果会明确标识，不能当作真实执行或生产证据。详见
> [`PRIVACY.md`](../PRIVACY.md)。

下文首先给出 **E0 模拟演示**，它不调用真实 provider、不写入外部目标系统。随后
的 provider-backed Local CLI 与 Enterprise Gateway（`/v1` + Postgres）均为
**alpha**；后者见英文 `README.md` SKU 表与 `ENTERPRISE_READINESS.md`。

---

## 前置要求

- **Node.js** 22.x（与 `.node-version` 和 CI 一致）
- **pnpm** 9（Corepack 会选择仓库固定的版本；项目使用 pnpm workspaces）
- E0 模拟演示不需要 API key；只有 provider-backed 路径才需要

> 为什么用 pnpm？Monorepo 通过 workspaces 管理 10+ 个包，`npm install` 会产生 `UNMET DEPENDENCY` 警告。

---

## 1. 克隆与安装

```bash
git clone https://github.com/PStarH/Commander.git
cd Commander
corepack enable
pnpm install --frozen-lockfile
```

安装完成后，建议先构建一次所有包：

```bash
pnpm build
```

首次克隆和冷安装仍需要正常访问 GitHub 与包仓库。下文的 `--offline` 只表示不向
LLM provider 发请求，并不表示安装过程完全断网。

---

## 2. 运行 E0 模拟演示（推荐首次运行）

```bash
pnpm exec tsx packages/core/src/cliEntry.ts --help
pnpm exec tsx packages/core/src/cliEntry.ts doctor --offline
pnpm demo:l4-a
```

`doctor --offline` 只检查本地前置条件，不访问 LLM provider。`demo:l4-a` 使用
模拟/内存依赖和本机回环服务器，不调用真实 provider，也不写入外部目标系统。
克隆、安装和构建仍会写入本机 checkout、依赖缓存和构建产物。命令退出时会自动
关闭它启动的回环服务器，因此没有外部资源需要 teardown；命令退出即完成 E0
清理。

这条路径只提供开发/演示证据，不代表已通过 npm 发布安装、E1 受治理写入证明或
生产就绪验证。

---

## 3. 配置 API Key（仅 provider-backed 路径）

Commander 会自动识别你设置的是哪家提供商：

```bash
export OPENAI_API_KEY=sk-...
# 或
export ANTHROPIC_API_KEY=sk-ant-...
# 或
export DEEPSEEK_API_KEY=sk-...
```

支持的完整列表见 `packages/core/src/runtime/providers/`（共 25 家 provider，
注册表位于 `providerRegistry.ts`）。

---

## 4. 运行真实 provider 的只读代码审查

以下命令是首用户唯一推荐的真实 provider 路径。运行前请先阅读
[`PRIVACY.md`](../PRIVACY.md)。

```bash
export OPENAI_API_KEY=sk-...
pnpm exec tsx packages/core/src/cliEntry.ts review \
  --commit HEAD --real --provider=openai
```

```bash
export ANTHROPIC_API_KEY=sk-ant-...
pnpm exec tsx packages/core/src/cliEntry.ts review \
  --commit HEAD --real --provider=anthropic
```

该命令只读取指定 Git diff 和本地 review guidelines，最多发送 15,000 个 diff
字符，并将 provider 输出限制为 4,000 tokens；超过 8 MiB 的响应正文会在 JSON 解析前
被拒绝，120 秒后会中止 provider 传输。
provider/model 不会收到任何执行工具，因此不能主动执行命令、修改文件、
访问 Web 或写入目标系统。CLI 本身会运行固定的只读 `git diff` 子进程，并在系统临时
目录更新跨进程限流状态。结果会标明 `source=real`、provider、model、endpoint
host、prompt 字节数、截断后实际覆盖范围和完成响应上限；凭据缺失、空 diff、provider
错误、超时、超限响应或无效结构化输出都会返回非零退出码，不会静默回退到模拟结果。

diff 和 guidelines 会离开本机，可能包含仓库敏感信息，并受 provider 的保留政策
约束。guidelines 会从 `AGENTS.md`、`.review.md`、`REVIEW.md`、
`.github/review.md` 和 `.commander/review.md` 的 Markdown 列表项自动收集，并限制为
合并后的前 1,000 字符。普通 `commander run`、`pnpm gui`、MCP、SDK 和 Enterprise
Gateway 不属于该首用户路径，目前不能宣称只读或生产就绪。

---

## 5. Enterprise Gateway（alpha）

这是需要凭据和外部服务的 Enterprise Gateway alpha 开发路径，不是 E0 演示的
替代安装方式，也不代表 E1 已就绪：

首次用户文档不提供可直接运行的 Gateway 命令；该路径还需要额外密钥、PostgreSQL
和运维控制。请同时按照
[`enterprise/quickstart.md`](enterprise/quickstart.md) 与
[`ENTERPRISE_READINESS.md`](../ENTERPRISE_READINESS.md) 操作。

在任何 bounded write pilot 前，必须满足
[`design-partner-launch-readiness.md`](runbooks/design-partner-launch-readiness.md)
中的 E1 门槛；本节不能作为外部写入授权或证明。

---

## 6. 额外验证

```bash
pnpm --filter @praetor/core test:quick
```

这会运行核心单元测试的安全子集（约 30 秒）。

---

## 7. 下一步

- 查看架构概览：`docs/architecture/`
- 查看 CLI 全部命令：`pnpm exec tsx packages/core/src/cliEntry.ts --help`
- 查看 OpenAPI 规范：启动 API 后访问 http://localhost:4000/v1/openapi.json（标准 profile 也支持 `/api/openapi.json`）

---

## 常见问题

### `better-sqlite3` 安装失败

项目依赖 `better-sqlite3`，它需要本地编译。确保：

1. Node 版本与 `.node-version` 一致（Node 22）。
2. 已安装 Python 3 和 C++ 编译工具：
   - macOS: `xcode-select --install`
   - Windows: Visual Studio Build Tools
   - Linux: `build-essential`

如果仍失败，可设置 `API_STORE_BACKEND=memory` 跳过 SQLite 持久化（生产环境下
还需要显式设置 `COMMANDER_ALLOW_MEMORY_STORE=1`，否则会 fail-closed 拒绝启动）。
内存存储不持久化任何状态，仅用于开发。

### `npm install` 出现 UNMET DEPENDENCY

请使用 `pnpm install`。README 和 CI 均以 pnpm 为准。
