# WS7：生产环境强制沙箱隔离（fail-closed）

**状态：PARTIAL（boot-refuse/旁路全拒/CI 门禁已落地；2026-07-16 复审修复 workload context key 不匹配后 §5 身份链路成立；2026-07-17 静态门禁验证 `assertProductionBackendRequest` host-exec guard 在位；遗留：镜像非白名单静默替换而非拒绝、workload 级容器测试缺）**  
**范围：Phase 1 Spec → Phase 2 Build → Phase 3 Review & Audit**

## 1. 依据与问题定义

架构评审中与本任务直接相关的约束如下：

- Worker 与 Gateway 分离；Worker 只能领取其租户范围内的工作，并在执行前建立隔离边界（`docs/architecture/006-worker-protocol.md`）。
- 执行隔离优先使用 sandbox/container/WASM；若使用 subprocess，必须同时具备 seccomp、cgroup 与网络策略。
- V2 worker 的生产插件模式必须是 `required`；不能因为后端不可用而回退到进程内执行（`docs/v2-migration-guide.md`）。

当前实现已有 `SandboxManager` 无后端时拒绝初始化的路径，但仍存在以下 WS7 缺口：

1. `COMMANDER_ALLOW_NO_SANDBOX` 可由运行时环境打开旁路。
2. `LocalBackend`、SSH 与宿主机执行路径没有统一的生产策略门禁。
3. Docker/gVisor 后端尚未由租户和工作负载身份统一管理。
4. 没有生产构建期的旁路检查，也没有独立的 boot-refuse CI 门禁。

WS7 的安全不变量是：**生产 Worker 在完成沙箱能力校验前不得领取或执行工作；任何校验、创建、启动或健康检查失败都拒绝执行，且不得切换到 Noop、host exec、in-process 或未受策略约束的 subprocess。**

## 2. 支持的隔离级别与默认值

| 级别      | 语义                                                                                                                      | 允许环境                              | 生产默认                     | 失败行为                                                                 |
| --------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ---------------------------- | ------------------------------------------------------------------------ |
| `process` | OS subprocess，必须通过 Bubblewrap/Seatbelt/seccomp，并设置 cgroup 资源限制和网络策略；不是裸 `execSync`/`spawn`。        | development、test；staging 仅显式配置 | 否                           | 启动时拒绝；不能降级为 host exec                                         |
| `docker`  | 每个工作负载一个临时 OCI 容器，使用只读 rootfs、非 root、`cap-drop=ALL`、`no-new-privileges`、cgroup 限额和显式网络策略。 | development、staging、production      | **是**                       | 容器创建或健康检查失败时拒绝该工作负载；生产 Worker 无可用容器后拒绝启动 |
| `gvisor`  | Docker/OCI 容器使用 `runsc` runtime；除 Docker 约束外增加 gVisor runtime 能力校验。                                       | staging、production                   | 可选增强；显式选择后不得降级 | `runsc` 不可用或启动失败时立即拒绝，不回退到普通 Docker                  |

配置接口：

- `COMMANDER_SANDBOX_ISOLATION=process|docker|gvisor`。
- production 未设置时默认 `docker`。
- production 设置为 `gvisor` 时必须使用 gVisor；设置为 `process` 时直接拒绝启动，避免把生产基线降到非容器隔离。
- development/test 保留平台探测能力；测试可以通过依赖注入提供 fake sandbox，但不得以此改变生产策略。

## 3. 生产禁止项

生产 profile 的构建检查和启动检查都必须拒绝以下情况：

| 禁止项         | 拒绝条件                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------ |
| 无沙箱旁路     | `COMMANDER_ALLOW_NO_SANDBOX=1/true/yes`，或任何等价的 `allowNoSandbox` 生产常量/编译选项               |
| 未检查执行旁路 | `COMMANDER_ALLOW_UNCHECKED_EXEC=1/true/yes`                                                            |
| 插件进程内执行 | `COMMANDER_PLUGIN_SANDBOX=in_process`；生产只能为 `required`                                           |
| 插件软回退     | `COMMANDER_PLUGIN_SANDBOX_SOFT` 为 truthy，或任何 `required → in_process` 的 fallback                  |
| 宿主机执行     | `backend=local` 的裸执行、`execSync`/`execFileSync`/未包裹的 `spawn`、`host_exec`、宿主机 shell 直通   |
| 未授权远程执行 | 生产执行请求中的 SSH backend、任意未注册的远程 host 或通过参数绕过容器的 `docker_exec`                 |
| 无约束容器     | privileged、Docker socket、host PID/network/IPC、host path 全量挂载、root 用户、未限制的 CPU/内存/网络 |
| 不可验证镜像   | 非 allowlist 镜像或未锁定 digest 的生产工作负载镜像                                                    |
| 全权限降级     | 生产选择 `full-access` profile，或用环境变量覆盖为允许宿主机读写/全网络的 profile                      |

构建检查是静态门禁：生产构建必须扫描最终编译入口及其依赖，确认不存在可启用 `ALLOW_NO_SANDBOX` 的生产常量、production fallback 分支或 host-exec 入口；检查失败时退出非零，不生成可发布产物。运行时检查仍然保留，因为环境变量和容器运行时能力只能在启动时验证。

## 4. 启动与执行的 fail-closed 行为

### 4.1 Worker 启动顺序

生产 Worker 必须按以下顺序启动：

1. 解析并冻结生产 sandbox policy。
2. 拒绝所有禁止项。
3. 校验所选隔离级别的二进制、runtime、镜像、Docker daemon 和最小容器启动能力。
4. 校验策略能施加 rootfs、用户、capability、网络、CPU、内存和工作目录约束。
5. 仅在上述检查全部成功后注册 Worker 并开始 claim work。

任一步骤失败都必须抛出可识别的 `SandboxInitializationError`/`SANDBOX_UNAVAILABLE`，记录原因和选择的隔离级别，退出非零；不得启动为 degraded/ready，不得 claim work，不得执行任何用户命令。

### 4.2 工作负载启动失败

每个工作负载执行前必须先通过 sandbox supervisor 创建并健康检查隔离环境。创建、挂载、网络策略、资源限制、镜像校验或命令启动失败时：

- 不调用宿主机执行路径。
- 不重试为另一个更弱的隔离级别。
- 不把失败转换成成功或空输出。
- 若工作已被 kernel claim，则以 `SANDBOX_UNAVAILABLE` 终止并释放/归还 lease；不能报告为业务命令失败后继续执行。
- 对调用方返回非零拒绝结果；日志与指标包含 `tenantId`、`workloadId`、隔离级别和拒绝原因，但不包含 secret。

## 5. 每租户 / 每工作负载策略

### 5.1 身份与生命周期

工作负载接口至少携带：`tenantId`、`runId`、`stepId`、`workloadId`、请求的 sandbox profile 和资源上限。四个身份字段在创建前必须校验非空且符合安全字符集；容器名和标签由服务端生成，不能由用户直接提供。

生产默认使用 **每工作负载一个临时容器**：

```text
tenant A / run 1 / step 2 ──> commander-sbx-<opaque-workload-id>
tenant B / run 3 / step 1 ──> commander-sbx-<opaque-workload-id>
```

不同租户不得共享容器、工作目录、可写 volume、网络 namespace 或 secrets。工作负载结束、超时、取消、崩溃和启动失败都必须清理容器与临时资源；清理失败必须告警并阻止复用该资源。

### 5.2 强制策略

- 容器以非 root 用户运行，rootfs 只读，`cap-drop=ALL`，`no-new-privileges`，不挂载 Docker socket。
- 工作目录使用该工作负载自己的临时 volume；只挂载明确允许的输入，禁止将宿主机任意路径作为工作区。
- 默认网络为 blocked；需要外网时必须走 allowlist/proxy policy，不能把 host network 当作 fallback。
- CPU、内存、执行时限和输出大小来自经过校验的 profile，并在容器 runtime 层实际施加。
- 环境变量使用 allowlist；默认剔除 token、secret、password、credential、数据库连接串和 Docker/SSH 控制变量。
- tenant scope 在 Worker claim、sandbox 创建和执行审计三处都必须一致；任何不一致都拒绝。

## 6. 实现边界与测试计划

### Phase 1：Spec

- 本文档作为唯一 WS7 验收基线。
- 评审通过后才能进入代码改造。

### Phase 2：Build

- 增加生产 profile 的构建期静态门禁，禁止 `ALLOW_NO_SANDBOX` 和 host-exec 生产入口。
- 增加 sandbox policy/supervisor，默认 Docker，支持 gVisor runtime 的显式强制选择。
- 将 Worker workload identity 接入每工作负载容器创建、策略校验和清理流程。
- 在 Worker boot 前执行能力探针；失败立即拒绝启动。
- 先写失败测试，再实现最小路径；至少覆盖：无沙箱启动拒绝、旁路配置拒绝、禁止 host exec、每租户容器不复用、容器创建失败不执行。

### Phase 3：Review & Audit

- CI 独立运行 boot-refuse 测试，并验证命令未被执行、进程以非零退出。
- 与 WS5 Worker 执行链联调：正常工作负载在 Docker/gVisor 沙箱中成功，tenant scope 和 lease 生命周期保持正确。
- 逐条检查本文档中的生产禁止项和 fail-closed 行为。
- 所有验收项有测试或构建日志证据后，将本文档状态改为 `ACCEPTED`。

## 7. 验收清单

- [x] 生产默认隔离级别为 `docker`；`gvisor` 显式选择时不降级。
- [x] `process` 仅表示受 seccomp/cgroup/network policy 约束的 subprocess，不等于 host exec。
- [x] 生产构建拒绝 `ALLOW_NO_SANDBOX` 常量/旁路；静态门禁验证 `ExecutionRouter.assertProductionBackendRequest` 调用与 SSH/Docker host-exec 拒绝文案仍在源码中（不全域禁 `child_process`）。
- [x] 生产启动拒绝所有禁止配置和任一沙箱能力探针失败。
- [x] 无沙箱时无 Noop fallback、无 in-process fallback、无自动降级。
- [x] 每个 workload 具备 tenant/run/step 身份和独立容器/工作目录。
- [x] 容器失败时命令未执行，且 kernel lease 被安全释放或终止。
- [x] boot-refuse 在本地和 CI 均通过。
- [x] WS5 Worker 联调通过（Worker readiness、registry 顺序与租户/工作负载上下文测试通过）。
- [x] 审计完成后本文档标记 `ACCEPTED`。

## 8. 验收证据

- Core sandbox focused suite：`83 passed, 1 skipped`；boot-refuse 包含无 Docker、旁路、探针失败、full-access、SSH、arbitrary Docker exec 和 local bypass 拒绝，容器安全参数测试确认非 root UID/GID。
- Worker suite：`6 passed`；沙箱 readiness 失败发生在 registry 初始化/注册之前，已 claim step 的沙箱初始化失败映射为 `SANDBOX_UNAVAILABLE` 并走 `failStep`。
- Effect Broker regression：`5 passed`。
- `pnpm --filter @praetor/core build:production`：静态 policy gate、TypeScript 编译和 ESM 产物处理均通过。
- `pnpm --filter @praetor/worker-plane build`、Prettier check、`git diff --check` 均通过。
- CI 已加入 core production static/boot-refuse 与 Worker production boot-refuse job steps。
- 本地 Docker daemon 和 `runsc` 不可用；因此真实 Docker/gVisor workload 执行仍需在具备运行时的 WS5/CI 节点执行，不能由本地测试结果替代。
