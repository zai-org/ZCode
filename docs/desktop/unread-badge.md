# Desktop 未读 Badge（已退役，并入新 spec）

本文是 v0 草稿，数据流描述（`countAllUnreadTasks`、`useRootPlatformEffects`、`unreadTaskCount.ts`）
对应的实现已删除。当前事实见 [windows-taskbar-unread-badge.md](windows-taskbar-unread-badge.md)：

- 未读权威仍是 tasks-index `unreadAt`；automation 终态由 host `setTaskUnread` 持久化、
  用户点击后由 `useWorkspaceTaskNavigation` 清除——这部分约束继续有效。
- 统计同步链路：`ProjectDirectoryProvider` 数权威树未读 → `syncWindowUnreadCount` →
  main 按平台分叉（win32 overlay / darwin·linux `setBadgeCount`）。
- 角标语语义为「本次 app 运行新增的未读」（per-host 基线分界），不再是本文的
  「全部后台完成未读」。
