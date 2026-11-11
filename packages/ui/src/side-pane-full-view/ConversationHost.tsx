// Side Pane 完整视图的对话宿主（spec：docs/ui/side-pane-full-view.md）。
// 它包住 conversation-column 里唯一的 SessionPane 实例，只改变定位方式，不移动 DOM、不重挂载：
// - normal：静态布局，与原三栏一致；
// - conversation：fixed 铺满面板内容区（slot），对话全宽；
// - floating：fixed 浮在 slot 内的吸附位置，收起态只露出底部输入区。
// 几何值是 DOM 布局投影，直接写到宿主 style，不进入 React state，避免每次测量重渲染对话树。
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  GripVerticalIcon,
  LoaderCircle,
  Maximize2Icon,
  MessageCircleIcon,
  MinusIcon,
  XIcon,
} from "lucide-react";
import {
  TID_SIDE_PANE_FULL_VIEW_ANSWER_BUBBLE,
  TID_SIDE_PANE_FULL_VIEW_ANSWER_BUBBLE_CLOSE,
  TID_SIDE_PANE_FULL_VIEW_BUBBLE,
  TID_SIDE_PANE_FULL_VIEW_DRAWER,
  TID_SIDE_PANE_FULL_VIEW_EXPAND,
  TID_SIDE_PANE_FULL_VIEW_HANDLE,
  TID_SIDE_PANE_FULL_VIEW_HEADER,
  TID_SIDE_PANE_FULL_VIEW_HOST,
  TID_SIDE_PANE_FULL_VIEW_MENU_MINIMIZE,
  TID_SIDE_PANE_FULL_VIEW_MENU_OPEN_CONVERSATION,
  TID_SIDE_PANE_FULL_VIEW_MINIMIZE,
  TID_SIDE_PANE_FULL_VIEW_RUNNING,
  TID_V4_COMPOSER_INPUT,
} from "@zcode/shared/test-ids";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  clampFloatingPosition,
  dismissFloatingAnswerBubble,
  FLOATING_DRAG_CLICK_THRESHOLD_PX,
  FLOATING_MINIMIZED_SIZE_PX,
  rebaselineFloatingAnswerBubbles,
  reduceFloatingAnswerBubbles,
  resolveFloatingAnswerPreview,
  resolveFloatingExpandedHeight,
  resolveFloatingPosition,
  resolveFloatingTransformOrigin,
  resolveFloatingWidth,
  resolveNearestFloatingAnchor,
  type FloatingPosition,
  type FloatingRect,
} from "@/side-pane-full-view/model.js";
import type {
  ConversationPaneFloatingStatus,
  ConversationPanePresentationValue,
  FloatingAnchor,
  FloatingAnswerBubbleState,
  SidePaneFullViewFloating,
  SidePaneFullViewHostMode,
} from "@/side-pane-full-view/contract.js";
import { ConversationPanePresentationContext } from "@/side-pane-full-view/conversationPanePresentation.js";

const FLOATING_HEADER_HEIGHT_PX = 40;
/** 操作栏隐藏时抽屉藏在输入框后面的高度；聚焦时从这里向上滑出。 */
const DRAWER_TUCK_UNDER_COMPOSER_PX = 16;
const GEOMETRY_PROPERTIES = ["left", "top", "width", "height"] as const;
const GEOMETRY_VARIABLES = [
  "--side-pane-full-view-frame-width",
  "--side-pane-full-view-pane-height",
  "--side-pane-full-view-clip-height",
  "--side-pane-full-view-drawer-height",
] as const;

interface DragSession {
  pointerId: number;
  startX: number;
  startY: number;
  origin: FloatingPosition;
  moved: boolean;
}

function readSlotRect(slot: HTMLElement): FloatingRect {
  const rect = slot.getBoundingClientRect();
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

export function SidePaneFullViewConversationHost({
  mode,
  floating,
  anchor,
  slotElement,
  onFloatingChange,
  onAnchorChange,
  onOpenConversation,
  children,
}: {
  mode: SidePaneFullViewHostMode;
  floating: SidePaneFullViewFloating;
  anchor: FloatingAnchor;
  slotElement: HTMLElement | null;
  onFloatingChange: (floating: SidePaneFullViewFloating) => void;
  onAnchorChange: (anchor: FloatingAnchor) => void;
  onOpenConversation: () => void;
  children: ReactNode;
}) {
  const { intl } = useZCodeIntl();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const isFloating = mode === "floating";
  const isMinimized = isFloating && floating === "minimized";
  const isExpanded = isFloating && floating === "expanded";
  const [status, setStatus] = useState<
    Pick<ConversationPaneFloatingStatus, "running" | "blockingInteractionId" | "ownerKey">
  >({
    running: false,
    blockingInteractionId: null,
    ownerKey: "",
  });
  /** 回答气泡按对话 owner 记录（只在内存里），只有点 × 或点气泡才清除。 */
  const [answerBubbles, setAnswerBubbles] = useState<
    ReadonlyMap<string, FloatingAnswerBubbleState>
  >(() => new Map());
  const [focusWithin, setFocusWithin] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const headerVisible =
    isFloating && !isMinimized && (isExpanded || focusWithin || menuOpen || dragging);
  const dockHeightRef = useRef(0);
  const dragRef = useRef<DragSession | null>(null);
  const dragPositionRef = useRef<FloatingPosition | null>(null);
  /** 上一次写入的几何是否为最小化形态；用来识别最小化与恢复之间的切换。 */
  const appliedMinimizedRef = useRef<boolean | null>(null);
  const applyGeometryRef = useRef<() => void>(() => {});

  const reportFloatingStatus = useCallback((next: ConversationPaneFloatingStatus) => {
    setStatus((current) =>
      current.running === next.running &&
      current.blockingInteractionId === next.blockingInteractionId &&
      current.ownerKey === next.ownerKey
        ? current
        : {
            running: next.running,
            blockingInteractionId: next.blockingInteractionId,
            ownerKey: next.ownerKey,
          },
    );
    setAnswerBubbles((current) => reduceFloatingAnswerBubbles(current, next));
  }, []);
  // 离开浮窗形态（对话 tab、退出完整视图）时清空基线：在对话 tab 里看过的回答，
  // 切回浮窗不再弹出；已经弹出的气泡保留。
  useEffect(() => {
    if (!isFloating) setAnswerBubbles(rebaselineFloatingAnswerBubbles);
  }, [isFloating]);
  const answer =
    isFloating && floating === "collapsed"
      ? (answerBubbles.get(status.ownerKey)?.answer ?? null)
      : null;
  const answerPreview = useMemo(
    () => (answer ? resolveFloatingAnswerPreview(answer.text) : ""),
    [answer],
  );
  const reportComposerDockHeight = useCallback((heightPx: number) => {
    if (dockHeightRef.current === heightPx) return;
    dockHeightRef.current = heightPx;
    applyGeometryRef.current();
  }, []);
  const presentationValue = useMemo<ConversationPanePresentationValue>(
    () => ({
      presentation: isFloating ? "floating" : "docked",
      reportFloatingStatus,
      reportComposerDockHeight,
    }),
    [isFloating, reportComposerDockHeight, reportFloatingStatus],
  );

  const resolveFrameSize = useCallback(
    (slot: FloatingRect) => {
      if (isMinimized) {
        return { width: FLOATING_MINIMIZED_SIZE_PX, height: FLOATING_MINIMIZED_SIZE_PX };
      }
      const paneHeight = Math.max(
        0,
        resolveFloatingExpandedHeight(slot.height) - FLOATING_HEADER_HEIGHT_PX,
      );
      const headerHeight = headerVisible ? FLOATING_HEADER_HEIGHT_PX : 0;
      // 收起态外层就是输入框本身；展开态输入层在抽屉内缩 1px，露出抽屉边框。
      const clipHeight = isExpanded
        ? Math.max(0, paneHeight - 1)
        : Math.min(dockHeightRef.current, paneHeight);
      const height = headerHeight + (isExpanded ? paneHeight : clipHeight);
      return {
        width: resolveFloatingWidth(slot.width),
        height,
        paneHeight: isExpanded ? clipHeight : paneHeight,
        clipHeight,
        // 修复原因：抽屉只伸到输入框后面 16px 时，抽屉底角与输入框顶角的圆角对出一个凹口。
        // 操作栏可见时抽屉一直延伸到浮窗底边，两侧边线连续，输入框像放在抽屉里。
        drawerHeight: headerVisible ? height : DRAWER_TUCK_UNDER_COMPOSER_PX,
      };
    },
    [headerVisible, isExpanded, isMinimized],
  );

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (mode === "normal" || !slotElement) {
      for (const property of GEOMETRY_PROPERTIES) host.style.removeProperty(property);
      for (const variable of GEOMETRY_VARIABLES) host.style.removeProperty(variable);
      applyGeometryRef.current = () => {};
      appliedMinimizedRef.current = null;
      return;
    }
    const apply = () => {
      const slot = readSlotRect(slotElement);
      if (mode === "conversation") {
        appliedMinimizedRef.current = null;
        host.style.left = `${slot.left}px`;
        host.style.top = `${slot.top}px`;
        host.style.width = `${slot.width}px`;
        host.style.height = `${slot.height}px`;
        return;
      }
      const size = resolveFrameSize(slot);
      // 对话 tab 与浮窗共用宿主；切回浮窗时若沿用几何过渡，输入框会从整页宽度收缩，
      // 回答气泡也会跨屏移动。首次进入浮窗直接提交几何，浮窗内的展开、收起和吸附仍过渡。
      const enteringFloating = appliedMinimizedRef.current === null;
      // 修复原因：恢复时宽度从圆形按钮的 48px 过渡到 560px，单行输入框在窄宽度下折成多行，
      // 测得的输入区高度先变大（实测 258px）再缩回 46px，浮窗背景先变高再往下掉。
      // 最小化与恢复之间切换时几何直接到位，只做从按钮所在角缩放 + 淡入（transform 不触发重排）。
      const crossingMinimized =
        appliedMinimizedRef.current !== null && appliedMinimizedRef.current !== isMinimized;
      appliedMinimizedRef.current = isMinimized;
      if (enteringFloating || crossingMinimized) host.style.transition = "none";
      // 内部内容始终按浮窗宽度排版：最小化期间也不跟着 48px 重排，测得的输入区高度保持正确。
      host.style.setProperty(
        "--side-pane-full-view-frame-width",
        `${resolveFloatingWidth(slot.width)}px`,
      );
      if ("paneHeight" in size) {
        host.style.setProperty("--side-pane-full-view-pane-height", `${size.paneHeight}px`);
        host.style.setProperty("--side-pane-full-view-clip-height", `${size.clipHeight}px`);
        host.style.setProperty("--side-pane-full-view-drawer-height", `${size.drawerHeight}px`);
      }
      const position = dragPositionRef.current
        ? clampFloatingPosition(dragPositionRef.current, slot, size)
        : resolveFloatingPosition(anchor, slot, size);
      host.style.left = `${position.left}px`;
      host.style.top = `${position.top}px`;
      host.style.width = `${size.width}px`;
      host.style.height = `${size.height}px`;
      if (enteringFloating || crossingMinimized) {
        // 强制提交一次样式，让上面的几何不带过渡生效，再恢复 CSS 过渡。
        void host.offsetWidth;
        host.style.removeProperty("transition");
      }
      if (crossingMinimized) {
        host.style.transformOrigin = resolveFloatingTransformOrigin(anchor);
        host.animate?.(
          [
            { opacity: 0, transform: "scale(0.92)" },
            { opacity: 1, transform: "scale(1)" },
          ],
          { duration: 150, easing: "ease-out" },
        );
      }
    };
    applyGeometryRef.current = apply;
    apply();
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(apply);
    resizeObserver?.observe(slotElement);
    window.addEventListener("resize", apply);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", apply);
    };
  }, [anchor, isMinimized, mode, resolveFrameSize, slotElement]);

  // 最小化时出现新的阻塞交互（权限 / 问答）自动恢复为收起态，卡片替换输入框显示在浮窗内。
  // 只响应新的请求 id：用户在请求等待期间再次最小化，不会被同一个请求反复弹开。
  const seenBlockingInteractionIdRef = useRef(status.blockingInteractionId);
  useEffect(() => {
    const previous = seenBlockingInteractionIdRef.current;
    seenBlockingInteractionIdRef.current = status.blockingInteractionId;
    if (isMinimized && status.blockingInteractionId && status.blockingInteractionId !== previous) {
      onFloatingChange("collapsed");
    }
  }, [isMinimized, onFloatingChange, status.blockingInteractionId]);

  const focusComposer = useCallback(() => {
    window.requestAnimationFrame(() => {
      hostRef.current
        ?.querySelector<HTMLElement>(`[data-testid="${TID_V4_COMPOSER_INPUT}"]`)
        ?.focus();
    });
  }, []);

  const handleFocusCapture = useCallback(() => setFocusWithin(true), []);
  const handleBlurCapture = useCallback((event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    setFocusWithin(false);
  }, []);

  const beginDrag = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    const host = hostRef.current;
    if (!host) return;
    // 阻止 Radix 在 pointerdown 时打开菜单；是否打开由松手时是否发生拖动决定。
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const rect = host.getBoundingClientRect();
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: { left: rect.left, top: rect.top },
      moved: false,
    };
  }, []);
  const moveDrag = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const session = dragRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    const dx = event.clientX - session.startX;
    const dy = event.clientY - session.startY;
    if (!session.moved && Math.hypot(dx, dy) < FLOATING_DRAG_CLICK_THRESHOLD_PX) return;
    if (!session.moved) {
      session.moved = true;
      setDragging(true);
    }
    dragPositionRef.current = { left: session.origin.left + dx, top: session.origin.top + dy };
    applyGeometryRef.current();
  }, []);
  const endDrag = useCallback(
    (event: ReactPointerEvent<HTMLElement>, onClick: () => void) => {
      const session = dragRef.current;
      if (!session || session.pointerId !== event.pointerId) return;
      dragRef.current = null;
      if (!session.moved) {
        onClick();
        return;
      }
      const host = hostRef.current;
      const dropped = dragPositionRef.current;
      dragPositionRef.current = null;
      setDragging(false);
      if (!host || !dropped || !slotElement) return;
      const slot = readSlotRect(slotElement);
      const rect = host.getBoundingClientRect();
      const nextAnchor = resolveNearestFloatingAnchor(
        clampFloatingPosition(dropped, slot, rect),
        slot,
        { width: rect.width, height: rect.height },
      );
      if (nextAnchor === anchor) {
        applyGeometryRef.current();
      } else {
        onAnchorChange(nextAnchor);
      }
    },
    [anchor, onAnchorChange, slotElement],
  );
  const cancelDrag = useCallback(() => {
    dragRef.current = null;
    dragPositionRef.current = null;
    setDragging(false);
    applyGeometryRef.current();
  }, []);

  const handleToggleExpanded = useCallback(() => {
    onFloatingChange(isExpanded ? "collapsed" : "expanded");
  }, [isExpanded, onFloatingChange]);
  const handleMinimize = useCallback(() => {
    setMenuOpen(false);
    onFloatingChange("minimized");
  }, [onFloatingChange]);
  const handleDismissAnswer = useCallback(() => {
    setAnswerBubbles((current) => dismissFloatingAnswerBubble(current, status.ownerKey));
  }, [status.ownerKey]);
  const handleOpenAnswer = useCallback(() => {
    handleDismissAnswer();
    onFloatingChange("expanded");
  }, [handleDismissAnswer, onFloatingChange]);
  const handleRestore = useCallback(() => {
    onFloatingChange("collapsed");
    focusComposer();
  }, [focusComposer, onFloatingChange]);

  const statusIcon = status.running ? (
    <LoaderCircle className="size-4 animate-spin text-foreground-subtle" aria-hidden="true" />
  ) : (
    <MessageCircleIcon className="size-4 text-foreground-subtle" aria-hidden="true" />
  );
  const statusLabel = intl.formatMessage({
    id: status.running ? "sidePane.fullView.statusRunning" : "sidePane.fullView.statusIdle",
  });
  const handleLabel = intl.formatMessage({ id: "sidePane.fullView.handle" });
  const expandLabel = intl.formatMessage({
    id: isExpanded ? "sidePane.fullView.collapseMessages" : "sidePane.fullView.expandMessages",
  });
  const ExpandIcon = isExpanded ? ChevronDownIcon : ChevronUpIcon;

  return (
    <div
      ref={hostRef}
      data-testid={TID_SIDE_PANE_FULL_VIEW_HOST}
      data-side-pane-full-view-host={mode}
      data-floating={isFloating ? floating : undefined}
      data-header-visible={headerVisible ? "true" : "false"}
      data-dragging={dragging ? "true" : undefined}
      data-running={status.running ? "true" : "false"}
      onFocusCapture={isFloating ? handleFocusCapture : undefined}
      onBlurCapture={isFloating ? handleBlurCapture : undefined}
      className={cn(
        mode === "normal" && "relative h-full w-full",
        mode === "conversation" && "fixed z-30 flex flex-col",
        isFloating &&
          "fixed z-30 transition-[left,top,width,height] duration-150 ease-out data-[dragging=true]:transition-none",
      )}
    >
      <ConversationPanePresentationContext.Provider value={presentationValue}>
        {answer ? (
          // 回答气泡：只显示回答正文前两行，不显示图标与标题；顶部吸附位置时放在浮窗下方。
          <div
            data-testid={TID_SIDE_PANE_FULL_VIEW_ANSWER_BUBBLE}
            className={cn(
              "absolute inset-x-0 z-20",
              anchor.startsWith("top") ? "top-full mt-2" : "bottom-full mb-2",
            )}
          >
            <button
              type="button"
              aria-label={intl.formatMessage({ id: "sidePane.fullView.openAnswer" })}
              className="block w-full rounded-2xl border border-border bg-background px-4 py-3 text-left shadow-lg transition-colors hover:bg-hover"
              onClick={handleOpenAnswer}
            >
              <span className="line-clamp-2 text-ui-base text-foreground">{answerPreview}</span>
            </button>
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              data-testid={TID_SIDE_PANE_FULL_VIEW_ANSWER_BUBBLE_CLOSE}
              aria-label={intl.formatMessage({ id: "common.close" })}
              className="absolute -top-2 -left-2 rounded-full border bg-background shadow-sm"
              // 关闭不夺走输入框焦点，避免抽屉因焦点进出闪一下。
              onMouseDown={(event) => event.preventDefault()}
              onClick={handleDismissAnswer}
            >
              <XIcon className="size-3" />
            </Button>
          </div>
        ) : null}
        {isFloating && !isMinimized ? (
          // 抽屉层：在输入框后面，聚焦时随浮窗变高从输入框后面向上滑出；展开时铺满整个浮窗。
          <div
            data-testid={TID_SIDE_PANE_FULL_VIEW_DRAWER}
            data-open={headerVisible ? "true" : "false"}
            className={cn(
              "absolute inset-x-0 top-0 h-[var(--side-pane-full-view-drawer-height)] overflow-hidden rounded-2xl border border-border bg-background shadow-lg transition-[height,opacity] duration-150 ease-out",
              headerVisible ? "opacity-100" : "pointer-events-none opacity-0",
            )}
          >
            {headerVisible ? (
              <div
                data-testid={TID_SIDE_PANE_FULL_VIEW_HEADER}
                data-expanded={isExpanded ? "true" : "false"}
                className="flex h-10 items-center gap-1 px-2"
                // 修复原因：菜单内容虽 portal 到 body，React 合成事件仍沿组件树冒泡；操作栏容器
                // 不挂点击行为，只阻止 mousedown 抢走输入框焦点，避免操作栏在点击前因失焦消失。
                onMouseDown={(event) => event.preventDefault()}
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  data-testid={TID_SIDE_PANE_FULL_VIEW_MINIMIZE}
                  aria-label={intl.formatMessage({ id: "sidePane.fullView.minimize" })}
                  onClick={handleMinimize}
                >
                  <MinusIcon className="size-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  data-testid={TID_SIDE_PANE_FULL_VIEW_EXPAND}
                  aria-label={expandLabel}
                  aria-expanded={isExpanded}
                  title={expandLabel}
                  onClick={handleToggleExpanded}
                >
                  <ExpandIcon className="size-4" />
                </Button>
                {status.running ? (
                  <span
                    role="status"
                    data-testid={TID_SIDE_PANE_FULL_VIEW_RUNNING}
                    aria-label={statusLabel}
                    title={statusLabel}
                    className="flex size-6 items-center justify-center"
                  >
                    <LoaderCircle
                      className="size-4 animate-spin text-foreground-subtle"
                      aria-hidden="true"
                    />
                  </span>
                ) : null}
                <div className="min-w-0 flex-1" />
                <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen} modal={false}>
                  <ControlHintTooltip title={handleLabel} side="top" align="end">
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        data-testid={TID_SIDE_PANE_FULL_VIEW_HANDLE}
                        aria-label={handleLabel}
                        className="cursor-grab touch-none data-[state=open]:bg-selected"
                        onPointerDown={beginDrag}
                        onPointerMove={moveDrag}
                        onPointerUp={(event) => endDrag(event, () => setMenuOpen(true))}
                        onPointerCancel={cancelDrag}
                      >
                        <GripVerticalIcon className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                  </ControlHintTooltip>
                  <DropdownMenuContent align="end" side="top" className="w-52">
                    <DropdownMenuItem
                      data-testid={TID_SIDE_PANE_FULL_VIEW_MENU_OPEN_CONVERSATION}
                      onSelect={onOpenConversation}
                    >
                      <Maximize2Icon className="size-4" />
                      {intl.formatMessage({ id: "sidePane.fullView.openConversation" })}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      data-testid={TID_SIDE_PANE_FULL_VIEW_MENU_MINIMIZE}
                      onSelect={handleMinimize}
                    >
                      <MinusIcon className="size-4" />
                      {intl.formatMessage({ id: "sidePane.fullView.minimize" })}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ) : null}
          </div>
        ) : null}
        {isMinimized ? (
          <button
            type="button"
            data-testid={TID_SIDE_PANE_FULL_VIEW_BUBBLE}
            aria-label={intl.formatMessage({ id: "sidePane.fullView.restore" })}
            title={statusLabel}
            className="absolute inset-0 z-10 flex cursor-grab touch-none items-center justify-center rounded-full border border-border bg-background shadow-lg hover:bg-hover"
            onPointerDown={beginDrag}
            onPointerMove={moveDrag}
            onPointerUp={(event) => endDrag(event, handleRestore)}
            onPointerCancel={cancelDrag}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                handleRestore();
              }
            }}
          >
            {statusIcon}
          </button>
        ) : null}
        <div
          data-side-pane-full-view-clip=""
          className={cn(
            "relative min-h-0",
            mode === "normal" && "h-full",
            mode === "conversation" && "flex-1",
            // 输入层：收起态外壳就是输入框（带阴影），展开态内缩 1px 露出抽屉边框。
            isFloating &&
              "absolute z-10 h-[var(--side-pane-full-view-clip-height)] overflow-hidden",
            isFloating && !isExpanded && "inset-x-0 bottom-0 rounded-2xl shadow-lg",
            isExpanded && "inset-x-px bottom-px rounded-b-2xl",
            // 最小化时输入层不可见，但保持浮窗宽度排版，不随 48px 的按钮重排。
            isMinimized && "invisible w-[var(--side-pane-full-view-frame-width)]",
          )}
        >
          <div
            className={cn(
              "h-full",
              // 收起态保持展开态的固定高度并贴底：只露出底部输入区，上方内容仍然挂载。
              isFloating &&
                "absolute inset-x-0 bottom-0 h-[var(--side-pane-full-view-pane-height)]",
            )}
          >
            {children}
          </div>
        </div>
      </ConversationPanePresentationContext.Provider>
    </div>
  );
}
