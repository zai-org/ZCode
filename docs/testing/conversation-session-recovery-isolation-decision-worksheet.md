# Conversation Session Recovery And Isolation Decision Worksheet

目标：把 `D01-D05`、`L01-L08`、`W01-W05`、`X01-X03` 这 21 个存储、生命周期、workspace 外部变化、跨 session 隔离 case 拆成可确认、可回写、可自动化的产品合同。本文只整理决策面和验证面，不替产品决定最终行为。

关联文档：

- 环境故障 catalog：[conversation-session-environment-fault-catalog.md](./conversation-session-environment-fault-catalog.md)
- 决策 backlog：[conversation-session-decision-backlog.md](./conversation-session-decision-backlog.md)
- FS 故障注入协议：[e2e-fs-fault-injection.md](./e2e-fs-fault-injection.md)
- Workspace remote 架构：[web-remote-control/web-remote-control-architecture.md](../web-remote-control/web-remote-control-architecture.md)
- Task realtime sync：[web-remote-control/task-realtime-sync.md](../web-remote-control/task-realtime-sync.md)

## 当前基础设施边界

| 能力 | 可覆盖的 case |
| --- | --- |
| `ZCODE_E2E_FS_FAULTS` | session DB 写入、workspace 父目录创建 / 非原子写入 / 删除、settings/provider 保存、日志/artifact 写入 |
| SQLite fault injection | DB open、migration、history write 的 `ENOSPC/EACCES/open_failed` |
| replay/capture network artifact | 生命周期或断连前后的模型请求、SSE 请求、compact 请求是否继续 |
| renderer store helpers | task runtime、queue、permission request、workspace init state、activeInputId |
| task realtime bus / host exit logs | host crash、remote disconnect、owner command failure、snapshot invalidation |
| multi-session E2E 基础路径 | A/B/C session 并发、inactive stream 不覆盖 active session 的正向断言 |

还没定义的是产品口径：用户最终看到什么、是否保留 queue、是否自动恢复、是否允许继续操作、桌面 continuous 和 mobile replayable 是否同一口径。

## 当前统计

| 指标 | 数量 |
| --- | ---: |
| Recovery/Isolation case | 21 |
| Recovery/Isolation 协议题 | 21 |
| answered | 0 |
| unanswered | 21 |

## 通用决策维度

| 维度 | 必须确认 |
| --- | --- |
| 用户可见状态 | inline error、toast、任务列表 badge、workspace banner、只读模式、设置页错误分别怎么用 |
| 运行态 | 当前 turn 是继续、失败、interrupted、notReady，还是只记录 warn |
| queue / draft | queue、composer draft、pendingAction、pending permission 是否保留 |
| 恢复策略 | reload/relaunch/reconnect 后自动恢复、显示恢复失败，还是要求用户手动重试 |
| 操作能力 | 继续发送、retry、edit、fork、compact、stop、设置保存分别是否可用 |
| 持久化 | 已显示但未落盘的 user/assistant/timeline/error 如何处理 |
| 多端边界 | desktop continuous 与 mobile replayable 是否同口径；是否需要区分 workspaceIdentity |

## P1/P2 协议题索引

这张表是给审计脚本读的 case-level 协议面。`Status=unanswered` 表示该 fault case 仍不能回写为 `accepted`，也不能写稳定 E2E 断言；此时 `产品结论` 必须保持 `待确认`。产品确认后，先写下明确产品结论，再把对应行改成 `answered`，最后回写 fault catalog / coverage matrix。

| Question | Case | Status | 产品结论 | 需要确认 | 验证关键词 | 回写目标 |
| --- | --- | --- | --- | --- | --- | --- |
| D01.1 | D01 | unanswered | 待确认 | session history 写入 ENOSPC 后 UI 告警、内存态、queue、relaunch 语义 | sqliteRun fault、DB、queue、relaunch | fault D01、fault coverage D01 |
| D02.1 | D02 | unanswered | 待确认 | tool 写 workspace 文件失败后的 tool block、assistant 后续、当前轮状态、重试入口 | workspace 父目录创建 / 非原子写 fault、tool block、file content | fault D02、fault coverage D02 |
| D03.1 | D03 | unanswered | 待确认 | provider/settings 保存失败后的表单错误、输入保留、配置回滚、发送阻断 | settings/provider fault、form state、config file | fault D03、fault coverage D03 |
| D04.1 | D04 | unanswered | 待确认 | 坏 DB/snapshot 启动恢复时是跳过、隔离备份、阻止进入还是显示恢复错误 | corrupt DB、workspace init、restore UI | fault D04、fault coverage D04 |
| D05.1 | D05 | unanswered | 待确认 | 日志/artifact 写入失败是否用户可见，主流程是否继续，截断回退是否接受 | log fault、artifact fallback、warn | fault D05、fault coverage D05 |
| L01.1 | L01 | unanswered | 待确认 | 切到其他 app/最小化后 agent/SSE 是否继续，回前台如何追流和提示 unread | background、foreground、stream、draft | fault L01、fault coverage L01 |
| L02.1 | L02 | unanswered | 待确认 | close/hide 窗口时 host/agent 是否继续，重开窗口如何恢复，平台差异如何处理 | window close、host lifecycle、task restore | fault L02、fault coverage L02 |
| L03.1 | L03 | unanswered | 待确认 | quit/relaunch 后 running turn 是 interrupted/failed/notReady/replay resume，queue 如何恢复 | app quit、snapshot、queue、timeline | fault L03、fault coverage L03 |
| L04.1 | L04 | unanswered | 待确认 | renderer reload/crash 后 continuous 链路、queue、activeInputId 如何恢复 | renderer reload、store rehydrate、snapshot | fault L04、fault coverage L04 |
| L05.1 | L05 | unanswered | 待确认 | host process crash 后是否自动重建，UI 状态和 pending permission/queue 如何处理 | kill host、owner lost、workspace notReady | fault L05、fault coverage L05 |
| L06.1 | L06 | unanswered | 待确认 | agent process crash/exit 后错误码、自动重启、当前轮和 queue 是否保留 | kill agent、PROCESS_EXIT、queue | fault L06、fault coverage L06 |
| L07.1 | L07 | unanswered | 待确认 | sleep/wake 后继续等待、自动失败、自动 reconnect 还是提示手动恢复，超时阈值 | sleep/stall simulation、transport close | fault L07、fault coverage L07 |
| L08.1 | L08 | unanswered | 待确认 | compacting 时 app 退出后 marker、pendingAction、queue 如何恢复 | compact quit、marker、pendingAction | fault L08、fault coverage L08 |
| W01.1 | W01 | unanswered | 待确认 | workspace 缺失后输入、历史、file tree、tool 调用是只读/锁定/允许失败 | workspace missing、composer、file tree | fault W01、fault coverage W01 |
| W02.1 | W02 | unanswered | 待确认 | tool 读写中目标文件外部变化后的 tool error、assistant 是否知道失败、是否一键重读/重试 | stale write、not_found、assistant | fault W02、fault coverage W02 |
| W03.1 | W03 | unanswered | 待确认 | git repo 缺失或 dirty state 改变后 UI 是否自动探测，agent 下一轮是否刷新 git context | git capability、action menu、env context | fault W03、fault coverage W03 |
| W04.1 | W04 | unanswered | 待确认 | remote disconnect 后 desktop continuous 和 mobile replayable 分别如何展示、重连、保留 pending | remote disconnect、clientMode、workspaceIdentity | fault W04、fault coverage W04 |
| W05.1 | W05 | unanswered | 待确认 | pending permission 切换/关闭/断线时保留、过期、自动 reject 还是绑定 active session | permission queue、task store、response routing | fault W05、fault coverage W05 |
| X01.1 | X01 | unanswered | 待确认 | A 后台主请求失败时 B 是否完全无感，是否全局 toast，A item 如何标记 | inactive failure、active DOM、task list badge | fault X01、fault coverage X01 |
| X02.1 | X02 | unanswered | 待确认 | A 后台 compact 失败时 B toolbar/sidebar 是否隔离，A marker 和全局提示如何展示 | inactive compact failure、switch back | fault X02、fault coverage X02 |
| X03.1 | X03 | unanswered | 待确认 | 从 B 切回 A error 时 error、queue、buttons、restore failed 区分如何恢复 | switch back、error detail、buttons | fault X03、fault coverage X03 |

## D. 文件系统 / 存储故障

| ID | 故障 | 当前代码观察 | 必须确认的产品结论 | 建议 E2E / 断言 |
| --- | --- | --- | --- | --- |
| D01 | session history 写入 `ENOSPC` | SQLite 写入前可注入 fault；失败前不会落入对应消息表 | UI 是否告警；内存态是否继续；queue 是否保留；重启后未落盘 turn 是丢失、恢复失败还是标记异常 | `sqliteRun` fault；断言 UI、DB、relaunch、queue |
| D02 | tool 写 workspace 文件时磁盘满/无权限 | workspace 文件写入错误会归一为 `io_error` / `permission_denied`；当前 fault injection 覆盖父目录创建、非原子写入和删除边界。默认 atomic temp/rename 不注入；atomic 路径失败后会清理 temp 并 fallback 到 `O_TRUNC` 非原子写，可能截断目标文件，当前作为既定行为暂时接受 | tool block 是 failed、assistant 是否继续解释失败、当前轮是否 failed、是否提供重试/打开文件入口 | workspace 父目录创建 / 非原子写 fault；断言 tool block、文件内容、assistant 后续 |
| D03 | provider/settings 保存 `EACCES/ENOSPC` | settings/provider 写入会 reject；失败不会创建新文件或会清理 temp | 设置页 inline error/toast；表单输入是否保留；是否回滚旧配置；是否阻止继续发消息 | settings/provider fault；断言表单、文件、模型选择状态 |
| D04 | 启动恢复时 DB/snapshot 损坏 | DB open/migration failure 有结构化错误；startup opener 没有坏库隔离策略 | 跳过坏 session、隔离备份、阻止进入 workspace，还是显示恢复错误；是否允许导出日志/重建库 | corrupt DB fixture；断言 task list、workspace init、恢复入口 |
| D05 | 日志/artifact 写入失败 | 日志 sink 吞错；tool artifact 失败回退截断 inline 且工具成功；checkpoint artifact 失败 warn | 哪些 artifact 失败必须用户可见；日志缺失是否提示；大输出截断回退是否可接受 | artifact/log fault；断言主流程继续、warn、inline truncation |

### D 组回答模板

```text
D01 = UI 告警 / 内存态 / queue / relaunch：
D02 = tool block / assistant 是否继续 / 当前轮状态 / 重试入口：
D03 = 设置页错误 / 表单保留 / 配置回滚 / 是否阻止发送：
D04 = 坏 DB/坏 session 恢复策略 / 日志导出：
D05 = 日志-artifact 失败是否用户可见 / 主流程是否继续：
```

## L. App 生命周期 / 进程故障

| ID | 故障 | 当前代码观察 | 必须确认的产品结论 | 建议 E2E / 断言 |
| --- | --- | --- | --- | --- |
| L01 | 切到其他 app / 最小化 | composer draft 会在 blur/pagehide/freeze/hidden 保存；没有 pause running session 逻辑 | 后台是否继续 agent/SSE；回前台是否追流/补快照；通知和 unread 如何表现 | background/foreground；断言 stream、draft、unread |
| L02 | 关闭当前窗口但不退出 app | macOS close 默认 hide；真正 closed 才 dispose host；Windows close-to-tray 另有配置 | close/hide 是否继续运行；重开窗口如何恢复；最后窗口与非最后窗口是否区分 | window close/open；断言 host/agent、task runtime、logs |
| L03 | 退出 app 后重新打开 | quit 会等待 host/agent dispose；更像主动回收运行中 agent | relaunch 后 running turn 是 interrupted、failed、notReady，还是恢复 replay | quit/relaunch；断言 snapshot、timeline、queue、network |
| L04 | renderer reload/crash | dom-ready 会重建 host；历史 task 走 resume/snapshot；restore 失败设 notReady/workspace failed | reload 期间 queue/activeInputId 是否保留；continuous 是否补快照还是 interrupted | renderer reload；断言 store rehydrate、snapshot、queue |
| L05 | host process crash/restart | host unregister 会失败 pending owner/session deliveries，释放 lease 并发 snapshot invalidation | 是否自动重建 host；UI 是全局错误还是 workspace notReady；queue/permission pending 如何处理 | kill host；断言 taskRealtimeBus、UI、logs |
| L06 | agent process crash/exit | stdio close 会 reject pending request；process manager 移除 client；UI 可能只看到 protocol close | 是否自动重启 agent；错误码是否统一 `PROCESS_EXIT`；当前轮/queue 是否保留 | kill agent；断言 task_error、queue、retry |
| L07 | 系统 sleep/wake | 没有专门 `powerMonitor` 处理；靠 stall/transport close/restore 兜底 | sleep 后继续等待、自动失败、自动 reconnect，还是提示手动恢复；超时阈值 | sleep/stall 模拟；断言 reconnect、timeout、stop |
| L08 | compacting 时 app 关闭/退出 | 没有专门 compact quit 路径；取决于退出前 marker 写入和恢复 snapshot | compact marker 是 failed、interrupted、unknown 还是移除；pendingAction/queue 如何恢复 | compact quit/relaunch；断言 marker、queue、请求 |

### L 组回答模板

```text
L01 = 后台是否继续 / 回前台追流 / unread：
L02 = hide/close 语义 / host-agent 是否继续 / 重开恢复：
L03 = quit 后 running turn 状态 / queue / 用户提示：
L04 = renderer reload 后 continuous 恢复 / queue / activeInputId：
L05 = host crash 后 UI / 自动重建 / pending：
L06 = agent crash 后错误码 / 自动重启 / queue：
L07 = sleep-wake 策略 / 超时阈值：
L08 = compact quit 后 marker / pendingAction / queue：
```

## W. Workspace / Tool 外部变化

| ID | 故障 | 当前代码观察 | 必须确认的产品结论 | 建议 E2E / 断言 |
| --- | --- | --- | --- | --- |
| W01 | workspace 目录被删除/重命名 | 文件/目录缺失会在调用时变成 `not_found`；Git missing cwd 降级为非仓库 | 是否锁输入、提示重选、保留只读历史，还是允许继续但 tool 失败 | fs mutation；断言 composer、file tree、tool、history |
| W02 | tool 读写中目标文件被外部修改/删除 | Write 返回未读（errorCode 2）/ 已过期（3）；FS revision 不匹配是 `stale_write` | tool error 如何展示；assistant 是否知道失败；是否一键重读/重试 | external file mutation；断言 tool block、文件、assistant |
| W03 | git repo 不存在或 dirty state 改变 | Git resolve 区分 unavailable/non-repo；Git action menu 依赖 `isRepository`；agent git context 是 start snapshot | UI 是否自动重新探测；agent 下一轮是否刷新 git context；旧轮是否保留 snapshot | git repo mutation；断言 action menu、context、tool/log |
| W04 | remote SSH/WSL/Docker 连接断开 | remote host dispose 并退出；realtime bus 发 owner lost invalidation；remote attachment 要 workspaceIdentity | desktop continuous 与 mobile replayable 各自展示什么；是否自动重连；queue/permission 是否保留 | remote disconnect；断言 clientMode、workspaceIdentity、snapshot invalidated |
| W05 | permission request pending 时切换/关闭 | permission request 是 task 级队列；snapshot 会重放 pending；client close 清理 service pending | pending permission 保留、过期、自动 reject，还是绑定 active session；跨端响应如何同步 | pending permission；断言 task store、notification、response routing |

### W 组回答模板

```text
W01 = workspace missing 后输入/历史/file tree/tool：
W02 = stale write / not_found 后 tool/assistant/retry：
W03 = git capability 自动刷新 / agent context：
W04 = remote disconnect desktop/mobile 策略 / 重连 / pending：
W05 = permission pending 切换/关闭/断线策略：
```

## X. 跨 Session 故障隔离

| ID | 故障 | 当前代码观察 | 必须确认的产品结论 | 建议 E2E / 断言 |
| --- | --- | --- | --- | --- |
| X01 | A running，B active，A 主模型请求失败 | runtime/error/messages 按 workspaceIdentity + taskId 写入；terminal 按 activeInputId 丢旧 input | B 是否完全无感；是否允许全局 toast；A 列表 item 是否显示 error badge | inactive failure fixture；断言 active DOM、A list item、switch back |
| X02 | A compacting，B active，A compact 失败 | compact marker 属于 task timeline，按 taskId restore | B toolbar/sidebar 是否完全不受影响；A marker 是否只在切回 A 展示；是否全局提示 | inactive compact failure；断言 B DOM、A snapshot、switch back |
| X03 | A error，B active，切回 A | restore/snapshot 按 taskId 回填 pending/runtime/messages；完整错误对象在 task store | 切回 A 后 error banner、queue、retry/edit/fork/compact 如何恢复；restore failed 与 task failed 怎么区分 | switch-back error；断言 buttons、queue、error detail |

### X 组回答模板

```text
X01 = B 是否无感 / 全局 toast / A item badge / 切回 A：
X02 = B toolbar-sidebar / A compact marker / 全局提示：
X03 = 切回 A 后 error / queue / buttons / restore failed 区分：
```

## 验证分层

| 层 | 断言 |
| --- | --- |
| UI | chat view 状态、workspace banner、task list badge、error block、permission dialog、action buttons |
| Runtime/Store | taskRuntime、taskUi error、queue、permission queue、workspaceInitState、activeInputId、stopRequested |
| Process/Protocol | host exit、agent exit、owner command failure、session message delivery failure、snapshot invalidated |
| Files | DB/session snapshot、workspace 文件、settings/provider config、logs/artifacts |
| Network | running/compact 请求是否继续、中断、重试；remote disconnect 前后的 capture |
| Multi-client | desktop continuous 与 mobile replayable 是否按 clientMode / deliveryKind 分离 |

## 建议落地顺序

1. `D03`：settings/provider 保存失败，最接近普通 UI 表单，容易先闭环。
2. `D02/W02`：tool 文件写入失败和外部修改，能复用已有 fs fault 与 tool block。
3. `X01/X03`：跨 session error 隔离，直接补当前多 session 正向用例的反向 fault。
4. `W05`：permission pending 切换/关闭，已有 store/runtime monitor 单测基础。
5. `L01/L04`：background/reload，优先验证 UI 恢复，不先碰真实进程崩溃。
6. `D01/D04/D05/L02-L08/W01/W03/W04/X02`：依次补齐更重的 relaunch、host/agent、remote、compact 断连。

确认后回写规则：

1. 更新 `docs/testing/conversation-session-environment-fault-catalog.md` 对应 case 的产品预期和 Review。
2. 更新 `docs/testing/conversation-session-decision-backlog.md`，移除已经确认的行或标注已转 accepted。
3. 在 `docs/testing/conversation-session-e2e-coverage-matrix.md` 增加 fault spec 缩写，并把对应 fault case 从 decision-needed 进入 `missing/covered` 跟踪。
4. 写 fault fixture / WDIO spec / 必要的 unit helper。
5. 跑 `pnpm audit:conversation-session-coverage`、目标 spec、`pnpm typecheck`、`pnpm lint`。
