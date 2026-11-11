# Task Unread State

## 当前约束

- task 的未读真相源统一为 tasks-index membership `unreadAt`
- UI 蓝点、Dock badge、任务选择后的已读清除，都只围绕 `unreadAt` 工作
- task query row 通过 membership join 消费 `unreadAt`；旧 `taskUnreadByTaskId`、`taskListCache` 和
  `optimisticTaskListByTaskId` 不再作为侧栏判断依据
- `lastActivityAt` 只负责 Updated 排序，不参与未读推导或清除

## 按未读视图（2026-10-20）

- 侧栏筛选新增“按未读”，位于“最近更新”之后，使用 Bell 图标与原单选勾。
- 未读集合与系统角标共用 Host `ProjectTree` 选择器：只收非归档且有 `unreadAt`
  的任务；包含跨项目置顶、本地未归类、未删除项目的任务。排除其余孤儿、已删除项目
  和远端未归类任务。按 `hostId + (workspaceIdentity || workspacePath) + taskId` 去重。
- 复用最近更新的行、日期标题与 20/+20 分页，按 CLI 更新时间排序，不按未读时间或置顶重排。
  无结果显示“暂无未读任务”。通知开关只控制系统角标，不影响此列表。
- 视图偏好沿用现有客户端存储与同源窗口同步；切换不改变当前任务、项目/分组折叠或任务组织态。
- 打开任务沿用桌面和手机的已读流程。Host 提交后列表自动移除已读行；迟到清除继续遵守
  `expectedUnreadAt` CAS。当前聊天不因筛选结果消失而关闭。

```text
Host tasks-index.unreadAt → 共享 ProjectTree → 共同未读选择器 → 按未读列表 / 系统角标
桌面或手机打开任务 → 原有已读命令（CAS）→ Host 提交 → 共享树刷新 → 列表更新
```

SBV07：桌面验证菜单、更新时间顺序、分页、重载偏好、已读移除与空态；
手机 shared-host 验证触摸筛选、打开真实任务清未读、返回后空态，且不增加 Host。
选择器单测覆盖归档、项目可见性、置顶、远端完整身份与去重；GUI 保持 pending。

## 关键链路

### 主动标记未读

- 入口：task 右键菜单、Header more 菜单
- 动作：调用 `zcodeTaskService.setTaskUnread(..., true)`
- renderer 只对 query row 应用 `{ unreadAt }` 字段 overlay；成功后与 tasks-index membership 对账，
  禁止把返回的整个 task meta 覆盖 session activity/status

### 被动标记未读

- 入口：Host 明确携带 `background_terminal` 的实时完成信号；普通 status、历史读取和 replay 不制造未读。仅 `completedSuccess`（且 Goal 已验证/无 Goal）与 `error` 产生该信号；`completedInterrupted` 表示用户主动停止、发新消息打断或新建对话时中断旧执行，不产生未读提醒。
- 动作：desktop base 的唯一目录 writer 判断查看状态，再经原 mutation 路由写 tasks-index；持久成功后刷新树，不先制造 UI 独有的未读。
- v4 sessions-index 重构后，后台运行态不再由旧 renderer monitor 持有；host
  `taskIndexSyncer` 只负责把 phase 终态收敛成 `task_status_changed`，不判断某个 renderer
  当前是否正在查看该 task。
- 查看状态认可桌面完整导航地址，或已连接 Web 前台实际显示的同一任务。Home、后台、草稿、遮盖的聊天和断线不算查看；不能仅看 activeTaskId 或最后导航位置。
- Main 的瞬时 `mobileTaskView` 经连接代际、序号和 bridge 身份验证后逐事件推送；宽窄屏共用上报，Web 不成为第二个自动写者。保留 `mobileViewState` 用于导航恢复。
- 同一任务的完成写入和新查看读/CAS 在唯一 writer 内串行：在途写使用自身返回 marker，写已结束则从所属 owner 精确读 marker 后 CAS。慢读取不能清除离开后的新完成；重复有效查看状态不擦除手动未读。详细时序与 owner 换代合同见 [任务列表刷新语义](../task-list-refresh-semantics.md)。
- `task_status_changed` 本身仍不触发 membership 重拉；只有随后 `setTaskUnread` 发出的
  `task_meta_changed` 才驱动 task-index membership join 重新拉取 `unreadAt`。
- 前台完成的离开补记与自动清除：完成信号到达时用户正在查看（桌面完整导航地址或有效 Web 前台）
  则不立即写未读，只记录该「前台完成」；窗口失焦、最小化或页面隐藏时补写未读，让任务栏气泡、
  托盘红点、蓝点在用户离开后亮起（覆盖「看着任务完成 → 直接最小化走人」的场景）。用户回到窗口
  （重新聚焦/恢复可见）且该任务仍在面前时，按补写返回的精确 marker 自动清除——不得让蓝点卡在
  正打开的任务上、逼用户点走再点回；用户离开期间去看了别的任务则保留未读作为回来处理的提醒。
  聚焦期间永不补写；补写后打开任务按既有已读合同清除。已知边界：补写前重新打开同一任务再离开，
  离开时仍会补写；关闭整个应用前的在途补写尽力而为，不保证落库。实现见 `useProjectUnreadSignals`。

### 查看任务后清已读

- 桌面入口：`useWorkspaceTaskNavigation`
- 动作：先激活目标 tab，再按当前激活 tab 的 `remoteSessionId` 解析精确服务实例
- 从当前 task query row 读取 `unreadAt`；存在时先应用 `{ unreadAt: undefined }` 字段 overlay，再调用
  `zcodeTaskService.setTaskUnread(..., false)`
- 成功后按 tasks-index membership 对账并移除 overlay；失败时移除 overlay、重新拉取 membership，允许蓝点回来
- desktop 定时任务执行会话复用相同已读合同：用户停留在 Automations route 时，scheduler 后台终态会把带
  `cronAutomationId` 的执行会话标记为未读；显式选择「不在项目中工作」的 automation 必须把执行会话归入
  canonical conversation workspace 的「任务」分区。点击蓝点或任务行必须从被点击 query row 读取
  `unreadAt`，按精确 `workspaceKey + taskId` 清除，不得依赖当前 active session，也不得因 cron identity 跳过。
- 该流程必须保留 sessions-index `lastActivityAt`，打开任务或清未读不得让历史任务跳到顶部
- 手机 Web 远控入口：任务首页点击的 `WebRemoteControlTaskTarget.unreadAt` 是本次用户可见快照。若存在，
  同 workspace 通过当前 bridge、跨 workspace 在目标 bridge 建立后调用
  `zcodeTaskService.setTaskUnread(..., false, expectedUnreadAt=task.unreadAt)`；不得依赖手机 Root 的
  query cache 水合状态。
- 手机已读使用 compare-and-clear：tasks-index 当前 `unreadAt` 仍等于 `expectedUnreadAt` 才清除；
  如果任务在点击后又产生新的终态未读，迟到的旧清除必须 no-op 并返回当前 meta。该比较与写入必须处于
  同一 repository 原子边界，不能在 Web/UI 先查后写。
- `unreadAt` 同时承担本次未读的 CAS marker；同一 task 每次写入未读时必须由 repository 在
  SQLite 写事务内生成严格递增值。系统时间不前进或回拨时使用上一值加一，禁止由调用方直接把
  `Date.now()` 当作唯一版本。清除 `unreadAt` 只改变未读 membership，不得重置 repository
  持久化的最后分配 marker。
- 手机已读写入失败不阻止打开任务，返回首页后重新采用 tasks-index 权威快照；desktop
  `useWorkspaceTaskNavigation` 的现有 query-cache overlay 与 `desktop-continuous` 链路保持不变。

## UI 读取口径

- 任务列表蓝点：task query row 的 joined `membership.unreadAt`
- 系统角标与按未读列表：共享 Host `ProjectTree` 未读选择器，但计数语义分叉——蓝点 = 全部
  未读，角标 = 本次 app 运行新增的未读（`countUnreadTasksSinceBaseline`，基线由
  `mergeBaselineForHostsInTree` 按 host 建立并吸收迟到上线的远端历史未读）。带历史未读
  启动时蓝点亮、角标 0 是预期形态，不是 bug。详见 `docs/desktop/windows-taskbar-unread-badge.md`

两个入口最终都只消费 tasks-index `unreadAt`；迁移期间可以复用聚合 helper，但不得回退旧
`taskUnreadByTaskId` 作为业务事实。
