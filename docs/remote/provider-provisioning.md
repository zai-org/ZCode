# Remote Provider Provisioning

## 状态

当前实现规范。此能力只表示一次由 Desktop 发起的 Local Environment → Remote Environment
配置 Provisioning，不改变远程 Workspace 的 Provider/Model 权威边界，也不恢复历史
`workspace/updateProviderRegistry` 快照同步。Desktop 模型配置页始终绑定 Local Environment，
不提供远程配置编辑或手动同步入口。

## 目标

在 Remote Environment 上线，以及本地模型配置、默认模型、账号状态或允许同步的凭据成功
保存后，把 Local Environment 的最新完整快照自动复制到每个在线 Remote Environment。此
v0 能力不提供远程配置管理 UI；本地 Environment 是编辑权威，远端只保存可丢弃的执行镜像。

## 不变量

独立 Server 发布 ready 前验证凭据安全存储。Linux 无 Secret Service 时，管理员须在
目标服务环境配置 `ZCODE_CREDENTIAL_SECRET_FILE`（目标机的受管 secret 文件，32–4096
字节、原字节读取）或既有 `ZCODE_CREDENTIAL_SECRET`，不可同时配置。systemd/launchd
应在服务环境持久配置文件位置，而非只在临时 shell 设置。重启时必须保留同一密钥；
不能从 Desktop 复制系统主密钥，也不能自动降级到可推导密钥。
Docker Web App 的 `scripts/docker-run-web-app.sh` 将显式文件只读挂载到容器；可以用
`ZCODE_CREDENTIAL_SECRET_FILE=/path/to/managed-secret scripts/docker-run-web-app.sh` 启动。
文件应由管理员以 0600 或受控只读 secret mount 提供，并保证容器运行用户 UID 10001
可读取；只读挂载不会自动改变宿主文件的属主权限。程序不生成、不打印密钥；没有
安全后端时启动失败，不接受可能写入失败的 Provisioning。

SSH/WSL 的 Server 由 Desktop 按需启动，不能假设会读取 `.bashrc` 中的 export。
Desktop 对 SSH/WSL/Docker 按需启动显式传入 `--prepare-credentials`，在远端的 ZCode
配置目录准备私有 `credential-secret`（默认
`~/.zcode/v2/credential-secret`，32–4096 字节、0400/0600）。Server 会在没有显式环境配置时
读取这个文件，重新连接和进程重启均沿用它，不依赖 shell 类型。仅在没有显式配置、
已有文件和 v2 密文时创建随机密钥；在凭据锁和密钥锁内排他发布，不覆盖已有文件。
已有 v2 数据不换密钥；旧 v1 数据先用历史规则认证解密，再迁移到随机文件密钥。
显式 `ZCODE_CREDENTIAL_SECRET` / `ZCODE_CREDENTIAL_SECRET_FILE` 优先，错误的显式配置
不能回退到约定文件。不同数据根用各自配置目录，不能复制 Desktop 的系统密钥。
文件内容按原字节读取，包括换行；从环境变量迁移时须保证字节完全相同，不能用
自动追加换行的写法改变密钥。密钥丢失或被替换后不能恢复原密文，应独立备份管理。
缺少安全后端时，现有连接错误详情会保留上述文件名、目标配置目录和重连指引。

- 远端正式 `provider_config.json`、`model-selection.json`、`setting.json` 和 Credential Store
  仍是远端 Environment 的事实源。
- Provisioning 只写目标 Environment 的正式 Store，完成后由目标 Environment 自己重建
  Provider Config、Account Source 和 Registry。
- 不向 Remote Worker 注入完整 Registry、Runtime Model、API Key 快照或动态 Header。
- 不使用跨 Environment 的 `provider/updateAccountConfig`；该协议仍只属于远端 Host → 远端
  Worker 的进程内同步。
- Provisioning 不经过 relay，不在 Desktop Main、Renderer 或远端任务状态中持久化 Secret。
- 本地 allowlist 凭据删除会在下一次同步中删除远端同名凭据；非 allowlist 凭据不受影响。
- Desktop `continuous`、Mobile `replayable` 任务流和现有 workspace identity 路由保持不变。

## 触发与范围

### 自动触发

只对 SSH、WSL、Docker、Server remote 执行，并由成功持久化或 Environment 生命周期触发：

- 某个 Remote Environment 从零个在线连接变为至少一个在线连接；
- Personal Provider Config 保存成功；
- Configured Default 保存或清除成功；
- Provisioning Envelope 允许的账号窄设置保存成功；
- allowlist credential 保存或删除成功。

每次同步都以本地最新完整快照覆盖远端对应镜像，不检查远端是否已有配置，也不比较两端
是否相同。本地 Personal Config 为空时同样写入空值；allowlist 凭据采用 replace 语义。同步
首次连接时，只有 `applied` / `already-applied` 才能发布 Remote Workspace ready；首次返回
`failed`、`rollback_failed` 或 `unsupported` 时沿正式连接失败通道结束请求。已经发布的
Workspace 后续同步失败不拆除连接，只留下不含 Secret 的结构化 warning，并等待下一次真实
触发重新读取最新快照。

R3 Source Server 自动重连换代 `remoteSessionId` 时（`desktopRemoteSessions.ts handleReconnected`），
Desktop Main 先 dispose 绑定旧 session 的登记，再以新 `remoteSessionId` 重新登记同一 Environment key，
等价于该 Environment 重新上线：触发一次 `environment-online` 整份重下发，补齐离线期间的本地配置变更。
重连不是发布屏障，失败只记录结构化 warning，不拆除已恢复的 Workspace。

### Environment 级协调

Workspace 不是同步单位。同一 Remote Environment 的多个 Workspace、多个窗口共用 Desktop
Main 中的一条同步 lane：

```text
Workspace A ─┐
Workspace B ─┼─> Remote Environment key ─> single-flight lane ─> 一个在线 Host 执行
Workspace C ─┘
```

Main 只保存 Environment key、Host registration（含可选 sourceServerId）、trigger、generation、
最近一次执行结果（不含 Secret）和请求关联信息，不读取或转发配置与 Secret。被选中的 Window Host 在执行时重新读取最新 Local Source，并调用该
Environment 的 Remote Target。同步期间发生的新触发只推进 generation；当前轮结束后再读取
一次最新快照形成尾随同步，不为每个事件排队，也不使用固定延迟。

### 物理连接关闭与同步请求收口

Window Host 的 `ServerRemoteConnection` 同时拥有 transport、`SocketProtocol` 和
`ChannelClient` 的生命周期。显式断开、socket close/error 或握手失败时必须幂等释放该连接的
RPC 客户端与协议；未完成及等待 Initialize 的请求以 `ConnectionClosed` 拒绝，迟到响应不能
重新完成旧请求。连接关闭事件仍按既有 Source 生命周期通知上层。
`connectOnce` 在写入在线表前持有连接所有权；包括握手记录落盘失败、版本解析抛错在内的
全部失败出口，统一释放未发布连接一次。发布成功后由在线表接管，迟到的旧连接关闭不影响新连接。

```text
Provider apply 尚未返回 -> Source 断开 -> 旧 ChannelClient.dispose
                                      -> Host 返回同步失败 -> 旧 lane 收口
新 Source 连接 -> 同一 Environment 读取最新配置 -> 同步成功 -> Renderer attachment ready
```

远端配置文件已更新不等于整个 apply RPC 已结束；用户此时断开仍须满足上述契约。
不得跳过首次同步屏障，也不得通过 UI 延时、清空同步队列或额外重试规避悬挂请求。
WebSocket Server 与 SSH/WSL/Docker 共用的 Duplex 连接遵循同一规则；手机 relay 断线和
replayable attachment 恢复不代表物理 Source 终结，不触发此清理。不修改 workspace identity、
session 路由、desktop-continuous/web-remote-replayable 语义或持久化格式，无数据迁移。

回归覆盖：`serverRemoteConnectionLifecycle.test.ts` 以真实网络请求覆盖断开时未返回的 RPC、
新连接的 Environment 同步、迟到响应与重复释放；`r3-provisioning-gui` 保留删除后立即断开、
离线修改、组头重连、最新配置同步和继续对话的 GUI 断言。

### Desktop 模型配置页

无论当前激活的是本地还是远程 Workspace，模型配置页都通过 Local Environment 的
`IProviderSettingsService` 读取和写入本地 Provider/Model 配置。页面不读取远端 Provider
Settings，也不显示 Local → Remote 手动同步按钮。远端配置的修改只能由远端 Environment
自身的管理入口完成；首次连接自动 Provisioning 仍遵循上面的条件与失败语义。

页面中的模型连通性测试同样属于 Local Environment。激活远程 Workspace 时，测试必须选择本地
目录作为 Agent cwd，顺序为：远程 tab 记住的本地来源路径 → 已打开的本地 workspace → Local Host
的对话目录（`fileService.ensureConversationWorkspace()`，由 Host 解析并创建）。Provider 配置是本机
全局配置，测试不依赖项目；只打开远程项目、没有本地 tab 时也在本机测试。只有 Local Host 无法提供
对话目录时才返回不可用结果。任何情况下都不能把远程 `workspacePath`/`workspaceIdentity` 发送给
Local Host。

```text
SettingsPage
  └─ Model Provider section
       └─ ServiceProvider(localHostServices)
            └─ Local IProviderSettingsService

Active workspace (local / remote) ──仅决定工作区上下文，不改变模型配置数据源
```

### 校验边界

同步必须拒绝损坏的 JSON、未知的 Envelope 结构、allowlist 凭据的格式错误、凭据解密失败和
配置读取期间的事实变化；这些错误不能通过跳过字段或部分写入来掩盖。Personal Provider 的
运行时字段（例如 `api.baseURL`）允许以字符串暂存（包括尚未完成的值）进入 Personal Layer，但无效的 Provider
必须在 Registry 完整性校验时 fail-closed，不得阻断同一文件中其它合法 Provider 的同步或进入
可执行 Registry。非 allowlist 的 Credential 记录不属于同步事实，即使其值损坏也不应阻断
allowlist 凭据的读取；allowlist 条目本身仍必须是字符串且能够用 Source cipher 解密。

同步仍然是完整 Personal Layer 的原子替换，不静默丢弃或部分覆盖 Provider；无效 Provider
保留在目标 Personal Config 中，并通过目标 Environment 的 Provider Settings 完整性问题呈现。
Configured Default 是新会话的初始偏好，不是配置复制的成功条件。同步必须原样保留它；
Provider/Model 不存在、reasoning 缺失或失效时，由目标 Host 现有的
`resolveInitialModelSelection` 选择可用的 Registry 推荐。没有可用模型时保持无推荐，不能伪造
可执行模型。不得为此回滚已完整写入的配置，也不得清除、改写持久化默认或已有会话的选择。

```text
原行为：完整写入 → 校验默认偏好失败 → 整体回滚 → 拒绝工作区连接
现行为：完整写入 → 刷新成功 → 开放工作区 → Host 解析默认偏好或 Registry 推荐
实际 IO / 刷新失败 → 原事务回滚 → 拒绝首次连接
```

此调整只改变 Provisioning 对默认偏好的处理；Target 仍拥有事务和 Registry，Main 仍只调度。
不增加重试、超时放行或第二份状态。Desktop `desktop-continuous` 和手机
`web-remote-replayable` 继续通过同一个已就绪 Host 的可信 attachment 访问服务，stream、
snapshot、queue、owner/lease 和 `workspaceIdentity` 边界不变。

## 同步数据

### 配置

同步 Personal Layer：

- `providers`；
- `modelConfigRules`；
- `providerOrder`；
- `model-selection.json` 中的 Configured Default。

不复制 ZCode Built-in Provider/Model Release。远端继续使用自己的 Built-in Release；两端
候选集差异可能使默认偏好不可用，按上面的 Host 推荐规则处理，不把它当成配置复制失败。

### 账号连接状态

只同步账号解析需要的窄字段：

- `providerFamilyDomain`；
- `providerFamilyConnectionSelections`。

不复制整个 `setting.json`，避免覆盖远端代理、数据目录、locale、窗口和任务设置。

### 凭据

同步范围由版本化 allowlist 定义：

- `oauth:active_provider`、`oauth:session_revision`；
- `oauth:zai:*`、`oauth:zai_cn:*`、`oauth:bigmodel:*` 的 access token、refresh token、user info；
- 同主会话绑定的 `oauth:linked_bigmodel`；
- `zcodejwttoken`。

新 Source 固定输出 `schemaVersion=3`。v3 表示上述完整 OAuth 会话组；旧 Target 在解析阶段拒绝，任何 Store 写入之前终止，不能降级信封。新 Target 接受 v1/v2/v3：v1 历史账号 Key 只校验不应用，v1/v2 只允许旧 OAuth 字段；应用旧信封时清除新字段，不能拼接目标原有关联。每次实际应用和成功回滚均生成新的目标会话 revision，不复用 Source 或回滚前的 revision；同 syncId 重放仍零写入。

Source 从一次凭据文件原子快照读取。Target 通过 Host 私有 `loadMany` 捕获整组旧值、`updateMany(expected)` 在凭据文件锁内比较并替换整组，单次通知。回滚也只做整组 CAS：当前值已等于旧值则无需写；等于本次已写快照才能恢复内容，同时生成新 revision，拒绝回滚前启动的旧请求。期间另一次登录/登出改动整组时，保留新登录并报告 `rollback_failed`，不能逐键回滚为混合会话。其余 Personal Config/窄设置沿原事务与 CAS 规则。

```text
Source 原子会话快照 → v3 信封 → 旧 Target：解析拒绝、零写入
                              → 新 Target：整组 CAS → Registry 刷新 → 完成
                                                      └失败：整组 CAS 回滚
                                                               └会话已更新：保留新会话，报告失败
```

OAuth → Project Token 迁移后，`account-provider:*:api-key` 不属于同步 allowlist。Source 不解密或发送旧账号 Key；Target 不读取、覆盖或删除已有旧/手工 Key。目标 Host 用同步的登录态和自己的 Key ID 缓存换 Token；短期 Token 和 ID 缓存不跨 Environment 传输。显式手工 Provider 的 Key 仍随 Personal Config 同步。磁盘幂等状态版本、同步 lane 和 desktop continuous/mobile replayable 边界不变。

不导出 SSH 密码/私钥、Bot 凭据、MCP OAuth token、插件 Secret 或其它通用 Credential key。

本地和远端的 Credential cipher 可能不同，禁止直接复制 `credentials.json` 密文。Source 端
通过 Credential Service 解密 allowlist 值，目标端通过自己的 Credential Store 重新加密落盘。
Result 与日志只记录数量、状态和非 Secret 标识，不返回或打印凭据值。

## 事务与回滚

Provisioning Envelope 包含：

- `schemaVersion`；
- `syncId`；
- source config/model/settings revision（仅用于 Source 读取一致性校验）；
- 目标端不做跨 Environment 的冲突 revision 判断；
- Personal Layer、Configured Default、账号窄设置和 allowlist 凭据。

目标端先校验整个 Envelope，再按以下顺序写入：

1. 账号窄设置；
2. 凭据（目标端重新加密）；
3. `provider_config.json`；
4. `model-selection.json`。

每个正式文件使用现有原子写和锁。目标端在事务内暂存每个 domain 的旧值/新值，任一步骤
失败时按记录反向恢复所有已写入 domain；恢复失败必须返回 `rollback_failed`，禁止报告成功。
回滚后会刷新目标内存中的 Account Source/Registry，使恢复后的事实立即生效，但不会产生
成功 Provisioning 结果。成功后目标端主动刷新 Account Source/Registry，
再由现有远端 Host → Worker account overlay 链路同步到 Agent Worker。

运行中的 Active Model 继续遵守“创建时冻结”语义；Provisioning 影响后续新建 Model/Session，
不静默改写正在执行的请求。

## 进程边界

```text
Desktop Main: Environment Coordinator（仅调度元数据）
  └─ 选择该 Environment 的一个在线 Window Host
       ↓
Window Host
  ├─ 重新读取 Local Provider Provisioning Source
  └─ Remote Target RPC（SSH/WSL/Docker/Server）
       ↓
Remote zcode-server
  ├─ Target Store 写入与回滚
  ├─ Remote ProviderRuntime refresh
  └─ Remote Host → Worker Account Config sync
```

Remote Target RPC 不复用 Renderer 的 `IProviderSettingsService` 写接口，避免把“跨 Environment
复制”和“远端本地编辑”混成一条无幂等、无回滚的路径。

### Worker Registry 刷新屏障

Provisioning 写入目标 Environment 的 Personal Config 后，存量 Agent Worker 可能仍持有写入前
的进程内 Registry。远端 Host 在会话创建、模型切换和输入执行前，必须通过内部
`provider/refreshRegistry` 请求让目标 Worker 从自己的正式 Config Store 读取并刷新 Registry；该
请求不携带 Desktop Registry、凭据或模型配置快照。刷新和待执行的 Selection 校验必须在输入
ACK 之前完成；刷新失败或 Selection 不可用时拒绝本次输入并保留用户草稿，不能先 ACK 再让后台
turn 静默失败。
V4 `switchModelConfig` 与输入命令共用该刷新屏障：刷新成功后才发送模型切换命令。

```text
Host execution admission
  -> Worker provider/refreshRegistry
  -> Worker reads local Personal/Account Config and rebuilds Registry
  -> Selection validation
  -> ACK + turn execution
```

该屏障不重启 Worker、不改变运行中 Active Model 的创建时冻结语义，也不改变 Desktop
`continuous` 与 Mobile `replayable` 的传输边界。

## 兼容与失败语义

- Result 与 Host execution result 增加可选 `errorCode`，只接受固定枚举：
  `source-read-failed`（本地快照读取）、`target-call-failed`（远端调用抛错，含校验/预读/RPC）、
  `target-write-failed`（目标 Store 写入）、`target-refresh-failed`（账号/Registry 刷新）、
  `target-commit-failed`（幂等记录写入）、`target-apply-failed`（旧目标只返回失败状态）、
  `capability-unavailable`、`session-unavailable`、`host-execution-failed`。
  `rollback_failed` 仍单独表达回滚失败，不覆盖原失败阶段。错误码不包含路径、凭据或远端自由文本。
- 新 Host 对旧 Target 缺失或未知的错误码使用 `target-apply-failed`；旧结果仍可读取。
  不改变 Envelope 版本、成功状态或幂等文件版本，也不推断无法确认的底层故障。
  默认偏好修复需要同时发布远端 server bundle；仅更新 Host 时，旧 Target 仍执行原有严格校验。
- 首次同步失败在 reject 前记录 Environment、trigger、status、errorCode、耗时；连接面板和反馈
  同时收到带安全错误码的失败行。已有连接的后续失败仍只记录 warning。原始 `errorMessage` /
  `error` 不直接转抄到 Main 日志或 Renderer。

- 首次连接的旧远端不支持 Provisioning capability 时返回 `unsupported`，不发送 Secret，也不发布 Remote Workspace ready。
- HTTP `zcode-server` 只有在配置 `ZCODE_SERVER_AUTH_TOKEN` 后才开放受信 Desktop Host 的
  Provisioning target；未配置认证时保持“不支持”，避免把跨 Environment 凭据写入口暴露给匿名连接。
- R3 Source Server Core（`packages/zcode-server-cli`，`serviceAuthorityMode: "standalone-server"`）
  **始终**注册 Provisioning target：R3 ingress token（`<serverRoot>/run/ingress-token`，0600）常在，
  不存在上一条那种“未配置鉴权则不支持”的分支。隔离在 `clientMode` 层完成：`/ws/host` 的
  `desktop-continuous` 连接（capability ticket + ingress token）拿到真实 `IProviderProvisioningTargetService`；
  `/ws` 的 `web-remote-replayable` 连接在 `exposeWebSocket` 中被 override 为抛错 stub
  （“Provider Provisioning 仅支持受信 Desktop Host”），Window Host 的手机 allowlist 也不含该 channel。
  旧版 daemon（无 target）不会在 R3 主链上收到 Envelope：`ZCODE_MIN_COMPATIBLE_VERSION` 默认等于
  产品版本，R3 兼容门在握手阶段就判定“需升级”并先执行远端更新，更新后的 Core 才进入首连 Provisioning。
  Core 使用的 ZCode Built-in Provider Config 由构建期 define 在 Core 启动时物化到 Environment 配置根
  `~/.zcode/v2/runtime/provider/bundled/zcode-builtin.json`（不写进不可变 release 目录）。运行中该文件与
  Endpoint Active 同时被删除时，Source 使用本进程已解析的 Bundled 基线继续服务并重建 Active，
  Provisioning 同步不再持续失败到 Core 重启（规则见
  [Built-in Release 与活动缓存](../working-memory/provider-refactor/design/registry/configuration.md)）。
  R3 侧接线见 [r3-source-server-remote-architecture.md §8.3](../architecture/r3-source-server-remote-architecture.md)。

  ```text
  zcode-server-cli Core（standalone-server，target 常驻）
    ├─ /ws/host  desktop-continuous ──► IProviderProvisioningTargetService（真实实现）
    └─ /ws       web-remote-replayable ─► { apply: () => throw }（stub；手机 allowlist 亦不含该 channel）
  ```

- Remote Workspace 已连接后的自动同步失败记录结构化 warning，不拆除现有连接，也不改变本地保存成功反馈；不新增 Banner，也不在模型设置页新增入口。Main 协调器按 lane 在内存中保留最近一次执行结果（时间、成功 / 失败、固定阶段码），只供数据同步页「模型提供商」分类读取；该分类在设备有 lane 且最近一次失败时提供「重试」，重试推进同一条 lane（trigger `user-retry`），不新增同步链路，见 [R3 §8.3.6](../architecture/r3-source-server-remote-architecture.md) 与 [数据同步](data-sync.md)。
- 网络断开导致结果未知时，以 `syncId` 重试；目标端重复收到任意已完成 `syncId` 时返回之前结果，
  不会因后续同步覆盖幂等记录而重新应用旧 Envelope。
- Environment 离线时保留一次待同步意图，重新上线后读取最新本地状态执行；普通失败不循环
  重试，等待下一次真实触发或用户在数据同步页的重试。

## Desktop 附着 Source 的连接初始化与反向资源通道

SSH / WSL / Docker 经 SourceServerConnectionManager 建立的每一代物理 RPC 连接，
在发布 online、允许 logical workspace attachment 之前，先下发 Desktop 当前
`dynamicWorkflowMode`。自动重连同样读取最新模式；模式同步不支持或失败只记录告警，
沿用既有旧版本兼容行为。独立 `kind: "server"` 保持自己的设置权威，不下发此模式。

群话题资源与 channel reply 的反向 RPC channel 由物理连接拥有，同一个 Source 的
多个 logical workspace 共用这一 channel。每次请求先经 registry 验证
`remoteSessionId + workspaceIdentity + workspacePath` 仍属于当前在线 attachment，
再核对其 Agent service 是该物理连接的代理实例；不能以 logical ServiceCollection
对象同一作为物理身份，也不能仅按工作区路径放行。socket 关闭、建连失败或物理
连接 dispose 均释放反向 channel 及在途读取；logical tab 关闭不关闭其他 tab 共用
的物理连接。新物理连接创建自己的 channel，旧代请求不得借用新代权限。

```text
物理 RPC 建立 → 注册反向 channel → 下发 Desktop workflow mode → Manager 发布 online
                         │                                  └→ 多 logical attachment
物理关闭/释放 ────────────┴→ 取消旧代资源请求；重连从 RPC 建立重新执行
```

该接缝只管理已鉴权物理连接与反向路由，不增加 runtime、accepted input queue 或
业务状态。桌面 continuous 和手机经 shared-host 的 replayable 边界保持各自可信
attachment 的 clientMode。

Source Server 内部 peer 路由使用 canonical workspace identity；反向 RPC 返回 Desktop
前通过同一个 workspace identity mapper 转回 stable identity，响应再映射回 canonical。
Desktop registry 的权限校验继续使用 stable identity，不能将内部 identity 泄漏为另一份
attachment 身份，也不能为绕过校验而降低到仅比较 workspacePath。

## 默认偏好与首次失败诊断回归

- `R3A-PRV-05` 的真实 Store 回归必须验证删除 Provider 后完整替换、保留失效默认、空 Registry 返回无推荐；`R3A-PRV-11` 必须验证无效 Provider 留在 Personal Layer 但不可执行、失效默认原样落盘且 Host 推荐合法模型。两项均不得继续断言“默认不可用则回滚”；真实写入、刷新和提交失败仍按 `R3A-PRV-08` 验证回滚。
- 聚焦测试覆盖缺失/失效 reasoning、缺失 Provider/Model、空 Registry、合法默认、写入/刷新/
  幂等提交失败与回滚，以及旧结果和未知错误码的安全处理。
- `SSH-P0-CONN-08` 通过真实 Electron → SSH → 远端 Target 验证：损坏本地同步凭据时错误和
  连接日志都显示 `source-read-failed`；恢复凭据后，保留失效默认也能进入远端目录和工作区。
  用例使用既有无账号启动 fixture，避免无关的假 OAuth 触发登录过期弹窗。
- 2026-10-09：macOS Desktop → 隔离 Ubuntu 22.04 aarch64 SSH E2E 通过，artifact
  `desktop-e2e-20261009032604472-p1453-8bb89553244ba5cc`。用例保持 pending，未进行人工晋升。
  Windows/WSL、其它远端系统与手机端 UI 未实测；未取得原反馈用户的现场输入，不据此宣称复现了
  每位用户的历史事故。回滚可还原本次提交，无持久化格式迁移。
