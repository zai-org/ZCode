# R2 独立 Server CLI 与 daemon 规格

## 1. 状态与范围

- 状态：P0/P1 已实现；本次 hardening 已补齐 Core 父进程断连、更新指针清理和稳定 Server identity；Linux x64 已完成 SSH 实机验证
- 阶段：统一多端远程架构 R2 / D4
- 本阶段目标：交付可独立安装、可后台运行、与 UI 生命周期解耦的 ZCode Server CLI
- 本文定位：R2 的实现规格和边界；可执行测试补充见 [R2 lifecycle test plan](./r2-server-cli-and-daemon-test-plan.md)
- R2 不切换 Desktop 的生产远程连接主链

本文基于：

- [ZCode 统一多端远程连接架构与产品方案（评审稿）](https://internal-docs.example.invalid/redacted)
- [R1 窗口级单 Host 进程重构规格](./r1-single-window-host-refactor.md)
- [Agent Electron/Node runtime 事实](../runtime-tools/agent-electron-node-runtime.md)
- [ZCode Lite / Server 统一多端架构实施计划](./unified-zcode-lite-server-multi-server-plan.md)

R2 交付：

- 独立安装的 `zcode` Server CLI；
- `serve`、`serve --daemon`、`status`、`stop`、`restart`、`update`、`uninstall`；
- Supervisor、Server Core、Agent 的进程边界；
- macOS、Linux、Windows 的用户级自启动服务；
- 单实例、崩溃退避和任务中断语义；
- HTTP/WebSocket ingress 边界及 R1 Host RPC 兼容性验证；
- 与现有远端资产流程一致的独立 Node runtime。

R2 不交付：

- SSH、WSL、Docker、Direct URL、WS/WSS 的 Transport Adapter；
- Desktop Host 到 Server daemon 的连接发现、安装和连接管理；
- Web 多 Server Controller；
- 手机独立创建 Server、Host 或 Agent runtime；
- `sourceServerId`、Connection Profile、Resource Store 和完整 compatibility manifest；
- Desktop 新远程生产链切换。

## 2. 核心决策

| 决策项               | R2 结论                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新代码目录           | 新建 `packages/zcode-server-cli`；R2 不在 `packages/server` 中增加代码                                                                                                                                                                                                                                                                                                                                                                                                              |
| 旧 `packages/server` | 仅作为现有 HTTP/WS、stdio、远程部署和协议行为参考；保持其当前入口兼容                                                                                                                                                                                                                                                                                                                                                                                                               |
| 用户入口             | 独立发行包提供 `zcode`；无参数继续进入既有 TUI                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Server Core          | 新目录内实现新的 Core 入口和生命周期合同，不继承旧 `entry-http` / `entry-stdio` 的进程语义                                                                                                                                                                                                                                                                                                                                                                                          |
| 业务服务             | 经过审查后复用 `@zcode/services`、`@zcode/shared`、`@zcode/rpc` 等底层能力                                                                                                                                                                                                                                                                                                                                                                                                          |
| Supervisor           | 只拥有生命周期状态，不拥有 task/session/stream/queue/snapshot 业务状态                                                                                                                                                                                                                                                                                                                                                                                                              |
| 监听地址             | 默认回环地址和动态端口；非回环监听必须启用鉴权                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Web / WS             | R2 实现并验证 Core 的 HTTP/WS ingress；具体远程 Transport 留给后续阶段                                                                                                                                                                                                                                                                                                                                                                                                              |
| 数据目录             | 复用 `getZCodeDataRootDir()` 和 `ZCODE_DATA_BASE_DIR`；标准目录为 `<dataRoot>/server`。OS service 必须携带内部参数 `--server-root <absolute-path>`，不得依赖注册时 shell 的环境                                                                                                                                                                                                                                                                                                     |
| Node runtime         | 沿用现有远端资产流程的 Node `v22.16.0`；Server CLI 不依赖系统 Node 或 Electron Node                                                                                                                                                                                                                                                                                                                                                                                                 |
| 崩溃策略             | 5 次/5 分钟预算，退避 1、2、4、8、16 秒；超出后进入 `crash-loop-stopped`。ready 的 Core 连续 6 个 heartbeat 周期无 IPC 消息时由 Supervisor SIGKILL，按崩溃处理（§4.2 Core 活性）                                                                                                                                                                                                                                                                                                    |
| Task 恢复            | Core 崩溃或更新后，运行中的 Task 中断，不自动恢复或重放输入                                                                                                                                                                                                                                                                                                                                                                                                                         |
| stop                 | 停止当前实例，但保留自启动注册                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| uninstall            | 停止实例、移除服务注册、删除 ZCode 自有数据；Workspace/Repo/用户文件不删除                                                                                                                                                                                                                                                                                                                                                                                                          |
| update               | 默认从配置的 release catalog 在线下载并校验；无网络时可应用本地 pending；使用原子切换和失败回滚                                                                                                                                                                                                                                                                                                                                                                                     |
| 组件更新             | 以 Node、server、agent、official-plugins、native-search-tools 五个粗粒度组件做内容寻址缓存；完整 release 仍是原子运行单元                                                                                                                                                                                                                                                                                                                                                           |
| 平台服务注册         | 先探测当前用户的 launchctl / systemctl --user / schtasks 能力；Linux 非交互会话可从 `/run/user/<uid>/bus` 恢复 user bus 环境。服务管理器不可访问，或 systemd 在装载阶段（`daemon-reload`、`enable`）失败时，自动由 detached Supervisor 启动并报告 `serviceRegistered=false`；systemd 启动阶段（`start`）失败和 launchd / Task Scheduler 注册失败仍返回可诊断错误，不做伪装 fallback。每次冷启动重新选择，不持久保存。OS service 或 detached Supervisor 二选一成为 daemon 启动 owner |

## 3. 进程与职责模型

```text
安装后的 zcode
└── bin/zcode
    ├── serve
    │   └── Supervisor
    │       └── Server Core
    │           └── Agent CLI
    ├── serve --daemon
    │   └── OS Service Manager
    │       └── Supervisor
    │           └── Server Core
    │               └── Agent CLI
    ├── status / stop / restart / update / uninstall
    │   └── 本地 Unix Socket / Windows Named Pipe
    │       └── Supervisor
    └── 无参数及其他既有 CLI 命令
        └── 发行包内既有 CLI/TUI bundle
```

### 3.1 Server CLI

Server CLI 负责：

- 解析 Server 生命周期命令；
- 对 Supervisor 发起本地控制请求；
- 输出人类可读或 `--json` 状态；
- 执行 update/uninstall 的交互确认；
- 在不加载 Server Core 的情况下保持 TUI 启动路径；
- 将无参数和非 Server 生命周期命令转发给发行包内已有 CLI/TUI bundle。

CLI 不直接持有 Server 业务状态，也不直接杀 Core 或 Agent 的裸 PID。

### 3.2 Supervisor

Supervisor 负责：

- 获取和维护 data-root 级单实例锁；
- 启动、停止、重启 Server Core；
- 通过私有 child IPC 接收 Core ready、heartbeat、运行任务数量和退出原因；
- 执行崩溃退避和 crash-loop 熔断；
- 处理 update/uninstall 前的运行任务保护；
- 管理平台服务注册、启动、停止和移除。

Supervisor 不持有：

- Session 正文；
- Task conversation 或 stream；
- CommandInbox、queued prompt 或 permission payload；
- Workspace、Repo 或用户文件内容。

### 3.3 Server Core

Server Core 是无界面的业务服务进程，负责：

- 以 `standalone-server` authority 组装服务；
- 管理多个 Workspace 和 Workspace Agent；
- 提供 HTTP API 和 WebSocket API；
- 维护 task/session/runtime 的权威状态；
- 把运行任务数量以只读生命周期快照提供给 Supervisor；
- 响应 SIGINT、SIGTERM 并有界释放服务资源。

Core 崩溃后由 Supervisor 启动新的 Core。旧 Core 中运行中的任务不自动续跑，遵循现有 CLI/runtime 的冷恢复语义。

### 3.4 Agent CLI

Agent CLI 继续作为每个 Workspace 的独立子进程运行：

- Agent 负责命令队列、Session、模型调用和工具执行；
- Server Core 负责 Workspace 到 Agent 的生命周期和路由；
- Supervisor 不直接管理 Agent 的业务状态；
- Agent 重启、Core 重启和 Desktop attachment 断开不得自动重放已接受的输入。

## 4. 进程间通信

```text
CLI 控制请求 ── Unix Socket / Windows Named Pipe ──> Supervisor
Supervisor ── 私有 child IPC ──> Server Core
Server Core ── stdio/RPC ──> Agent CLI
Server Core ── HTTP/WS ──> Desktop Host / Browser / future Transport
```

### 4.1 CLI ↔ Supervisor

本地控制协议由 `packages/zcode-server-cli` 自己拥有，使用严格运行时 schema 和 JSONL framing，至少包括：

- `status`；
- `stop`；
- `prepare-update` / `apply-update`；
- `prepare-uninstall` / `confirm-uninstall`；
- `ping`。

控制 socket/pipe 必须位于当前 data root 下，并使用权限收紧的运行时路径。响应不得泄露 token、凭据或完整用户路径之外的敏感内容。

### 4.2 Supervisor ↔ Core

Core 通过私有 child IPC 发送：

- `ready`：监听地址、端口、Core 版本和实例 generation；
- `heartbeat`：单调递增时间戳和运行任务数量；ready 后每 `CORE_HEARTBEAT_INTERVAL_MS`（10 秒）一次，是 Core 定期发出的活性消息（判定规则见 [Core 活性](#core-活性)）；
- `task-activity`：运行任务数量发生变化时的只读更新；
- `shutdown-ack`：资源释放完成；
- `fatal`：不可恢复错误摘要；Core 随后退出时 Supervisor 把它保留在 `lastExitReason` 中（见 §7.1 `serve --daemon` 失败详情）；
- `exit`：Core 主动或异常退出原因。

#### Core 活性

Core 进程存活不等于 Core 可用。Core 的事件循环被同步工作占满时，进程仍在，但不发 heartbeat，
不响应握手，也执行不了 JS 层的 SIGTERM 处理。Supervisor 负责发现这种状态并恢复
（ZCT-2113570821476302848：远端 Core 卡死后 status 一直是 ready，只能人工 `kill -9`）：

- 只在 `ready` 状态检查。每个 heartbeat 周期检查一次；当前 Core 发来任何 IPC 消息，计数清零。
- 连续 `CORE_UNRESPONSIVE_HEARTBEAT_PERIODS`（6）个周期没有消息，判定 Core 无响应。Supervisor 直接
  SIGKILL 当前 Core，`lastExitReason` 带 `core unresponsive` 摘要。不发 SIGTERM，因为卡住的事件循环执行不了它。
- Core 退出后按普通崩溃处理：计入 crash budget，按 1/2/4/8/16 秒退避重启；运行中的 Task 中断（R2-CLI-07）。
- 按周期计数，不比较时钟。Supervisor 自身被挂起（主机休眠、SIGSTOP、VM 暂停）时检查不执行，
  恢复后不会把挂起时长算成 Core 无响应。
- `starting`、`stopping`、`updating`、`stop-failed` 不做活性检查，仍按各自的超时和终态规则处理。
- 发送方 Core 与 Supervisor 共用同一组常量（`contracts.ts`），不各自写死。

```text
Core 事件循环卡住 ──X── heartbeat
Supervisor（ready）：每 10 秒检查，无消息则计数 +1 ── 连续 6 次 ──> SIGKILL Core
  Core exit ──> crashed ──> crash budget 退避 ──> 新 Core ready ──> status 带新端口
Desktop probe / serve --daemon 读到新端口 ──> 握手成功
```

运行任务数量必须来自 Core 内部 Agent runtime 发布的权威 turn lifecycle fact，不能由 Supervisor
维护第二份 task registry。Core-local `TaskActivityTracker` 订阅所有已连接 workspace 的
`turn.started` / `turn.terminal`，只保留按 `workspaceKey + sessionId` 去重的活动 key，并把数量作为
生命周期快照发给 Supervisor。它不是公开 RPC 接口，也不持有正文、stream、queue 或 snapshot。
Task facade 与直接调用 `IZCodeAgentService` v4 的 `desktop-continuous` 路径必须汇入同一 tracker；
`web-remote-replayable` 仍只按自己的 gap/snapshot 边界向客户端恢复，活动计数不得改变两种 delivery
语义。

```text
desktop-continuous ── sendConversationCommandV4 ─┐
                                                 ├─> Agent runtime turn facts
web-remote-replayable ─ Task/Agent command ──────┘             │
                                                               ▼
                                         Core-local TaskActivityTracker
                                         key = workspaceKey + sessionId
                                                               │ count only
                                                               ▼
                                                         Supervisor guard
```

## 5. HTTP / WebSocket ingress

R2 不把 Server Core 设计成 SSH 专用服务。Web、WS、WSS、SSH、WSL、Docker 后续都应只是到达同一个 Core 的不同 Transport。

```text
Desktop Host / Browser Web / Mobile Controller
                  │
                  ▼
       SSH / WSL / Docker / WS / WSS
                  │
                  ▼
              Server Core
```

R2 Core 实现和验证：

- HTTP server-info 能力；
- Web replayable WebSocket 合同；
- capability-gated desktop continuous WebSocket 合同；
- `desktop-continuous` 和 `web-remote-replayable` 的 delivery 边界；
- `workspaceIdentity`、`workspacePath` 的传递和隔离；`remoteSessionId` 不属于 R2 Core ingress 合同，仍由 R3 Transport/Host 连接层负责透传。

R2 的 Core 是 Supervisor 的 child process。除显式 `shutdown` 外，Core 还必须监听 IPC
`disconnect`：Supervisor 被强杀、崩溃或 IPC 通道断开时，Core 要自行关闭 HTTP/WebSocket、释放
Agent/SQLite 等资源并退出，不能成为绕过 data-root lock 的孤儿进程。Supervisor 只依据自己的
lock ownership 判断实例存活，不能把 Core 的孤儿状态当作可安全复用。

```text
Supervisor ── SIGKILL/crash ──X IPC ──disconnect──> Core
                                                    │
                                                    ├─ close HTTP/WebSocket
                                                    ├─ dispose Agent/SQLite
                                                    └─ exit；端口不再可用
```

在线 catalog 已确认当前 release 与磁盘上的 `current.json` 一致时，`prepareOnlineUpdate` 会删除
不可能高于当前版本的遗留 `pending.json`。这样离线更新不会在一次“已是最新”的在线检查之后
意外降级到旧 release；如果 pending 明确指向更高的未来版本，则保留它作为显式的离线候选。

`/api/server-info.serverId` 使用 `install.json.installationId` 作为持久用户数据环境的稳定身份。只有直接调用
Core HTTP 工厂且未提供 server root 的测试/嵌入场景才回退到 hostname；真实 Supervisor 启动的
Core 必须通过 `ZCODE_SERVER_ROOT` 校验 ownership marker 后注入 installationId。

现有 `packages/server` 中的 `/api/server-info`、`/api/rpc-host-capability`、`/ws`、`/ws/host` 等行为作为兼容性参考；新 Core 不直接导入旧入口，而是通过合同测试决定需要保留的边界。

R2 默认只监听回环地址和动态端口，并把实际端口写入 `status.json`。非回环监听必须显式配置鉴权。R2 不实现公网暴露、Relay、配对、Direct URL 发现和 Transport Adapter。

当前 loopback-only ingress 的安全边界是网络位置边界，不是进程身份边界：同一台机器上能够发现该动态端口的其他进程，理论上可以访问普通 `/ws` replayable RPC 和申请 host capability。R2 的 `authRequired: false` 因此只表示“未启用调用方认证”，不应被解释为跨用户或公网安全保证。该阶段暂接受受控本机/SSH 隧道的威胁模型；在启用 Direct URL、WSS、Relay 或其他非回环 Transport 前，必须补充 token、Unix socket peer credential 或 Windows named-pipe ACL 等调用方认证，并更新对应连接合同。

手机 `/remote` 仍只能 attachment 到已经存在的 Desktop Host；R2 daemon 不得成为手机独立 Agent 的创建入口。

## 6. 新代码目录与依赖边界

```text
packages/zcode-server-cli/
├── src/
│   ├── main.ts
│   ├── supervisor/
│   ├── server-core/
│   ├── ipc/
│   ├── platform/
│   ├── runtime/
│   └── packaging/
└── package.json
```

依赖规则：

- 新 Core 不依赖 `@zcode/server` 的入口实现；
- 不修改 `packages/server` 的 `entry-http`、`entry-stdio` 和 `build:remote`；
- 只复用经过审查的 `@zcode/services`、`@zcode/shared`、`@zcode/rpc` 和服务类型；
- 不把 Electron、Renderer、Desktop Main 或 Window Host 打入 Server CLI 包；
- 不新增 App ↔ Agent 协议；若未来必须修改该协议，另行修改 `packages/shared/src/zcode-protocol` 并增加 schema 验证；
- 新增 IO 使用异步 API；锁、状态和 release 切换必须可恢复、可审计。

## 7. 安装包与 Node runtime

R2 Server CLI 不使用 Electron 内置 Node，也不要求目标服务器预装 Node。

当前事实：

- Desktop Host/Agent 使用 Electron 41 内置 Node 24.x；
- SSH/WSL/Docker 远端资产使用独立 Node `v22.16.0`；
- CLI bundle 当前以 `node22` 为最低运行目标。

R2 沿用第二条远端资产链路，并把它扩展为独立 Server CLI 的发行 runtime：

- Node 版本固定为 `v22.16.0`；
- CLI、Supervisor、Server Core、Agent 共用同一 Node；
- 每个 OS/架构随包提供对应 Node；
- 运行时不联网下载 Node；
- `node-pty` 等原生依赖按 OS/架构随包准备；
- 根目录构建仍可使用 Node 24+，但不代表发行 runtime 使用 Node 24。

发行包结构：

```text
zcode-server-<os>-<arch>/
├── bin/
│   ├── zcode
│   └── zcode.cmd
├── runtime/
│   ├── node                 # Windows 为 node.exe
│   ├── package.json         # {"type":"module"}，让 .js 入口按 ESM 解析
│   ├── server-cli.js        # ESM bundle（tsup 产物，含 __dirname banner）
│   ├── server-core.js       # ESM bundle，server-cli 以同目录相对路径 fork
│   ├── zcode.cjs            # 既有 CLI/Agent bundle（自包含 CJS）
│   ├── node_modules/        # bundle 外置依赖闭包（含 node-pty 平台 prebuilds）
│   ├── tools/               # bfs/rg/ugrep（Windows 为 rg/ugrep）
│   └── packages/            # Agent 实际启用的官方插件
└── manifest.json
```

入口用 ESM `.js` 而不是最初设想的 `.cjs`：`@zcode/services` 依赖链已按 ESM 组织，
CJS 化 bundle 风险更高；`server-cli.js` 通过 `new URL("./server-core.js", import.meta.url)`
fork Core，通过同目录 `zcode.cjs` 委派既有 CLI，因此三个入口必须位于同一 `runtime/` 目录。

### 7.1 发行包 staging

staging 由 `packages/zcode-server-cli/src/packaging/stage.ts` 实现，
`pnpm --filter @zcode/server-cli stage --target <os>-<arch>` 触发，只做本地组装，不上传、不发布：

- 入口 bundle 来自本包 `tsup` 产物；`zcode.cjs` 来自 `apps/zcode-cli/packages/cli/dist/zcode.cjs`
  （由 `scripts/build-desktop-agent-cli.mjs` 构建，与远端资产链同源）；
- `runtime/node_modules` 内容以**产物扫描**为事实源：扫描 bundle 顶层裸模块引用，
  与 workspace `node_modules` 求交集后递归收集生产依赖闭包，从 workspace 复制为扁平布局；
  不使用 `tsup` external 声明列表作为事实源，避免声明与实际引用漂移；
- Server CLI/Core 的 ESM bundle 必须将仍由 services 间接使用的 `yazl` 外置，
  由 Node 加载其 CommonJS 实现及内置模块依赖；删除 CLI 自身的直接调用不能据此删除
  external 配置。staging 继续通过产物中的裸模块引用收集 `yazl` 的生产依赖闭包。
  `tsupConfig.test.ts` 使用实际 tsup 配置构建并在独立 Node 进程执行
  `server-cli.js --version --json`，防止只验证源码或模拟发行布局而漏掉入口加载错误。
- `node-pty` 复制时剔除 `build/`（本机编译产物，交叉打包时会被 loadNativeModule 优先加载导致
  错误架构崩溃），只保留目标平台 `prebuilds/<os>-<arch>/`；darwin 保留官方 `pty.node` 与
  `spawn-helper`；
- 发行包里 `node-pty` 的 JS 与 native 必须来自同一个包、同一个版本。linux 目标的整个 `node-pty`
  始终由 workspace `@lydell/node-pty-linux-<arch>` 提供（该包是同版本 node-pty 的 linux 子集，含
  `lib/` 与 `prebuilds/<os>-<arch>/pty.node`），不能只把它的 `pty.node` 塞进官方 JS：两者 resize
  参数个数不同（3 个 / 5 个），混装后终端 resize 必然报 `Usage` 错误、尺寸停在初始值。官方包里已有
  linux `pty.node` 也不能证明来源正确：桌面 Linux 打包的 beforePack 会把平台包的 native 回填进共享的
  workspace `node-pty`，同一 checkout 随后 staging 时会复制到这份文件，所以 linux 不按文件是否存在决定来源。
  平台包缺 `lib/` 或 `pty.node` 时 staging 失败；staging 结束前比对 `node-pty/package.json` 的版本
  与 native 来源包的版本，不一致即失败；
- Node 二进制固定 `v22.16.0`：优先复用 `packages/desktop/mock-cdn/releases/<version>/node/<platform>/`
  已下载的缓存，缺失时从 nodejs.org 下载目标格式（POSIX 为 `tar.xz`，Windows 为 `zip`）并缓存；
- 同时产出目录形态和 `zcode-server-<os>-<arch>.tar.gz`（供 scp 到远端解压验证）；
- staging 实现六个目标：`darwin-x64/arm64`、`linux-x64/arm64`、`win32-x64/arm64`；POSIX
  产出 `tar.gz`，Windows 产出 `zip` 和 `zcode.cmd`。Windows 不打包 `bfs`，使用 `rg.exe`、
  `ugrep.exe`，并保留系统/Git Bash fallback。
- Agent bundle 的外置依赖以运行时入口扫描和官方插件定义为事实源；不再只扫描 Server CLI/Core，
  因而 `@zcode/tui`、`playwright-core` 等 bundle 运行时依赖不会被遗漏。
- `runtime/tools` 由 `scripts/prepare-native-search-tools.mjs` 按目标 release plan 准备到
  `node_modules/.cache/zcode-server-cli/tools/<target>`（内网依赖源已配置时下载，未配置时解包仓库归档），
  不复用 mock-cdn 或 bundled-tools 目录（远端 macOS 固定为 rg13）；每个工具目录同时携带
  `THIRD-PARTY-NOTICES.txt` 与 `SOURCES.json`。运行时通过
  `ZCODE_SERVER_RUNTIME_ROOT` 解析；`runtime/packages` 包含当前官方插件定义中需要 seed 的七个
  plugin（browser-use、document-skills、skill-creator、zcode-guide、android-emulator、
  ios-simulator、restore-legacy-sessions）。
- 内置技能包不变量：`stageRelease` 从独立的 `bundledSkillsDir` 参数发布
  `runtime/packages/bundled-skills`（生产入口传入 `apps/zcode-cli/packages/bundled-skills`），
  只复制 `README.md` 与 `skills/`，排除其他顶层文件。Agent 在
  `zcode.cjs` 旁按官方插件同款候选目录原地读取它，`/workflow` 依赖的 `dynamic-workflows` 技能
  只在这里。它只属于 `agent-runtime` 组件并参与其内容哈希与归档，不写入 manifest 的 `plugins`。
  官方插件目录不提供也不覆盖技能包，发布不依赖插件缓存中是否存在同名目录。
  `stageRelease` 按 Agent 的必需文件清单 fail-closed 校验，缺任一文件时 staging 失败。
- 官方插件 MCP runtime 不变量：凡 `plugin.json` 的 `mcpServers` 通过 `${ZCODE_PLUGIN_ROOT}/...`
  引用的文件（当前为 android-emulator、ios-simulator、browser-use 的 `dist/mcp/server.js`）必须随
  archive 一起发布。这些 dist 不入库，由 `scripts/build-desktop-agent-cli.mjs` 的 MCP runtime 清单在
  staging 前构建；`stageRelease` 以 plugin.json 声明为事实源 fail-closed 校验，manifest 缺失或入口
  文件不存在时 staging 失败，不产出只含 skills、缺 MCP 入口的残缺插件。

Agent 接线约定：发行包内 Core 不在 monorepo、也没有 Electron runtime。Supervisor 每次启动 Core
时必须根据该 Core 所属 release 的 `runtime/` 重新计算接线（`runtime/node zcode.cjs app-server
--stdio`），不得由旧 `server-cli.js` 把自动推导结果永久写入全局 `process.env`。显式配置的
`ZCODE_AGENT_SERVER_COMMAND` 仍永远优先；开发态没有 release runtime 时不注入。

Agent 版本身份：Core 启动时把自身编译期版本 `ZCODE_VERSION` 写入 `ZCODE_APP_VERSION`，覆盖继承值；
Core 拉起的 Agent 继承该 env，模型请求的 `User-Agent` / `X-ZCode-App-Version` 和遥测
productVersion 报告 App 版本，而不是 CLI 包版本。注入点只能在 Core：升级时旧 Supervisor 会拉起
新 release 的 Core，Supervisor 与 SSH/WSL/Docker exec 的版本都不代表该 Core。

安装后的程序和数据分离：

```text
~/.zcode/server/
├── releases/<version>-<target>-<sha12>/   # 更新成功后只保留 current 与上一个 release
│   ├── runtime/
│   ├── bin/
│   └── manifest.json
├── current.json
├── pending.json
├── downgrade.json                 # 显式降级标记 { releaseId, fromVersion }；仅在 releaseId 等于 current.json 时有效
├── bin/zcode                       # Windows 为 zcode.cmd；OS service 稳定入口
├── service/<root-hash>.<platform>  # 运行时按 canonical root 生成，显式携带 --server-root
├── cache/components/<target>/<component>/<sha256>/
├── config/provider/zcode-builtin-<sha256>.json   # Core 启动时按内容 hash 物化的 ZCode Built-in Provider Config（2026-09-07 起）
└── run/
    ├── server.lock
    ├── update.lock                  # 跨 Supervisor handoff 的 CLI update/uninstall/restart 单 owner
    ├── status.json
    ├── ingress-token                # R3：0600，每次 daemon 启动轮换
    └── control.sock / named pipe
```

`config/provider/zcode-builtin-<sha256>.json` 由 Core（`server-core/core.ts`）在启动时从构建期 define
`__ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__` 物化（tmp + rename；同 hash 幂等，内容不一致则启动失败），
`ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 显式指定时跳过物化。它落在 server root 而不是 release 自带的
`runtime/`：release 目录不可变，同一 releaseId 重装时会重算整棵树的内容哈希，多出的物化文件会让该目录
被判为损坏副本并在重装时整体替换；文件名含内容 hash，跨 release 共用安全。当前 `zcode uninstall` 的
allowlist 不含 `config/`，卸载后该目录会保留并列入 `uninstalled.json.preservedPaths`。

descriptor 不随 release archive 打包，而是在 `serve --daemon` 注册时由
`platform/serviceManager.ts` 动态写入 `service/`。显式传入非标准 `--server-root` 时，Server CLI
将该目录同时作为 `dataBaseDir`，因此 Agent/SQLite 等本地状态位于该 root 的 `.zcode/` 隔离目录；
卸载仍只删除 ZCode allowlist，未知文件会保留并列入 `uninstalled.json.preservedPaths`。

`current.json` 和 `pending.json` 只通过临时文件加 rename 更新。release 目录按 archive SHA 内容寻址
且不可变：安装器只能把完整临时目录原子 promote 到尚不存在的 `releases/<releaseId>`；目标已存在
时校验 archive identity 与 runtime manifest 后复用，身份不一致必须失败，禁止为了发布另一份内容删除、
覆盖或 rename 走一个可能正被 Core 使用的 release 目录。唯一例外是同身份损坏副本的修复，见下文。
组件缓存命中时只下载变化组件并组装新的 release，最后仍只切换一次 `current.json`。任何启动失败都
恢复旧 pointer，临时目录和半成品缓存会被清理。

完整 archive 安装与组件增量组装必须复用同一个 immutable promote 语义：`incoming` 只能 rename 到
不存在的目标；目标已存在时按该目录自己的 `.release-integrity.json` 判定三种结论（2026-10-24，A2）：

| 已存在目标                                                                        | 结论     | 处理                                                                                                                                |
| --------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 完整性记录的 archive SHA、内容 hash、target、version 与本次一致，整树 hash 也一致 | 复用     | 不移动、不覆盖（inode 不变）                                                                                                        |
| 完整性记录与本次一致，但整树 hash、`manifest.json` 或读取结果偏离记录             | 损坏副本 | 先 rename 到同目录 `.damaged-<releaseId>-<pid>-<uuid>`，再 rename 已校验的 incoming；第二步失败则移回并报告原错误；最后清理隔离目录 |
| 完整性记录缺失、无法解析，或指向别的身份（含 umask 造成的 mode 差异）             | 冲突     | 失败，目录保持原样                                                                                                                  |

损坏副本的判定依据是：目录自己的记录与本次已校验 archive 的身份相同，说明它本应与 incoming 逐字节
一致；替换后的内容正是记录描述的内容，不是“发布另一份内容”。所有 promote 调用方都持有
`run/update.lock`，同一 server root 不会并发修复。POSIX 上已打开文件的进程不受目录 rename 影响；
Windows 上目录被占用时 rename 报错，结果仍是失败。rename 后发现目标已被并发发布者创建（race 分支）时
只允许复用，不做修复。无论复用、修复还是失败，未 promote 的 `incoming` 都必须清理。禁止为了发布新
内容把既有目标移动到 backup；该目标可能已在另一个并发 update 完成后成为活动 release。

两次 rename 之间没有跨平台的目录原子交换，修复能保证的不变量是“任何中断后，同一 archive 再次重装都能
恢复”，而不是“失败后旧目录一定在原位”。第二步失败且移回也失败时（如 Windows 杀毒或句柄占用），
`releases/<releaseId>` 缺失、`current.json` 仍指向它，损坏副本保留在 `.damaged-*`：错误必须同时带出
两步的原因和隔离路径，不能吞掉移回失败、只报第二步错误。进程在两步之间退出也落到同一状态；再次重装时
目标不存在，走普通 promote 恢复。

修复只能由同一 archive 的安装触发（Desktop「重新安装远端服务」，见
[远程设备体验规格](remote-device-connection-ux-spec.md#重新安装远端服务rdri-012026-10-24)）；运行中不做完整性校验，
probe 也不读 release 内容。修复逻辑随 archive 内的 bootstrap CLI 生效，只能修复该版本及以后版本的损坏副本；
更早版本的损坏副本由升级到不同版本恢复（新 releaseId 不与旧目录冲突）。

**旧 release 回收（2026-11-03）**：每次换代都会新增一个完整 release（解压后约 300MB 以上），此前从不回收，
远端磁盘随版本线性增长。`zcode update` 成功后，`releases/` 只保留两个 release：`current.json` 指向的
release，以及本次被替换的上一个 release（失败回滚与「将远端切换到旧版本」的复用目标）；`pending.json`
仍引用的目录同样保留。

- 时机：只在 `zcode update` 持有 `run/update.lock`，`current.json` 已切换，并且 daemon handoff 已收敛
  （daemon 离线时为指针已切换）之后执行。running-task guard、安装失败、handoff 回滚、首装和重装同一
  release（未换代）都不回收。
- 范围：只处理 `releases/` 下的非隐藏目录。`.incoming-*`、`.damaged-*` 和未知文件不动。任一保留项无法
  解析为 `releases/` 的直接子目录时，跳过整次回收。
- 删除：先把目录 rename 为同目录的 `.pruning-<releaseId>-<uuid>`，再递归删除。中断时只留下隐藏目录，
  不会留下与 releaseId 同名的半目录，因此不会让之后重装同一 release 误判为冲突。下次回收一并删除残留的
  `.pruning-*`。
- 失败：回收是收尾动作。单项失败（如 Windows 目录被占用）只写 warn 日志，update 仍返回成功。

```text
update.lock ─ install ─ 切换 current ─ handoff 收敛 ─┬─ 失败/回滚/未换代 → 不回收
                                                     └─ 成功换代 → 保留 {current, previous, pending}
                                                                   其余 releases/<id> → rename .pruning-* → rm
```

更新回滚必须先收口未就绪的新 Core，再恢复旧 pointer 并启动旧 release；超时但仍存活的 Core
不得与回滚后的旧 Core 并存：

```text
apply pending
    │
    ▼
new Core ── ready ───────────────────────────────> commit
    │
    ├─ spawn error + close（无 exit）─┐
    └─ timeout / fatal / exit ────────┴─> stop if alive ─> restore current ─> old Core ready
```

`fork()` 的 `error`、`exit` 与 `close` 必须收敛到同一个、最多执行一次的 Core 终态入口。spawn error
也是可回滚的启动失败，必须被 Supervisor 消费并进入 crash budget，不能成为未处理事件让 Supervisor
崩溃；运行中 ChildProcess 的 `error` 本身不等价于进程已经退出。停止流程只有观察到 `exit`/`close`
才能释放 data-root lock；SIGKILL 后仍未收口则进入 `stop-failed`，保留 Core 引用和锁，禁止启动替代 Core。

停止预算由 `contracts.ts` 的常量统一定义：Core 优雅退出宽限 5 秒，SIGKILL 后最多再等 10 秒终态。
SIGKILL 只能被不可中断等待推迟；Rosetta 转译叠加 swap 的远端按事故时序推算回收约需 3.5～5.4 秒，旧的 2 秒
预算会把“慢但必然结束”的退出误判为 `stop-failed`。所有等待 Supervisor 停止的调用方（update
handoff、旧 identity service 迁移、卸载）共用由宽限 + 强杀等待 + control socket 关闭推导出的 20 秒
上限，不得各自写死比 Supervisor 停止流程更短的时间；`apply-update` 客户端超时同样按三次停止和两次
ready 等待推导。`serve --daemon`（含 `restart` 的启动段）等待新 Supervisor 报告 ready 的上限由 Core ready
预算 15 秒加 10 秒 Supervisor 冷启动余量（进程拉起、模块加载、取锁、启动恢复、control 监听）推导为
25 秒，不得短于 Supervisor 自身的 ready 预算；否则机器繁忙时 CLI 会先报超时，daemon 随后照常 ready。
复用现有 Supervisor 时，`serve --daemon` 只在它已 ready 时立即返回；处于 `starting` 时按同一上限轮询
control 实时状态，等到 ready 才以带端口的状态成功返回，超时则失败。不得以 exit 0 返回 `starting`、
`port:null`，也不能用 status.json 判断：它可能是旧 Supervisor 留下的 ready 快照。
control 报告 ready 或 `starting` 的 Supervisor 一律复用，不论它是 OS service 还是 detached fallback，
也不论服务管理器当前是否可用；运行中有任务时同样复用，不报错（2026-10-23）。唯一例外是服务管理器可访问、
同 root 仍有旧 identity service 注册：无运行任务时先停止现有 Supervisor，再注册 root-scoped identity；
有运行任务时返回错误。旧的“空闲 fallback 停止后迁移到 OS service”已删除：fallback 现在可能是 systemd
装载失败的正常结果，迁移只会在每次重连时停掉 fallback、再次注册失败并重新拉起；有运行任务时还会阻断连接。
detached fallback 的 Supervisor 由 CLI fork，CLI 是它唯一的 owner：等待失败时必须先强杀该 child 并等到
`exit`，再报告失败，保证“失败”即“本次拉起的 Supervisor 已不在运行”（Core 经 IPC 断连自行收口，残留锁按
stale 由下一任接管）；否则晚到的 Supervisor 会与 update 回滚等后续启动争锁。OS service 模式由服务管理器
持有 Supervisor，CLI 不越权停止。

`serve --daemon` 失败时必须带出 Supervisor 已知的启动失败事实（2026-10-22，3.16.2 远端超时工单只有
`Timed out waiting for Server ready`，远端也查不到 Core 为什么起不来）：

- Core 退出时，Supervisor 把该 Core 先前发来的 `fatal` 摘要拼在退出码之后写入 `lastExitReason`
  （`core exited code=1 signal=none: <fatal>`，截断到 500 字符），不能用退出码覆盖 `fatal`。
- 等待失败（ready 超时、fallback Supervisor 早退、复用 `starting` 超时）时，若本次启动写过的状态
  （status.json 的 `updatedAt` 晚于启动前基线，或复用时 control 的实时状态）存在，错误在原句后追加
  `(state=<state>, last exit: <lastExitReason>)`。启动前的旧快照不能冒充本次原因。
- 本次启动没有写过状态（上一条无详情可追加）时，按顺序追加 CLI 已掌握的下列事实，彼此以 `; ` 分隔、整体放在
  原句后的括号内；每项只来自本次启动或实时状态，查不到的项省略，三项都没有时保留原文案（2026-11-03，
  ZCT-2117253090228297728 与 ZCT-2117275161536565248：A 组每次只有 `Timed out waiting for Server ready`，C 组只有
  `exited before ready (code=1)`，真正的原因在远端，且远端材料拿不到）：
  1. `running supervisor: state=<state>[, last exit: <lastExitReason>]`：开始时 control 报告了现有 Supervisor，
     本次却没有复用它（例如 `crash-loop-stopped`，见 R3-ISSUE-031）。这是 control 的实时状态，不是旧快照。
  2. `supervisor: <message>`：Supervisor 在写出第一份状态之前失败（读取 current、安装归属检查、取 data-root 锁）时，
     先把错误摘要写入 `run/supervisor-startup-failure.json`（`{pid, version, at, message}`，`message` 截断到
     300 字符）再退出；CLI 只采用 `at` 不早于本次 `serve --daemon` 开始时刻的记录。失败的实例不持有锁，
     不能写 `status.json`，所以使用独立文件；该文件只用于诊断，任何状态判断都不读它，写入失败不改变退出码。
     fallback 方式拉起的 Supervisor 仍以 `stdio: ignore` 启动：把它的输出接到 CLI 的管道上，CLI 退出后常驻进程
     下一次写日志会遇到 EPIPE 而退出。
  3. `service: <状态>`：仅 OS service 模式，等待失败后查询一次，2 秒超时，查询失败不追加。systemd 为
     `systemctl --user show <unit> --property=ActiveState,SubState,Result,ExecMainStatus,NRestarts` 的结果
     （例如 `ActiveState=failed SubState=failed Result=exit-code ExecMainStatus=1 NRestarts=5`），可区分无法执行、
     被信号或 OOM 结束、重启次数耗尽和进程仍在但不响应；launchd 为 `launchctl list <label>` 中的 `PID` 与
     `LastExitStatus`。不读 journal：用户服务的 journal 在不少系统上当前用户无权读取，内容也更难脱敏。
- 只增加错误详情：错误首句、等待预算、退出码、重试与回收行为都不变。
- 错误类别不随详情改变：CLI 的 `--json` 结果按原首句带公开码（超时为 `remote-connection-timeout`，早退为
  `remote-connection-unknown`，与追加详情前 Desktop 按文本的判定一致），Desktop `ensureDaemon` 优先使用该码。
  否则详情里的 `permission denied`、`ECONNREFUSED` 等文本会让连接错误改报其他类别。

```text
Core ── fatal ──> Supervisor.lastExitReason = <fatal>
Core ── exit ───> 旧：lastExitReason = "core exited code=1 signal=none"（fatal 被覆盖）
                  新：lastExitReason = "core exited code=1 signal=none: <fatal>"
CLI 等待失败 ──> 旧："Timed out waiting for Server ready"
                新："Timed out waiting for Server ready (state=crashed, last exit: core exited …: <fatal>)"

本次未写状态 ──> 新："Timed out waiting for Server ready (running supervisor: state=crash-loop-stopped, last exit: …)"
                    "ZCode Server daemon exited before ready (code=1 signal=none) (supervisor: Another ZCode Server
                     instance is already running)"
                    "Timed out waiting for Server ready (supervisor: …; service: ActiveState=failed … NRestarts=5)"
```

`stop-failed` 时 Supervisor 保留锁和 control socket，直到收到下一次 `stop`。迟到的 `exit`/`close`
只清除 Core 引用（status `pid:null`），不会自动释放锁。`serve --daemon` 发现现有 Supervisor 处于
`stop-failed` 且 `pid:null`（已无存活 Core）时，先向它发送 `stop` 并等待 stopped 与锁释放，再走正常
启动；遗留的更新事务仍由新 Supervisor 的启动恢复按既有规则处理。`pid` 仍存在时不得发送替代停止或
绕过锁启动新实例。

```text
Supervisor ── shutdown ──> Core
    │ 5s 内未退出
    ├── SIGKILL ──> Core ── ≤10s exit/close ──> 继续 stop / update
    └── 10s 仍无终态 ──> stop-failed（保留 Core 引用、锁、control）
                             └── 迟到 exit ──> pid:null，仍 stop-failed
serve --daemon ── status ──> stop-failed + pid:null ── stop ──> stopped + 释放锁 ──> 正常启动
                          └> stop-failed + pid≠null ──────────────────────────────> 沿用锁冲突失败
```

Supervisor 的 `stop`、`apply-update`、`confirm-uninstall` 共用一个生命周期 operation gate。
同类幂等 stop 可复用当前 Promise；其他并发写操作立即返回 retryable `operation-in-progress`，不排队。
Core IPC listener 必须绑定具体 child 与 generation，非当前 child 的消息全部丢弃；Core 终止或换代时
清空 host、port、startedAt 与 runningTaskCount，不能让已中断任务继续污染下一代 guard。

`serve --daemon` 的启动 owner 只有 OS service。descriptor 的命令必须指向 data root 下的稳定入口
`<serverRoot>/bin/zcode`（Windows 为 `zcode.cmd`），参数固定包含 `serve --supervisor --service-entry
--server-root <absolute-path>`；不得记录注册时 release 的 `server-cli.js` 绝对路径。CLI 注册并启动
service 后等待现有 Supervisor 报告 ready；service entry 不能再次注册自身或 fork 第二个 Supervisor。
只有 OS service entry 才报告 `serviceRegistered=true`；detached fallback（显式跳过 service
registration、服务管理器不可访问、systemd 装载阶段失败）必须报告 false。systemd 注册依次执行
`systemctl --user daemon-reload`、`enable <descriptor 路径>`、`start <unit 名>`，前两步是装载阶段，第三步
是启动阶段。注册错误带上失败阶段；launchd 与 Task Scheduler 的错误不带阶段。装载阶段失败时本次没有启动
任何 unit：保留 descriptor，不停止或禁用 unit，改用 detached fallback；成功输出附带可选字段
`serviceFallbackReason`（注册失败的原始错误），非 `--json` 模式向 stderr 写一行提示，原因不写入
`status.json`。启动阶段失败或错误不带阶段时，保留 descriptor 并返回可诊断错误，不回退。任何情况都不能
把 fallback 伪装成注册成功。update 可以先由当前 Supervisor 验证候选 Core ready，但更新命令只有在旧 Supervisor
退出、目标 release 的新 Supervisor 与 Core 都 ready，并完成 runtime identity 校验后才能返回成功。
handoff 由独立的目标版本 CLI 协调，不在持有 data-root lock/control socket 的 Supervisor 进程内自举；
OS service 与 detached fallback 都必须经过同一收敛门。`stop` 请求导致的正常退出不得被 launchd 自动
重启，但 update handoff 会由协调 CLI 显式从目标 immutable release 重新执行 `serve --daemon`。

OS service identity 必须按 canonical server root 隔离，使用稳定 root hash 派生 launchd Label、systemd
unit name、Windows task name 和 descriptor 文件名。兼容清理旧固定 service id 时，只有旧 descriptor
中的 canonical `--server-root` 与当前 root 相同才允许卸载，禁止误删另一个 root 的服务。

`--server-root` 是 service/fallback daemon 使用的内部全局参数，值必须是绝对路径。CLI 的 control
endpoint、status、release、service descriptor 和 uninstall 均从该参数解析同一个 layout；Core/Agent
同时获得对应的 `ZCODE_DATA_BASE_DIR`。因此自定义 data root 的 daemon 不得在默认 root 创建第二份
status、lock、Core 或 SQLite。

POSIX 稳定入口 `bin/zcode` 读取 `current.json.releaseDir`，只执行 `<root>/releases/` 下的 release；
越界时输出 `Invalid current ZCode Server release` 并以 1 退出。该边界必须和写入方比较同一种路径：
生命周期命令写 `current.json` 前已把 server root 收敛为 canonical（`realpath`）路径，launcher 也必须
用物理路径（`cd -P` + `pwd -P`）计算 root。远端以 `"$HOME/.zcode/server/bin/zcode"` 调用入口，
`$HOME` 可能经过符号链接（例如 NAS 的 `/var/services/homes -> /volume1/homes`、`/home -> /var/home`），
这种别名不得让合法 release 被判为越界。

组件增量组装先从旧 release 复制，再删除所有已变化或已移除组件声明的旧路径，之后解压新组件并
校验新 manifest；这样新 manifest 移除插件/工具等组件时不会把旧文件带入新 release。

R2 至少准备以下平台资产：

- `darwin-x64`、`darwin-arm64`；
- `linux-x64`、`linux-arm64`；
- `win32-x64`、`win32-arm64`。

## 8. CLI 命令语义

```bash
zcode                  # 无参数仍进入 TUI
zcode serve            # 前台 Server Core
zcode serve --daemon   # 注册并启动 daemon
zcode status
zcode stop
zcode stop --wait
zcode restart
zcode update
zcode update --force
zcode uninstall
```

| 命令                                               | 行为                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `serve`                                            | 由当前 CLI 进程运行 Supervisor/Core；不注册 OS 自启动；终止信号后有界退出                                                                                                                                                                                                                                                                                                           |
| `serve --daemon`                                   | 安装/复用当前用户的服务注册，并启动或复用 Supervisor/Core                                                                                                                                                                                                                                                                                                                           |
| `status`                                           | 返回注册状态、Core 状态、PID、端口、版本、最近退出原因和 crash budget                                                                                                                                                                                                                                                                                                               |
| `stop`                                             | 请求 Supervisor 停止 Core 并退出；保留自启动注册。默认收到 ack 即返回；`--wait` 见下文                                                                                                                                                                                                                                                                                              |
| `restart`                                          | 由发起命令的 CLI 协调整棵进程树重启（见下文）；不检查运行 Task，不自动恢复中断 Task                                                                                                                                                                                                                                                                                                 |
| `update`                                           | 获取 catalog 中当前 target 的新 release（或使用已有 pending），校验并安装后应用；在线 daemon 必须完成 Supervisor/Core/Agent 的整棵进程树换代与 runtime identity 校验后才返回成功；catalog 与 current archive 相同返回成功的 `up-to-date`，不得继续请求 apply；未配置 catalog 且没有 pending 时返回明确的 release source 错误；有运行 Task 时默认返回可操作的 guard 错误，不中断任务 |
| `update --force`                                   | 明确允许中断运行 Task 后应用 release                                                                                                                                                                                                                                                                                                                                                |
| `update --from-archive <path> [--allow-downgrade]` | 校验并应用本地 archive；archive 版本低于 `current.json` 且未带 `--allow-downgrade` 时，删除本次 `pending.json`，以 `source-server-downgrade-unconfirmed` 失败，不切换 release；带该参数时先写 `downgrade.json` 再应用                                                                                                                                                               |
| `uninstall`                                        | 检查运行 Task（有运行 Task 时拒绝并保持原状态），要求两次输入 `DELETE`，停止并移除服务，删除允许列表内的 ZCode 数据                                                                                                                                                                                                                                                                 |

`uninstall` 允许删除：

- R2 程序 release；
- Supervisor/Core 运行记录；
- ZCode 配置、缓存、runtime 记录；
- ZCode 自有状态数据库和日志。

`uninstall` 禁止删除：

- Workspace 文件；
- Git 仓库和工作树；
- 用户 home 下的其他文件；
- 用户显式指定的外部目录；
- 任何无法通过 canonical path 和 allowlist 校验的路径。

初始化 server root 时必须写入严格 schema 的 `install.json` 所有权标记，包含 product、schema version、
canonical server root 和 installation id。`uninstall` 只有在 `realpath` 后的 root 与该标记一致时才允许
自动清理；无标记或标记不匹配时拒绝并提示手工处理。卸载只删除 `releases/`、`run/`、`cache/`、
`bin/`、`service/`、`current.json`、`pending.json`、`downgrade.json` 等 allowlist 项；`install.json` 与用户数据
一并保留，原地重装复用原 installation id。server root 内未知文件也必须保留；结果的
`preservedPaths` 包含身份标记及其他保留项。完成后在保留的 root 下写 `uninstalled.json`，含卸载时间
与版本；R2 不实现 Controller UI。

### 8.1 `stop --wait` 与整棵进程树 `restart`（2026-10-20）

桌面端设备卡的停止、重启入口只执行这两条命令，时序全部由 CLI 负责；产品合同见
[停止和重启远端服务](../issues/remote-daemon-lifecycle/01-stop-restart-remote-service.md)。

- `stop --wait`：发出 `stop` 后等待 data-root 锁释放且 status 为比基线新的 `stopped`，复用 update handoff 的停止等待和
  20 秒统一上限。daemon 未运行时立即成功；Supervisor 进入 `stop-failed` 时以公开错误码 `source-server-stop-failed` 失败。
  status 写成 `stopped` 时锁尚未释放，所以只看 status 不能判定停止完成。
  - 实现（2026-10-20）：锁缺失或 stale 即“未运行”，输出 stopped 状态（Supervisor 死前残留的 ready 快照不原样输出）；
    control 不可达时按此刻的 status 判定（与不带 `--wait` 的 `stop` 共用同一兜底）：已是 `stopped` 视为另一次停止
    正在收尾，只等锁释放；锁仍被持有却没有 status 快照（Supervisor 首次启动中）按原错误失败；等待期间出现比基线新的 `stop-failed`
    立即失败，不再等满 20 秒。这些规则在共享的停止等待函数中，update handoff 与 `serve --daemon` 的停止步骤同样适用。
- `restart`：与 update handoff 一样，由发起命令的 CLI 进程协调，不在持锁的 Supervisor 进程内自举。daemon 在运行时先按
  `stop --wait` 停止现有 Supervisor，未运行时跳过；然后以 current release 执行 `serve --daemon` 并等待 ready。
- `restart` 保持原启动方式：OS service 继续由服务管理器托管；设置了跳过服务注册环境变量的 WSL、Docker 继续走
  detached fallback，调用方必须像 `serve --daemon` 一样传入该变量。
- `restart` 能从 `crash-loop-stopped`、`stop-failed` 且 `pid:null`、Supervisor 已死但残留锁或 control socket 的状态恢复；
  新 Supervisor 重置崩溃预算。
- control 请求超时返回公开错误码 `source-server-control-unresponsive`，CLI 不强杀 Supervisor。
- 成功输出最终 ServerStatus JSON；失败沿用 `{ok:false,error,code?,retryable?}`。
- Supervisor 控制协议不再提供只重启 Core 的 `restart`；Core 单独换代只保留在 `apply-update` 内部。
  - 实现（2026-10-21）：`restart` 在发起命令的 CLI 进程内先调用共享的停止等待函数，再执行与 `serve --daemon`
    相同的启动逻辑并输出新的 ready ServerStatus；桌面端经 stable launcher 执行，该进程即 current release。
    启动方式只按调用方环境变量与服务管理器探测判定，与 `serve --daemon` 一致。control 请求带 `restart` 时按
    非法请求返回 `invalid-request`。
  - `restart` 取 `run/update.lock`（2026-10-21 确认），与 `update`、`uninstall` 以及另一次 `restart` 互斥：锁被占用时
    不等待、不停止现有服务，直接失败；输出沿用 `uninstall` 的锁冲突结果 `{ok:false,error:"A ZCode Server update is
already running"}`，不带公开错误码。锁在停止等待与启动等待 ready 期间一直持有，命令结束释放。桌面 Host 按设备的
    互斥保持不变，CLI 锁覆盖多台电脑或终端并发的场景。

```text
zcode restart（协调 CLI）
  ├─ 取 run/update.lock ── 已被 update / uninstall / restart 占用 ──> 直接失败，不停止现有服务
  ├─ status ── ready / starting / crash-loop-stopped / stop-failed+pid:null ──> stop ──> 等锁释放 + stopped
  │         └─ 未运行或 Supervisor 已死（残留锁按 stale 回收）─────────────────> 跳过停止
  │         └─ stop-failed+pid≠null ──> stop 仍未收口 ──> source-server-stop-failed，不启动新实例
  ├─ serve --daemon（current release，保持 service / fallback 方式）──> 等 ready
  └─ 输出新 ServerStatus
control 无响应 ──> source-server-control-unresponsive（不 kill）
```

## 9. 数据、状态与不变量

```text
OS Service Manager
└── Supervisor lifecycle state
    ├── release / PID / port / registration
    ├── crash budget / backoff
    └── update / uninstall operation

Server Core
└── authoritative business state
    ├── workspace / task / session
    ├── command queue / stream
    └── Agent runtime lifecycle

Workspace / Repo / User files
└── user-owned state，R2 不负责删除
```

必须保持：

- 单实例 key = 当前 OS 用户 + data root；
- stale lock 回收必须先按 ownership token 原子 claim 到隔离路径；release 只能删除仍属于自己的 token，禁止按一次陈旧的 PID 判断直接删除当前路径；
- 持锁者判活按进程身份，不只看 PID（2026-10-21）。容器、WSL 发行版或整机重启后，进程全部消失但锁文件留在磁盘上；
  PID 从小号重新分配，同样的启动顺序会让新 Supervisor 拿到锁里记录的旧 PID，只看 PID 会把残留锁判为存活，
  启动永久报 `Another ZCode Server instance is already running`。容器重启不换内核，`boot_id` 不变，所以只有开机标识不够。
  锁记录 `processIdentity`，持锁进程身份一致才算存活：

  | 锁记录                                                       | 判定                                                                                                               |
  | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
  | PID 等于本进程                                               | 本进程当前持有该 `ownerToken` → active；否则 stale（重启前同 PID 的进程留下的锁）                                  |
  | 有 `processIdentity`                                         | 读取该 PID 当前的进程身份：进程不存在、已退出未回收或身份不同 → stale；身份相同 → active；读不到身份 → 按 PID 判定 |
  | 没有 `processIdentity`（旧版本写入，或写锁的平台读不到身份） | 按 PID 判定                                                                                                        |
  | 按 PID 判定                                                  | Linux 上进程已退出未回收 → stale；否则 `kill(pid, 0)` 成功 → active；ESRCH、EPERM 等失败 → stale                   |
  - 已退出未回收的进程（僵尸）不算存活（2026-11-03，ZCT-2117275161536565248）。Docker 容器的 PID 1 常是
    `sleep infinity` 这类不回收子进程的程序：Supervisor 与 Core 非正常死亡后都成为 PID 1 名下的僵尸，
    `/proc/<pid>/stat` 仍在、starttime 不变，`kill(pid, 0)` 也成功，旧判定把僵尸当成持锁者，新 Supervisor
    每次报 `Another ZCode Server instance is already running` 并 exit 1，容器重启前设备一直连不上。僵尸已释放
    全部 fd、端口与内存，不可能再持有锁。Linux 按 `/proc/<pid>/stat` 的状态字段判定：`Z`（僵尸）、`X`（已死）
    视为进程不存在；带身份和不带身份的锁都适用。Node 主线程退出即进程结束，Supervisor 不会出现“主线程已退出、
    其余线程仍在运行”的状态。probe 仍只用 `kill -0` 判断快照中的 Core PID，遇到僵尸 Core 时多一次失败的握手，
    再按既有回退执行 `serve --daemon`，由新 Supervisor 接管锁。
  - 进程身份：Linux 为 `/proc/sys/kernel/random/boot_id` 加 `/proc/<pid>/stat` 的 starttime（内核启动以来的时钟滴答）；
    macOS 为 `LC_ALL=C TZ=UTC ps -o lstart= -p <pid>` 的启动时刻；其他平台读不到身份，按 PID 判定。
    `ps` 按调用进程的时区格式化启动时刻，必须固定 `TZ=UTC`（2026-10-22）。否则同一进程在不同时区下身份不同：
    shell 设置了 `TZ` 的 SSH 进程与 launchd 拉起的 Supervisor、或系统时区变化前后，活着的持锁者会被判为 stale 并被接管。
  - EPERM 判为 stale：锁文件 `0600`、`run/` 目录 `0700`，Supervisor 不切换用户。能读到锁说明写锁的是当前用户，
    PID 却属于其他用户，只能是 PID 被复用。其他用户真正持有的锁对当前用户不可读，走 `unreadable`，不经过 EPERM。
  - 升级兼容：旧版 Supervisor 写的锁没有身份字段，同用户存活时 `kill(pid, 0)` 成功，仍判为 active，不会被新版抢占。

- 运行中的 Supervisor 只在仍持有锁时写 `status.json`（2026-10-26，ZCT-2112854001415753728）。daemon 运行中
  server root 被删除、移动或替换后，旧 Supervisor 的锁、control socket 和 Core 写的 `ingress-token` 都随旧目录消失；
  旧实现仍按路径把 ready 与旧端口写进新 root，probe 和 `serve --daemon` 都把它当作新 root 的 daemon，随后读 token
  失败。OS service 的 unit 仍 active，`start` 不会拉起新实例，每次重连都失败。
  - 每次写 `status.json` 前读取路径上的锁。锁文件不存在，或内容不是本实例的 `ownerToken`，即判定失去 server root；
    读取出错（权限、I/O）无法判断，按仍持有处理。
  - 失去 server root 后不再写 `status.json`，停止 Core（运行中的任务随之结束），然后结束进程。不走正常 stop：
    关闭 control server 和释放锁都按路径清理，路径上的 socket 与锁可能已属于新 owner。
  - 退出码按路径上的锁区分：
    - 锁文件不存在（root 被删除、移动或替换，还没有新 owner）：退出码 1，交给服务管理器。systemd `Restart=on-failure`、
      launchd `KeepAlive.SuccessfulExit=false` 按新 root 的 `bin/zcode` 重新拉起；`bin/zcode` 不存在时由服务管理器限流。
      detached fallback 由下一次 `serve --daemon` 拉起。
    - 锁已属于其他 owner（内容不是本实例的 `ownerToken`）：退出码 0。新 owner 已在运行，服务管理器不重启本实例
      （2026-10-26）。多台主机共享 home 时，双方都把对方活着的锁判为 stale 并接管（规格不支持共享 home，见
      [Issue 04](../issues/remote-startup-failures-3-16/04-shared-home-across-hosts.md)）；以 1 退出会让两边的服务管理器
      轮流重启、互相接管，每 10～20 秒停一次 Core。以 0 退出后只剩最后启动的一方，不再自动循环。
  - 只对修复后 release 启动的 Supervisor 生效；已在运行的旧版本 Supervisor 不会自行退出。

  ```text
  root 被删除/替换、锁被接管 ─> Core 下一次 heartbeat ─> Supervisor 写快照前读锁
                                                       ├─ 仍是自己的 ──> 照常写 status.json
                                                       ├─ 锁不存在 ──> 不写；停 Core；exit 1
                                                       │     ├─ OS service：服务管理器按新 root 的 bin/zcode 重启
                                                       │     └─ detached：下一次 serve --daemon 拉起
                                                       └─ 换了 owner ─> 不写；停 Core；exit 0（新 owner 已在运行，不重启）
  ```

- Workspace 隔离使用 `workspaceKey = workspaceIdentity?.trim() || workspacePath`；
- 路径执行继续使用 `workspacePath`；
- 远程 identity 不得只使用 `workspacePath`；
- Supervisor 不创建第二份 CommandInbox 或 Task queue；
- Desktop `continuous` 不拼接 Web `replayable` 恢复消息；
- Mobile `replayable` 不绕过 gap/snapshot 恢复；
- Core 崩溃、更新和卸载都不自动恢复已中断输入；
- Main、relay 和未来 Transport 不下沉业务状态；
- 生产日志使用 `createServiceLogger`，高频 heartbeat/RPC 明细使用 debug，不记录 secret。

## 10. 实施顺序

1. 保留本文作为 R2 spec，并补充 [R2 lifecycle test plan](./r2-server-cli-and-daemon-test-plan.md)；涉及 conversation/session 的用例先更新 case catalog 和 coverage matrix。
2. 在 `packages/zcode-server-cli` 建立 CLI、IPC、runtime layout 和 contract schema，先写测试。
3. 实现单实例锁、状态文件、canonical path 和 allowlist 校验。
4. 实现 Server Core 新入口，接入 `standalone-server` 服务并提供 HTTP/WS ingress。
5. 实现 Supervisor、Core 私有 child IPC、崩溃预算和 running-task guard。
6. 实现 macOS launchd、Linux systemd --user、Windows Task Scheduler adapter。
7. 实现 Server CLI 命令路由、TUI/既有 CLI lazy delegation、`--json` 和确认流程。
8. 实现六平台 Node runtime、node-pty、native search tools 和官方 plugins 的 staging；不改 `packages/server` 的构建入口。
9. 实现 ReleaseCatalog/Downloader/Installer、组件内容寻址缓存、原子 current/pending 切换和失败回滚。
10. 完成真实 OS service manager adapter、在线下载合同测试、Windows 合同测试和 R1 Host RPC compatibility。
11. 执行 `pnpm typecheck`、`pnpm lint`、新包测试及 conversation coverage audit。

## 11. 验收用例

| Case      | 验收目标                                                                     |
| --------- | ---------------------------------------------------------------------------- |
| R2-CLI-01 | 无参数不加载 Server Core，仍进入 TUI                                         |
| R2-CLI-02 | 前台 `serve` 启动 Core、监听回环动态端口并完成 ready                         |
| R2-CLI-03 | `serve --daemon` 注册平台服务并启动 Supervisor                               |
| R2-CLI-04 | 重复启动复用当前实例，不产生第二个 Core                                      |
| R2-CLI-05 | `status`、`stop`、`restart` 状态收敛且幂等                                   |
| R2-CLI-06 | Core 崩溃按 1/2/4/8/16 秒退避，超过预算进入熔断                              |
| R2-CLI-07 | Core 崩溃后运行 Task 中断，不自动恢复                                        |
| R2-CLI-08 | 无运行 Task 时 update 原子切换 release 并完成 ready                          |
| R2-CLI-09 | 有运行 Task 时 update 默认返回 guard 错误且不中断任务，`--force` 才允许中断  |
| R2-CLI-10 | uninstall 双重 `DELETE` 确认并移除服务注册                                   |
| R2-CLI-11 | uninstall 保留 Workspace、Repo 和用户文件                                    |
| R2-CLI-12 | HTTP/WS ingress 通过 server-info、Web replayable 和 Host continuous 合同测试 |
| R2-CLI-13 | 不同 data root 互相隔离，单实例锁不误伤其他 root                             |
| R2-CLI-14 | macOS/Linux/Windows service descriptor 和 Node runtime 可启动                |
| R2-CLI-15 | Core 6 个 heartbeat 周期无消息时被 SIGKILL 并按崩溃重启，不误杀              |

## 12. 发布与回滚

R2 只在内部环境验证，不改变 Desktop 当前生产远程连接。发布前必须同时具备：

- 安装、启动、停止、重启、卸载成功；
- 单实例和 crash-loop 行为稳定；
- Node runtime 和 native dependency 在三平台矩阵通过；
- R1 Host RPC 边界通过合同测试；
- 无 Workspace/Repo/用户文件误删；
- 日志不泄露 secret；
- `pnpm typecheck` 和 `pnpm lint` 通过。

失败时只回滚当前 Server CLI release 或 Desktop 版本，不做数据库破坏性迁移，不切换或修复现有 `packages/server` 远程链路。
