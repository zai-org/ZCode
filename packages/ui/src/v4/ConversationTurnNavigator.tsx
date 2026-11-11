import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  TID_V4_TURN_NAVIGATOR,
  TID_V4_TURN_NAVIGATOR_ITEM,
  TID_V4_TURN_NAVIGATOR_TOOLTIP,
  testId,
} from "@zcode/shared/test-ids";
import { cn } from "@/components/lib/utils.js";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  createConversationTurnNavigatorItemsSelector,
  type ConversationTurnNavigatorItem,
  resolveConversationTurnNavigatorActiveUnitIndex,
  resolveConversationTurnNavigatorBarVisualState,
  resolveConversationTurnNavigatorVisualFocusItemIndex,
  type ConversationTurnNavigatorVirtualItem,
} from "@/v4/conversationTurnNavigatorHelpers.js";
import type { ConversationTurnRenderUnitsPartition } from "@/v4/conversationTurnRenderUnits.js";

export interface ConversationTurnNavigatorProps {
  enabled?: boolean;
  /** 按「历史 + 尾轮」分区的 render unit；历史段引用在流式帧之间不变。 */
  renderUnits: ConversationTurnRenderUnitsPartition;
  scrollOffsetPx: number;
  viewportHeightPx: number;
  virtualItems: readonly ConversationTurnNavigatorVirtualItem[];
  activeQueryRowId?: number;
  isHydratingDirectory?: boolean;
  onJumpToQuery: (target: { unitIndex: number; rowId: number }, behavior: ScrollBehavior) => void;
}

function usePrefersReducedMotion() {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) {
      return;
    }
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setPrefersReducedMotion(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return prefersReducedMotion;
}

function ConversationTurnNavigatorImpl({
  enabled = true,
  renderUnits,
  scrollOffsetPx,
  viewportHeightPx,
  virtualItems,
  activeQueryRowId,
  isHydratingDirectory = false,
  onJumpToQuery,
}: ConversationTurnNavigatorProps) {
  const { intl } = useZCodeIntl();
  const prefersReducedMotion = usePrefersReducedMotion();
  const [interactionItemIndex, setInteractionItemIndex] = useState<number | undefined>(undefined);
  const selectItems = useMemo(() => createConversationTurnNavigatorItemsSelector(), []);
  const items = useMemo(
    () =>
      selectItems(renderUnits, {
        assistantEmptyPreview: intl.formatMessage({
          id: "chat.turnNavigator.emptyAssistant",
        }),
        assistantRunningPreview: intl.formatMessage({
          id: "chat.turnNavigator.runningAssistant",
        }),
        userFallbackPreview: intl.formatMessage({
          id: "chat.turnNavigator.userFallback",
        }),
      }),
    [intl, renderUnits, selectItems],
  );

  const activeUnitIndex = useMemo(
    () =>
      resolveConversationTurnNavigatorActiveUnitIndex({
        items,
        scrollOffsetPx,
        viewportHeightPx,
        virtualItems,
      }),
    [items, scrollOffsetPx, viewportHeightPx, virtualItems],
  );
  const itemIndexes = useMemo(() => {
    const byRowId = new Map<number, number>();
    const firstByUnitIndex = new Map<number, number>();
    items.forEach((item, index) => {
      byRowId.set(item.rowId, index);
      if (!firstByUnitIndex.has(item.unitIndex)) {
        firstByUnitIndex.set(item.unitIndex, index);
      }
    });
    return { byRowId, firstByUnitIndex };
  }, [items]);
  const activeItemIndex =
    (activeQueryRowId === undefined ? undefined : itemIndexes.byRowId.get(activeQueryRowId)) ??
    (activeUnitIndex === undefined
      ? undefined
      : itemIndexes.firstByUnitIndex.get(activeUnitIndex)) ??
    -1;
  const visualFocusItemIndex = resolveConversationTurnNavigatorVisualFocusItemIndex({
    activeItemIndex,
    interactionItemIndex,
  });
  const railScrollRef = useRef<HTMLDivElement>(null);
  const getRailScrollElement = useCallback(() => railScrollRef.current, []);
  const getRailItemKey = useCallback((index: number) => items[index]?.key ?? index, [items]);
  const railVirtualizer = useVirtualizer({
    enabled,
    count: items.length,
    estimateSize: () => 10,
    getItemKey: getRailItemKey,
    getScrollElement: getRailScrollElement,
    overscan: 6,
  });
  const virtualRows = railVirtualizer.getVirtualItems();

  useEffect(() => {
    if (!enabled || activeItemIndex < 0 || items.length < 2) return;
    railVirtualizer.scrollToIndex(activeItemIndex, { align: "auto" });
    const element = railScrollRef.current;
    if (!element) return;
    window.queueMicrotask(() => {
      if (railScrollRef.current !== element) return;
      // 目录从 tail 一次扩展到上千项时，scrollToIndex 与 virtualizer 的
      // measurement 更新处于同一个 commit，Chromium 可能合并 scroll 通知。补发通知
      // 只同步 rail observer，确保活动项对应的可视窗口立即挂载。
      element.dispatchEvent(new Event("scroll"));
    });
  }, [activeItemIndex, enabled, items.length, railVirtualizer]);

  if (items.length < 2) {
    return null;
  }

  return (
    <nav
      aria-label={intl.formatMessage({ id: "chat.turnNavigator.label" })}
      aria-busy={isHydratingDirectory}
      data-testid={TID_V4_TURN_NAVIGATOR}
      data-item-count={items.length}
      data-rendered-item-count={virtualRows.length}
      className="pointer-events-none invisible absolute inset-y-0 left-0 z-10 w-12 -translate-x-2 opacity-0 transition-[opacity,transform,visibility] duration-150 ease-out motion-reduce:transition-none @min-[864px]/conversation:visible @min-[864px]/conversation:translate-x-0 @min-[864px]/conversation:opacity-100"
    >
      <div
        ref={railScrollRef}
        // 只声明 overflow-y-auto 时，浏览器会把 overflow-x 计算为 auto；
        // hover 山峰横向放大后便可能触发横向滚动条，因此 rail 必须只开放纵向滚动。
        className="!scrollbar-hide pointer-events-auto absolute left-3 top-1/2 max-h-[calc(100%-6rem)] w-9 -translate-y-1/2 overflow-x-hidden overflow-y-auto py-1"
        onPointerLeave={() => setInteractionItemIndex(undefined)}
        onScroll={() => setInteractionItemIndex(undefined)}
      >
        <div className="relative w-9" style={{ height: `${railVirtualizer.getTotalSize()}px` }}>
          {virtualRows.map((virtualRow) => {
            const itemIndex = virtualRow.index;
            const item = items[itemIndex];
            if (!item) return null;
            return (
              <ConversationTurnNavigatorItemView
                key={item.key}
                item={item}
                itemIndex={itemIndex}
                itemCount={items.length}
                start={virtualRow.start}
                active={itemIndex === activeItemIndex}
                visualDistance={
                  visualFocusItemIndex === undefined
                    ? undefined
                    : Math.min(3, Math.abs(itemIndex - visualFocusItemIndex))
                }
                prefersReducedMotion={prefersReducedMotion}
                onInteractionChange={setInteractionItemIndex}
                onJumpToQuery={onJumpToQuery}
              />
            );
          })}
        </div>
      </div>
    </nav>
  );
}

// 父级每个 hover/stream 都执行全部 HoverCard；按条目实际视觉输入隔离，仍保留邻近山峰变化。
const ConversationTurnNavigatorItemView = memo(function ConversationTurnNavigatorItemView({
  item,
  itemIndex,
  itemCount,
  start,
  active,
  visualDistance,
  prefersReducedMotion,
  onInteractionChange,
  onJumpToQuery,
}: {
  item: ConversationTurnNavigatorItem;
  itemIndex: number;
  itemCount: number;
  start: number;
  active: boolean;
  visualDistance: number | undefined;
  prefersReducedMotion: boolean;
  onInteractionChange: (index: number | undefined) => void;
  onJumpToQuery: ConversationTurnNavigatorProps["onJumpToQuery"];
}) {
  const { intl } = useZCodeIntl();
  const visualState = resolveConversationTurnNavigatorBarVisualState({
    itemIndex: 0,
    visualFocusItemIndex: visualDistance,
  });
  const showScrollActiveColor = visualDistance === undefined && active;
  return (
    <div
      className="absolute left-0 top-0 h-2.5 w-9"
      style={{ transform: `translateY(${start}px)` }}
    >
      <HoverCard closeDelay={80} openDelay={120}>
        <HoverCardTrigger asChild>
          <button
            type="button"
            aria-current={active ? "location" : undefined}
            aria-label={intl.formatMessage(
              { id: "chat.turnNavigator.jumpToQuery" },
              { index: String(itemIndex + 1) },
            )}
            aria-posinset={itemIndex + 1}
            aria-setsize={itemCount}
            data-testid={testId(TID_V4_TURN_NAVIGATOR_ITEM, item.key)}
            data-item-index={itemIndex}
            data-unit-index={item.unitIndex}
            data-turn-id={item.turnId}
            data-query-row-id={item.rowId}
            data-active={active ? "true" : "false"}
            data-running={item.isRunning ? "true" : "false"}
            data-visual-color-tone={visualState.colorTone}
            data-visual-scale={String(visualState.scaleX)}
            data-visual-tone={visualState.tone}
            onBlur={() => onInteractionChange(undefined)}
            onClick={() =>
              onJumpToQuery(
                { unitIndex: item.unitIndex, rowId: item.rowId },
                prefersReducedMotion ? "auto" : "smooth",
              )
            }
            onFocus={() => onInteractionChange(itemIndex)}
            onPointerEnter={() => onInteractionChange(itemIndex)}
            onPointerLeave={() => onInteractionChange(undefined)}
            className="flex h-2.5 w-9 items-center justify-start rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            {/* 入场位移与 hover 缩放分层，避免覆盖同一个 transform；按钮命中区域保持不动。 */}
            <span className="zcode-turn-navigator-enter block" aria-hidden="true">
              <span
                className={cn(
                  "block h-0.5 w-3 origin-left rounded-full transition-[height,opacity,transform,background-color] duration-150 ease-out motion-reduce:transition-none",
                  visualState.colorTone === "focus" && "bg-foreground",
                  visualState.colorTone === "muted" &&
                    (showScrollActiveColor ? "bg-foreground" : "bg-foreground-subtlest"),
                )}
                style={{
                  opacity: showScrollActiveColor
                    ? 0.9
                    : item.isRunning
                      ? Math.max(visualState.opacity, 0.72)
                      : visualState.opacity,
                  transform: `scaleX(${visualState.scaleX})`,
                }}
              />
            </span>
          </button>
        </HoverCardTrigger>
        <HoverCardContent
          align="start"
          side="right"
          sideOffset={8}
          data-testid={testId(TID_V4_TURN_NAVIGATOR_TOOLTIP, item.key)}
          className="w-80 max-w-[calc(100vw-2rem)] border border-popover-border bg-popover p-3 text-popover-foreground shadow-lg"
        >
          <div className="space-y-2">
            <p className="line-clamp-2 whitespace-pre-line text-ui-base font-medium leading-5">
              {item.userPreview}
            </p>
            <p
              className={cn(
                "line-clamp-3 whitespace-pre-line text-ui-base leading-5",
                item.assistantPreviewKind === "text"
                  ? "text-popover-foreground/80"
                  : "text-foreground-subtle",
              )}
            >
              {item.assistantPreview}
            </p>
          </div>
        </HoverCardContent>
      </HoverCard>
    </div>
  );
});

export const ConversationTurnNavigator = memo(ConversationTurnNavigatorImpl, (previous, next) => {
  if (previous.enabled !== next.enabled) return false;
  // CSS 隐藏时保留外壳的过渡，但不传播正文更新；恢复 enabled 会读取完整的最新 props。
  if (next.enabled === false) return true;
  return (
    previous.renderUnits === next.renderUnits &&
    previous.isHydratingDirectory === next.isHydratingDirectory &&
    previous.onJumpToQuery === next.onJumpToQuery &&
    previous.activeQueryRowId === next.activeQueryRowId &&
    // 已有精确 query 锚点时，像素偏移不会改变目录显示。尚未挂载锚点时仍更新 unit fallback。
    (next.activeQueryRowId !== undefined ||
      (previous.scrollOffsetPx === next.scrollOffsetPx &&
        previous.viewportHeightPx === next.viewportHeightPx &&
        previous.virtualItems === next.virtualItems))
  );
});
