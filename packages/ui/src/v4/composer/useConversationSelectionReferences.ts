import { useCallback, useEffect, useRef, useState } from "react";
import {
  clearConversationSelectionReferenceLimitReason,
  getConversationSelectionReferenceScope,
  getConversationSelectionReferenceLimitReason,
  getConversationSelectionAddEventName,
  isConversationSelectionAddEvent,
  subscribeConversationSelectionReferenceScopes,
  retainSelectionCommentsWithLiveSource,
  setConversationSelectionReferenceScope,
  type ConversationSelectionLimitReason,
  type ConversationSelectionReference,
} from "@/lib/conversationSelectionReference.js";

export function useConversationSelectionReferences(options: {
  sessionId: string | null;
  workspaceKey: string;
  draftScopeKey?: string;
  /** 当前会话的权威 rows；提供时，rewind 删除来源行的带评论注释会被同步移除。 */
  liveSourceRows?: Parameters<typeof retainSelectionCommentsWithLiveSource>[2] | null;
}) {
  const [references, setReferencesState] = useState<readonly ConversationSelectionReference[]>(() =>
    getConversationSelectionReferenceScope(
      options.sessionId,
      options.workspaceKey,
      options.draftScopeKey,
    ),
  );
  const [limitReason, setLimitReason] = useState<ConversationSelectionLimitReason | null>(() =>
    getConversationSelectionReferenceLimitReason(
      options.sessionId,
      options.workspaceKey,
      options.draftScopeKey,
    ),
  );

  useEffect(() => {
    setReferencesState(
      getConversationSelectionReferenceScope(
        options.sessionId,
        options.workspaceKey,
        options.draftScopeKey,
      ),
    );
    setLimitReason(
      getConversationSelectionReferenceLimitReason(
        options.sessionId,
        options.workspaceKey,
        options.draftScopeKey,
      ),
    );
  }, [options.sessionId, options.workspaceKey, options.draftScopeKey]);

  const setReferences = useCallback(
    (
      update:
        | readonly ConversationSelectionReference[]
        | ((
            current: readonly ConversationSelectionReference[],
          ) => readonly ConversationSelectionReference[]),
    ) => {
      setReferencesState((current) => {
        const next = typeof update === "function" ? update(current) : update;
        setConversationSelectionReferenceScope(
          options.sessionId,
          options.workspaceKey,
          next,
          options.draftScopeKey,
        );
        return next;
      });
    },
    [options.sessionId, options.workspaceKey, options.draftScopeKey],
  );

  useEffect(() => {
    const handleAdd = (event: Event) => {
      if (!isConversationSelectionAddEvent(event)) return;
      if (
        event.detail.targetSessionId !== options.sessionId ||
        event.detail.workspaceKey !== options.workspaceKey ||
        (options.sessionId === null && event.detail.draftScopeKey !== options.draftScopeKey)
      ) {
        return;
      }
      setReferencesState(
        getConversationSelectionReferenceScope(
          options.sessionId,
          options.workspaceKey,
          options.draftScopeKey,
        ),
      );
      setLimitReason(
        getConversationSelectionReferenceLimitReason(
          options.sessionId,
          options.workspaceKey,
          options.draftScopeKey,
        ),
      );
    };
    window.addEventListener(getConversationSelectionAddEventName(), handleAdd);
    return () => window.removeEventListener(getConversationSelectionAddEventName(), handleAdd);
  }, [options.sessionId, options.workspaceKey, options.draftScopeKey]);

  const liveSourceRowsRef = useRef(options.liveSourceRows);
  liveSourceRowsRef.current = options.liveSourceRows;

  // 正文注释标记也能编辑/删除注释（直接写作用域存储），不经过 setReferences，
  // 必须订阅存储变化才能让 chip 与正文标记保持同一份数据。
  useEffect(
    () =>
      subscribeConversationSelectionReferenceScopes(() => {
        const latest = getConversationSelectionReferenceScope(
          options.sessionId,
          options.workspaceKey,
          options.draftScopeKey,
        );
        // 撤销删除会把注释原样放回；若期间 rewind 已删掉来源行，带评论的注释不能复活。
        // rows 不变时下面的剪枝 effect 不会重跑，所以存储变化时也按最新 rows 剪一次。
        const rows = liveSourceRowsRef.current;
        if (options.sessionId && rows) {
          const pruned = retainSelectionCommentsWithLiveSource(latest, options.sessionId, rows);
          if (pruned !== latest) {
            setConversationSelectionReferenceScope(
              options.sessionId,
              options.workspaceKey,
              pruned,
              options.draftScopeKey,
            );
            return;
          }
        }
        setReferencesState((current) =>
          current === latest || (current.length === 0 && latest.length === 0) ? current : latest,
        );
      }),
    [options.sessionId, options.workspaceKey, options.draftScopeKey],
  );

  const { sessionId, workspaceKey, draftScopeKey, liveSourceRows } = options;
  useEffect(() => {
    if (!sessionId || !liveSourceRows) return;
    const current = getConversationSelectionReferenceScope(sessionId, workspaceKey, draftScopeKey);
    const next = retainSelectionCommentsWithLiveSource(current, sessionId, liveSourceRows);
    // rows 每个流式 delta 都会换引用；只有真的删掉批注时才写回，避免清掉超限提示。
    if (next !== current) setReferences(next);
  }, [sessionId, workspaceKey, draftScopeKey, liveSourceRows, setReferences]);

  const removeReference = useCallback(
    (id: string) => {
      setReferences((current) => current.filter((reference) => reference.id !== id));
      setLimitReason(null);
    },
    [setReferences],
  );
  const clearReferences = useCallback(() => {
    setReferences([]);
    setLimitReason(null);
  }, [setReferences]);
  const dismissLimitReason = useCallback(() => {
    clearConversationSelectionReferenceLimitReason(
      options.sessionId,
      options.workspaceKey,
      options.draftScopeKey,
    );
    setLimitReason(null);
  }, [options.sessionId, options.workspaceKey, options.draftScopeKey]);

  return {
    references,
    limitReason,
    dismissLimitReason,
    removeReference,
    clearReferences,
  };
}
