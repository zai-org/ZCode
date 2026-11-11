# managed-worktree-ui

受管 worktree 的 renderer 组件与 hook，规格见 `docs/git/worktree.md` §3。管理弹窗在 `project-sidebar` 模块。

- `WorktreeToggle` / `WorktreeBranchPicker`：新建任务 composer 头部的 worktree 复选框与分支选择。状态存放在 session store 的草稿字段（`draftWorktree`），每次新建草稿重置为关闭；分支选择只记录起点，不切换主目录。
- `useManagedWorktreeCreations` / `useManagedWorktreeSettlements`：固定从 base services 镜像本机 Host 推送的创建记录与结束事件，不随远程 workspace 切换服务。记录只在 Host 内存中，是创建阶段的唯一数据源；base 未提供 worktree 能力时不订阅。
- `ManagedWorktreeCreationView`：发送后、会话创建前的用户消息与进度卡片，以及失败时的重试 / 不使用 worktree / 放弃。创建成功后由 session store 的 `worktreeHandoff` 盖在会话上，直到会话时间线出现内容或订阅出错。
- `WorktreeCreatedMarker`：会话历史中的"已创建 worktree"项（CLI 写入的 timeline 标记）。
- `ForkDestinationMenu` + `ForkDestinationContext`：assistant 行分叉的两项菜单；父任务在 worktree 中时第一项为"在当前 worktree 中分叉"。`SessionPane` 提供 memo 后的 context 值。
- `useTaskWorktreePlacement`：会话的 cwd、worktree 根与可用性，只读 Host tasks-index 任务元数据（`useWorkspaceActiveTaskState.ts` 的 `useIndexedTaskMeta`，与会话头部同一数据源），不读 renderer 任务列表缓存。
- 对服务层的类型依赖只经 `contract.ts`。
