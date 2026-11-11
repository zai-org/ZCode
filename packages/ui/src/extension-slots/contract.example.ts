import type { ComposerStatusSlotProps } from "@/extension-slots/contract.js";

// 输入框工具栏在用量圆环左边挂 composer.status：传当前工作区与会话（草稿为预热会话）。
export const composerStatusSlotExample: ComposerStatusSlotProps = {
  workspacePath: "/Users/dev/project",
  workspaceIdentity: null,
  sessionId: "sess_00000000-0000-4000-8000-000000000000",
};
