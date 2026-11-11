import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  PPTX_ELEMENT_REFERENCE_ADD_TO_CHAT_EVENT,
  addPptxElementReference,
  getPptxElementReferenceWorkspaceKey,
  isPptxElementReferenceInWorkspaceScope,
  isPptxElementReferenceAddToChatEvent,
  type PptxElementReference,
} from "@/lib/pptxElementReference.js";
import { isComposerEditScopeId } from "@/composer-edit-mode/contract.js";

// 按 composer 草稿 scope 缓存未发送的 PPTX 元素引用；切任务或进入/退出编辑态后切回原样恢复。
const scopedPptxElementReferences = new Map<string, readonly PptxElementReference[]>();

function pptxScopeKey(
  workspaceKey: string,
  remoteSessionId: string | undefined,
  scopeId: string | null,
) {
  return `${workspaceKey}\0${remoteSessionId ?? ""}\0${scopeId ?? ""}`;
}

/** 进入编辑态前为 edit scope 预置待编辑消息的 PPTX 元素引用。 */
export function seedPptxElementReferencesForScope(
  options: { workspacePath: string; workspaceIdentity?: string; remoteSessionId?: string },
  scopeId: string,
  references: readonly PptxElementReference[],
) {
  const key = pptxScopeKey(
    getPptxElementReferenceWorkspaceKey(options.workspacePath, options.workspaceIdentity),
    options.remoteSessionId,
    scopeId,
  );
  if (references.length > 0) scopedPptxElementReferences.set(key, [...references]);
  else scopedPptxElementReferences.delete(key);
}

export function usePptxElementReferences(options: {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  listenAddToChatEvents?: boolean;
  scopeId?: string | null;
}) {
  const {
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    listenAddToChatEvents = true,
    scopeId = null,
  } = options;
  const [references, setReferences] = useState<readonly PptxElementReference[]>([]);
  const workspaceKey = getPptxElementReferenceWorkspaceKey(workspacePath, workspaceIdentity);
  const scopeKey = pptxScopeKey(workspaceKey, remoteSessionId, scopeId);
  const referencesRef = useRef(references);
  referencesRef.current = references;
  const scopeKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const previousKey = scopeKeyRef.current;
    if (previousKey === scopeKey) return;
    if (previousKey !== null) {
      // composer 编辑态的 edit scope 用完即弃，不缓存。
      if (referencesRef.current.length > 0 && !isComposerEditScopeId(previousKey))
        scopedPptxElementReferences.set(previousKey, referencesRef.current);
      else scopedPptxElementReferences.delete(previousKey);
    }
    scopeKeyRef.current = scopeKey;
    const restored = scopedPptxElementReferences.get(scopeKey) ?? [];
    scopedPptxElementReferences.delete(scopeKey);
    setReferences(restored);
  }, [scopeKey]);
  useEffect(
    () => () => {
      const key = scopeKeyRef.current;
      if (key !== null && referencesRef.current.length > 0 && !isComposerEditScopeId(key))
        scopedPptxElementReferences.set(key, referencesRef.current);
    },
    [],
  );

  const removeReference = useCallback((id: string) => {
    setReferences((items) => items.filter((item) => item.id !== id));
  }, []);
  const clearReferences = useCallback(() => setReferences([]), []);

  useEffect(() => {
    if (!listenAddToChatEvents || typeof window === "undefined") {
      return;
    }
    const handleAdd = (event: Event) => {
      if (!isPptxElementReferenceAddToChatEvent(event)) {
        return;
      }
      const reference = event.detail;
      if (
        !isPptxElementReferenceInWorkspaceScope(reference, {
          workspacePath,
          workspaceIdentity,
          remoteSessionId,
        })
      ) {
        return;
      }
      event.preventDefault();
      setReferences((items) => addPptxElementReference(items, reference));
    };
    window.addEventListener(PPTX_ELEMENT_REFERENCE_ADD_TO_CHAT_EVENT, handleAdd);
    return () => window.removeEventListener(PPTX_ELEMENT_REFERENCE_ADD_TO_CHAT_EVENT, handleAdd);
  }, [listenAddToChatEvents, remoteSessionId, workspaceIdentity, workspaceKey, workspacePath]);

  return useMemo(
    () => ({
      references,
      hasReferences: references.length > 0,
      removeReference,
      clearReferences,
    }),
    [clearReferences, references, removeReference],
  );
}
