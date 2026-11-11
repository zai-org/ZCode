// composer-edit-mode 契约（docs/ui/composer-edit-mode.md）：编辑态的目标、失效原因与 edit scope 规则。
// 编辑最后一条消息与排队消息都复用底部 composer：编辑内容放在独立的 edit scope，原草稿留在原
// scope 不动，所以取消、提交成功或失效后只需切回原 scope 就能完整恢复，无需另存快照。
import type { V4ConversationFileRewindPreviewResult } from "@zcode/shared/zcode-protocol-v4";

/** edit scope 的草稿只留在内存：编辑内容不写 localStorage，刷新后只恢复原草稿。 */
export const COMPOSER_EDIT_SCOPE_MARKER = "::composer-edit:";

export function isComposerEditScopeId(scopeId: string): boolean {
  return scopeId.includes(COMPOSER_EDIT_SCOPE_MARKER);
}

export function composerEditSessionKey(workspaceKey: string, sessionId: string): string {
  return `${workspaceKey}\0${sessionId}`;
}

export type ComposerEditTarget =
  | { kind: "userQuery"; rowId: number; entityId: string }
  | { kind: "queueItem"; queueItemId: string };

export type ComposerEditInvalidReason = "notLatest" | "queueItemRemoved" | "editLockLost";

export interface ComposerEditWorkspaceRewind {
  enabled: boolean;
  reason: string;
}

export interface ComposerEditSession {
  target: ComposerEditTarget;
  /** 本次编辑使用的 edit scope（createComposerEditScopeId）。 */
  scopeId: string;
  inputKind: "sendText" | "sendGoalCommand";
  /** 载入编辑态时的正文；与当前正文比较判断是否有未保存改动。 */
  loadedText: string;
  /** 投影已显示本编辑器的锁；之前锁缺失只是 delta 未到，不能判为被解除。 */
  lockConfirmed: boolean;
  /** 目标 user 行上报的「对话 + 文件重置」可用性；状态条按它渲染。 */
  workspaceRewind?: ComposerEditWorkspaceRewind;
  /** 「对话 + 文件重置」遇到文件冲突时的预览，状态条打开冲突对话框。 */
  conflictPreview?: V4ConversationFileRewindPreviewResult;
  /** 每次点击占位递增；composer 订阅后聚焦输入框。 */
  focusRequest: number;
}
