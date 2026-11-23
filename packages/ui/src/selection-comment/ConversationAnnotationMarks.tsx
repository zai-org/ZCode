import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal, flushSync } from "react-dom";
import { cn } from "@/components/lib/utils.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ConversationSelectionTextAnchor } from "@/lib/conversationSelectionReference.js";
import {
  AnnotationNumber,
  type AnnotationNumberVariant,
} from "@/selection-comment/AnnotationNumber.js";
import {
  CODE_BLOCK_HOST_SELECTOR,
  getSelectionLineRects,
  resolveSelectionTextAnchor,
} from "@/selection-comment/textAnchor.js";

export interface AnnotationMarkItem {
  id: string;
  number: number;
  variant: AnnotationNumberVariant;
  rowId: number;
  anchor: ConversationSelectionTextAnchor;
  text: string;
  /** 已发送注释当时的评论；悬停灰色编号时展示。 */
  comment?: string;
}

interface MarkLayout {
  id: string;
  number: number;
  variant: AnnotationNumberVariant;
  text: string;
  comment?: string;
  lines: { left: number; top: number; width: number; height: number }[];
}

/** 时间线消息层（relative、随内容滚动）；标记挂在这里就不用跟着 scroll 事件重算位置。 */
const MESSAGE_LAYER_SELECTOR = '[data-v4-timeline-message-layer="true"]';
const OVERLAY_ATTRIBUTE = "data-conversation-annotation-marks";

function sameLayouts(a: readonly MarkLayout[], b: readonly MarkLayout[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 正文里的注释标记：选区下划线 + 末尾编号气泡。
 *
 * 不改 Markdown 渲染树：标记是消息层上的绝对定位覆盖层，坐标由文字锚点还原出的 Range 计算。
 * 这样流式输出、虚拟滚动卸载/重挂、主题切换都不需要改动行组件；行没挂载或文字对不上时就不画。
 * 覆盖层整体 pointer-events: none，只有角标露在文字行上方的那一截可交互，不影响正文继续划词。
 */
export function ConversationAnnotationMarks({
  rootRef,
  items,
  hoveredId,
  onHover,
  onActivate,
}: {
  rootRef: RefObject<HTMLElement | null>;
  items: readonly AnnotationMarkItem[];
  hoveredId: string | null;
  onHover: (id: string | null) => void;
  /** 点编号气泡：打开编辑浮层，rect 是气泡在视口里的位置。 */
  onActivate: (id: string, rect: DOMRect) => void;
}) {
  const { intl } = useZCodeIntl();
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [layouts, setLayouts] = useState<readonly MarkLayout[]>([]);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const frameRef = useRef<number | null>(null);

  const measure = useCallback(() => {
    frameRef.current = null;
    const root = rootRef.current;
    const nextHost = root?.querySelector<HTMLElement>(MESSAGE_LAYER_SELECTOR) ?? null;
    setHost((current) => (current === nextHost ? current : nextHost));
    if (!root || !nextHost) {
      setLayouts((current) => (current.length === 0 ? current : []));
      return;
    }
    const hostRect = nextHost.getBoundingClientRect();
    const next: MarkLayout[] = [];
    for (const item of itemsRef.current) {
      const row = root.querySelector<HTMLElement>(`[data-row-id="${item.rowId}"]`);
      const range = row ? resolveSelectionTextAnchor(row, item.anchor, item.text) : null;
      const lines = range ? getSelectionLineRects(range) : [];
      if (lines.length === 0) continue;
      next.push({
        id: item.id,
        number: item.number,
        variant: item.variant,
        text: item.text,
        ...(item.comment ? { comment: item.comment } : {}),
        lines: lines.map((line) => ({
          left: line.left - hostRect.left,
          top: line.top - hostRect.top,
          width: line.right - line.left,
          height: line.bottom - line.top,
        })),
      });
    }
    setLayouts((current) => (sameLayouts(current, next) ? current : next));
  }, [rootRef]);

  const schedule = useCallback(() => {
    if (frameRef.current !== null) return;
    // 问题原因：rAF 里只调 setState，React 要到之后的任务才提交，这一帧画出来的还是旧位置，
    // 正文已经重排而划线慢一拍（切回会话、虚拟行重新挂载时最明显）。rAF 在绘制前执行，
    // 用 flushSync 让新位置和正文在同一帧上屏。
    frameRef.current = requestAnimationFrame(() => flushSync(measure));
  }, [measure]);

  useLayoutEffect(() => {
    measure();
  }, [items, measure]);

  const active = items.length > 0;
  useEffect(() => {
    const root = rootRef.current;
    if (!active || !root) return;
    // 流式 delta、虚拟行挂载/位移、表格展开都会改变文字位置；合并到下一帧重算一次。
    // 覆盖层自身的更新也在 root 子树里，必须过滤掉，否则会自我触发死循环。
    // 问题原因：代码块的横向滚动容器在 Shadow DOM 里，scroll 事件不会传到外面，也不产生
    // mutation。代码行的下划线按滚动后的位置裁剪，横向滚动后不重算就会留在旧位置。
    // 这里直接在各代码块的 shadow root 上监听；代码块会随虚拟行挂载和卸载，所以每次 DOM 变化后
    // 同步一遍：新挂载的补上监听，已经离开时间线的摘掉监听并从集合里移除，否则长对话来回滚动时
    // 集合会一直持有卸载掉的代码块。
    const codeRoots = new Set<ShadowRoot>();
    const watchCodeBlocks = () => {
      for (const shadow of codeRoots) {
        if (root.contains(shadow.host)) continue;
        shadow.removeEventListener("scroll", schedule, { capture: true });
        codeRoots.delete(shadow);
      }
      for (const host of root.querySelectorAll(CODE_BLOCK_HOST_SELECTOR)) {
        const shadow = host.shadowRoot;
        if (!shadow || codeRoots.has(shadow)) continue;
        codeRoots.add(shadow);
        shadow.addEventListener("scroll", schedule, { capture: true, passive: true });
      }
    };
    watchCodeBlocks();
    const mutations = new MutationObserver((records) => {
      if (records.some((record) => record.type === "childList")) watchCodeBlocks();
      if (
        records.some(
          (record) =>
            !(
              record.target instanceof Element ? record.target : record.target.parentElement
            )?.closest(`[${OVERLAY_ATTRIBUTE}]`),
        )
      ) {
        schedule();
      }
    });
    mutations.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["style", "class", "open", "data-state"],
    });
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    resize?.observe(root);
    const layer = root.querySelector(MESSAGE_LAYER_SELECTOR);
    if (layer) resize?.observe(layer);
    window.addEventListener("resize", schedule);
    return () => {
      mutations.disconnect();
      resize?.disconnect();
      for (const shadow of codeRoots) {
        shadow.removeEventListener("scroll", schedule, { capture: true });
      }
      codeRoots.clear();
      window.removeEventListener("resize", schedule);
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, [active, rootRef, schedule]);

  if (!host || layouts.length === 0) return null;
  return createPortal(
    <div
      {...{ [OVERLAY_ATTRIBUTE]: "true" }}
      aria-hidden="false"
      className="pointer-events-none absolute inset-0 select-none"
    >
      {layouts.map((layout) => {
        const sent = layout.variant === "sent-comment" || layout.variant === "sent-quote";
        const pending = layout.variant === "pending";
        const solid = layout.variant === "comment" || layout.variant === "sent-comment";
        const highlighted = hoveredId === layout.id && !sent;
        const last = layout.lines[layout.lines.length - 1];
        if (!last) return null;
        // 角标是 18px 的气泡，左下角收尖，贴在选区末尾的右上方：底边只探入文字行约 4px，
        // 其余部分在行间空隙和上一行的下沿。太小看不清编号，太低又会盖住后面的字。
        const numberStyle = { left: last.left + last.width - 3, top: last.top - 14 };
        const numberClassName = "absolute flex rounded-full rounded-bl-sm";
        const numberHitClassName = "pointer-events-auto absolute inset-x-0 top-0 h-3.5";
        return (
          <div key={layout.id} data-annotation-mark={layout.id}>
            {layout.lines.map((line, index) => (
              <div
                key={index}
                className={cn(
                  "absolute",
                  // 新增时输入框抢走焦点会折叠浏览器选区；用同色底保留“正在注释哪段”的高亮。
                  (pending || highlighted) && "rounded-[2px] bg-icon-blue/15",
                )}
                style={{ left: line.left, top: line.top, width: line.width, height: line.height }}
              >
                <div
                  className={cn(
                    "absolute inset-x-0 bottom-0 border-b-[1.5px]",
                    solid ? "border-solid" : "border-dotted",
                    sent ? "border-foreground-subtlest" : "border-icon-blue",
                  )}
                />
              </div>
            ))}
            {/* 角标本身不接收鼠标，只有露在文字行上方的那一截（14px）可以悬停或点击。
                问题原因：角标底边探入文字行约 4px，整个角标都可交互时，会挡住它下面那几个字的
                上沿，从那里按下鼠标划词会落在角标上。已发送的标记一直留在正文里，影响更明显。 */}
            <span className={numberClassName} style={numberStyle}>
              <AnnotationNumber
                value={layout.number}
                variant={layout.variant}
                highlighted={highlighted}
                size="mark"
              />
              {pending ? null : sent ? (
                // 已发送的标记留在正文里方便回看；悬停编号可以看到当时发出的原文和评论。
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      data-annotation-sent-mark={layout.number}
                      className={cn(numberHitClassName, "cursor-default")}
                    />
                  </TooltipTrigger>
                  <TooltipContent
                    side="top"
                    sideOffset={4}
                    data-annotation-sent-detail="true"
                    className="max-w-sm flex-col items-start gap-1"
                  >
                    <span className="text-foreground-subtle">
                      {intl.formatMessage({ id: "chat.selections.sentTitle" })}
                    </span>
                    <span className="line-clamp-3 border-l-2 border-border pl-2 text-foreground-subtle">
                      {layout.text}
                    </span>
                    {layout.comment ? <span className="line-clamp-6">{layout.comment}</span> : null}
                  </TooltipContent>
                </Tooltip>
              ) : (
                <button
                  type="button"
                  data-annotation-mark-id={layout.id}
                  data-annotation-mark-number={layout.number}
                  aria-label={String(layout.number)}
                  className={cn(
                    numberHitClassName,
                    "rounded-full outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused",
                  )}
                  onPointerDown={(event) => event.preventDefault()}
                  onMouseEnter={() => onHover(layout.id)}
                  onMouseLeave={() => onHover(null)}
                  onClick={(event) =>
                    onActivate(layout.id, event.currentTarget.getBoundingClientRect())
                  }
                />
              )}
            </span>
          </div>
        );
      })}
    </div>,
    host,
  );
}
