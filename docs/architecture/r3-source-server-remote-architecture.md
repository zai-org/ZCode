# R3 Source Server 统一远程主链规格

## 1. 状态与范围

- 状态：已实现（代码基线 `fad93b9e57`，2026-09-13）。正式发布校验与真实 SSH E2E 复跑仍在进行，以 [问题台账](./r3-source-server-remote-open-issues.md) R3-ISSUE-001 / 020 为准。本文是当前事实规格；R3 过程文档已归档到 `docs/archive/remote-r3/`，阅读入口见 [docs/remote/README.md](../remote/README.md)
- 修订：2026-09-07 合并 Provider 重构 M2（Provider 重构 M1~M4 + Remote Provider Provisioning）后，§1/§2/§3.1/§6.2/§7.1/§8/§10/§11 中的模型配置语义改为「设置页绑定本地 + Provisioning 自动单向下发」；Provider 侧以 [Remote Provider Provisioning](../remote/provider-provisioning.md) 与 [SSH 远端 Workspace 状态权威边界](../ssh-remote-app-global-state-authority.md) 为事实文档，合并过程与决策见 [r3-provider-refactor-merge.md（已归档）](../archive/remote-r3/r3-provider-refactor-merge.md)
- 阶段：统一多端远程架构 R3 / D5—D11
- 发布方式：SSH、WSL、Docker 在同一 App 版本统一切换新主链；不按连接方式分版本或灰度；R3 App 内不保留可运行的旧远程主链
- 核心目标：引入 Source Server、`sourceServerId`、Connection Profile、Transport Adapter、Source 权威、身份迁移与版本兼容，让三种连接方式在「窗口级 Local Host（R1）↔ 常驻 ZCode Server daemon（R2）」的新主链上完成产品闭环

本文基于：

- [ZCode 统一多端远程连接架构与产品方案（评审稿）](https://internal-docs.example.invalid/redacted)（D5—D11 定义）
- [R1 窗口级单 Host 进程重构规格](./r1-single-window-host-refactor.md)（已实施，当前架构事实）
- [R2 独立 Server CLI 与 daemon 规格](./r2-server-cli-and-daemon.md)（已实施；`verify-remote-ssh.mjs` 为 R3 SSH Transport 的最小形态预演）
- [R3 Source Server 发布测试方案（历史，已归档）](../archive/remote-r3/r3-source-server-release-test-plan.md)：REMOTE-01—15 稳定编号现由 [conversation-session-case-catalog.md](../conversation-session-case-catalog.md) 承载，当前执行方案见 [r3-remote-automation-plan.md](../testing/r3-remote-automation-plan.md)
- [远程工作区投影与持久化兼容](./remote-domain-simplification-and-conversation-workspace-spec.md)（统一 projection、open set、strict schema 与 R4 剩余事项）
- [ZCode Lite / Server 统一多端架构实施计划](./unified-zcode-lite-server-multi-server-plan.md)（目标架构背景）
- [Remote Target 抽象](./remote-target-abstraction.md)（现有旧主链的 target/backend 事实）

R3 交付：

- 远程领域模型与协议：`SourceServerRecord`、`ConnectionProfile`、`sourceServerId`、compatibility manifest、握手/迁移/同步 schema（D5）；
- Transport 框架与 SSH、WSL、Docker 三种 Adapter：只负责发现、安装、启动、传输（D6）；
- 稳定 `sourceServerId` 握手、Profile 归并、Source 写路由与身份迁移（D7）；
- 统一远程主链：三种连接方式全部改为连接常驻 Server daemon，删除「部署临时 stdio zcode-server」的旧业务主链；旧连接记录与远端旧数据完成迁移（D8）；
- 生命周期与恢复：启动自动重连、在线断连重试、离线探测、断连数据恢复、待确认请求恢复（D9）；
- 版本兼容与更新：双端 compatibility manifest、只升级旧端、完整 Server CLI 远程更新与重新握手（D10）；
- 多 Source 产品面：连接管理页、平铺项目与任务来源标识、非阻断持续运行提示、完整更新交互（D11）。模型配置与登录信息**不再**提供设备选择器与「一键同步」入口：由 Provider Provisioning 在首连 / 重连 / 本机保存成功时自动单向下发，设置页「模型设置」永远绑定本地 Environment（2026-09-07 合并 Provider 重构 M2 时拍板，路线 A；见 §8.2、§8.3 与 [Remote Provider Provisioning](../remote/provider-provisioning.md)）。

R3 不交付：

- Direct URL 新入口（`kind: "server"` 直连保留为 dev-only 调试入口，不进入一期产品面）；
- 跨网络远程控制、Mobile 新产品能力、任务完成推送（现有手机扫码 attachment 与 replayable 边界必须回归不退化）；
- 手机专属沙盒；Resource Store 化的附件协议（沿用现有 prompt-attachment-transfer 合同）；
- Server/Agent 崩溃后运行中 Task 的自动续跑；模型配置的远端编辑、反向（远端 → 本机）同步与远端配置管理 UI（远端只是本机配置的可丢弃执行镜像，见 §8.3）；远端 automation（cron 调度仍是本地 workspace 能力，调度器留在窗口 Host）；
- Desktop Local Host 与同机独立 daemon 共用同一数据目录（明确不支持）；
- 旧数据迁移兼容代码的删除（留待 R4 / D12）。

## 2. 核心决策

| 决策项           | R3 结论                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sourceServerId` | 直接采用远端 Server 安装的 `install.json.installationId`（R2 已实现：UUID、原子生成、保留数据卸载时保留、经 `/api/server-info.serverId` 暴露）。不引入第二个身份体系                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 身份边界         | `sourceServerId` 表示「Server 环境 + 登录账号」：不同 OS 账号/WSL distro/容器各有独立 server root → 天然不同 id；换 IP/域名/端口/连接方式不换 id；正式卸载保留用户数据与身份，原地重装沿用原 Source Server、Profile 和项目；连接目标换成独立数据环境时才确认新身份。数据目录被克隆导致 id 重复的检测不在 R3 范围                                                                                                                                                                                                                                                                        |
| workspace 身份   | 控制端 identity 统一为 `remote:server:<sourceServerId>:<posixPath>`（复用既有 `buildServerRemoteWorkspaceIdentity`）。远端权威存储 key 在 R3 **保持旧 route-derived 格式不做全量重写**：每个 path 选举一个 canonical key，新主链读写统一路由到它（见 §3.2/§9.2）；真正的 server-local 清洁化留待 R4。route-derived 格式停止在控制端生成，Host 仅以 hint 形式下发供 canonical 选举                                                                                                                                                                                                       |
| 连接拓扑         | Host 通过 Transport Adapter 建立到远端 loopback ingress 的字节通道，其上跑与 `kind:"server"` 直连完全相同的 HTTP+WS 握手链（server-info → capability ticket → `/ws/host`）。`connectServerRemote` 与 `createServerRemoteWorkspaceServiceCollection` 是新主链的既有骨架                                                                                                                                                                                                                                                                                                                  |
| Adapter 通道     | SSH 用 `ssh2 forwardOut`（direct-tcpip 到远端 loopback 动态端口）；WSL、Docker 统一 stdio 桥（新增内部命令 `zcode server proxy-stdio`）。WSL 宿主 localhost 直连不进一期（减少测试矩阵，留作后续性能优化）                                                                                                                                                                                                                                                                                                                                                                              |
| bootstrap 底座   | 复用现有 `IRemoteBackend` 的 `detect/exec/upload` 原语（SSH sftp、WSL UNC 直拷、docker cp 全部保留）；`deployServer` 旧资产编排整体废弃                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 远端安装         | 上传 R2 六平台发行包 archive，远端执行本地 archive 安装（与 R2 update 同一 immutable promote 语义），随后 `serve --daemon`。首装与升级共用同一条链                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| daemon 保活      | 三种 Transport 都先按远端实际能力选择启动方式：可访问的 launchd/systemd --user 注册 OS service（`serviceRegistered=true`）；服务管理器缺失、未启动或当前用户会话不可访问时自动走 detached fallback（`serviceRegistered=false`）。服务管理器探测已成功但真实注册失败仍 fail-closed，禁止用 fallback 掩盖权限、descriptor 或系统错误。fallback 常驻性以上层环境存活为前提，重启后由下一次自动/手动连接重新 `ensureDaemon`                                                                                                                                                                 |
| ingress 鉴权     | 新增 server root 下 `run/ingress-token`（0600）文件 token。Adapter 以目标用户身份经传输通道读取，HTTP/WS 请求全部携带。把 R2 的「网络位置边界」升级为「OS 用户身份边界」；R2 的一次性 host capability ticket 机制保留在 token 之上                                                                                                                                                                                                                                                                                                                                                      |
| 版本兼容         | 双端生成 compatibility manifest `{schemaVersion, productVersion, minCompatibleVersion}`；由较新端 manifest 判断旧端；只升级旧端。R2 存量 server 无 manifest 字段 → 一律判为「过旧需升级」                                                                                                                                                                                                                                                                                                                                                                                               |
| 远端更新         | Desktop 解析并校验当前 Server release archive，经 Adapter `installOrUpdate(..., { force })` 统一执行 `zcode update --from-archive`（复用 R2 running-task guard、原子切换和失败回滚）；目标版本 CLI 必须让 Supervisor/Core/Agent 全部收敛到同一 immutable release 后才返回 `applied:true`，不得依赖远端 manifest URL。完成后自动重新握手                                                                                                                                                                                                                                                 |
| 权威切换         | 远端 daemon 以 `standalone-server` authority 运行（R2 Core 已是）；删除 `desktop-attached-remote` 的 provider 下发主链。模型 Provider 配置由远端 Environment 自权威（Core `createLocalServices({ providerProvisioningTargetEnabled: true, zcodeBuiltinProviderConfigFilePath })`）；本机 Personal Layer、Configured Default、账号窄设置与 allowlist 凭据由 Provider Provisioning 在首连 / 重连 / 本机保存成功时**自动单向下发**。设置页「模型设置」永远绑定本地 Environment，不提供设备选择器、远端编辑与手动「一键同步」（2026-09-07 合并 Provider 重构 M2 时拍板，路线 A；§8.2/§8.3） |
| 服务集合         | 三种连接方式统一采用「全转发」模式（与现有 server transport 的 `createServerRemoteWorkspaceServiceCollection` 一致）；`LegacyRemoteWorkspaceRpcContract` 更名为版本化的 `RemoteWorkspaceRpcContract` 并作为握手校验的一部分                                                                                                                                                                                                                                                                                                                                                             |
| 连接记录模型     | `lastWorkspaceSession` 的「连接与 workspace 合一实体」拆分为三实体：`SourceServerRecord`（握手后建立）、`ConnectionProfile`（线路+凭据引用）、workspace 打开历史（引用前两者）。凭据 key 从 `remote-workspace:<workspaceKey>:*` 迁到 `connection-profile:<profileId>:*`                                                                                                                                                                                                                                                                                                                 |
| 远端数据迁移     | **R3 不做破坏性 key 重写**。Server Core 维护 path → canonical key 的 alias 解析层，按 workspace 打开惰性执行；单线路历史零数据改动（新旧版本读写同一批行，回退与混连天然兼容）；仅多线路变体历史做一次性合并到 canonical（备份 + ledger），失败按 workspace 粒度阻止打开、不阻塞连接。R4 才执行 server-local 清洁化                                                                                                                                                                                                                                                                     |
| 目录共存         | 旧主链资产（`~/.zcode/server` 下 `node`、`zcode-server.cjs`、`agents/`、`tools/`、`build/` 散文件）与 R2 release 布局同目录共存。R3 安装不清理旧散文件（保护未升级 Desktop 的回滚路径），清理留待 R4                                                                                                                                                                                                                                                                                                                                                                                    |
| 自动重连         | 启动按最近在线排序尝试全部保存连接，不按 7 天过滤（并发和单次预算见[当前恢复合同](../remote/desktop-remote-session-renderer-reattach.md)，各尝试一次）；在线断连按 2/4/8s 重试 3 次；离线每 2 分钟静默探测。仅对「凭据可静默获得」的 Profile 生效；需要交互（密码未存、版本不兼容、迁移失败）时停在离线态等待用户                                                                                                                                                                                                                                                                       |
| 窗口模型         | 沿用 R1 窗口级隔离；一期按单窗口（主窗口）设计与验收，启动自动重连由主窗口 Host 执行，多窗口行为不做产品承诺                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 远端 automation  | 一期不支持。cron 调度与 run 生命周期当前在窗口 Host 进程内（`cronAutomationRepo`/`cronRunLifecycle`），迁往 Core 涉及调度器移植、错过补跑语义（方案已列为后续能力）与管理 UI 多 Source 化，改动独立且不小；daemon 常驻已为后续实现铺路，R3 架构不设障碍                                                                                                                                                                                                                                                                                                                                 |
| 灰度与回滚       | 按 App/用户版本灰度；回滚 = 装回旧 Desktop 版本。canonical key 方案下单线路用户回退零成本（远端数据零改动）；多线路合并前备份 + ledger 可对账，见 §9.3/§9.4                                                                                                                                                                                                                                                                                                                                                                                                                             |

既有不变量（全部保持）：

- `workspaceKey = workspaceIdentity?.trim() || workspacePath`；路径 IO 继续使用 `workspacePath`。
- Desktop `continuous` 与手机 Web `replayable` 的队列、seq、gap、恢复边界相互隔离；手机 `/remote` 只 attachment 既有窗口 Host。
- Main 和 relay 不持有业务状态；`remoteSessionId` 由 Host 分配，仍是窗口内路由句柄，不进入全局身份。
- CLI 是 Session 正文与运行态权威；Supervisor 不持有业务状态；崩溃/更新中断的 Task 不自动续跑。
- Secret 不进入日志、任务事件、snapshot 或迁移报告。

## 3. 领域模型与身份

### 3.1 新增共享类型（D5，落点 `packages/shared/src/source-server/`）

```ts
/** 控制端持久化：一条到达某个 Server 的线路。 */
interface ConnectionProfile {
  profileId: string; // 控制端生成的 UUID
  transport: "ssh" | "wsl" | "docker";
  target: SSHProfileTarget | WSLProfileTarget | DockerProfileTarget; // 复用现有 snapshot 字段（secret 一律 credential key 引用）
  sourceServerId?: string; // 首次握手成功后回填；未握手前 Profile 独立展示
  displayName?: string; // 用户可改；默认取 host/alias/distro/container
  lastConnectedAt?: number;
  lastConnectError?: string;
  createdAt: number;
}

/** 控制端持久化：一个已识别的 Source Server。 */
interface SourceServerRecord {
  sourceServerId: string; // = 远端 install.json.installationId
  displayName: string; // 默认 `${hostname} · ${osUser}`，用户可改
  osUser?: string;
  hostname?: string;
  lastSeenVersion?: string; // 远端 productVersion
  lastOnlineAt?: number; // 启动静默重连的 7 天门禁依据（§7.1）
  declaredWorkspaces?: Array<{ workspacePath: string; workspaceIdentity: string; label?: string }>; // 握手时整体替换的远端已知目录，≤20 条（§8.4.1）
  preferredProfileId?: string; // 用户指定默认线路；否则用最近成功线路
}

/** 控制端持久化：workspace 打开历史，stable identity 与回滚 hint 分栏保存。 */
interface SourceServerWorkspaceHistoryEntry {
  workspacePath: string;
  workspaceIdentity?: string;
  legacyWorkspaceIdentity?: string;
  profileId: string;
  sourceServerId?: string;
  lastOpenedAt: number;
}

/** 模型配置的跨 Environment 下发不在本目录定义：Envelope / Result / Trigger schema 见
 *  packages/shared/src/provider-provisioning.ts，语义见 docs/remote/provider-provisioning.md。 */

interface SourceServerResolveWorkspaceRequest {
  workspacePath: string;
  legacyRouteHint?: string;
}

interface SourceServerResolveWorkspaceResult {
  canonicalWorkspaceKey: string;
  mergedKeys: string[];
  migrationId?: string;
}

/** 双端构建产物内嵌的兼容清单。 */
interface CompatibilityManifest {
  schemaVersion: 1;
  productVersion: string; // = ZCODE_VERSION
  minCompatibleVersion: string;
}
```

以上类型全部配套 zod 严格 schema（`.strict()`），放入 `packages/shared/src/validation*` 体系并有契约测试。`RemoteTarget` 的 `ssh/wsl/docker` 三种连接参数形状不变，继续作为 Adapter 的输入。模型配置下发使用 `ProviderProvisioningEnvelope`（Personal Layer + Configured Default + 账号窄设置 + allowlist 凭据），其字段与事务语义以 [Remote Provider Provisioning](../remote/provider-provisioning.md) 为准，R3 不再定义自己的同步快照类型。

### 保留数据的卸载重装（2026-10-10）

`sourceServerId` 表示远端持久用户数据环境，继续以 `install.json.installationId` 为唯一来源。
正式 `uninstall` 清理程序运行资产，保留用户数据及 `install.json`；重新安装沿用原 UUID。
App 不触发身份换代，不归档原 Profile、不新增设备或项目，原任务可见且可继续使用。
普通更新和保留数据重装均不改 workspace identity；连接的临时 `remoteSessionId` 可重新分配。

```text
原设备 / Profile / 项目 / 历史
  -> uninstall：保留数据与 install.json，写 uninstalled.json 禁止启动
  -> archive 安装完成：清除卸载标记，握手仍返回原 sourceServerId
  -> 复用原设备、Profile 和项目，打开原任务并续聊
```

同一线路实际连接到独立数据环境时，仍按不同 UUID 进入身份确认：取消不改记录，确认建立
新设备和独立 Profile，原连接归档、原项目身份保留。测试必须替换完整数据环境，不能只换 UUID
却共享历史数据库。身份变化文案表达连接目标变化，不把保留数据的重新安装描述为新设备。
本版本尚未上线，不增加旧版身份丢失恢复或历史重复设备合并。数据克隆仍遵循 §2 的范围约束。

### 3.2 workspace 身份的三层结构

SSH 线路身份继续使用 `remote:ssh:<host>:<port>:<username>:<posixPath>`。用户名可含
冒号（例如 `user:tenant`）；统一解析器先消费 host、port，再以 `:/` 定位用户名后的
绝对路径，不把用户名内部冒号当成路径起点。路径中的冒号原样保留。构造结果、已保存的
线路键、稳定 Source 身份和凭据键不改写，也不迁移历史数据；认证仍使用完整原用户名。
空 host/port/username、缺少绝对路径仍拒绝。WSL、Docker、Server 的解析规则不变。

连接准入和目录状态投影都复用这一解析器。带冒号的用户名必须能到达原有 SSH 认证；
若远端拒绝账号，沿用认证失败提示，不能报 `remote-project.invalid-host-identity`，
也不能让该连接的失败状态阻断整个远程项目目录读取。回归场景见 SSH-P0-CONN-09。

现状问题：旧 identity `remote:ssh:<host>:<port>:<user>:<path>` 把线路编进身份（`packages/shared/src/remote-workspace-identity.ts`），换 IP/别名即形成新 key 丢历史；同一目录经多条线路连接会在远端两套数据库（`~/.zcode/v2/tasks-index.sqlite`、`~/.zcode/cli/db/db.sqlite`）留下多套并行历史。

R3 的身份分三层。核心取舍：**控制端身份彻底 route 无关；远端存储 key 在迁移窗口期保持旧格式（canonical key），保证旧版本 Desktop 回退/混连时读写同一批数据**；存储 key 的 server-local 清洁化推迟到 R4（旧版本退出支持窗口后）。

```text
控制端（Host / Renderer / 手机 bridge / credential key / tab 去重）
  workspaceIdentity = remote:server:<sourceServerId>:<posixPath>   ← route 无关，换线路不变
  workspaceKey      = workspaceIdentity
        │
        │  wire：Host 下发 { workspacePath, legacyRouteHint? }
        │        legacyRouteHint = 按当前线路构造的旧格式 key（仅供 canonical 选举，R4 删）
        ▼
远端 Server Core（唯一映射点：workspace 定位层）
  canonical key 解析：path ──alias 表──► canonical key（旧 route-derived 格式）
        │
        ▼
远端权威存储（Server Core / Agent CLI / SQLite / sessions/<hash>/ 配置目录）
  workspaceKey = canonical key（R3 迁移窗口期）──R4──► server-local path
```

- 控制端格式复用既有 `buildServerRemoteWorkspaceIdentity({ serverId: sourceServerId, workspacePath })`，`isRemoteWorkspaceIdentity` 判定、手机链路贯穿 `workspaceIdentity + remoteSessionId`、realtime `workspaceKey + taskId` 路由全部不改语义，只换值。
- 换线路不换控制端 identity；远端侧由 alias 层把任意线路收敛到同一 canonical key → 同一历史（REMOTE-09）。
- 不同 OS 账号 → 不同 server root → 不同 `sourceServerId`，且远端数据库本就分属不同账号 → 严格隔离（REMOTE-10）。
- canonical key 是旧格式 → 旧版本 Desktop（旧主链）按旧 key 读写**同一批任务行与 session 行**：回退后已有会话可见、可续聊（messages/parts 按 session_id 关联，双向可见）；`sessions/<hash>` 配置目录 hash 不变。新旧兼容不依赖旧代码理解任何新概念。
- 远端本机 TUI 打开同一目录仍是 path key，与远程历史暂不共享——保持与旧版本一致的现状，R4 清洁化时统一。
- realpath 只属于新目录选择：用户新选一个目录时，应在 bind 前先在远端 `fileService.resolvePath` 做 realpath，避免同一目录以 symlink 别名生成两个身份。项目根目录由 Host 给出，按原路径 bind。
  当前只有不带 `preparedWorkspaceIdentity` 的打开（conversation workspace）经过 realpath；SSH 向导选目录用原始路径生成 identity 后打开或新建项目，仍保留 symlink 路径，缺口见 [issue 12](../issues/remote-e2e-stability/12-project-symlink-workspace-identity.md)。
- 已绑定过的 workspace 不再改写路径。原地重连、Source 上线后的自动挂回、从历史打开都用持久化的 `workspacePath` bind，不做 realpath。tab、项目根目录与 history 都以首次 bind 的路径为准；重连时改写成 symlink 目标会得到另一个 identity，保留校验因此把刚建立的 session 当作“已被移除”回收（3.17.1，例如 `/home/dev/projects/app → /data/projects/app`）。
- Renderer 不再根据 SSH/WSL/Docker target 构造正式 identity。`bindRemoteWorkspaceSessionContext`
  必须在 Host 完成 canonical 准备且新 attachment ready 后返回权威
  `{ sourceServerId, workspacePath, workspaceIdentity }`；tab、history、credential 与重连
  匹配统一消费该返回值。route-derived identity 只作为 Host 内部 `legacyRouteHint`，不得回传 Renderer/手机。

Core 映射 seam 固定如下：

- `source-server-workspace.resolveWorkspace` 在远端解析 alias 后，把
  `remote:server:<sourceServerId>:<workspacePath> ↔ canonical key` 注册到 Core 内存映射表；
- 普通 RPC 值的映射装配在远端 Core 的 `IChannelServer` 装饰层，对所有业务
  channel 的 call 参数、返回值和 listen 事件做 workspace identity 值级替换；
- V4 topic logical frame 是例外：Source Server 内部 CLI wire 可能已按 canonical identity 做
  JSON + CRC32 + base64 分片，因此不得只改 fragment outer object。Core 对外 seam 必须在
  16 MiB/1,024 片的既有有界预算内先重组内部 logical frame，映射 topic、
  snapshot.workspaceId 与 session.workspaceId，再重新 JSON encode/CRC32/fragment 为对外 stable
  wire；任何 checksum/schema/limit 失败继续 fail-closed，禁止部分 apply；
- conversation、sessions-index、workspace-config 三种 V4 topic 共用上述 physical fragment seam。
  assembler 同批返回 fault 与 complete 时必须逐项处理；fault 或重新编码失败只能向控制端发送不含
  canonical payload 的 typed recovery candidate，禁止透传原始 base64，也禁止让异常越过 event listener
  关闭整条 CLI runtime；
- 未分片的普通映射字符串分为两类：① 完整值等于 identity；② 已登记的协议复合值
  `sessions-index/<identity>`、`workspace-config/<identity>`。复合值必须用对应 parser/builder codec
  解析和重建，禁止通用 substring replace，避免误改路径、日志和用户文本；新增复合 identity 字符串
  必须先更新本节与 codec 合同测试；
- 二进制、`Date`、`ArrayBuffer`、typed array 和其他非 plain object 必须原样透传；映射器不得用
  `Object.entries` 深拷贝任意对象；
- `source-server-workspace` 自身不经过映射，仍返回真实 canonical key 供迁移诊断；Desktop Host 不保存、
  不消费 canonical key，也不再包装 `IServiceAccessor`；
- 该 seam 保证 R4 清洗只替换远端映射实现，不要求 Desktop/Renderer/手机配合发版。

### 3.3 任务地址演进

```ts
interface WindowHostTaskAddress {
  sourceServerId?: string; // 新增：远程 source 的稳定身份（本地任务缺省）
  remoteSessionId?: string; // 保留：窗口内连接句柄（重连后可变化）
  workspacePath: string;
  workspaceIdentity?: string; // 控制端 identity（remote:server:…）
  taskId: string;
}
```

Controller 写路由（pin/archive/delete/open/resume）以 `sourceServerId + workspaceKey + taskId` 定位唯一 source；`remoteSessionId` 只用于把请求路由到当前窗口内的活跃连接。断线重连后 `remoteSessionId` 换代但地址中的稳定三元组不变，R1 的 `replaceDisconnectedSource` 原子替换语义保持。

## 4. 进程与连接拓扑

改造前（R1 完成后的旧远程主链）：

```text
Window Host（R1）
├─ LocalSource ── stdio ── local zcode-cli
└─ RemoteConnectionRegistry
   ├─ SSH entry ─ ssh2 exec ─ deployServer 部署散资产 ─ 启动前台 stdio zcode-server（entry-stdio）
   │                               版本必须严格相等          │ SERVICE_AUTHORITY_MODE=desktop-attached-remote
   │                                                       └─ 远端 Agent CLI（随连接 EOF 退出）
   ├─ WSL entry ─ wsl.exe ─ 同上（60s idle TTL）
   ├─ Docker entry ─ docker exec ─ 同上（per-session dedicated）
   └─ Server entry ─ HTTP+WS ─ 已运行 zcode-server /ws/host（dev-only）
identity = remote:ssh:<host>:<port>:<user>:<path>（route-derived）
模型配置 = Desktop 下发覆盖远端
```

R3 后：

```text
Window Host（R3）
├─ LocalSource ── stdio ── local zcode-cli（不变）
└─ SourceServerConnectionManager（RemoteConnectionRegistry 演进）
   ├─ ServerDirectory（app 级持久化读写：SourceServerRecord + ConnectionProfile）
   ├─ 每个在线 Source Server 一条窗口级连接
   │  ├─ TransportAdapter(ssh|wsl|docker)
   │  │  ├─ bootstrap：probe → (确认后 install/update) → ensure daemon → 读 port/token
   │  │  └─ channel：Duplex 字节通道 → 远端 127.0.0.1:<动态端口>
   │  ├─ 握手：/api/server-info（版本兼容 + 迁移门）→ ticket → WS /ws/host
   │  └─ @zcode/rpc 服务集合（全转发）+ 多 logical remote session（remoteSessionId）
   │                         │
   │                         ▼
   │              远端 ZCode Server daemon（R2）
   │              OS service / detached ── Supervisor ── Server Core ── Workspace Agent CLI
   │              Desktop 断开只释放 attachment；daemon 与任务继续运行
   └─ ControllerProjection（source 维度 = sourceServerId）
```

窗口关闭/App 退出只断开 attachment 与传输通道，绝不停止远端 daemon（REMOTE-03）。同一 Server 被多窗口/多台 Desktop 连接时，Core 天然支持多 attachment，互不影响。

## 5. Transport Adapter 合同（D6）

### 5.1 接口

```ts
interface SourceServerTransportAdapter {
  readonly kind: "ssh" | "wsl" | "docker";

  /** 探测远端环境与 Server CLI 安装状态；不做任何写操作。 */
  probe(target: RemoteTarget, ctx: TransportContext): Promise<SourceServerProbeResult>;

  /** 上传发行包并以本地 archive 语义安装/升级；进度经 RemoteWorkspaceConnectionLog 结构化上报。 */
  installOrUpdate(
    target: RemoteTarget,
    release: ServerReleaseAsset,
    ctx: TransportContext,
    options?: { force?: boolean },
  ): Promise<void>;

  /** 确保 daemon 运行（serve --daemon；按远端服务管理器能力选择 service 或 detached fallback），返回 ingress 端口与 token。 */
  ensureDaemon(target: RemoteTarget, ctx): Promise<SourceServerIngressInfo>;

  /** 建立到远端 loopback ingress 的 Duplex 字节通道；上层在其上执行 HTTP/WS。 */
  openChannel(target: RemoteTarget, ingress: SourceServerIngressInfo, ctx): Promise<Duplex>;

  /** 运行远端管理命令（status/update/migrate retry/uninstall 等，一律 --json）。 */
  exec(target: RemoteTarget, argv: string[], ctx): Promise<RemoteExecResult>;
}

interface SourceServerProbeResult {
  platform: string;
  arch: string;
  installed: boolean;
  installedVersion?: string; // bin/zcode --version
  daemonStatus?: PersistedServerStatus; // status.json 读取结果（valid/missing/invalid）
}

interface SourceServerIngressInfo {
  port: number; // status.json 的动态端口
  ingressToken: string; // run/ingress-token 内容（内存态，不落控制端日志/持久化）
}
```

合同约束（连接方式无关性，REMOTE-15）：Adapter 之上的握手、服务集合、身份、生命周期、错误语义完全一致；合同测试用同一套用例跑三种 Adapter 的 fake/真实实现，禁止任何 `kind` 专属业务分支泄漏到 Manager 层以上。

远端平台支持沿用现状：三种 transport 的远端环境均要求 POSIX（linux/darwin），win32 远端继续拒绝（`assertSupportedRemoteEnvironment` 语义保留）；R2 发行包的 win32 资产仅服务「本机手动安装 Server CLI」场景，不属于 R3 远程连接矩阵。

- 不受支持的平台使用公开码 `remote-platform-unsupported`，不归入笼统的预检或下载失败。来源有三种：uname 报告 win32；探测脚本因 Windows 原生 shell 失败（SSH exec 固定进入 `/bin/sh`，Windows OpenSSH 的 cmd/PowerShell 找不到它，stderr 含 `CommandNotFoundException`、`is not recognized as` 等明确特征）；release resolver 收到 x64/arm64 以外的架构（如 riscv64）。乱码不算 Windows 证据：probe 由 SSH、WSL、Docker 共用，POSIX 启动脚本的本地编码报错和 `wsl.exe` 的 UTF-16LE 提示按 UTF-8 解码同样出现非法字符，这类失败保持预检失败并保留 stderr；只有本地编码报错的 Windows 主机也因此显示预检失败。Windows 的提示复用"仅支持 POSIX shell 环境，暂不支持 Windows 原生远程主机"。架构不受支持的原因写明实测平台与支持范围（Linux、macOS 的 x64 与 arm64）。列举不用 `/` 分隔：连接错误的脱敏把空格后的裸 `/` 当作路径，会遮到行尾。
- Linux 远端的 C 库下限是 glibc 2.28。发行包内置官方 Node.js 22.16.0 Linux 构建，它需要 GLIBC_2.28（以及 GLIBCXX_3.4.21 / CXXABI_1.3.9，glibc 2.28 的发行版都满足）；CentOS 7（2.17）、Ubuntu 18.04（2.27）等无法运行。musl 系统（如 Alpine）也不支持：实测装了 gcompat 后 Node 仍报 `fcntl64: symbol not found`。probe 在同一次往返里读取 `getconf GNU_LIBC_VERSION`；没有 glibc 时再检查 `/lib/ld-musl-*.so.1`。Linux 远端（含 WSL、Docker）glibc 低于 2.28 或识别为 musl 时，probe 只通过现有连接日志输出 `warn`，写明检测结果、随包 runtime 所需版本和可能启动失败的风险，继续安装确认、上传或远端直下及已有服务连接；按 glibc 报告拒连会让已安装的服务也无法尝试连接。Host 保留该日志级别；不新增确认步骤，不把警告转为预检失败。两项都读不到（缺 getconf、输出无法识别）时不警告、不拦截。放行不改变随包 runtime 的兼容要求，后续真实安装或启动失败仍按原错误通道报告。glibc 过低时，动态链接器的报错形如 ``<程序路径>: <库路径>: version `GLIBC_2.28' not found (required by <程序路径>)``。连接日志脱敏要遮住路径，但必须保留 ``: version `<符号>'`` 和其后的 `not found`，让连接日志和反馈能看出缺少哪个 GLIBC / GLIBCXX / CXXABI 版本（ZCT-2115996335380615168）。

探测结果校验（ZCT-2114700808714715136）：`probeSourceServer` 是 SSH / WSL / Docker 共用的
探测结果校验边界。`uname -s`、`uname -m` 任一失败必须立即以该命令的非零退出码结束，
不能由最后的 `printf` 覆盖为成功。可选 libc、版本、release 与 daemon 状态读取仍允许为空。
即使命令退出 0，也必须取得非空 `PLATFORM`、`ARCH`、`ROOT`，`INSTALLED` 必须精确为 `0` 或 `1`，
并收到 `END` 标记。缺失或无效时抛出环境探测失败，保留缺失字段名及经既有脱敏边界处理的 stderr；
不从 stdout 猜系统，不把未知平台报告为已确认不支持，也不把未知安装状态投影为 `installed=false`。
既有 Source 的安装状态与身份不得因这种失败被清除。真实已识别的不支持平台/架构仍沿用专用错误码。

```text
Backend 只读命令 → probeSourceServer 校验退出码及必需结果
                   ├─ 无效 → preflight failed → 保留既有 Source 安装状态
                   └─ 有效 → 原有平台支持判定 → 安装 / 升级 / 复用
```

本修复不改变探测分段的换行兼容策略，不声明已查明用户现场“旧版本可连接”的上游原因。
桌面与手机仍消费同一 Window Host 的 Source 状态；不增加重试、超时或独立探测状态。
验收用例与实际运行证据见 [RDUX-11-11/12](../conversation-session-case-catalog.md#rdux-11-连接中与目录屏验收accepted)。

### 5.2 三种实现

| 能力        | SSH                                                                                                                                                                               | WSL                                                                                                                                                                                                  | Docker                                                                     |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 底座        | 现有 `SSHBackend`（ssh2；exec 强制 `/bin/sh`）                                                                                                                                    | 现有 `WSLBackend`（wsl.exe -d distro -u user）                                                                                                                                                       | 现有 `DockerBackend`（docker exec -i）                                     |
| probe/exec  | `client.exec`                                                                                                                                                                     | `spawn wsl.exe`                                                                                                                                                                                      | `spawn docker exec`                                                        |
| 上传        | SFTP，失败回退 `cat >` 管道                                                                                                                                                       | `\\wsl.localhost\` UNC 直拷，回退流式                                                                                                                                                                | `docker cp`，回退 `cat >`                                                  |
| channel     | `client.forwardOut` → 远端 `127.0.0.1:<port>`（direct-tcpip，不占 exec channel）；sshd 禁用转发（`AllowTcpForwarding no`）时回退 stdio 桥（同一 proxy-stdio 命令经 exec channel） | stdio 桥（`wsl.exe -d <distro> -u <user> --exec bash -lc '<serverRoot>/bin/zcode server proxy-stdio --server-root <serverRoot>'`；必须 `--exec`，`--` 会让默认 shell 提前展开命令，见 R3-ISSUE-024） | `docker exec -i <c> <serverRoot>/bin/zcode server proxy-stdio`（stdio 桥） |
| daemon 常驻 | `serve --daemon` 优先注册 launchd/systemd --user；服务管理器不可访问或 systemd 装载 unit 失败时 detached fallback，下一次连接负责重启                                             | detached fallback；若未来具备可访问服务管理器也消费同一能力探测合同                                                                                                                                  | detached fallback；容器 stop 即退出                                        |
| 连接复用    | 同 `buildSshRemoteHostKey` 一条 ssh2 Client（exec/sftp/forwardOut 多 channel 复用）                                                                                               | 按 normalized distro+user 复用 wsl.exe 调用上下文                                                                                                                                                    | 按 container 复用                                                          |

- `zcode server proxy-stdio`（新增内部子命令）：读取本 root `status.json` 端口后做 stdin/stdout ↔ `127.0.0.1:<port>` 的纯字节双向转发；daemon 未运行时输出一行结构化错误后退出。它不调用 `createLocalServices`，不持有任何业务状态。
- Host 侧在任意 Duplex 上执行 HTTP 请求与 WS 升级（`http.request`/`ws` 均支持自定义 `createConnection`），SSH forwardOut 流与 stdio 桥流走完全相同的上层代码。
- 旧主链的 WSL 60s idle TTL、Docker per-session dedicated 生命周期差异全部废除：连接生命周期统一为「窗口级连接 ↔ 常驻 daemon」，workspace runtime 的启停完全由远端 Core 管理。
- 三种 Backend 的 exec 退出码使用同一套规则。命令正常退出时，取它的退出码。命令被信号终止时，返回 `128 + 信号值`（例如 SIGKILL 为 137）。SSH 通道关闭但没有收到 exit-status 和 exit-signal 时，返回 255，与 OpenSSH 客户端一致。后两种情况都是失败，不能当作 0。依赖退出码的步骤（下载、解包、update）因此不会把被杀死的命令当成成功。
- WSL 的 canonical 身份（distro + user）在连接前解析，并会写进设备 Profile，因此解析结果只能来自身份探测本身：
  - 探测命令不走登录 shell：`wsl.exe [-d <distro>] [-u <user>] --exec bash --noprofile --norc -c '<identity>'`。输出先打印一行哨兵，只读取哨兵之后的三行（`$WSL_DISTRO_NAME`、`id -un`、`$HOME`）。profile、bashrc 或 wsl.exe 打印的文字不能进入身份。
  - distro 以 `wsl.exe -l -v` 列表为准。上报的 distro 与列表中某一项相同（不区分大小写）时，采用列表里的名字；不同时，采用列表选中的 distro；列表为空时，才采用上报值。user 必须通过 `isValidWslUser`，否则身份解析失败，不写入 Profile。
  - 身份解析失败（包括 distro 不存在）不缓存，下一次调用重新探测。
  - wsl.exe 失败时，错误带退出码。stderr 为空时，错误带 stdout（wsl.exe 常把错误写到 UTF-16 stdout）。Main 记录发现失败时展开错误字段，不能只记成 `{}`。
- Docker Backend 的直接 exec 与 home 相对路径读取在调用 CLI 前校验容器引用：去除首尾空白后必须匹配 `^[A-Za-z0-9][A-Za-z0-9_.-]*$`，接受名称、完整 ID 与 ID 前缀；非法引用明确拒绝，不增加容器枚举或 CLI 往返。
- Docker daemon 探测失败时，连接错误保留 docker CLI 的原始原因（stderr，或者 docker 命令无法启动的错误）。例如 daemon 未启动、socket 没有权限、docker 未安装。错误分类仍为"未知"：原因文本只进入"详细信息"和日志，不能借它把错误猜成"没有容器写入权限"等类别。Main 记录 Docker 发现失败时展开错误字段，不能只记成 `{}`。
  - R3 probe 经 `docker exec` 执行，不预跑 daemon 探测。daemon 不可用时 `docker exec` 只是非零退出，退出码与远端脚本失败相同（都是 1），无法区分。所以 probe 非零退出后，Docker Backend 重新探测一次 daemon：不可用时按上一条规则报告（"未知"，带 docker CLI 原因），不归入预检失败；daemon 可用时仍按远端环境检查失败处理。成功的 probe 不增加 docker CLI 调用。
  - docker CLI 原因里的 daemon 地址（`unix://`、`npipe://`、`tcp://`）按 URL 整体脱敏（macOS 的 socket 路径含用户名），地址后面的正文保留。同一错误后面再次出现的裸 socket 路径也要脱敏，但必须保留 `: connect: no such file or directory`、`: connect: connection refused`、`: connect: permission denied` 这三种确定的系统诊断尾部；无法确定边界的其他尾部仍保守过滤，不能把带空格的私人路径当成正文放行。
- R1 registry 的 generation/fail-closed/两阶段 attachment 换代等机制原样保留。

daemon 启动能力判定固定为（2026-10-23 起）：

```text
serve --daemon
  ├─ 已有存活 daemon（control 报告 ready / starting）
  │    ├─ 默认路径、服务管理器可访问，且同 root 有旧 identity service
  │    │    └─ 无运行任务时停止旧 daemon，再按下面的冷启动注册；有运行任务时返回错误
  │    └─ 其他情况 ────────────────────────────────────► 复用；starting 时等到 ready
  └─ 冷启动（没有存活 daemon）
       ├─ 显式 opt-out（WSL/Docker）───────────────────► detached fallback
       └─ 默认路径
            ├─ OS 用户服务管理器不可访问 ──────────────► detached fallback
            │    Linux 非交互 SSH 先尝试 /run/user/<uid>/bus
            │    恢复 XDG_RUNTIME_DIR/DBUS_SESSION_BUS_ADDRESS
            └─ 服务管理器可访问
                 ├─ 注册成功 ───────────────────────────► OS service
                 ├─ systemd 装载阶段失败 ────────────────► detached fallback + serviceFallbackReason
                 │    （daemon-reload、enable <unit 路径>）
                 └─ systemd 启动阶段失败（start <unit 名>）
                    或 launchd / Task Scheduler 注册失败 ──► 返回错误（不 fallback）
```

- “服务管理器不可访问”是能力事实，不等于安装失败：常见于 SSH 进入容器、最小系统、未启动 user manager，或 macOS SSH 会话没有可访问的 launchd user domain。
- 能力探测只证明 user manager 的 bus 能连上，不证明 manager 能读到 server root。`enable` 由 user manager 执行，使用 manager 自己的组列表和挂载视图，不是 SSH 会话的。用户在 manager 启动后才加入目录访问组、manager 使用私有 `/tmp` 时，`enable` 失败（`Access denied`、`Unit file … does not exist`），而同一 root 由 SSH 会话派生的 detached fallback 能正常运行（2026-10-23）。
- 自动 fallback 不改变 Source/Task/Session 权威；Desktop 断开只释放 attachment。fallback 进程在远端环境存活期间继续运行，宿主/容器重启后由既有启动重连或手动连接重新拉起。
- 连接日志的 daemon 阶段只报告本次连接的实际动作：本次执行了 `serve --daemon`，才报告启动方式（detached fallback 或 OS 用户服务）；probe 已确认 daemon 就绪而复用时，只报告复用。不能让复用看起来像又启动了一个实例。
- probe 的“就绪”只是磁盘快照：`status.json` 为 ready 且其中的 Core PID 能 `kill -0`。远端环境重启后快照残留，PID 可能已被同用户的其他进程复用，端口已无人监听。所以复用只是省掉一次 `serve --daemon` 的优化，不是就绪的事实源（2026-10-21）：
  - 复用后握手失败（未取消），Manager 回退执行一次 `serve --daemon --json`，再握手一次。`serve --daemon` 经 control socket 读取 Supervisor 的实时状态，必要时接管残留锁并重新拉起。
  - 回退只做一次。第二次握手的失败按原样上报；本次实际执行过 `serve --daemon` 的连接，握手失败不再回退。
  - Supervisor 存活、Core 事件循环卡住时，control 实时状态在 Supervisor 判定前仍是 ready，回退也只能拿到同一端口。恢复卡住的 Core 由 Supervisor 的活性检查负责（[R2 §4.2 Core 活性](./r2-server-cli-and-daemon.md#core-活性)），Desktop 不新增强杀或重启路径；Supervisor 重启 Core 后，下一次连接读到新端口（ZCT-2113570821476302848）。
  - 第一次握手的连接已关闭，它的关闭事件不能计入第二次握手。迟到的关闭按握手身份忽略；失败时同步触发的关闭（`ws` 在 upgrade 失败时同一 tick 先发 `error` 再发 `close`，早于失败传给调用方）由每次握手开始时清空“发布前已关闭”的记录来隔离（2026-10-22）。

```text
probe：status.json ready + Core PID 存活 ──► 复用端口 ──► 握手
                                                        ├─ 成功 ──► 在线
                                                        └─ 失败 ──► serve --daemon --json（control 实时状态）──► 再握手一次 ──► 在线 / 上报失败
```

- Linux SSH 若 `/run/user/<uid>/bus` 存在，即使 sshd 未注入 `XDG_RUNTIME_DIR`/`DBUS_SESSION_BUS_ADDRESS`，也应使用该用户 bus 完成 service 探测和注册；不得把“环境变量缺失”误判为“systemd 不存在”。
- Linux 能力探测读取 `systemctl --user show --property=Version`，只有退出码为 0 且返回非空 `Version` 属性才确认 user manager 可访问。chroot / offline 环境可能跳过命令并返回 0；这种没有属性响应的结果必须进入既有 detached fallback，不能依赖本地化 stderr 文案判断，也不能覆盖用户的离线环境设置。
- 能力探测沿用 2 秒进程超时。命令被信号终止后，执行器必须关闭本端 stdout/stderr 管道并返回失败，不能继续等待持有管道的 D-Bus 辅助进程退出；正常退出仍等到 `close` 后读取完整响应。该收口不改变服务注册错误传播，也不新增启动路径。
- 探测成功后，按注册执行到哪一步决定是否回退，不按 stderr 文案判断（2026-10-23）：
  - Linux systemd 注册拆成三次调用：`daemon-reload` → `enable <unit 路径>` → `start <unit 名>`。前两次是装载阶段，第三次是启动阶段。
  - 装载阶段失败时，本次没有启动任何 unit（实测失败后 unit 为 not-found / inactive，没有 job），CLI 直接改用 detached fallback，回退前不停止或禁用 unit。成功输出 `serviceRegistered=false`，并带可选字段 `serviceFallbackReason`，值为注册失败的原始错误；非 `--json` 模式向 stderr 写一行提示。该原因不写入 `status.json`。
  - 启动阶段失败时，unit 已经启用，可能正在启动或等待自动重启；自动回退需要先停止并禁用 unit，所以保持原样返回错误。Core 未 ready、launchd / Task Scheduler 注册失败也照原样返回错误，不回退。
  - 回退后的 detached Supervisor 仍启动失败时，按现有错误链路报告 fallback 的失败原因，不再追加注册原因。
- 连接日志的 detached fallback 行附上 `serviceFallbackReason`，沿用连接日志现有的脱敏规则；没有原因时文案不变。
- 每次冷启动重新选择启动方式，不持久保存 fallback 选择。环境修好后，下一次冷启动自动改用 OS service。存活的 daemon（ready / starting）一律复用：服务管理器后来变得可用，也不停止 fallback，运行中有任务时也不报错；fallback 停止后的下一次冷启动才改用 OS service。唯一例外是同 root 的旧 identity service 迁移，规则见 [R2](r2-server-cli-and-daemon.md)。
- daemon 启动 owner 仍由 Server CLI 在 OS service 与 detached Supervisor 之间选择，不新增重试、状态缓存、启动锁或并行启动路径。同一 canonical server root 只有一个 Supervisor 和 Core，由现有 `server.lock` 保证：后到的 Supervisor 取锁失败就退出，不改 status。以前注册成功的 enabled unit 与 fallback 同时启动、两个 CLI 同时回退时，后到者取锁失败，结果与 WSL/Docker 的 fallback 相同。运行中的 Supervisor 失去锁时不再写 status，停止 Core 后结束，规则见 [R2](r2-server-cli-and-daemon.md)（2026-10-26）：锁文件不存在（server root 被删除或替换）以退出码 1 结束，由服务管理器或下一次 `serve --daemon` 拉起新实例；锁已换了 owner 以退出码 0 结束，新 owner 已在运行，服务管理器不重启。
- `serve --daemon --json` 非零退出时，Adapter 必须优先解析 stdout 的结构化 `{ error, code?, retryable? }`，再把 stderr 作为补充诊断。Node warning、登录 banner 或 shell 噪音不得覆盖真实 CLI 错误。
- Server CLI `--json` 的结果（成功或失败）是 stdout 中最后一个单行 JSON 对象；Adapter 读取结果时跳过其前后的纯文本行。部分 SSH 堡垒机会把远端 stderr 合并进 stdout，并在 stdout 结束后才投递，Node warning 因此可能排在结果行之后，不能把最后一个非空行当作结果。
- Source Server bootstrap 可执行文件放在最终可执行根（`~/.zcode/server`）的临时 staging 内，不从常见 `noexec` 的 `/tmp` 执行；archive 临时文件仍须在成功、失败和取消后清理。
- 远端直下只把 curl/wget、tar 和 SHA-256 工具作为必需能力；awk/wc/date 等仅用于增强进度，缺失时降级为无速度进度而不是阻断下载。Desktop 下载后上传同样必须在上传前探测 tar，避免传完大 archive 才失败。
- macOS 构建 POSIX archive 时必须显式禁用 bsdtar xattr/PAX metadata；仅设置 `COPYFILE_DISABLE=1` 不足以移除 `LIBARCHIVE.xattr.*`，否则 Linux 解压会按条目刷出数千行 unknown extended header 并掩盖真实错误。

### 5.3 发现、安装与升级链

```text
probe ──已安装且 daemon ready──────────────────────────────► ensureDaemon（复用）
  │
  ├─ 未安装 ──► 展示目标账号/版本/安装位置，用户确认 ──► 上传 archive（平台匹配的 R2 发行包）
  │                                                        └─► 远端本地 archive 安装（immutable promote）
  │                                                              └─► serve --daemon ──► ready
  └─ 已安装但版本不兼容 ──► §6.3 升级流程（同一条 install/update 链）
```

- 发行包来源：沿用现有远端资产分发模式（CDN manifest + 本地缓存 + `assetInstallMode` 远端直下选项），资产内容从「散文件集合」换成 `linux/darwin × x64/arm64` 四个平台的 `zcode-server-<os>-<arch>.tar.gz`。版本根必须同时发布独立的 `source-server-release.json`，按 target 记录 `version`、`fileName`、`sha256`、`sizeBytes` 与相对 `urls`；Desktop 和远端直下必须消费同一份描述并在安装前校验 SHA-256。Windows stage 仍可产出 `.zip` 供 R2 本地验证，但 R3 远端环境不接受 win32，不进入 Desktop Source Server resolver 的发布合同。
- 正式 `build:remote-assets` 只执行四个目标的 Server CLI stage，把 descriptor/archive 复制到当前版本 release 根并上传；R3 起不再构建或发布 legacy `manifest-*.json` / `components/**`。CI 在复制和上传前逐文件 fail-closed 校验，禁止用开发 worktree 的 `dist-release` 缓存充当发布证据。已发布旧版本的 legacy 对象继续由 CDN/OSS 保留，删除新版本构建入口不得删除历史对象。
- `assetInstallMode` 只决定 archive 在哪一侧获取：`local-download-upload` 由 Desktop 下载、校验后经 Backend 上传，`remote-download` 由 SSH 目标使用 descriptor URL 下载并校验；两条路径从远端临时 archive 开始必须汇合到同一个 `zcode update --from-archive`，禁止恢复旧散组件安装器。
- 远端应用入口：`zcode update --from-archive <path> --json`（R2 update 增加本地 archive 源；首装时先解包出 `bin/zcode` 引导）。安装、升级、组件缓存、原子切换、失败回滚全部复用 R2 已验证的 release 语义，Adapter 不自造第二套安装逻辑。
- 首次安装即执行 `serve --daemon`：能访问 OS 用户服务管理器时返回 `serviceRegistered=true`；否则自动 detached fallback 并返回 `false`，连接日志明确说明“当前远端环境存活期间常驻、重启后由连接自动拉起”。
- Source Server 部署策略必须显式区分 `release-versioned` 与 `development-content-addressed`。两者只在「是否需要更新」的判定上不同：打包态 Desktop 固定使用前者，只按版本兼容性判定；未打包开发态 SSH 使用后者，在 Server version 与当前 archive version 相同但 `archiveSha256` 不同或远端身份缺失时判定为需要更新。SHA 相同继续复用；不得把该判定扩散到生产态或 WSL/Docker。
- 判定为需要更新之后，两种策略的更新逻辑必须完全一致：连接流程只把 Profile 置为 `needs-upgrade + updateAvailability: required` 并以 `source-server-upgrade-required` 拒绝连接，不得在连接流程内直接执行 archive update；更新本身统一由 §6.3 的 `updateSource → Manager.updateServer` 执行（`updating` 状态、操作日志、`force:false` 先行、running-task guard 后由用户显式确认再 `force:true`）。因此连接向导内的自动更新、启动重连/断线恢复的「立即更新」入口和强制更新确认对开发态同样生效。（R3A-B-06 修正：此前开发态在连接流程内直接 `installOrUpdate`，guard 只能表现为普通连接失败，UI 没有强制更新入口。）
- 开发态内容刷新只接受本轮本地 staging 的 descriptor/archive，并统一走 Desktop 上传；即使 SSH Profile 保存的是 `remote-download` 也不得改从 CDN 获取同版本产物。若本地产物缺失、校验失败或更新被 running-task guard 阻断，连接必须 fail-closed，禁止回退 CDN 或继续运行旧 release。
- 开发态 `bootstrap:with-remote` 必须调用与 CI 相同的 Source Server staging 入口并刷新 descriptor/archive；普通 `bootstrap` 继续跳过远端资源。成功返回表示所有仓库源码派生的 runtime、插件与 archive 都在本轮构建，只有固定版本且经校验的外部二进制允许复用缓存。staging 开始先使旧 descriptor 失效，四个平台 archive 全部原子落盘并校验后再原子发布新 descriptor；失败不得留下可被开发连接消费的旧 generation。Linux 开发专用入口 `prepare:remote-assets:linux` 复用同一路径，只构建并发布 `linux-x64` / `linux-arm64`，descriptor 只列本轮目标，不混入历史 macOS 条目；环境与使用约定见 [Bootstrap 命令](../bootstrap.md)。
- 远端 `~/.zcode/server` 内旧主链散文件（`node`、`zcode-server.cjs`、`agents/`、`build/`、`tools/`）与 R2 布局共目录：R3 安装**不删除**这些旧文件——未升级的旧版本 Desktop 仍依赖它们运行旧主链；清理属于 R4。R2 的 uninstall allowlist 需扩展列出这批旧路径，保证 R3 之后的 `zcode uninstall` 能一并清理并写入 `preservedPaths` 对账。

## 6. 握手、鉴权与版本兼容

### 6.1 ingress 鉴权（补 R2 遗留的安全边界）

R2 的 loopback-only 是网络位置边界：多用户服务器上任何本地进程都能访问 `/ws` 与 capability 签发端点。R3 隧道把这个端口暴露给「任何能连到该机器的 ZCode 用户」，必须先收口：

- daemon 启动时在 `<serverRoot>/run/ingress-token` 写入随机 token（0600，每次 daemon 启动轮换）；
- Core ingress 对 `/api/*`、`/ws`、`/ws/host` 全部要求 `authorization: Bearer <token>`（或 `?token=`，复用现有 server transport 客户端已实现的携带方式）；`/api/server-info` 允许匿名返回**仅版本与兼容字段**的降级形态，供升级提示使用；
- Adapter 在 bootstrap 阶段以目标用户身份经传输通道读取该文件——能读到 0600 文件即证明调用方是同一 OS 用户，鉴权边界从「网络位置」升级为「OS 用户身份」；
- token 只驻 Host 内存，不写控制端持久化与日志；WS 重连时重读文件（daemon 重启后 token 已轮换）；
- 一次性 host capability ticket（30s TTL、consume 即删）保留为 `/ws/host` 的第二层门，语义不变；
- `server-info.authRequired` 从硬编码 `false` 改为如实反映 token 要求。

### 6.2 握手时序

```text
Adapter                                    远端 daemon（Server Core）
  │ probe：exec bin/zcode status --json / 读 status.json
  │ ensureDaemon：serve --daemon（必要时）
  │ 读 run/ingress-token（0600）
  │ openChannel ══ Duplex → 127.0.0.1:<port> ══════════════╗
  │                                                        ║
  │ GET /api/server-info (Bearer token) ──────────────────►║
  │ ◄── { serverId, version, compatibility{min…}, migration{failedPathCount}, identity{osUser,hostname}, … }
  │
  │ ① 版本兼容判断（较新端 manifest，见 §6.3）→ 不兼容则停在 needs-upgrade
  │ ② Profile.sourceServerId 回填/校验：与已有记录不一致 → 按新 Source Server 处理并提示
  │
  │ POST /api/rpc-host-capability (Bearer token) → ticket
  │ WS /ws/host + ticket + token ─────────────────────────►║ desktop-continuous / trusted-host-relay
  │ assertRemoteWorkspaceRpcContract（channel 完整性）
  │ → Main：ProviderProvisioningEnvironmentCoordinator.register(...).initialSync
  │   （首连屏障，§8.3.2：applied/already-applied 才发布 ready；failed/rollback_failed/unsupported 走连接失败）
  │ → online：注册 Controller source，读取权威任务事实
  │
  │ （canonical key 解析/合并不在握手阶段：按 workspace 打开惰性执行，
  │   失败只阻止该 workspace 打开，见 §9.2；migration.failedPathCount 仅供连接页展示报告入口）
```

`/api/server-info` 扩展（新增字段全部 optional，`protocolVersion` 保持 1）：

```ts
interface ServerRemoteInfo {
  serverId: string; // = installationId = sourceServerId
  version: string;
  protocolVersion: 1;
  authRequired: boolean;
  compatibility?: CompatibilityManifest; // R3 起必有；缺失 → 判为 pre-R3，需升级
  migration?: { failedPathCount: number }; // 多线路合并失败的 workspace 计数；仅展示，不阻塞连接
  identity?: { osUser: string; hostname: string };
  capabilities: { desktopContinuous: true; websocketRpc: true };
}
```

Server 构造自身出参时使用 strict schema 自校验；Desktop/控制端解析 wire 入参时忽略未知字段，保证
`protocolVersion=1` 下新增 optional 字段不会击穿旧客户端。匿名 server-info 使用独立 schema，只暴露
`version/protocolVersion/authRequired/compatibility`，不得强行套完整握手 schema。

`identity.osUser` 是系统用户的展示信息，不参与 `sourceServerId`、workspace identity 或鉴权。
Server Core 与直接 HTTP Server 共用 Node 侧解析：优先读取 `os.userInfo().username`；
当系统返回 `uv_os_get_passwd` 的 `ENOENT`，且运行时提供 `process.geteuid()` 时，使用
`uid:<有效 UID>`，与 `os.userInfo()` 查询的有效用户一致。Docker 以未登记在 `/etc/passwd` 的数字 UID 运行时，仍须正常监听并发布
ready。不得读取可伪造的 `USER` / `USERNAME` 代替系统身份，不修改容器账户数据库；其他
查询错误或没有数字 UID 的平台继续保留原错误。

```text
用户名可查询 → 原用户名 → server-info
用户条目不存在 → 当前进程数字 UID → server-info → Core ready
安装 UUID → sourceServerId / workspace identity（与上述展示值独立）
```

回归：HTTP 两个入口验证缺用户条目时仍可读取握手信息；`R3A-TRN-01-UID` 通过 Desktop
Docker 入口连接数字 UID 容器并打开项目，核对 Server ready、安装 UUID 与 `uid:10001`。

验证（2026-10-20）：23 项聚焦回归通过；受影响测试 239 个文件完成验证（其中一个未修改的
遥测测试首次触发 Electron 下载而超时，下载完成后定向复跑 2/2 通过）。类型、Lint、格式和
架构检查通过。macOS arm64 Desktop → Linux arm64 Docker 的 `R3A-TRN-01-UID` 通过，
run `local-docker-20261020151240-63b1f0`，证据含截图、`docker-transport.json` 和运行日志。
保持 pending，未转正或加入 CI；未实跑 Windows/WSL、Linux x64 和手机 GUI。

### 6.3 版本兼容与远端更新（D10）

- Desktop 构建产物与 Server CLI 发行包各内嵌 `CompatibilityManifest`；判断规则：取 `productVersion` 较新的一端，用其 `minCompatibleVersion` 判断较旧端；兼容且版本不同 → 连接成功后主动显示一次非阻塞「可更新」提示，并在 Source 管理页保留更新入口；不兼容 → 阻止业务连接，展示当前版本/最低版本/应升级端。
- Server 较旧：用户显式点击连接时，在连接向导内自动发起一次 `force:false` 的受保护更新（远端带有效
  `downgradedFrom` 时除外，见下方「Desktop 较旧时显式切换远端」）；没有运行中
  Task 时直接更新并继续原连接意图，只有收到 running-task guard 后才向用户确认是否强制中断。启动重连、
  断线恢复和离线探测仍停在 `needs-upgrade`，只提供「立即更新」，不得静默更新或弹出确认。升级命令以
  `profileId + target` 为寻址边界，不要求预先握手得到 `sourceServerId`；Desktop 解析当前 release archive 后
  统一调用 Adapter `installOrUpdate`，因此 pre-R3 也能先升级再握手。存在运行 Task 时默认返回 guard
  错误等待，用户明确选择强制才允许继续。**更新是显式编排操作**：连接进入 `updating` 状态、暂停被动
  断连重试；更新完成后主动重新握手并回填 `sourceServerId`，失败展示原因与重试，不依赖 §7 的被动探测。
- **更新期间的连接（2026-10-30，ZCT-2116085848489570304）**：同一 Profile 或同一 Source 有在途更新时，
  Manager 的公开 `connect` 入口（窗口连接、设备卡连接、身份确认、启动重连）在写状态和设备操作日志之前，
  以 `source-server-update-in-progress`（`retryable:true`）拒绝：不 probe、不建 transport、不改 `updating`。
  更新完成后的重新握手走内部连接流程，不经过该入口。原连接意图只由发起更新的一方继续；后来的连接不并入
  更新，因为它要等完整个更新，也无法处理 running-task guard 的强制确认。UI 把该码显示为“远端服务正在更新”
  的等待点，不计为连接失败，也不由它触发新的更新。此前同一向导在更新上传期间再次连接，连接 probe 到旧版本，
  把状态改成 `needs-upgrade` 并替换更新日志，用户只看到“必须升级”，更新仍在后台进行。

```text
更新 flight（profileId / sourceServerId）── probe ── archive ── 安装 ── 内部重新握手 ── online
          │
其他入口 connect() ── 命中同一 Profile 或 Source 的在途更新 ── 拒绝 source-server-update-in-progress
                                                     （不改状态、不写日志、不建 transport）
```

- **更新的本机阶段与取消（2026-11-03，ZCT-2117527614209818624）**：一次更新分两段。本机阶段是 probe、
  release 解析和本机下载 archive（本地下载后上传模式）；远端阶段从 Adapter `installOrUpdate` 开始（预检、
  上传或远端下载、解压、校验、重启），之后是内部重新握手。
  - 本机阶段进行中，Host 状态快照在 `updating` 上另带 `updateCancelable: true`。Manager 在调用
    `installOrUpdate` 之前同步去掉该字段；之后的取消请求不生效。字段由 Host 唯一维护，Renderer 只读。
    Host 写状态时按该 Profile 的更新 flight 推导此字段：写入 `updating` 且有处于本机阶段、尚未取消的更新时
    才带上。因此本机下载期间旧在线连接关闭（预期断线的连接失效投影）后快照仍带该字段。
  - `SourceServerManagementService.cancelSourceUpdate(profileId)` 只取消该 Profile 处于本机阶段的更新 flight，
    返回 `{ canceled }`；其他情况为空操作，返回 `canceled: false`，不报错。Renderer 收到的快照可能稍晚于
    Host 的阶段切换，因此是否取消以返回值为准。取消使用独立的取消信号，不是断开：不删除恢复意图，不发布 offline 终态。
    更新按失败路径收口，但不写入错误字段：在线时恢复更新前状态；离线时与失败相同，有恢复意图则重新进入
    恢复，没有则为未连接并保留兼容字段（仍需升级的设备继续显示“需要更新”）；尚无设备身份的线路恢复
    更新前状态。设备操作日志以 info 级记录
    `remote-connection-canceled`，`updateSource` 以同一错误码拒绝。远端没有被写入，无需回滚。
  - release 解析接收更新的取消信号：descriptor 与 archive 的请求和写盘都传入 `signal`，中止后不再尝试下一个
    候选地址，并删除未完成的临时文件。显式断开、删除 Profile 与 Host 释放因此也能立即停止本机下载。
    首次安装的连接流程复用同一 resolver，传入连接 flight 的取消信号与日志：「取消连接」同样立即停止本机下载，
    安装阶段同样显示下载进度。
  - 本机下载 archive 时写入 `download` 阶段日志：先记“开始下载”，再按不超过每 500 毫秒一次写入
    `download progress: N% (已下载/总量 MB, 速度 MB/s)`，带 `progress`。格式与上传进度一致，向导、设备卡和
    最近日志直接复用。缓存命中不下载、不写进度。远端下载模式的进度仍由远端命令输出。
  - 本期不改超时：本机请求仍使用 Node fetch（undici）的默认超时（连接卡住时约 300 秒后失败）。
  - 此前本机阶段没有任何日志，也不响应取消；向导的「取消连接」在整个更新期间禁用。下载 90MB archive
    在慢网下要几分钟，用户只看到“Checking the remote device”，界面停在“更新中”且无法退出。

```text
updateSource ─► updating + updateCancelable ─► probe ─► 解析 descriptor ─► 本机下载（download 进度）
                     ▲  cancelSourceUpdate：中止本机请求，按失败收口（无错误字段）┘
                     └───────────────────────────────────────────────────────────────┐
installOrUpdate 之前：去掉 updateCancelable ─► 预检 / 上传 / 解压 / 校验 / 重启 ─► 重新握手 ─► online
                                              （远端阶段：cancelSourceUpdate 为空操作）
```

- Host 状态快照是版本判断唯一权威，固定携带
  `updateAvailability: none | available | required`、`currentVersion`、`availableVersion`、
  `minimumVersion`、`upgradeTarget`、`errorCode`、`retryable`，远端被显式切换到旧版本时另带
  `downgradedFrom`；Renderer 不自行比较版本。
- `source-server-upgrade-required` 的连接失败保留 Host 实际使用的 `profileId`，由严格 Host 响应 schema 校验并经 Main 透传。它只标识本次失败的线路，升级资格仍须读取最新 Host 快照；不传凭据、不新增持久化状态。WSL 参数规范化后，向导以该线路的实际目标继续更新和重连，避免默认用户与 UI 原始参数不一致导致升级入口空操作。
- 自动升级以失败时的不可变目标身份为约束，`profileId` 只标识可编辑记录。WSL 升级失败与安装等待均返回本次解析的 `resolvedWslTarget`。向导先核验最新 Profile 的目标，再提交 `updateSource({ profileId, expectedTarget, force })`；`expectedTarget` 只包含 SSH 地址/端口/用户/配置别名、WSL 实际发行版/用户或 Docker 容器，不含凭据。
- Host 对 `expectedTarget` 做严格运行时校验，并比较当前 Profile 与解析目标。更新使用同一 Profile 快照解析出的固定 target，不能在校验后再按 ID 取目标；不匹配返回 `remote-target-changed`，不 probe/install/reconnect，UI 终止旧升级并显示显式重试。force 确认期间仍携带原身份。旧的无 expectedTarget 管理入口保持兼容；不改变桌面 continuous / 手机 replayable 及远端任务 owner。

```text
失败目标 A → UI 最新 Profile 校验 → expectedTarget=A → Host 校验并固定 A → 更新
                    改为 B ─拒绝──────┘           改为 B ─拒绝──────┘
Host 已固定 A → 后续 Profile 编辑 B → 在途操作仍只使用 A
```

- `source-server-install-required` 同样保留实际 `profileId`。WSL 安装失败响应另带严格校验的 `resolvedWslTarget: { kind: "wsl", distro, user }`，两个身份字段均非空，不含凭据。它来自本次 Host 连接请求的已解析目标，独立于附加安装预览；预览不可用时仍可确认同一目标。该字段经 Main、平台和原项目失败交接保留，不改变发现缓存、持久化、安装授权或桌面/手机传输边界。
- 公开错误码统一由 `@zcode/shared` 登记并由 CLI/Host 消费：running-task guard 使用
  `source-server-update-running-tasks`（`retryable:false`，允许用户显式 `force`），兼容阻断使用
  `source-server-upgrade-required`，更新期间被拒绝的连接使用 `source-server-update-in-progress`，
  未授权的降级使用 `source-server-downgrade-unconfirmed`（`retryable:false`）；workspace migration 与 bind cancel 同样不得维护各自白名单。
  远端服务生命周期（§8.4.5）使用 `source-server-stop-failed`（Supervisor 停止 Core 失败进入 `stop-failed`）与
  `source-server-control-unresponsive`（control 请求超时；由 control 客户端统一打码，所有 control 命令超时都带此码）。
- 连接/部署失败统一经 shared 分类：认证失败、需要额外验证（二次验证）、拒绝连接/不可达、超时、主机不存在、明确的 SSH host-key 校验失败、下载、上传、预检、安装、远端空间/权限、取消与未知都有公开码。AggregateError 读取内层码，空消息补非空兜底，Host 失败响应不能因 schema 拒收而悬挂；UI 映射中英文，未知码显示通用文案。
- 用户可见日志只接收流水线显式进度，Host console/其他服务的诊断不转发。绝对路径、token、凭据引用与设备标识统一脱敏；等待安装确认是 info。连接反馈预填这份日志，不默认上传全量诊断文件。
- 连接日志的凭据字段还包括各类 `apiKey` / `api_key` / `api-key`、`secret`、Authorization 与 Cookie / Set-Cookie；Bearer 与 Basic 凭据均遮蔽。普通 Authorization/Cookie Header 的值覆盖至行尾，带引号键名的结构化字段按完整转义字符串过滤；重复过滤保持幂等，后续日志行仍保留。
- Server CLI 原生提供 `version --json`/`--version`，不得把版本输出委托给 Agent `zcode.cjs`。探测 pre-R3
  安装时允许从旧文本输出提取唯一合法 semver；无法证明兼容时保守进入 `needs-upgrade`。
- Desktop 较旧：主动作是升级 Desktop；不得自动降级 Server。用户回退 Desktop 后仍要使用该远端时，
  按下方「Desktop 较旧时显式切换远端」由用户确认切换。
- R2 存量 server（无 compatibility 字段）判为过旧，走同一升级链；R3 Desktop 的 `minCompatibleVersion` 设为首个携带 R3 握手合同的 Server 版本。
- 当前发布默认不在根 `package.json` 中声明 `zcodeCompatibility` 覆盖；Desktop 与 Server CLI 构建都将缺失的 `minCompatibleVersion` 回退为当前 `productVersion`，因此默认只承诺同版本兼容。只有在完成跨版本合同与发布验证后，才可重新显式声明更低的 `zcodeCompatibility.minCompatibleVersion`。
- Server 较旧且必须升级时，启动重连提示、连接向导失败面板和连接管理页都必须提供就地「立即更新」，并统一提交到 `SourceServerManagementService.updateSource`；不得要求用户记住或寻找 Settings 中的唯一入口。Desktop 较旧时主动作仍导向 Desktop 升级，不显示 Server 更新动作；只在连接向导失败面板与设备卡提供次级的「将远端切换到 <版本>」。
- 启动/任务列表重连的 Source Server 更新 Toast 使用独立展示变体：顶部居中、完整换行展示设备与版本文案、完整「立即更新」和关闭入口。该变体只服务 Source Server，不改变 Desktop 应用更新等既有 compact update Toast 的位置与截断规则。
- 连接向导接管某个目标后，该目标的 Server 必须升级提示由向导呈现，全局 Toast 不重复提示；收起向导仍保留接管，退出/改选目标才释放，其他设备和 Desktop 升级提示不受影响。向导在发起连接前同步发布目标，不能等 `needs-upgrade` 后才抑制提示。Host 进入 `updating`、升级需求解除或 Profile 被移除时立即撤销旧升级 Toast；点击动作须重新核对当前快照，同一提示只提交一次更新。失败回到需升级状态后保留重试入口，不因旧提示去重永久丢失通知。
- 更新动作默认先以 `force:false` 执行；只有收到 `source-server-update-running-tasks` guard 后，才向用户二次确认并以 `force:true` 重试。「版本不兼容」本身不等于授权强制中断运行中 Task。
- 「更新中」必须在所有入口中覆盖旧的 required/error 文案，展示明确的 loading、当前结构化阶段和可展开日志；只在上传/下载产生可验证数字时展示百分比，其他阶段使用不定进度。成功后自动重新握手并继续原连接意图；失败保留阶段、日志、重试和手动指引。
- `applied:true` 是完整远端运行时收敛合同：`current.json`、Supervisor、Server Core、Agent/Plugin Host
  必须来自同一个目标 release。当前 Supervisor 可以先验证候选 Core ready，但目标版本 CLI 随后必须停止
  旧 Supervisor，从目标 immutable release 重新执行 `serve --daemon`，并经 control runtime identity 校验后
  才允许成功；不得把 `status.version` 或新 Core ready 当作整个 daemon 已换代。更新中的短暂离线属于
  `updating`，不能发布新的 online attachment。
- 已识别 Source 的显式更新必须复用 §7.1 的 physical → logical 换代 seam：只有旧物理连接实际从 Manager online owner 中移除时，才把该 Source 的既有 logical workspace 标为 recoverable offline；新物理连接握手成功后，必须发布同一 Source 的 reconnect handle，由 `WindowRemoteConnectionRegistry` 换代 `remoteSessionId`、generation、scoped services 与 Desktop/Mobile attachment。running-task guard 或更新准备失败且旧物理连接仍存活时，禁止失效或换代 logical workspace。

```text
版本不兼容
  ├─ 用户显式连接 ─────────► 连接向导自动 updateSource(force=false)
  ├─ 启动/重连 Toast ──────►「立即更新」─┐
  └─ 远程设备 Server card ─►「立即更新」─┴─► updateSource(force=false)
                                                           │
                                                           ├─► Host operation log Event
                                                           │      └─ phase / message / real progress
                                                           ├─ running-task guard
                                                           │      └─ 用户确认 ─► force=true
                                                           └─ old physical owner removed
                                                                  └─ logical offline
                                                                       └─ success ─► re-handshake
                                                                            └─ logical/attachment 换代
                                                                                 └─ 继续原连接意图
```

**Desktop 较旧时显式切换远端（2026-10-21）**

场景：用户升级 Desktop 后，向导把远端升到新版本；用户再回退 Desktop，旧 Desktop 因 Server 较新而无法连接。

- 入口：只在 `needs-upgrade + upgradeTarget: controller + updateAvailability: required` 时出现次级动作
  「将远端切换到 <Desktop 版本>」，位置为连接向导失败面板和设备卡的必须更新区；主动作仍是「更新桌面端」。
  启动 Toast 不提供该动作。版本号取 Host 快照的 `currentVersion`（较旧端，即本机 Desktop）。
- 确认：点击后必须二次确认。文案说明：仍在使用新版本的设备连接时需要再次升级远端；旧版本可能无法完整显示
  新版本写入的内容。取消不发请求。
- 执行：确认后提交 `updateSource({ profileId, expectedTarget?, allowDowngrade: true, force: false })`，复用
  同一条更新链：`updating`、操作日志、running-task guard 后由用户确认再以 `force: true` 重试，重试保留
  `allowDowngrade`。成功后重新握手，并继续原连接意图。
- 授权 owner：降级判定只由远端 Server CLI 执行。`zcode update --from-archive` 持有 update lock 后比较 archive
  版本与 `current.json` 版本。目标更低且没有 `--allow-downgrade` 时，删除本次写入的 `pending.json`，以
  `source-server-downgrade-unconfirmed` 失败，不切换 release。Desktop 不用 probe 结果预判方向：probe 之后
  其他设备可能已把远端升到更高版本，这时普通升级也不能把它静默降级。
- 降级标记：CLI 接受降级时写 `<serverRoot>/downgrade.json`：`{ releaseId, fromVersion }`。标记只在
  `releaseId` 等于 `current.json.releaseId` 时有效。之后的升级或失败回滚到其他 release 都会让它自然失效，
  不需要额外清理。probe 在同一次远端 round-trip 中读取它；Host 只在 `needs-upgrade + upgradeTarget: server`
  上发布 `downgradedFrom`，该字段随兼容字段在 `updating`、`offline`、重试状态中保留。
- 新版 Desktop 再连接：远端带 `downgradedFrom` 时，连接向导不自动更新。失败面板说明远端已从 `downgradedFrom`
  切换到当前版本，由用户点击「立即更新」确认后才升级。启动 Toast、设备卡本来就需要用户点击，行为不变。
- 数据：切换只换程序 release，不回滚、不迁移用户数据。风险与本机 Desktop 回退相同，见 §9.3。

```text
Desktop 3.17 连接 → 向导自动升级 → Server 3.17
Desktop 回退到 3.16.2 → 连接 → needs-upgrade(upgradeTarget=controller)
   ├─「更新桌面端」（主动作）
   └─「将远端切换到 3.16.2」（次动作）→ 二次确认 → updateSource(allowDowngrade=true)
          → CLI：目标 < current，且带 --allow-downgrade → 写 downgrade.json → 切换 release
          → 重新握手 → online
Desktop 3.17 再连接 → probe：版本较旧 + downgrade.json 有效
   → needs-upgrade(upgradeTarget=server, downgradedFrom=3.17)
   → 向导不自动更新 → 用户点击「立即更新」→ 正常升级 → downgrade.json 失效
```

- 更新失败：更新操作状态与兼容状态分栏。若更新前 Source 在线且版本兼容，running-task guard、下载/上传或安装失败后必须恢复原 `online + updateAvailability` 事实，只附加本次更新错误与重试/强制更新入口；不得把可用 Source 改判为 `needs-upgrade + required`。只有握手 compatibility 明确不兼容，或开发态内容寻址判定 archive SHA 不一致（连接前必须先更新）时才进入阻塞式 `needs-upgrade`。一期不在控制端追加额外 release 回滚编排。
- 显式断开、删除更新中的 Profile 或 Host 释放必须取消 Manager 持有的在途更新，覆盖 probe、release 解析（含本机下载，见上方「更新的本机阶段与取消」）、安装、running-task 清单读取和重新握手。Profile 尚未取得 `sourceServerId` 时也按 Profile 取消；Source 断开取消该 Source 的全部更新。迟到成功、失败及清理不得重新拨号、发布 online、恢复旧状态、安排重试或覆盖后续手动连接。取消只终止本机连接意图，不承诺回滚远端已应用的 release；正常更新及意外断线恢复沿用既有合同。
- 删除非当前更新线路时，若更新已使旧物理连接失效，且该 Source 没有其他在途更新，Manager 必须在删除操作中把恢复交回仍保留的原恢复线路，复用既有重试；不得等待被取消更新的迟到结果。仍在线、后续已连接或其他更新尚在进行时不另启恢复。删除当前恢复线路、显式断开或 Host 释放仍是终态，不选择替代线路；桌面与手机继续消费同一 Source 恢复 owner。
- Host 释放还必须清除离线 Source 的恢复输入，覆盖正在 retry 或 offline probe 的连接；中止 flight 后的迟到 catch 不得重新安排定时器或发布无 owner 的连接。

```text
更新 → Manager 登记独立操作 → probe / archive / 安装 / 重握手 → online
              │
断开 / 删除 / 释放 → 取消并移除该操作 → 迟到结果只退出
                                           └─ 保留 offline / 已删除状态 / 后续新连接
```

```text
A 在线 → B 更新 → 旧物理连接失效 → 删除 B
                                  ├─ 仍有其他更新 → 由该更新收口
                                  └─ 原恢复线路 A 仍保留 → 既有重试 → A 在线
```

## 7. 连接生命周期与自动重连（D9）

### 7.1 状态机（窗口级，每 Source Server 一份）

```text
                ┌────────────── App 启动：近 7 天使用过的 Server
                │               （≤3 并发、单节点 10s、只试一次、静默）
                ▼
 absent ──connect──► bootstrapping ──不兼容──► needs-upgrade（用户动作）
                │        │ probe→install?→daemon→channel→握手
                │        └─成功
                ▼        ▼
             failed    online ◄────resync 完成──────┐
                          │ 通道/WS 断开             │
                          ▼                         │
                       retrying（2s → 4s → 8s，×3）──┘
                          │ 全部失败
                          ▼
                       offline（每 2 分钟静默探测 + 手动重试 + 「最近在线时间」）
                          │ 探测可达 且 凭据可静默获得
                          └────────► bootstrapping（无交互路径：不弹凭据、不装新版本）
```

- **静默前提**：自动路径（启动重连/断连重试/离线探测）只允许无交互步骤——凭据必须能从 credential store 静默取得（私钥无口令、或密码/口令已保存）；需要输入密码、需要安装确认、版本不兼容的一律停在对应状态等待用户。
- **终态后的新恢复周期**：同一 Source 重新发布物理连接时，Registry 先为旧 terminal owner 建立新的恢复屏障并清除旧失败，再开始异步挂回。其他线路此时 join 同一 Source 必须等待新周期，不得读到旧安装/升级等待错误；恢复预算和 Manager 的连接单飞语义保持不变。
- **断连期间**：沿用 R1 语义——保留最后可信 task 投影并标记 `sourceAvailability=offline`，所有写与 IO fail-closed，不回落本地；重连成功后由新 source snapshot 原子替换（`replaceDisconnectedSource` 既有路径）。
- **恢复完成**：补齐 Task/Session/待确认请求（复用现有断连数据恢复：权威状态查询 + 增量收敛）；存在待确认请求时，由底部阻塞卡片消费 `pendingInteractions` 投影，不再显示顶部 warning 提示及“去处理”入口，不新增第二事实源。该展示规则适用于本地桌面、远端桌面和手机 Web。远端在断连期间继续运行是 daemon 的自然行为，恢复只是重新读取权威状态，不重放输入。
- **启动重连的范围**：主窗口 Host 启动时对「近 7 天有 `lastOnlineAt` 的 Server（`SourceServerRecord.lastOnlineAt`，取其默认线路）」发起（一期按单窗口设计；Profile 的 `lastConnectedAt` 只用于线路排序，不参与门禁）。设备 online 后 Renderer 挂回当前窗口该设备下全部 open 的 `remote:server:*` 断连 tab，不再按工作区年龄或上次 connected 历史过滤（见 [remote-device-sidebar-device-level-connect-spec.md](./remote-device-sidebar-device-level-connect-spec.md) C3）；这是对现状「冷启动只恢复断连条目、等待手动重连」（SSH-P0-LIFE-01）的显式行为变更，case catalog 需同步更新。
- **探测**：轻量路径（传输拨号 + 匿名 server-info），成功才进入完整 bootstrap；探测不产生用户可见 UI 变化，除状态徽标外。
- **最近在线**：握手成功初始化 `lastOnlineAt`；Manager 从 online 离开时，用 Host 时钟向 Directory 的串行写队列提交最后在线时刻，落盘后通过原目录事件刷新投影。后续离线重试不推进时间；迟到写入不得覆盖更晚握手，也不得重建已移除的 Source。此元数据更新不改变 desktop continuous / mobile replayable 的恢复链。
- daemon 不在（如服务器重启且未注册自启动的 WSL/Docker）时，自动重连允许执行 `ensureDaemon`（不含安装/升级）。
- **生命周期操作**：更新与重启共用 Source 级生命周期操作 flight。flight 存在时，在线连接关闭视为预期断线，只做连接失效、不排 retrying；命令完成后由 flight 自己走连接流程并发出 reconnect。停止先完整执行显式断开（删除恢复意图），再执行远端命令，因此不会触发 retrying 或离线探测。合同见 §8.4.5。
- **发布前断连**：物理连接只有在 Manager 把它登记为该 Source 的 online owner 之后才进入「通道/WS 断开 → retrying」路径。握手落盘（`recordHandshake`）期间连接关闭时，Manager 不得把已关闭连接发布为 online，而是按普通连接失败收口（`failed` 且 `retryable:true`，自动路径继续下一档重试）；同一 Source 上其他 Profile 的握手期断连不得影响已在线的 owner。close 事件只作用于它所属的那条连接，不按 `sourceServerId` 泛化。

恢复 owner 与换代 seam：

```text
Source transport 断开
  -> SourceServerConnectionManager 只负责 2/4/8s transport reconnect flight
  -> WindowRemoteConnectionRegistry 保留同一 connection entry，并把旧 logical session generation 标为 offline
  -> Host 关闭旧 scoped port；Desktop/手机分别进入 reconnecting/recovering，Controller 保留最后可信投影
  -> Manager 产出新 connection handle
  -> Registry 以 entry + generation CAS 为仍打开的 workspace 换代 remoteSessionId/generation
  -> Host/Main 原子重建 Desktop attachment
  -> Main 摘掉绑定旧 remoteSessionId 的 Provisioning lane，以新 remoteSessionId 重新 register
     （触发一次 environment-online 整份重下发；失败只 warn，不拆 Workspace，§8.3.2）
  -> Main 先完成 Desktop attachment 并通知 Renderer；手机恢复不参与 Desktop 成功与否的裁决
  -> Main 向旧手机 bridge 发送非终态 bridge-degraded，Web 主动以新 bridgeSessionId/generation
     重建 replayable attachment，完成 gap/snapshot 恢复后再回到 ready
  -> 释放旧 connection/session/port
```

- `WindowRemoteConnectionRegistry` 是 connection handle、logical session、`remoteSessionId`、generation 与
  `sourceAvailability` 的唯一恢复 owner；Manager 不直接持有或替换 Renderer/手机 attachment。
- SSH/WSL/Docker route key 只允许作为握手前的 provisional lookup key。握手取得
  `sourceServerId` 后，managed connection entry 的 canonical owner key 必须收敛为
  `source:<sourceServerId>`；同一窗口内允许多条 route alias 指向该 Source entry，但禁止每条 Profile
  各自保留一个 online/recovering entry。Source owner claim 必须发生在 entry、logical session 或 attachment
  发布 online 之前；竞争失败的 provisional entry 只回收 logical wrapper/订阅，不能断开 Manager 持有的
  物理 Source connection。
- transient close 后 persistent Source entry 继续占有 connection key；手动重连只触发或加入同一个
  Manager/Registry recovery flight，不得创建第二个 entry。任何 `entriesByKey` 写入和 logical replacement
  都必须验证预期 entry/generation，迟到 flight 不能覆盖新 owner。
- 每个 connection entry 维护单调 `transitionEpoch`。recovery replacement、手动 connect join、workspace
  prepare 与 attachment 换代在跨 `await` 前捕获 epoch，恢复后必须同时校验 entry owner、epoch、
  `closePhase/state` 和 logical session identity；期间到达 terminal close 时旧 flight 必须 fail-closed，
  禁止重新发布 online。
- `connectionKey + workspaceKey` 同时只能有一个 online/recovering logical owner。Bot/手机触发的重连必须
  join 已有 recovery，返回换代后的唯一 session；不得另建第二个 logical session 再由上层事后清理。
- logical replacement 的提交与回滚单位是单个 `connectionKey + workspaceKey`，不是整个 Source entry。
  同一物理 Source 上 workspace A 的 Controller/Main attachment 已完成 generation 换代后，workspace B 的
  prepare、Controller snapshot 或 attachment replacement 失败只能回滚并重试 B；不得把 A 的 Registry owner
  回滚到旧 `remoteSessionId`。物理 transport 在 logical replacement 失败期间继续保持 online，仍未提交的
  workspace 保持 offline 且所有 scoped IO fail-closed；预算耗尽也只终态化这些 workspace。
- `SourceServerConnectionManager` 拥有常驻物理 Source 连接与离线探测；Window registry entry 只拥有
  logical wrapper 和订阅。最后一个 logical owner 释放或 entry 被新 owner 替代时必须回收 wrapper/订阅，
  但不得隐式调用 Manager 的物理 `disconnect`。物理断开只来自连接管理页的显式操作或 Host shutdown。
  被替代 entry 上仍 pending 的 recovery 等待者必须以连接取消错误结束；仅 abort transport 不能代替
  拒绝 recovery Promise。已转交到 canonical Source owner 的请求继续由该 owner 完成，不受旧 entry 释放影响。
- 设备 transport 会话（SSH 连接、WSL 子进程等，含其中的凭据）同样由 Manager 拥有。Adapter 按 target 对象缓存会话；
  重试、离线探测和设备操作沿用恢复意图的 target，从而复用同一会话。target 的持有者结束时，Manager 必须释放它的会话：
  显式断开与删除当前线路释放恢复意图的 target；新连接以另一个 target 发布、替换恢复意图时释放旧 target；连接、更新、
  重启、停止和运行中任务读取结束时，所用 target 若不是当前恢复意图的 target，也要释放。不能只在 Host 释放时整体回收：
  否则每次更新或用新 target 连接都会多留一条到设备的空闲会话，停止远端服务后本机仍连着设备（2026-10-21 修复）。
- logical replacement/attachment replacement 失败有自己的有界重试；物理 connection 已恢复后不得等待
  下一次断线才重新触发。被替换的 `ServerRemoteConnection` 必须显式 dispose。
- logical replacement 定时重试只属于安排时的 transport epoch；执行时 entry 必须仍 online 且
  `transitionEpoch` 未变。再次收到物理 close（包括 recoverable 与 terminal）时立即取消旧定时器；
  迟到回调不得把 disconnected 改为 online、消耗新恢复周期的预算或清除新周期的定时器。
  recoverable close 后等待者继续等待真实重连，terminal close 则拒绝等待者；只有真实重连或
  已连接 handle 接管能启动新一轮换代，定时器不能充当 transport 已恢复的证据。
- Manager 的 `onDidReconnect` 只有一个事实源：同一 Source 在首次发布 online 之后、显式断开之前再次被发布
  为 online（无论由 2/4/8s retry、离线探测、`updateServer`，还是 `connectProfile` / `confirmIdentityChange`
  等手动 `connect()` 触发）。手动连接成功也必须让 Host wrapper 换 services、Registry 完成 logical 换代；
  不允许出现「Manager online、Registry 仍 recovering、新 join 永久等待」的分叉。首次发布与 sibling Profile
  join 已在线 owner 不是重连，不 fire。
- 重连成功不能只更新 Manager 内部 `services` 快照；在 Registry 完成 handle/session 换代之前，旧 source
  始终保持 offline，所有写与 IO fail-closed。
- Desktop attachment 继续注入 `desktop-continuous`，手机 attachment 继续注入
  `web-remote-replayable`；换代只重建各自 connection-owned subscription，不把 replayable snapshot/gap
  语义扩散到 Desktop。
- 手机 bridge 在 transient retry 期间只发送 recovering 状态，不发送终态 `workspace-bridge-error`；只有
  恢复预算耗尽、凭据/版本/迁移需要用户动作或用户显式断开时才进入终态错误。
- Renderer 必须区分自动恢复与用户手动重连：自动恢复显示当前尝试次数与固定预算（1/3、2/3、3/3），
  手动重连不伪造自动重试计数；预算耗尽进入明确终态并展示 Host 提供的 `reasonCode/retryable` 映射。
  recovering 期间 scoped services 已释放，sidebar 的 workspace 展开、task 点击、新建任务及写操作全部
  fail-closed，直到 replacement attachment ready。Bot 的连接状态查询只认 attachable route，不得把 closed /
  recovering route 报为 connected。
- Manager 的每次 retry 状态必须穿过 Registry/Main 到达 Renderer；Registry 处于 recovering 时不能把后续
  recoverable close 当作重复终态丢弃。预算耗尽使用公开 `reasonCode` 与本地化文案收口，不得用 Host 内
  硬编码中文正文覆盖客户端 locale。
- Main 不得使用相同 `bridgeSessionId + bridgeGeneration + recoveryId` 新建 seq 从 1 开始的
  acknowledged relay protocol；新 protocol 必须具有新 identity。手机 attachment 重建失败不得
  dispose 已就绪的 Desktop logical session。
- `bridge-degraded` 是 bridge generation 的持久 invalidation latch，不进入普通 5 秒 app payload buffer。
  Source 换代后立即释放旧手机 attachment，并在 relay paired/send-ready 时重复发送 invalidation，直到
  手机以新 bridge identity 完成 `workspace-bridge-ready`。Web bridge rebuild 失败按同一 recovery generation
  有界重试；普通 transport 后台恢复不得误建新 Agent/Host/session。
- 旧 `remoteSessionId`、旧 generation 和旧 scoped port 在新 attachment ready 后统一释放；任何迟到事件、
  owner command 或写请求必须被旧 scope 拒绝。
- workspace bind 以 `requestId` 建立 Main deadline。deadline 到期后 Main 必须向 Host 发送 cancel；Host 在
  每个跨 `await` 的远端 RPC 前后检查 cancel epoch，特别是 `recordWorkspaceOpen` 后、发布 success 前必须再查。
  迟到完成只回收该 bind request 新建且独占的资源；join 到既有 logical session 或仍有其他 attachment owner
  时不得无条件 `disposeSession`。Main timeout 自身也返回 `remote-bind-canceled`，迟到 ACK 幂等忽略，禁止超时
  调用方消失后留下幽灵 scope或连坐其他 owner。

### 7.2 等待用户确认（3.11）

权限/输入等阻塞请求保存在 Source Server（Agent/Core 既有行为）；控制端断开不拒绝请求、Agent 不因失去 attachment 退出（daemon 化后自然成立，取代旧主链「连接断开 server 即死」的行为）。重连后按恢复流程重新拉取 `pendingInteractions`：Desktop 自动恢复、Desktop 手动重连和手机 replayable attachment 都以首次 snapshot 重新投影请求。底部权限/问答卡片读取该投影；resolve 后随下一帧权威 snapshot 消失。顶部不再重复显示待处理请求提示。

## 8. Source 权威与配置面（D7 / D11）

### 8.1 权威表

| 数据/能力                                            | 权威                                      | R3 变化                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace 文件、Git、Terminal、Task、Session、运行态 | Source Server / Agent CLI                 | 不变（远端权威），服务改为全转发                                                                                                                                                                                                                                                                                                        |
| Task 索引、pin/archive、workspace 设置               | Source Server                             | 不变；Controller 只聚合与路由                                                                                                                                                                                                                                                                                                           |
| MCP、Skills、Hooks、插件、Commands、权限模式         | Source Server                             | Skills/Plugins/Commands/Hooks 已远端；**Subagents/Memory/OutputStyle/settings-sync 从本地切到远端**，消除 UI 与 runtime 事实源分裂                                                                                                                                                                                                      |
| 模型 Provider 配置、模型可用性                       | Source Server（执行镜像）；本机是编辑权威 | **主链切换**：删除 desktop-attached 下发；远端 `standalone-server` 自权威读取自己的 Built-in Release + Personal Layer 并构建 Registry。Personal Layer、Configured Default 由本机 Provider Provisioning 自动单向覆盖，远端不提供编辑入口；对话区 / Subagents / Automation 的模型目录从目标 Host 的 `model-selection` Facade 读取（§8.2） |
| OAuth / `zcodejwttoken` 登录态                       | 各端自持；本机为源                        | Provisioning allowlist 凭据（`oauth:active_provider`、`oauth:zai\|bigmodel:*`、`zcodejwttoken`、`account-provider:*:api-key`）随每次下发 replace 到目标 Source，Source 端解密、目标端用自身 Credential Store 重新加密；本机登出 / 换号在下一次触发时收敛。远端不能自行发起浏览器 OAuth                                                  |
| Connection Profile、窗口、Theme、Locale              | 控制端                                    | Theme/Locale 由窗口 base attachment 的本地服务提供，不随 Source 切换                                                                                                                                                                                                                                                                    |

服务集合落点：三种 transport 统一改用 `createServerRemoteWorkspaceServiceCollection({ connectionServices, sourceServices })` 的全转发模式（`packages/desktop/src/host/remoteWorkspaceServiceCollection.ts`），删除 SSH/WSL/Docker 专用的「本地权威混装」分支；`onDynamicSessionRuntimePreferencesRequest` 反向桥随 desktop-attached 模式一并退役。全转发集合同时把 Host 私有的 `RemoteProviderProvisioningExecutor`（本机 `ProviderProvisioningSource` + 远端 `IProviderProvisioningTargetService`）登记在 WeakMap 上供 Main 调度，不进入 Renderer RPC（§8.3）。

全转发下 app-global 类服务（OAuth、usage-stats、bots、coding-plan-subscription 等）在 remote scope 的行为需在实施切片 5 按 channel 清单逐项确认，其中已定：远端 Source 不能直接发起浏览器 OAuth（控制端浏览器无法服务远端回调），而是由 Provider Provisioning 自动接收本机当前 active OAuth 会话（allowlist 凭据）；目标未持有可用模型时，对话区显示「此远程设备尚无可用模型，请先在本机配置模型，保存后会自动同步到远程设备」，配置 / 升级动作始终指向本机。

实施确认后的 `RemoteWorkspaceRpcContract v1` 清单：

| channel 组                                                              | remote scope 权威/行为                                                                         | 一期限制                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| file/file-watcher/git/git-checkpoint/system/terminal                    | Source Server 全转发                                                                           | `workspacePath` 只用于远端 IO                                                                                                                                                                                                      |
| zcode-task/zcode-agent/zcode-session                                    | Source Server/CLI 全转发                                                                       | Desktop continuous；手机保持 replayable attachment                                                                                                                                                                                 |
| setting/credential/broadcast                                            | Source Server 全转发                                                                           | Connection Profile、Theme、Locale 仍属控制端 base attachment                                                                                                                                                                       |
| onboarding-record                                                       | Source Server 全转发（与 setting/OAuth 同源）                                                  | 不借用控制端记录；手机 replayable allowlist 放行，见 onboarding-record-spec §5.1                                                                                                                                                   |
| provider-settings/model-selection/media-preview                         | Source Server 全转发（远端 Facade 读远端 Registry）                                            | 设置页「模型设置」不消费远端 `provider-settings`（永远绑定本地，§8.2）；对话区 / Subagents / Automation 模型目录消费目标 Host 的 `model-selection`；`media-preview` 是合同必有 channel，由 `assertRemoteWorkspaceRpcContract` 校验 |
| provider-provisioning-target                                            | 远端 Environment 内部 Provisioning target；**Host-only**                                       | 不在 `RemoteWorkspaceRpcContract v1` 内，不进 Renderer、不进手机 allowlist；`/ws` replayable 连接拿到抛错 stub（§8.3.4）                                                                                                           |
| OAuth/usage-stats/coding-plan/client-scenes/bots                        | Source Server 全转发                                                                           | 远端不直接启动浏览器 OAuth；消费 Provisioning 下发的会话且不回落控制端服务                                                                                                                                                         |
| skills/MCP/plugins/commands/hooks/subagents/memory/output/settings-sync | Source Server 全转发                                                                           | Source 离线 fail-closed                                                                                                                                                                                                            |
| conversation-share                                                      | Source Server 使用目标 OAuth/JWT、HTTP、Rows/File 执行；Desktop 转发 trusted attachment 上下文 | SSH/WSL/Docker 可发布；Server 直连与手机仍禁用；详见会话分享 spec 的 R3 权威约定                                                                                                                                                   |
| prompt-attachment-transfer                                              | Source 本地实现保留；SSH/WSL/Docker 的 Window Host attachment 覆盖跨机 staging                 | 复用当前 Transport backend 上传 desktop localPath；operation 由 attachment 持有，关闭时取消未 adopt 内容；不引入 Resource Store，见附件物化 spec                                                                                   |
| repo-wiki                                                               | Source Server 全转发                                                                           | 使用远端文件和模型                                                                                                                                                                                                                 |
| source-server-workspace                                                 | Source Server canonical alias/迁移权威                                                         | `legacyRouteHint` 只在 Host→Core 边界使用，不进入 Renderer/手机身份                                                                                                                                                                |

新增 channel 必须先更新本表与 `RemoteWorkspaceRpcContract v1`；控制端本地仍只保留 Source/Profile
目录、窗口、Theme/Locale、Web 远控配对、attachment 调度，以及模型 Provider 的编辑权威（本地 `IProviderSettingsService`）与 Provisioning Source。

`REMOTE_WORKSPACE_RPC_CHANNELS`（`packages/desktop/src/host/remoteWorkspaceRpcContract.ts`，`REMOTE_WORKSPACE_RPC_CONTRACT_VERSION = 1`）当前清单，握手时 `assertRemoteWorkspaceRpcContract` 逐项要求远端提供：

```text
fileService gitService gitCheckpointService systemService terminalService
settingService onboardingRecordService credentialService broadcastService
zcodeTaskService zcodeAgentService zcodeSessionService conversationShareService botsService fileWatcherService oauthService
providerSettingsService modelSelectionService mediaPreviewService          ← 2026-09-07 起替代 modelProviderService / providerSyncService
sourceServerWorkspaceService usageStatsService codingPlanSubscriptionService clientScenesService
skillsService skillSyncService mcpSyncService pluginSyncService pluginsService pluginManagementService
subagentsService commandsService hooksService memoryService outputStyleService settingsSyncService
promptAttachmentTransferService repoWikiService
```

`modelProviderService`、`providerSyncService` 已从合同中移除；`providerProvisioningTargetService` 不在合同内（Host 从 `connectionServices` 上按需读取，不校验、不转发）。合同版本号保持 v1：兼容门默认只承诺同版本连接，旧远端在握手前已被更新，是否升 v2 见 [r3-provider-refactor-merge.md（已归档）](../archive/remote-r3/r3-provider-refactor-merge.md)。

#### 控制端设置持久化事务

Main 保存窗口偏好、Local Host 保存 Source Directory 均沿用 `SettingService` 补丁更新；Source/工作区历史 owner 不变。共享 `setting.json` 的写入必须按同一文件的进程间锁执行「获取锁 → 重读最新磁盘 → 合并本次补丁/迁移 → 原子替换 → 释放锁」，不能只保护最后的 rename。锁内原子写复用已持有的锁，避免重入；失败释放锁，提交前超时撤销写入 generation，迟到旧写不能覆盖后续设置；进入 rename 提交后沿用现有提交屏障直至完成。窗口尺寸保存不得抹掉刚记录的远程目录。

### 8.2 模型设置页绑定本地 Environment

2026-09-07 合并 Provider 重构 M2 时拍板（路线 A）：设置页「模型设置」**永远绑定本地 Environment**，不提供设备选择器、不可编辑远端、没有手动「一键同步」按钮。依据是 Provider Refactor Design V2 §7.1（每个执行 Environment 自己读本环境配置，Host 不向 Worker 发 Registry Snapshot；远程编辑与登录同步是独立产品能力，不属于 Provider 核心）与 [Remote Provider Provisioning](../remote/provider-provisioning.md)「Desktop 模型配置页」一节。

```text
SettingsPage
  └─ activeSection === "modelProvider"
       └─ ServiceProvider(localHostServices)            ← useBaseWorkspaceServices()，与激活的 workspace 无关
            └─ ModelProviderSection
                 ├─ 读写：本地 IProviderSettingsService（provider_config.json / model-selection.json / setting.json 窄字段）
                 ├─ 连通性测试：connectivityWorkspacePath 强制本地 workspace；激活远端 workspace 且无本地 workspace 时改用本机 Host 对话目录，Host 也无法提供时才返回不可用
                 └─ 保存成功 ──► 本地 Provisioning Source 触发 ──► §8.3 自动下发到全部在线 Source

Active workspace（local / remote）──只决定工作区上下文，不改变模型配置数据源
```

- 设置页不再有「本机 / 各远端 Server」设备菜单，也不记忆 `lastAgentSettingsSourceServerId`；`ModelProviderSourceControls.tsx`、`useSourceSettingsAttachment.ts`、`providerSyncSnapshot.ts` 及 `AppSettings.lastAgentSettingsSourceServerId|providerSyncDefaultModel|providerSyncRuntimeCredentialBindings` 已删除。远端缺模型时设置页不显示任何远端引导；引导只出现在对话区（§8.3）。
- 保留的 `source-settings` attachment scope（`sourceSettingsServiceCollection.ts`）不注册 `provider-settings` / `model-selection`，只服务 Skills / MCP / Plugins / Commands / Hooks / Subagents / Memory / OutputStyle / settings-sync 等非 Provider 配置面；其它能力页（插件、MCP、技能、命令、子智能体、钩子）使用按设备分组的 Scope 菜单：本机「用户」走本机，远端设备「用户」走该设备的 source-settings attachment（不需要打开项目），项目走各自的配置专用服务；默认选中当前 workspace 所在设备的「用户」，选中设备离线时 fail-closed（[数据同步](../remote/data-sync.md)「Scope 菜单按设备分组」）。禁止把「模型设置绑定本地」扩散成「所有设置页都绑定本地」。
- 对话区、Subagents、Automation 的模型目录来自**目标 Host**：`useModelSelectionView(workspacePath, remoteSessionId, workspaceIdentity)` 经 `useWorkspaceServicesResolution` 解析到该 workspace 的服务集合，再读其 `modelSelectionService`（ssh/wsl/docker/server 全部远端一致）；等待远端 attachment 期间保持 `remote-waiting`，绝不回落本机 Local Host 目录。首次 bind/rekey 期间即使 tab 仍短暂携带 legacy `remote:ssh|wsl|docker:*` identity，也不得读取本机目录。
- 远端 workspace 缺模型时 `ChatErrorBanner` 的 `modelConfigTarget: "remote"` 只切换措辞（`chat.error.remoteNoAvailableModel`：「此远程设备尚无可用模型，请先在本机配置模型，保存后会自动同步到远程设备」），按钮仍是「配置」（打开本机模型设置）/「升级」；「去同步」入口已删除。
- Renderer 收到远端 scoped service port 时，是否采用 Source Server 全权威服务集合仍以 Host 注入的 `sourceServerId` 为准；SSH/WSL/Docker 只描述 transport，不能据此回落 legacy mixed services。已识别 Source 即使通过 SSH 连接，`settingService`、credential、usage 与 `modelSelectionService` 也必须来自远端。
- 例外：高速卡与闲时任务只在本地生效（2026-10-21 产品决定），远端合同不含这两个频道。所有远程 workspace 的服务集合中，`highspeedCardService` 使用「远程不支持」实现（立即 fallback，不 draw），`offPeakTaskService` 固定取本地 Desktop Host；任何一个都不得路由到远端。见 [Highspeed §8](../highspeed/highspeed-card-spec.md#8-多端与恢复边界)、[闲时任务 §多端](../off-peak-task/spec.md)。

### 8.3 Provider Provisioning 接入 R3 主链

模型配置没有用户触发的同步入口；唯一例外是数据同步页「模型提供商」分类在该设备最近一次自动下发失败时提供的「重试」（§8.3.6）。本机是 Provider 配置的唯一编辑权威，每个在线 Source Server 是本机配置的可丢弃执行镜像；Envelope 内容、目标端事务 / 回滚、`syncId` 幂等、校验边界以 [Remote Provider Provisioning](../remote/provider-provisioning.md) 为事实文档，本节只描述它如何挂到 R3 Source Server 主链上，不得与之矛盾。

#### 8.3.1 链路：Main coordinator → Window Host executor → Source Server target

```text
Desktop Main                         Window Host                              Source Server daemon (zcode-server-cli Core)
------------                         -----------                              --------------------------------------------
ProviderProvisioning                 RemoteProviderProvisioningExecutor       createLocalServices({
EnvironmentCoordinator               (registered by                             serviceAuthorityMode: "standalone-server",
  key = buildRemoteEnvironmentKey     createServerRemoteWorkspaceService-       providerProvisioningTargetEnabled: true,
        (descriptor.target)           Collection; Host-private WeakMap,         zcodeBuiltinProviderConfigFilePath })
  single-flight lane + generation     never exposed to Renderer RPC)           IProviderProvisioningTargetService
        |                                    |                                         |
        | HostMessage                        |                                         |
        | ProviderProvisioningExecute        |                                         |
        | {requestId, environmentKey,        |                                         |
        |  remoteSessionId, trigger}         |                                         |
        |----------------------------------->|                                         |
        |                                    | (1) source.read(syncId)                 |   <- local ProviderProvisioningSource
        |                                    | (2) target.apply(envelope)              |   <- /ws/host, desktop-continuous,
        |                                    |---------------------------------------->|      channel "provider-provisioning-target"
        |                                    |                                         | validate envelope
        |                                    |                                         | -> account narrow settings
        |                                    |                                         | -> credentials (re-encrypt on target)
        |                                    |                                         | -> provider_config.json
        |                                    |                                         | -> model-selection.json
        |                                    |                                         | any failure: reverse rollback
        |                                    |<----------------------------------------|
        |                                    | ProviderProvisioningResult              | success: refresh Account Source / Registry
        | HostResponse                       | {syncId, status, personalProviderCount, |          -> remote Host -> Worker overlay
        | ProviderProvisioningExecutionResult|  credentialCount, rolledBack}           |
        |<-----------------------------------|                                         |
        |
        | status in {applied, already-applied} -> resolve -> lane.lastResult = success
        | otherwise: warn (no Secret) -> reject(ProviderProvisioningExecutionError{errorCode}) -> lane.lastResult = failed
        |   coordinator: trigger == environment-online -> rethrow (first connect fails); other triggers -> swallowed
```

- Main 只持有 Environment key、Host 登记、trigger、generation 与 `requestId` 关联，不读也不转发配置与 Secret；Envelope 只在 Window Host 内存中经过一次，落盘只发生在目标 Source 的正式 Store。
- 触发源（`ProviderProvisioningTrigger`）：`environment-online`（首连 / 重连）、`personal-config`、`configured-default`、`account-settings`、`credential`，以及只由 Main 协调器产生的 `user-retry`（§8.3.6）。后四者由本机 Local Services 在持久化成功后经 `HostResponse ProviderProvisioningSourceChanged` 上报，Main 调 `coordinator.requestAll(trigger)` 对全部在线 Environment 推进 generation；同步期间的新触发只推进 generation，本轮结束后再读一次最新快照形成尾随同步。
- 与旧「一键同步」相比：没有目标确认界面、没有 journal + write barrier，目标端改为事务暂存 + 反向回滚 + `syncId` 幂等；Team Plan runtime Key 绑定、family 运行选择整包等 ours 专有字段不再存在，账号侧只同步 `providerFamilyDomain` / `providerFamilyConnectionSelections` 窄字段与 allowlist 凭据。

#### 8.3.2 首连屏障与重连重注册

```text
首连（desktopRemoteSessions.ts handleConnected）
  RemoteWorkspaceConnected(descriptor)
    -> routesBySessionId.set(remoteSessionId, route)
    -> registration = coordinator.register(environmentKey, remoteSessionId, execute)
    -> route.providerProvisioningDispose = registration.dispose
    -> await registration.initialSync                       ← Remote Workspace ready 屏障
         ├─ applied / already-applied ──► attachRendererPort ──► pending.resolve（连接成功）
         └─ failed / rollback_failed / unsupported
               ──► dispose lane、删除 route、DisposeRemoteWorkspaceSession ──► pending.reject（连接失败）

重连换代（handleReconnected；§7.1 Source 自动重连 / 显式更新后重新握手）
  RemoteWorkspaceReconnected(previousRemoteSessionId, descriptor)
    -> route 从旧 sessionId 迁到新 sessionId
    -> route.providerProvisioningDispose()                   ← 摘掉绑定旧 sessionId 的 lane
    -> registration = coordinator.register(environmentKey, 新 remoteSessionId, execute)
    -> registration.initialSync.catch(warn)                  ← 重连不是发布屏障：失败只记 warning，不拆 Workspace
    -> attachRendererPort(win, route, "source-server-reconnected")
```

- 屏障只作用于 `environment-online` 触发的首连；同一 Environment 的第二个 Workspace join 已有 lane，不产生第二次首次同步（E2E `SSH-P0-TASK-01` 断言远端 `~/.zcode/v2/provider-provisioning-state.json` 的 `records[]` 在第二个 Workspace 连接后不增加）。
- 重连必须重新 register：lane 以 `remoteSessionId` 登记、execute 闭包也绑定旧 sessionId，Source 换代后若不重注册，后续下发会命中 Host 已失效的旧 session，远端再也收不到配置。重新 register 触发一次 `environment-online` 整份重下发，补齐离线期间的本机配置变更；单测 `desktopRemoteSessions.test.ts` 覆盖「重连后以新 sessionId 重新登记并重新下发」与「重连触发的失败只 warn」。
- Environment key 由 `buildRemoteEnvironmentKey(target)` 按 transport 派生（`ssh:<hostKey>` / `wsl:<distro>` / `docker:<container>` / `server:<serverId|url>`），不是 `sourceServerId`；同一 Source 经不同线路连接会形成不同 lane（各自首连同步，结果幂等）。收敛到 `sourceServerId` 是后续可选项，见 [r3-provider-refactor-merge.md（已归档）](../archive/remote-r3/r3-provider-refactor-merge.md)。

#### 8.3.3 `unsupported` 拒连与兼容门自动更新

```text
连接向导 / 自动重连
  -> 握手 /api/server-info → compatibility 判断（§6.3）
       ├─ 远端 < minCompatibleVersion（默认 = 本机产品版本）
       │     ├─ 显式连接：向导原地 updateSource(force=false) → 重新握手 → 继续原连接意图
       │     └─ 启动 / 离线重连：停在 needs-upgrade，等用户「立即更新」
       └─ 兼容 → /ws/host → assertRemoteWorkspaceRpcContract → Provisioning 首连屏障（§8.3.2）
```

- `ZCODE_MIN_COMPATIBLE_VERSION` 默认等于产品版本（根 `package.json` 未声明 `zcodeCompatibility`），因此不带 Provisioning target 的旧 daemon 在握手阶段就被判「需升级」并先走 §6.3 更新，更新后的 Core 必然注册 target；R3 主链不会对 pre-Provisioning daemon 发出 Envelope。
- `unsupported` 拒连语义按 Provisioning 事实文档原样保留，仍覆盖：本机 `ProviderProvisioningSource` 不可用（Window Host 尚无 active local services，`sourceServices` 为空）、远端 Core 未注册 target（例如 `kind:"server"` dev 直连到未配置 `ZCODE_SERVER_AUTH_TOKEN` 的 `packages/server` HTTP zcode-server）。
- `unsupported` / `failed` / `rollback_failed` 首连一律走正式连接失败通道：不发布 Remote Workspace ready、不发送 Secret、不静默重试；Renderer 看到普通连接失败与日志，用户修正后重连即重试。

#### 8.3.4 非桌面 clientMode 拒绝 stub

```text
Source Server Core（server-core/http.ts exposeWebSocket）
  /ws/host  clientMode = desktop-continuous（受信 Desktop Host：capability ticket + ingress token）
     └─ overrides 不替换 → IProviderProvisioningTargetService 真实实现
  /ws       clientMode = web-remote-replayable（手机 / Web）
     └─ overrides.set("provider-provisioning-target",
            { apply: () => throw Error("Provider Provisioning 仅支持受信 Desktop Host") })

Window Host（windowHostAttachmentRpcPolicy.ts）
  web-remote-replayable allowlist：含 ProviderSettings / ModelSelection / MediaPreview，不含 ProviderProvisioningTarget
```

- Core 始终注册 target（R3 ingress token 常在，不存在 HTTP zcode-server 那种「未配置鉴权则不支持」的分支）；隔离在 clientMode 层完成：手机 replayable 连接即使知道频道名也只能拿到抛错 stub，不能把跨 Environment 凭据写进 Source Server。
- `RemoteProviderProvisioningExecutor` 存于 Host 私有 WeakMap，不随 ServiceCollection 暴露到 Renderer；手机没有任何触发同步的入口。桌面 Renderer 只有 §8.3.6 的失败重试，经本机 Host 请求 Main 协调器推进已有 lane，不直接调用 executor。

#### 8.3.5 Built-in Provider Config 物化目录

```text
zcode-server-cli 构建
  tsup define SERVER_CLI_DEFINES = { __ZCODE_VERSION__, __ZCODE_MIN_COMPATIBLE_VERSION__, __ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__ }
        │
Core 启动（server-core/core.ts runServerCore）
  layout = resolveServerLayout(ZCODE_SERVER_ROOT)
  ├─ ZCODE_BUILTIN_PROVIDER_CONFIG_FILE 显式指定 ──► 直接使用该文件
  ├─ 否则 materializeZCodeBuiltinProviderConfig({ runtimeRoot: layout.serverRoot, content })
  │     └─► ~/.zcode/server/config/provider/zcode-builtin-<sha256(content)>.json（tmp + rename；同 hash 幂等，内容不一致则失败）
  └─ 两者皆无 ──► 启动失败（fail-closed）
```

- 物化目录是 `serverRoot`（`~/.zcode/server`），**不是** release 自带的 `runtime/`：release 目录不可变，同一 releaseId 重装时会重算整棵树的内容哈希，多出的物化文件会让该目录被判为损坏副本并整体替换（[R2 immutable promote](./r2-server-cli-and-daemon.md)）；文件名含内容 hash，跨 release 共用安全。`config/` 目前不在 `zcode uninstall` allowlist 内，卸载后会作为 `preservedPaths` 保留（见 [r2-server-cli-and-daemon.md](./r2-server-cli-and-daemon.md)）。
- 远端 Built-in Release 不随 Provisioning 复制：本机 Personal Layer 引用远端 Built-in 不存在的 Provider/Model 时，目标返回结构化错误并回滚本次配置写入。

#### 8.3.6 最近结果与失败重试（数据同步页）

数据同步页「模型提供商」分类（[data-sync.md](../remote/data-sync.md)「模型提供商（只读）」）显示该设备最近一次自动下发的结果，失败时提供「重试」。唯一数据源是 Main 协调器的 lane，不新增持久化，也不新增同步链路。

```text
Renderer DataSyncDialog（providers 分类 / 概览行）
  └─ providerProvisioningStatusService（通道 provider-provisioning-status，只在本机 Host 注册；
     │  不进远程 workspace RPC 合同 / source-settings 集合 / 手机白名单）
       ├─ getStatus({sourceServerId, waitForIdle?})
       └─ retry({sourceServerId})
            │ HostResponse ProviderProvisioningLaneRequest {requestId, sourceServerId, action: read|wait|retry}
            ▼
Desktop Main（desktopHostProcess → remoteSessionManager → coordinator）
  getLaneStatus(sourceServerId)：找到仍有该设备注册的 lane（register 时带 descriptor.sourceServerId）
      ├─ 没有 → { lane: "none" }（本机没有打开该设备上的项目；不下发、不能重试）
      └─ 有   → { lane: "present", running: 任一 drain 执行中, lastResult: 时间最新的 {at, outcome, errorCode?} }
  retry(sourceServerId)：同一条 lane generation+1，trigger = user-retry → #startDrain（single-flight）
      └─ 执行中时合并进当前 drain 的尾随同步；等 drain 结束后返回最新状态
            │ HostMessage ProviderProvisioningLaneResult {requestId, status}
            ▼
本机 Host 按 requestId 交回调用方
```

- lane 在每次真正完成的执行后记录 `lastResult`（Host 被其它注册接管的那次不记录）；失败只带固定阶段码（`ProviderProvisioningErrorCode`），不带远端自由文本或 Secret。lane 失去全部注册后按「无 lane」返回。
- 重试不增加自动重试、超时放行或第二条同步链路；source-settings attachment 不注册 lane，设备没有打开的项目时不下发也不能重试。
- 同一 Source 经不同线路形成多条 lane 时，状态取时间最新的结果，重试推进该设备的全部 lane。
- Host 侧实现：`packages/services/src/provider-provisioning-status/`（`createHostProviderProvisioningStatus`，按 requestId 关联请求与结果，不设超时）。
- 单测：`providerProvisioningEnvironmentCoordinator.test.ts`、`desktopRemoteSessions.test.ts`、`desktopHostProcess.test.ts`、`hostProviderProvisioningStatus.test.ts`、`windowHostControlProtocol.test.ts`；E2E `DSYNC-13-01`。

### 8.4 设备管理合同（2026-09-13 自 `docs/archive/remote-r3/r3-remote-ui-prototype-gap-audit.md` §8 并入，原文已归档）

以下合同已实现。代码事实源：`packages/shared/src/source-server/contracts.ts`、`packages/shared/src/source-server/errorCodes.ts`、`packages/desktop/src/host/sourceServerDirectory.ts`、`packages/desktop/src/host/sourceServerManagementService.ts`、`packages/shared/src/validationAppSettings.ts`。

**8.4.1 `declaredWorkspaces`（远端已知目录）**

- 挂在 `SourceServerRecord` 上，条目 `{ workspacePath, workspaceIdentity, label? }`，schema `.default([])`，旧持久化数据缺键时在 parse 阶段补空数组；不新增 AppSettings 键，随设备记录一起换代、删除。
- 写入点只有 `recordHandshake`：成功握手用远端 `ServerRemoteInfo.workspaces[]` 整体替换（返回空数组即清空），每设备最多 20 条；连接失败 / 断线不触碰。协议缺 `workspaces` 字段走既有握手失败路径，不做静默空数组降级。
- 身份：远端条目 `workspaceIdentity` 缺失或与设备 / 路径不匹配时，用 `buildServerRemoteWorkspaceIdentity({ serverId: sourceServerId, workspacePath })` 补全为设备级 stable identity；与本地 `workspaceHistory` 合并去重一律按 `workspaceKey`，禁止仅按路径判等。该字段不携带 `profileId`，quick-open 只回填路径，由当前已建立的连接提交。

**8.4.2 `removeSourceServer(sourceServerId)`（移除全部连接）**

- 删除面：该设备全部 Profile（active / retired）及其凭据、全部 `workspaceHistory` 条目、`sourceServers` 记录本体（含 `declaredWorkspaces`）；迁移 ledger 与远端数据不受影响。
- 顺序：① Manager 幂等 dispose 运行中连接 → ② `await onBeforeSourceServerRemoved(sourceServerId)`（桌面 Host 生产装配必须注入，回调内 detach 该设备的 Runtime 资源）→ ③ Directory 单次 `enqueue` 内一次写入 AppSettings，凭据沿用 `removeProfile` 的先备份后删、失败回滚 → ④ 发布管理快照。
- 错误码：缺回调拒绝执行 `source-server-remove-callback-missing`；回调失败中止且不删除任何持久化记录 `source-server-remove-callback-failed`；持久化 / 凭据删除失败进入「设备记录保留、连接已断开」恢复态 `source-server-remove-persist-failed`。设备不存在返回成功空操作。服务层与 UI 测试断言错误码而非异常文本。
- UI：设备更多菜单在所有已安装状态都提供「移除全部连接」，不依赖设备在线，danger 二次确认；只有「在侧边栏中显示」依赖在线。

**8.4.2.1 未识别线路的本机成员预留（2026-11-03）**

- 首次连接在 probe 前由 admission 按线路地址写入本机成员行（`remote:ssh|wsl|docker:…`），握手成功后 `bindHost` 才把它改名为 `remote:server:<sourceServerId>`。握手前失败或取消时，该行只属于无 `sourceServerId` 的未识别线路。
- `removeProfile` 删除未识别线路时先释放预留，再写 AppSettings；`updateProfile` 改址成功后释放旧地址的预留。释放条件：没有其他未归档线路映射到同一地址，且该行没有项目入口。AppSettings 写入失败时线路保留，下次 `add` 连接重建预留。
- 带项目入口的地址行（旧版迁移）不释放，由侧栏「移除连接」处理。已识别线路与 `removeSourceServer` 不经过此路径。
- 地址不能构成成员身份的线路（如 IPv6 主机，authority 段含 `:`）在 admission 写入前就失败，没有预留行，也不拥有任何成员行。所有按线路枚举成员行的地方都把它当作“不匹配”：释放预留时是空操作、不参与同地址比较；`readConnectionStates` 不为它投影状态；`connectHost` 选线时不选它。它不能阻止删除、改址、读取目录或重连其他设备。IPv6 连接本身仍由 admission 明确拒绝，身份格式支持 IPv6 不在本节范围。
- Bug 原因：此前删除或改址只改 AppSettings，预留行成为孤儿；侧栏每次刷新都对它 `readTree`，Host 只为 `remote:server:` 路由，持续记录 `project.host-offline`。已存在的孤儿行不在本次清理范围。

**8.4.3 目录变更事件与统一 generation**

- `SourceServerDirectory.onDidChange` 在每次 `enqueue` 持久化成功后 fire；管理服务把它与 `manager.onDidChangeState` 汇入同一个单调 `generation`，经 RPC 暴露 `onDidChangeDirectory`，payload `{ generation }`（`sourceServerManagementDirectoryDeltaSchema`）。快照内容变化必然伴随 generation 递增。
- `getSnapshot()` 采用乐观读：记 `startGeneration` → 读 directory / states / counts → 比对 `endGeneration`，不一致则整体重读，不产出「旧内容 + 新版本号」。
- 管理快照不得等待远端统计 RPC：directory 与连接状态先返回，Host 按当前物理连接独立读取迁移统计。`migrationCounts` 区分 `loading`、`unavailable`、`requires-connection` 与携带真实数值的 `available`；顶层总数只汇总 available 项，不代表其他项为零。每个连接至多一组统计请求在途，统计完成通过既有目录变更事件提升 generation、通知刷新；一个 Source 慢或失败不阻塞其他 Source 或手动断开。连接换代、删除与 dispose 后的旧结果不得发布。目录变更和迁移重试/放弃使统计失效；在途失效合并为完成后的单次重新读取，不增加定时轮询或无限重试。
- 页面显式进入/刷新使用 `getSnapshot({ refreshMigrationCounts: true })` 请求后台更新统计；事件驱动的读取使用默认值 false，只读取投影，避免统计完成事件再次触发远端读取。该可选参数由 Host 严格 schema 校验，仅属于同版 Desktop 的本机管理服务，不改变远端 Server/Agent 协议。
- Renderer 全部管理快照订阅点同时订阅两个事件，并汇入同一个 in-flight / queued 刷新队列，按「generation 低于已观察值即丢弃」判序；`useRemoteWorkspaceHistory` 的 directory 回调只刷新快照，不触发自动重连。

**8.4.4 连接偏好 `remoteStartupAutoReconnectEnabled`**

- AppSettings 顶层布尔，默认 `true`，缺字段视为 `true`；full schema 与 patch schema 都声明该字段，显式 `false` 不得在写盘前被剥离。
- 只门禁 Host 启动静默重连入口（`listStartupReconnectCandidates → reconnectOnStartup`），不影响手动连接与断线后的 retrying / offline 恢复；修改立即持久化、下次启动生效。仅桌面设置页提供入口，不新增跨端 RPC。
- 不提供全局下载方式默认偏好（2026-08-28 决策撤销 `remoteDefaultAssetInstallMode`）；SSH 新建线路表单每次从 `local-download-upload` 开始，Profile 自身 `assetInstallMode` 优先。

**8.4.5 停止与重启远端服务（2026-10-20）**

产品合同与验收见[停止和重启远端服务](../issues/remote-daemon-lifecycle/01-stop-restart-remote-service.md)，CLI 语义见
[R2 §8.1](./r2-server-cli-and-daemon.md#81-stop---wait-与整棵进程树-restart2026-10-20)。

- 管理服务新增 `stopSource(sourceServerId)`、`restartSource(sourceServerId)`、`getSourceRunningTasks(sourceServerId)`，严格 schema，只对桌面 Renderer 开放，手机 attachment allowlist 不增加。
- 路由由 Host 按 `sourceServerId` 选择（更新仍由 Renderer 传 `profileId`，不改）：在线时用在线连接；否则用默认连接，再按最近连接时间选可静默取得凭据的连接（与启动静默重连候选同一排序）；取不到时返回 `credentials-required`。桌面端只经 transport 执行固定 argv：`stop --wait --json`、`restart --json`、`running-tasks --json`；非 SSH 的 `restart` 与 `serve --daemon` 一样带跳过服务注册的环境变量。
- 停止：先执行与显式断开相同的收口（清定时器、中止在途连接与更新、删除恢复意图、释放连接、置 `offline`），再执行远端 `stop --wait`。远端命令沿用被断开连接的 transport 会话（不重新认证），命令结束后释放该会话，本机不再连着设备。成功与失败都保持 `offline`，失败原因经操作结果与日志呈现。不写持久标记；启动静默重连仍只受 §8.4.4 开关门禁。
- 重启：登记生命周期操作 flight 并清恢复定时器，状态投影为连接中；执行 `restart --json`，期间在线连接关闭按 §7.1 视为预期断线。成功后走现有连接流程并发出 reconnect，由 Registry 为已打开 workspace 换代；失败时：有恢复意图且非终态时与更新失败相同，从第一档自动恢复；没有恢复意图时为 `failed`（设备卡显示连接失败）。更新失败且没有恢复意图时仍为 `offline` 带错误，不随本合同改变。
- 同一 Source 的生命周期操作互斥：重启或停止进行中时拒绝任何新的生命周期操作（更新、重启、停止）；更新进行中时拒绝重启与停止；多个更新并存（经 sibling Profile 发起）保持现状；同一 Profile 只允许一个更新，已有更新时新的更新在写设备操作日志前以 `source-server-operation-in-progress` 拒绝（2026-11-04：两个更新曾互相把对方写的 `updating` 记成更新前状态，取消或失败收口时写回，更新全部结束后设备仍显示“更新中”）；手动连接不在停止、重启的互斥范围内，停止期间另行建立的连接按普通断线恢复；更新进行中的连接按 §6.3「更新期间的连接」拒绝。显式断开或移除设备中止进行中的重启 flight。不新增 Host 连接状态，不用超时等待同步本机状态。
- 其他客户端（另一台 Desktop）的自动恢复可能重新拉起远端服务，一期只在确认文案中说明。
- 实现落点（停止，2026-10-20）：Host 互斥被拒时抛非公开码 `source-server-operation-in-progress`，且在写设备操作日志之前拒绝，
  不覆盖进行中操作的日志；停止 flight 不把在线连接关闭视为预期断线（停止前已释放连接，其间用户新建的连接按普通断线恢复）。
  远端命令输出经 transport 的统一结果解析保留公开错误码；成功必须是最终 `stopped` 状态，旧远端的 ack 视为失败。
  停止失败时原因写在所用连接的 `offline` 状态上（不改变未连接展示），供失败详情分类。设备操作日志 `operation` 增加 `stop`。
  更新、停止、重启失败写入状态的 `errorCode` 与 `retryable` 取自同一归一化结果；远端未声明 `retryable` 时统一为 `true`
  （2026-10-21 确认，含停止失败）。
  版本门禁常量为 `@zcode/shared` 的 `SOURCE_SERVER_LIFECYCLE_CONTROL_MIN_VERSION`，与设备记录的 `lastSeenVersion` 比较，
  取 `3.17.0`（2026-10-27 确认）：这是首个包含本合同的正式版。已发布的 3.16.3 及更早远端不支持本合同。
  曾取 `3.16.3`，前提是“下一次发版至少是 3.16.3，且包含本合同”；实际 v3.16.3 从 release 分支发布，不含本合同，
  最近握手为 3.16.3 的未连接或连接失败设备因此开放了菜单（发布验证 REL3170-CAP-01）。
  不取根版本：本合同开发期间根版本与已发布、不支持本合同的版本同号，门禁取它会对旧远端开放菜单。
  代价是根版本升到 3.17.0 之前，开发构建、E2E 远端包与 staging 测试包都报 3.16.3，菜单显示禁用；根版本何时升级由团队决定。
- 实现落点（重启，2026-10-21）：重启开始时把所用连接投影为 `bootstrapping`（不带重试计数）；预期断线的连接失效事件
  `reason` 为 `restart`，同一 Source 的在线连接都投影为 `bootstrapping`，Host wrapper 与更新一样按可恢复关闭通知
  Registry。远端命令必须返回 ready 状态（旧远端的 ack 视为失败）；旧连接的关闭可能晚于命令返回，连接前若旧连接仍登记
  在线，先主动失效，不能复用已退出的连接。失败收口与更新共用同一实现。离线路由读取凭据期间若手动连接已发布恢复意图，
  改用恢复意图的连接；删除 Profile 中止重启后，恢复意图的连接若停在没有在途连接的 `bootstrapping`，从第一档自动恢复。
  设备操作日志 `operation` 增加 `restart`，阶段名为 `service-restart`（`restart` 阶段会被错误归一化当作安装失败）。
- 实现落点（运行中任务读取，2026-10-21）：Host `getSourceRunningTasks` 的路由同重启（恢复意图优先；离线路由读取
  凭据后重查恢复意图），经 transport 执行 `running-tasks --json`。输出 `null`（Core 尚未上报）、非零退出、执行异常或
  不符 schema 都返回 `{ available: false }`，不当作没有任务；结果 schema 为 `@zcode/shared` 的
  `sourceServerRunningTasksResultSchema`。读取只读：不登记生命周期操作、不参与 Host 互斥、不改变连接状态，也不写
  设备操作日志（日志按设备只保留最近一次操作）。更新 guard 拒绝后的清单读取共用同一解析。

```text
停止：disconnect 收口（恢复意图删除）──> exec stop --wait ──> offline
重启：lifecycle flight ──> exec restart ──(在线连接 close = 预期断线)──> connect ──> online + reconnect ──> 移除 flight
                                 └─ 失败 ──> 有恢复意图：retrying 第一档；否则 failed

同 Source 互斥（行 = 新操作，列 = 进行中的操作）：
             update      restart   stop
  update     sibling 允许  拒绝      拒绝
             同 Profile 拒绝
  restart    拒绝         拒绝      拒绝
  stop       拒绝         拒绝      拒绝
```

## 9. 数据迁移（D7 / D8）

结构升级统一进入物理库的正式 migration 账本：Controller/Source 附加表按用途进入
`tasks_schema_migration`，session identity 表进入 CLI `schema_migration`。
Repo 不再独立建表/补列。旧 schema、未完成计划与回退兼容规则见
[`Task SQLite Index：R3 附加表纳入库级账本`](../task/task-sqlite-index.md#r3-附加表纳入库级账本)。
以下 workspace 级数据合并 ledger 仍负责业务进度，不代替库级 schema 版本。

### 9.1 控制端迁移（App 升级后首次启动）

输入：`~/.zcode/v2/setting.json#lastWorkspaceSession[kind="remote"]`（连接与 workspace 合一，≤20 条）+ `credentials.json` 中 `remote-workspace:<workspaceKey>:{password,private-key-passphrase,server-token}`。

```text
每条 remote entry
  ├─ target snapshot ──按 (transport, 归一化 target) 去重──► ConnectionProfile（新 profileId）
  │     └─ credential key 重定向：remote-workspace:<key>:* → connection-profile:<profileId>:*
  │        （同 host 多目录的 N 份凭据收敛为 1 份；旧 key 保留到 R4 再删）
  ├─ workspacePath + lastOpenedAt ──► workspace 打开历史（引用 profileId；sourceServerId 待握手回填）
  └─ 旧 identity 保留在历史条目上，用于打开时的远端历史匹配兜底
```

- 迁移是纯本地、幂等、schema 解析阶段完成（沿用 `migrateLegacyWorkspaceSession` 的既有模式）；失败不阻塞 App 启动，只影响连接页展示并可重试。Directory 的 rejected initialize flight 必须清空，允许后续显式重试；Window Host 无论迁移结果如何都必须先暴露 local base attachment，禁止让 Source Server 目录故障把本地工作区一起卡死。
- 同一 target 存在多份凭据（不同 workspace 条目各存一份）时，非敏感 target 元数据取 `lastOpenedAt` 最新条目；密码与私钥口令分别取按 `lastOpenedAt` 降序扫描后第一个“credential value 实际存在”的条目。空源不得遮蔽较旧的有效 sibling。本机无法解密的值（`ZCODE_CREDENTIAL_DECRYPT_FAILED`）按“无可用值”处理：记一条 warn（不含 key 与 value），继续扫描，原记录不删除、不改写；不得因此中断迁移。其他读取错误（凭据文件损坏、IO 失败）仍让本次迁移失败并回滚。
- 新建 Profile 与迁移使用同一凭据 seam：拥有 plaintext target 的 Host 生成 `profileId` 后，把密码/私钥口令写入 `connection-profile:<profileId>:*` 并在同一持久化操作中写入引用。迁移只有在 value 复制成功后才写新引用；空源继续表达需要交互凭据，禁止制造悬空 key。
- R4 兼容窗口内，Renderer 为旧 Desktop 投影 stable Source workspace 时，必须把 Profile secret 物化到每个 workspace 独立的 `remote-workspace:<legacyWorkspaceKey>:*` mirror，且先写 secret、后提交 `lastWorkspaceSession` 引用。旧 key 仅用于回退兼容，当前主链仍只消费 Profile credential。
- `sourceServerDirectoryMigrationVersion=1` 不代表 credential 一定完整；Host initialize 对 active SSH Profile 做幂等审计，仅用相同标准化 route 的 legacy siblings 修复缺失或无法解密的 canonical value，不按 alias/hostname 相似度猜测。
- “无法解密 = 无可用值”是 Host `SourceServerDirectory` 全部凭据读取的统一规则，不只用于迁移与审计（2026-10-21）：静默连接把不可解密的 Profile secret 当作缺失，返回 `credentials-required`；启动重连跳过该 Profile，其他 Profile 照常进入候选；用户补充凭据时直接覆盖该 key；编辑、删除、身份替换的回滚快照把它记为无值，回滚时删除而不恢复本机无法解密的密文。“原记录不删除、不改写”只约束 legacy 来源。Renderer 读取 Profile secret 时遵循同一规则（设备连接流程 `loadConnectionProfileCredentials` 与原项目重连）：解密失败按缺失处理，进入已有的补充凭据交互；其他读取错误照常上抛。
- `SourceServerRecord` 不在此阶段创建——它只能来自真实握手（`sourceServerId` 未知）；未握手 Profile 在连接页独立展示，首次连接成功后按 `sourceServerId` 归并到 Server 卡片。
- 控制端本地 `tasks-index.sqlite` 中引用旧 remote identity 的行在对应 Server 首次握手后重写为新 identity，禁止静默丢弃。逐表盘点如下（已实现：`packages/services/src/session/controllerRemoteIdentityMigration.ts`；2026-09-13 自 `docs/archive/remote-r3/r3-controller-remote-row-migration-inventory.md` 并入）。控制端 `tasks-index.sqlite` 只是 Controller 壳层 / 调度记录，不是远端 Session 正文权威；旧 `lastWorkspaceSession` 与旧 credential key 保留只读到 R4。

| 表/字段                                                      | 现有语义                                        | R3 动作                                                            | 冲突/对账规则                                                                    |
| ------------------------------------------------------------ | ----------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `tasks.workspace_key/workspace_identity/meta_json`           | Controller task membership/cache                | 按 `(oldWorkspaceKey, task_id)` 重写新 key；同步修正 meta identity | 新 key 已有同 task 时保留更新时间较新的壳行；正文不在此库，不做 Session 内容裁决 |
| `task_group_members.workspace_key/workspace_identity`        | 本地 group membership 引用                      | 与 task 行同事务重写                                               | 同 task 冲突保留目标 membership；不得产生重复 member                             |
| `task_group_workspace_bootstraps.workspace_key`              | workspace 首次 group bootstrap 标记             | 重写 key                                                           | 目标已有标记时删除旧标记；group id 保持，避免重排                                |
| `task_group_view_node_orders.node_key`（`node_type='task'`） | `JSON.stringify([workspaceKey, taskId])` 排序键 | 解析 JSON 后只替换 workspace key                                   | 目标 node 已存在时保留目标排序；非法历史 key 跳过并计入报告                      |
| `automations.workspace_key/workspace_identity`               | 控制端 cron 定义                                | 保留记录并重写身份，`location_kind` 不改                           | R3 remote automation 不开放执行入口；迁移只防止记录失联，不改变调度能力边界      |
| `automation_runs.workspace_key`                              | cron run 对账/历史                              | 随 automation identity 重写                                        | `run_id` 是主键，不会因 workspace key 更新合并                                   |
| `off_peak_tasks.workspace_key/workspace_identity`            | 闲时任务记录                                    | 保留记录并重写身份                                                 | 同 session 活跃绑定冲突按下述裁决取消源行；R3 不扩大远端闲时调度                 |
| `session_creation_commands.workspace_key`                    | 创建命令的持久分配回执（含删除后的保护记录）    | 与 task 同事务 rekey；相同回执合并，不同 session ID 冲突整笔回滚   | 新 key 重试原命令仍返回原 ID；仅有回执也必须迁移                                 |
| `workspace_alias` / `workspace_migration_*`                  | 远端 Server 专用 canonical/ledger               | 控制端不创建、不读取                                               | 这些表只属于 Source Server tasks-index，禁止与控制端迁移混用                     |

不需要改写：`task_groups`（不以 workspace key 定位）、`task_group_view_node_orders` 的 `node_type='group'` 行、本地 workspace 行与远端本机 path-key 行、CLI `db.sqlite` 的 `session/message/part`（由 Source Server 侧 canonical migration 处理）、Controller 内存投影（首次握手 / 重连用新 source snapshot 原子替换）。

事务与回滚：每个 workspace 单事务重写，写入 `controller_remote_identity_migrations` ledger（old/new key、各表 before/after 行数、状态、错误）；任何表失败整事务回滚。迁移后机械对账 `tasks` membership、group member、automation、automation run、off-peak 数量前后一致，旧 key 对应行数必须为 0。

失败收口必须保留原始迁移错误。SQLite 因 FULL/IOERR 自动回滚后，清理不得用“无活动事务”覆盖原错误；控制端 failed 审计写入按 best-effort 执行，即使审计库不可写也返回带原始错误的 failed 报告，不因二次审计失败中断握手。远端 alias 合并的事务回滚同样遵守此规则。

闲时绑定冲突裁决（CR-03，控制端与远端 canonical 合并共用）：同一数据库中，源 key 与目标 key
下存在相同非空 `session_id`，且双方 `status` 均不属于 `completed/failed/cancelled` 时，保留
目标活跃行；源冲突行先转为 `cancelled`，再与其他源行一起改写身份，不删除历史。
取消沿用终态落库语义：写入迁移时刻的 `ended_at/updated_at`，清空 `failure_reason`，设置
`schedulable=0`、`claim_running=0`、`claimed_at=NULL`；对象 id、session/conversation 引用、
票据与既有核销状态保持不变，未核销终态交由既有 outbox 处理。目标行、既有终态行、空 session、
不同 session 及其他 workspace 的运行状态保持不变。冲突裁决与 rekey 必须在同一
`BEGIN IMMEDIATE` 事务内，后续失败时连同取消一起回滚；重试不重复修改已迁移行。
多个 source 变体按 frozen plan 的既定顺序处理；目标原本没有该 session 活跃行时，先迁入的
行成为后续冲突的保留目标。Source Server 既有 task identity 冲突仍由预检拒绝，不能借此绕过。

### 9.2 远端 canonical key 解析与合并（Server Core 自治）

R3 对远端存量数据的原则：**能不动就不动**。旧版本 Desktop（旧主链跑旧代码）只认旧 route-derived key，任何需要旧代码配合的兼容层都无效，因此兼容只能发生在数据形态层——R3 让新主链**继续读写旧格式 key**，通过 alias 解析获得 route 无关性：

```text
Core workspace 定位层收到 { workspacePath, legacyRouteHint? }
  │
  ├─ alias 表已有该 path 记录 ──────────────► 使用记录的 canonical key（零数据改动）
  │
  ├─ 无记录，扫描两库中该 path 的 remote:* 变体
  │    ├─ 恰有一个 key（单线路用户，绝大多数）─► 该 key 即 canonical，写入 alias 表（零数据改动）
  │    ├─ 多个 key（多线路历史）──► 选最近活跃 key 为 canonical，其余变体行一次性合并进 canonical
  │    │                            （备份先行 + migration ledger + 冲突报告，见下）
  │    └─ 同时存在本机 path key 的历史 ──► 不合并（远端本机历史保持独立，R4 统一）
  │
  └─ 完全无历史（新 workspace）──► 以 legacyRouteHint 为 canonical 并写入 alias 表
                                    （保证旧版本从同线路连接时新任务同样可见）
```

- alias 表落远端 `tasks-index.sqlite`（`workspace_alias(path, canonical_key, created_at)`），是新代码专用的小型附加表，旧代码不感知、不受影响。
- **单线路用户（绝大多数）：任务行、session 行、`sessions/<hash>` 配置目录全部零改动**。新旧版本读写同一批行：回退后已有会话可见、可续聊；新版本在同一 session 里追加的消息旧版本同样可见（messages/parts 按 session_id 关联）；反之亦然。
- 多线路合并仅处理「同 path 多个 remote:\* 变体」，迁移对象与裁决固定如下：

  | 对象                                                     | 合并规则                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
  | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `tasks`                                                  | 唯一 task 迁到 canonical；同 `taskId` 合并 shell metadata；meta 字段按 `updated_at` 较新者优先（相同时间沿用 source 优先），状态/provider/mode/model/migration/fork/cron/off-peak 投影与合并后的 meta 保持一致；`createdAt` 取最早、`updatedAt` 取最新、title 优先用户手工版本，pinned/archived/deleted 按 `deleted > archived > pinned > normal`；正文索引保留 canonical 的非空值，否则取 source；`unreadAt` 取双方非空最大值，`lastUnreadAt` 取双方历史 marker 与合并后 unread 的最大值；cron/off-peak/fork 身份不兼容则整 workspace 冲突 |
  | `task_group_members` / `task_group_workspace_bootstraps` | 随 task/workspace rekey；canonical 已有同 task/bootstrap 时保留 canonical 行并删除 source 重复行                                                                                                                                                                                                                                                                                                                                                                                                                                            |
  | `task_group_view_node_orders`                            | 只改 `node_type='task'` 且 `node_key=[workspaceKey,taskId]` 的结构化 key；canonical 已有同 key 时保留 canonical 顺序                                                                                                                                                                                                                                                                                                                                                                                                                        |
  | `automations` / `automation_runs`                        | `workspace_key` 全量 rekey；存在 `workspace_identity` 时同步改为 canonical；对象 id、task/session 引用与运行状态不改写                                                                                                                                                                                                                                                                                                                                                                                                                      |
  | `off_peak_tasks`                                         | 按 §9.1 的闲时绑定冲突裁决保留 canonical 活跃行、取消 source 冲突行后全量 rekey；保留全部历史及对象引用，非冲突行运行状态不变                                                                                                                                                                                                                                                                                                                                                                                                               |
  | `~/.zcode/cli/db/db.sqlite#session`                      | 只把同 path 变体的 `workspace_id` 改为 canonical；messages/parts 正文不改写                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
  | `~/.zcode/v2/sessions/<hash>`                            | 递归合并 source hash 目录：目标不存在则移动；同相对路径且字节相同则去重；类型不同或字节不同则在任何备份/搬运前整 workspace fail-closed                                                                                                                                                                                                                                                                                                                                                                                                      |

- 重复 task 的 meta 合并仍按字段进行：较新记录缺少某字段时保留较旧记录的值，不能用较新行的
  NULL 投影覆盖该值。旧 meta 未携带字段时，保留双方索引中较新行优先的非空投影，兼容历史
  cron/off-peak 仅回填索引列的记录。投影修复、meta 写入和 source 删除在同一 task DB 事务内完成；
  cron/off-peak/fork 仍以 meta 字段为准、历史索引列作缺失字段的来源，再执行身份冲突预检；
  即使两份 meta JSON 相同，双方有效身份不同也必须拒绝，不能按新旧覆盖身份。
- 项目化 task 索引从 `cli_*` 列投影标题、创建/更新时间与状态，合并必须同步这些 CLI 事实，
  规则与 `TaskIndexRepo.applyCliFacts` 一致：`cli_created_at` 取最早、`cli_updated_at` 取最新；
  较新行的 `cli_last_outcome` 为空时保留较旧值；custom 标题来源不被非 custom 覆盖；
  `cli_deleted` 取最大、`handoff_pending` 取并集。Source Server 的行共用同一 owner host，
  `host_id`/`root_path`/`project_id` 沿用 canonical 行；只跑过 tasks schema 迁移、没有这些列的库按旧列合并。
- CLI 事实的“较新行”只按双方 `cli_updated_at` 判定，与壳字段按 `updated_at` 的裁决相互独立；
  没有 CLI 事实（`cli_updated_at` 为空）的一方不胜出，时间相同时沿用 source 优先。旧 ACP ID 迁移
  只抬高 `updated_at`、不改 `cli_*`，两列在存量库中可以分叉，不能用 `updated_at` 代替。

  ```text
  较旧 meta + 较新 meta → 合并 meta → 同一事务更新索引投影 → 删除 source 行
                                      └─ 失败 → 整个 task DB 事务回滚
  ```

- 冲突预检覆盖 task identity 与 `sessions/<hash>` 文件碰撞。冲突默认保持 workspace fail-closed，双方数据
  原地零搬运；此时冲突检测早于备份，因此不得声称“已有备份”。相同未变化冲突重复打开只更新同一失败
  ledger/冲突集，不新建 ledger、不创建备份。身份冲突是确定性用户决策，`migrate retry` 在冲突未解决时
  返回结构化 `workspace-task-identity-conflict` 且 `retryable:false`，不得空转后宣称已重试。
  写事务按 source 顺序逐个并入 canonical，后一个 source 与已累积的合并结果比较；task identity 预检
  必须按同一顺序累积每个 `taskId` 的合并结果，不能只比 canonical 快照。canonical 缺该 task 或缺对应
  身份字段时，source 之间的身份冲突同样在建账和备份前发现：

  ```text
  canonical A 无 T（或 T 无 cron）；source B.T cron=b，source C.T cron=c
    预检：merged[T] ← B.T → C.T vs merged[T] → 冲突 → 复用失败 ledger，不备份
  ```

- 管理面提供**整目录粒度**显式「保守放弃合并」：最近活跃变体成为 canonical，其他变体原地封存且不搬运；
  禁止 task 粒度跳过。ledger 使用 `status='abandoned'`，记录 canonical、时间、触发方式和覆盖上述全部迁移
  对象的 activity digest。后续查询发现 digest 变化时投影 `abandoned-diverged` 并提供重新尝试合并；
  `failedPathCount` 只统计 `failed`，`abandonedPathCount` 独立统计，二者禁止互相推断。
- abandon 在读取配置快照后取得 task DB 写锁，并在事务内复查同一 migration 的 `status='failed'`、`phase IS NULL`、canonical 与 variants 均未变化。已完成、已恢复、已删除或计划已变化时拒绝并返回可重试错误，保持当前 ledger/alias；不能用毫秒 `updated_at` 代替计划比较。同一 Source Server Repo 内，resolve、retry、abandon 按 trim 后的 workspacePath 共用一条串行队列，覆盖读计划、异步备份、目录搬运、alias 发布与连接关闭；retry 在队列内复用内部 resolve，不重复排队。前一次失败仍释放队列，下一次从已提交 ledger 恢复；不同 path 独立排队。该队列不替代 SQLite 写事务，也不承诺跨进程串行。
- resolve 入口在 alias/variant 扫描前查询当前 path 的 `abandoned` ledger。用户未显式“重新尝试合并”时，
  无论 digest 是否变化都直接返回冻结 canonical 与 `mergedKeys=[]`，允许 workspace 打开；digest 变化只把报告
  投影为 `abandoned-diverged`。显式 retry 才把 ledger 重新激活并进入 conflict preflight。
- 无冲突时先创建两库备份，再按 phase forward-only 推进；备份仅供人工灾难恢复，不自动回滚已提交阶段：

  ```text
  resolve(path)
    ├─ 有 running/failed + phase 的活动 ledger
    │    └─ 冻结 migrationId + canonical + variants，从已记录 phase 继续
    └─ 无活动 ledger
         └─ 扫描 variants + 选举 canonical + conflict preflight
                │
                ▼
            phase=preflight
                -> backups-created
                -> task-db-merged
                -> session-db-merged
                -> config-dirs-merged
                -> alias-published
                -> completed
  ```

  每个阶段的写入都必须幂等，阶段完成后才推进 ledger；阶段工作已完成但 ledger 尚未推进时，重放同阶段也
  必须收敛。活动 ledger 优先级高于 alias/variant 扫描，恢复期间禁止重选 canonical 或创建第二条 ledger；
  迁移开始后出现的新 variant 留给本轮 completed 后的下一次增量迁移。

- resume 不能跳过仍可能变化的冲突条件。进入 `task-db-merged` 前必须在同一个 task DB 写事务内重新验证
  frozen variants 的 task identity；发现新冲突时整阶段 rollback、ledger 保持 failed，禁止“保留冲突 task
  但继续 rekey membership/automation/session”后标记 completed。config 目录在实际搬运时发现 preflight 后
  新冲突也保持当前 phase failed，不发布 alias/completed。
- ledger schema 必须版本化重建，保留存量行，并一次加入 phase 与 `abandoned` 审计字段；不得依赖
  `CREATE TABLE IF NOT EXISTS` 改写既有 CHECK 约束。
- 合并是幂等增量的：旧版本 Desktop 混连期间从「非 canonical 线路」写出的新变体行，在下一次 Core 解析该 path 时并入。
- `legacyRouteHint` 的来源优先级：Host 优先取该 workspace 历史条目上保留的旧 identity（更精确指向历史），
  否则按当前 SSH/WSL/Docker 线路构造；Renderer 传入的 stable identity 不能充当 hint。
- `sourceServerWorkspaceHistory.legacyWorkspaceIdentity` 是回滚 identity 的单一来源。`recordWorkspaceOpen`
  未收到新 legacy hint 时必须保留旧值；所有 `lastWorkspaceSession` 写入者必须基于同一份最新 history
  生成 legacy-compatible snapshot，禁止默认空 history 把 frozen legacy identity 改写成当前线路。
- 冲突 ledger 以 `path + conflict kind` 作为未解决事件身份；canonical 候选变化只能原子更新同一 ledger
  和当前冲突集，不能重复建账。resolved ledger 的冲突明细作为审计记录保留；当前态查询必须 join ledger
  并过滤 `status='failed'`，不得把历史明细误显示为未解决冲突。
- `kind:"server"` 仅是本地开发直连入口，不参与 SSH/WSL/Docker 的 R3 route compatibility。它必须使用
  stable identity 作为 dev storage key，或装配与 Source Server Core 完全相同的 alias mapper；禁止把
  `remote:server:*` 送入只接受 legacy route key 的 `legacyRouteHint`。

### 9.3 新旧版本兼容边界（混连与回退）

| 场景                                | 行为                                                                                                                                                                                                                |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 单线路用户升级 R3 后回退            | 数据零改动，旧主链按原 key 读写同一批行：历史完整、可续聊，R3 期间产生的新任务/新消息同样可见                                                                                                                       |
| 新旧 Desktop 混连同一远端（同线路） | 双方读写同一 canonical key 的行：任务与会话双向可见、续聊互通。差异仅在架构层（旧端起临时 stdio server、新端连 daemon），互不干扰                                                                                   |
| 多线路用户：从被合并线路回退/混连   | 该线路的旧 key 行已并入 canonical，旧端从此线路看不到已合并历史（数据未删除，备份与 ledger 可对账）；从 canonical 线路访问完整。属于窄边缘，灰度文案覆盖                                                            |
| 新装服务器上 R3 创建的 workspace    | canonical = 当前线路的旧格式 key：旧版本从同线路连接可见、可续聊                                                                                                                                                    |
| Desktop 回退后把远端切回旧版本      | 只切换程序 release，用户数据不回滚。SQLite 迁移只加不删，旧版本忽略未知迁移 ID；新版本写入的新内容结构可能显示不全。若旧 Server 不认识更新的 workspace-migration schema 版本，会拒绝启动（fail-closed），不改写数据 |

### 9.4 回滚安全

- 远端：单线路用户天然无损（无数据改动）；多线路合并有备份 + ledger + 报告，极端情况可手工恢复；session 正文（messages/parts）任何情况下不改写。alias 表与 ledger 是纯附加物，旧代码忽略。
- 控制端：`lastWorkspaceSession` 中的 remote entry 在 R3 继续保存 legacy route-compatible
  representation，禁止写入 `remote:server:*`；回滚旧版本后旧字段仍可用。R3 运行态 tab/history/credential/UI store
  必须通过 `sourceServerWorkspaceHistory.legacyWorkspaceIdentity -> workspaceIdentity` 投影为唯一 stable
  workspaceKey，不得在 UI 同时恢复 legacy 与 stable 两条。
- Desktop 首次绑定 Source workspace 时，Host bind 回包可携带一次性
  `previousWorkspaceIdentity` rekey hint；Renderer 必须复用既有 `ensureWorkspaceTab()` 原地把
  legacy tab 换代为 stable tab，不能通过 `addTab()` 产生第二个 workspace。该字段不是任务路由身份，
  仅用于 Desktop `continuous` tab rekey，手机 `replayable` attachment 忽略。
- 灰度顺序：内部验证 → 小比例灰度（重点核对 alias 命中率、多线路合并 ledger 与任务对账）→ 扩大 → 全量；三种连接方式同版本切换，不按 transport 拆分。
- R4（迁移窗口结束、旧版本退出支持范围后）分两步，可解耦：① 删兼容代码（旧连接记录读取、`legacyRouteHint`、旧格式解析、旧散文件清理）——纯代码，风险低；② canonical key 清洗——R4 版 Server CLI 启动时一次性把 canonical key 改写为 server-local key、合并远端本机历史、删除 alias 层。清洗对 Desktop 完全透明：R3 的 Source Server workspace 定位 wire 只传 `{ workspacePath, legacyRouteHint? }`，stable `workspaceIdentity` 只用于 Desktop/Host 侧隔离，canonical 始终是 Core 内部存储细节。因此清洗只是远端 Server 的一次版本升级，不需要控制端配合发版；排期紧时可推迟到 R4 之后。

## 10. Controller 投影与多 Source 产品面（D11）

### 10.1 投影演进

Source 管理状态与命令由 Window Host 单点拥有：

```text
Desktop Renderer ── SourceServerManagementService ──► Directory + ConnectionManager
Desktop Renderer ── source-settings attachment ─────► 在线 Source 配置 channels
Mobile /remote   ── existing workspace attachment ──► 禁止 management/source-settings
```

- `getRecentOperationLogs(profileId)` 查询所属设备最近一次连接或更新的最多 100 行日志；`onDidAppendOperationLog` 通知界面重读。唯一记录归 Host ConnectionManager 的运行时内存，更新后的内部重连属于同一次操作，新操作替换旧记录；并发迟到输出不能覆盖，身份换代迁移到新的 Source/Profile，旧设备保留此前历史。关闭面板不清除，删除对应记录及 Host 退出时清理，不写入 settings。
- `SourceServerManagementService` 提供初始 directory/state snapshot、单调 generation 状态增量、
  connect/disconnect/update/rename/preferred/remove 与迁移计数；Directory 变化必须通过完整 snapshot 或 typed
  directory delta 刷新 `servers/profiles/history`，不能只更新 `states`。迁移计数按 Source 表达
  `available | requires-connection | value`，离线不能伪装为 0。Renderer 不再直接整数组覆盖 settings。
- `source-settings` attachment 不绑定 workspace、不启动 Agent runtime，只暴露
  MCP/skills/plugins/commands/hooks/subagents/memory/output/settings-sync 等非 Provider 配置 channels；Source 离线即销毁。
  Provider 配置面不在其中：模型设置页绑定本地（§8.2），远端配置由 Provisioning 下发（§8.3）。
- 两项能力只在 `desktop-continuous` attachment 注册，`web-remote-replayable` 即使构造 scope 也由 Host
  拒绝；手机只继续消费既有 workspace/task 投影。

- `ControllerProjection` 的 source scope 从 `remote\0remoteSessionId\0workspaceKey` 升级为以 `sourceServerId` 为一级维度（本地 source 保持 `local\0workspaceKey`）；`controller/workspaces` 的 workspace facts 增加 `sourceServerId`、`serverDisplayName`、在线状态与「最近在线时间」。
- R1 的订阅/seq/gap/resync、query 级失效、single-flight、离线冻结语义全部不变。
- workspace、timeline、grouped、archived 与 pinned 入口保留任务的 Source 归属；项目列表平铺，
  设备信息、离线占位、排序和动作以[项目导航规格](../remote/project-first-remote-navigation-spec.md)为准。
  展示名不参与身份、去重或持久化隔离，不以设备 online 代替 attachment ready。
- 写操作（打开/pin/archive/继续）始终路由到任务所属 Source Server；离线时明确失败并回滚乐观状态（R1 fail-closed 语义）。

### 10.2 产品面清单

- [连接 UX](remote-device-connection-ux-spec.md)维护统一五态、三屏向导、安装确认、设备卡、日志、只读任务清单与更新提示；不再使用旧三 tab/五步方案。
- [项目导航](../remote/project-first-remote-navigation-spec.md)维护平铺项目、连接后选目录、原项目续接、断线和重启恢复；远程无项目聊天 UI 停用，数据保留。
- 首次持续运行说明位于目录页，一次性、非阻断，沿用版本化 onboarding 记录；不再弹出要求确认的边界模态。
- [投影与持久化兼容](remote-domain-simplification-and-conversation-workspace-spec.md)维护 open set、显式关闭、strict schema 与 R4 剩余迁移。
- [Renderer 重挂](../remote/desktop-remote-session-renderer-reattach.md)维护设备上线后的项目挂回；底层连接生命周期仍以 §7 为准。
- 模型设置绑定本地（§8.2），Provider 自动下发（§8.3）；其它能力页遵循按设备分组的 Scope 菜单（§8.2）。
- 删除当前物理连接或 recovery owner 使用的 Profile 等价于当前窗口显式断开整个 Source：取消 timer/flight，释放连接、清除 target/secret 并发布 terminal offline。即使有其它 active Profile 也不自动切换；删除非当前 Profile 不打断其它连接。
- uninstall 后由用户决定是否移除本机记录；保留数据卸载重装的身份连续性以 §3 为准。

## 11. 旧主链移除与保留清单

R3 内删除或禁用的可运行路径：

| 处理项                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | R3 落点                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `desktop-attached-remote` provider 下发主链与本地权威混装服务集合                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 删除 `createRemoteWorkspaceServiceCollection` 及其只验证旧分支的测试；统一只保留全转发集合                                                                                                                                                                                                                                       |
| Web/Lite 旧远程连接入口 `POST /api/connect-remote` + `/ws/remote/:id`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 两条配对 route 一并删除，并以 404 不可达测试锁定；Server 不再能启动临时 stdio 主链                                                                                                                                                                                                                                               |
| 把 route-derived identity 当作正式 Controller/workspace identity 的调用方                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 删除零调用方；stable identity 继续由 `sourceServerId + workspacePath` 构造                                                                                                                                                                                                                                                       |
| R3 早期的 Provider「一键同步」与模型设置页设备选择器：`provider-sync` channel、`IProviderSyncService`、`packages/services/src/provider-sync/*`、`shared/src/source-server/contracts.ts` 的 `encryptedProviderSyncSnapshotSchema` / `providerSync*` schema、`ModelProviderSourceControls.tsx`、`useSourceSettingsAttachment.ts`、`providerSyncSnapshot.ts`、`packages/ui/src/lib/remoteWorkspaceProviderSync.ts`、`packages/ui/src/lib/zcodeModelSelectionResolution.ts`、`AppSettings.lastAgentSettingsSourceServerId\|providerSyncDefaultModel\|providerSyncRuntimeCredentialBindings`、`ServiceChannels.ModelProvider\|ProviderSync`、`oauthService.exportSessionForSync\|replaceSessionForSync`、对话横幅「去同步」动作 | 2026-09-07 合并 Provider 重构 M2 时随路线 A 一并删除（详见 [r3-provider-refactor-merge.md（已归档）](../archive/remote-r3/r3-provider-refactor-merge.md)）；替代物为 Provider Provisioning（§8.3）与绑定本地的模型设置页（§8.2）。`source-settings` scope 与 `sourceSettingsServiceCollection.ts` 保留，只服务非 Provider 配置面 |

2026-09-29 视觉收尾：平铺项目导航上线后，删除无生产引用的 `WorkspaceSourceGroupHeader` 及设备分组/折叠偏好辅助函数与旧专属测试；`getWorkspaceSourceServerId` 及精确 legacy alias 解析继续保留。此清理不触及下列 R4 兼容链。

R3 保留源码但已从生产入口不可达、R4 再物理删除：

- `packages/server/src/remote/connect.ts`（及 `handshake.ts`、`stdio-socket.ts` 直接旧链依赖）、`deploy.ts`（及仍被它静态调用的 `remoteAssetDeployDecision.ts`、`zcodeAgentDeploy.ts`）与 `packages/server/src/entry-stdio.ts`。R3 先通过删除 `/api/connect-remote` 和 Desktop 旧调用方切断运行路径，保留一个迁移窗口用于 R2 回滚/升级排查，避免在主链稳定期混入大范围历史模块删除；`pnpm dep:refs` 已确认后两者仍有生产调用方，不能按死代码删除；
- `buildRemoteWorkspaceIdentity` 的 SSH/WSL/Docker 构造。Host 仍在没有历史精确值时用它生成 `legacyRouteHint`，它不是正式 stable identity；随 R4 删除 hint 时一并删除；
- 旧连接记录（`lastWorkspaceSession` remote entry、`remote-workspace:*` credential key）的读取与解析；
- `parseRemoteWorkspaceIdentity` 对 `remote:ssh/wsl/docker:*` 的解析（远端迁移扫描用）；
- 远端 `~/.zcode/server` 旧散文件（未升级 Desktop 的回滚依赖）；
- 迁移 ledger/报告的兼容读取。

长期保留：`IRemoteBackend` 三实现的 exec/upload/detect 原语（Adapter 底座）、`kind:"server"` dev 直连、手机 attachment 全链路。

## 12. 实施记录

原实施切片已完成，过程保存在 Git 历史。发布剩余项仍以[问题台账](r3-source-server-remote-open-issues.md)为准；
本规格标为已实现不表示当前候选已完成全平台发布验证。

## 13. 验收映射与测试策略

- 总方案验收矩阵 REMOTE-01—15 全部由 R3 收口（REMOTE-01 已由 R1 覆盖，此处回归）。关键映射：REMOTE-02→§5.3；REMOTE-03→§4/§7；REMOTE-04/05→§7；REMOTE-06→§10；REMOTE-07（Agent 设置切换 Source）与 REMOTE-11（一键同步）随 2026-09-07 决策作废，替代验收为 §8.2 模型设置页绑定本地 + §8.3 Provisioning 首连屏障 / 重连重注册 / `unsupported` 拒连 / 手机 replayable 拒绝 stub / Secret 不进日志（E2E 落点 `SSH-P0-TASK-01` 的 `provider-provisioning-state.json` 断言）；REMOTE-08→§6.3；REMOTE-09/10→§3.2；REMOTE-12→R2 回归+§7 恢复；REMOTE-13→§5.3 卸载与 §10.2 卸载感知；REMOTE-14→§10.2；REMOTE-15→§5.1 合同测试。
- 证据层按总方案 5.3：UI / Process（每窗口一 Host、远端每 root 一 daemon、每 workspace ≤1 Agent）/ Protocol（握手返回版本与 `sourceServerId`、写路由带 Source）/ Network（三 transport 承载同一 RPC、断线不杀远端、secret 不进日志）/ Persistence（迁移 ledger、Profile、同步结果可对账）/ Recovery（重连、Core 崩溃、升级后状态符合规则）。
- 合同测试是「连接方式无关」的唯一证明方式：同一套用例分别以三种 Adapter + fake Core 运行；业务层测试全部不感知 transport。

## 14. 可观测性

- 连接状态机每次迁移、bootstrap 各阶段、迁移 saga 各阶段使用生产 `info`；自动重试/探测失败用 `warn`；握手/迁移不可恢复失败用 `error`；WS frame、探测心跳等高频细节一律 `debug`。
- `RemoteWorkspaceConnectionLog` 继续按 `windowId + requestId` 归属，bootstrap 全阶段结构化上报（检测/上传进度/安装/daemon/握手/迁移门）。
- Process Monitor 增加 Source Server 维度：连接状态、`sourceServerId`、daemon 版本、attachment 数。
- SSH 超时文案按连接阶段区分。ssh2 的握手超时和 Keepalive 超时都使用 `client-timeout` level，只有 message 不同。连接 ready 之前的 `client-timeout` 是"握手超时"；连接 ready 之后的 `client-timeout` 只能来自 Keepalive（每 15 秒一次心跳，最后一次收到数据后约 60 秒仍无响应），文案是"连接无响应"。不能把已建立连接的断开记成握手失败。
- ingress token、capability、Provisioning Envelope（Personal Layer 与 allowlist 凭据）、SSH 凭据在任何日志/遥测中不可出现；Provisioning 结果日志只记录 `environmentKey`、trigger、status、耗时与计数。

## 15. 已决事项与遗留确认

以下事项已随评审反馈定案（2026-08-18）：

1. **回退与混连兼容**：远端不做破坏性 key 重写，采用 canonical key + alias 解析（§3.2/§9.2）。单线路用户回退旧版本后历史完整、可续聊，新旧混连读写同一批行；server-local 清洁化留待 R4。
2. **WSL 通道**：一期统一 stdio 桥，不做宿主 localhost 直连（留作后续性能优化）。
3. **远端 automation**：一期不支持（调度器在窗口 Host 内，移植成本独立且不小；方案已把错过补跑列为后续能力）；daemon 常驻为后续实现铺路，架构不设障碍。
4. **模型配置下发的加密边界**（原「一键同步加密」，2026-09-07 随路线 A 改由 Provisioning 承接）：wire 不做应用层二次加密（credential cipher 是本机指纹密钥，跨机不可行且通道受信）；Source 端解密 allowlist 值、目标端用自身 Credential Store 重新加密落盘；secret 不落日志（§8.3、provider-provisioning.md）。
5. **`kind:"server"` dev 入口**：接入 ingress token（同一客户端代码路径）。
6. **窗口语义**：一期按单窗口设计与验收，启动自动重连由主窗口 Host 执行。

遗留确认（非阻塞）：

- 多线路历史合并的窄边缘（§9.3：从被合并线路回退后该线路视图看不到已合并历史）的灰度文案口径。
- 以下五项来自 Provider 重构合并（2026-09-13 自 [r3-provider-refactor-merge.md（已归档）](../archive/remote-r3/r3-provider-refactor-merge.md) §7 并入）：
  - 若产品仍需要「查看 / 手动同步某台远端的模型配置」，在 `IProviderSettingsService` 之上重建只读设备视图 + 显式「立即下发」按钮（复用 `coordinator.requestAll("personal-config")`），不复活 `provider-sync` / journal 体系。
  - Provisioning lane 的 Environment key 由 `buildRemoteEnvironmentKey(target)` 按 transport 派生，未接入 `sourceServerId`；同一 Source 经不同线路连接会形成两条 lane（结果幂等，但重复首连同步）。可评估在 descriptor 携带 `sourceServerId` 时以其为 key。
  - `REMOTE_WORKSPACE_RPC_CONTRACT_VERSION` 仍为 v1，但 channel 集合已变；当前靠「兼容门默认同版本」兜底，若未来放宽 `zcodeCompatibility.minCompatibleVersion`，需先决定是否升 v2 并在握手中协商。
  - `zcode uninstall` allowlist 不含 `config/`，`config/provider/zcode-builtin-*.json` 卸载后会留在 `preservedPaths`；是否纳入 allowlist 待定。
  - R3-ISSUE-012（API Key 明文持久化规格冲突）已按明文 Personal Config 新基线关闭为不修复，见问题台账。
