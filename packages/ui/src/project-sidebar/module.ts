/**
 * project-sidebar 模块清单（architecture-governance managed 模块）。
 * 层：ui。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const projectSidebarModule = {
  id: "project-sidebar",
  requires: [
    "resource-manager",
    "services",
    "shared",
    "ui",
    "conversation-workspace-target",
    "web-remote-control-ui",
    "remote-connection-flow",
    "data-sync",
    "managed-worktree-ui",
    // 分组会话行复用同一张悬停卡片（docs/ui/task-row-hover-details.md）。
    "task-row-hover",
    // 主导航挂 nav.primary 插槽组件（docs/plugins/extension-host.md §16.4）。
    "extension-slots",
  ],
  provides: ["project-sidebar"],
  publicEntrypoints: [
    "index.tsx",
    "contract.ts",
    "remote-project-connection.ts",
    "useSavedWorkflowProjectOptions.ts",
    "RemoteProjectMenu.tsx",
    "WorkspaceDragOverlay.tsx",
    "useRemoteProjectConnectionPresentation.ts",
    "OfflineRemoteProjectRows.tsx",
    "RemoteConversationDisconnected.tsx",
  ],
} as const;
