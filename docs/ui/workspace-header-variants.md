# Workspace Header Variants

## 目标

桌面端 New Task 草稿与已有 Task 使用同一个 `WorkspaceHeader` 组件和同一套标题栏布局，避免草稿态维护第二份轻量 header，导致操作入口、窗口控制安全区和拖拽行为逐渐分叉。

## 状态模型

```text
activeTaskId = null                       activeTaskId != null
        │                                        │
        ▼                                        ▼
WorkspaceHeader variant="draft"  ─────▶  WorkspaceHeader variant="task"
        │              首次提交创建 task             │
        └──────────── 同一组件实例 / 同一布局骨架 ─────┘
```

- `variant="draft"`：保留 Header 高度、拖拽区、Help、Terminal、Side Pane 和平台 caption 菜单；不展示左侧任务标题、编辑器选择器及依赖稳定 task 的 workspace/branch 上下文、Task 更多菜单、日志、重命名、归档等操作。Side Pane 收起时 Header 底部分割线透明，展开时恢复默认分割线。
- `variant="task"`：展示完整 Task 标题、workspace/branch 上下文和 Task 操作；Task 更多菜单不含归档，归档只在侧栏提供（见 [任务列表右键菜单](./task-list-context-menu.md)）。
- Draft 顶部文件拖拽复用主 Composer 暴露的 drop target controller，只在 Header 内显示遮罩，不注册第二套附件入口。
- Header 的错误边界只按 workspace 重置，Draft 首次提交得到 `activeTaskId` 时不能因为 reset key 改变而重建 Header。

## 多端边界

- 桌面端本地与远程 workspace 都使用上述 variant 模型，并继续适配 macOS、Windows、Linux 和两种主题。
- 手机 Web 远控沿用现有 side pane overlay 与 replayable 恢复边界；没有 active task 时不额外渲染桌面标题栏，也不创建独立 Agent runtime。

## 验收

- New Task 页面存在 `WorkspaceHeader[data-workspace-header-variant="draft"]`，Side Pane 按钮可展开/收起已有 tabs。
- Draft Header 不显示任务标题、编辑器选择器、Task 更多菜单和 workspace/branch 上下文；Side Pane 收起时底部分割线透明，展开时显示默认分割线。
- 首次提交进入 Task 后，同一 Header 切换为 `variant="task"`，标题栏高度和右侧共享操作位置不跳变。
- 单测覆盖 variant 透传与 Draft 内容裁剪；桌面 E2E 覆盖 Draft Header 和 Side Pane 交互。
