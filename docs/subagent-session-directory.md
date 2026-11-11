# Subagent Session Directory

## 目标

父 Session 的子智能体状态使用一份只读投影，同时驱动 composer 实时入口、右上角摘要、
子智能体目录和失效 tab 清理。目录只展示当前有效 conversation branch 中能够可靠关联到
已持久化 `subagent_child` session 的 Agent/Task 调用，不创建占位 session，也不新增数据库表。

Workflow activity 不进入该投影，现有 Workflow 数据结构和交互保持不变。

## 权威与查询

```text
child runtime ── persist subagent_child session ── SubagentSpawned/status/stopped
                                                   │
                                                   ▼
CLI ProductProjection V4 snapshot.subagents
├─ revision
├─ childSessionIds[]（当前 branch manifest）
├─ running[]（完整、不分页）
└─ endedTotal
       │
       ├─ desktop-continuous ────────────────┐
       └─ web-remote-replayable snapshot/gap ├─ UI 纯消费
                                             └─ UI 仅用 session/subagents 查询 ended 分页详情
```

- V4 `snapshot.subagents` 是当前 branch 的唯一运行态权威；composer 数量、状态摘要、运行项、
  child tab 失效清理都直接消费该投影，不再另发 `session/subagents` 查询来重建 running 状态。
- UI 对 `session/subagents` 仅消费已结束详情的 keyset 分页，不参与运行中成员计数或 tab
  manifest；响应中的旧 running/manifest 字段只作协议兼容与 CLI 冷恢复校验，不再是 renderer 权威。
- `SubagentSpawned` 对外可见前，child session 必须已经持久化且可读取为
  `taskType=subagent_child`。run、background start 和 resume 使用同一顺序，不允许投影先公布一个
  尚不存在的 child，也不通过 renderer 延迟、轮询或切换 Session 自愈。
- 同一次 CLI 投影提交原子更新 `childSessionIds`、`running`、`endedTotal` 和对应 Agent row；
  UI 不在事件和查询之间做二次拼接。`revision` 只随该投影提交递增，迟到或重复 delta 不得回退状态。

- active branch 使用 append-only transcript 的 `keptMessageIDs + branchCutAfterMessageID` 语义；
  compact 只压缩 provider context，不删除目录成员。
- edit/retry 移除的旧分支 child 立即退出投影；fork 继承复制 transcript 中可靠的已结束
  `childSessionId` 引用，但不继承原 Session 的运行态。
- 关联优先读取 tool output/metadata 中的 `childSessionId`；foreground 完成结果只有稳定
  `agentId` 时，按 Agent runtime 的正式 `sess_subagent_{agentId}` 身份规则构造并再次验证对应
  session 确实存在且 `taskType=subagent_child`。运行中的 foreground 使用 parent event log 的
  `parentToolCallId -> childSessionId` 关系，并且仍须命中 active branch tool call；不按标题、时间
  或列表位置猜测。
- 已运行 child 在模型请求、工具或取消失败后通常已经持久化；若失败发生在首次持久化之前，
  或历史记录无法可靠证明 child 关联，则不展示 stub。
- `running` 包含 foreground、background、blocked 和 waiting；success、failed、cancelled、lost
  统一属于 `ended`，每项继续保留具体状态。
- 上一代 runtime 进程退出时仍在运行的 child（启动早于本进程、本进程无活事实、child 在本进程启动后
  没有落盘）不再算 running；旧进程写在输出目录 `metadata.json` 里的终态（正常关闭时的停止、失败、完成）照常显示为 cancelled / failed / success，没有终态的标 `lost`。判据与给模型的中断提醒见
  [Subagent 工具「上一代 runtime 遗留的 Agent」](../apps/zcode-cli/docs/design/v2/tool/07-subagent.md)。
- 冷恢复先从持久 transcript 重建 row，再以 session store 中已验证的
  `taskType=subagent_child` 事实校验成员；旧历史里模糊、未持久或已被 branch cut 移除的引用不能进入
  `snapshot.subagents`。运行中的恢复态由 runtime overlay 补齐，不能仅凭历史标题或时间猜测。
- 已结束查询响应携带独立查询 `revision`，使用稳定 keyset cursor、每页 20 条、最新优先。
  `snapshot.subagents.childSessionIds` 是当前 branch 的 tab 失效清单，不是第二份展示数据。

## UI 合同

```text
mini capsule
├─ subagent-only -> 只统计 running subagent；不显示 ended；显示“{count} 运行”
└─ Bash/Subagent mixed -> 统计两类 running item；显示“{count} 运行”

expanded status panel
└─ 智能体（统一折叠分组，标题尾部显示“{count} 运行”）
   ├─ 正在运行 -> 现有运行项，可直接打开 child 详情；可控 foreground/background 项提供 Stop
   └─ 已结束 · N -> 打开或复用 Subagent 目录 tab

Subagent directory（桌面 / 普通 Web）
├─ 正在运行（不分页）
└─ 已结束 · N
   ├─ newest first
   └─ 再显示 20 个
```

- “{count} 运行”统计 `snapshot.subagents.running` 的成员数量，表达当前仍在运行的
  subagent 数量；不得显示为“{count} 后台”，因为该集合同时包含 foreground、background、
  blocked 和 waiting。
- mini capsule 的计数只要包含 running subagent，也必须使用“{count} 运行”；只有纯
  background terminal 计数继续使用“{count} 后台”。
- 只有 ended 且没有 Git/plan/goal/running 等其它摘要内容时，mini 可以消失；不为目录增加
  单独常驻胶囊。
- expanded panel 中“已结束”必须位于“智能体”折叠内容内，不能与“智能体”作为两个并列的
  顶层 section；没有 running、但 panel 因其它摘要内容存在时，仍可显示只含“已结束”的
  “智能体”分组。
- expanded panel 的运行项以 V4 `snapshot.subagents.running` 作为 child 身份、展示和 Stop
  能力的事实源。仅 runtime 确认当前执行支持单项停止时，running 项携带 `stopControl`
  （`taskId` 与本次执行的 `executionId`）；UI 不再关联 `backgroundWorks` 推断 Agent Stop，
  也不得用 agentId、标题或时间猜测。点击发送父会话的 `stopSubagent`，由该会话 runtime
  校验 task 归属、执行身份和未结束状态；迟到命令不能停止同一 agentId 经 `SendMessage`
  恢复的新执行。没有能力字段时不显示 Stop。按钮阻止详情点击冒泡；请求期间禁用重复操作，
  失败反馈可见，成功后等权威投影移除运行项，不在 UI 提前删除。`cancelBackgroundWork`
  仍用于 Bash/Workflow 的既有控制，不扩大其语义。
- Stop 只结束目标 child，不取消父 turn 或其它 child。前台取消经原 Agent 工具调用返回停止
  结果，不发后台终态通知，也不把已停止任务重新写为 failed；后台沿用 killed 通知和
  `SubagentStopped(stopped)`。产物写入或通知入队失败仍取消目标并发布结束事件，再明确
  报告失败，不回滚 killed。
  结束事件携带 `executionId`，投影拒绝旧执行的迟到终态。完成与停止竞争时只提交先到的
  终态，另一侧不得覆盖或重复通知。
- `stopControl` 是当前 runtime 能力，不持久化为历史权限。冷恢复仅重建成员和展示；旧事件、
  失效 child、已结束任务及没有活 runtime 证明的 running 行不提供 Stop。桌面 continuous 和
  手机 replayable 消费同一投影，命令执行时仍做 runtime 校验。
- 目录项展示 Agent description、最终摘要或错误、相对时间、状态图标；目录只读，不新增
  stop/cancel 控件。
- live completion 由 V4 投影把同一项移出 running 并更新 `endedTotal`；目录随后按 ended-only
  查询把该项合并到顶部，但保留已加载页面和滚动位置。
- 目录 tab 稳定身份为
  `subagent-directory:{workspaceKey}:{rootSessionId}:{parentSessionId}`；child tab 为
  `subagent-session:{workspaceKey}:{rootSessionId}:{childSessionId}`。
- 点击目录项复用统一 child 详情打开请求。同一 root 内重复点击复用；原 Session 与 fork
  root 不同，因此可以各自持有指向同一历史 child 的 tab。
- edit/retry 使 child 失效时自动关闭对应详情 tab，不进入“最近关闭”；若当前激活的是该 tab，
  优先回到已打开的目录，否则回到前一个可见 tab。compact 不关闭 tab。
- 目录 tab 和 child tabs 都只保存在 renderer 内存，不跨刷新恢复。

## 多端边界

- 桌面端与普通 Web 提供目录及分页。
- 手机 `/remote` 不提供目录；Agent/Task 和 Running 行仍可在现有右侧抽屉打开 child 详情。
- 桌面继续使用 `desktop-continuous`，手机继续使用 `web-remote-replayable`；两端消费同一 V4
  `snapshot.subagents`，手机重连仍由既有 snapshot/gap 恢复。ended-only 查询通过当前 trusted host
  attachment 到同一 CLI/runtime，不在 relay、desktop main 或 Host 增加状态。
- remote workspace 贯穿 `workspaceIdentity` 和 `remoteSessionId`；身份 key 始终为
  `workspaceIdentity?.trim() || workspacePath`。

## 可访问性、主题和国际化

- 目录 section 和 item 使用语义标题、button、可见 focus；状态不能只靠颜色表达。
- 使用 `DESIGN.md` 的 surface/text/border/semantic token，兼容 Zai Light/Dark。
- 文案通过 zh-CN/en-US locale；标题和摘要允许长文本换行或截断，不依赖中文长度。

## 持久化 workspace 与执行目录（2026-10-26）

- Bash `cd` 只修改执行 cwd。Agent 子运行时继承父运行时稳定的 workspacePath / workspaceIdentity，正文和父子关系仍由 CLI 持久化。
- 历史辅助会话若缺 workspace identity，允许沿持久化 parentID 找到目录 owner，旧 cwd 可以与 owner 不同。只有最终 owner 的路径和身份均匹配请求 workspace 才允许打开；显式外部身份、删除、断链、环一律拒绝。不得把 child 写成 Host 普通任务。
- 元数据查询、显式 resume、桌面 continuous 和手机 replayable 冷订阅使用同一父链判定。Host 反向回调只消费 CLI 已验证的 directorySessionId，不反向查询阻塞中的 CLI 队列。
- 回归须实际执行 Bash cd 后创建 Agent、检查 SQLite 身份，再重启打开历史正文；历史错误 cwd 单独覆盖，不以新数据测试替代。
