# R3 Source Server 远程主链问题台账

> **2026-09-07 更新**：合并 Provider 重构 M2（路线 A）后，R3 早期的 Provider「一键同步」、模型设置页设备选择器、`provider-sync` channel、`source-settings` scope 中的 `model-provider` 注册以及旧 `modelProviderService` 已全部删除，改为「设置页绑定本地 + Provider Provisioning 自动单向下发」。本文中涉及这些能力的条目随之作废，不逐条改写：R3-ISSUE-010 的修复记录里「模型设置先注册 `source-settings` attachment … `model-provider.*` 调用成功」属于已删除路径的历史证据；R3-ISSUE-012 引用的 `packages/services/src/model-provider/modelProviderService.ts` 与 `apiKeyCredentialKey` 逻辑已不存在，Personal Provider Config 按 Provider 重构 M2 以明文 Personal Config 持久化，该 issue 的「规格与实现冲突」以 [docs/remote/provider-provisioning.md](../remote/provider-provisioning.md) 与 [../archive/remote-r3/r3-provider-refactor-merge.md](../archive/remote-r3/r3-provider-refactor-merge.md) 为新基线重新评估。其余非 Provider 条目不受影响。

## 文档状态

- 状态：Open
- 建立日期：2026-08-28
- 审阅基线：`feat/multi-device-remote-3-real-ssh-feature@ed0fe80b1391`
- 原审阅范围：2026-08-28 当时的 `staging...HEAD`，不是当前分支的最新 diff
- 用途：记录当前分支全面审阅中发现的问题，供后续按稳定 ID 逐项修复、验证和关闭
- 当前说明：状态按单项维护；关闭项保留修复与验证摘要，未关闭项保留完整待办。文档整理不改变验证结论。
- 2026-09-13 文档整理：R3 过程文档归档到 `docs/archive/remote-r3/`，本文引用已同步；R3-ISSUE-012 因前提失效改为不修复，R3-ISSUE-019 进入修复中；当前阅读入口见 [docs/remote/README.md](../remote/README.md)
- 2026-09-13 补登：R3-ISSUE-023（恢复态手动连接成功不发 reconnect）来自同日分支审查 RV-P1-2，随修复一并关闭
- 2026-09-14 补登：R3-ISSUE-024（wsl.exe 默认 shell 提前展开命令变量，WSL 安装误报缺少 tar）来自同日 Windows 实机复现，随修复登记为待验证
- 2026-10-20 补登：R3-ISSUE-031～033 来自停止 / 重启远端服务的设计讨论，均为范围外登记

## 状态定义

| 状态     | 含义                                       |
| -------- | ------------------------------------------ |
| `待修复` | 问题已登记，尚未开始修改                   |
| `修复中` | 已有对应实现或测试工作正在进行             |
| `待验证` | 实现已完成，仍缺自动化或运行时证据         |
| `已关闭` | 根因修复、相关测试与必要运行时验证均已完成 |
| `不修复` | 经产品或架构决策接受现状，必须记录决策依据 |

严重度口径：

- `P0`：发布阻断、数据安全或主链不可用；
- `P1`：高影响功能、权限、身份隔离或生命周期错误；
- `P2`：中低影响缺陷、架构债务、验证或文档缺口。

置信度口径：

- `已确认`：静态调用链已经能够证明问题成立；
- `高风险待复现`：代码结构允许问题发生，仍需先补失败测试或运行时复现确认具体触发条件。

## 总览

| ID           | 严重度 | 领域             | 问题摘要                                                                  | 置信度       | 状态   |
| ------------ | ------ | ---------------- | ------------------------------------------------------------------------- | ------------ | ------ |
| R3-ISSUE-001 | P0     | 发布             | 正式 release validator 仍校验旧 remote assets                             | 已确认       | 待验证 |
| R3-ISSUE-002 | P1     | Desktop IPC      | Preload 丢失 workspace scope                                              | 已确认       | 已关闭 |
| R3-ISSUE-003 | P1     | Mobile 权限      | 手机 attachment 可访问 Terminal RPC                                       | 已确认       | 已关闭 |
| R3-ISSUE-004 | P1     | 生命周期         | retrying 时显式断开不能收口                                               | 已确认       | 已关闭 |
| R3-ISSUE-005 | P1     | 生命周期         | 同一 Source 的不同 Profile 可能产生两个 logical owner                     | 已确认       | 已关闭 |
| R3-ISSUE-006 | P1     | 生命周期         | 删除 Profile 后 Manager 仍可能使用旧线路重连                              | 已确认       | 已关闭 |
| R3-ISSUE-007 | P1     | 恢复             | 自动恢复遇到用户动作状态仍继续重试                                        | 已确认       | 已关闭 |
| R3-ISSUE-008 | P1     | 设置             | 启动自动重连偏好被完整 AppSettings schema 丢弃                            | 已确认       | 已关闭 |
| R3-ISSUE-009 | P1     | Mobile 恢复      | bridge 重建预算耗尽后没有明确终态                                         | 已确认       | 已关闭 |
| R3-ISSUE-010 | P2     | Source Settings  | 旧端口迟到关闭可能删除新一代服务                                          | 已确认       | 已关闭 |
| R3-ISSUE-011 | P1     | 恢复             | 多 workspace logical replacement 不是完整原子操作                         | 已确认       | 已关闭 |
| R3-ISSUE-012 | P2     | Provider 安全    | API Key 明文持久化规格与实现冲突                                          | 已确认       | 不修复 |
| R3-ISSUE-013 | P2     | 迁移             | 首次 Directory 迁移失败可能遗留孤儿凭据                                   | 已确认       | 已关闭 |
| R3-ISSUE-014 | P2     | Release Resolver | 下载缺少取消和 cache single-flight                                        | 高风险待复现 | 待修复 |
| R3-ISSUE-015 | P2     | UI 架构          | RemoteWorkspaceController 尚未成为统一写入口                              | 已确认       | 已关闭 |
| R3-ISSUE-016 | P2     | UI 投影          | RemoteWorkspaceProjection 未完全接线且会误投影本地 tab                    | 已确认       | 已关闭 |
| R3-ISSUE-017 | P2     | Mobile UI        | 手机 Source 组头状态与名称可能降级失真                                    | 高风险待复现 | 待修复 |
| R3-ISSUE-018 | P2     | 设计系统         | 新增远程 UI 存在任意尺寸和 ad-hoc alpha                                   | 已确认       | 待验证 |
| R3-ISSUE-019 | P2     | 文档             | 架构、计划、coverage 与实机记录状态漂移                                   | 已确认       | 修复中 |
| R3-ISSUE-020 | P1     | 发布证据         | 历史实机记录不能证明当前 HEAD                                             | 已确认       | 待验证 |
| R3-ISSUE-021 | P1     | 生命周期         | 握手落盘期间断连被丢弃，死连接被发布为 online                             | 已确认       | 已关闭 |
| R3-ISSUE-022 | P1     | 发布             | 远端 archive 缺 android/ios 插件 MCP runtime                              | 已确认       | 已关闭 |
| R3-ISSUE-023 | P1     | 恢复             | 恢复态手动连接成功不发 reconnect，Registry 停在 recovering                | 已确认       | 已关闭 |
| R3-ISSUE-024 | P0     | WSL Transport    | wsl.exe 非 --exec 模式让默认 shell 提前展开命令变量，WSL 安装误报缺少 tar | 已确认       | 待验证 |
| R3-ISSUE-029 | P2 | 恢复 | logical replacement 在途时不保留后续 reconnect，当前连接收口时序未触发 | 已确认（条件性） | 待修复 |
| R3-ISSUE-030 | P2 | Provider 取消 | 等待共享 Registry 刷新期间不能及时取消，当前生产调用方不传 signal | 已确认（条件性） | 待修复 |
| R3-ISSUE-031 | P2 | 恢复 | crash-loop-stopped 时 `serve --daemon` 因锁冲突失败，自动恢复无法拉起远端服务 | 已确认（静态） | 待修复 |
| R3-ISSUE-032 | P2 | 生命周期 | Supervisor 自身无响应时没有强杀兜底，停止与重启只能报错 | 已确认 | 待修复 |
| R3-ISSUE-033 | P2 | 文档 | 启动自动重连文案与 §7.1 写“最近 7 天”，代码不按 7 天过滤 | 已确认 | 待修复 |
| R3-ISSUE-034 | P1 | 恢复 | 容器 PID 1 不回收子进程时，僵尸 Supervisor 被判为持锁者，Docker 设备在容器重启前一直连不上 | 已确认 | 已关闭 |
| R3-ISSUE-035 | P2 | 诊断 | `serve --daemon` 失败时没有带出 Supervisor 写状态前的原因、现有 Supervisor 状态与系统服务状态 | 已确认 | 已关闭 |

## 问题详情


关闭项的完整定位、旧路径与逐轮记录保存在 `git show a17a875588b8d66c2bee49236292e174df651363:docs/architecture/r3-source-server-remote-open-issues.md`；以下摘要不提升原验证等级。

### R3-ISSUE-001：正式 release validator 仍校验旧 remote assets

- 严重度：P0
- 置信度：已确认
- 状态：待验证
- 现象：新构建链只生成 `source-server-release.json` 和四个 `zcode-server-*.tar.gz`，正式 `release:validate` 仍要求 `manifest-*.json` 与 `components/**`。
- 影响：干净发布目录会稳定失败；脏目录可能用旧产物通过校验，却没有验证本轮真正发布的 Source Server archive。
- 证据：
  - [`.gitlab/ci/30-build.yml`](../../.gitlab/ci/30-build.yml) 的 `build:remote:assets` 只收集 descriptor 和四个 archive；
  - [`.gitlab/ci/50-release.yml`](../../.gitlab/ci/50-release.yml) 的上传合同只包含新产物；
  - [`scripts/validate-release-artifacts.mjs`](../../scripts/validate-release-artifacts.mjs) 的 `validateRemoteAssets()` 仍只认识 legacy manifest/components；
  - `gitlabCiBuildGraph.test.ts` 与 `validateReleaseArtifacts.test.ts` 分别验证两套互斥合同，缺少端到端对接测试。
- 关闭条件：validator 严格校验 descriptor 的版本、四个 target、文件名、size、SHA-256、URL 和真实 archive；构建输出能够直接通过正式发布校验；旧残留不会影响结果。

#### 修复记录 2026-09-13

- 状态：待验证
- 修复提交：`feat/multi-device-remote-3-real-ssh-feature` 上包含本记录的提交（`fix(release): validate Source Server descriptor and archives`）
- 根因：构建/上传两端已切换到 descriptor+archive 合同，`validateRemoteAssets()` 未同步，且 `build:remote:assets` 切换时删掉了共享目录旧产物清理。复现：用真实脚本对"6 平台 + descriptor + 4 archive"目录校验抛 `missing remote manifest: manifest-darwin-arm64.json`；目录残留旧 manifest 时把 archive 改坏、甚至删掉 descriptor 都能通过。
- 修复：`validateRemoteAssets()` 改为 `validateSourceServerRelease()`，校验 descriptor 的 `schemaVersion`、版本、四个 target、`fileName`、`version`、`urls`（必须含指向 archive 的安全相对路径）、`sizeBytes`、`sha256` 与真实 archive，并 fail-closed 拒绝残留 `manifest-*.json` / `components/` 及未被引用的 `zcode-server-*.tar.gz`；`build:remote:assets` 在复制前清掉自己负责的根目录产物；`docs/desktop-ci-cd.md` validate 描述同步。
- 自动化验证：`packages/desktop/test/validateReleaseArtifacts.test.ts` 重写为新布局（含 target 常量与 `@zcode/shared` 的 `SOURCE_SERVER_RELEASE_TARGETS` 对接断言）；`gitlabCiBuildGraph.test.ts` 新增“CI 收集 target 集合 == validator 期望集合、复制前有清理”断言。
- 运行时验证：未在真实 tag / `ci*` 管道上运行，需下一次 `CI_RELEASE_BRANCH=1` 演练确认后关闭。
- 剩余风险：`scripts/upload-oss.sh` 仍保留 `manifest-*.json` 特判分支（死代码，未清理）；validator 拒绝 legacy 残留后，若 runner 共享目录被人工放入旧文件会直接阻断 validate，需清理目录后重试。

### R3-ISSUE-002：Preload 丢失 workspace scope

- 严重度：P1
- 置信度：已确认
- 状态：已关闭
- 现象：Main 投递 `ScopedServicePort` 时携带 `workspacePath`、`workspaceIdentity`、`workspacePurpose`，Preload 转发时只保留 `attachmentId`、`sessionId`、`target`、`sourceServerId`。
- 影响：Renderer 注册的 remote session 缺少 workspace 和 purpose 信息；从项目进入 Source conversation 时，可能不创建独立 logical session，而把原项目 session rebind 到 conversation backing workspace。
- 证据：
  - [`packages/desktop/src/main/desktopRemoteSessions.ts`](../../packages/desktop/src/main/desktopRemoteSessions.ts) 的 Main payload 含完整 scope；
  - [`packages/desktop/src/preload/index.ts`](../../packages/desktop/src/preload/index.ts) 截断上述三字段；
  - [`packages/desktop/src/renderer/src/remoteWorkspaceServicePortBridge.ts`](../../packages/desktop/src/renderer/src/remoteWorkspaceServicePortBridge.ts) 已准备解析这三字段；
  - [`packages/ui/src/root/useRemoteWorkspaceHistory.ts`](../../packages/ui/src/root/useRemoteWorkspaceHistory.ts) 依赖 session 的 path/purpose 决定是否新建 conversation session。
- 关闭条件：Main、Preload、Renderer 共享严格 payload schema；三字段端到端保留；集成测试证明项目与 conversation 使用不同 logical session，且不会共用同一 `remoteSessionId`。
- 当前进展（2026-08-28）：
  - 已新增共享 strict payload schema，并由 Main、Preload、Renderer 共同消费；Preload 不再手工白名单重建 payload；
  - focused tests 已覆盖 Main payload、真实 Preload listener → Renderer parser 透传、缺失 scope fail-closed、unbound session 直接绑定 conversation，以及 project → conversation 使用独立 logical session；
  - 真实 SSH Electron pending case `conversation-session-ssh-remote-project-conversation-scope.test.ts` 在 `linux-amd64-dev` 通过，证明 project/conversation 使用不同 `remoteSessionId` 且复用同一 Window Host；artifact：`desktop-e2e-20260828023242575-p87386-071a9e0ea38732ee`。
  - 当前 HEAD `86f5701e10` 再次通过真实 SSH 运行时复验：`dev@localhost:2222` 握手到 Source `32a10b89-141c-469b-aa97-850f41ab7deb`；project `/home/dev` 返回 `remoteSessionId=58423030-60c1-4dda-b21e-3c5254b7d08a`，conversation `/home/dev/.zcode/workspace/default` 返回 `remoteSessionId=a1188548-5cfe-4162-ae74-b4cf1315dd6f`。两者 stable identity 各自保留，conversation bind 明确返回 `workspacePurpose=conversation`，连接请求均完成 Renderer attachment ready ACK。

### R3-ISSUE-003：手机 attachment 可访问 Terminal RPC

- 状态：已关闭
- 当前合同（2026-10-22）：已配对手机应支持终端；下述历史修复中的 Terminal 禁令已被
  [手机终端恢复合同](../web-remote-control/web-remote-control-architecture.md#启动调用边界与-office-xss-关系)
  替代。继续保留 allowlist 和其他频道限制，仅恢复 Terminal，桌面服务面不变。

#### 修复记录 2026-08-28

- 状态：已关闭
- 根因：Window Host 把完整 `ServiceCollection` 当成 attachment 授权，只用 denylist 排除 Source Management；`ITerminalService` 因而被注册到 `web-remote-replayable` 的 `ChannelServer`。
- 修复：`ServiceCollection.exposeOnChannelServer()` 改为显式 allowlist policy；Window Host 为 mobile attachment 维护独立已审阅 channel 合同，明确不包含 Terminal 和 Source Management，未审阅的新 channel 默认 fail-closed；Desktop attachment 保持完整服务面。
- 验证：mobile 内存 RPC 调用 Terminal 返回 Unknown，且底层 `terminal.create` 未执行；Desktop Terminal RPC 仍成功；相关 5 个测试文件 18 项通过；`pnpm typecheck` 与 `pnpm lint` 通过。
- 本轮真实 SSH 复验按用户要求不包含手机端，未新增手机实机证据。

### R3-ISSUE-004：retrying 时显式断开不能收口

- 状态：已关闭

#### 修复记录 2026-08-28

- 根因：`disconnect()` 把 online 物理 owner 误当成 Source 生命周期是否存在的判据；意外断线已经摘除该 owner，因此显式断开只清理恢复 timer 后提前返回。已经启动的恢复 flight 也没有 Source 级取消 owner，迟到成功仍可重新发布 online。
- 修复：显式断开先捕获 Source 的全部 Profile，再清理恢复状态并统一发布 offline；已识别 Source 的 connect flight 持有可取消 owner，disconnect 会使旧 flight 失效，异步边界在发布状态前检查取消信号，迟到连接只释放、不发布 online 或 reconnect event。
- 验证：Manager focused tests 24 项通过，覆盖多 Profile retrying-disconnect、取消全部 timer/probe 和 in-flight 迟到成功；Registry、Main、Renderer 三条终态 focused tests 通过；真实定时器最小复现保持 offline、无恢复次数且没有新增连接；全量 unit 1496 个文件、13247 项通过；`pnpm typecheck`、`pnpm lint` 与 `pnpm verify:pre-push` 通过。
- 当前 HEAD `86f5701e10` 通过真实 SSH/进程故障注入复验：停止专用 `zcode-ssh-linux-amd64` 容器后，Source 从“已连接”进入“连接中”；在 mounted `SourceServerManagementPanel` 使用的真实 `ISourceServerManagementService` 上调用 `disconnectSource(sourceServerId)`，Host 日志记录 `source-server-management.disconnectSource OK (3.1ms)`，状态立即变为“未连接”。恢复容器并等待 6 秒后仍保持“未连接”，没有迟到 reconnect 复活；测试后容器、daemon 与 Desktop 均已恢复在线。
- 交互边界：设置页和 Sidebar 当前只在 aggregated status 为 online 时展示“断开”，retrying/connecting 时没有可点击的用户入口。因此本轮证明的是生产 Renderer → MessagePort RPC → Host → Manager 的运行时合同，不是纯 UI 点击路径；若产品要求用户在恢复中主动取消，需要另补交互入口或调整按钮可见性。

### R3-ISSUE-005：同一 Source 的不同 Profile 可能产生两个 logical owner

- 状态：已关闭

#### 修复记录 2026-08-28

- 根因：Registry 把 SSH/WSL/Docker route key 同时当成握手前 lookup key 和握手后的最终 owner key；Manager 已按 `sourceServerId` 复用物理连接后，不同 Profile 的 entry 仍会分别发布 online，workspace join 又只检查同一个 entry。
- 修复：Registry 在握手后以 `sourceServerId` 原子 claim canonical Source entry；竞争失败的 route entry 把 pending logical session 转交给 canonical owner，只回收 wrapper/订阅并保留 route alias。recovering Source 经另一 Profile 获得新 handle 时，在同一 canonical entry 上换代 handle、active target、`remoteSessionId` 与 generation，不创建第二个 owner。
- 验证：新增同 workspace、不同 workspace、反序并发握手、跨 Profile recovery takeover 和 Main canonical target join 测试；相关 5 个测试文件 103 项通过；`pnpm typecheck`、`pnpm lint` 通过；最小运行时回放从 `connectionCount=2/logicalSessionCount=2` 收敛为 `1/1`，两次请求返回同一 `remoteSessionId`，`findSessionForWorkspace()` 唯一命中。
- 当前 HEAD `86f5701e10` 通过真实双 Profile SSH 复验：Profile A `dev@localhost:2222` 与 Profile B `dev@127.0.0.1:2222` 握手后均归属 Source `32a10b89-141c-469b-aa97-850f41ab7deb`；两条 route 打开 `/home/dev` 均返回 `remoteSessionId=58423030-60c1-4dda-b21e-3c5254b7d08a`。第二 route 完成后 Host topology 仍为 `connections=1, logicalSessions=2`，其中两个 logical session 分别对应 project 与 conversation，没有生成第二个 project owner。

#### 补充修复记录 2026-09-13（review finding RV-P1-3）

- 现象：Registry `connect()` 命中已在线 Source entry 时直接拿到 `sourceServerId`，却不把 workspace identity 归一成 `remote:server:*`；调用方带 legacy route identity（Renderer 对未换代条目手动重连，或 Host 为无 context 的 connect 补 route identity）时，owner 去重按原值比对不命中，同一 workspace 发布第二个 online logical session，`connect()` 还把 legacy identity 当权威值返回。main 在 bind 时归一后两条 session 同 key，`findSessionForWorkspace()` 抛“匹配到多个 logical session”，Controller `resolveSource` 与 Automation 目标解析随之失败。
- 根因：同一条“Source 身份已知后 identity 只能是 stable”的规则在握手上线、Source owner 转交、`bindWorkspaceContext` 三处各写一份，在线 entry 直接 join 这第四处漏掉。启动自动重连只接受 stable 条目，因此端到端触发窄，但 Host 不变量确定被违反。
- 修复：Registry 抽出 `applyStableWorkspaceIdentity()`，握手上线、owner 转交与在线 entry join 三条路径统一调用；`connect()` 在 `sourceServerId` 已知时先归一再参与 owner 匹配与返回。
- 验证：`windowRemoteConnectionRegistry.test.ts` 新增“在线 Source 上以 legacy identity join 时复用唯一 owner 并返回 stable identity”“在线 Source 上以 legacy identity 打开新 workspace 时立即归一为 stable identity”，修复前失败、修复后 44 项通过；相邻 Host 远程连接测试、`pnpm architecture:check --changed`、`pnpm typecheck`、`pnpm lint` 结果见提交说明。

### R3-ISSUE-006：删除 Profile 后 Manager 仍可能使用旧线路重连

- 状态：已关闭

#### 修复记录 2026-08-28

- 产品语义：删除当前 physical/recovery/connecting Profile 等价于显式断开整个 Source；剩余 Profile 只保留为可手动连接线路，不参与自动接管。
- 根因：旧 `forgetProfile()` 只删除展示状态和部分索引，没有删除 `OnlineConnection.profileIds`、Source 级 `reconnectInputs`、timer/flight 及其中已解析的 target/secret；删除后旧恢复 owner 仍能进入 transport。
- 修复：Manager 以 `removeProfile()` 统一处理 Profile 生命周期。删除当前 owner 时先取消 timer/flight、摘除 online/recovery owner，再发布 `profile-removed` terminal invalidation、释放 transport，并只把剩余已知 Profile 置为 offline；删除非当前 Profile 只清理自身。未识别和已识别的连接 flight 都持有可取消 owner，迟到异步结果不会重新发布被删 Profile。
- 验证：Manager、Management Service、Directory 与 Window Registry 四个 focused test 文件共 115 项通过，覆盖 online、retrying、未识别/已识别 in-flight、非当前 Profile 和持久化失败；`pnpm verify:pre-push` 因 upstream affected 分析遇到已删除文件自动升级全量 unit，1496 个文件、13258 项通过，`pnpm typecheck`、`pnpm lint` 通过。真实生产类运行时回放中，删除当前 SSH Profile 后 Source 为 terminal offline、剩余 Profile 为 offline，等待首个 2 秒恢复窗口后旧 host 没有新增 probe，自动重连次数为 0。
- 当前提交 `6a1de7485c` 完成真实 Electron + SSH `linux-amd64-dev` 复验：`pnpm bootstrap:with-remote` 构建并上传 3.9.1 linux-x64 archive，Desktop 经 `dev@localhost:2222` 连接 Source `32a10b89-141c-469b-aa97-850f41ab7deb`；另建 `dev@127.0.0.1:2222` Profile、显式断开后以该 Profile 建立当前物理连接，同时保留 `localhost` 与 `linux-amd64-dev` 两条可用 Profile。设置页确认删除当前 `127.0.0.1` Profile 后，Host 记录 `source-server-management.removeProfile OK (20.3ms)`，Source 立即显示“未连接”，被删 Profile 与凭据引用从 Directory 消失，剩余线路保持 offline。自 14:51:33 删除至 14:53:49 Desktop 停止的 136 秒观察窗口内没有新的 `connecting window-scoped remote source`、`remote-connected`、retry 或 reconnect 记录，完整跨过 2/4/8 秒恢复和 2 分钟 offline probe 边界，证明没有旧线路重试或其他线路自动接管。测试新增 Profile 已清理，Desktop 已停止，Source 恢复到测试前的离线状态。

### R3-ISSUE-007：自动恢复遇到用户动作状态仍继续重试

- 状态：已关闭

#### 修复记录 2026-08-28

- 根因：retry 与 offline probe 各自维护终止条件，且只硬编码识别 `SourceServerUpgradeRequiredError`；`connectOnce()` 已发布的 install/identity/non-retryable 终态随后又被调度器覆盖。Host 同时只转发 `retrying/offline`，pending 状态无法让 logical recovery 收口。
- 修复：Manager 在更新断连、2/4/8 秒 retry 和 2 分钟 probe 三个入口统一按公开错误码、原始 `retryable` 与 recovery owner 状态终止自动路径；owner 保留 actionable 状态，sibling Profile 收口为 terminal offline。Host 复用纯 recovery policy，把 pending 与 `failed + retryable:false` 转为既有 `recoverable:false` close，不修改 Registry、relay、main 或 realtime delivery 合同。
- 验证：Manager、recovery policy、Window Registry 与 Directory 四个 focused test 文件共 110 项通过，覆盖 install/upgrade/identity、普通 `retryable:false`、offline probe、更新断连、同 Source 多 Profile、瞬态预算和手动恢复；fake timer 运行时回放跨过 4/8 秒及 2 分钟边界后没有新增 probe。`pnpm typecheck`、`pnpm lint` 以及新增 policy/test 与本 issue 文档的 `oxfmt --check` 通过；lint 仅报告仓库既有 warning。
- 实机验证：当前修复提交 `9b56031ac2` 执行 `pnpm bootstrap:with-remote` 与真实 Electron `pnpm dev:desktop`，通过 CDP 9229 将 SSH `linux-amd64-dev`（Ubuntu x64、用户 `dev`）连接到 Source `32a10b89-141c-469b-aa97-850f41ab7deb`。15:49:40 UTC 临时移走 `/home/dev/.zcode/server/bin/zcode` 并由备份 launcher 正常停止 daemon；约 2 秒后 UI 从首次 recovery 直接收口为“未连接 / 远端已卸载 ZCode Server”，3 个项目历史保留。176 秒观察窗口完整跨过 2/4/8 秒和 2 分钟 probe 边界，UI 未进入 2/3、3/3 或 offline probe，Host 在首次 recoverable close 后只再发布一次 terminal close，日志没有新的 connect、remote-connected、upload 或 recovery-budget 记录，远端始终保持 `stopped`。恢复 launcher 后等待 8 秒仍未自动复活；用户显式点击“重新安装并连接”后于 15:55:03 恢复 online，Desktop 退出后远端保持 3.9.1 `ready`，临时备份已清除。截图证据位于 `packages/desktop/.e2e-artifacts/r3-issue-007-live-20260828-9b56031a/`。
- 实机覆盖边界：本次确认 SSH install-required、Desktop continuous logical terminal 与显式恢复；identity-change、普通 `retryable:false` 和 Mobile replayable 仍由 focused state matrix 覆盖，未以修改共享 installation identity 或未建立的手机配对环境伪报实测。

### R3-ISSUE-008：启动自动重连偏好被完整 AppSettings schema 丢弃

- 状态：已关闭

#### 修复记录 2026-08-28

- 根因：`remoteStartupAutoReconnectEnabled` 只进入 patch schema，SettingService 合并补丁后再次执行完整 AppSettings schema 时会在写盘前剥离显式 `false`；Host 门禁本身已经存在，原台账“Host 未读取”的判断已更正。
- 修复：完整 schema 增加可选布尔字段，保持旧配置缺字段即开启且不触发迁移；按产品决策从 AppSettings、patch、设置页、i18n 与 SSH 表单预填链删除全局 `remoteDefaultAssetInstallMode`。线路级 `assetInstallMode`、Profile 持久化与 release resolver 不变；新建连接弹窗每次打开固定重置为 `local-download-upload`，避免形成隐藏的“上次选择”偏好。
- 验证：6 个 focused test 文件 68 项通过，覆盖 schema full/patch、SettingService 跨实例重建、Host `false/true/undefined` 三态门禁、设置页只保留启动开关、i18n 删除与新建表单 reopen 重置；全量 `pnpm test:unit` 为 1497 files / 13271 tests 通过（另 1 file / 11 tests skipped），`pnpm typecheck` 通过，`pnpm lint` 0 error（仅仓库既有 warning）。
- 进程级验证：两个独立 Node/tsx 进程依次执行“SettingService 写入 false”与“新进程重读后调用 `runStartupReconnectBatch`”，观察到 `readAfterProcessRestart=false`、候选枚举 0 次、reconnect 0 次、结果 `[]`，证明持久化事实先于 Host recovery 生效。
- 实机验证：在提交 `645958b80b` 执行 `pnpm bootstrap:with-remote` 与真实 Electron `pnpm dev:desktop`，通过 CDP 9229 操作 SSH `linux-amd64-dev`（Ubuntu x64、`dev@localhost:2222`）。首次显式连接完成 74.2 MB Source Server archive 上传并安装/握手 3.9.1，Source `32a10b89-141c-469b-aa97-850f41ab7deb` 显示“已连接”；设置页只显示“启动时自动重连”，不再出现全局“默认资源下载方式”，新建 SSH 线路的高级选项仍显示“本地下载后上传 / 远端服务器下载”且默认前者，已保存 Profile 的 `remote-download` 保持。关闭开关并重启后，16:47:02 Host 记录 `Source Server startup reconnect finished, online=0, failed=0`，页面保持“未连接”；16:47:54 用户显式点击连接后恢复为“已连接”，证明手动路径不受门禁。重新开启并再次重启后，16:48:57 Host 记录 `online=1, failed=0`，无需用户动作恢复在线；对应截图位于 `packages/desktop/.e2e-artifacts/r3-issue-008-live-20260828-645958b8/`。测试结束后停止 Dev Desktop，并用测试前 SHA-256 备份恢复本机 `setting.json` 与 `credentials.json`；原始未配置开关、4 条 Profile、6 条历史均恢复。

### R3-ISSUE-009：手机 bridge 重建预算耗尽后没有明确终态

- 状态：已关闭

#### 修复记录 2026-08-28

- 根因：`scheduleBridgeRecoveryRetry()` 把有界退避返回的 `null` 当成静默停止，没有把“恢复预算耗尽”转换为终态；此时 Desktop 已释放旧 attachment，手机端却仍保留 degraded protocol、service registration 与旧 React Root。
- 修复：预算耗尽后复用既有 `renderBootstrapFailure()` 终态边界，发布 `connection-recovery-timeout`，依次销毁 service registration、protocol、requester 与 terminal transport，并渲染带整页重试入口的错误页。正常恢复、1s/2s/5s 预算、同 flight `recoveryId` 和逐次换代的 bridge generation 保持不变。
- 验证：外部 relay 入口集成测试真实驱动 initial bridge、hard degrade、连续四次 bridge-open 失败和 1s/2s/5s fake timer，确认终态错误页、远程 session registration 清理、protocol/transport 释放、预算耗尽后不再发送 open，以及手动 reload；相关 4 个测试文件 12 项通过，`pnpm typecheck` 通过，`pnpm lint` 0 error（仅仓库既有 warning）。

### R3-ISSUE-010：Source Settings 旧端口迟到关闭可能删除新一代服务

- 状态：已关闭

#### 修复记录 2026-08-28

- 根因：Renderer store 只以 `sourceServerId` 保存裸 `IServiceAccessor`，port close 也只按该 ID 删除；Port B 覆盖 Port A 后，A 的迟到 close 因而会删除当前 B。bridge 同时使用只返回 services 的 `connectViaMessagePort()`，丢失了主动释放旧 connection 所需的生命周期句柄。
- 修复：store 注册项携带 attachment identity、services 与 disposer，并以 entry 对象作为 owner token；注册 B 时先把 B 设为当前 owner，再主动 dispose A。每次注册返回绑定自身 entry 的 release，close 只有在该 entry 仍是当前 owner 时才删除。Renderer bridge 改用 `createMessagePortServiceConnection()` 保留幂等 disposer，复用既有 `attachmentId` 注册并在 port close 时调用 owner-aware release。
- 验证：新增 store owner 与真实 MessageChannel bridge 回归测试，覆盖 A→B→A-close 后 B 保持可用、替换主动 dispose A、B close 才删除及重复 release 幂等；相关 4 个 focused 文件 14 项通过，`pnpm typecheck` 通过，`pnpm lint` 0 error（仅仓库既有 warning）。`pnpm verify:pre-push` 因分支已有删除文件自动升级全量 unit，1496 个文件、13269 项通过，另有 3 个无关文件 5 项在高并发下超时；三文件单独复跑 35 项全部通过。
- 实机验证：提交 `d8a919b7ee` 执行 `pnpm bootstrap:with-remote` 和 `pnpm dev:desktop`，通过 CDP 9229 将 SSH `linux-amd64-dev`（`dev@localhost:2222`）连接到 Source `32a10b89-141c-469b-aa97-850f41ab7deb`，远端运行 3.9.1。模型设置先注册 attachment `source-settings-fa670e48-...`，再经真实 Preload → Main → Window Host 链路连续请求 `source-settings-7c315610-...` 与 `source-settings-0e7c8ddd-...`；Host 在第二次换代后仍为 `connections=1, logicalSessions=1, attachments=4`，没有继续增长为 5。最新 attachment 随后的 `model-provider.getDisplayOrder/getAllCached/getProviderRegistrySnapshot/getAll` 全部成功；页面刷新后继续选中远端 Source，供应商与模型列表可用，未进入 loading/error。截图位于 `packages/desktop/.e2e-artifacts/r3-issue-010-live-20260828-d8a919b7/after-two-replacements.png`。测试结束后通过管理服务“移除全部连接”清理临时 Source/Profile/凭据，恢复 `sourceServers=[]` 与原 4 条 Profile，Desktop 已停止；SSH 直查远端 daemon 仍为 3.9.1 `ready`。

### R3-ISSUE-011：多 workspace logical replacement 不是完整原子操作

- 状态：已关闭

#### 修复记录 2026-08-28

- 根因：Registry 以整个 Source entry 作为 rollback 单位，却以逐 workspace `onSessionReconnected`
  作为外部提交单位；workspace A 的 Controller/Main generation 已发布后，workspace B 失败仍会把 A 的
  internal session map 回滚到旧 generation。Controller replacement 同时缺少 Registry epoch 的 commit CAS，
  失败后还可能保留已经失去 logical owner 的 provisional source/订阅。
- 修复：logical replacement 改为逐 workspace 串行 prepare/commit。Registry 只把当前尚未提交的 pair 放入
  rollback 集合，通过 `isCurrent + commit` 在 Controller snapshot 成功且 epoch/owner 仍有效时提升 generation；
  已提交 sibling 永不再参与后续回滚。物理 Source 在单 workspace replacement 失败时保持 online，retry 与
  预算耗尽只处理仍 disconnected 的 workspace。Controller 在 commit 前执行 Registry CAS，并在 CAS/读取失败时
  静默丢弃 provisional source、订阅和 pending replacement，保留上一代离线可信投影。
- 验证：Registry、Controller、Desktop Main attachment 与 Mobile replayable 四个 focused test 文件共 136 项
  通过；新增双 workspace 第二项失败、只重试未提交 workspace、commit 后通知异常、提交后再次物理断连和
  Controller CAS 清理覆盖。
  `pnpm typecheck`、`pnpm lint` 通过（lint 仅有仓库既有 warning）。最小运行时回放中 workspace A 从
  `session-1/gen1` 收敛到 `session-3/gen2/online`，workspace B 保持 `session-2/gen1/disconnected` 且只有 B
  收到 terminal close；Registry 与外部投影对两个 workspace 的 sessionId/generation 完全一致。
- 实机验证：提交 `927f819ca4` 执行 `pnpm bootstrap:with-remote` 与真实 Electron `pnpm dev:desktop`，通过
  CDP 9229 将 SSH `linux-amd64-dev`（Ubuntu x64、`dev@localhost:2222`）连接到 Source
  `32a10b89-141c-469b-aa97-850f41ab7deb`，上传并运行 3.9.1 linux-x64 release。打开
  `/home/dev/r3-issue-011-a`、`/home/dev/r3-issue-011-b` 与 Source conversation 后，Host 稳定为
  `connections=1, logicalSessions=3, attachments=4`。首次真实 `zcode restart --json` 后三条旧 session
  同时 fail-closed，并在约 2.6 秒内全部换代恢复。随后使用仅存在于本次实测构建、测试后已删除的一次性
  fault injection 拒绝 B 的首次 `onSessionReconnected`：A 从 `7b9f032a-...` 单次换代为
  `7f940331-...`，conversation 单次换代为 `d37b04dd-...`；B 保持旧 `eb878642-...`，未产生对外 ghost
  generation，并在约 0.5 秒后的独立 retry 换代为 `d61d448a-...`。过程中 logical session 始终为 3，
  attachment 按 `1 → 3 → 4` 收敛，最终设置页显示设备在线且 2 个项目仍在。截图位于
  `packages/desktop/.e2e-artifacts/r3-issue-011-live-20260828-927f819c/after-fault-recovery-settings.png`。
  测试结束后已移除临时 fault injection、Source/Profile/凭据/历史与远端测试目录，恢复测试前设置；远端
  daemon 保持 3.9.1 `ready`、`runningTaskCount=0`。

### R3-ISSUE-012：Provider API Key 明文持久化规格与实现冲突

- 严重度：P2
- 置信度：已确认
- 状态：不修复（前提失效，2026-09-13）
- 现象：R3 主规格和 release 安全门禁要求 Provider store 不含明文 API Key；当前实现与降级兼容文档要求普通 Provider 在 `config.json#options.apiKey` 保留明文，并同时写 encrypted mirror。
- 影响：发布安全门禁无法与实现同时满足，后续开发者可能按错误规格进行破坏性清理或误报 Secret scan。
- 证据：
  - [`docs/architecture/r3-source-server-remote-architecture.md`](./r3-source-server-remote-architecture.md)；
  - [`../archive/remote-r3/r3-source-server-release-test-plan.md`](../archive/remote-r3/r3-source-server-release-test-plan.md)；
  - [`docs/model-provider-opencode-config.md`](../model-provider-opencode-config.md)；
  - `packages/services/src/model-provider/modelProviderService.ts`（已随 Provider 重构 M2 删除）。
- 关闭条件：明确兼容期真实策略；统一架构规格、存储文档和 Secret scan；若继续双写，明确普通 Provider 与 Start Plan 的不同安全边界。

#### 决策记录 2026-09-13

- 依据：Provider 重构合并（路线 A，Q3）接受明文 Personal Config；`modelProviderService`、`zcode.apiKeyCredentialKey` 加密镜像与 provider-sync 只读校验路径已全部删除，代码中不再有 `apiKeyCredentialKey` 引用。主规格 §8 已改为「设置页绑定本地 + Provisioning 单向下发」，不再要求 Provider store 无明文；原要求该门禁的发布测试方案已归档。
- 结论：「规格与实现冲突」的两端都已不存在，按 `不修复` 关闭。`docs/model-provider-opencode-config.md` 中描述该镜像的小节同日删除。

### R3-ISSUE-013：首次 Directory 迁移失败可能遗留孤儿凭据

- 状态：已关闭

#### 修复记录 2026-08-28

- 根因：`migrateProfileTarget()` 在 Directory settings 提交前就把 legacy secret 复制到新 Profile key，`migrateLegacyRemoteEntries()` 却没有持有这些写入的 before state。settings 失败后初始化允许用新 `profileId` 重试，首代 key 因而永久失去引用；密码与私钥口令并行复制时，先失败的 Promise 还会让另一条迟到写越过 rollback。
- 修复：首次迁移以整个 Directory 写入为凭据事务边界，记录每个目标 key 的旧值，任一凭据或 settings 写入失败都在返回前恢复本轮全部变更；密码与私钥口令改为顺序等待，禁止迟到 save。已有 `connectionProfiles` 作为提交权威时不再为被排除的临时 Profile 复制 secret。
- 验证：新增 settings 失败后回滚并以新 Profile ID 重试、双凭据部分失败迟到写和未进入提交集的临时 Profile 三组回归；`sourceServerDirectory.test.ts` 38 项全部通过，`pnpm typecheck` 通过，`pnpm lint` 0 error（仅 38 个仓库既有 warning）。
- 实机验证：提交 `8d25737576` 执行 `pnpm bootstrap:with-remote` 与 `pnpm dev:desktop`，通过 CDP 9229（`agent-browser` daemon 启动失败后按 Electron skill 回退 Playwright CDP）使用 SSH `linux-amd64-dev`（`dev@localhost:2222`、用户 `dev`）连接真实 Source `32a10b89-141c-469b-aa97-850f41ab7deb`，UI/Host 日志确认 `direct-tcpip 通道已建立`、远端 `ZCode v3.9.1`、握手成功与链路就绪。
- 隔离迁移回放：在独立 `/tmp` 数据目录预置一条 legacy SSH entry 和加密 legacy credential，首次 Desktop 启动用一次性 `ENOSPC` settings fault 命中 `setting.json`；Host 日志记录 `Source Server directory initialization failed`，此时 `migrationVersion=null`、Profile/history 均为 0，credentials 仅剩 legacy key。移除 fault 后重启同一 Desktop，最终 `migrationVersion=1`、Profile/history 引用同一 canonical Profile，credentials 仅有 legacy + canonical 两个 key 且解密值一致；真实 settings 中由连接验证临时创建的 Profile/Source 已通过 Directory API 清理恢复，隔离目录已移入 `/tmp/.Trash/`。

### R3-ISSUE-014：Release Resolver 下载缺少取消和 cache single-flight

- 严重度：P2
- 置信度：高风险待复现
- 状态：待修复
- 现象：descriptor/archive fetch 未完整传递 AbortSignal，同 version/target 的并发请求没有共享 single-flight，可能同时操作同一 cache 文件。
- 影响：用户取消后下载继续；多 Source 同时下载时可能竞争 delete/download/rename，Windows 行为尤其需要验证。
- 证据：[`packages/desktop/src/host/sourceServerReleaseResolver.ts`](../../packages/desktop/src/host/sourceServerReleaseResolver.ts)。
- 关闭条件：补 cancel、并发、Windows cache 竞争测试；相同 cache key 共享下载 flight；所有调用者取消时停止底层 fetch；原子发布 cache 文件。

### R3-ISSUE-015：RemoteWorkspaceController 尚未成为统一写入口

- 状态：已关闭

#### 修复记录 2026-08-28

- 根因：controller handler 全部为 optional，生产只装配 `open-conversation`；Root 继续向 Sidebar、Settings、Dialog 和 tab lifecycle 暴露分散的连接、断开、项目打开、重连和关闭回调。
- 修复：六类 handler 改为强类型必填，在 `useRemoteWorkspaceHistory` 内按 Source/attachment/persistence owner 完整装配单一 controller，并通过 Root provider 供 UI 使用；普通 Profile 连接统一携带 `open-conversation` completion intent。项目选择、设备断开、workspace 重连和 user-close 均先 dispatch，再进入既有 owner helper。
- 验证：controller 全 intent/错误传播、Root production wiring、Settings disconnect 和 Sidebar 禁止直接 `disconnectSource` 的 focused tests 通过；全量 unit（1500 passed，1 skipped）、`pnpm typecheck` 与 `pnpm lint` 通过。`pnpm bootstrap:with-remote` 构建成功，`VITE_ZCODE_E2E_STORE_BRIDGE=1 pnpm dev:desktop` 启动成功并监听 CDP 9229。
- 真实 SSH/CDP（2026-08-28）：使用 SSH alias `linux-amd64-dev`（`dev@localhost:2222`，密码由测试环境注入）连接真实设备，远端 `~/.zcode/server/current.json` 为 `3.9.1`，设备 `4fedce9b49f0`，Source Server 为 `32a10b89-141c-469b-aa97-850f41ab7deb`。设置页普通连接完成后自动打开 `/home/dev/.zcode/workspace/default` 的 `conversation` tab，`workspaceIdentity=remote:server:<sourceServerId>:/home/dev/.zcode/workspace/default`；断开后卡片由“已连接”变为“未连接”，远程 attachment/session 被释放；再次连接生成新的 `remoteSessionId` 并重新打开 conversation。随后从 conversation 选择 `/home/dev` 打开 project，project 与 conversation 使用不同 `remoteSessionId`；通过真实 tab close 触发 user-close 后 project 被移除且 conversation 保留。
- 自动化 SSH E2E：`E2E_SSH_REMOTE_PROJECT_CONVERSATION_SCOPE` 1 项通过，报告 [`desktop-e2e-20260828-153721-524`](../../packages/desktop/.e2e-artifacts/desktop-e2e-20260828-153721-524/summary.md)。同轮执行的 pending-cancel 手工复核因代理 socket 在 30 秒断言窗口后约 1.5 秒才关闭而失败（`desktop-e2e-20260828-153846-870`）；该失败路径不涉及本 issue 的 controller 写入口变更，未将其计入 R3-ISSUE-015 关闭条件。

### R3-ISSUE-016：RemoteWorkspaceProjection 未完全接线且会误投影本地 tab

- 状态：已关闭

#### 修复记录 2026-08-29

- 状态：已关闭
- 修复提交：`aecaf1f410`
- 根因：`buildRemoteWorkspaceProjection()` 使用全部 `input.tabs` 构建 `openWorkspaces`；本地 tab 没有 `remoteSessionId`，随后被 `stateForOpenWorkspace()` 误标为 `disconnected`。同时 Sidebar、Root 和 Source 管理面板没有完整消费 projection join 结果。
- 修复：`openWorkspaces` 先按统一 remote-tab 判定过滤；`executionContexts` 保留全部 local/remote tab，并只为 remote context 关联 open workspace。Sidebar 合并为单次 projection 计算，Root 的 Source open-tab 集合及 Source 管理面板的设备 Profile/聚合状态改从 projection 读取；新增本地 tab 回归与生产接线测试，并将边界合同写入远程 workspace 规格。
- 自动化验证：受影响的 6 个 UI 测试文件 56 项通过；全量单测 1500 个文件、13290 项通过（1 个文件 skipped、11 项 skipped）；`pnpm typecheck` 通过；`pnpm lint` 0 errors（保留 38 个既有 warning）。`pnpm verify:pre-push` 首轮因旧静态断言失败，修正该断言后等价全量 `pnpm test:unit` 已通过。
- 运行时验证：`VITE_ZCODE_E2E_STORE_BRIDGE=1 pnpm dev:desktop` 成功完成 Desktop/Host 构建，Electron 监听 CDP 9229，Renderer 加载 ZCode 页面并显示本地与远程历史 workspace。已补做真实 local + SSH remote 混合 TabStore/Projection/Sidebar 复验，详见下方 SSH/CDP 记录。
- 剩余风险：真实 attachment fact 仍未由该 projection 在所有入口注入，远程 workspace 的 ready/attaching 细节需继续由各 attachment 生命周期验证；该风险不会使 local tab 进入 `openWorkspaces`。手机 `/remote` relay 实机不在本次 SSH 环境内，沿用 focused mobile tests，属于独立跨端验证项。

#### 真实 SSH/CDP 复验 2026-08-29

- 环境：`pnpm bootstrap:with-remote` 与 `pnpm dev:desktop`；SSH alias `linux-amd64-dev`，`dev@localhost:2222`，真实密码认证由连接向导完成。
- 连接结果：Source `32a10b89-141c-469b-aa97-850f41ab7deb` 显示“已连接/刚刚在线”；连接向导经历 SSH 通道、Server 启动与握手后正常收口。
- Projection 结果：真实 TabStore 读取到 13 个 workspace tabs（6 local、7 remote）；动态加载当前 `buildRemoteWorkspaceProjection` 后得到 7 个 `openWorkspaces`，`openWorkspaces` 不含 local，6 个 local `executionContexts` 均不带 `attachmentState`，两个 SSH Source ID 正确保留。
- Sidebar 结果：切换到项目视图后真实 DOM 出现“本机”、两个已连接 Source 组和两个未连接 pending 组；本地 workspace 没有被画成断连远程组。
- 断开/重连：真实点击 `4fedce9b49f0 · dev` 的“断开”后卡片变为“未连接”，对应 remote tabs 保留且 projection 行变为 `disconnected`；再次点击“连接”后卡片恢复“已连接”，三个目标 workspace 的 `remoteSessionId` 恢复。
- Source 管理面板：真实卡片显示 `dev@localhost:2222`、`online`、`2 个项目`，设备状态与 Profile 事实正常渲染。
- 边界：运行时只使用 `desktop-continuous` attachment；未创建额外 Host/Agent。真实手机 `/remote` relay 与 Source 管理 mobile denylist 不在本次 SSH 环境内，继续沿用 focused mobile tests 验证。

### R3-ISSUE-017：手机 Source 组头状态与名称可能降级失真

- 严重度：P2
- 置信度：高风险待复现
- 状态：待修复
- 现象：手机不能读取 Desktop-only management channel，只能从 workspace identity 分组，缺少 Source displayName 和聚合状态。
- 影响：attachment 实际可用时仍可能显示通用“远程设备”或“未连接”；任务可操作，但状态文案误导。
- 证据：手机 workspace projection 与 Source 分组 UI 的数据来源缺少 display/status 权威字段。
- 关闭条件：在不开放 Source 管理能力的前提下，通过既有 workspace attachment 投影必要的只读 Source 展示事实；补 mobile online/offline/recovering 展示测试。

### R3-ISSUE-018：新增远程 UI 存在任意尺寸和 ad-hoc alpha

- 严重度：P2
- 置信度：已确认
- 状态：待修复
- 现象：新增向导中仍存在 `rounded-[14px]`、`rounded-[10px]`、`size-[22px]`、`border-warning/35`、`border-success/35` 等写法。
- 影响：不符合根 [`DESIGN.md`](../../DESIGN.md) 的固定 radius/size 和 semantic surface token 规则，主题与后续视觉维护容易漂移。
- 证据：远程向导、连接状态和 continuity UI 中的任意 Tailwind 值。
- 关闭条件：替换为仓库现有 token/组件尺寸；补 descriptor token 和 continuity panel 的多主题对比度/视觉回归证据。

#### 修复记录 2026-08-29

- 状态：待验证
- 修复提交：`b53f1652c4`
- 根因：原型精确像素和透明描边直接进入远程 UI JSX class，绕过已有 radius/size/semantic surface token；既有布局测试还把部分 arbitrary class 当作预期输出。
- 修复：远程连接方式卡片改用 `min-h-32`、`rounded-lg`、`rounded-md` 和 `size-5`；连接面板、LinkRail、设置页离线点和 Source boundary dialog 统一使用既有语义边框/表面 token，移除组件级 alpha 与 340/180px 固定值；新增远程 UI token conformance 检查，并补 descriptor/continuity token 的四主题解析与对比度测试。
- 自动化验证：相关 6 个 UI 测试文件 37 项通过；全量 `pnpm test:unit` 通过（1501 files / 13293 tests，1 skipped file / 11 skipped tests）；`pnpm typecheck` 通过；`pnpm lint` 0 error（38 条既有 warning）。
- 运行时验证：Electron test 环境通过 CDP 9229 验证设置页和连接弹窗设备/连接方式步骤，Zai Light/Zai Dark 截图归档于 `packages/desktop/.e2e-artifacts/r3-issue-018-live-20260829/`；截图中 SSH/WSL/Docker descriptor 与状态 token 正常显示。
- 剩余风险：connecting 状态面板和 continuity dialog 尚未在当前 Electron 会话中单独截图；语义 token 对比度已有自动化覆盖，仍需补两类场景的最终视觉 artifact 后关闭 issue。

### R3-ISSUE-019：架构、计划、coverage 与实机记录状态漂移

- 严重度：P2
- 置信度：已确认
- 状态：修复中
- 现象：主规格、completion plan、conversation spec、UI 规格、release plan、coverage matrix 与实机记录分别使用“设计中、实现中、代码完成、已实测、partial/planned”等不同口径；部分构建文档仍描述 legacy manifest/components。
- 影响：无法可靠判断当前事实和发布剩余项，旧 artifact 或旧架构容易被误用。
- 证据：
  - [`r3-source-server-remote-architecture.md`](./r3-source-server-remote-architecture.md)；
  - [`../archive/remote-r3/r3-source-server-remote-completion-plan.md`](../archive/remote-r3/r3-source-server-remote-completion-plan.md)；
  - [`remote-domain-simplification-and-conversation-workspace-spec.md`](./remote-domain-simplification-and-conversation-workspace-spec.md)；
  - [`../archive/remote-r3/r3-source-server-release-test-plan.md`](../archive/remote-r3/r3-source-server-release-test-plan.md)；
  - [`../testing/conversation-session-e2e-coverage-matrix.md`](../testing/conversation-session-e2e-coverage-matrix.md)；
  - [`../archive/remote-r3/r3-source-server-expanded-live-test-record-2026-08-21.md`](../archive/remote-r3/r3-source-server-expanded-live-test-record-2026-08-21.md)。
- 关闭条件：建立当前候选统一状态入口，记录规格状态、candidate SHA、自动化结果、实机 artifact、blocked 环境与发布结论；其他文档引用该入口，不再分别维护漂移的当前状态。

#### 修复记录 2026-09-13

- 已做：新增 `docs/remote/README.md` 作为远程主链阅读入口并在 AGENTS.md 登记；主规格 §1 状态改为「已实现（基线 `fad93b9e57`）」、§7.1 启动重连门禁字段改为 `lastOnlineAt`、新增 §8.4 设备管理合同、§9.1 并入控制端逐表盘点、§15 并入 Provider 合并遗留项；领域简化规格标注 Phase 0–4 已实现；`desktop-remote-session-renderer-reattach.md` 门禁描述改为「Host 设备级 7 天 + Renderer 不按 connected 历史过滤」；18 份过程 / 评审 / 实机记录文档移入 `docs/archive/remote-r3/`，全部入站链接（含 `.agents/skills/feature-boundary-planner/references/zcode-feature-graph.yaml`）已改指归档路径；`r3-remote-ui-redesign.md` 删除 §11–§19 历史日志并标注原型未入库；`zcode-agent-remote-deployment.md`、`server-remote-workspace-connection.md` 加旧主链状态注记；coverage matrix 修正 SSH-P0-LIFE-03 的不存在 spec 引用。
- 未做：统一「candidate SHA + 自动化结果 + 实机 artifact」的发布状态入口仍由本文与 `docs/testing/r3-remote-full-rerun-2026-09-10.md` 分担；R3-ISSUE-001 / 020 关闭后在本文补发布结论即可关闭本项。

### R3-ISSUE-020：历史实机记录不能证明当前 HEAD

- 严重度：P1
- 置信度：已确认
- 状态：待验证
- 现象：SSH 和扩展实机记录绑定的 commit 不是当前 HEAD 的祖先；当前分支后续又修改了自动升级、workspace 恢复、conversation、OAuth、Team Plan 和 mobile bridge。
- 影响：历史记录能证明故障模式和早期能力，但不能作为当前候选发布签字。
- 证据：
  - SSH record 基线 `d684ee1af7`；
  - expanded record 基线 `069250a399`；
  - 当前基线 `ed0fe80b1391`；
  - release plan 仍有 WSL、launchd、物理手机、长稳和当前 commit artifact 缺口。
- 关闭条件：在最终候选 SHA 上执行并归档必要的 SSH、Docker、Windows WSL、Mobile、更新、卸载/重装、permission/elicitation 和恢复测试；artifact 自包含、可被其他机器独立复核；coverage matrix 与结果同步。

### R3-ISSUE-021：握手落盘期间断连被丢弃，死连接被发布为 online

- 状态：已关闭

#### 修复记录 2026-09-13

- 根因：close 事件按 Source 键路由而非按连接身份路由，且“连接已关闭但尚未发布”没有状态承载。
- 修复：`connectOnce` 只在把连接登记为 online owner 之后才把 close 交给 `handleUnexpectedClose`，并传入连接对象；发布前的关闭只记录原因，发布点在 sibling join 之后检查该标记，命中则 dispose 并抛出 `retryable:true` 的握手期关闭错误，走既有 connect 失败路径。`handleUnexpectedClose` 核对 `online.connection === connection`，迟到或不属于 owner 的 close 直接忽略。主规格 §7.1 新增「发布前断连」条目。
- 验证：`sourceServerConnectionManager.test.ts` 新增 3 项（握手期关闭→failed retryable、sibling 握手期关闭 join owner、重试阶梯中握手期关闭继续下一档），修复前 3 项均失败、修复后 37 项全部通过；`sourceServerHostReleaseWiring.test.ts` 通过；`pnpm typecheck`、`pnpm lint`（0 错误）、`pnpm architecture:check --changed` 通过。未做真实 SSH/Docker 运行时故障注入。

### R3-ISSUE-022：远端 archive 缺 android-emulator / ios-simulator 插件 MCP runtime

- 状态：已关闭

#### 修复记录 2026-09-13

- 状态：已关闭
- 根因：删除 legacy 资产链时，“构建并断言官方插件 MCP runtime”的责任没有落到新 staging 链任何一环。
- 修复：`scripts/build-desktop-agent-cli.mjs` 的 MCP runtime 清单补入 `@zcode/android-emulator-plugin` 与 `@zcode/ios-simulator-plugin`，该脚本是桌面与 Source Server staging 共用的唯一构建入口；`stage.ts` 复制每个插件后新增 `assertOfficialPluginRuntime`，manifest 缺失或 `mcpServers` 引用的 `${ZCODE_PLUGIN_ROOT}/...` 文件不存在即抛错。R2 spec 新增“官方插件 MCP runtime 不变量”条目。
- 自动化验证：`packaging.test.ts` 新增 2 项 fail-closed 用例（缺 MCP 入口、缺 manifest），修复前失败、修复后通过；既有插件 staging 用例补断言 `dist/mcp/server.js` 被打包；`runtime-asset-scripts.test.ts` 清单断言同步。
- 运行时验证：本地删除 `apps/zcode-cli/packages/{android-emulator,ios-simulator}-plugin/dist` 后执行 `pnpm --filter @zcode/server-cli stage --target linux-x64`，构建链实际重建两个插件，`zcode-server-linux-x64.tar.gz` 内四个 MCP 插件的 `runtime/packages/*/dist/mcp/server.js` 均存在，耗时约 1 分钟。未运行真实 CI `build:remote:assets`。
- 剩余风险：`stageRelease` 现在会对所有被复制的 `*-plugin` 目录做校验，若未来新增声明 mcpServers 却不在构建清单中的官方插件，staging 会显式失败而非静默残缺，这是预期行为。

### R3-ISSUE-023：恢复态手动连接成功不发 reconnect，Registry 停在 recovering

- 状态：已关闭

#### 修复记录 2026-09-13

- 状态：已关闭
- 根因：重连事件的发布责任分散在三个调用方，而不是放在 Manager 唯一知道「非在线 → 在线」的发布点；新增的手动 `connect()` 路径没有复制这一职责。
- 修复：`connectOnce` 发布点以 `reconnectInputs.has(sourceServerId)`（首次发布写入、显式断开删除）判定「再次发布」，命中即在 `setState(online)` 之后 fire 一次 `onDidReconnect`；删除 `scheduleOnlineRetry`、`enterOfflineProbe` 的 `.then(fire)` 与 `updateServer` 的显式 fire，避免双触发。Registry 的接管注释同步更新。主规格 §7.1 新增「`onDidReconnect` 唯一事实源」条目。
- 验证：`sourceServerConnectionManager.test.ts` 新增 2 项（retrying 期间手动连接、offline 期间手动连接均 fire 一次且后续 timer 不再触发），修复前均失败、修复后 39 项全部通过；`windowRemoteConnectionRegistry.test.ts`、`sourceServerHostReleaseWiring.test.ts` 通过（3 文件 85 项）；`pnpm typecheck`、`pnpm architecture:check --changed` 通过；oxlint 对改动文件 0 错误。未运行 Electron E2E 与真实 SSH/Docker 断连注入；未对 Host wrapper → Registry 的联动写集成测试。
- 行为变化：不同 Profile 手动连回 recovering Source 时，旧 wrapper 现在会先收到 reconnect 并把 entry 置回 online，provisional entry 走 join 分支而非接管分支；两条路径的结果都是唯一 canonical entry。`updateServer` 对从未在线过的 Source 不再 fire reconnect（此前无消费者）。

### R3-ISSUE-024：wsl.exe 非 `--exec` 模式让默认 shell 提前展开命令变量，WSL 安装误报「远端缺少 tar」

- 严重度：P0
- 置信度：已确认
- 状态：待验证
- 现象：Windows 3.12.0（`0d926421`）连接 WSL Ubuntu，五步弹窗在「部署 ZCode Server」阶段报「远端服务器缺少 tar，无法解压 ZCode Source Server。请安装 tar 后重试。」；同一台机器用线上 3.12.1 旧主链连接正常。日志里 `[connect-remote] caught error` 之前没有任何部署日志，失败点是 `transportAdapter.installOrUpdate` 本地上传分支的 `detectRemoteTarTool` 预检；该预检要求远端退出码为 0，所以只能是「脚本成功但 `tar=` 为空」。
- 根因：`WSLBackend.exec` / `execDirect` 以 `spawn("wsl.exe", ["-d", distro, "-u", user, "--", "bash", "-lc", command])` 启动。Node 对含空格/引号的参数加双引号并把内部双引号转义；wsl.exe 不带 `--exec` 时把 `--` 之后的原始命令行整段交给用户默认 shell 以 `-c` 执行（microsoft/WSL `WslClient.cpp` 非 exec 分支把整段 commandLineString 作为 argv[0]，经用户默认 shell 以 -c 执行）。外层 bash 解析这段双引号字串时先把 `"$tar_tool"` 展开成空串，内层 `bash -lc` 实际收到 `printf 'tar=%s\n' ""`，远端输出 `tar=`、退出码 0，预检判定缺少 tar。同一机制还让 `installOrUpdate` 的过期 staging 清理循环（`$candidate`、`${name##*-}`）与 `probeSourceServer` 的 `$status_pid` 存活检查在 WSL 上静默失效。旧主链只引用 `$HOME` 类环境变量（外层展开结果相同），部署锁（`77433f1616`）与 agent wrapper 写入又各自做了落盘绕行，所以从未暴露。
- 证据：隔离探针用真实 `detectRemoteTarTool` + libuv `quote_cmd_arg` 规则 + `$SHELL -c <原始尾巴>` 稳定复现同一报错（stdout `tar=\n`、exit 0）；改为 `--exec` argv 直传或 SSH 后端的 `/bin/sh -c '…'` 包装均得到 `tar=tar`。现有 `remoteAssetPreflight.test.ts` 6 项全部通过，因为假后端直接回传正确文本，覆盖不到引号链路。

#### 修复记录 2026-09-14

- 状态：待验证
- 修复提交：`feat/multi-device-remote-3-real-ssh-feature` 上包含本记录的提交（`fix(remote): run wsl.exe commands in --exec mode so the default shell cannot pre-expand them`）
- 根因：见上；责任边界是 `WSLBackend` 向 wsl.exe 交付命令的方式，不是 preflight 或错误文案。
- 修复：`buildWslArgs` 的分隔符由 `--` 改为 `--exec`。wsl.exe 按 `CommandLineToArgvW` 解析 argv 后直接 exec `bash -lc <command>`，该解析与 Node 的加引号规则互逆，命令字节原样到达 bash；登录环境仍由显式的 `bash -lc` 提供。`exec`（部署、上传流）与 `execSimple` / `execDirect`（身份解析、`uname`、代理探测）同时生效；preflight、错误文案与部署锁/agent wrapper 的既有落盘路径不动。
- 自动化验证：`packages/server/test/wslBackend.test.ts` 新增「exec 与 execSimple 都以 --exec 直传 argv，命令不经默认 shell 二次解析」，并把 3 处 `--` 参数期望改为 `--exec`；修复前 3 项失败、修复后 18 项通过。`wslProxy`、`remoteAssetPreflight`、`sourceServerTransportAdapter`、`remoteDeployLock`、`remoteAssetInstaller` 合计 6 文件 75 项通过；`tsc -b packages/server`、`pnpm architecture:check --changed`、oxlint、oxfmt 通过。隔离探针：真实 `buildWslArgs` → libuv 加引号 → `CommandLineToArgvW` 规则解析回 argv 后直接 exec，对 tar preflight、完整资源 preflight、Source Server probe、WSL 网关探测四条真实命令均字节一致回环，真实 `detectRemoteTarTool` 返回 `tar`，`probeSourceServer` 正常解析。
- 运行时验证：未在真实 Windows/WSL 上运行。关闭条件：Windows 实机用本修复构建连接 WSL Ubuntu，五步弹窗走到「链路就绪」，且 `~/.zcode/server/.bootstrap-*` 过期目录会被清理、`status.json` 存活时 `ensureDaemon` 不再重复 `serve --daemon`。
- 剩余风险：`--exec` 要求 distro 内 PATH 能解析 `bash`，与现有 `bash -lc` 依赖一致；此前被外层 shell 掩盖的脚本（stale staging 清理、`$status_pid` 检查、网关 `route=` 行）在 WSL 上首次真正执行，语义与 SSH 路径一致。若用户默认 shell 不是 POSIX shell，旧路径本会以非零退出码失败，新路径不再经过它。

### R3-ISSUE-029：replacement 在途时不保留后续 reconnect

- 状态：待修复，当前生产时序未触发；2026-10-11 登记，评审核对基线 `f5c233df918e`（CR-02）。
- 责任位置：`windowRemoteConnectionRegistry.ts` 的 `handleConnectionReconnected`。已有 flight 时直接返回；flight 以 stale 结束后不重试，也不复查是否收到新 reconnect。
- 证据：交接探针分别运行真实 Registry、ChannelClient，以及 Manager + Registry 联动。只有在 replacement 中注入与旧连接无关的等待时，第二次 reconnect 被丢弃，等待者保持 pending。按生产顺序先 dispose 旧连接并拒绝 RPC，旧 flight 在同一 tick 收口，2 秒后的 reconnect 可正常恢复。
- 当前处理：仅登记，不增加运行时状态。今后若 replacement 新增不随 transport 关闭而结束的等待，必须重新核对本项。
- 后续修复边界：entry 记录待处理 reconnect，终态关闭清除；旧 flight 完成后串行补跑。不得并行执行两个 replacement，因为 rollback 操作 entry 级状态。
- 关闭条件：覆盖独立等待跨两次重连、终态关闭、迟到回滚与真实 RPC 断线收口；共享 entry 只保留一代恢复 owner。

### R3-ISSUE-030：Provider 共享刷新等待没有接入单调用者取消

- 状态：待修复，当前无传 signal 的生产调用方；2026-10-11 登记，评审核对基线 `f5c233df918e`（CR-07）。
- 责任位置：`zcodeAgentService.ts` 的 `generateWorkspaceText` / `testProviderModelConnectivity` 等待 `ensureAccountProviderConfigSynced` 时未消费 signal。
- 证据：真实 Service 探针中取消后仍等待刷新结束，随后以 AbortError 收口；协议客户端在后续请求发出前检查 signal，因此不会执行已取消的模型请求。该证据证明收口延迟，不表示取消失效。
- 当前处理：仅登记。首个支持取消的生产调用方接入时，单个等待者与 signal 竞速；共享 `accountConfigSyncByClient` 刷新继续完成，不能由一个调用者取消其他调用者依赖的刷新。
- 关闭条件：一个等待者取消时及时拒绝，其他等待者仍可完成，且已取消的模型请求不会发送；共享刷新失败仍向未取消调用者传播。

### R3-ISSUE-031：crash-loop-stopped 时自动恢复无法拉起远端服务

- 状态：待修复；2026-10-20 在[停止和重启远端服务](../issues/remote-daemon-lifecycle/01-stop-restart-remote-service.md)讨论中登记，静态核对，未运行时复现。
- 现象：Core 在 5 分钟内崩溃 5 次后，Supervisor 进入 `crash-loop-stopped`，仍持有 data-root 锁和 control。probe 读到的 status `pid` 为空，Desktop 自动恢复执行 `serve --daemon`；该命令只对 ready / starting / `stop-failed`+`pid:null` 特判，不先停止现有 Supervisor。fallback 模式新 Supervisor 抢锁失败，service 模式等待 ready 超时，设备停在连接失败并每 2 分钟重复失败。
- 当前处理：新的整棵进程树 `zcode restart` 与设备卡「重启远端服务」让用户手动走出该状态。
- 待决：`crash-loop-stopped` 本身是防止无限崩溃重启的保护，自动恢复不应绕过崩溃预算。候选方向是识别该状态后停止自动恢复，展示“需要处理 · 远端服务反复崩溃”，主操作为重启；这会改变五态映射和设备卡主操作，需产品确认。
- 关闭条件：确定产品方案后，覆盖 crash-loop 状态的 probe、自动恢复终止与 UI 映射，并在真实远端复现崩溃预算耗尽。
- 运行时复现（2026-11-03）：本机 Docker systemd 容器（linux/arm64，root，无 linger）安装官方 3.17.2，保持一个
  SSH 会话，ready 后 5 次 `kill -9` Core 进入 `crash-loop-stopped`（unit 仍为 active）。之后 Desktop 每次连接都是
  `Starting Source Server` → `[ssh] exec channel failed: code=1` → 约 25.7 秒 `Timed out waiting for Server ready`
  （无状态后缀，`remote-connection-timeout`），持续复现；同状态下按 Desktop 方式更新到新版本会经在线 handoff
  停掉旧 Supervisor，更新后连接恢复。失败信息自 R3-ISSUE-035 起带出 `running supervisor: state=crash-loop-stopped`；
  自动恢复与 UI 映射仍待产品决策。

### R3-ISSUE-032：Supervisor 自身无响应时没有强杀兜底

- 状态：待修复；2026-10-20 登记（同上讨论 Q11）。
- 现象：Core 卡死时 Supervisor 会先 IPC shutdown、5 秒后 SIGKILL；但 Supervisor 自身事件循环卡住、control 请求超时时，`zcode stop` / `restart` 只返回 `source-server-control-unresponsive`，不清理也不 kill。
- 当前处理：首期接受，设备卡显示“远端服务无响应”，用户需登录服务器处理。
- 后续修复边界：按 `server.lock` 的 pid 与 ownerToken 确认身份后 SIGTERM → SIGKILL Supervisor，Core 因 IPC 断开自行退出；需覆盖 pid 复用、service 管理器托管与 Windows named pipe。
- 关闭条件：卡住的 Supervisor 能被 `restart` 安全替换，且不会误杀其他 root 或其他用户的进程。

### R3-ISSUE-033：启动自动重连“最近 7 天”文案与代码不一致

- 状态：待修复；2026-10-20 登记。
- 现象：设置页「启动时自动重连」说明与 §7.1 状态机写“最近 7 天内在线过的设备”；Host 候选枚举按 `lastOnlineAt` 排序，但不按 7 天过滤，保存的连接不因长期未使用失去启动重连资格。另外显式断开会刷新 `lastOnlineAt`，刚断开的设备在下次启动时排在最前。
- 处理方向：以代码行为为准修正文案与 §7.1，或由产品决定恢复 7 天门禁；二者择一后同步 case 目录。
- 关闭条件：文案、规格与候选枚举一致，并有覆盖候选范围的单测。

### R3-ISSUE-034：容器内僵尸 Supervisor 被判为持锁者

- 状态：已关闭；2026-11-03 由 ZCT-2117275161536565248（Windows 3.17.2，Docker workspace）登记。
- 现象：连接日志为 `Reusing running Source Server` → `Reused Source Server did not respond` →
  `ZCode Server daemon exited before ready (code=1 signal=none); check …`。同一容器当天 3.17.1 起后台重试约 260 轮
  报错相同，升级 3.17.2 后约 85 秒再次进入该状态；容器重启前一直连不上。
- 根因：容器 PID 1 为 `sleep infinity` 这类不回收子进程的程序时，Supervisor 与 Core 非正常死亡后成为僵尸。
  probe 用 `kill -0` 判定快照中的 Core PID 存活并复用旧端口，握手失败后执行 `serve --daemon`；新 Supervisor
  取锁时 `/proc/<pid>/stat` 仍在、starttime 不变，身份判定把僵尸当成存活持锁者，报
  `Another ZCode Server instance is already running` 并 exit 1（fallback 方式的输出被 `stdio: ignore` 丢弃）。
- 复现：本机 Docker（linux/arm64）官方 3.17.2，`docker run --entrypoint sleep … infinity` 容器经 Docker transport
  安装连接后 `kill -9` Supervisor 与 Core，二者成为 `Z` 状态；Desktop 两次重连都逐字复现上述日志与
  `remote-connection-unknown`。`--init` 容器同样操作后旧进程被回收，重连成功。Supervisor 与 Core 最初为何死亡，
  客户端日志无法确认。
- 修复方向：Linux 判活读取 `/proc/<pid>/stat` 状态字段，`Z`/`X` 视为进程不存在，带身份与不带身份的锁都适用
  （[R2 §9 持锁者判活](r2-server-cli-and-daemon.md#9-数据状态与不变量)）。
- 关闭条件：Docker transport pending E2E 覆盖“锁持有者为僵尸”，修复前失败、修复后进入目录选择；p0 与受影响远程
  用例回归通过。

#### 修复记录 2026-11-03

- 状态：已关闭
- 修复提交：本记录所在提交
- 修复：`runtime/lock.ts` 读取 Linux 进程身份时先看 `/proc/<pid>/stat` 的状态字段，`Z`/`X` 视为进程不存在；
  无身份的旧格式锁在 `kill(pid, 0)` 之前同样排除僵尸。取锁、`stop --wait` / `restart` 的停止等待与卸载守卫共用该判定。
- 自动化验证：pending E2E `conversation-session-remote-zombie-lock-docker`（本机 Docker linux/arm64，Docker transport）
  修复前连接失败于 `ZCode Server daemon exited before ready (code=1 signal=none); check …`，锁未被接管
  （`local-docker-20261103051543-9d6a22`）；修复后进入目录选择，新 Supervisor 持锁，僵尸保持原状
  （`local-docker-20261103051901-114865`）。
- 运行时回归：同批 `ssh-remote-p0`、`ssh-remote-connection-p0`、Docker / SSH 残留锁接管、停止远端服务、卸载通过；
  重启远端服务、server 更新、Core 启动失败、starting 复用、detached daemon 在共享容器中受前序用例改写的远端 release
  影响失败，各自在独立容器重跑通过。`--systemd` 下共享 home 对端接管、server root 被替换、p0 与 OS service 注册通过。
- 剩余风险：未在 x64 远端、Windows 客户端经 Docker Desktop 与真实跨机网络上运行；用户现场 Supervisor 与 Core 最初为何
  死亡仍未知。probe 仍按 `kill -0` 复用僵尸 Core 的旧端口，多一次失败握手后由回退恢复。

### R3-ISSUE-035：启动失败信息缺少远端已知原因

- 状态：已关闭；2026-11-03 由 ZCT-2117253090228297728、ZCT-2117256800886456320、ZCT-2117256940728745984
  （macOS 3.17.2，SSH root）与 R3-ISSUE-034 登记。
- 现象：A 组从 3.17.1 起每次连接都在约 27 秒后报 `Timed out waiting for Server ready`，无状态后缀；9 次更新都走离线
  切换（control 不可达）后报同一错误。说明 25 秒内没有任何 Supervisor 写过状态，原因只在远端 journal 或被丢弃的
  stderr 中，工单无法定位。本机 Docker 已排除 crash-loop-stopped、Core 启动即崩溃、CPU 极慢和更新 handoff 中断
  这几种解释；剩余解释需要远端证据区分。
- 修复方向：CLI 失败时按 [R2 §7.1](r2-server-cli-and-daemon.md#71-发行包-staging) 追加现有 Supervisor 的实时状态、Supervisor 写状态前的失败摘要与 OS service
  状态；首句与错误码不变。
- 关闭条件：SSH pending E2E 覆盖取锁失败（fallback 与 systemd 两种启动方式）和 crash-loop-stopped 两类失败信息；
  p0 与受影响远程用例回归通过。

#### 修复记录 2026-11-03

- 状态：已关闭
- 修复提交：本记录所在提交
- 修复：`serve --daemon`（含 `restart` 的启动段）在本次未写状态时追加 `running supervisor`、`supervisor`、`service`
  三项事实；Supervisor 写状态前失败时写 `run/supervisor-startup-failure.json`；OS service 等待失败后查询一次 unit 状态
  （2 秒上限）。错误首句与公开码不变，Desktop 无改动。
- 自动化验证：pending E2E `conversation-session-ssh-remote-supervisor-lock-failure` 与
  `conversation-session-ssh-remote-crash-loop-detail`（本机 Docker linux/arm64）。修复前默认 runner 只有
  `ZCode Server daemon exited before ready (code=1 signal=none); check …`（`local-docker-20261103050918-39c99c`）；
  `--systemd` 下锁被身份一致但不应答 control 的存活进程持有时，只有无后缀的 `Timed out waiting for Server ready`
  （`local-docker-20261103060008-685e72`），与 A 组现场逐字一致。修复后 detached fallback 报
  `… (supervisor: Another ZCode Server instance is already running)`、crash-loop 另带
  `running supervisor: state=crash-loop-stopped, last exit: …`（`local-docker-20261103051901-114865`）；OS service 另带
  `service: ActiveState=failed SubState=failed Result=exit-code ExecMainStatus=1 NRestarts=5`
  （`local-docker-20261103054344-f1362a`、`local-docker-20261103054553-f1e1e8`）。回归范围同 R3-ISSUE-034 修复记录。
- 剩余风险：A 组远端具体是哪个进程持锁仍需远端证据；本机已确认“身份一致、不应答 control 的存活持锁者”能同时解释
  A 组连接与 9 次更新的全部现场。launchd 分支未在 macOS 远端运行，x64 远端未运行。

## 连接体验后续议题（RDUX 范围外）

来源：[体验优化范围外](../issues/remote-connection-ux/01-remote-connection-ux-optimization.md#out-of-scope)。以下均未纳入 RDUX-03 实施，也不修改状态机或手机恢复协议。

| ID           | 后续议题                                                        | 状态   |
| ------------ | --------------------------------------------------------------- | ------ |
| R3-ISSUE-017 | 手机 Web 设备名和状态展示失真；复用既有 issue，另行评估手机展示 | 待修复 |
| R3-ISSUE-025 | 20 台以上设备/项目的搜索、筛选与分组                            | 待修复 |
| R3-ISSUE-026 | 设备在线但无打开项目时的空闲超时断开                            | 待修复 |
| R3-ISSUE-027 | 统一设置分区的本机/远端作用域归属                               | 待修复 |
| R3-ISSUE-028 | 钩子在远端作用域下的真实行为验证                                | 待验证 |

## 剩余工作

- 发布验证：R3-ISSUE-001、020；WSL 实机验证：024。历史自动化通过不能替代最终 candidate / 对应平台验证。
- 待修复或待复现：014、017，以及后续议题 025–027。
- 待验证：018、028；文档与覆盖状态核对：019。
- 条件性后续项：029、030；仅在各自触发前提变化或新增调用方时实施。
- 远端服务生命周期：031 待产品决策，032、033 待修复；来源见[停止和重启远端服务](../issues/remote-daemon-lifecycle/01-stop-restart-remote-service.md)。
- 已关闭项不再列入修复顺序。012 的不修复决策继续保留，不重新引入已退出的 Provider 方案。
- 2026-10-10 文档收敛移除重复过程与过期 UI 规则；019 仍保持修复中，不能由文档链接检查推定代码、覆盖率与最终发布证据已全部一致。

## 单项更新模板

后续修复单项问题时，在对应章节追加：

```md
#### 修复记录 YYYY-MM-DD

- 状态：修复中 / 待验证 / 已关闭
- 修复提交：`<commit>`
- 根因：
- 修复：
- 自动化验证：
- 运行时验证：
- 剩余风险：
```
