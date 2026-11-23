# Fork Session Title Design

## 背景（历史问题）

用户报告 fork 出来的 `sess_0f8d6d7c-d682-49ec-b925-f91552c2fa73` 在列表标题显示为「新任务」，但 fork child 应该显示为 `Fork of <parent title>`。运行时取证显示：

- `~/.zcode/cli/db/db.sqlite` 的 `session.title` 已经是 `Fork of Checkpoint复现目标`，`title_source=generated`。
- `v4/conversation/frame` 的 `sessions-index` 下行 delta 里同一 session 一直是 `title: ""`、`titleSource: "default"`。
- UI 看到空标题后按 `task.forkedFromTaskId ? taskList.forkedUntitled : taskList.untitled` fallback，因此显示「新任务」。

## 根因

fork child 的持久化标题只写入了 session store，没有进入 child 自己的 v4 event/projection。v4 sessions-index 的 live 摘要从 `ConversationSnapshot.meta.title` 派生，而 `ProductProjection` 只有收到 `SessionTitleUpdated` 事件才会更新 `meta.title`。fork child resume 后只产生 `SessionResumed`，没有补发已持久化的 title 事实。

同时，live `getSessionIndexMeta` 只返回 `createdAt` 和 `lastActivityAt`，未返回 `parentSessionId`，导致 fork 关系在 live sessions-index 摘要中也可能丢失。

```text
fork parent
  -> create child session in DB
       title = "Fork of <parent title>"
       parent_id = parent session
  -> create child runtime record
  -> child runtime resume
       before: SessionResumed only
       after : SessionTitleUpdated(generated) + SessionResumed
  -> child ProductProjection.meta.title
  -> sessions-index summary.title / parentSessionId
  -> UI task row/header
```

## 设计

### 当前命名规则（2026-11-12）

- CLI 创建 fork 时只对父标题做正则替换：末尾 `(数字)` 加一，没有则追加 `(2)`，不插入空格。例如 `任务 → 任务(2) → 任务(3)`、`任务(9) → 任务(10)`。
- 不查询数据库计数或去重。同一父任务重复 fork 都得到相同标题；正文中的括号及非数字后缀原样保留，旧 `Fork of ...` 也只作为普通父标题，不迁移存量。
- `titleSource=generated`、辅助对话标题及原有标题事实同步链路不变。
- 验收：CLI 覆盖后缀解析与重复 fork；既有 `conversation-session-fork-cold-start-membership.test.ts` 覆盖桌面首次/连续 fork、冷恢复标题及手机重复 fork 的同名结果。SSH/WSL 与 Windows/Linux 不扩展成本次必跑组合：命名在同一 CLI 纯字符串路径，无平台或交付方式分支。

```text
父标题 → CLI 正则生成 child 标题 → session store → sessions-index → 桌面/手机
```

### 标题事实同步

1. 在 runtime resume 路径中同步持久化标题到当前 runtime event stream。
   - 当 `session.title` 非空时，append `SessionTitleUpdated`。
   - `source` 使用持久化 `session.titleSource`；`first_input` 归一逻辑仍由 v4 projection 映射为 `generated`。
   - 事件必须由当前 child runtime 自己 append，避免 parent runtime 事件误投到 parent publisher。

2. 在 bootstrap live record 中保留 fork parent 关系。
   - `ZCodeProtocolSessionRecord` 新增可选 `parentSessionId`。
   - `createRecord` 从 `params.parentSessionId` 初始化该字段。
   - fork record 创建时传入 `parentSessionId: fork.parentSessionId`。
   - resume 老会话时从 session store 的 `parentID` 回填。
   - v4 bridge 的 `getSessionIndexMeta` 透传该字段。

3. 测试覆盖 live sessions-index，而不是只覆盖 DB。
   - 新增 core resume 回归：fork child 的持久化 generated title 必须在 `SessionResumed` 前补发 `SessionTitleUpdated`。
   - 扩展 v4 cold-resume 集成：fork child 不在 `roots: true` store seed 中，live sessions-index summary 仍必须包含 `parentSessionId`。
   - 保留现有 core fork DB title 测试。

## 非目标

- 不修改 UI fallback 文案。
- 不把 fork 命名逻辑下沉到 UI。
- 不改变 desktop continuous 与 web remote replayable 的恢复边界；两端继续消费同一 v4 event/sessions-index 事实。
