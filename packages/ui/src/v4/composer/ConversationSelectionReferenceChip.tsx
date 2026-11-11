import { useEffect, useState } from "react";
import { MessageSquareTextIcon, PencilIcon, PlusIcon, QuoteIcon, Trash2Icon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import type { AttachmentHoverCardContentProps } from "@/components/ai-elements/attachments.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  isConversationSelectionReference,
  setHoveredConversationAnnotation,
  subscribeHoveredConversationAnnotation,
  type ConversationSelectionDisplayReference,
} from "@/lib/conversationSelectionReference.js";
import { AnnotationNumber, annotationVariant } from "@/selection-comment/index.js";
import { ContextAttachmentPill } from "@/v4/composer/ContextAttachmentPill.js";

type AnchorPoint = { center: number; top: number; bottom: number };

/**
 * 注释 chip：输入框与历史消息共用。每条注释只算一条（有无评论都一样），
 * 列表编号与正文里的编号一一对应；有评论 = 实心编号，仅原文 = 空心编号。
 */
export function ConversationSelectionReferenceChip({
  references,
  contentAlign = "start",
  numbered = false,
  onRemove,
  onRemoveAll,
  onEdit,
}: {
  references: readonly ConversationSelectionDisplayReference[];
  contentAlign?: AttachmentHoverCardContentProps["align"];
  /** 输入框里的待发送注释：显示“下一条消息将携带 N 条注释”并给每条编号，对应正文标记。 */
  numbered?: boolean;
  onRemove?: (id: string) => void;
  onRemoveAll?: () => void;
  /** 提供时显示铅笔与“添加评论”；fallback 是正文编号不可见时编辑浮层的指向位置。 */
  onEdit?: (id: string, fallback: AnchorPoint) => void;
}) {
  const { intl, locale } = useZCodeIntl();
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  useEffect(
    () => (numbered ? subscribeHoveredConversationAnnotation(setHoveredId) : undefined),
    [numbered],
  );
  if (references.length === 0) return null;
  const filePath = references.length === 1 ? references[0]?.path : undefined;
  const hasComment = references.some((reference) => reference.comment?.trim());
  // 文件引用沿用共用 pill，但不能被注释计数隐藏来源。
  const label = filePath
    ? intl.formatMessage(
        { id: "chat.selections.file" },
        { name: filePath.split(/[\\/]/).pop() ?? filePath },
      )
    : intl.formatMessage(
        {
          id: references.some((reference) => reference.path)
            ? "chat.selections.mixedCount"
            : "chat.selections.count",
        },
        { count: String(references.length) },
      );
  const removeLabel = intl.formatMessage({ id: "chat.selections.remove" });
  const editLabel = intl.formatMessage({ id: "chat.selections.commentEditTitle" });
  const addCommentLabel = intl.formatMessage({ id: "chat.selections.commentAdd" });
  return (
    <ContextAttachmentPill
      contentAlign={contentAlign}
      icon={
        hasComment || numbered ? (
          <MessageSquareTextIcon className="size-4 shrink-0 text-foreground-subtle" />
        ) : (
          <QuoteIcon className="size-4 shrink-0 text-foreground-subtle" />
        )
      }
      label={label}
      onRemoveAll={onRemoveAll}
      removeLabel={intl.formatMessage({ id: "chat.selections.removeAll" })}
      triggerProps={{
        "data-conversation-selection-reference-count": references.length,
      }}
    >
      {numbered ? (
        <div className="flex items-center justify-between gap-2 px-2 pb-1 pt-1.5 text-ui-sm text-foreground-subtle">
          <span className="truncate">
            {intl.formatMessage(
              { id: "chat.selections.listHeader" },
              { count: String(references.length) },
            )}
          </span>
          <span className="shrink-0 text-foreground-subtlest">
            {intl.formatMessage({ id: "chat.selections.listHint" })}
          </span>
        </div>
      ) : null}
      {references.map((reference, index) => {
        const id = isConversationSelectionReference(reference) ? reference.id : null;
        const comment = reference.comment?.trim();
        const editable = Boolean(onEdit && id && reference.path === undefined);
        const openEdit = (target: HTMLElement) => {
          if (!onEdit || !id) return;
          const rect = target
            .closest("[data-conversation-annotation-row]")
            ?.getBoundingClientRect();
          const box = rect ?? target.getBoundingClientRect();
          onEdit(id, { center: box.left + box.width / 2, top: box.top, bottom: box.bottom });
        };
        return (
          <div
            key={id ?? `${index}:${reference.text}`}
            data-conversation-annotation-row={id ?? undefined}
            className={cn(
              "group/reference flex gap-2 rounded-lg px-2 py-1.5 text-ui-base hover:bg-menu-hover",
              numbered && id && hoveredId === id && "bg-menu-hover",
            )}
            onMouseEnter={numbered && id ? () => setHoveredConversationAnnotation(id) : undefined}
            onMouseLeave={numbered && id ? () => setHoveredConversationAnnotation(null) : undefined}
          >
            {numbered ? (
              <AnnotationNumber
                value={index + 1}
                variant={annotationVariant(comment)}
                className="mt-0.5"
              />
            ) : (
              <QuoteIcon className="mt-0.5 size-4 shrink-0 text-foreground-subtle" />
            )}
            <div className="min-w-0 flex-1">
              {reference.senderName || reference.senderId || reference.sentAt ? (
                <div className="mb-1 text-ui-sm text-foreground-subtle">
                  {reference.senderName ||
                    (reference.senderId
                      ? `${reference.senderId.slice(0, 8)}…${reference.senderId.slice(-4)}`
                      : "")}
                  {reference.sentAt ? (
                    <>
                      {" "}
                      ·{" "}
                      {new Date(reference.sentAt).toLocaleTimeString(locale, {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </>
                  ) : null}
                </div>
              ) : null}
              {/* 原文每行都完整保留，最多两行，悬停看全文；有评论时原文降为次级色。 */}
              <div
                title={reference.text}
                className={cn(
                  "line-clamp-2 whitespace-pre-wrap break-words",
                  comment && "text-foreground-subtle",
                )}
              >
                {reference.text}
              </div>
              {comment ? (
                // 评论是用户自己的话，加重字重显示在原文下方，避免读成原文的一部分。
                <div
                  data-conversation-selection-comment="true"
                  className="mt-1 whitespace-pre-wrap break-words font-medium"
                >
                  {comment}
                </div>
              ) : editable ? (
                <button
                  type="button"
                  data-conversation-annotation-add-comment="true"
                  className="mt-1 flex items-center gap-1 text-ui-sm text-icon-blue hover:underline"
                  onClick={(event) => openEdit(event.currentTarget)}
                >
                  <PlusIcon className="size-3.5" />
                  {addCommentLabel}
                </button>
              ) : null}
              {reference.path || isConversationSelectionReference(reference) ? (
                <div className="mt-0.5 break-words text-ui-sm text-foreground-subtlest">
                  {reference.path ? (
                    reference.path
                  ) : isConversationSelectionReference(reference) &&
                    reference.contentType === "markdown" ? (
                    reference.sourceTitle
                  ) : isConversationSelectionReference(reference) &&
                    reference.contentType !== "markdown" ? (
                    <>
                      {intl.formatMessage({ id: `chat.selections.type.${reference.contentType}` })}{" "}
                      · #{reference.sourceRowId}
                      {reference.agent ? ` · ${reference.agent}` : null}
                    </>
                  ) : null}
                </div>
              ) : reference.agent ? (
                <div className="mt-0.5 text-ui-sm text-foreground-subtlest">{reference.agent}</div>
              ) : null}
            </div>
            {editable || (onRemove && id) ? (
              <div className="flex shrink-0 items-start gap-0.5 opacity-0 group-hover/reference:opacity-100 group-focus-within/reference:opacity-100">
                {editable ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="size-5 text-foreground-subtle"
                    aria-label={editLabel}
                    title={editLabel}
                    data-conversation-annotation-edit="true"
                    onClick={(event) => openEdit(event.currentTarget)}
                  >
                    <PencilIcon className="size-3.5" />
                  </Button>
                ) : null}
                {onRemove && id ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="size-5 text-foreground-subtle"
                    aria-label={removeLabel}
                    title={removeLabel}
                    onClick={() => onRemove(id)}
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </ContextAttachmentPill>
  );
}
