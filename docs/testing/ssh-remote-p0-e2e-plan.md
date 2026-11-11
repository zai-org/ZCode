# SSH Remote P0 E2E 规格

> **2026-09-07 新一轮完整回归**：范围、材料与隔离以 [R3 合并后自动化方案](r3-remote-automation-plan.md) 为执行入口，逐项合同见 [R3A 矩阵](r3-remote-automation-case-matrix.md)。下文历史“单服务器/不含手机”剪枝不限制新方案；旧 `zcode-server.cjs` PID helper、legacy manifest 代理断言和显式 Provider 同步表述需按现行 R3/Provisioning 改造后才能复用。已有 formal/pending 状态不代表新基线运行通过。

## 定义

SSH P0 不是单个 case，而是“用户能连接、开发、对话并在常见生命周期后继续工作”的核心 case 集合。

```text
Ubuntu 24.04 + password SSH
  |
  +-- connect/auth ----> directory ----> remote workspace identity/session
  |                                         |
  |                                         +-- file tree / terminal / Git
  |                                         |
  |                                         +-- task / request / reply
  |                                         |
  |                                         +-- close / restart / disconnect / reconnect
  |
  +-- one BrowserWindow ----> one Window Host ----> one shared SSH connection
                                               +--> workspace A logical session
                                               +--> workspace B logical session
```

每个 case 必须有自己的 setup、action 和 assertion；不能因为长链路经过某个状态，就宣称该状态已覆盖。

## 用户确认与环境边界

2026-08-10 用户确认第一阶段只使用一台现有服务器：Ubuntu 24.04、root、password SSH。凭据由运行环境注入，文档、spec、fixture、artifact 和错误消息不得保存密码。

| 维度               | 第一阶段包含                                                                            | 第一阶段剪枝                                                |
| ------------------ | --------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| target             | 单台 Ubuntu 24.04 SSH server                                                            | 多服务器、同路径不同 host identity                          |
| auth               | password                                                                                | SSH config alias、private key、passphrase、agent forwarding |
| workspace          | 同 target 下多个绝对路径                                                                | 其它 SSH target、3 个以上 workspace 的规模组合              |
| client             | Desktop `desktop-continuous`                                                            | 手机 `web-remote-replayable`、Bot、跨窗口                   |
| user capability    | connect、directory、file、terminal、Git、task、restart/reconnect                        | tool/MCP、附件、queue、stop、permission、Goal、compact      |
| internal lifecycle | App 冷启动自动重连、SSH Source 断线和手动重试、OS service/detached 两种 daemon 启动能力 | renderer reload；由独立 `R1-RELOAD-01` 覆盖                 |

## P0 Case 集合

### A. 连接与认证

| Case ID        | Setup                                                                                        | Action                                                                                                            | Assertions                                                                                                                                                                                                                | 状态                                                                                                                                  |
| -------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| SSH-P0-CONN-01 | 本地 E2E workspace ready；目标服务器可达                                                     | 从 composer workspace 菜单打开 SSH 向导，使用 password 连接并选择远端目录                                         | 部署/握手/目录 RPC 成功；tab 的 path、`workspaceIdentity`、`remoteSessionId` 正确；只有一个 Window Host；tab/store/log 不保存 secret                                                                                      | formal                                                                                                                                |
| SSH-P0-CONN-02 | 目标服务器可达                                                                               | 使用错误 password 连接，看到失败后改用正确 password 重试                                                          | 错误可见且不含 secret；失败不提交 workspace tab，不留下可用 logical session/Agent；重试后连接成功                                                                                                                         | formal                                                                                                                                |
| SSH-P0-CONN-03 | 目标服务器可达；本地测试代理对首个 TCP connection 保持 pending、后续 connection 透传真实 SSH | 使用旧 password 发起连接，在 pending 阶段点击“取消连接”；随后对同一 host/port/username 使用正确 password 立即重试 | 首连接关闭且无 logical session/远端写入；重试使用新 request/credential 进入目录选择并打开 workspace；Host PID 不变；不影响 WSL/Docker/Server 取消语义                                                                     | pending (`packages/desktop/test/e2e/conversation-session/remote/connection/manual-review/pending/conversation-session-ssh-remote-cancel-retry.test.ts`) |
| SSH-P0-CONN-04 | 目标服务器可达；设置页配置本地 HTTP 代理；远程资源测试 CDN 只允许经该代理返回                | 选择“本地下载后上传”并连接 SSH workspace                                                                          | proxy 捕获首装必发的 Source Server descriptor 请求；fake CDN 域名无法直连；部署/握手和 workspace 打开成功；Host PID 不变。Source Server archive 的同端口路由由 `sourceServerReleaseResolver.test.ts` 强制 cache miss 覆盖 | pending (`packages/desktop/test/e2e/conversation-session/remote/connection/conversation-session-ssh-remote-local-download-proxy.test.ts`)               |
| SSH-P0-CONN-05 | Ubuntu/minimal/container SSH target 无可访问 user service manager                            | 使用 password 连接、确认安装并打开 workspace                                                                      | 自动 detached fallback；daemon ready、`serviceRegistered=false`；Desktop 断开不主动停止 daemon；远端环境重启后重连会重新拉起；错误/日志不把 Node warning 当根因                                                           | pending                                                                                                                               |
| SSH-P0-CONN-08 | 本地含损坏的同步凭据，SSH target 可达                                                        | 连接失败后恢复凭据，保留失效默认模型并重试                                                                        | 首次错误和连接日志含安全 source-read-failed；不含凭据；无脏 tab；重试成功且默认偏好未改写                                                                                                                                 | pending（packages/desktop/test/e2e/conversation-session/remote/installation/conversation-session-ssh-provisioning-failure.test.ts）                       |

### B. 远端开发基础能力

测试数据只放在由 case 创建的 `/root/.zcode-e2e/ssh-p0-*` 隔离目录；setup/cleanup 通过测试控制连接完成，不修改隔离目录外的用户文件。

| Case ID       | Setup                                        | Action                                                               | Assertions                                                                                   | 状态   |
| ------------- | -------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------ |
| SSH-P0-DEV-01 | 远端隔离目录含唯一 marker 文件               | 连接该目录，展开 file tree 并打开文件；Terminal 新增文件后刷新文件树 | 列表和预览来自远端；新文件可见；本地同路径不参与；path 执行语义正确                          | formal |
| SSH-P0-DEV-02 | 已连接远端隔离 workspace                     | 打开 Terminal，执行 `pwd`、Ubuntu/system marker 和文件写入命令       | 输出来自远端 Ubuntu；cwd 等于 remote `workspacePath`；写入只落远端；控制连接复核远端文件     | formal |
| SSH-P0-DEV-03 | 远端隔离目录是带 baseline commit 的 Git repo | 修改远端文件并打开 Git pane/status                                   | Git pane 显示远端 repo 的 tracked/untracked 变化；控制连接复核修改 marker；不创建测试 commit | formal |

### C. Task、请求与多 Workspace

| Case ID        | Setup                                                                                                | Action                                                | Assertions                                                                                                                                                                                                                                | 状态                                                                                                                               |
| -------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| SSH-P0-TASK-01 | case-local provider replay 通过测试专用 SSH reverse tunnel 对远端 Agent 可达；同 target 两个目录存在 | workspace A/B 各自新建 task 并首发；依次切回 A/B 续发 | task row 在正确 workspace；running→idle 无 error；四个请求和回复可见；A2 只带 A 历史、B2 只带 B 历史；identity/session 独立；Window Host PID 不变；连接后 Host 日志无 `highspeed-card` / `off-peak-task` 未知频道超时（两者只在本地生效） | formal                                                                                                                             |
| SSH-P0-TASK-02 | A/B 已连接且各有已完成 task                                                                          | 关闭 workspace A，再切回 B 继续发送；随后重新打开 A   | A 关闭只释放自己的 attachment/session；B task、请求、回复继续工作；重新打开 A 复用共享 Host 且不覆盖 B                                                                                                                                    | pending (`packages/desktop/test/e2e/conversation-session/remote/execution/conversation-session-ssh-remote-task-lifecycle.test.ts`)                  |
| SSH-P0-TASK-03 | A 已连接且有已完成 task；case-local replay 的续发响应延迟 15s                                        | 续发进入 streaming 后打开并关闭设置页；等待任务完成   | 续发期间侧栏 task 行转圈；设置页开关不新建第二条 sessions-index 订阅（同 attachment 同 topic 会被 CLI 静默替换）；任务完成后侧栏 running 消失、与聊天区一致                                                                               | pending (`packages/desktop/test/e2e/conversation-session/remote/configuration/conversation-session-ssh-remote-settings-overlay-sidebar-status.test.ts`) |

### D. 持久化、断线与恢复

| Case ID        | Setup                                                                                                     | Action                                                                                                 | Assertions                                                                                                                                                                           | 状态                                                                                                                                       |
| -------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| SSH-P0-LIFE-01 | A/B 有历史 task；默认 Profile 凭据可静默取得；Server 最近 7 天连接过；显式断开后保留工作区历史全部 failed | 完整重启 Electron/Main/Host；不点击手动重连，等待主窗口 Host 在 10 秒单节点预算内自动重连并继续原 task | 稳定 Source/identity/path 无 secret；failed 历史不阻断 A/B 自动获得新 `remoteSessionId`；恢复 task/history；续发命中原 task；不重复 workspace/daemon；启动阶段每个 Server 只尝试一次 | pending (`packages/desktop/test/e2e/conversation-session/remote/connection/manual-review/pending/conversation-session-ssh-remote-cold-reconnect.test.ts`)    |
| SSH-P0-LIFE-02 | A/B 共享同一 SSH Host 且在线                                                                              | 只终止本 case 启动的远端 `zcode-server`，不操作 `sshd`；随后对 A 点击重连                              | A/B 同时 disconnected，本地 workspace 不受影响；只建立一次新 SSH Host；A/B 分别获得新 `remoteSessionId` 并恢复；task/file 路由不串                                                   | pending (`packages/desktop/test/e2e/conversation-session/remote/connection/conversation-session-ssh-remote-server-fault.test.ts`)                            |
| SSH-P0-LIFE-04 | 远端目录 `link → real` 为 symlink；用 `link` 建项目并有历史 task                                          | 设置页断开设备后从项目菜单“连接”；再完整重启 App 等待自动挂回                                          | 两次挂回都 bind `link`，identity 仍为 `remote:server:<id>:link`，获得新 `remoteSessionId`；不出现 `real` 路径 tab；原 task 历史可打开                                                | pending (`packages/desktop/test/e2e/conversation-session/remote/connection/manual-review/pending/conversation-session-ssh-remote-symlink-reconnect.test.ts`) |

## 共享不变量

| 不变量                                  | P0 证明                                                                                                  |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 每个 BrowserWindow 只有一个 Host        | 所有 case 前后 Process Monitor 只存在同一个 Window Host PID；App 冷启动除外，冷启动后只能有一个新 Host   |
| 同 target workspace 共用 SSH connection | A/B 不重复部署/握手；远端只有一个对应 `zcode-server`；logical session 独立                               |
| identity 与 path 不混用                 | 隔离/key 使用 `workspaceIdentity?.trim() \|\| workspacePath`；file/git/terminal cwd 使用 `workspacePath` |
| 远端执行、本地 app-global               | file/git/terminal/Agent 来自远端；setting/credential/provider 来自本地并显式同步                         |
| desktop continuous 不扩散 replayable    | P0 不建立手机 attachment，不断言 replayable gap/snapshot                                                 |
| secret 不持久化、不进证据               | password 只来自 `ZCODE_E2E_SSH_PASSWORD`；tab、settings、fixture、capture、日志和失败文本均不包含密码    |

2026-08-19 用户确认 SSH cancel/retry 的状态剪枝：只接受“最后一个 SSH pending waiter 取消”作为新增
底层 abort 语义；共享 waiter、online SSH cache 继续使用现有契约用例；WSL、Docker、Server 保持原 transport
生命周期，不与 SSH 做笛卡尔积。SSH-P0-CONN-03 使用首连接阻塞/后续透传的同端口 TCP 代理固定 pending
窗口，避免用 sleep 或错误密码响应速度制造时序。该 case 不发送 prompt，provider request policy 为 none。

## Fixture 与运行约束

- 必需环境变量：`ZCODE_E2E_SSH_HOST`、`ZCODE_E2E_SSH_PORT`、`ZCODE_E2E_SSH_USERNAME`、`ZCODE_E2E_SSH_PASSWORD`。
- 默认 formal 全量发现只有在 `ZCODE_E2E_SSH_HOST`、`ZCODE_E2E_SSH_USERNAME`、
  `ZCODE_E2E_SSH_PASSWORD` 均存在时才纳入真实 SSH spec；端口继续允许默认 22。缺少凭据
  时默认套件应排除这些环境型 case，不能把“环境未配置”统计成产品失败。显式定向运行 SSH
  spec 仍保持 fail-closed，并报告缺少的变量，方便环境维护者验证配置。
- workspace 路径使用 `ZCODE_E2E_SSH_WORKSPACE_PATHS`；conversation 默认 `/root,/home`，开发基础能力使用 case-local `/root/.zcode-e2e/ssh-p0-*`。
- provider case 使用 case-local OpenAI-compatible replay fixture；reverse tunnel 只传递测试 provider 流量，产品 SSH 连接仍通过真实 UI 建立。
- 远端 fixture 必须带本次 run 唯一前缀并在 `finally` 清理。断线 case 只能终止由当前窗口连接启动的 `zcode-server`，禁止修改 `sshd`、系统网络或其它用户进程。
- 所有 spec 先放在 `manual-review/pending`，未经人工审阅不晋升 formal。
- `SSH-P0-CONN-04` 的代理/CDN 必须完全由 case 本地进程提供，不访问真实发布 CDN；测试目标 URL
  在直连路径不可解析，只有代理 mock 能返回 manifest，以机械证明没有 silent direct fallback。

## 运行证据

- `SSH-P0-TASK-01`：2026-08-10 在 Ubuntu 24.04 上按 `/root,/tmp` 完成 formal 默认 replay（1 passing，artifact `desktop-e2e-20260810-074921-918`）与显式 case-local replay（1 passing，artifact `desktop-e2e-20260810-075053-683`）。
- `SSH-P0-TASK-01` 未知频道断言（2026-10-21，macOS arm64 Desktop → Ubuntu 24.04 真实 SSH，临时隔离用户，`/home/<user>/ws-a,ws-b`）：实现回退到修复前时失败，捕获 8 条 `highspeed-card`、4 条 `off-peak-task` 未知频道超时；修复后 2/2 passing，0 条。修复前另有 1 次运行在打开首个工作区时失败（`尚无可用 renderer attachment`），属已知问题，与本断言无关。
- `SSH-P0-CONN-01/02`：2026-08-10 在同一 Ubuntu 24.04 上完成 formal 默认 replay，1 passing，artifact `desktop-e2e-20260810-073137-368`。
- `SSH-P0-DEV-01/02/03`：2026-08-10 在 case-local `/tmp` repo 上完成 formal 默认 replay，1 passing，artifact `desktop-e2e-20260810-073248-576`。
- `SSH-P0-TASK-02`、`SSH-P0-LIFE-01/02/03` 在实际运行通过前保持 `pending`；不得用 unit/integration 证据替代真实 SSH Electron E2E 状态。
- `SSH-P0-TASK-03`（2026-09-04 新增）：来源于 3.11.1 WSL 用户反馈——远程 workspace 运行中打开设置页后侧栏永久转圈；根因与单元证据见 `docs/wsl-task-status-inconsistency.md` T3。fixture 合同检查已通过（`pnpm --filter @zcode/desktop e2e:fixture:check`），真实 SSH 运行通过前保持 `pending`。

## Lifecycle pending 实现

以下 pending spec 已按同一套 Ubuntu password SSH + reverse-tunnel replay harness 编写，尚未声称
formal/covered；必须在真实 SSH 环境完成 capture/replay 与人工审阅后再 promotion：

- `conversation-session-ssh-remote-task-lifecycle.test.ts`：关闭 A、验证 B 续发，再重新打开 A。
- `conversation-session-ssh-remote-cold-reconnect.test.ts`：`browser.reloadSession()` 冷重启后不触发任何手动重连，等待主窗口 Host 单次自动重连并恢复 A/B；交互凭据负例归 R3-REMOTE-05。
- `conversation-session-ssh-remote-symlink-reconnect.test.ts`：项目路径是 symlink 时，手动重连与冷启动自动挂回都按项目原路径 bind；对应 3.17.1 用户反馈“设备已连接、会话打不开”。
- `conversation-session-ssh-remote-server-fault.test.ts`：只终止本次连接新建且记录的 `zcode-server` PID，验证 A/B 断连和按组重连；不会调用 `sshd`、`wsl --terminate` 或 `wsl --shutdown`。
- `conversation-session-ssh-remote-cancel-retry.test.ts`：首连接保持 pending，确认停止后同 target 立即以正确 password 重试；不发送 provider 请求。

上述四条 pending spec 在 R3 下统一以握手返回的稳定
`remote:server:<sourceServerId>:<workspacePath>` 作为 controller identity。旧
`buildRemoteWorkspaceIdentity(sshTarget)` 只允许作为 Host 内部 legacy route hint，禁止作为 Renderer/E2E
期望值。测试必须先完成握手，再从权威 tab snapshot 读取并校验稳定 identity。

四个 case 的 case-local replay fixture 和 manifest 已建立，fixture check 通过；真实运行前仍需确认
provider stream、SSH server PID 归属、断连事件和重连分组行为。

## SSH 项目入口编排（2026-09-13 自 `docs/archive/remote-r3/ssh-project-entry-helper.md` 并入）

SSH 项目用例遵循[当前三屏向导](../architecture/remote-device-connection-ux-spec.md)：
无目录入口连接成功后直接选择目录；已有项目保留目录意图，连接/安装/升级完成后回到原项目。
不得等待远程 conversation ready，也不以向导关闭代替项目 ready。

```text
统一选择 / 配置 → 连接（凭据、安装或升级等待）
  → 目录选择或原项目 → 校验 workspaceIdentity / remoteSessionId
  → 选择用例指定模型与思考档位 → 首发
```

约束：

- 设备卡查找限定在可见 SSH 弹窗内；侧栏可能包含相同的 host/port，不能按全页面第一个 section 定位。
- 只处理用例授权的安装及身份确认；持续运行说明为非阻断提示，不作为确认等待，失败和其它确认应明确报告。
- `browser.execute` 的参数显式序列化传入，不能引用 Node 模块常量。
- helper 超时报告最后一次 UI 观测，不能把超时前创建的空字符串当作诊断。
- 切换到 lifecycle 自定义模型后必须显式选择思考档位（`disabled`）；产品不为新模型补默认档位，未选时发送键保持禁用。
- 测试编排不修改业务连接、命令重放、desktop continuous 或 mobile replayable 语义。

验证入口：`packages/desktop/test/sshDirectoryFlow.test.ts` 的独立浏览器上下文探针，以及
`conversation-session/manual-review/pending/conversation-session-r3-ack-loss.test.ts` 的真实 SSH 路径；helper 实现在 `packages/desktop/test/e2e/helpers/ssh-remote-p0.ts`。

### RDUX-04 向导回归

准备、动作、断言与运行证据见[会话 case 目录](../conversation-session-case-catalog.md#rdux-04-向导回归)；测试路径与 pending 状态见[覆盖矩阵](conversation-session-e2e-coverage-matrix.md#rdux-04-向导回归)。

### RDUX-10 三屏向导验收

准备、动作、断言与运行证据见[会话 case 目录](../conversation-session-case-catalog.md#rdux-10-三屏向导验收)；测试路径与 pending 状态见[覆盖矩阵](conversation-session-e2e-coverage-matrix.md#rdux-10-三屏向导验收)。

### RDUX-11 连接中与目录屏验收（accepted）

| Case       | Setup / Action / Assertions                                                                                                                                                     | 自动化                                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| RDUX-11-01 | 独立用户首装 → 阶段内安装确认显示发布版本、远端 home 下的实际安装位置和真实包大小；第一阶段无遮挡；连接后展示首次持续运行介绍，明确确认后继续；版本 3 不重复展示                | `packages/desktop/test/e2e/conversation-session/remote/navigation/conversation-session-ssh-remote-three-screen.test.ts`，Pending        |
| RDUX-11-02 | 错误密码 → 当前连接阶段内补密码 → 原目标成功；错误详情与日志可见，不回到配置表单                                                                                                | `conversation-session-ssh-remote-connection-p0.test.ts`，沿用 SSH-P0-CONN-01/02                                       |
| RDUX-11-03 | TCP 拒绝连接 → 分类原因、重试与返回配置；日志自动展开                                                                                                                           | `packages/desktop/test/e2e/conversation-session/remote/connection/conversation-session-remote-connection-log-contract.test.ts`，Pending |
| RDUX-11-04 | 目录显示完整路径与名称保存反馈；首次介绍点击「知道了」才记已读 3，第二项目及重启不重复；最近/远端 chip 导航和读取失败由向导 DOM 回归覆盖；连接/目录屏浅色深色 × 1440/900px 截图 | 三屏 pending spec + `remoteConnectionDirectoryNavigation.test.ts`                                                     |

本票沿用已确认的向导 UI / Source Server 服务 / SSH E2E 边界。桌面 continuous 与手机 replayable 不改变 owner 或恢复协议；新只读任务清单不写入远端持久化 status 格式，旧远端不支持时明确显示清单不可用。

2026-09-29 RDUX-11 最终真实 SSH 证据：`desktop-e2e-20260928171512189-p86116-9ec1bbe80ceb67aa`，上述 4 个 spec 通过，首装 4 次点击/1 次输入。安装和目录两屏包含浅色/深色 × 1440/900px 截图；Pending 状态不变。只读安装信息及任务清单的范围扩展已于同日经用户确认，父规格同步完成。

### SSH-P0-CONN-09：冒号用户名的认证边界

使用本机 Docker 目标，从向导输入测试账号加 `:tenant` 和错误密码，必须进入真实 SSH
认证失败；目录仍可读取。仅改为正确密码后，安装、目录选择、项目打开和稳定 Source 绑定
必须成功；完整用户名不改写，旧地址入口不重复保留，Host 数量不变。候选 spec：`conversation-session/remote/connection/manual-review/pending/conversation-session-ssh-remote-colon-username.test.ts`。
与既有连接 P0、双 workspace 任务 P0 同批验证，分别证明普通连接与会话隔离未回归。
