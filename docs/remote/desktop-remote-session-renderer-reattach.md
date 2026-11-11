# 桌面远程 Workspace Renderer 重挂

当前规格。适用于同一 BrowserWindow 的 renderer reload / ErrorBoundary 恢复，以及 Source online 后的项目 attachment 挂回。
SSH/WSL/Docker 统一由窗口 Local Host 管理，不再使用独立/池化 Remote Host 进程模型。
项目入口与缓存的所有权以 [虚拟项目设计](../superpowers/specs/2026-09-09-virtual-project-design.md) 为准。

## 权威与投递顺序

| 事实                                                              | 唯一 owner                                                         |
| ----------------------------------------------------------------- | ------------------------------------------------------------------ |
| Source 物理连接及恢复                                             | Window Host `SourceServerConnectionManager`                        |
| logical session、remoteSessionId、generation、workspace readiness | Window Host `WindowRemoteConnectionRegistry`                       |
| 窗口路由与 Renderer 端口投递                                      | Main `desktopRemoteSessions.ts` 的 `routesBySessionId`             |
| Renderer services 注册与门禁                                      | Renderer service store；tab 中的 sessionId 不是 ready 证据         |
| 项目身份                                                          | `workspaceIdentity?.trim() \|\| workspacePath`，与实际执行路径分开 |

```text
同窗口 renderer ready → Main 枚举 attachmentState=attachable 的 route
  → 从既有 Window Host 请求 attachment → 投递 RemoteServicePort
  → Renderer 注册 scoped services / ready ACK → 允许 workspace RPC
Source 换代 → Registry 更换 session/generation → Main 换 route → 重新建立 attachment
```

- 只重挂本窗口仍 attachable 的路由；pending、已 dispose 和过时代际不投递。
- 重挂更换端口与 attachment，不销毁共享 Window Host、物理 Source 或远端任务。
- remote port 早于 base ServicePort 时先暂存，base ready 后 flush，不能丢弃端口。
- 相同 workspace 的并发 connect 可返回同一 sessionId；Main join 既有 route/attachment，不覆盖健康 route。
- route 的首连阶段（首次 Provisioning 未完成、首个 renderer attachment 尚未投递）也可被 join：
  join 等待同一个首连结果，与发起者同成功、同失败；不得因“尚无 attachment”立即拒绝。
- 迟到的 ready、port 或旧 timer 不能回收新 generation；失败精确释放本次 attachment。
- Main 已删除 route（例如 Source 换代 ready 超时后回收换代 session）之后收到的 ready ACK，说明 Renderer
  晚于放弃才登记了这次 attachment。Main 回给该窗口一条释放通知；Renderer 只在当前登记仍是这个 attachment
  时注销 session，不改 tab。释放通知由 ACK 触发，ACK 在登记之后发出，所以释放一定晚于登记。
  route 仍存在时的迟到 ACK 只忽略。
- Desktop 继续 continuous；手机继续共享已有 Host 的 replayable attachment，Main/relay 不持有业务 snapshot。

## 冷启动选择与存量 Renderer 挂回

[虚拟项目 F5](../superpowers/specs/2026-09-09-virtual-project-design.md) 是新版持久化权威：
冷启动只从 `lastActiveWorkspace` 恢复活动执行目录，其他项目入口从 Host SQLite 读取，用户打开时
再创建 attachment。`lastWorkspaceSession` 是降级兼容投影，不是新版 open set；不得因其中有 A/B
就要求冷启动生成 A/B 全部 tab。没有新字段的旧设置仍沿用一次性导入与 active-first 补齐。
以下“全部 open 项目”只指当前 Renderer 实际保留的断连 tabs，不指旧字段中的所有目录。

```text
冷启动：Host 保存的连接 → Source online
        lastActiveWorkspace → 活动 tab → attachment
        Host 项目入口 → 用户打开其他项目 → 该目录 attachment
同窗口断线恢复：当前已有 tabs → Source online → 逐个挂回，不抢焦点
```

## 两级恢复门禁

1. Host 冷启动对全部保存的连接按最近在线时间排序各尝试一次，不再按 7 天过滤；只使用默认 Profile 可静默取得的凭据，并尊重全局自动重连关闭开关。legacy、需交互/升级/迁移确认的候选保持手动。
2. Renderer 只在 Management 观察到 Source online 后恢复当前窗口该 Source 下的 open、断连、stable identity 项目；不再按 workspace 年龄或上次 connected 状态过滤。
3. 目录有效性由 Host admission 校验；某项目失败不阻止其它项目。远程 conversation UI 已停用，其历史 entries 不进入恢复候选。
4. 每周期去重；terminal close 后未观察到 offline 不立即自恢复。active-first 后到 siblings 按 workspace key 检查，不能被 Source 级 attempted 标记吞掉。

## 导航恢复与挂回门禁（RDUX-09）

主窗口恢复上次激活的远程项目与会话选择，见 [导航规格 §2.3](./project-first-remote-navigation-spec.md#23-重连与重启后回到原处rdux-09)。这里的“Source 上线不自动激活”约束保持：启动位置由页签持久化决定，后台重挂不改写焦点。Host 仍只预热本地路径，Renderer 可先激活远程占位；首次 ready 前不读取/渲染远端内容，失败或未连接保持原页签与横幅。已加载内容按现有 owner 保留只读；手机 replayable 不消费桌面导航恢复。

## Manual Disconnect Boundary

用户主动断开是当前窗口内的终止意图，不属于启动恢复或异常断线恢复。Source 状态事件只有进入
`online` 时才可触发历史 workspace 的启动恢复；已有 tab 从 live session 变为断连占位时，只更新
断连状态，不重新触发恢复。active-first 启动补齐新断连 tab 仍可触发一次候选重算。

Directory delta 本身仍不是重连信号；但当它首次补齐
`legacyWorkspaceIdentity -> remote:server:*` 映射时，Renderer 必须先同步重投影已恢复的内存 session
和断连 tab。后续是否恢复仍只由 Source `online`、open membership、stable identity 与每连接周期一次的去重门禁决定；静默凭据与全局自动重连开关在 Host 启动重连处执行。
不得把普通重命名、删线路、记录打开项目或孤立的 `failed` history 扩大成自动恢复 initiator；Source
flight 获准后，failed open entry 只作为该 flight 的恢复成员。

自动恢复的 owner 是 online Source，不是某个 workspace initiator。Source `online` 只决定是否允许启动
本轮 Source flight；flight 启动后必须遍历该 Source 当前窗口内全部 open 且 disconnected 的 entries，不按工作区年龄或上次 connected 过滤。
成员已经 live 或正在另一个恢复 flight 中时只结算该成员，不能把整组标记为 skipped。手动连接尚未 online
的 Source 继续复用 Host 的设备连接 initiator/credential gate，不扩大本规则。

## 回归与证据边界

| 稳定 ID         | 合同与原记录状态                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------- |
| DRS-RR-01       | 同窗口 ready 更换 attachment、沿用 session；原 unit covered。                                                             |
| DRS-RR-02/05    | pending 不投递；base ready 前暂存 remote port；原 Accepted Cases 为 planned，不能由候选表推定通过。                       |
| DRS-RR-03/08    | 两级恢复、legacy→stable 重投影；原 unit / 真实 SSH covered，仅适用于记录基线。                                            |
| DRS-RR-04/06/07 | 手机边界不变；不合格启动候选保持断连；主动断开不触发自恢复。                                                              |
| DRS-RR-09       | 获准 Source flight 跳过已 live 成员并继续 siblings；当前 UI 只恢复项目。                                                  |
| DRS-RR-10       | 重复 connect 的 route/attachment join；原 conversation 场景为 unit + real SSH pending。旧 UI 场景不作为当前导航通过证据。 |
| DRS-RR-11       | 首连 Provisioning 期间的 join 等待同一首连结果、共享成败；unit + 本机 Docker 真实 SSH E2E covered（RPN-18 用例）。        |

启动的 10 秒预算只属于 Host physical flight；超时先结算稳定错误，再 abort 并精确取消 transport。
Renderer 不能抢先调用 connectProfile 扩大同一恢复 flight，迟到握手不得注册 online。

测试文件及执行证据见[覆盖矩阵](../testing/conversation-session-e2e-coverage-matrix.md)；旧候选表、
Accepted Cases 和历史限制完整保存在 `git show a17a875588b8d66c2bee49236292e174df651363:docs/remote/desktop-remote-session-renderer-reattach.md`。
本次仅修正文档，不补记运行结果或改变 formal/pending 状态。
