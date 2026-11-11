// Composer 编辑态编排（docs/ui/composer-edit-mode.md）：进入/取消/结束编辑、队列项冻结锁、
// 失效判定与刷新后的锁自愈。编辑内容放在独立 edit scope；原草稿留在原 scope，切回即恢复。
// 失效只看 CLI 投影（row.actions.canEdit、queue item 与 editLock），不使用计时器。
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type {
  AttachmentRef,
  CommandAck,
  ConversationRowTarget,
  ConversationSnapshot,
} from "@zcode/shared/zcode-protocol-v4";
import { createUuid, isHighspeedProviderId, type ConversationSelectionText } from "@zcode/shared";
import {
  isConversationSelectionReference,
  setConversationSelectionReferenceScope,
} from "@/lib/conversationSelectionReference.js";
import { toast } from "@/components/ui/toast.js";
import { useConfirmDialogStore } from "@/store/confirmDialogStore.js";
import { TID_V4_COMPOSER_EDIT_SWITCH_DIALOG } from "@zcode/shared/test-ids";
import { logger } from "@/logger.js";
import { parseConversationShareContext } from "@/lib/conversationShareContext.js";
import { v4QueuedCommandText } from "@/v4/slashCommands.js";
import { splitUserInputEpilogue } from "@/v4/ConversationUserInputEpilogue.js";
import { parseComposerPromptContexts } from "@/v4/composer/composerPromptContexts.js";
import { persistV4ComposerDraft, type V4ComposerDraft } from "@/v4/composer/composerDraftStore.js";
import {
  replaceComposerAttachmentsForScope,
  setComposerAttachmentPreviewUrlForScope,
} from "@/v4/composer/useComposerAttachments.js";
import type { ConversationAttachmentReadParams, ConversationTransport } from "@/v4/transport.js";
import { seedCodeCommentContextsForScope } from "@/v4/composer/useCodeCommentContexts.js";
import { seedWebElementContextsForScope } from "@/v4/composer/useWebElementContexts.js";
import { seedPptxElementReferencesForScope } from "@/v4/composer/usePptxElementReferences.js";
import { composerEditSessionKey } from "./contract.js";
import { ensureEditorIdentity, useEditorIdentity } from "./editorIdentity.js";
import type {
  ComposerEditInvalidReason,
  ComposerEditSession,
  ComposerEditTarget,
} from "./contract.js";
import {
  createComposerEditScopeId,
  getComposerEditSession,
  useComposerEditStore,
} from "./store.js";

type DispatchCommand = (
  type: "lockQueueItemEdit" | "releaseQueueItemEdit",
  payload: Record<string, unknown>,
  sessionId: string,
) => Promise<CommandAck>;

type DraftConfig = Pick<V4ComposerDraft, "mode" | "planEnabled" | "modelSelection">;

interface EditContent {
  inputKind: "sendText" | "sendGoalCommand";
  /** 含序列化上下文块的原文；载入时拆成可见正文与 chip。 */
  text: string;
  attachments: readonly AttachmentRef[];
  conversationQuotes?: readonly ConversationSelectionText[];
  config: DraftConfig;
}

/** lock ACK 前投影可能已出现本端锁：这段窗口内自愈逻辑不能把它当成遗留锁释放。 */
const lockRequestsInFlight = new Set<string>();

/**
 * 编辑一条消息时工具栏载入它提交时的配置（最后一条消息与排队项同一规则，docs/ui/composer-edit-mode.md）；
 * 旧消息/旧队列项缺少的字段保留当前草稿配置。旧版本曾把单轮 Highspeed Provider 持久化进输入，
 * 载入工具栏会污染后续 fallback，因此不载入 Highspeed 模型。
 */
function submittedEditConfig(
  submitted: Pick<DraftConfig, "mode" | "planEnabled" | "modelSelection">,
  fallback: DraftConfig,
): DraftConfig {
  const modelSelection =
    submitted.modelSelection && !isHighspeedProviderId(submitted.modelSelection.providerId)
      ? submitted.modelSelection
      : undefined;
  return {
    mode: submitted.mode ?? fallback.mode,
    planEnabled: submitted.planEnabled ?? fallback.planEnabled,
    modelSelection: modelSelection ?? fallback.modelSelection,
  };
}

export interface ComposerEditMode {
  editSession: ComposerEditSession | undefined;
  invalidReason: ComposerEditInvalidReason | null;
  editorId: string;
  pendingLockQueueItemId: string | null;
  beginUserQueryEdit: (target: ConversationRowTarget) => Promise<void>;
  beginQueueItemEdit: (queueItemId: string) => Promise<void>;
  /** 取消：释放队列锁并切回原 scope；原草稿随 scope 恢复。 */
  cancelEdit: () => void;
  /** 编辑提交成功：锁已由 editQueueItem 释放，只结束编辑态。 */
  finishEdit: () => void;
  releaseQueueItemEditLock: (queueItemId: string) => void;
  requestEditFocus: () => void;
}

// 预置操作跨渲染复用，但不能与 dispatch/releaseLock 共享作用域；否则旧命令回调仍持有旧 pane。
function createEnterEditScope({
  readAttachment,
  remoteSessionId,
  workspaceIdentity,
  workspaceKey,
  workspacePath,
}: {
  readAttachment?: ConversationTransport["attachmentRead"];
  remoteSessionId?: string;
  workspaceIdentity?: string;
  workspaceKey: string;
  workspacePath: string;
}) {
  return (
    targetSessionId: string,
    target: ComposerEditTarget,
    content: EditContent,
    extra?: Partial<ComposerEditSession>,
  ) => {
    const scopeId = createComposerEditScopeId(targetSessionId);
    const parsed = parseComposerPromptContexts(content.text, {
      workspacePath,
      workspaceIdentity,
    });
    const visibleText = parseConversationShareContext(parsed.visibleContent).visibleContent;
    persistV4ComposerDraft(workspacePath, workspaceIdentity, scopeId, {
      text: visibleText,
      ...content.config,
    });
    const attachmentItems = replaceComposerAttachmentsForScope(
      workspacePath,
      workspaceIdentity,
      scopeId,
      content.attachments,
    );
    // Bug 根因：session-owned 附件没有本地 objectUrl，编辑态媒体卡既无缩略图也无法打开 gallery
    // （VI06/VI07 视频预览 E2E）。与消息行一致按原序号读回；视频带 row target，
    // 删除前面的附件后预览仍按持久化原序号读取。
    if (readAttachment) {
      content.attachments.forEach((attachment, index) => {
        const isVideo = attachment.mime.startsWith("video/");
        if (!isVideo && !attachment.mime.startsWith("image/")) return;
        const item = attachmentItems[index];
        if (!item) return;
        void readAttachment({
          sessionId: targetSessionId,
          ref: attachment.previewRef ?? attachment.ref,
          ...(isVideo ? { mediaType: attachment.mime } : {}),
          ...(isVideo && target.kind === "userQuery"
            ? {
                target: { rowId: target.rowId, entityId: target.entityId },
                attachmentIndex: index,
              }
            : {}),
        })
          .then((result) => {
            const url =
              "url" in result
                ? result.url
                : URL.createObjectURL(
                    new Blob([Uint8Array.from(result.bytes)], { type: result.mediaType }),
                  );
            const applied = setComposerAttachmentPreviewUrlForScope(
              workspacePath,
              workspaceIdentity,
              scopeId,
              item.id,
              url,
            );
            if (!applied && !("url" in result)) URL.revokeObjectURL(url);
          })
          .catch((error: unknown) =>
            logger.warn("[v4-composer-edit] 读取编辑态附件预览失败", error),
          );
      });
    }
    seedCodeCommentContextsForScope(`${workspaceKey}\0${scopeId}`, parsed.codeComments);
    seedWebElementContextsForScope(workspacePath, workspaceIdentity, scopeId, parsed.webElements);
    seedPptxElementReferencesForScope(
      { workspacePath, workspaceIdentity, remoteSessionId },
      scopeId,
      parsed.pptxElements,
    );
    // 会话引用载入为 composer 的引用 chip，提交时作为结构化 quotes 带回。
    // Bug 根因：曾只读结构化 conversationQuotes；正文尾部 `# userselect:` 块形式的引用被
    // parseComposerPromptContexts 从可见正文剥离后直接丢失（AL 附件布局 E2E 编辑态少一个 chip）。
    // 与原行内编辑器一致：有结构化 quotes 用它，否则用正文解析出的引用。
    const selections = content.conversationQuotes ?? parsed.conversationSelections;
    setConversationSelectionReferenceScope(
      scopeId,
      workspaceKey,
      selections.map((quote) =>
        isConversationSelectionReference(quote)
          ? quote
          : {
              ...quote,
              id: createUuid(),
              sourceSessionId: targetSessionId,
              sourceRowId: target.kind === "userQuery" ? target.rowId : 0,
              contentType: "user" as const,
            },
      ),
    );
    useComposerEditStore.getState().begin(composerEditSessionKey(workspaceKey, targetSessionId), {
      target,
      scopeId,
      inputKind: content.inputKind,
      loadedText: visibleText,
      lockConfirmed: false,
      ...extra,
    });
  };
}

// Bug 原因：投影 effect 与长期复用的编辑回调共享词法作用域，旧回调会连带保留整份历史。
// 独立作用域只负责本轮投影校验和锁同步；事件处理仍通过 snapshotRef 读取当前投影。
function useComposerEditProjection({
  snapshot,
  sessionId,
  workspaceKey,
  sessionKey,
  editSession,
  editorId,
  editorIdentityConfirmed,
  releaseLock,
}: {
  snapshot: ConversationSnapshot | null;
  sessionId: string | null;
  workspaceKey: string;
  sessionKey: string | null;
  editSession: ComposerEditSession | undefined;
  editorId: string;
  editorIdentityConfirmed: boolean;
  releaseLock: (sessionId: string, queueItemId: string) => Promise<boolean>;
}): ComposerEditInvalidReason | null {
  // 失效只依据投影：最后一条消息不再可编辑、队列项已不存在、或锁已不属于本编辑器。
  const invalidReason = useMemo<ComposerEditInvalidReason | null>(() => {
    if (!editSession || !snapshot || snapshot.sessionId !== sessionId) return null;
    const target = editSession.target;
    if (target.kind === "userQuery") {
      const row = snapshot.rows.window.find((candidate) => candidate.rowId === target.rowId);
      return row && row.kind === "userInput" && row.actions?.canEdit ? null : "notLatest";
    }
    const item = snapshot.queue.items.find(
      (candidate) => candidate.queueItemId === target.queueItemId,
    );
    if (!item) return "queueItemRemoved";
    if (editSession.lockConfirmed && item.editLock?.editorId !== editorId) return "editLockLost";
    return null;
  }, [editSession, editorId, sessionId, snapshot]);

  useEffect(() => {
    if (!editSession || editSession.lockConfirmed || !sessionKey || !snapshot) return;
    const target = editSession.target;
    if (target.kind !== "queueItem") return;
    const item = snapshot.queue.items.find(
      (candidate) => candidate.queueItemId === target.queueItemId,
    );
    if (item?.editLock?.editorId === editorId) {
      useComposerEditStore.getState().update(sessionKey, { lockConfirmed: true });
    }
  }, [editSession, editorId, sessionKey, snapshot]);

  // 刷新或重启后：投影里属于本编辑器的锁没有对应编辑态，说明发起端已丢失编辑，立即释放。
  // Bug 根因：曾在发出释放时就把项永久标成已处理，释放失败（断线、非 accepted ACK）后不再重试，
  // 队首一直冻结。标记只代表「进行中或已确定释放」，失败即清除，下一次投影更新时重试；
  // 释放完成前该行显示「解除」入口（ConversationQueuePanel），用户也可手动处理。
  const releasedOrphanLocksRef = useRef(new Set<string>());
  useEffect(() => {
    if (!editorIdentityConfirmed) return;
    if (!sessionId || !snapshot || snapshot.sessionId !== sessionId) return;
    for (const item of snapshot.queue.items) {
      if (item.editLock?.editorId !== editorId) continue;
      if (lockRequestsInFlight.has(item.queueItemId)) continue;
      const active = getComposerEditSession(composerEditSessionKey(workspaceKey, sessionId));
      if (active?.target.kind === "queueItem" && active.target.queueItemId === item.queueItemId) {
        continue;
      }
      if (releasedOrphanLocksRef.current.has(item.queueItemId)) continue;
      releasedOrphanLocksRef.current.add(item.queueItemId);
      logger.info("[v4-composer-edit] 释放本编辑器遗留的队列编辑锁", {
        queueItemId: item.queueItemId,
        sessionId,
      });
      const queueItemId = item.queueItemId;
      void releaseLock(sessionId, queueItemId).then((released) => {
        if (!released) releasedOrphanLocksRef.current.delete(queueItemId);
      });
    }
  }, [editorId, editorIdentityConfirmed, releaseLock, sessionId, snapshot, workspaceKey]);

  return invalidReason;
}

export function useComposerEditMode(params: {
  sessionId: string | null;
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceKey: string;
  remoteSessionId?: string;
  snapshot: ConversationSnapshot | null;
  snapshotRef: RefObject<ConversationSnapshot | null>;
  composerDraftStateRef: RefObject<{ hasContent: boolean; busy: boolean }>;
  composerTextRef: RefObject<string>;
  readCurrentDraftConfig: () => DraftConfig;
  /** 读回已发送附件，用于编辑态媒体卡的缩略图与预览；runtime 未就绪时缺省。 */
  readAttachment?: (
    params: ConversationAttachmentReadParams,
  ) => ReturnType<ConversationTransport["attachmentRead"]>;
  dispatchCommand: DispatchCommand;
  intl: { formatMessage: (descriptor: { id: string }) => string };
}): ComposerEditMode {
  const {
    sessionId,
    workspacePath,
    workspaceIdentity,
    workspaceKey,
    remoteSessionId,
    snapshot,
    snapshotRef,
    composerDraftStateRef,
    composerTextRef,
    readCurrentDraftConfig,
    readAttachment,
    dispatchCommand,
    intl,
  } = params;
  const { editorId, confirmed: editorIdentityConfirmed } = useEditorIdentity();
  const sessionKey = sessionId ? composerEditSessionKey(workspaceKey, sessionId) : null;
  const editSession = useComposerEditStore((state) =>
    sessionKey ? state.sessions[sessionKey] : undefined,
  );
  const [pendingLockQueueItemId, setPendingLockQueueItemId] = useState<string | null>(null);
  const bindingRef = useRef({ sessionId, workspaceKey });
  bindingRef.current = { sessionId, workspaceKey };

  /** 释放编辑锁；返回是否已确定释放（accepted/noop），供遗留锁自愈判断是否需要重试。 */
  const releaseLock = useCallback(
    (targetSessionId: string, queueItemId: string): Promise<boolean> =>
      dispatchCommand("releaseQueueItemEdit", { queueItemId }, targetSessionId)
        .then((ack) => {
          if (ack.status === "accepted" || ack.status === "noop") return true;
          logger.warn(`[v4-composer-edit] 释放编辑锁失败: ${ack.status} ${ack.reasonCode ?? ""}`);
          return false;
        })
        .catch((error: unknown) => {
          logger.warn("[v4-composer-edit] 释放编辑锁失败", error);
          return false;
        }),
    [dispatchCommand],
  );

  const enterEditScope = useMemo(
    () =>
      createEnterEditScope({
        readAttachment,
        remoteSessionId,
        workspaceIdentity,
        workspaceKey,
        workspacePath,
      }),
    [readAttachment, remoteSessionId, workspaceIdentity, workspaceKey, workspacePath],
  );

  /**
   * 已在编辑态时切换目标：编辑内容未改动直接切（排队消息先释放旧锁），已改动先确认。
   * 暂存的始终是进入编辑态前的原草稿：原 scope 从未被编辑态改写。
   */
  const runWithSwitchGuard = useCallback(
    (action: () => void) => {
      const current = sessionKey ? getComposerEditSession(sessionKey) : undefined;
      if (!current) {
        action();
        return;
      }
      const dirty = (composerTextRef.current ?? "").trim() !== current.loadedText.trim();
      if (!dirty) {
        action();
        return;
      }
      void useConfirmDialogStore
        .getState()
        .requestConfirmation({
          testId: TID_V4_COMPOSER_EDIT_SWITCH_DIALOG,
          intent: "composer-edit-switch",
          title: intl.formatMessage({ id: "chat.composerEdit.switchTitle" }),
          description: intl.formatMessage({ id: "chat.composerEdit.switchDescription" }),
          confirmLabel: intl.formatMessage({ id: "chat.composerEdit.switchConfirm" }),
          confirmVariant: "destructive",
        })
        .then((confirmed) => {
          if (confirmed) action();
        });
    },
    [composerTextRef, intl, sessionKey],
  );

  const releaseCurrentQueueLock = useCallback(() => {
    if (!sessionKey || !sessionId) return;
    const current = getComposerEditSession(sessionKey);
    if (current?.target.kind === "queueItem")
      void releaseLock(sessionId, current.target.queueItemId);
  }, [releaseLock, sessionId, sessionKey]);

  const busyGuard = useCallback((): boolean => {
    if (!composerDraftStateRef.current?.busy) return false;
    toast(intl.formatMessage({ id: "chat.composerEdit.busy" }));
    return true;
  }, [composerDraftStateRef, intl]);

  const beginUserQueryEdit = useCallback(
    async (target: ConversationRowTarget) => {
      if (!sessionId || busyGuard()) return;
      const current = snapshotRef.current;
      const row = current?.rows.window.find((candidate) => candidate.rowId === target.rowId);
      if (!row || row.kind !== "userInput" || !row.actions?.canEdit || !row.entityId) return;
      const entityId = row.entityId;
      const { body } = splitUserInputEpilogue(row.text, row.epilogueStart);
      runWithSwitchGuard(() => {
        releaseCurrentQueueLock();
        enterEditScope(
          sessionId,
          { kind: "userQuery", rowId: row.rowId, entityId },
          {
            inputKind: "sendText",
            text: body,
            attachments: row.attachments ?? [],
            conversationQuotes: row.conversationQuotes,
            // 载入该消息提交时的配置；编辑态里可再改，提交时随 editUserQuery 携带。
            config: submittedEditConfig(row, readCurrentDraftConfig()),
          },
        );
      });
    },
    [
      busyGuard,
      enterEditScope,
      readCurrentDraftConfig,
      releaseCurrentQueueLock,
      runWithSwitchGuard,
      sessionId,
      snapshotRef,
    ],
  );

  const beginQueueItemEdit = useCallback(
    async (queueItemId: string) => {
      if (!sessionId || pendingLockQueueItemId || busyGuard()) return;
      const current = snapshotRef.current;
      const item = current?.queue.items.find((candidate) => candidate.queueItemId === queueItemId);
      if (!item || item.kind === "compact") return;
      const proceed = async () => {
        setPendingLockQueueItemId(queueItemId);
        lockRequestsInFlight.add(queueItemId);
        try {
          // 身份确认前不加锁：复制出的 Web 标签页会在确认时换新 id。
          const confirmedEditorId = await ensureEditorIdentity();
          const ack = await dispatchCommand(
            "lockQueueItemEdit",
            { queueItemId, editorId: confirmedEditorId },
            sessionId,
          );
          if (ack.status !== "accepted" && ack.status !== "duplicate") {
            const reason =
              ack.reasonCode === "guard.queueItemReserved"
                ? "reserved"
                : ack.reasonCode === "guard.queueItemEditLocked"
                  ? "locked"
                  : "generic";
            toast(intl.formatMessage({ id: `chat.composerEdit.lockFailed.${reason}` }));
            return;
          }
          const binding = bindingRef.current;
          if (binding.sessionId !== sessionId || binding.workspaceKey !== workspaceKey) {
            // ACK 返回前 pane 已切 task：不能把旧 session 的内容写进新 composer，锁也要立即还回去。
            void releaseLock(sessionId, queueItemId);
            return;
          }
          const latest = snapshotRef.current?.queue.items.find(
            (candidate) => candidate.queueItemId === queueItemId,
          );
          const source = latest ?? item;
          enterEditScope(
            sessionId,
            { kind: "queueItem", queueItemId },
            {
              inputKind: source.kind === "sendGoalCommand" ? "sendGoalCommand" : "sendText",
              text: v4QueuedCommandText(
                source.kind === "sendGoalCommand" ? "sendGoalCommand" : "sendText",
                source.text,
              ),
              attachments: source.attachments,
              conversationQuotes: source.conversationQuotes,
              config: submittedEditConfig(source, readCurrentDraftConfig()),
            },
            {
              lockConfirmed: latest?.editLock?.editorId === editorId,
            },
          );
        } catch (error) {
          logger.warn("[v4-composer-edit] 冻结队列项失败", error);
          toast(intl.formatMessage({ id: "chat.composerEdit.lockFailed.generic" }));
        } finally {
          lockRequestsInFlight.delete(queueItemId);
          setPendingLockQueueItemId(null);
        }
      };
      runWithSwitchGuard(() => {
        releaseCurrentQueueLock();
        void proceed();
      });
    },
    [
      busyGuard,
      dispatchCommand,
      editorId,
      enterEditScope,
      intl,
      pendingLockQueueItemId,
      readCurrentDraftConfig,
      releaseCurrentQueueLock,
      releaseLock,
      runWithSwitchGuard,
      sessionId,
      snapshotRef,
      workspaceKey,
    ],
  );

  const endEdit = useCallback(
    (releaseQueueLock: boolean) => {
      if (!sessionKey) return;
      const current = getComposerEditSession(sessionKey);
      if (!current) return;
      if (releaseQueueLock && sessionId && current.target.kind === "queueItem") {
        void releaseLock(sessionId, current.target.queueItemId);
      }
      useComposerEditStore.getState().end(sessionKey);
    },
    [releaseLock, sessionId, sessionKey],
  );
  // 取消不提交：composer 离开 edit scope 时按未发送规则清理其中的附件，原草稿附件不受影响。
  const cancelEdit = useCallback(() => endEdit(true), [endEdit]);
  const finishEdit = useCallback(() => endEdit(false), [endEdit]);

  const invalidReason = useComposerEditProjection({
    snapshot,
    sessionId,
    workspaceKey,
    sessionKey,
    editSession,
    editorId,
    editorIdentityConfirmed,
    releaseLock,
  });

  const releaseQueueItemEditLock = useCallback(
    (queueItemId: string) => {
      if (!sessionId) return;
      void releaseLock(sessionId, queueItemId);
    },
    [releaseLock, sessionId],
  );
  const requestEditFocus = useCallback(() => {
    if (sessionKey) useComposerEditStore.getState().requestFocus(sessionKey);
  }, [sessionKey]);

  return {
    editSession,
    invalidReason,
    editorId,
    pendingLockQueueItemId,
    beginUserQueryEdit,
    beginQueueItemEdit,
    cancelEdit,
    finishEdit,
    releaseQueueItemEditLock,
    requestEditFocus,
  };
}
