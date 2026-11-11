# Task File Change Summary

## 目标

任务结束后，把该任务涉及的文件改动汇总到任务标题和任务条目下方，同时保留后续接入回滚功能需要的轮次信息。

## 数据流

1. Agent runtime 的文件写入继续只记录原始 `fileChanges`
   - 会话文件追踪器在 `packages/services/src/session/fileChangeTracker.ts`
   - 每次写入都会把 `beforeContent` / `afterContent` 记到 session file change tracker

2. 任务摘要在读取任务列表时动态聚合
   - 聚合实现：`packages/services/src/session/taskChangeSummary.ts`
   - 注入位置：`packages/services/src/session/zcodeTaskService.ts`
   - 摘要字段挂在 `ZCodeTaskMeta.changeSummary`

3. UI 只消费摘要，不直接扫描完整快照
   - 格式化实现：`packages/ui/src/lib/taskChangeSummary.ts`
   - 任务列表：`packages/ui/src/TaskList.tsx`
   - 顶部标题：`packages/ui/src/App.tsx`

## 摘要结构

- `fileCount`: 任务涉及的唯一文件数
- `added` / `removed`: 按任务最终结果聚合后的总行数
- `files[]`
  - `path`
  - `added` / `removed`
  - `writeCount`
  - `lastTurnIndex`

## 回滚预留

- 真正的回滚仍然只依赖 `fileChanges`
- `changeSummary.files[].lastTurnIndex` 只是 UI 快速定位入口
- 后续如果要做“回滚整个任务”或“回滚单个文件”，直接复用 session file change tracker 的 rewind/truncate 能力

## v4 每轮文件摘要与文件撤销规划

v4 conversation 不复用旧 `session/previewFileRewind` / `session/applyFileRewind` 入口；每轮文件摘要和撤销要走 v4 投影与命令/查询边界。产品语义固定为“只撤销工作区文件修改”：撤销成功后不删除、不截断、不改写聊天历史，只把对应轮次的文件状态标记为已撤销。

### 状态与事件链路

```text
Write/Edit 等文件工具
  -> core 写入 workspace checkpoint artifact
  -> SessionEvent.CheckpointCreated(snapshotRef/diffRef/messageId/targetMessageId/toolMessageId)
  -> 同步写入既有 session_entry(runtime/workspace_checkpoint)，冷恢复时重建 checkpoint event
  -> v4 ProductProjection 按 stable messageId/turnId 归属到 turnHeader
  -> TurnHeader.fileChanges = { files, additions, deletions }
  -> UI 在该轮尾部显示文件摘要

用户点击撤销文件
  -> previewFileRewind(turn/message target)
  -> core previewWorkspaceFileRewind 做 hash 安全检查
  -> UI 弹窗展示 safe / unsafe / ignored 文件
  -> applyFileRewind
  -> core applyWorkspaceFileRewind 写回或删除文件
  -> SessionEvent.RewindTriggered(scope=workspace, reason=file_summary_rewind)
  -> 同步写入既有 session_entry(runtime/workspace_file_rewind)，冷恢复时重建撤销事件
  -> v4 ProductProjection 标记该轮文件已撤销，不触发 row.removed
```

### 投影边界

- `turnHeader.fileChanges` 只承载轻量摘要：文件数、总新增行、总删除行，以及后续需要的撤销状态；不要把完整 patch 或 before/after content 放进 replayable snapshot。
- 文件明细、readonly diff patch、preview safe/unsafe 列表按需从 host/core 查询；展开面板或点击撤销时再读取 checkpoint artifact。
- `CheckpointCreated` 的 event store 是运行时内存账本；checkpoint payload 还必须写入既有
  `session_entry`，child/main runtime 冷恢复时先重建事件再执行 preview/apply。该持久化复用现有表，
  不新增数据库表或 migration；artifact 仍是 before/after 内容的唯一大对象来源。
- workspace-only `RewindTriggered` 同样写入既有 `session_entry`；否则关闭详情或重启后会把已撤销
  turn 重新投影成 active。detached child cold resume 产生新的 raw event epoch 时，以
  `SessionResumed` 重设 gateway raw cursor，但 transport sequence 继续单调递增。
- 同一轮同一文件多次改动时，摘要按该轮最初 before 到最终 after 计算；中间 checkpoint 只用于安全撤销顺序，不重复累计展示行数。
- 归属和撤销目标优先使用 stable `messageId` / `turnId` / checkpoint id；`turnIndex` 只能作为旧数据兼容 fallback，不能作为新协议的主要定位。
- `CheckpointCreated(scope=workspace|both)` 可以贡献文件摘要；shell/bash checkpoint 如果 core 判为 ignored，撤销 preview 只展示 ignored，不作为可安全写回文件。

### 撤销边界

- 只允许在 session 空闲时执行文件撤销；running、compacting、permission/elicitation 等 active 状态下入口 disabled 或命令被拒绝，避免和正在写文件的 tool loop 竞争。这个 session 锁由 `availability.rewindFiles` 表达，行上的 `canRewindFiles` 只表达该轮是否可撤销。
- 因 session 锁禁用时，文件摘要的「撤销」按钮和撤销弹窗的「撤销文件」按钮在 hover 时显示同一条固定文案：会话正在运行或有待处理的请求，完成后可撤销。不按原因区分文案。弹窗打开后才加锁时，「撤销文件」按钮同步禁用，不发命令；锁解除后恢复可用。其他禁用原因（已撤销、运行时未就绪、只读 pane、preview 中有不能安全撤销的文件）不显示这条提示。编辑消息时「与文件一起重置」按钮因同一把锁禁用时，使用同一条文案。手机触屏没有 hover，只显示禁用态。
- preview 阶段如果任一文件存在外部修改、checkpoint 缺失、checkpoint 不可读或 unsupported patch，确认按钮 disabled；apply 不做部分写回。
- apply 成功后对话行保持不变，只在对应 turn 的文件摘要面板显示已撤销状态，并可保留 diff review 入口。
- Subagent 文件撤销只使用 child projection 的 `canRewindFiles` 与 `availability.rewindFiles` 门禁；父 task 是否仍在运行不新增
  父级 guard。父任务或外部进程对同一文件的修改继续由现有 hash preview 判为 unsafe。
- 右侧 child 详情保持 conversation 只读，仅把 preview/apply 作为显式 workspace capability；不得
  因此开放 composer、edit/retry/fork/stop 或 permission/elicitation response。
- detached live child 没有直接 bootstrap record 时，首次 preview 可以 cold resume 已持久化的
  child record，但不得启动新 turn；后续 apply 仍以 `childSessionId` 为命令 session。
- apply 只恢复真实 workspace 并把目标 child turn 标为已撤销，不改写父 Agent 行、目录、父 task
  aggregate 或任一聊天历史。
- 桌面端 `desktop-continuous` 通过 live delta 更新摘要和撤销状态；手机 `/remote` 的 `web-remote-replayable` 通过同一 host projection/snapshot 恢复，不在 relay 或 main 进程下沉 session/task/stream/file 状态。
- 远程 workspace 必须沿用 `workspaceIdentity` / `remoteSessionId` 贯穿 bridge、snapshot、撤销 target 和缓存 key；身份隔离使用 `workspaceKey = workspaceIdentity?.trim() || workspacePath`。

### UI 形态

- 每轮文件摘要显示在该 turn 的 assistant 工作区尾部，格式为 `N files changed +A -D`；移动端保持同等信息，但按钮和文件行更紧凑。
- 展开后展示每个文件的相对路径和 `+/-` 行数，不展示写入/修改次数；点击文件行或 Review 打开 code viewer diff。
- 写入/修改次数只在文件撤销预检弹窗中展示，用于解释撤销操作边界，不作为摘要行信息。
- 撤销按钮先打开 preview dialog；dialog 区分 safe、unsafe、ignored 文件，unsafe 原因必须可见。
- 手机远控继续隐藏“选择 App 打开”下拉，只保留应用内 diff review 和文件撤销能力。

## 消息内变更摘要交互

- 消息里的变更摘要默认只展开到文件列表，不再支持在单个文件行内继续展开 inline diff
- 单个文件行点击、Enter、Space 的行为与该行的 `Review` 按钮一致：打开右侧 code viewer 的 diff 预览
- `Review` 按钮保留文字入口，不展示图标，避免和整行点击入口形成重复视觉强调
- 文件行仍保留普通文件打开入口；手机远控继续隐藏“选择 App 打开”下拉，只保留应用内预览能力
- diff 预览源继续优先使用 readonly patch，没有 patch 时使用本轮 checkpoint 的 before/after snapshot

## 额外修正

- `task_error` 现在也会持久化本轮 `fileChanges`
- 这样失败任务同样能显示文件汇总，也不会丢掉后续回滚所需的数据
