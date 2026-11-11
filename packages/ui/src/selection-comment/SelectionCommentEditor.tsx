import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CornerDownLeftIcon, Trash2Icon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { CONVERSATION_SELECTION_MAX_COMMENT_LENGTH } from "@/lib/conversationSelectionReference.js";
import {
  useSelectionAnchoredPosition,
  type SelectionAnchoredPlacement,
} from "@/v4/SelectionActionMenu.js";
import {
  AnnotationNumber,
  type AnnotationNumberVariant,
} from "@/selection-comment/AnnotationNumber.js";

/**
 * 选区“注释”输入浮层，新增与编辑共用。它独立于 useTextSelection：聚焦输入框会折叠正文选区并触发
 * keyup/selectionchange，若仍跟随选区状态，浮层会在输入第一个字时被关掉。
 *
 * 评论可选：新增时留空直接回车 = 只加原文（取代原“添加到当前任务”）；编辑时清空评论 = 回到只保留原文，
 * 不会因此删掉这条注释。删除注释只在编辑态由显式按钮触发。
 */
export function SelectionCommentEditor({
  mode = "add",
  number,
  numberVariant = "comment",
  center,
  top,
  bottom,
  quote,
  initialComment = "",
  error,
  onSave,
  onCancel,
  onDelete,
}: {
  mode?: "add" | "edit";
  /** 这条注释在列表与正文里的编号；新增时为预占编号。 */
  number: number;
  /** 编号气泡形态与正文一致：编辑仅原文注释时为空心。 */
  numberVariant?: AnnotationNumberVariant;
  center: number;
  top: number;
  bottom: number;
  quote: string;
  initialComment?: string;
  /** 保存被拒（如注释已满）时的本地化提示；浮层保持打开、输入保留。 */
  error?: string | null;
  /** comment 已 trim，可能为空；返回 false 表示未保存，浮层与输入保持原样。 */
  onSave: (comment: string) => boolean;
  onCancel: () => void;
  /** 仅编辑态：删除整条注释。 */
  onDelete?: () => void;
}) {
  const { intl, locale } = useZCodeIntl();
  const ref = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState(initialComment);
  const [placement, setPlacement] = useState<SelectionAnchoredPlacement | null>(null);
  const latestCancel = useRef(onCancel);
  latestCancel.current = onCancel;
  useSelectionAnchoredPosition(ref, { center, top, bottom }, `${mode}:${locale}`, setPlacement, 12);

  useEffect(() => {
    const input = inputRef.current;
    input?.focus({ preventScroll: true });
    // 编辑已有评论时光标放到末尾，方便直接续写。
    input?.setSelectionRange(input.value.length, input.value.length);
    const dismiss = (event: PointerEvent) => {
      if (ref.current?.contains(event.target as Node)) return;
      latestCancel.current();
    };
    document.addEventListener("pointerdown", dismiss, true);
    return () => document.removeEventListener("pointerdown", dismiss, true);
  }, []);

  const save = () => {
    onSave(value.trim());
  };
  const msg = (id: string) => intl.formatMessage({ id });
  const editing = mode === "edit";
  return createPortal(
    <form
      ref={ref}
      role="dialog"
      aria-label={msg(editing ? "chat.selections.commentEditTitle" : "chat.selections.comment")}
      data-conversation-selection-tooltip="true"
      data-conversation-selection-comment-editor="true"
      data-conversation-selection-comment-mode={mode}
      style={{ left: 12, top: 12 }}
      className="fixed z-50 flex w-96 max-w-[calc(100vw-24px)] flex-col gap-1.5 rounded-lg border border-popover-border bg-menu p-1.5 text-ui-base text-foreground shadow-md"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      {placement ? (
        // 箭头指向正文里的选区或编号，说明这张卡片在评论哪一段。
        <span
          aria-hidden="true"
          style={{ left: placement.arrowLeft - 5 }}
          className={cn(
            "pointer-events-none absolute size-2.5 rotate-45 border-popover-border bg-menu",
            placement.side === "above"
              ? "-bottom-[5.5px] border-b border-r"
              : "-top-[5.5px] border-l border-t",
          )}
        />
      ) : null}
      <div className="flex min-w-0 items-center gap-1.5 px-1 pt-0.5 text-ui-sm text-foreground-subtle">
        <AnnotationNumber value={number} variant={numberVariant} />
        <span className="truncate">
          {msg(editing ? "chat.selections.commentEditTitle" : "chat.selections.commentAddTitle")}
        </span>
      </div>
      <div className="mx-1 line-clamp-2 min-w-0 break-words border-l-2 border-border pl-2 text-ui-sm text-foreground-subtle">
        {quote}
      </div>
      <textarea
        ref={inputRef}
        rows={2}
        value={value}
        maxLength={CONVERSATION_SELECTION_MAX_COMMENT_LENGTH}
        aria-label={msg("chat.selections.commentPlaceholder")}
        placeholder={msg("chat.selections.commentPlaceholder")}
        data-conversation-selection-comment-input="true"
        className="max-h-32 min-h-14 w-full resize-none rounded-md border border-input-border bg-input px-2 py-1.5 text-ui-base text-foreground outline-none placeholder:text-foreground-subtlest hover:border-input-border-hover focus:border-input-border-focused focus:bg-input-focused max-md:text-mobile-input-safe"
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          // 输入法候选上屏的 Enter 不能当作保存。
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          } else if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            save();
          }
        }}
      />
      {error ? (
        <span
          role="alert"
          data-conversation-selection-comment-error="true"
          className="px-1 text-ui-sm text-[var(--color-warning)]"
        >
          {error}
        </span>
      ) : editing ? (
        <span className="px-1 text-ui-sm text-foreground-subtlest">
          {msg("chat.selections.commentEditHint")}
        </span>
      ) : null}
      <div className="flex items-center justify-between gap-2 pl-1">
        {editing ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="-ml-1 gap-1 rounded-md text-[var(--color-warning)] hover:text-[var(--color-warning)]"
            data-conversation-selection-comment-delete="true"
            onClick={onDelete}
          >
            <Trash2Icon className="size-3.5" />
            {msg("chat.selections.commentDelete")}
          </Button>
        ) : (
          <span className="min-w-0 truncate text-ui-sm text-foreground-subtlest">
            {msg("chat.selections.commentHint")}
          </span>
        )}
        <div className="flex shrink-0 items-center gap-1">
          <Button type="button" variant="ghost" size="sm" className="rounded-md" onClick={onCancel}>
            {msg("common.cancel")}
          </Button>
          <Button
            type="submit"
            size="sm"
            className="gap-1 rounded-md"
            data-conversation-selection-comment-save="true"
          >
            {msg(editing ? "chat.selections.commentEditSave" : "chat.selections.commentSave")}
            {editing ? null : <CornerDownLeftIcon className="size-3" />}
          </Button>
        </div>
      </div>
    </form>,
    document.body,
  );
}
