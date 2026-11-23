import { memo, useEffect, useLayoutEffect, useRef, type CSSProperties } from "react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { LocateFixed } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { ScrollArea } from "@/components/ui/scroll-area.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { resolveConversationShareSelectionPanelMotion } from "@/v4/conversationShareModeMotion.js";
import {
  CONVERSATION_SHARE_SELECTION_PANEL_CENTER_Y_PROPERTY,
  CONVERSATION_SHARE_SELECTION_PANEL_MAX_HEIGHT_PROPERTY,
} from "@/v4/conversationShareSelectionPanelLayout.js";
import { resolveConversationShareScrollbarIndicatorMetrics } from "@/v4/conversationShareScrollbarMetrics.js";
import type { ConversationSharePreflightState } from "@/conversation-share-interaction/ConversationSharePreflightStatus.js";
import type { ConversationTurnNavigatorItem } from "@/v4/conversationTurnNavigatorHelpers.js";

export interface ConversationShareSelectionPanelProps {
  onConfirm?: () => void;
  onCancel?: () => void;
  selectedCount?: number;
  preflight?: ConversationSharePreflightState;
  visible: boolean;
  items: readonly ConversationTurnNavigatorItem[];
  selectedRowIds: ReadonlySet<number>;
  onToggle: (rowId: number) => void;
  onSelectAllChange?: (selected: boolean) => void;
  onInspect: (target: { unitIndex: number; rowId: number }) => void;
}

const PANEL_LAYOUT_STYLE: CSSProperties = {
  // 固定高度会让少量候选留下大块空白，并在底部 dock 增高时覆盖输入区。
  // 面板自身按内容自然撑开，max-height 与 top 由共享会话容器动态提供。
  height: "auto",
  maxHeight: `var(${CONVERSATION_SHARE_SELECTION_PANEL_MAX_HEIGHT_PROPERTY}, calc(100% - 3rem))`,
  top: `var(${CONVERSATION_SHARE_SELECTION_PANEL_CENTER_Y_PROPERTY}, 50%)`,
};

function ConversationShareSelectionPanelImpl({
  visible,
  items,
  selectedRowIds,
  onToggle,
  onSelectAllChange,
  onInspect,
  onConfirm,
  onCancel,
  selectedCount = selectedRowIds.size,
  preflight,
}: ConversationShareSelectionPanelProps) {
  const { intl } = useZCodeIntl();
  const prefersReducedMotion = useReducedMotion() === true;
  const motionConfig = resolveConversationShareSelectionPanelMotion(prefersReducedMotion);
  const panelRef = useRef<HTMLElement>(null);
  const scrollShellRef = useRef<HTMLDivElement>(null);
  const scrollContentRef = useRef<HTMLDivElement>(null);
  const visualThumbRef = useRef<HTMLDivElement>(null);
  const selectableItems = items.filter((item) => !item.isRunning);
  const selectedItemCount = selectableItems.filter((item) => selectedRowIds.has(item.rowId)).length;
  const allSelected = selectableItems.length > 0 && selectedItemCount === selectableItems.length;
  const checking = selectedCount > 0 && preflight !== undefined && preflight.status !== "ready";
  const rowLimit =
    preflight?.status === "ready"
      ? preflight.blockingIssues.find((issue) => issue.code === "rows_limit")
      : undefined;
  const exceededRows = rowLimit ? Math.max(0, (rowLimit.actual ?? 0) - (rowLimit.limit ?? 0)) : 0;

  useLayoutEffect(() => {
    if (!visible) return;
    const panel = panelRef.current;
    const content = scrollContentRef.current;
    if (!panel || !content) return;

    const syncNaturalHeight = () => {
      // 列表直接贴合面板边缘；content 的 scrollHeight 始终代表完整候选列表，
      // 即使外层已经被 max-height 截断，也不会把可滚动内容误测成当前 viewport 高度。
      const naturalHeight = content.scrollHeight + (onConfirm && onCancel ? 98 : 0);
      const settings = document.querySelector<HTMLElement>(
        '[data-testid="conversation-share-popover"]',
      );
      const container = panel.parentElement;
      const parentRect = container?.getBoundingClientRect();
      const settingsRect = settings?.getBoundingClientRect();
      // 侧栏与浮窗锚点会改变可用宽度，固定阈值会漏掉遮挡；按最终布局边界避让。
      // offset 不包含入场动画的水平位移，避免动画期间误判并排空间。
      const panelLeft = (parentRect?.left ?? 0) + panel.offsetLeft;
      if (
        onConfirm &&
        container &&
        parentRect &&
        settingsRect &&
        panelLeft < settingsRect.right + 8 &&
        panelLeft + panel.offsetWidth + 8 > settingsRect.left
      ) {
        const layout = getComputedStyle(container);
        const center = Number.parseFloat(
          layout.getPropertyValue(CONVERSATION_SHARE_SELECTION_PANEL_CENTER_Y_PROPERTY),
        );
        const maxHeight = Number.parseFloat(
          layout.getPropertyValue(CONVERSATION_SHARE_SELECTION_PANEL_MAX_HEIGHT_PROPERTY),
        );
        const bottom =
          Number.isFinite(center) && Number.isFinite(maxHeight)
            ? parentRect.top + center + maxHeight / 2
            : parentRect.bottom;
        const remaining = Math.max(96, bottom - settingsRect.bottom - 16);
        const height = Math.min(naturalHeight, remaining);
        panel.style.maxHeight = `${remaining}px`;
        panel.style.top = `${settingsRect.bottom - parentRect.top + 8 + height / 2}px`;
        panel.style.height = `${height}px`;
      } else {
        panel.style.maxHeight = String(PANEL_LAYOUT_STYLE.maxHeight);
        panel.style.top = String(PANEL_LAYOUT_STYLE.top);
        if (content.scrollHeight > 0) panel.style.height = `${naturalHeight}px`;
      }
    };
    syncNaturalHeight();

    if (typeof ResizeObserver === "undefined") return;
    const resizeObserver = new ResizeObserver(syncNaturalHeight);
    resizeObserver.observe(content);
    if (panel.parentElement) resizeObserver.observe(panel.parentElement);
    const settings = document.querySelector<HTMLElement>(
      '[data-testid="conversation-share-popover"]',
    );
    if (settings) resizeObserver.observe(settings);
    return () => resizeObserver.disconnect();
  }, [items.length, visible, onConfirm, onCancel]);

  useEffect(() => {
    if (!visible) return;

    const shell = scrollShellRef.current;
    const visualThumb = visualThumbRef.current;
    const viewport = shell?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
    if (!shell || !visualThumb || !viewport) return;

    let animationFrame = 0;
    const updateVisualThumb = () => {
      animationFrame = 0;
      const metrics = resolveConversationShareScrollbarIndicatorMetrics({
        trackSize: shell.clientHeight,
        viewportSize: viewport.clientHeight,
        contentSize: viewport.scrollHeight,
        scrollOffset: viewport.scrollTop,
      });

      // 渐隐只作用于 viewport，避免连同独立滚动条和底部按钮一起淡出。
      const fadeTop = viewport.scrollTop > 1;
      const fadeBottom = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop > 1;
      viewport.style.maskImage =
        fadeTop || fadeBottom
          ? `linear-gradient(to bottom, ${fadeTop ? "transparent" : "black"}, black 32px, black calc(100% - 32px), ${fadeBottom ? "transparent" : "black"})`
          : "none";
      visualThumb.style.display = metrics.visible ? "block" : "none";
      visualThumb.style.height = `${metrics.size}px`;
      visualThumb.style.transform = `translateY(${metrics.offset}px)`;
    };
    const scheduleVisualThumbUpdate = () => {
      if (animationFrame !== 0) cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(updateVisualThumb);
    };

    viewport.addEventListener("scroll", scheduleVisualThumbUpdate, {
      passive: true,
    });
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleVisualThumbUpdate);
    resizeObserver?.observe(shell);
    resizeObserver?.observe(viewport);
    if (viewport.firstElementChild instanceof HTMLElement) {
      resizeObserver?.observe(viewport.firstElementChild);
    }
    scheduleVisualThumbUpdate();

    return () => {
      viewport.removeEventListener("scroll", scheduleVisualThumbUpdate);
      resizeObserver?.disconnect();
      if (animationFrame !== 0) cancelAnimationFrame(animationFrame);
    };
  }, [items.length, visible]);

  return (
    <AnimatePresence initial={false}>
      {visible ? (
        // motion transform 已包含 -50% 的纵向居中；再叠加 Tailwind translate
        // 会把面板重复上移半个自身高度，越过会话内容区并被 WorkspaceHeader 覆盖。
        <motion.aside
          ref={panelRef}
          key="conversation-share-selection-panel"
          aria-label={intl.formatMessage({
            id: "conversationShare.partial.panelLabel",
          })}
          data-testid="conversation-share-selection-panel"
          data-conversation-share-left-navigation="true"
          data-conversation-share-mode-motion="selection-panel"
          className="group/share-selection-panel absolute left-4 z-30 flex h-auto w-[20rem] flex-col overflow-hidden rounded-xl bg-popover text-popover-foreground shadow-md ring-1 ring-inset ring-popover-border max-md:left-2 max-md:w-[min(20rem,calc(100vw-1rem))]"
          style={PANEL_LAYOUT_STYLE}
          initial={motionConfig.initial}
          animate={motionConfig.animate}
          exit={motionConfig.exit}
          transition={motionConfig.transition}
        >
          {onConfirm && onCancel ? (
            <div
              className="flex shrink-0 items-center border-b border-border px-4 py-2"
              data-testid="conversation-share-selection-header"
            >
              <label className="flex min-h-8 cursor-pointer items-center gap-3">
                <Checkbox
                  data-testid="conversation-share-selection-all"
                  aria-label={intl.formatMessage({ id: "conversationShare.partial.selectAll" })}
                  checked={allSelected ? true : selectedItemCount > 0 ? "indeterminate" : false}
                  disabled={selectableItems.length === 0}
                  onCheckedChange={() => {
                    if (onSelectAllChange) {
                      onSelectAllChange(!allSelected);
                      return;
                    }
                    for (const item of selectableItems) {
                      if (selectedRowIds.has(item.rowId) === allSelected) onToggle(item.rowId);
                    }
                  }}
                />
                <span className="text-ui-base">
                  {intl.formatMessage({ id: "conversationShare.partial.selectAll" })}
                </span>
              </label>
            </div>
          ) : null}
          {/* Bugfix：Radix 默认的 table wrapper 会被长文本撑宽，必须锁回 viewport 宽度，否则右侧间距、截断和 hover 都会失真。 */}
          {/* Bug 根因：auto 会按滚动事件挂载/卸载 scrollbar，无法让整个面板 hover 稳定控制可见性；始终挂载后只切 opacity。 */}
          <div ref={scrollShellRef} className="relative min-h-0 flex-1">
            <ScrollArea
              type="always"
              data-testid="conversation-share-selection-scroll-area"
              className="size-full min-h-0 flex-1 [&_[data-radix-scroll-area-viewport]>div]:!block [&_[data-radix-scroll-area-viewport]>div]:!w-full"
              // scale-y-50 只缩短 Radix thumb 的绘制结果，位移仍按原长度计算，
              // 因而滚动到底后可见 thumb 仍停在轨道中段。原始 thumb 仅保留拖动命中，
              // 视觉 thumb 由完整 scroll progress 独立映射到整条轨道。
              scrollbarClassName="opacity-0 transition-opacity group-hover/share-selection-panel:opacity-100 group-focus-within/share-selection-panel:opacity-100 data-vertical:!w-2.5 data-vertical:!pr-1 data-vertical:!pl-0 [&_[data-slot=scroll-area-thumb]]:!min-w-1.5 [&_[data-slot=scroll-area-thumb]]:!bg-transparent [@media(hover:none)]:opacity-100"
            >
              <div ref={scrollContentRef} className="flex min-w-0 flex-col p-2">
                {items.length > 0 ? (
                  items.map((item) => {
                    const selected = selectedRowIds.has(item.rowId);
                    return (
                      <div
                        key={item.key}
                        data-conversation-share-selection-item="true"
                        data-conversation-share-selection-state={
                          selected ? "selected" : "unselected"
                        }
                        className="group flex items-start gap-2 rounded-lg px-1 py-2 transition-colors hover:bg-menu-hover"
                        onClick={() => {
                          if (!item.isRunning) onToggle(item.rowId);
                        }}
                      >
                        <div className="relative flex h-5 w-6 shrink-0 items-center justify-center">
                          {/* Bugfix：原先只有 14px Checkbox 本体接收点击，24px 槽位只是布局容器；用不占布局的 32px label 扩大热区，避免改变列表间距和视觉尺寸。 */}
                          <label
                            data-conversation-share-checkbox-hit-area="true"
                            onClick={(event) => event.stopPropagation()}
                            className="absolute flex size-8 cursor-pointer items-center justify-center"
                          >
                            <Checkbox
                              checked={selected}
                              disabled={item.isRunning}
                              aria-label={item.userPreview}
                              onCheckedChange={() => {
                                if (!item.isRunning) onToggle(item.rowId);
                              }}
                              checkIconStrokeWidth={1.33}
                            />
                          </label>
                        </div>
                        <button
                          type="button"
                          disabled={item.isRunning}
                          aria-label={item.userPreview}
                          aria-pressed={selected}
                          data-testid="conversation-share-selection-toggle"
                          className="flex min-w-0 flex-1 flex-col gap-1 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
                        >
                          <span
                            className={cn(
                              "block truncate text-ui-base font-normal leading-5 transition-colors",
                              item.isRunning ? "text-foreground-subtlest" : "text-foreground",
                            )}
                          >
                            {item.userPreview}
                          </span>
                          <span
                            className={cn(
                              "line-clamp-2 break-words text-ui-sm leading-4 transition-colors",
                              item.isRunning
                                ? "text-foreground-subtlest"
                                : "text-foreground-subtle",
                            )}
                          >
                            {item.assistantPreview}
                          </span>
                        </button>
                        <ControlHintTooltip
                          title={intl.formatMessage({ id: "conversationShare.range.locate" })}
                          side="right"
                        >
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="-my-0.5 text-foreground-subtle"
                            data-testid="conversation-share-selection-locate"
                            aria-label={intl.formatMessage({
                              id: "conversationShare.range.locate",
                            })}
                            onClick={(event) => {
                              event.stopPropagation();
                              onInspect({ unitIndex: item.unitIndex, rowId: item.rowId });
                            }}
                          >
                            <LocateFixed />
                          </Button>
                        </ControlHintTooltip>
                      </div>
                    );
                  })
                ) : (
                  <p className="px-2 py-4 text-ui-sm text-foreground-subtle">
                    {intl.formatMessage({
                      id: "conversationShare.partial.empty",
                    })}
                  </p>
                )}
              </div>
            </ScrollArea>
            <div
              ref={visualThumbRef}
              aria-hidden="true"
              data-testid="conversation-share-selection-scroll-thumb"
              className="pointer-events-none absolute right-1 top-0 z-10 hidden w-1.5 rounded-full bg-border opacity-0 transition-opacity group-hover/share-selection-panel:opacity-100 group-focus-within/share-selection-panel:opacity-100 [@media(hover:none)]:opacity-100"
            />
          </div>
          {onConfirm && onCancel ? (
            <div
              className="flex shrink-0 items-center justify-between gap-1 border-t border-border pr-2 pl-4 py-2"
              data-testid="conversation-share-selection-footer"
            >
              <span
                role="status"
                data-testid="conversation-share-selection-summary"
                className={cn(
                  "min-w-0 text-ui-sm",
                  rowLimit ? "text-warning" : "text-foreground-subtle",
                )}
              >
                {rowLimit
                  ? intl.formatMessage(
                      { id: "conversationShare.range.exceeded" },
                      { count: exceededRows },
                    )
                  : checking
                    ? intl.formatMessage({ id: "conversationShare.partial.preflightChecking" })
                    : intl.formatMessage(
                        { id: "conversationShare.range.selected" },
                        { count: selectedCount },
                      )}
              </span>
              <div className="flex gap-1">
                <Button
                  size="lg"
                  variant="ghost"
                  onClick={onCancel}
                  data-testid="conversation-share-selection-cancel"
                >
                  {intl.formatMessage({
                    id: "conversationShare.partial.cancel",
                  })}
                </Button>
                <Button
                  size="lg"
                  disabled={selectedCount === 0 || checking || !!rowLimit}
                  onClick={onConfirm}
                  data-testid="conversation-share-selection-apply"
                >
                  {intl.formatMessage({
                    id: "conversationShare.range.confirm",
                  })}
                </Button>
              </div>
            </div>
          ) : null}
        </motion.aside>
      ) : null}
    </AnimatePresence>
  );
}

export const ConversationShareSelectionPanel = memo(ConversationShareSelectionPanelImpl);
