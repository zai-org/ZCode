# Prompt Editor 复用说明

> **当前状态**：`ChatPromptEditor` 只由 V4 主 composer 使用。用户消息编辑不再使用行内编辑器，改为复用底部主 composer 的编辑态，见 [Composer 编辑态](../ui/composer-edit-mode.md)。

`ChatPromptEditor` 是聊天输入框的轻量共享编辑器，负责承载 `LexicalChatInput`、提交/取消按钮、可选快捷入口和 workspace file drop。

主 `packages/ui/src/v4/ConversationComposer.tsx` 保留 session 级能力，例如 toolbar、prompt enhance、附件选择和停止生成；`ChatPromptEditor` 只处理通用编辑能力。编辑最后一条消息与编辑排队消息时，主 composer 进入编辑态：顶部显示编辑状态条与「取消」，「对话 + 文件重置」也放在状态条中；原消息位置只显示「正在下方编辑」占位。

workspace file tree 拖拽追加 mention 的逻辑集中在 `workspaceFileComposer`，保证编辑态与普通输入的 `@file` mention 语义一致。
