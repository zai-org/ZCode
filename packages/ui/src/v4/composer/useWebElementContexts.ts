import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  WEB_ELEMENT_CONTEXT_ADD_TO_CHAT_EVENT,
  WEB_ELEMENT_CONTEXT_REMOVE_FROM_CHAT_EVENT,
  WEB_ELEMENT_CONTEXT_UPDATE_ONLY,
  dispatchWebElementContextsRemoved,
  createWebElementContextId,
  getWebElementContextWorkspaceKey,
  isWebElementContextAddToChatEvent,
  isWebElementContextPayload,
  isWebElementContextRemoveFromChatEvent,
  type WebElementContextComposerAttachment,
} from "@/lib/webElementContext.js";
import { isComposerEditScopeId } from "@/composer-edit-mode/contract.js";

interface WebElementContextRemovePayload {
  id: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface UseWebElementContextsOptions {
  workspacePath: string;
  workspaceIdentity?: string;
  listenAddToChatEvents?: boolean;
  scopeId?: string | null;
}

export interface UseWebElementContextsResult {
  contexts: readonly WebElementContextComposerAttachment[];
  hasContexts: boolean;
  removeContext: (id: string) => void;
  clearContexts: () => void;
  /** 用户在输入框里删掉（会通知浏览器取消选中） */
  removeContextByUser: (id: string) => void;
  clearContextsByUser: () => void;
  /** 随消息发出后清掉（通知浏览器忘掉这些引用） */
  removeSentContexts: (ids: string[]) => void;
}

function isRemovePayload(payload: unknown): payload is WebElementContextRemovePayload {
  const candidate = payload as WebElementContextRemovePayload;
  return (
    typeof payload === "object" &&
    payload !== null &&
    typeof candidate.id === "string" &&
    candidate.id.length > 0 &&
    typeof candidate.workspacePath === "string" &&
    candidate.workspacePath.length > 0 &&
    (candidate.workspaceIdentity === undefined || typeof candidate.workspaceIdentity === "string")
  );
}

function toComposerAttachment(
  payload: Parameters<typeof isWebElementContextPayload>[0],
): Omit<WebElementContextComposerAttachment, "ordinal"> | null {
  if (!isWebElementContextPayload(payload)) {
    return null;
  }
  return {
    ...payload,
    id: payload.id ?? createWebElementContextId(),
  };
}

// 按 composer 草稿 scope 缓存未发送的网页元素上下文；切任务或进入/退出编辑态后切回原样恢复。
const scopedWebElementContexts = new Map<string, readonly WebElementContextComposerAttachment[]>();

function webElementScopeKey(workspaceKey: string, scopeId: string | null) {
  return `${workspaceKey}\0${scopeId ?? ""}`;
}

/** 进入编辑态前为 edit scope 预置待编辑消息的网页元素上下文。 */
export function seedWebElementContextsForScope(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  scopeId: string,
  contexts: readonly WebElementContextComposerAttachment[],
) {
  const key = webElementScopeKey(
    getWebElementContextWorkspaceKey(workspacePath, workspaceIdentity),
    scopeId,
  );
  if (contexts.length > 0) scopedWebElementContexts.set(key, [...contexts]);
  else scopedWebElementContexts.delete(key);
}

/**
 * 修复原因：以前提示词按发送时的位置编 `## Element N`，截图按加入时的位置命名 element-N.png，
 * 删掉前面的 chip 后两者错位，模型会把截图对到别的元素上。改成加入时分配稳定编号，两边共用。
 */
function withOrdinal(
  items: readonly WebElementContextComposerAttachment[],
  attachment: Omit<WebElementContextComposerAttachment, "ordinal">,
): readonly WebElementContextComposerAttachment[] {
  const existing = items.find((item) => item.id === attachment.id);
  if (existing) {
    return items.map((item) =>
      item.id === attachment.id ? { ...attachment, ordinal: existing.ordinal } : item,
    );
  }
  const ordinal = items.reduce((max, item) => Math.max(max, item.ordinal), 0) + 1;
  return [...items, { ...attachment, ordinal }];
}

export function useWebElementContexts({
  workspacePath,
  workspaceIdentity,
  listenAddToChatEvents = true,
  scopeId = null,
}: UseWebElementContextsOptions): UseWebElementContextsResult {
  const [contexts, setContexts] = useState<readonly WebElementContextComposerAttachment[]>([]);
  const workspaceKey = getWebElementContextWorkspaceKey(workspacePath, workspaceIdentity);
  const scopeKey = webElementScopeKey(workspaceKey, scopeId);
  const contextsRef = useRef(contexts);
  contextsRef.current = contexts;
  const scopeKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const previousKey = scopeKeyRef.current;
    if (previousKey === scopeKey) return;
    if (previousKey !== null) {
      // composer 编辑态的 edit scope 用完即弃，不缓存。
      if (contextsRef.current.length > 0 && !isComposerEditScopeId(previousKey))
        scopedWebElementContexts.set(previousKey, contextsRef.current);
      else scopedWebElementContexts.delete(previousKey);
    }
    scopeKeyRef.current = scopeKey;
    const restored = scopedWebElementContexts.get(scopeKey) ?? [];
    scopedWebElementContexts.delete(scopeKey);
    setContexts(restored);
  }, [scopeKey]);
  useEffect(
    () => () => {
      // composer 卸载（关闭分屏等）时保留当前 scope 的未发送上下文。
      const key = scopeKeyRef.current;
      if (key !== null && contextsRef.current.length > 0 && !isComposerEditScopeId(key))
        scopedWebElementContexts.set(key, contextsRef.current);
    },
    [],
  );

  const removeContext = useCallback((id: string) => {
    setContexts((items) => items.filter((item) => item.id !== id));
  }, []);

  const clearContexts = useCallback(() => {
    setContexts([]);
  }, []);

  useEffect(() => {
    if (!listenAddToChatEvents || typeof window === "undefined") {
      return;
    }

    const handleAdd = (event: Event) => {
      if (!isWebElementContextAddToChatEvent(event)) {
        return;
      }
      const updateOnly =
        (event.detail as unknown as Record<string, unknown>)[WEB_ELEMENT_CONTEXT_UPDATE_ONLY] ===
        true;
      const { [WEB_ELEMENT_CONTEXT_UPDATE_ONLY]: _marker, ...detail } =
        event.detail as unknown as Record<string, unknown>;
      const attachment = toComposerAttachment(detail as unknown as typeof event.detail);
      if (!attachment) {
        return;
      }
      // 补截图之类的更新只作用于这个输入框里已有的同 id 引用（!3450 SG-04）：
      // 截图回来前切了会话，新会话的输入框没有这条，不能当成新引用收下
      if (updateOnly && !contextsRef.current.some((item) => item.id === attachment.id)) {
        return;
      }
      const eventWorkspaceKey = getWebElementContextWorkspaceKey(
        attachment.workspacePath,
        attachment.workspaceIdentity,
      );
      if (eventWorkspaceKey !== workspaceKey) {
        return;
      }
      event.preventDefault();
      setContexts((items) => withOrdinal(items, attachment));
    };

    const handleRemove = (event: Event) => {
      if (!isWebElementContextRemoveFromChatEvent(event)) {
        return;
      }
      if (!isRemovePayload(event.detail)) {
        return;
      }
      const eventWorkspaceKey = getWebElementContextWorkspaceKey(
        event.detail.workspacePath,
        event.detail.workspaceIdentity,
      );
      if (eventWorkspaceKey !== workspaceKey) {
        return;
      }
      event.preventDefault();
      removeContext(event.detail.id);
    };

    window.addEventListener(WEB_ELEMENT_CONTEXT_ADD_TO_CHAT_EVENT, handleAdd);
    window.addEventListener(WEB_ELEMENT_CONTEXT_REMOVE_FROM_CHAT_EVENT, handleRemove);
    return () => {
      window.removeEventListener(WEB_ELEMENT_CONTEXT_ADD_TO_CHAT_EVENT, handleAdd);
      window.removeEventListener(WEB_ELEMENT_CONTEXT_REMOVE_FROM_CHAT_EVENT, handleRemove);
    };
  }, [listenAddToChatEvents, removeContext, workspaceKey]);

  // 用户在输入框里删掉引用 / 随消息发出：告诉浏览器（设计工具据此取消选中或忘掉引用）。
  // 浏览器要求撤回（handleRemove）不走这里，避免来回触发。
  const broadcastRemoved = useCallback(
    (ids: string[], reason: "user" | "sent") =>
      dispatchWebElementContextsRemoved({
        ids,
        reason,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
      }),
    [workspaceIdentity, workspacePath],
  );
  const removeContextByUser = useCallback(
    (id: string) => {
      removeContext(id);
      broadcastRemoved([id], "user");
    },
    [broadcastRemoved, removeContext],
  );
  const clearContextsByUser = useCallback(() => {
    broadcastRemoved(
      contextsRef.current.map((item) => item.id),
      "user",
    );
    clearContexts();
  }, [broadcastRemoved, clearContexts]);
  const removeSentContexts = useCallback(
    (ids: string[]) => {
      for (const id of ids) removeContext(id);
      broadcastRemoved(ids, "sent");
    },
    [broadcastRemoved, removeContext],
  );

  return useMemo(
    () => ({
      contexts,
      hasContexts: contexts.length > 0,
      removeContext,
      clearContexts,
      removeContextByUser,
      clearContextsByUser,
      removeSentContexts,
    }),
    [
      clearContexts,
      clearContextsByUser,
      contexts,
      removeContext,
      removeContextByUser,
      removeSentContexts,
    ],
  );
}
