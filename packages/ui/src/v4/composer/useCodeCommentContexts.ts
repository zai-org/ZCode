import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CODE_COMMENT_ADD_TO_CHAT_EVENT,
  CODE_COMMENT_REMOVE_FROM_CHAT_EVENT,
  getCodeCommentWorkspaceKey,
  isCodeCommentAddToChatEvent,
  isCodeCommentPayload,
  isCodeCommentRemoveFromChatEvent,
  isCodeCommentRemovePayload,
  type CodeCommentComposerAttachment,
} from "@/lib/codeCommentContext.js";
import { isComposerEditScopeId } from "@/composer-edit-mode/contract.js";

export interface UseCodeCommentContextsOptions {
  listenAddToChatEvents?: boolean;
  onContextRemoved?: (context: CodeCommentComposerAttachment) => void;
  requestFocus?: () => void;
  scopeKey: string;
}

export interface UseCodeCommentContextsResult {
  contexts: readonly CodeCommentComposerAttachment[];
  hasContexts: boolean;
  removeContext: (
    context: Pick<
      CodeCommentComposerAttachment,
      "id" | "workspaceIdentity" | "workspacePath"
    >,
  ) => void;
  clearContexts: () => void;
  getContexts: () => readonly CodeCommentComposerAttachment[];
}

// 按 composer 草稿 scope 缓存未发送的代码评论：切任务或进入/退出 composer 编辑态后切回，
// 原草稿的评论 chip 原样恢复（docs/ui/task-scoped-composer-drafts.md、composer-edit-mode.md）。
const scopedCodeCommentContexts = new Map<string, readonly CodeCommentComposerAttachment[]>();

/** 进入编辑态前为 edit scope 预置待编辑消息的代码评论；scope 切换时载入。 */
export function seedCodeCommentContextsForScope(
  scopeKey: string,
  contexts: readonly CodeCommentComposerAttachment[],
) {
  if (contexts.length > 0) scopedCodeCommentContexts.set(scopeKey, [...contexts]);
  else scopedCodeCommentContexts.delete(scopeKey);
}

/** composer 编辑态的 edit scope 用完即弃：离开时不缓存，原草稿 scope 正常缓存。 */
function stashScopeContexts(
  scopeKey: string,
  contexts: readonly CodeCommentComposerAttachment[],
) {
  if (isComposerEditScopeId(scopeKey)) {
    scopedCodeCommentContexts.delete(scopeKey);
    return;
  }
  seedCodeCommentContextsForScope(scopeKey, contexts);
}

function createCodeCommentAttachmentId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `code-comment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function contextKey(
  context: Pick<
    CodeCommentComposerAttachment,
    "id" | "workspaceIdentity" | "workspacePath"
  >,
) {
  return `${getCodeCommentWorkspaceKey(context.workspacePath, context.workspaceIdentity)}\0${context.id}`;
}

export function useCodeCommentContexts({
  listenAddToChatEvents = true,
  onContextRemoved,
  requestFocus,
  scopeKey,
}: UseCodeCommentContextsOptions): UseCodeCommentContextsResult {
  const [contexts, setContexts] = useState<
    readonly CodeCommentComposerAttachment[]
  >(() => {
    const restored = scopedCodeCommentContexts.get(scopeKey) ?? [];
    scopedCodeCommentContexts.delete(scopeKey);
    return restored;
  });
  const contextsRef = useRef(contexts);
  const callbacksRef = useRef({ onContextRemoved, requestFocus });
  const scopeKeyRef = useRef(scopeKey);
  callbacksRef.current = { onContextRemoved, requestFocus };

  const commitContexts = useCallback(
    (next: readonly CodeCommentComposerAttachment[]) => {
      const nextKeys = new Set(next.map(contextKey));
      for (const context of contextsRef.current) {
        if (!nextKeys.has(contextKey(context))) {
          callbacksRef.current.onContextRemoved?.(context);
        }
      }
      contextsRef.current = next;
      setContexts(next);
    },
    [],
  );

  const removeContext = useCallback(
    (
      target: Pick<
        CodeCommentComposerAttachment,
        "id" | "workspaceIdentity" | "workspacePath"
      >,
    ) => {
      const targetKey = contextKey(target);
      const next = contextsRef.current.filter(
        (context) => contextKey(context) !== targetKey,
      );
      if (next.length !== contextsRef.current.length) {
        commitContexts(next);
      }
    },
    [commitContexts],
  );

  const clearContexts = useCallback(() => {
    if (contextsRef.current.length > 0) {
      commitContexts([]);
    }
  }, [commitContexts]);

  const getContexts = useCallback(() => contextsRef.current, []);

  useEffect(() => {
    if (scopeKeyRef.current === scopeKey) return;
    stashScopeContexts(scopeKeyRef.current, contextsRef.current);
    scopeKeyRef.current = scopeKey;
    const restored = scopedCodeCommentContexts.get(scopeKey) ?? [];
    scopedCodeCommentContexts.delete(scopeKey);
    // scope 切换只换展示的那一份；被切走的评论仍属于原草稿，不能触发「移除」回调清掉代码预览标记。
    contextsRef.current = restored;
    setContexts(restored);
  }, [scopeKey]);
  useEffect(
    () => () => {
      stashScopeContexts(scopeKeyRef.current, contextsRef.current);
    },
    [],
  );

  useEffect(() => {
    if (!listenAddToChatEvents || typeof window === "undefined") return;

    const handleAdd = (event: Event) => {
      if (
        !isCodeCommentAddToChatEvent(event) ||
        !isCodeCommentPayload(event.detail) ||
        event.defaultPrevented ||
        !event.cancelable
      ) {
        return;
      }
      // V4 迁移只保留了 PreviewPane 的事件发送端，没有任何 composer
      // 消费端；claim 后由唯一 primary pane 接管，避免分屏时重复写入多个输入区。
      event.preventDefault();
      if (!event.defaultPrevented) return;
      const attachment: CodeCommentComposerAttachment = {
        ...event.detail,
        id: event.detail.id ?? createCodeCommentAttachmentId(),
      };
      const key = contextKey(attachment);
      const existingIndex = contextsRef.current.findIndex(
        (context) => contextKey(context) === key,
      );
      const next =
        existingIndex < 0
          ? [...contextsRef.current, attachment]
          : contextsRef.current.map((context, index) =>
              index === existingIndex ? attachment : context,
            );
      commitContexts(next);
      callbacksRef.current.requestFocus?.();
    };

    const handleRemove = (event: Event) => {
      if (
        !isCodeCommentRemoveFromChatEvent(event) ||
        !isCodeCommentRemovePayload(event.detail)
      ) {
        return;
      }
      removeContext(event.detail);
    };

    window.addEventListener(CODE_COMMENT_ADD_TO_CHAT_EVENT, handleAdd);
    window.addEventListener(CODE_COMMENT_REMOVE_FROM_CHAT_EVENT, handleRemove);
    return () => {
      window.removeEventListener(CODE_COMMENT_ADD_TO_CHAT_EVENT, handleAdd);
      window.removeEventListener(
        CODE_COMMENT_REMOVE_FROM_CHAT_EVENT,
        handleRemove,
      );
    };
  }, [commitContexts, listenAddToChatEvents, removeContext]);

  return useMemo(
    () => ({
      contexts,
      hasContexts: contexts.length > 0,
      removeContext,
      clearContexts,
      getContexts,
    }),
    [clearContexts, contexts, getContexts, removeContext],
  );
}
