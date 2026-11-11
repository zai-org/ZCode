import { useSyncExternalStore } from "react";
import { toast } from "@/components/ui/toast.js";
import {
  getConversationSelectionReferenceScope,
  getSentConversationSelections,
  removeConversationSelectionReferenceFromScope,
  restoreConversationSelectionReferenceInScope,
  subscribeConversationSelectionReferenceScopes,
} from "@/lib/conversationSelectionReference.js";

/** 撤销窗口：删除后 6 秒内可撤销，其余编号自动补位、撤销后恢复。 */
export const ANNOTATION_UNDO_MS = 6000;

/**
 * 删除整条注释并给出撤销入口。正文编辑浮层与 composer 注释列表共用，
 * 两处都直接写作用域存储，chip 与正文标记经订阅保持同一份数据。
 */
export function deleteConversationAnnotationWithUndo(options: {
  sessionId: string | null;
  workspaceKey: string;
  draftScopeKey?: string;
  id: string;
  formatMessage: (id: string) => string;
}): void {
  const { sessionId, workspaceKey, draftScopeKey, id, formatMessage } = options;
  const removed = removeConversationSelectionReferenceFromScope(
    sessionId,
    workspaceKey,
    id,
    draftScopeKey,
  );
  if (!removed) return;
  // 只有 notice 变体（info/warning/success）渲染操作按钮；default 变体会把“撤销”静默丢掉。
  toast(formatMessage("chat.selections.commentDeleted"), {
    variant: "info",
    durationMs: ANNOTATION_UNDO_MS,
    actionLabel: formatMessage("chat.selections.commentUndo"),
    dedupeKey: `conversation-annotation-delete:${workspaceKey}:${sessionId ?? ""}:${id}`,
    onAction: () => {
      if (
        !restoreConversationSelectionReferenceInScope(
          sessionId,
          workspaceKey,
          removed,
          draftScopeKey,
        )
      ) {
        toast(formatMessage("chat.selections.limit.count"), { variant: "warning" });
      }
    },
  });
}

/** 时间线读取主 composer 作用域里的注释与已发送注释；存储里的数组引用稳定，可直接做快照。 */
export function useConversationAnnotationScope(sessionId: string, workspaceKey: string) {
  const references = useSyncExternalStore(subscribeConversationSelectionReferenceScopes, () =>
    getConversationSelectionReferenceScope(sessionId, workspaceKey),
  );
  const sent = useSyncExternalStore(subscribeConversationSelectionReferenceScopes, () =>
    getSentConversationSelections(sessionId, workspaceKey),
  );
  return { references, sent };
}
