import { useLayoutEffect, useRef, type RefObject } from "react";
import { createPortal } from "react-dom";
import { MessageSquareTextIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export interface SelectionAnchoredPlacement {
  /** 浮层落在锚点上方还是下方；箭头画在靠近锚点的那条边上。 */
  side: "above" | "below";
  /** 锚点中心相对浮层左边的距离，已钳在浮层内。 */
  arrowLeft: number;
}

/** 选区浮层统一定位：优先放在选区上方居中，放不下翻到下方，并钳在视口内。 */
export function useSelectionAnchoredPosition(
  ref: RefObject<HTMLElement | null>,
  anchor: { center: number; top: number; bottom: number },
  layoutKey: unknown,
  onPlaced?: (placement: SelectionAnchoredPlacement) => void,
  gap = 8,
) {
  const { center, top, bottom } = anchor;
  const placedRef = useRef(onPlaced);
  placedRef.current = onPlaced;
  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const position = () => {
      const rect = menu.getBoundingClientRect();
      const left = Math.max(
        12,
        Math.min(window.innerWidth - rect.width - 12, center - rect.width / 2),
      );
      menu.style.left = `${left}px`;
      const above = top - rect.height - gap >= 12;
      const preferredTop = above ? top - rect.height - gap : bottom + gap;
      menu.style.top = `${Math.max(12, Math.min(window.innerHeight - rect.height - 12, preferredTop))}px`;
      placedRef.current?.({
        side: above ? "above" : "below",
        arrowLeft: Math.max(14, Math.min(rect.width - 14, center - left)),
      });
    };
    position();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(position);
    observer?.observe(menu);
    return () => observer?.disconnect();
  }, [ref, center, top, bottom, layoutKey, gap]);
}

// 问题原因：Markdown 曾复制一份固定宽度的竖排菜单，与对话流逐渐分叉。
// 两处只传选区位置与动作，共用展示和尺寸测量，避免再次出现样式差异。
export function SelectionActionMenu({
  center,
  top,
  bottom,
  singleLimit,
  sideActionDisabled,
  sideDisabledTitle,
  onAddToCurrentTask,
  onAskInSideChat,
  onComment,
}: {
  center: number;
  top: number;
  bottom: number;
  singleLimit?: boolean;
  sideActionDisabled?: boolean;
  sideDisabledTitle?: string;
  onAddToCurrentTask: () => void;
  onAskInSideChat: () => void;
  /**
   * 提供时显示“注释”并取代“添加到当前任务”：注释的评论可选，留空即等于原来的添加原文。
   * Markdown 预览与不支持评论的旧 CLI 不提供，继续显示“添加到当前任务”。
   */
  onComment?: () => void;
}) {
  const { intl, locale } = useZCodeIntl();
  const ref = useRef<HTMLDivElement>(null);
  useSelectionAnchoredPosition(ref, { center, top, bottom }, `${String(singleLimit)}:${locale}`);
  return createPortal(
    <div
      ref={ref}
      data-conversation-selection-tooltip="true"
      style={{
        width: "max-content",
        maxWidth: Math.min(576, window.innerWidth - 24),
        left: 12,
        top: 12,
      }}
      className="fixed z-50 flex overflow-hidden rounded-lg border border-popover-border bg-menu text-ui-sm text-foreground shadow-md"
      onPointerDown={(event) => event.preventDefault()}
      onMouseDown={(event) => event.preventDefault()}
    >
      {singleLimit ? (
        <div className="px-2.5 py-1.5 text-[var(--color-warning)]">
          {intl.formatMessage({ id: "chat.selections.limit.single" })}
        </div>
      ) : (
        <>
          {onComment ? (
            <>
              <button
                type="button"
                data-conversation-selection-action="comment"
                className="flex min-w-0 items-center gap-1 px-2.5 py-1.5 hover:bg-menu-hover"
                onClick={onComment}
              >
                <MessageSquareTextIcon className="size-3.5 shrink-0 text-foreground-subtle" />
                {intl.formatMessage({ id: "chat.selections.comment" })}
              </button>
              <div className="w-px shrink-0 bg-border" />
            </>
          ) : (
            <>
              <button
                type="button"
                data-conversation-selection-action="add-to-task"
                className="min-w-0 px-2.5 py-1.5 hover:bg-menu-hover"
                onClick={onAddToCurrentTask}
              >
                {intl.formatMessage({ id: "chat.selections.addToTask" })}
              </button>
              <div className="w-px shrink-0 bg-border" />
            </>
          )}
          <button
            type="button"
            data-conversation-selection-action="ask-in-side-chat"
            disabled={sideActionDisabled}
            title={sideActionDisabled ? sideDisabledTitle : undefined}
            className={cn(
              "min-w-0 px-2.5 py-1.5 hover:bg-menu-hover",
              sideActionDisabled && "cursor-not-allowed opacity-50 hover:bg-transparent",
            )}
            onClick={() => {
              if (!sideActionDisabled) onAskInSideChat();
            }}
          >
            {intl.formatMessage({ id: "chat.selections.askInSideChat" })}
          </button>
        </>
      )}
    </div>,
    document.body,
  );
}
