# Commander Enterprise Gateway（alpha）租户部署层（Bridge / Silo / Pool）

本目录补充 **Enterprise Gateway（alpha）** 的租户部署层能力草案，与 `packages/core/src/runtime` 中的 `TenantProvider`、`TenantContext`、`SqliteMemoryStore` 等运行时机制配套。**不是**已验证的完整多租户 SaaS 方案；存储层隔离为 opt-in，请对照 `ENTERPRISE_READINESS.md`。

## 1. 三种部署模型

| 模型 | 隔离级别 | 数据目录 | 适用场景 |
|------|----------|----------|----------|
| **Pool** | 逻辑隔离，共享运行时与存储 | 不创建独立目录，仅通过 `tenantId` 区分 namespace | 开发/测试、或共享池试验租户（逻辑隔离 only；勿当生产 SaaS 强隔离） |
| **Bridge** | 共享容器/进程，但独立数据子目录 | `data/bridge/<tenantId>/{memory,runs,logs,artifacts,storage}` | 标准试验租户，需要数据目录隔离但共享基础设施 |
| **Silo** | 独立容器/命名空间/存储卷 | `data/tenants/<tenantId>/{memory,runs,logs,artifacts,storage}` | 高级/合规试验租户，强隔离、独立资源 |

运行时通过 `TenantConfig.isolation` 字段识别模型：`pool | bridge | silo`。

## 2. 目录结构

```
deploy/
├── scripts/
│   ├── create-tenant.sh      # 创建租户
│   ├── destroy-tenant.sh     # 销毁租户
│   ├── migrate-tenant.sh     # 模型迁移
│   └── __tests__/
│       └── create-tenant.test.sh
├── docker/
│   ├── silo.docker-compose.yml    # Silo 独立容器模板
│   ├── bridge.docker-compose.yml  # Bridge 共享容器模板
│   └── kernel-tls/                # v2/cell 内核数据库 TLS 材料：生成脚本 + Postgres 入口包装
├── k8s/
│   └── tenant-namespace.yaml      # Namespace + ConfigMap + Secret + PVC 模板
└── README.md
```

## 3. 快速开始

### 3.1 创建租户

```bash
# Pool 租户（仅配置，无独立目录）
./deploy/scripts/create-tenant.sh demo-pool starter pool

# Bridge 租户（共享容器，独立子目录）
./deploy/scripts/create-tenant.sh demo-bridge standard bridge

# Silo 租户（独立容器/卷）
./deploy/scripts/create-tenant.sh demo-silo premium silo
```

输出示例：

```
Tenant created: demo-silo
  Tier:            premium
  Deployment:      silo
  Token budget:    500000
  Max concurrency: 10
  Max runs/min:    120
  API key:         a1b2c3d4...
  Config file:     /.../config/tenants.json
  Data directory:  /.../data/tenants/demo-silo
```

生成的租户级 API Key 同时写入 `.commander/tenant-api-keys.json`。

### 3.2 销毁租户

```bash
# 交互式确认后删除配置与数据目录
./deploy/scripts/destroy-tenant.sh demo-silo

# 强制删除，跳过确认
./deploy/scripts/destroy-tenant.sh demo-silo --force
```

Pool 租户仅移除配置；Silo / Bridge 会额外删除对应数据目录。

### 3.3 迁移租户

支持以下过渡：

- `pool -> bridge`
- `pool -> silo`
- `bridge -> silo`

```bash
# 实际迁移
./deploy/scripts/migrate-tenant.sh demo-pool bridge

# 仅预览
./deploy/scripts/migrate-tenant.sh demo-pool silo --dry-run
```

迁移会复制 SQLite DB、JSON store、runs 等数据到新目录，并更新 `tenants.json` 的 `isolation` 与路径字段。

## 4. 环境变量覆盖

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `TENANT_CONFIG_PATH` | `tenants.json` 路径 | `$PROJECT_ROOT/config/tenants.json` |
| `COMMANDER_DATA_ROOT` | 数据目录根 | `$PROJECT_ROOT/data` |
| `TENANT_KEYS_PATH` | 租户 API Key 文件 | `$PROJECT_ROOT/.commander/tenant-api-keys.json` |

## 5. Docker 部署

> **本节模板为不受支持的遗留拓扑示意，不是可用的部署路径。**
> `deploy/docker/*.docker-compose.yml` 未提供六个必需的 API 启动凭据、kernel/Postgres DSN 与数据库 TLS 材料，容器会在启动校验阶段退出；`envsubst` 渲染到 `/tmp` 还会产生相对路径问题。
> 受支持的部署方式请使用 [`docs/deploy.md`](../docs/deploy.md) 中的 Compose profile 与 Helm 分阶段生命周期；本节仅用于说明 Bridge/Silo 的拓扑差异。

### 5.1 Silo（每租户独立容器）

```bash
# 遗留示意（不可直接启动生产服务）
export TENANT_ID=demo-silo
export COMMANDER_API_KEY=$(openssl rand -hex 32)
export API_PORT=4000

envsubst < deploy/docker/silo.docker-compose.yml > /tmp/silo-${TENANT_ID}.yml
docker compose -f /tmp/silo-${TENANT_ID}.yml up -d
```

容器内环境变量：

- `TENANT_ID=demo-silo`
- `DEPLOYMENT_MODEL=silo`
- `COMMANDER_DATA_ROOT=/data`

独立卷 `silo-data-${TENANT_ID}` 挂载到 `/data/tenants/${TENANT_ID}`。

### 5.2 Bridge（多租户共享容器）

```bash
# 遗留示意（不可直接启动生产服务）
export BRIDGE_GROUP=team-alpha
export TENANT_IDS="tenant-a,tenant-b"
export COMMANDER_API_KEY=$(openssl rand -hex 32)
export API_PORT=4001

envsubst < deploy/docker/bridge.docker-compose.yml > /tmp/bridge-${BRIDGE_GROUP}.yml
docker compose -f /tmp/bridge-${BRIDGE_GROUP}.yml up -d
```

容器内环境变量：

- `DEPLOYMENT_MODEL=bridge`
- `TENANT_IDS=tenant-a,tenant-b`
- `COMMANDER_DATA_ROOT=/data`

共享卷 `bridge-data-${BRIDGE_GROUP}` 挂载到 `/data/bridge`，各租户按 `data/bridge/<tenantId>` 子目录写入。

## 6. Kubernetes 部署

> **本节模板同样为不受支持的遗留示意。** `deploy/k8s/tenant-namespace.yaml` 只创建 Namespace / ConfigMap / Secret / PVC，不含工作负载（Deployment/StatefulSet）、镜像、健康检查或数据库材料；需自行在其上叠加，且 `envsubst` 会注入相对路径。
> 受支持的 Kubernetes 部署请使用 [`docs/deploy.md`](../docs/deploy.md) 中的 `deploy/helm/commander` chart 与租户权威生命周期。

模板位于 `deploy/k8s/tenant-namespace.yaml`，使用 `envsubst` 渲染后应用：

### 6.1 Silo 租户

```bash
export TENANT_ID=demo-silo
export TENANT_API_KEY=$(openssl rand -hex 32)
export TENANT_STORAGE=10Gi

envsubst < deploy/k8s/tenant-namespace.yaml | kubectl apply -f -
```

创建：

- Namespace `commander-silo-${TENANT_ID}`
- ConfigMap `commander-tenant-config`
- Secret `commander-tenant-apikey`
- PVC `commander-silo-data`

### 6.2 Bridge 租户组

```bash
export BRIDGE_GROUP=team-alpha
export TENANT_IDS="tenant-a,tenant-b"
export COMMANDER_API_KEY=$(openssl rand -hex 32)
export BRIDGE_STORAGE=50Gi

envsubst < deploy/k8s/tenant-namespace.yaml | kubectl apply -f -
```

创建：

- Namespace `commander-bridge-${BRIDGE_GROUP}`
- ConfigMap `commander-bridge-config`（含多租户 `TENANT_IDS`）
- Secret `commander-bridge-apikey`
- PVC `commander-bridge-data`

> 注意：Deployment / StatefulSet 需要另外叠加，可参考 `deploy/helm/commander` 基础 Chart。

## 7. 与运行时的集成

- `apps/api/src/tenantProviderLoader.ts` 在启动时读取 `config/tenants.json`，初始化 `SimpleTenantProvider`。
- `tenantContextMiddleware` 将请求中的租户身份绑定到 `AsyncLocalStorage`，使 `getCurrentTenantId()` 在后续调用链中生效。
- `SqliteMemoryStore` 使用 `tenant_id` 列在数据库层隔离数据；Silo/Bridge 模型通过独立文件目录进一步隔离。
- `ThreeLayerMemoryRegistry` 为每个租户维护独立的内存实例。

## 8. 测试

```bash
# Bash 集成测试
bash deploy/scripts/__tests__/create-tenant.test.sh

# TypeScript 测试（vitest）
pnpm --filter @praetor/core test tests/deployment/tenantDeployment.test.ts
```

测试会：

1. 在临时目录创建 `tenants.json` 与 `data/`。
2. 验证 `create-tenant.sh` 对 pool/bridge/silo 的目录与配置行为。
3. 验证 `migrate-tenant.sh` 的 `--dry-run` 与实际迁移。
4. 验证 `destroy-tenant.sh` 的 `--force` 删除与 API Key 清理。
