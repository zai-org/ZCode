import { useBotTopicPreparations } from "@/v4/BotTopicPreparation.js";
/* oxlint-disable eslint(max-lines) -- ConversationTimeline 集中承载虚拟滚动、滚动锚定、loadOlder 与 find 高亮协调；拆散会让同一滚动状态跨文件传递。 */
import {
  Component,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type TouchEvent as ReactTouchEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { flushSync } from "react-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDownIcon } from "lucide-react";
import { TID_V4_TIMELINE, TID_V4_TIMELINE_BOTTOM } from "@zcode/shared/test-ids";
import type {
  ApiRetryState,
  ConversationRow,
  ConversationRowTarget,
  QueueItem,
  SessionPhase,
} from "@zcode/shared/zcode-protocol-v4";
import { cn } from "@/components/lib/utils.js";
import { runUserAction } from "@/lib/userActionTelemetry.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { ConversationTurnGroup } from "@/v4/ConversationTurnGroup.js";
import {
  createLogicalUiInstancesSelector,
  getPluginUiDisclosureSnapshot,
  setPluginUiInstanceDerivation,
  subscribePluginUiDisclosure,
  type PluginUiRowPinResolver,
} from "@/plugin-ui/index.js";
import { ConversationPendingGuideList } from "@/v4/ConversationPendingGuideList.js";
import type { AssistantFeedbackHandler, UserInputEditHandler } from "@/v4/ConversationRowView.js";
import { ConversationTurnNavigator } from "@/v4/ConversationTurnNavigator.js";
import { syncConversationShareSelectionPanelLayout } from "@/v4/conversationShareSelectionPanelLayout.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
import {
  isSameConversationLatestTurnSummary,
  resolveConversationLatestTurnSummary,
  splitConversationTimelineLiveTail,
  withTopicPreparationUnits,
  type ConversationLatestTurnSummary,
} from "@/v4/conversationTimelineLiveTail.js";
import { armHighspeedFooterExpiryClock } from "@/highspeed/highspeedFooterExpiryClock.js";
import { resolveNextHighspeedExpiryMsInPartition } from "@/highspeed/highspeedConversationRows.js";
import { getConversationRowsPartition } from "@/v4/conversationProjectionStore.js";
import {
  CONVERSATION_STATUS_PANEL_TOP_CLEARANCE_CLASS_NAME,
  getConversationContentWidthClassName,
  getConversationStatusPanelOffsetClassName,
} from "@/v4/conversationLayout.js";
import {
  createConversationTurnRenderUnitsSelector,
  type ConversationTurnRenderUnit,
} from "@/v4/conversationTurnRenderUnits.js";
import {
  CONVERSATION_TURN_NAVIGATOR_MIN_WIDTH_PX,
  createConversationTurnNavigatorQueryRowIdsSelector,
  resolveConversationTurnNavigatorActiveQueryRowId,
  resolveConversationTurnNavigatorHydrationRetryDelayMs,
  shouldHydrateConversationTurnNavigatorDirectory,
  type ConversationTurnNavigatorHydrationResult,
  type ConversationTurnNavigatorQueryPosition,
  type ConversationTurnNavigatorVirtualItem,
} from "@/v4/conversationTurnNavigatorHelpers.js";
import {
  DEFAULT_ROW_HEIGHT_ESTIMATE_PX,
  TimelineRowHeightCache,
} from "@/v4/timelineRowHeightCache.js";
import {
  readChatSessionScrollMemoryState,
  resolveChatSessionScrollRestoreTop,
  saveChatSessionScrollMemoryState,
  type ChatSessionScrollMemoryState,
} from "@/lib/chatSessionScrollMemory.js";
import type {
  ChatSearchResultHighlightRequest,
  ConversationFindMatchState,
} from "@/v4/legacyChatViewTypes.js";
import {
  anchorActionAfterContentChange,
  historyPrefetchTriggerPx,
  initialFollowing,
  prependScrollAdjustment,
  prependVirtualAnchorAdjustment,
  reconcileFollowingForContentAnchor,
  resolveFollowingAfterScroll,
  shouldAdjustVirtualizerForItemSizeChange,
  shouldShowBackToBottom,
  shouldTriggerLoadOlder,
  timelineKeyboardScrollIntent,
  timelineTouchScrollIntent,
  timelineWheelScrollIntent,
  type PrependVirtualAnchor,
  type TimelineUserScrollIntent,
} from "@/v4/timelineScrollAnchor.js";
import { useConversationTimelineFind } from "@/v4/useConversationTimelineFind.js";
import { ConversationSelectionTooltip } from "@/v4/ConversationSelectionTooltip.js";
import type {
  ConversationSelectionAppendResult,
  ConversationSelectionReference,
} from "@/lib/conversationSelectionReference.js";

// memo 组件参数中的 `pendingGuides = []` 会在每次调用时创建新引用，
// 让未传该属性的渲染绕过稳定引用边界；共享只读空数组可保持默认值恒定。
const EMPTY_PENDING_GUIDES: readonly QueueItem[] = [];

// Bug 根因：虚拟单元是一整轮长正文，前后各 8 轮会在搜索跳转时同步挂载大量屏外 Markdown。
// 保留两轮滚动缓冲，避免把小行列表的 overscan 放大为数十屏布局工作。
const ROW_OVERSCAN = 2;
const RUNNING_WORK_DURATION_TICK_MS = 1000;
const USER_SCROLL_INTENT_TTL_MS = 1200;
const LAYOUT_SCROLL_GUARD_MS = 250;
const CONTENT_WIDTH_RESIZE_SETTLE_MS = 120;
const SCROLL_MEMORY_RESTORE_TOLERANCE_PX = 1;

function scheduleMicrotask(callback: () => void): void {
  // 部分 WebView/最小 DOM 运行时没有 window.queueMicrotask；调度能力应从
  // globalThis 注入，并保留 Promise 微任务降级，避免滚动恢复在 commit 阶段直接中断。
  if (typeof globalThis.queueMicrotask === "function") {
    globalThis.queueMicrotask(callback);
    return;
  }
  void Promise.resolve().then(callback);
}

function isEditableScrollTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}

// v4 时间线重写滚动控件时把可访问名称误做成了可见文字，偏离旧版
// 的圆形下箭头样式；这里集中渲染图标按钮，避免两个定位分支再次产生视觉差异。
function ConversationBackToBottomButton({
  className,
  label,
  onClick,
}: {
  className: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <Button
      aria-label={label}
      title={label}
      type="button"
      size="icon"
      variant="outline"
      className={cn("rounded-full bg-card hover:bg-card-selected", className)}
      data-testid={TID_V4_TIMELINE_BOTTOM}
      onClick={() =>
        runUserAction({
          input: { featureId: "conversation.navigation", action: "jump_bottom", trigger: "button" },
          operation: onClick,
          completed: { resultSource: "local_commit" },
          failureStage: "timeline_scroll",
        })
      }
    >
      <ArrowDownIcon className="size-4" />
    </Button>
  );
}

interface ConversationScrollMemoryScopeSnapshot {
  key: string;
  state: ChatSessionScrollMemoryState;
}

type PendingScrollMemoryRestoreWait = "rows" | "content";

interface PendingScrollMemoryRestore extends ConversationScrollMemoryScopeSnapshot {
  rowWindowKey: string;
  waitFor: PendingScrollMemoryRestoreWait;
}

function resolvePendingScrollMemoryRestoreWait(
  state: ChatSessionScrollMemoryState | null,
  element: Pick<HTMLElement, "clientHeight" | "scrollHeight"> | null,
  hasRows: boolean,
): PendingScrollMemoryRestoreWait | null {
  if (!state || state.wasPinnedToBottom !== false) return null;
  if (!hasRows || !element) return "rows";

  const restoredTop = resolveChatSessionScrollRestoreTop(state, element);
  return restoredTop + SCROLL_MEMORY_RESTORE_TOLERANCE_PX < state.scrollTop ? "content" : null;
}

function canReleasePendingScrollMemoryRestore(
  pendingRestore: PendingScrollMemoryRestore,
  element: Pick<HTMLElement, "clientHeight" | "scrollHeight"> | null,
  rowCount: number,
  hasOlderRows: boolean,
  rowWindowKey: string,
): boolean {
  if (!element) return false;
  if (pendingRestore.waitFor === "rows" && rowCount === 0) return false;
  const restoredTop = resolveChatSessionScrollRestoreTop(pendingRestore.state, element);
  const targetIsRepresentable =
    restoredTop + SCROLL_MEMORY_RESTORE_TOLERANCE_PX >= pendingRestore.state.scrollTop;
  if (targetIsRepresentable || element.scrollHeight >= pendingRestore.state.scrollHeight) {
    return true;
  }
  // 新 lease 的首帧 rows 可能仍是截断尾窗；只要还能拉取更早历史，就继续保留原始
  // 恢复意图，避免把临时 clamp 后的 scrollTop 当成最终阅读锚点。
  return rowCount > 0 && !hasOlderRows && pendingRestore.rowWindowKey !== rowWindowKey;
}

interface ConversationScrollMemoryScopeCaptureProps {
  scopeKey: string | null;
  capture: (previousKey: string | null) => ConversationScrollMemoryScopeSnapshot | null;
  commit: (snapshot: ConversationScrollMemoryScopeSnapshot | null) => void;
}

/** React 的 before-mutation snapshot：scope cleanup 时普通 layout effect 已看到新 DOM。 */
class ConversationScrollMemoryScopeCapture extends Component<
  ConversationScrollMemoryScopeCaptureProps,
  unknown,
  ConversationScrollMemoryScopeSnapshot | null
> {
  getSnapshotBeforeUpdate(
    previousProps: ConversationScrollMemoryScopeCaptureProps,
  ): ConversationScrollMemoryScopeSnapshot | null {
    if (previousProps.scopeKey === this.props.scopeKey) return null;
    return this.props.capture(previousProps.scopeKey);
  }

  componentDidUpdate(
    _previousProps: ConversationScrollMemoryScopeCaptureProps,
    _previousState: unknown,
    snapshot: ConversationScrollMemoryScopeSnapshot | null,
  ): void {
    this.props.commit(snapshot);
  }

  render(): null {
    return null;
  }
}

/** tanstack 默认测量的竖向复刻：优先 ResizeObserver entry（不触发同步布局）。 */
function measureRowHeight(element: Element, entry: ResizeObserverEntry | undefined): number {
  const boxSize = entry?.borderBoxSize?.[0];
  if (boxSize) {
    return Math.round(boxSize.blockSize);
  }
  return Math.round(element.getBoundingClientRect().height);
}

function getUnitHeightCacheKey(unit: ConversationTurnRenderUnit | undefined): string | undefined {
  return unit?.key;
}

export interface ConversationTimelineProps {
  rows: readonly ConversationRow[];
  /** 手机远控窄屏允许整条会话 flex 链按抽屉宽度收缩；桌面布局保持原样。 */
  compactForRemoteControl?: boolean;
  /** CLI 权威 queue 中等待 model-step 注入的 guide；只改变 renderer 落位。 */
  pendingGuides?: readonly QueueItem[];
  /** runtime memory 状态，只交给当前 live turn，不进入历史虚拟列表。 */
  apiRetry?: ApiRetryState | null;
  /** 投影全序行数（rows.totalCount；窗口截断后大于 rows.length，仅用于滚动条估计/诊断）。 */
  totalCount: number;
  /**
   * 会话身份键（sessionId ?? "draft"）。切换时重置滚动锚定与测高缓存——
   * rowId 在不同 session 间会重复，测高缓存禁止跨会话串号。
   */
  sessionKey: string;
  /** renderer-local 滚动记忆 key；draft 为 null，不参与保存或恢复。 */
  scrollMemoryKey?: string | null;
  /** 行渲染上下文（theme/codePreviewSettings/workspacePath）；宿主保证引用稳定。 */
  rowContext: ConversationRowRenderContext;
  onFork?: (target: ConversationRowTarget) => void;
  onRetry?: (target: ConversationRowTarget) => void;
  onFeedbackChange?: AssistantFeedbackHandler;
  onEdit?: UserInputEditHandler;
  /** 还有更早历史可拉（窗口首行 > 全序首行）。 */
  canLoadOlder?: boolean;
  /** loadOlder 在途，抑制重复触发。 */
  loadingOlder?: boolean;
  /** 拉取更早一窗历史（接近顶部时自动预取）。 */
  onLoadOlder?: () => Promise<void> | void;
  /** 宽屏问题目录挂载后一次补齐当前有效分支的全部历史。 */
  onLoadAllOlder?: () => Promise<ConversationTurnNavigatorHydrationResult>;
  /**
   * 问题导航目录失效代际（store turnNavigatorDirectoryRevision）。
   * real-user query 增删后终态必须失效重探测；组件 hydration key
   * 追加此 revision，避免同一 logEpoch 内永久拦截。
   */
  turnNavigatorDirectoryRevision?: number;
  /** 与旧 ChatView 对齐：composer dock 属于同一个滚动视口，sticky 到滚动容器底部。 */
  bottomDock?: ReactNode;
  /** 分享选择面板所在的共享父容器；用于把 dock 的真实位置写入同一坐标系。 */
  selectionPanelLayoutContainerRef?: { current: HTMLElement | null };
  /**
   * 锁定背景滚动。
   *
   * 分享选择面板只用 scrim 隔离了正文指针事件，滚动容器仍是 overflow-y-auto，
   * 原生滚动条拖拽和键盘 PageUp/Down 仍能改变 scrollTop，勾选目标会在面板下方漂走。
   */
  backgroundScrollLocked?: boolean;
  /** rows 为空时的可选内容；正式空 session 传空，草稿态传问候语。 */
  emptyState?: ReactNode;
  /**
   * 滚动容器内、消息层之上的常驻内容（分享导入的只读块 + 分割线）。
   *
   * 必须在容器内而不是做成固定横幅，才能与实时对话一起滚动；rows 为空时也要渲染，
   * 所以它落在 emptyState 分支之外。
   */
  headerSlot?: ReactNode;
  /** 草稿态让 emptyState 与同一个 bottomDock 作为整体居中，不重挂 composer。 */
  centerEmptyStateWithDock?: boolean;
  /** 窄屏/粗指针视口保留紧凑居中布局，不复用桌面草稿安全间距。 */
  compactEmptyStateWithDock?: boolean;
  /**
   * Side Pane 完整视图浮窗形态：底部输入区不留内边距，输入框外壳即浮窗最外层；
   * 输入区脱离滚动流贴在时间线底部，滚动容器（含滚动条）止于输入框上方。
   */
  floatingComposerDock?: boolean;
  /** 浮窗形态下上报底部输入区实测高度，宿主据此裁剪收起态。 */
  onComposerDockHeightChange?: (heightPx: number) => void;
  /**
   * 浮窗形态下上报最后一个回合的运行状态、运行时长与最终回答（同一个 render unit），
   * 供输入框占位「工作中 N 秒」与回答气泡使用；值变化时才回调。
   */
  onLatestTurnSummaryChange?: (summary: ConversationLatestTurnSummary) => void;
  /** 右侧状态面板对消息列的布局模式；auto 由 conversation container query 裁决。 */
  summaryPanelLayout?: "none" | "auto" | "inline";
  conversationFindQuery?: string;
  conversationFindActiveIndex?: number;
  conversationFindNavigationRequestId?: number;
  onConversationFindMatchStateChange?: (state: ConversationFindMatchState) => void;
  searchResultHighlightRequest?: ChatSearchResultHighlightRequest | null;
  onSearchResultHighlightDone?: (requestId: number) => void;
  sessionPhase?: SessionPhase;
  /** 宿主可调用的一次性“滚动到底部”动作；不持有 conversation 或跨 renderer 状态。 */
  scrollToBottomActionRef?: { current: (() => void) | null };
  /** 宿主可调用的一次性 query 定位动作；不改变分享面板 view。 */
  scrollToQueryActionRef?: {
    current: ((target: { unitIndex: number; rowId: number }) => void) | null;
  };
  selectionActions?: {
    enabled: boolean;
    sideActionDisabled?: boolean;
    /** 当前会话的 CLI 声明 conversationQuoteComment 时才提供“注释”。 */
    commentEnabled?: boolean;
    /** 主 composer 引用作用域的 workspaceKey；提供时正文画注释编号标记。 */
    annotationWorkspaceKey?: string;
    onAddToCurrentTask: (
      reference: ConversationSelectionReference,
    ) => ConversationSelectionAppendResult | undefined;
    onAskInSideChat: (reference: ConversationSelectionReference) => void;
  };
  /** 范围编辑时，左侧 rail 由分享选择面板独占。 */
  hideTurnNavigator?: boolean;
}

/**
 * 虚拟滚动 timeline：动态测高（ResizeObserver 驱动 remeasure）+ 底部锚定 +
 * 「回到底部」。滚动位置/跟随态/测高缓存全部为组件实例状态——多 pane（同会话或
 * 异会话）各自独立，互不干扰；数据订阅共享经 sessionDataLayer lease 处理。
 *
 * React 性能：rows 高频变化（流式 delta），滚动相关回调全部经 ref 读取最新值，
 * 保持稳定引用；跟随态存 ref（每帧变化不触发渲染），仅「回到底部」可见性走 state。
 */
function ConversationTimelineImpl({
  rows,
  compactForRemoteControl = false,
  pendingGuides = EMPTY_PENDING_GUIDES,
  apiRetry = null,
  totalCount,
  sessionKey,
  scrollMemoryKey = null,
  rowContext,
  onFork,
  onRetry,
  onFeedbackChange,
  onEdit,
  canLoadOlder = false,
  loadingOlder = false,
  onLoadOlder,
  onLoadAllOlder,
  turnNavigatorDirectoryRevision = 0,
  bottomDock,
  selectionPanelLayoutContainerRef,
  backgroundScrollLocked = false,
  emptyState,
  headerSlot,
  centerEmptyStateWithDock = false,
  compactEmptyStateWithDock = false,
  floatingComposerDock = false,
  onComposerDockHeightChange,
  onLatestTurnSummaryChange,
  summaryPanelLayout = "none",
  conversationFindQuery = "",
  conversationFindActiveIndex = -1,
  conversationFindNavigationRequestId = 0,
  onConversationFindMatchStateChange,
  searchResultHighlightRequest,
  onSearchResultHighlightDone,
  sessionPhase,
  scrollToBottomActionRef,
  scrollToQueryActionRef,
  selectionActions,
  hideTurnNavigator = false,
}: ConversationTimelineProps) {
  const { intl } = useZCodeIntl();
  const scrollRef = useRef<HTMLDivElement>(null);
  const headerSlotRef = useRef<HTMLDivElement>(null);
  // headerSlot 高度参与虚拟窗口换算（scrollMargin），必须随内容与宽度变化实时跟进，
  // 否则只读块加载完成或窗口变宽换行后，虚拟行会整体错位。
  //
  // 依赖必须是「有没有 slot」而不是 headerSlot 本身：后者是 ReactNode，宿主传的是内联 JSX，
  // 每次渲染都是新对象，会让 ResizeObserver 在流式输出期间每帧重建。
  const hasHeaderSlot = Boolean(headerSlot);
  const [headerSlotHeight, setHeaderSlotHeight] = useState(0);
  useEffect(() => {
    const element = headerSlotRef.current;
    if (!element) {
      setHeaderSlotHeight(0);
      return;
    }
    const sync = () => {
      const next = element.getBoundingClientRect().height;
      setHeaderSlotHeight((current) => (Math.abs(current - next) < 0.5 ? current : next));
    };
    sync();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(sync);
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasHeaderSlot]);
  const [liveNowMs, setLiveNowMs] = useState(() => Date.now());
  // 「冻结历史 + 尾轮」分区（spec：docs/ui/chat-virtual-scroll.md「每帧派生成本」）：
  // 下面的派生都按 history 引用缓存历史段，流式帧只计算尾轮。
  const rowsPartition = getConversationRowsPartition(rows);
  // 插件卡片展示模型——同资源替代 + 最近三回合自动展开 + 手动固定；推导结果发布给卡片自己读。
  const selectPluginUiDerivation = useMemo(() => createLogicalUiInstancesSelector(), []);
  const pluginUiDerivation = useMemo(
    () => selectPluginUiDerivation(rows, rowsPartition),
    [rows, rowsPartition, selectPluginUiDerivation],
  );
  useEffect(() => {
    setPluginUiInstanceDerivation(sessionKey, pluginUiDerivation);
  }, [pluginUiDerivation, sessionKey]);
  const pluginUiPins = useSyncExternalStore(
    subscribePluginUiDisclosure,
    () => getPluginUiDisclosureSnapshot(sessionKey),
    () => getPluginUiDisclosureSnapshot(sessionKey),
  );
  const pluginUiPinResolver = useMemo<PluginUiRowPinResolver>(
    () => (toolCallId) => ({
      disposition: pluginUiDerivation.byToolCallId[toolCallId],
      manualPinned: pluginUiPins.get(toolCallId),
    }),
    [pluginUiDerivation, pluginUiPins],
  );
  const selectRenderUnits = useMemo(() => createConversationTurnRenderUnitsSelector(), []);
  const topicPreparations = useBotTopicPreparations();
  const renderUnits = useMemo(
    () =>
      withTopicPreparationUnits(
        selectRenderUnits(rowsPartition, {
          nowMs: liveNowMs,
          sessionPhase,
          pluginUiPinResolver,
        }),
        rows,
        topicPreparations,
      ),
    [
      liveNowMs,
      pluginUiPinResolver,
      rows,
      rowsPartition,
      sessionPhase,
      topicPreparations,
      selectRenderUnits,
    ],
  );
  const renderUnitCount = renderUnits.history.length + renderUnits.tail.length;
  const { virtualizedUnits, liveUnit, liveUnitIndex } = useMemo(
    () => splitConversationTimelineLiveTail(renderUnits),
    [renderUnits],
  );
  const historyHasRunningUnit = useMemo(
    () => renderUnits.history.some((unit) => unit.isRunning),
    [renderUnits.history],
  );
  const hasRunningUnit = historyHasRunningUnit || renderUnits.tail.some((unit) => unit.isRunning);
  const latestTurnSummary = useMemo(
    () =>
      resolveConversationLatestTurnSummary(
        renderUnits.tail.length > 0 ? renderUnits.tail : renderUnits.history,
      ),
    [renderUnits],
  );
  // 回调随会话 owner 变化；换了回调必须重新上报，不能因值相同而跳过。
  const reportedLatestTurnSummaryRef = useRef<{
    callback: (summary: ConversationLatestTurnSummary) => void;
    summary: ConversationLatestTurnSummary;
  } | null>(null);
  useEffect(() => {
    if (!onLatestTurnSummaryChange) {
      reportedLatestTurnSummaryRef.current = null;
      return;
    }
    const reported = reportedLatestTurnSummaryRef.current;
    if (
      reported?.callback === onLatestTurnSummaryChange &&
      isSameConversationLatestTurnSummary(reported.summary, latestTurnSummary)
    ) {
      return;
    }
    reportedLatestTurnSummaryRef.current = {
      callback: onLatestTurnSummaryChange,
      summary: latestTurnSummary,
    };
    onLatestTurnSummaryChange(latestTurnSummary);
  }, [latestTurnSummary, onLatestTurnSummaryChange]);
  const nextHighspeedExpiryMs = useMemo(
    () => resolveNextHighspeedExpiryMsInPartition(rowsPartition, liveNowMs),
    [liveNowMs, rowsPartition],
  );
  const selectTurnNavigatorQueryRowIds = useMemo(
    () => createConversationTurnNavigatorQueryRowIdsSelector(),
    [],
  );
  // 按分区收集目录成员：流式帧只看尾轮，成员不变时保持同一个 Set（锚点登记按它的身份失效）。
  const turnNavigatorQueryRowIds = useMemo(
    () => selectTurnNavigatorQueryRowIds(renderUnits),
    [renderUnits, selectTurnNavigatorQueryRowIds],
  );
  const turnNavigatorQueryRowIdsRef = useRef(turnNavigatorQueryRowIds);
  turnNavigatorQueryRowIdsRef.current = turnNavigatorQueryRowIds;
  // 会话首轮在窗口里、上方也没有分享导入块时，它就是对话最顶部的内容，由它的虚拟项承接
  // 状态胶囊 inset。inset 挂在虚拟项上而不是列表上：测高、跳到首轮、前插历史的锚点都把它算进去。
  // 只认「会话首轮」而不是「窗口首项」：前插更早历史时旧首项若丢掉 inset，阅读位置会跳 56px。
  const sessionStartAtTop = !headerSlot && !canLoadOlder && totalCount <= rows.length;
  const centeredEmptyLayout = centerEmptyStateWithDock && renderUnitCount === 0;
  const responsiveCenteredEmptyLayout = centeredEmptyLayout && !compactEmptyStateWithDock;
  // 高频值经 ref 供稳定回调读取（不进依赖数组）。
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const renderUnitCountRef = useRef(renderUnitCount);
  renderUnitCountRef.current = renderUnitCount;
  const virtualizedUnitsRef = useRef(virtualizedUnits);
  virtualizedUnitsRef.current = virtualizedUnits;
  const liveTailRef = useRef<HTMLDivElement>(null);
  const virtualHistoryRef = useRef<HTMLDivElement>(null);
  const stableContentWidthRef = useRef<number | null>(null);
  const contentWidthResizeActiveRef = useRef(false);
  const contentWidthResizeSettleTimerRef = useRef<number | null>(null);
  const committingMeasuredLayoutRef = useRef(false);
  const contentMeasurementPendingRef = useRef(false);
  const isContentWidthChanging = useCallback(() => {
    const currentContentWidth = virtualHistoryRef.current?.clientWidth ?? null;
    const stableContentWidth = stableContentWidthRef.current;
    return (
      committingMeasuredLayoutRef.current ||
      contentWidthResizeActiveRef.current ||
      (currentContentWidth !== null &&
        stableContentWidth !== null &&
        currentContentWidth !== stableContentWidth)
    );
  }, []);
  // loadOlder 相关值经 ref 读取，保持 handleScroll 稳定引用。
  const loadOlderRef = useRef({ canLoadOlder, loadingOlder, onLoadOlder });
  loadOlderRef.current = { canLoadOlder, loadingOlder, onLoadOlder };
  const followingRef = useRef(initialFollowing());
  const programmaticScrollFrameRef = useRef<number | null>(null);
  const userScrollIntentRef = useRef<{
    intent: TimelineUserScrollIntent;
    observedAt: number;
  }>({ intent: "none", observedAt: 0 });
  const touchClientYRef = useRef<number | null>(null);
  const scrollbarPointerIdRef = useRef<number | null>(null);
  const layoutScrollGuardUntilRef = useRef(0);
  const userAdjustedScrollSinceRestoreRef = useRef(false);
  const suppressVirtualizerAdjustmentDuringRestoreRef = useRef(false);
  const latestScrollMemoryStateRef = useRef<{
    key: string;
    state: ChatSessionScrollMemoryState;
  } | null>(null);
  const pendingDetachedScrollRestoreRef = useRef<PendingScrollMemoryRestore | null>(null);
  // 组件「已账目」的 scrollTop——scroll 事件读取值或组件自身
  // 程序化写入（贴底/prepend 平移）后的回读值。贴底 effect 拿它对账未观察滚动
  // （滚动已发生、scroll 事件未派发），防止过期 following=true 把用户/测试的上滚拽回底部。
  const lastObservedScrollTopRef = useRef(0);
  // prepend 锚定基线（上一 commit 的首行/总高度），见下方对账效应。
  const prependAnchorRef = useRef<{
    firstRowId: number | null;
    totalSize: number;
  }>({ firstRowId: null, totalSize: 0 });
  const pendingPrependVirtualAnchorRef = useRef<PrependVirtualAnchor | null>(null);
  const heightCacheRef = useRef<TimelineRowHeightCache | null>(null);
  if (heightCacheRef.current === null) {
    heightCacheRef.current = new TimelineRowHeightCache();
  }
  const [backToBottomVisible, setBackToBottomVisible] = useState(false);
  const [turnNavigatorActiveQueryRowId, setTurnNavigatorActiveQueryRowId] = useState<number>();
  const [turnNavigatorContainerWide, setTurnNavigatorContainerWide] = useState(false);
  const turnNavigatorEnabled =
    !hideTurnNavigator && turnNavigatorContainerWide && turnNavigatorQueryRowIds.size >= 2;
  const turnNavigatorEnabledRef = useRef(turnNavigatorEnabled);
  turnNavigatorEnabledRef.current = turnNavigatorEnabled;
  const turnNavigatorAnchorsRef = useRef<{
    root: HTMLDivElement;
    mountedKey: string;
    queryIds: ReadonlySet<number>;
    elements: HTMLElement[];
  } | null>(null);
  const turnNavigatorJumpFrameRef = useRef<number | null>(null);
  const turnNavigatorHydrationAttemptRef = useRef<{
    attemptCount: number;
    key: string | null;
    retryTimer: number | null;
    status: "idle" | "in-flight" | "waiting" | "terminal";
  }>({ attemptCount: 0, key: null, retryTimer: null, status: "idle" });
  const [turnNavigatorHydrationRetryRevision, setTurnNavigatorHydrationRetryRevision] = useState(0);
  const timelineRootRef = useRef<HTMLDivElement>(null);
  const composerDockRef = useRef<HTMLDivElement>(null);
  const shareSelectionPanelLayoutRef = useRef<{
    centerYPx: number;
    maxHeightPx: number;
  } | null>(null);
  // 右侧状态面板完整 inline 展开时，中间消息列和输入 dock 必须使用同一偏移；
  // 否则面板会覆盖正文，而不是并排布局。
  const summaryPanelInlineOffsetClassName =
    getConversationStatusPanelOffsetClassName(summaryPanelLayout);
  const contentWidthClassName = getConversationContentWidthClassName({
    centeredEmptyLayout,
    statusPanelLayout: summaryPanelLayout,
  });

  const syncShareSelectionPanelLayout = useCallback(() => {
    if (!backgroundScrollLocked) return;
    const container = selectionPanelLayoutContainerRef?.current;
    const dock = composerDockRef.current;
    if (!container || !dock) return;

    // 选择面板是 SessionPane 的兄弟节点，不能把 CSS 变量写在 Timeline
    // 自身，否则面板拿不到 dock 的真实边界；统一写入共享父容器供两者使用。
    const layout = syncConversationShareSelectionPanelLayout(container, dock);
    const previous = shareSelectionPanelLayoutRef.current;
    if (previous?.centerYPx === layout.centerYPx && previous.maxHeightPx === layout.maxHeightPx) {
      return;
    }
    shareSelectionPanelLayoutRef.current = layout;
  }, [backgroundScrollLocked, selectionPanelLayoutContainerRef]);

  useLayoutEffect(() => {
    if (!backgroundScrollLocked) return;
    const container = selectionPanelLayoutContainerRef?.current;
    const dock = composerDockRef.current;
    if (!container || !dock) return;

    syncShareSelectionPanelLayout();
    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(syncShareSelectionPanelLayout);
      resizeObserver.observe(container);
      resizeObserver.observe(timelineRootRef.current ?? container);
      if (scrollRef.current) resizeObserver.observe(scrollRef.current);
      resizeObserver.observe(dock);
    }

    // ResizeObserver 在部分 Electron flex 布局中可能晚于窗口尺寸变化回调，
    // 因此窗口 resize 也始终触发一次几何同步，保证面板随窗口放大/缩小。
    window.addEventListener("resize", syncShareSelectionPanelLayout);
    return () => {
      window.removeEventListener("resize", syncShareSelectionPanelLayout);
      resizeObserver?.disconnect();
    };
  }, [backgroundScrollLocked, selectionPanelLayoutContainerRef, syncShareSelectionPanelLayout]);

  const hasBottomDock = Boolean(bottomDock);
  useLayoutEffect(() => {
    // 完整视图浮窗收起态只露出底部输入区：由 dock 自身测量并上报高度（权限/问答卡片
    // 替换输入框时高度随之变化），宿主不去猜 SessionPane 内部结构。
    const dock = composerDockRef.current;
    if (!onComposerDockHeightChange || !dock || !hasBottomDock) return;
    const report = () => onComposerDockHeightChange(dock.getBoundingClientRect().height);
    report();
    if (typeof ResizeObserver === "undefined") return;
    const resizeObserver = new ResizeObserver(report);
    resizeObserver.observe(dock);
    return () => resizeObserver.disconnect();
  }, [hasBottomDock, onComposerDockHeightChange]);

  useEffect(() => {
    if (!hasRunningUnit) {
      return;
    }

    // 运行中的 assistant work 状态文案要显示“工作中 N 秒”并随时间推进；
    // 完成态耗时由协议事实固定，builder 会拒绝把这个 UI 时钟用于已结束轮次。
    setLiveNowMs(Date.now());
    const timer = window.setInterval(() => {
      setLiveNowMs(Date.now());
    }, RUNNING_WORK_DURATION_TICK_MS);

    return () => window.clearInterval(timer);
  }, [hasRunningUnit]);

  useEffect(() => {
    if (nextHighspeedExpiryMs === undefined) return;

    // Bug 根因：会话完成后工作时钟会停止；若 Highspeed 卡稍后才到期，footer 不会自行出现。
    // 单独订阅最近的卡片到期边界，避免为了等待倒计时持续刷新整个历史列表。
    // spec §9.3：到期唤醒基于 renderer setTimeout，窗口隐藏/被遮挡时会被 Chromium 冻结停摆；
    // helper 额外监听窗口恢复可见/获得焦点并即时追平 liveNowMs，footer 才能不依赖用户再发
    // 消息就出现。与 SessionPane 的 highspeedAutoShareClock 窗口唤醒补偿分工：那条刷新分享
    // 入口/查看按钮的完成态数据，这条刷新组尾 footer 的显隐时钟。
    return armHighspeedFooterExpiryClock(nextHighspeedExpiryMs, () => setLiveNowMs(Date.now()));
  }, [nextHighspeedExpiryMs]);

  useLayoutEffect(() => {
    const element = timelineRootRef.current;
    if (!element) return;

    // rail 改由 CSS container query 隐藏后，完整历史补拉失去了同一宽度
    // 资格边界，手机远控与窄分屏也会请求全部 rows。这里仅同步只读分页资格；
    // rail 的显隐、占位与过渡仍完全由 CSS 裁决，不恢复 composer 几何测量。
    const commitWidth = (width: number) => {
      // 这里只裁决资格，不把窗口拖动的每个像素传播给目录。
      setTurnNavigatorContainerWide(width >= CONVERSATION_TURN_NAVIGATOR_MIN_WIDTH_PX);
    };
    const readWidth = () => commitWidth(element.clientWidth);
    readWidth();

    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver((entries) => {
        const entry = entries[0];
        const borderBox = entry?.borderBoxSize?.[0];
        commitWidth(borderBox?.inlineSize ?? entry?.contentRect.width ?? element.clientWidth);
      });
      observer.observe(element);
      return () => observer.disconnect();
    }

    window.addEventListener("resize", readWidth);
    return () => window.removeEventListener("resize", readWidth);
  }, []);

  useEffect(() => {
    if (
      hideTurnNavigator ||
      !shouldHydrateConversationTurnNavigatorDirectory({
        canLoadOlder,
        containerWidthPx: turnNavigatorContainerWide ? CONVERSATION_TURN_NAVIGATOR_MIN_WIDTH_PX : 0,
        hasLoadHandler: Boolean(onLoadAllOlder),
        loadingOlder,
      })
    ) {
      return;
    }
    // terminal key 必须与 store turnNavigatorDirectoryRevision 同步。
    // 仅用 sessionKey + logEpoch 时，real-user query 增删不换 epoch，
    // 组件层 terminal 永久拦截，store 即使失效缓存也无法重新探测。
    const hydrationKey = `${sessionKey}:${rowContext.logEpoch ?? "unknown"}:${turnNavigatorDirectoryRevision}`;
    const attempt = turnNavigatorHydrationAttemptRef.current;
    if (attempt.key !== hydrationKey) {
      if (attempt.retryTimer !== null) window.clearTimeout(attempt.retryTimer);
      Object.assign(attempt, {
        attemptCount: 0,
        key: hydrationKey,
        retryTimer: null,
        status: "idle" as const,
      });
    }
    if (attempt.status !== "idle" || !onLoadAllOlder) return;
    attempt.status = "in-flight";
    logger.debug("[v4-turn-navigator] 目录请求补齐完整历史", {
      attempt: attempt.attemptCount + 1,
      loadedRows: rows.length,
      sessionKey,
      totalRows: totalCount,
    });
    void onLoadAllOlder().then((result) => {
      if (attempt.key !== hydrationKey) return;
      if (result.status === "hydrated" || result.status === "not-enough-queries") {
        attempt.status = "terminal";
        return;
      }
      if (result.status === "stale") {
        attempt.status = "idle";
        return;
      }
      attempt.attemptCount += 1;
      const retryDelayMs = resolveConversationTurnNavigatorHydrationRetryDelayMs(
        attempt.attemptCount,
      );
      if (retryDelayMs === null) {
        attempt.status = "terminal";
        return;
      }
      attempt.status = "waiting";
      attempt.retryTimer = window.setTimeout(() => {
        if (attempt.key !== hydrationKey) return;
        attempt.retryTimer = null;
        attempt.status = "idle";
        setTurnNavigatorHydrationRetryRevision((revision) => revision + 1);
      }, retryDelayMs);
    });
  }, [
    canLoadOlder,
    loadingOlder,
    onLoadAllOlder,
    rowContext.logEpoch,
    rows,
    sessionKey,
    totalCount,
    turnNavigatorContainerWide,
    hideTurnNavigator,
    turnNavigatorDirectoryRevision,
    turnNavigatorHydrationRetryRevision,
  ]);

  useEffect(
    () => () => {
      const timer = turnNavigatorHydrationAttemptRef.current.retryTimer;
      if (timer !== null) window.clearTimeout(timer);
    },
    [],
  );

  const getScrollElement = useCallback(() => scrollRef.current, []);
  const getItemKey = useCallback(
    (index: number) => virtualizedUnitsRef.current[index]?.key ?? index,
    [],
  );
  // 测高缓存兜底：行卸载重挂（甚至 virtualizer 重建）时用上次真实测量代替固定估计。
  const estimateSize = useCallback(
    (index: number) =>
      heightCacheRef.current?.estimate(
        getUnitHeightCacheKey(virtualizedUnitsRef.current[index]),
        // 一个虚拟单元是一整轮；未知长轮按小行的 72px 会首屏挂载十几轮正文。
        // 以一屏作保守预算，实际尺寸仍由缓存与 ResizeObserver 决定。
        scrollRef.current?.clientHeight || DEFAULT_ROW_HEIGHT_ESTIMATE_PX,
      ) ?? DEFAULT_ROW_HEIGHT_ESTIMATE_PX,
    [],
  );
  // 动态测高：virtualizer 对窗口内元素挂 ResizeObserver，流式行长高即回调此处；
  // 同时把真实高度写入稳定的 turnId 缓存。
  const measureElement = useCallback((element: Element, entry: ResizeObserverEntry | undefined) => {
    const height = measureRowHeight(element, entry);
    const indexAttr = element.getAttribute("data-index");
    const unit = indexAttr === null ? undefined : virtualizedUnitsRef.current[Number(indexAttr)];
    const cacheKey = getUnitHeightCacheKey(unit);
    if (cacheKey !== undefined) {
      heightCacheRef.current?.set(cacheKey, height);
    }
    return height;
  }, []);

  const [measuredLayoutRevision, commitMeasuredLayout] = useState(0);
  const virtualizer = useVirtualizer({
    count: virtualizedUnits.length,
    getScrollElement,
    estimateSize,
    overscan: ROW_OVERSCAN,
    getItemKey,
    measureElement,
    // headerSlot（分享导入的只读块）与虚拟列表同处一个滚动容器，
    // 且高度可观。不告知这段偏移，虚拟窗口会按 scrollTop 直接索引 item，
    // 渲染窗口整体偏移一个 header 高度，用户滚到的区域会是空白。
    scrollMargin: headerSlotHeight,
  });
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item) => {
    return shouldAdjustVirtualizerForItemSizeChange({
      // 前插批次由下方 prepend 锚点统一补偿；逐行测高再补一次会把阅读位置推到底部。
      suppressAdjustment:
        suppressVirtualizerAdjustmentDuringRestoreRef.current ||
        (contentMeasurementPendingRef.current &&
          prependAnchorRef.current.firstRowId !== null &&
          (rowsRef.current[0]?.rowId ?? Infinity) < prependAnchorRef.current.firstRowId),
      following: followingRef.current,
      contentWidthChanging: isContentWidthChanging(),
      itemEnd: item.end,
      // 同批 RO 的 item 坐标尚未重算，原生 scrollTop 已含前一行补偿；混用会把目标之后
      // 的行也判为视口上方。比较 virtualizer 同一测量批次的偏移，再由原生 scroll 入账。
      scrollTop: virtualizer.scrollOffset ?? scrollRef.current?.scrollTop ?? 0,
    });
  };
  const virtualRows = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  // virtualizer 的缓存可能先于 React DOM 更新；只用最近一次提交的几何判断是否需要同步屏障。
  const committedVirtualLayoutRef = useRef(new Map<number, { start: number; size: number }>());
  useLayoutEffect(() => {
    committedVirtualLayoutRef.current = new Map(
      virtualRows.map((row) => [row.index, { start: row.start, size: row.size }]),
    );
  }, [virtualRows]);
  const turnNavigatorVirtualItems: ConversationTurnNavigatorVirtualItem[] = useMemo(() => {
    const historyItems = virtualRows.map((row) => ({
      index: row.index,
      size: row.size,
      start: row.start,
    }));
    if (liveUnitIndex === null) return historyItems;
    return [
      ...historyItems,
      {
        index: liveUnitIndex,
        start: totalSize,
        // live tail 不参与 virtualizer 测高；覆盖剩余滚动区即可供目录判定当前轮次。
        size: Number.MAX_SAFE_INTEGER - totalSize,
      },
    ];
  }, [liveUnitIndex, totalSize, virtualRows]);
  const mountedRowsKey = useMemo(
    () =>
      [
        measuredLayoutRevision,
        ...virtualRows.map((row) => `${row.key}:${row.start}:${row.size}`),
        ...(liveUnit === null ? [] : [String(liveUnit.key)]),
      ].join(":"),
    [liveUnit, measuredLayoutRevision, virtualRows],
  );
  const mountedRowsKeyRef = useRef(mountedRowsKey);
  mountedRowsKeyRef.current = mountedRowsKey;

  const markProgrammaticScroll = useCallback(() => {
    if (programmaticScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(programmaticScrollFrameRef.current);
    }
    programmaticScrollFrameRef.current = window.requestAnimationFrame(() => {
      programmaticScrollFrameRef.current = null;
    });
  }, []);

  const commitFollowing = useCallback((following: boolean) => {
    if (followingRef.current === following) return;
    followingRef.current = following;
    setBackToBottomVisible(shouldShowBackToBottom(following, renderUnitCountRef.current));
  }, []);

  const clearUserScrollIntent = useCallback(() => {
    userScrollIntentRef.current = { intent: "none", observedAt: 0 };
    touchClientYRef.current = null;
    scrollbarPointerIdRef.current = null;
  }, []);

  const getActiveUserScrollIntent = useCallback((): TimelineUserScrollIntent => {
    const current = userScrollIntentRef.current;
    const interactionActive =
      touchClientYRef.current !== null || scrollbarPointerIdRef.current !== null;
    if (interactionActive) {
      return current.intent === "none" ? "unknown" : current.intent;
    }
    return Date.now() - current.observedAt <= USER_SCROLL_INTENT_TTL_MS ? current.intent : "none";
  }, []);

  const markLayoutScrollGuard = useCallback(() => {
    layoutScrollGuardUntilRef.current = Date.now() + LAYOUT_SCROLL_GUARD_MS;
  }, []);

  const markUserScrollIntent = useCallback(
    (intent: TimelineUserScrollIntent) => {
      if (intent === "none") return;
      userScrollIntentRef.current = { intent, observedAt: Date.now() };
      const element = scrollRef.current;
      // running -> terminal 会折叠工作历史并触发测高。
      // 向上滚动必须在 scroll 事件之前先拿走滚动权，否则终态
      // layout effect 会拿过期的 following=true 把用户重新拽到底部。
      if (intent === "awayFromBottom" && element && element.scrollHeight > element.clientHeight) {
        commitFollowing(false);
      }
    },
    [commitFollowing],
  );

  const handleWheelCapture = useCallback(
    (event: ReactWheelEvent<HTMLDivElement>) => {
      markUserScrollIntent(timelineWheelScrollIntent(event.deltaY));
    },
    [markUserScrollIntent],
  );

  const handleTouchStartCapture = useCallback((event: ReactTouchEvent<HTMLDivElement>) => {
    touchClientYRef.current = event.touches[0]?.clientY ?? null;
  }, []);

  const handleTouchMoveCapture = useCallback(
    (event: ReactTouchEvent<HTMLDivElement>) => {
      const nextClientY = event.touches[0]?.clientY;
      const previousClientY = touchClientYRef.current;
      if (nextClientY === undefined || previousClientY === null) return;
      markUserScrollIntent(timelineTouchScrollIntent(previousClientY, nextClientY));
      touchClientYRef.current = nextClientY;
    },
    [markUserScrollIntent],
  );

  const handleTouchEndCapture = useCallback(() => {
    touchClientYRef.current = null;
  }, []);

  const handleKeyDownCapture = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      markUserScrollIntent(
        timelineKeyboardScrollIntent({
          key: event.key,
          shiftKey: event.shiftKey,
          editableTarget: isEditableScrollTarget(event.target),
        }),
      );
    },
    [markUserScrollIntent],
  );

  const handlePointerDownCapture = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      // 内容区点击（尤其 composer 发送）不是滚动意图；只有 scrollbar/空白命中
      // scroll container 自身时才登记未知方向，随后由真实 scroll 落点裁决。
      if (event.target !== event.currentTarget) return;
      scrollbarPointerIdRef.current = event.pointerId;
      markUserScrollIntent("unknown");
    },
    [markUserScrollIntent],
  );

  const handlePointerEndCapture = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (scrollbarPointerIdRef.current === event.pointerId) {
      scrollbarPointerIdRef.current = null;
    }
  }, []);

  useLayoutEffect(() => {
    // 修复原因：浮窗展开态输入区曾是滚动容器内的 sticky 层，滚动条一直延伸到输入框后面。
    // 浮窗形态下输入区改为相对时间线根节点贴底（同一 DOM，不重挂载），滚动容器底边让出输入区高度。
    const root = timelineRootRef.current;
    const dock = composerDockRef.current;
    if (!floatingComposerDock || !root || !dock) return;
    const sync = () =>
      root.style.setProperty(
        "--v4-floating-composer-dock-height",
        `${dock.getBoundingClientRect().height}px`,
      );
    sync();
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(sync);
    resizeObserver?.observe(dock);
    return () => {
      resizeObserver?.disconnect();
      root.style.removeProperty("--v4-floating-composer-dock-height");
    };
  }, [floatingComposerDock, hasBottomDock]);

  const syncTurnNavigatorViewport = useCallback((element: HTMLDivElement) => {
    if (!turnNavigatorEnabledRef.current) {
      turnNavigatorAnchorsRef.current = null;
      return;
    }
    let anchors = turnNavigatorAnchorsRef.current;
    if (
      !anchors ||
      anchors.root !== element ||
      anchors.mountedKey !== mountedRowsKeyRef.current ||
      anchors.queryIds !== turnNavigatorQueryRowIdsRef.current ||
      anchors.elements.some((anchor) => !anchor.isConnected)
    ) {
      anchors = {
        root: element,
        mountedKey: mountedRowsKeyRef.current,
        queryIds: turnNavigatorQueryRowIdsRef.current,
        elements: Array.from(element.querySelectorAll<HTMLElement>("[data-row-id]")).filter((row) =>
          turnNavigatorQueryRowIdsRef.current.has(Number(row.dataset.rowId)),
        ),
      };
      turnNavigatorAnchorsRef.current = anchors;
    }
    const viewportRect = element.getBoundingClientRect();
    const queryPositions: ConversationTurnNavigatorQueryPosition[] = [];
    // 虚拟窗口/目录成员变化时登记节点，滚动复用节点但读取实时几何；展开与流式测高不会过期。
    for (const rowElement of anchors.elements) {
      const rowId = Number(rowElement.dataset.rowId);
      const rowRect = rowElement.getBoundingClientRect();
      const start = element.scrollTop + rowRect.top - viewportRect.top;
      queryPositions.push({ rowId, start, end: start + rowRect.height });
    }
    // 只发布语义变化。像素滚动已由 virtualizer 持有，不能再驱动整棵 timeline 状态。
    const activeQueryRowId = resolveConversationTurnNavigatorActiveQueryRowId({
      positions: queryPositions,
      scrollOffsetPx: element.scrollTop,
      viewportHeightPx: element.clientHeight,
    });
    setTurnNavigatorActiveQueryRowId(activeQueryRowId);
  }, []);

  const buildCurrentScrollMemoryState = useCallback(
    (element: HTMLDivElement): ChatSessionScrollMemoryState => {
      const metrics = {
        scrollTop: element.scrollTop,
        viewportHeight: element.clientHeight,
        contentHeight: element.scrollHeight,
      };
      const wasPinnedToBottom = reconcileFollowingForContentAnchor({
        following: followingRef.current,
        metrics,
        lastObservedScrollTop: lastObservedScrollTopRef.current,
      });
      return {
        scrollTop: element.scrollTop,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
        wasPinnedToBottom,
        updatedAt: Date.now(),
      };
    },
    [],
  );

  const cacheCurrentScrollMemoryState = useCallback(
    (element: HTMLDivElement): ChatSessionScrollMemoryState => {
      const state = buildCurrentScrollMemoryState(element);
      if (scrollMemoryKey) {
        latestScrollMemoryStateRef.current = { key: scrollMemoryKey, state };
      }
      return state;
    },
    [buildCurrentScrollMemoryState, scrollMemoryKey],
  );

  const notifyScrollObserversAfterCommit = useCallback((element: HTMLDivElement) => {
    scheduleMicrotask(() => {
      if (scrollRef.current !== element) return;
      element.dispatchEvent(new Event("scroll"));
    });
  }, []);

  const captureScrollMemoryBeforeScopeMutation = useCallback(
    (previousKey: string | null): ConversationScrollMemoryScopeSnapshot | null => {
      const pendingRestore = pendingDetachedScrollRestoreRef.current;
      if (pendingRestore?.key === previousKey) {
        // 会话数据尚未到达时 DOM 只能读到被钳制的 scrollTop=0；此时切换
        // 任务不能用空时间线覆盖原记忆，必须保留尚未落地的 detached 恢复意图。
        return pendingRestore;
      }
      const element = scrollRef.current;
      if (!previousKey || !element) return null;
      return {
        key: previousKey,
        state: buildCurrentScrollMemoryState(element),
      };
    },
    [buildCurrentScrollMemoryState],
  );

  const commitCapturedScrollMemory = useCallback(
    (snapshot: ConversationScrollMemoryScopeSnapshot | null) => {
      if (!snapshot) return;
      latestScrollMemoryStateRef.current = snapshot;
      saveChatSessionScrollMemoryState(snapshot.key, snapshot.state);
    },
    [],
  );

  // 贴底必须 instant（scrollTop 赋值）：smooth 的中间帧会被 scroll 判定误读为「离底」。
  const scrollToBottom = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    markProgrammaticScroll();
    // 草稿安全居中允许内容在低高度下向下溢出；若沿用真实会话吸底，
    // 顶部安全留白会被滚走。草稿始终展示顶部，真实会话继续吸底。
    element.scrollTop = responsiveCenteredEmptyLayout ? 0 : element.scrollHeight;
    // 回读取钳制后的落点入账（浏览器会把赋值钳到最大可滚动距离）。
    lastObservedScrollTopRef.current = element.scrollTop;
    syncTurnNavigatorViewport(element);
    userAdjustedScrollSinceRestoreRef.current = false;
    cacheCurrentScrollMemoryState(element);
    notifyScrollObserversAfterCommit(element);
  }, [
    cacheCurrentScrollMemoryState,
    responsiveCenteredEmptyLayout,
    markProgrammaticScroll,
    notifyScrollObserversAfterCommit,
    syncTurnNavigatorViewport,
  ]);

  useLayoutEffect(() => {
    const contentColumn = virtualHistoryRef.current;
    if (!contentColumn || typeof ResizeObserver === "undefined") return;

    stableContentWidthRef.current = contentColumn.clientWidth;
    let observedViewportHeight = scrollRef.current?.clientHeight ?? 0;
    let observeContentFrame: number | null = null;
    let disposed = false;
    const observer = new ResizeObserver(() => {
      const nextWidth = contentColumn.clientWidth;
      const element = scrollRef.current;
      if (!element) return;
      const viewportHeightChanged = observedViewportHeight !== element.clientHeight;
      observedViewportHeight = element.clientHeight;
      if (nextWidth === stableContentWidthRef.current && !viewportHeightChanged) return;
      markLayoutScrollGuard();
      commitFollowing(
        reconcileFollowingForContentAnchor({
          following: followingRef.current,
          metrics: {
            scrollTop: element.scrollTop,
            viewportHeight: element.clientHeight,
            contentHeight: element.scrollHeight,
          },
          lastObservedScrollTop: lastObservedScrollTopRef.current,
          userScrollIntent: getActiveUserScrollIntent(),
        }),
      );
      if (followingRef.current) {
        if (contentWidthResizeSettleTimerRef.current !== null) {
          window.clearTimeout(contentWidthResizeSettleTimerRef.current);
          contentWidthResizeSettleTimerRef.current = null;
        }
        // 本批次统一提交布局与吸底，其间其他内容 effect 不得按中间高度吸底。
        observer.unobserve(contentColumn);
        committingMeasuredLayoutRef.current = true;
        try {
          // virtualizer 的 ResizeObserver 默认异步提交 React；先吸底会使用旧占位高度，
          // 下一帧测高提交后再跳一次。仅在 observer 内批量测高并同步提交，避免跨帧追赶。
          const measurements = Array.from(
            contentColumn.querySelectorAll(":scope > [data-index]"),
            (node) => ({
              index: Number(node.getAttribute("data-index")),
              height: measureElement(node, undefined),
            }),
          );
          const committed = committedVirtualLayoutRef.current;
          const changed = measurements.filter(
            (item) => committed.get(item.index)?.size !== item.height,
          );
          const pendingLayout = virtualizer.getVirtualItems().some((item) => {
            const rendered = committed.get(item.index);
            return rendered?.start !== item.start || rendered.size !== item.size;
          });
          // 侧栏动画每帧改变列宽，但消息不一定每帧换行。仅高度或待提交坐标有变化时
          // flushSync；仍比较已提交几何，不能因 RO 已更新缓存就漏掉防跳动的提交屏障。
          if (
            changed.length > 0 ||
            pendingLayout ||
            Number.parseFloat(contentColumn.style.height) !== virtualizer.getTotalSize()
          ) {
            flushSync(() => {
              for (const item of measurements) virtualizer.resizeItem(item.index, item.height);
              commitMeasuredLayout((revision) => revision + 1);
            });
          }
        } finally {
          committingMeasuredLayoutRef.current = false;
          // 暂停的是本批次会写入高度的观察目标，不推迟测高或吸底。下一帧继续
          // 观察内容列宽度，以覆盖视口停止后仍在进行的 CSS 宽度过渡。
          if (observeContentFrame !== null) window.cancelAnimationFrame(observeContentFrame);
          if (!disposed) {
            observeContentFrame = window.requestAnimationFrame(() => {
              observeContentFrame = null;
              observer.observe(contentColumn);
            });
          }
        }
        if (disposed) return;
        stableContentWidthRef.current = contentColumn.clientWidth;
        contentWidthResizeActiveRef.current = false;
        // 同步提交可能触发其他布局处理；用户上滚或定位始终优先。
        if (followingRef.current && getActiveUserScrollIntent() !== "awayFromBottom")
          scrollToBottom();
        return;
      }
      if (nextWidth === stableContentWidthRef.current) return;

      // 宽度变化会让虚拟行分批重新测高；逐行补偿或逐批追底都会
      // 连续改写 scrollTop。resize 期间暂停两者，稳定后只执行一次最终贴底。
      contentWidthResizeActiveRef.current = true;
      if (contentWidthResizeSettleTimerRef.current !== null) {
        window.clearTimeout(contentWidthResizeSettleTimerRef.current);
      }
      contentWidthResizeSettleTimerRef.current = window.setTimeout(() => {
        stableContentWidthRef.current = contentColumn.clientWidth;
        contentWidthResizeActiveRef.current = false;
        contentWidthResizeSettleTimerRef.current = null;
        // 宽度校正期间禁用测高补偿；发布既有生命周期的结束，使待定位搜索此时接管。
        // 否则过早居中后，新挂载的上方缓冲行会把命中推离视口。
        commitMeasuredLayout((revision) => revision + 1);
        if (followingRef.current) {
          scrollToBottom();
        }
      }, CONTENT_WIDTH_RESIZE_SETTLE_MS);
    });
    observer.observe(contentColumn);
    if (scrollRef.current) observer.observe(scrollRef.current);

    return () => {
      disposed = true;
      observer.disconnect();
      if (observeContentFrame !== null) window.cancelAnimationFrame(observeContentFrame);
      if (contentWidthResizeSettleTimerRef.current !== null) {
        window.clearTimeout(contentWidthResizeSettleTimerRef.current);
        contentWidthResizeSettleTimerRef.current = null;
      }
      contentWidthResizeActiveRef.current = false;
    };
  }, [
    commitFollowing,
    getActiveUserScrollIntent,
    markLayoutScrollGuard,
    measureElement,
    renderUnitCount === 0,
    scrollToBottom,
    virtualizer,
  ]);

  useLayoutEffect(() => {
    const element = liveTailRef.current;
    const cacheKey = getUnitHeightCacheKey(liveUnit ?? undefined);
    if (!element || cacheKey === undefined) return;

    const cacheHeight = (entry?: ResizeObserverEntry) => {
      const height = measureRowHeight(element, entry);
      heightCacheRef.current?.set(cacheKey, height);
      return height;
    };
    let observedHeight = cacheHeight();
    if (typeof ResizeObserver === "undefined") return;

    // projection revision 的父 layout effect 可能早于 Markdown 子树最终测高；
    // 旧 observer 只缓存高度，正文会先把 loading 槽顶下去，后续 commit 才补 scrollTop。
    // ResizeObserver 在绘制前拿到真实高度，这里仅在仍拥有 following 滚动权时同步吸底；
    // 用户已经上滚（包括 scroll event 尚未入账的竞态）则只缓存，不夺回阅读位置。
    const observer = new ResizeObserver((entries) => {
      const nextHeight = cacheHeight(entries[0]);
      if (nextHeight === observedHeight) return;
      observedHeight = nextHeight;

      const scrollElement = scrollRef.current;
      if (!scrollElement) return;
      markLayoutScrollGuard();
      const following = reconcileFollowingForContentAnchor({
        following: followingRef.current,
        metrics: {
          scrollTop: scrollElement.scrollTop,
          viewportHeight: scrollElement.clientHeight,
          contentHeight: scrollElement.scrollHeight,
        },
        lastObservedScrollTop: lastObservedScrollTopRef.current,
        userScrollIntent: getActiveUserScrollIntent(),
      });
      commitFollowing(following);
      if (anchorActionAfterContentChange(following, isContentWidthChanging()) === "stickToBottom") {
        scrollToBottom();
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [
    commitFollowing,
    getActiveUserScrollIntent,
    isContentWidthChanging,
    liveUnit?.key,
    markLayoutScrollGuard,
    scrollToBottom,
  ]);

  const saveCurrentScrollMemory = useCallback(() => {
    const key = scrollMemoryKey;
    const element = scrollRef.current;
    if (!key) return;
    const pendingRestore = pendingDetachedScrollRestoreRef.current;
    const cached = latestScrollMemoryStateRef.current;
    const cachedState = cached?.key === key ? cached.state : null;
    const state =
      pendingRestore?.key === key
        ? pendingRestore.state
        : element
          ? cacheCurrentScrollMemoryState(element)
          : cachedState;
    if (state) saveChatSessionScrollMemoryState(key, state);
  }, [cacheCurrentScrollMemoryState, scrollMemoryKey]);

  const restoreScrollMemory = useCallback(
    (state: ChatSessionScrollMemoryState) => {
      const element = scrollRef.current;
      if (!element) return;
      clearUserScrollIntent();
      markProgrammaticScroll();
      element.scrollTop = resolveChatSessionScrollRestoreTop(state, element);
      lastObservedScrollTopRef.current = element.scrollTop;
      followingRef.current = false;
      setBackToBottomVisible(shouldShowBackToBottom(false, renderUnitCountRef.current));
      syncTurnNavigatorViewport(element);
      userAdjustedScrollSinceRestoreRef.current = false;
      cacheCurrentScrollMemoryState(element);
    },
    [
      cacheCurrentScrollMemoryState,
      clearUserScrollIntent,
      markProgrammaticScroll,
      syncTurnNavigatorViewport,
    ],
  );

  const handleScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const programmaticScroll =
      programmaticScrollFrameRef.current !== null &&
      Math.abs(element.scrollTop - lastObservedScrollTopRef.current) < 1;
    const userScrollIntent = getActiveUserScrollIntent();
    // 用户输入优先；其余 scroll 若落在内容/测高 guard 内视为布局补偿，guard 外的
    // 未分类事件继续按真实用户滚动处理，兼容原生滚动条和辅助技术。
    const scrollSource =
      userScrollIntent !== "none"
        ? "user"
        : programmaticScroll
          ? "programmatic"
          : Date.now() <= layoutScrollGuardUntilRef.current
            ? "layout"
            : "user";
    // virtualizer 的原生 offset observer 会先于 React onScroll 入账；到这里即可确认它
    // 已看见恢复后的真实 scrollTop。用户滚动也应立即结束保护窗，把滚动权交还用户。
    if (scrollSource !== "layout") {
      suppressVirtualizerAdjustmentDuringRestoreRef.current = false;
    }
    lastObservedScrollTopRef.current = element.scrollTop;
    syncTurnNavigatorViewport(element);
    const following = resolveFollowingAfterScroll({
      following: followingRef.current,
      source: scrollSource,
      metrics: {
        scrollTop: element.scrollTop,
        viewportHeight: element.clientHeight,
        contentHeight: element.scrollHeight,
      },
    });
    commitFollowing(following);
    if (scrollSource === "user") {
      pendingDetachedScrollRestoreRef.current = null;
      userAdjustedScrollSinceRestoreRef.current = true;
      saveCurrentScrollMemory();
    }
    // 只在 64px 顶边才补页时，用户会先撞到窗口边界再看到内容跳入；提前两个
    // 视口预取，让桌面和手机 Web 共用的 renderer 在用户抵达边界前完成补页。
    const loadOlder = loadOlderRef.current;
    const triggerPx = historyPrefetchTriggerPx(element.clientHeight);
    if (
      shouldTriggerLoadOlder({
        scrollTop: element.scrollTop,
        canLoadOlder: loadOlder.canLoadOlder,
        loadingOlder: loadOlder.loadingOlder,
        triggerPx,
      })
    ) {
      // 前插超过 viewport + overscan 后旧可见 turn 会被卸载，DOM 不能作为跨
      // commit 锚点；这里保存 virtualizer 按稳定 turn key 维护的 measurement 起点。
      const anchorMeasurement = virtualizer.getVirtualItemForOffset(element.scrollTop);
      const anchorUnit = anchorMeasurement
        ? virtualizedUnitsRef.current[anchorMeasurement.index]
        : undefined;
      pendingPrependVirtualAnchorRef.current =
        anchorMeasurement && anchorUnit?.key === anchorMeasurement.key
          ? {
              key: anchorUnit.key,
              offsetTop: anchorMeasurement.start - element.scrollTop,
              start: anchorMeasurement.start,
            }
          : null;
      logger.debug("[v4-timeline] 接近历史窗口顶部，自动预取更早行", {
        scrollTop: element.scrollTop,
        triggerPx,
      });
      loadOlder.onLoadOlder?.();
    }
  }, [
    commitFollowing,
    getActiveUserScrollIntent,
    saveCurrentScrollMemory,
    syncTurnNavigatorViewport,
    virtualizer,
  ]);

  const handleBackToBottom = useCallback(() => {
    pendingDetachedScrollRestoreRef.current = null;
    clearUserScrollIntent();
    commitFollowing(true);
    scrollToBottom();
    // scrollToBottom 只更新组件内 ref；若用户点击后立刻切任务，scope
    // cleanup/scroll 事件可能还没运行，旧 Map 会把下次恢复重新带回中部甚至顶部。
    saveCurrentScrollMemory();
  }, [clearUserScrollIntent, commitFollowing, saveCurrentScrollMemory, scrollToBottom]);

  useLayoutEffect(() => {
    if (!scrollToBottomActionRef) return;
    scrollToBottomActionRef.current = handleBackToBottom;
    return () => {
      // 只清理本实例登记的动作，避免切 pane 时旧 cleanup 覆盖新 timeline。
      if (scrollToBottomActionRef.current === handleBackToBottom) {
        scrollToBottomActionRef.current = null;
      }
    };
  }, [handleBackToBottom, scrollToBottomActionRef]);

  const scrollToQuery = useCallback(
    (target: { unitIndex: number; rowId: number }, behavior: ScrollBehavior = "auto") => {
      clearUserScrollIntent();
      commitFollowing(false);
      if (turnNavigatorJumpFrameRef.current !== null) {
        window.cancelAnimationFrame(turnNavigatorJumpFrameRef.current);
        turnNavigatorJumpFrameRef.current = null;
      }

      const scrollMountedQuery = (element: HTMLDivElement): boolean => {
        const rowElement = element.querySelector<HTMLElement>(`[data-row-id="${target.rowId}"]`);
        if (!rowElement) return false;
        const targetTop =
          element.scrollTop +
          rowElement.getBoundingClientRect().top -
          element.getBoundingClientRect().top;
        if (behavior === "auto") {
          element.scrollTop = targetTop;
        } else {
          element.scrollTo({ top: targetTop, behavior });
        }
        lastObservedScrollTopRef.current = element.scrollTop;
        syncTurnNavigatorViewport(element);
        logger.debug("[v4-turn-navigator] 定位用户 query", {
          behavior,
          rowId: target.rowId,
          unitIndex: target.unitIndex,
        });
        return true;
      };

      const element = scrollRef.current;
      if (!element || scrollMountedQuery(element)) return;

      // product turn 是虚拟列表的最小挂载单元，steer query 是单元内锚点。目标未挂载时
      // 先无动画挂载所属 turn，再按用户 motion 偏好精确滚到 row，不能退回 turn 开头。
      if (target.unitIndex === liveUnitIndex) {
        const liveTail = liveTailRef.current;
        if (liveTail) {
          element.scrollTop =
            element.scrollTop +
            liveTail.getBoundingClientRect().top -
            element.getBoundingClientRect().top;
        }
      } else {
        virtualizer.scrollToIndex(target.unitIndex, {
          align: "start",
          behavior: "auto",
        });
      }

      let remainingAttempts = 12;
      const alignMountedQuery = () => {
        turnNavigatorJumpFrameRef.current = null;
        const currentElement = scrollRef.current;
        if (currentElement && scrollMountedQuery(currentElement)) return;
        remainingAttempts -= 1;
        if (remainingAttempts <= 0) {
          logger.warn("[v4-turn-navigator] query 锚点挂载超时", {
            rowId: target.rowId,
            unitIndex: target.unitIndex,
          });
          return;
        }
        turnNavigatorJumpFrameRef.current = window.requestAnimationFrame(alignMountedQuery);
      };
      turnNavigatorJumpFrameRef.current = window.requestAnimationFrame(alignMountedQuery);
    },
    [clearUserScrollIntent, commitFollowing, liveUnitIndex, syncTurnNavigatorViewport, virtualizer],
  );

  useLayoutEffect(() => {
    if (!scrollToQueryActionRef) return;
    const action = (target: { unitIndex: number; rowId: number }) => {
      scrollToQuery(target);
    };
    scrollToQueryActionRef.current = action;
    return () => {
      if (scrollToQueryActionRef.current === action) {
        scrollToQueryActionRef.current = null;
      }
    };
  }, [scrollToQuery, scrollToQueryActionRef]);

  useEffect(
    () => () => {
      if (turnNavigatorJumpFrameRef.current !== null) {
        window.cancelAnimationFrame(turnNavigatorJumpFrameRef.current);
        turnNavigatorJumpFrameRef.current = null;
      }
    },
    [sessionKey],
  );

  const scrollToUnit = useCallback(
    (unitIndex: number, behavior: ScrollBehavior = "auto") => {
      clearUserScrollIntent();
      commitFollowing(false);
      if (unitIndex === liveUnitIndex) {
        const element = scrollRef.current;
        const liveTail = liveTailRef.current;
        if (!element || !liveTail) return;
        const targetTop =
          element.scrollTop +
          liveTail.getBoundingClientRect().top -
          element.getBoundingClientRect().top;
        if (behavior === "auto") {
          element.scrollTop = targetTop;
        } else {
          element.scrollTo({ top: targetTop, behavior });
        }
        lastObservedScrollTopRef.current = element.scrollTop;
        syncTurnNavigatorViewport(element);
        return;
      }
      // Bug 根因：scrollToIndex 会持续校正 turn 起点，与随后命中 Range 的居中争夺滚动权；
      // 它还会在 scroll 的同步提交中逐行测高，造成错误窗口反复挂载。这里只写入粗定位，
      // 后续校正由 find 请求跟随已提交测量驱动，命中到位后结束。
      const offset = virtualizer.getOffsetForIndex(unitIndex, "start")?.[0];
      if (offset !== undefined) scrollRef.current?.scrollTo({ top: offset, behavior });
    },
    [clearUserScrollIntent, commitFollowing, liveUnitIndex, syncTurnNavigatorViewport, virtualizer],
  );

  const isMountedLayoutMeasured = useCallback(
    () =>
      !isContentWidthChanging() &&
      virtualizer.getVirtualItems().every((row) => {
        const node = virtualizer.elementsCache.get(row.key);
        return node?.isConnected && measureRowHeight(node, undefined) === row.size;
      }),
    [isContentWidthChanging, virtualizer],
  );

  useConversationTimelineFind({
    rootRef: scrollRef,
    renderUnits,
    rows,
    mountedRowsKey,
    canLoadOlder,
    loadingOlder,
    onLoadOlder,
    sessionPhase,
    conversationFindQuery,
    conversationFindActiveIndex,
    conversationFindNavigationRequestId,
    onConversationFindMatchStateChange,
    searchResultHighlightRequest,
    onSearchResultHighlightDone,
    scrollToUnit,
    isMountedLayoutMeasured,
  });

  const saveCurrentScrollMemoryRef = useRef(saveCurrentScrollMemory);
  saveCurrentScrollMemoryRef.current = saveCurrentScrollMemory;

  useLayoutEffect(() => {
    return () => {
      // 真正卸载时 DOM 尚在；scope 更新则由 before-mutation capture 读取旧 DOM。
      saveCurrentScrollMemoryRef.current();
    };
  }, []);

  const rowCount = renderUnitCount;
  const rowWindowKey = `${rows.length}:${rows[0]?.rowId ?? "none"}:${rows[rows.length - 1]?.rowId ?? "none"}`;
  const pendingGuideKey = pendingGuides.map((item) => item.queueItemId).join(":");

  // V4 迁移删除旧 ChatView 滚动 hook 后，sessionKey effect 仍固定滚到底部，
  // 导致残留的 renderer-local 记忆模块彻底断线。这里在清测高并重新 measure 后按 scope
  // 恢复；首个 layout 立即写入防闪动，下一帧再校正异步测高，但必须把滚动权让给用户。
  useLayoutEffect(() => {
    clearUserScrollIntent();
    heightCacheRef.current?.clear();
    // prepend 锚定基线一并重置：rowId 跨会话可重复，禁止拿旧会话首行比较。
    prependAnchorRef.current = { firstRowId: null, totalSize: 0 };
    pendingPrependVirtualAnchorRef.current = null;
    // draft 默认吸底会留下旧 virtualizer.scrollOffset；在恢复写入派发 scroll 事件前，
    // 测高若继续按旧 offset 校正，会把刚恢复的历史位置重新推回 draft 的落点。
    suppressVirtualizerAdjustmentDuringRestoreRef.current = true;
    virtualizer.measure();
    userAdjustedScrollSinceRestoreRef.current = false;

    const restoredState = readChatSessionScrollMemoryState(scrollMemoryKey);
    const pendingRestoreWait = resolvePendingScrollMemoryRestoreWait(
      restoredState,
      scrollRef.current,
      renderUnitCountRef.current > 0,
    );
    pendingDetachedScrollRestoreRef.current =
      scrollMemoryKey && restoredState && pendingRestoreWait
        ? {
            key: scrollMemoryKey,
            rowWindowKey,
            state: restoredState,
            waitFor: pendingRestoreWait,
          }
        : null;
    const restore = () => {
      if (!restoredState || restoredState.wasPinnedToBottom === true) {
        suppressVirtualizerAdjustmentDuringRestoreRef.current = false;
        followingRef.current = initialFollowing();
        setBackToBottomVisible(false);
        scrollToBottom();
        return;
      }
      restoreScrollMemory(restoredState);
    };

    restore();
    let releaseGuardFrame: number | null = null;
    const correctionFrame = window.requestAnimationFrame(() => {
      if (!userAdjustedScrollSinceRestoreRef.current) {
        restore();
      }
      releaseGuardFrame = window.requestAnimationFrame(() => {
        suppressVirtualizerAdjustmentDuringRestoreRef.current = false;
      });
    });
    return () => {
      window.cancelAnimationFrame(correctionFrame);
      if (releaseGuardFrame !== null) {
        window.cancelAnimationFrame(releaseGuardFrame);
      }
      suppressVirtualizerAdjustmentDuringRestoreRef.current = false;
    };
  }, [
    clearUserScrollIntent,
    restoreScrollMemory,
    scrollMemoryKey,
    scrollToBottom,
    sessionKey,
    virtualizer,
  ]);

  // 冷恢复先展示末尾窗口，再补齐同一 turnId 的正文；稳定 ref 不会重新测高，
  // 只等 ResizeObserver 会先画出新正文和旧坐标，造成一帧重叠。提交后批量读取
  // 已挂载轮次，在 layout 阶段更新既有 virtualizer；下一次同步提交后再对账锚点。
  useLayoutEffect(() => {
    const renderedSizes = new Map(virtualRows.map((row) => [row.index, row.size]));
    const measurements = Array.from(
      virtualHistoryRef.current?.querySelectorAll(":scope > [data-index]") ?? [],
      (node) => ({
        index: Number(node.getAttribute("data-index")),
        height: measureElement(node, undefined),
      }),
    ).filter((item) => renderedSizes.get(item.index) !== item.height);
    contentMeasurementPendingRef.current = measurements.length > 0;
    if (measurements.length === 0) return;
    for (const item of measurements) virtualizer.resizeItem(item.index, item.height);
    // RO 可能已写入缓存但尚未提交 DOM；此时 resizeItem 无差量，也要提交坐标。
    commitMeasuredLayout((revision) => revision + 1);
  }, [measureElement, rowWindowKey, virtualRows, virtualizer]);

  useLayoutEffect(() => {
    if (contentMeasurementPendingRef.current) return;
    const pendingRestore = pendingDetachedScrollRestoreRef.current;
    if (rowCount === 0 || !pendingRestore || pendingRestore.key !== scrollMemoryKey) {
      return;
    }

    // session scope 往往先于 rows 订阅完成；只在 scope commit 和下一帧
    // 恢复会把历史 scrollTop 钳成 0。首批内容到达后重新落地，并再等一帧校正测高。
    suppressVirtualizerAdjustmentDuringRestoreRef.current = true;
    restoreScrollMemory(pendingRestore.state);
    let releaseGuardFrame: number | null = null;
    const correctionFrame = window.requestAnimationFrame(() => {
      if (
        pendingDetachedScrollRestoreRef.current === pendingRestore &&
        !userAdjustedScrollSinceRestoreRef.current
      ) {
        restoreScrollMemory(pendingRestore.state);
      }
      releaseGuardFrame = window.requestAnimationFrame(() => {
        if (
          pendingDetachedScrollRestoreRef.current === pendingRestore &&
          canReleasePendingScrollMemoryRestore(
            pendingRestore,
            scrollRef.current,
            rowCount,
            canLoadOlder || totalCount > rows.length,
            rowWindowKey,
          )
        ) {
          pendingDetachedScrollRestoreRef.current = null;
        }
        suppressVirtualizerAdjustmentDuringRestoreRef.current = false;
      });
    });

    return () => {
      window.cancelAnimationFrame(correctionFrame);
      if (releaseGuardFrame !== null) {
        window.cancelAnimationFrame(releaseGuardFrame);
      }
      suppressVirtualizerAdjustmentDuringRestoreRef.current = false;
    };
  }, [
    canLoadOlder,
    restoreScrollMemory,
    rowCount,
    rowWindowKey,
    measuredLayoutRevision,
    scrollMemoryKey,
    totalCount,
    totalSize,
  ]);

  // prepend 锚定：loadOlder 前插历史行时平移 scrollTop，阅读位置不跳。
  // 既有 turn key=turnId 且测量缓存不失效 → 前插只把总高度撑高 delta，scrollTop += delta
  // 即恢复锚点（绘制前完成，无闪动）；本效应声明在会话切换效应之后，切换 commit 上
  // 先重置基线再对账，防跨会话 rowId 误判为前插。
  useLayoutEffect(() => {
    if (contentMeasurementPendingRef.current) return;
    const prev = prependAnchorRef.current;
    const nextFirstRowId = rowsRef.current[0]?.rowId ?? null;
    const nextTotalSize = virtualizer.getTotalSize();
    const pendingRestore = pendingDetachedScrollRestoreRef.current;
    const pendingRestoreOwnsAnchor = pendingRestore?.key === scrollMemoryKey;
    const didPrepend =
      prev.firstRowId !== null && nextFirstRowId !== null && nextFirstRowId < prev.firstRowId;
    let viewportAdjustment: number | null = null;
    if (didPrepend && !pendingRestoreOwnsAnchor && scrollRef.current) {
      const previousVirtualAnchor = pendingPrependVirtualAnchorRef.current;
      const nextAnchorMeasurement = previousVirtualAnchor
        ? virtualizer.measurementsCache.find(
            (measurement) => measurement.key === previousVirtualAnchor.key,
          )
        : undefined;
      if (previousVirtualAnchor && nextAnchorMeasurement) {
        viewportAdjustment = prependVirtualAnchorAdjustment(
          previousVirtualAnchor,
          {
            key: previousVirtualAnchor.key,
            offsetTop: previousVirtualAnchor.offsetTop,
            start: nextAnchorMeasurement.start,
          },
          scrollRef.current.scrollTop,
        );
      }
    }
    if (didPrepend) pendingPrependVirtualAnchorRef.current = null;
    const adjustment = pendingRestoreOwnsAnchor
      ? null
      : (viewportAdjustment ??
        prependScrollAdjustment({
          prevFirstRowId: prev.firstRowId,
          nextFirstRowId,
          prevTotalSize: prev.totalSize,
          nextTotalSize,
        }));
    if (adjustment !== null && scrollRef.current) {
      const element = scrollRef.current;
      markLayoutScrollGuard();
      element.scrollTop += adjustment;
      // 程序化平移同样入账，避免被下方贴底对账误读为「未观察滚动」。
      lastObservedScrollTopRef.current = element.scrollTop;
      syncTurnNavigatorViewport(element);
      cacheCurrentScrollMemoryState(element);
      // 一次前插数千行时，measurement cache 与 scrollTop 会在同一 commit
      // 更新，Chromium 可能合并掉原生 scroll 通知，virtualizer 仍按旧 offset 挂载首屏，
      // 形成“滚动条在底部、正文却空白”。commit 后按最终落点补发只读通知；若同帧存在
      // 用户 wheel/pointer 意图，handleScroll 仍会优先识别为 user，不夺回滚动权。
      notifyScrollObserversAfterCommit(element);
    }
    // 待恢复的离底记忆拥有当前 commit 的坐标系；不能让 prepend 把临时 clamp 值再次
    // 平移。恢复 effect 会在同一 commit 的下一帧按最终内容高度重放原始位置。
    prependAnchorRef.current = {
      firstRowId: nextFirstRowId,
      totalSize: nextTotalSize,
    };
  });

  // 底部锚定：内容变化（新行 / 流式 delta / 动态测高修正 → totalSize 变化）时，
  // 跟随中贴底，解除跟随保持阅读位置。useLayoutEffect 在绘制前完成贴底，避免闪动。
  // terminal 会自动折叠过程区并触发测高；这些 scrollTop 回退属于布局，必须保持 following。
  // 若同帧有用户向上滚动，capture handler 会先登记 awayFromBottom，本 effect 必须让位。
  useLayoutEffect(() => {
    if (contentMeasurementPendingRef.current) return;
    const element = scrollRef.current;
    markLayoutScrollGuard();
    if (element) {
      const following = reconcileFollowingForContentAnchor({
        following: followingRef.current,
        metrics: {
          scrollTop: element.scrollTop,
          viewportHeight: element.clientHeight,
          contentHeight: element.scrollHeight,
        },
        lastObservedScrollTop: lastObservedScrollTopRef.current,
        userScrollIntent: getActiveUserScrollIntent(),
      });
      commitFollowing(following);
    }
    if (
      anchorActionAfterContentChange(followingRef.current, isContentWidthChanging()) ===
      "stickToBottom"
    ) {
      scrollToBottom();
    }
  }, [
    getActiveUserScrollIntent,
    isContentWidthChanging,
    markLayoutScrollGuard,
    commitFollowing,
    headerSlotHeight,
    measuredLayoutRevision,
    pendingGuideKey,
    rowCount,
    rows,
    scrollToBottom,
    totalSize,
  ]);

  useLayoutEffect(() => {
    if (scrollRef.current) {
      syncTurnNavigatorViewport(scrollRef.current);
    }
  }, [
    pendingGuideKey,
    rowCount,
    syncTurnNavigatorViewport,
    totalSize,
    mountedRowsKey,
    turnNavigatorEnabled,
    turnNavigatorQueryRowIds,
  ]);

  // 行清空（如 editUserQuery 大范围 rewind）：重置为跟随并收起按钮，
  // 后续重新出现的行走上面的锚定 effect 贴底。
  useEffect(() => {
    if (rowCount === 0) {
      if (pendingDetachedScrollRestoreRef.current?.key === scrollMemoryKey) {
        return;
      }
      followingRef.current = initialFollowing();
      if (backToBottomVisible) {
        setBackToBottomVisible(false);
      }
    }
  }, [rowCount, backToBottomVisible, scrollMemoryKey]);

  useEffect(() => {
    return () => {
      if (programmaticScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(programmaticScrollFrameRef.current);
        programmaticScrollFrameRef.current = null;
      }
    };
  }, []);

  // raw projection row 与按 turn 合并后的 render unit 不是同一计量单位；
  // 分开暴露才能让恢复/分页验证不再把可见 unit 误当成持久 row。
  return (
    <div
      ref={timelineRootRef}
      className={cn(
        "relative flex min-h-0 flex-1 flex-col",
        compactForRemoteControl && "min-w-0",
        // 原先消息层的 mask 靠 scroll 回调追赶合成滚动，快速滚动会闪黑并漏字。
        // 把底部留白移到视口外，由原生 overflow 裁剪；输入框仍在同一视口内 sticky。
        hasBottomDock && !centeredEmptyLayout && !floatingComposerDock && "pb-4",
      )}
    >
      {selectionActions ? (
        <ConversationSelectionTooltip
          rootRef={scrollRef}
          rows={rows}
          sourceSessionId={sessionKey}
          enabled={selectionActions.enabled}
          sideActionDisabled={selectionActions.sideActionDisabled}
          commentEnabled={selectionActions.commentEnabled === true}
          annotationWorkspaceKey={selectionActions.annotationWorkspaceKey}
          onAddToCurrentTask={selectionActions.onAddToCurrentTask}
          onAskInSideChat={selectionActions.onAskInSideChat}
        />
      ) : null}
      <ConversationScrollMemoryScopeCapture
        scopeKey={scrollMemoryKey}
        capture={captureScrollMemoryBeforeScopeMutation}
        commit={commitCapturedScrollMemory}
      />
      {/* Bugfix：分享选择流程无论面板展开还是收起，左 rail 都由分享面板或 reopen 按钮独占，
          必须隐藏对话轮导航，避免两个绝对定位控件互相覆盖。退出分享选择后自动恢复。 */}
      {hideTurnNavigator ? null : (
        <ConversationTurnNavigator
          enabled={turnNavigatorEnabled}
          renderUnits={renderUnits}
          isHydratingDirectory={loadingOlder}
          scrollOffsetPx={virtualizer.scrollOffset ?? 0}
          viewportHeightPx={virtualizer.scrollRect?.height ?? 0}
          virtualItems={turnNavigatorVirtualItems}
          activeQueryRowId={turnNavigatorActiveQueryRowId}
          onJumpToQuery={scrollToQuery}
        />
      )}
      <div
        ref={scrollRef}
        data-testid={TID_V4_TIMELINE}
        data-v4-timeline-scroll="true"
        data-v4-timeline-scroll-locked={backgroundScrollLocked ? "true" : "false"}
        data-markdown-table-layout-root="true"
        data-row-count={rows.length}
        data-window-row-count={rows.length}
        data-render-unit-count={renderUnitCount}
        data-total-row-count={totalCount}
        data-following={backToBottomVisible ? "false" : "true"}
        data-loading-older={loadingOlder ? "true" : "false"}
        onKeyDownCapture={handleKeyDownCapture}
        onPointerCancelCapture={handlePointerEndCapture}
        onPointerDownCapture={handlePointerDownCapture}
        onPointerUpCapture={handlePointerEndCapture}
        onScroll={handleScroll}
        onTouchCancelCapture={handleTouchEndCapture}
        onTouchEndCapture={handleTouchEndCapture}
        onTouchMoveCapture={handleTouchMoveCapture}
        onTouchStartCapture={handleTouchStartCapture}
        onWheelCapture={handleWheelCapture}
        className={cn(
          // 原生滚动条按内容高度动态出现时会缩窄会话视口，导致消息与 composer
          // 横向跳动；稳定预留 gutter，让桌面与手机 Web 共用的滚动区宽度保持不变。
          // 只声明 overflow-y-auto 会让浏览器把横轴计算为 auto，宽内容会把
          // 整条 Conversation 撑出横向滚动；表格和代码块应由各自内部容器滚动。
          "min-h-0 flex-1 overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable_both-edges] [--markdown-table-layout-left-inset:16px] [--markdown-table-layout-right-inset:16px] max-md:[--markdown-table-layout-left-inset:8px] max-md:[--markdown-table-layout-right-inset:8px]",
          // 分享选择面板展开时改为 overflow-hidden：scrollTop 与 scrollbar-gutter 都保持不变，
          // 但原生滚动条、滚轮和键盘翻页都不再能移动背景，勾选目标不会漂走。
          backgroundScrollLocked && "!overflow-y-hidden",
          compactForRemoteControl && "min-w-0",
          // 浮窗形态：滚动容器止于输入框上方 12px，消息底部再留 16px 空白。
          floatingComposerDock &&
            "mb-[calc(var(--v4-floating-composer-dock-height,0px)+12px)] pb-4",
          // 修复原因：Conversation turn map 覆盖 timeline 左侧 48px；表格增强滚动如果仍按
          // 普通 16px 边距借位，会有 32px 落到 turn map 下方，必须把完整占用计入左边界。
          turnNavigatorQueryRowIds.size >= 2 &&
            "@min-[864px]/conversation:[--markdown-table-layout-left-inset:48px]",
        )}
      >
        <div
          className={cn(
            // 固定高度断点会在窗口跨过临界值时让问候语与 composer 整组跳动。
            // 顶部留白按视口高度伸缩，输入框的位置不再受下方推荐列表高度影响；
            // 空间不足时顶部可收缩到底线，底部继续随内容自然排布。
            responsiveCenteredEmptyLayout
              ? // Bugfix 根因：动态修改原生窗口下限会把内容换行反馈到窗口拖动，产生阻尼；
                // 容器保留固有最小高度，由外层 timeline 统一承接受限高度下的溢出内容。
                "flex min-h-full flex-col items-center px-2 before:block before:min-h-[52px] before:w-full before:shrink before:basis-[29dvh] before:content-[''] after:block after:min-h-4 after:w-full after:flex-1 after:content-['']"
              : centeredEmptyLayout
                ? "flex min-h-full flex-col items-center justify-center gap-4 px-2"
                : "flex min-h-full flex-col",
          )}
          // session 切到 draft 时内容高度骤降，Chrome 会把子树里的
          // sticky composer 选作原生 scroll anchor，并在切回后覆盖 layout/RAF 恢复值。
          // V4 已自管 prepend、吸底和记忆锚点；和其它虚拟列表一致，应从内容子树禁用锚点候选。
          style={{ overflowAnchor: "none" }}
        >
          {renderUnitCount === 0 && !headerSlot ? (
            <div
              className={cn(
                centeredEmptyLayout
                  ? "flex w-full max-w-2xl shrink-0 items-center justify-center"
                  : "min-h-0 flex-1",
                !centeredEmptyLayout && summaryPanelInlineOffsetClassName,
              )}
            >
              {emptyState}
            </div>
          ) : (
            <div
              data-v4-timeline-message-layer="true"
              data-sandbox-page-container="true"
              className="relative w-full flex-1"
            >
              {/*
               * headerSlot 与实时消息列共用内容层及宽度类，保持同一个滚动和裁剪边界。
               */}
              {headerSlot ? (
                <div
                  ref={headerSlotRef}
                  data-v4-timeline-header-slot="true"
                  data-v4-timeline-content-column="true"
                  className={cn(
                    "relative mx-auto w-full shrink-0",
                    contentWidthClassName,
                    summaryPanelInlineOffsetClassName,
                  )}
                >
                  {headerSlot}
                </div>
              ) : null}
              <div
                ref={virtualHistoryRef}
                data-v4-timeline-virtual-history="true"
                data-v4-timeline-content-column="true"
                className={cn(
                  // 宽度过渡会让打开对话时的输入框逐帧伸缩，并反复触发消息测高。
                  // 消息历史、活动轮和输入区直接采用同一套 CSS 布局，不对尺寸或偏移做动画。
                  "relative mx-auto w-full shrink-0",
                  contentWidthClassName,
                  summaryPanelInlineOffsetClassName,
                )}
                style={{ height: totalSize }}
              >
                {virtualRows.map((virtualRow) => {
                  const unit = virtualizedUnits[virtualRow.index];
                  if (!unit) return null;
                  const clearsStatusPanel = sessionStartAtTop && virtualRow.index === 0;
                  return (
                    <div
                      key={`${virtualRow.key}:${rowContext.logEpoch ?? ""}`}
                      ref={virtualizer.measureElement}
                      data-index={virtualRow.index}
                      data-v4-turn-unit="true"
                      data-turn-id={unit.turnId}
                      // virtual history 的子项通过 absolute 定位，父级 padding 不会缩小
                      // 它们的 containing block；正文响应式内边距必须落在 turn wrapper 自身。
                      className={cn(
                        "absolute left-0 top-0 w-full",
                        clearsStatusPanel && CONVERSATION_STATUS_PANEL_TOP_CLEARANCE_CLASS_NAME,
                      )}
                      style={{ transform: `translateY(${virtualRow.start - headerSlotHeight}px)` }}
                    >
                      <ConversationTurnGroup
                        unit={unit}
                        nowMs={unit.isRunning ? liveNowMs : undefined}
                        apiRetry={null}
                        context={rowContext}
                        onFork={onFork}
                        onRetry={onRetry}
                        onFeedbackChange={onFeedbackChange}
                        onEdit={onEdit}
                        topClearedByTimeline={clearsStatusPanel}
                      />
                    </div>
                  );
                })}
              </div>
              {liveUnit !== null && liveUnitIndex !== null ? (
                <div
                  key={`${liveUnit.key}:${rowContext.logEpoch ?? ""}`}
                  ref={liveTailRef}
                  data-index={liveUnitIndex}
                  data-v4-live-tail="true"
                  data-v4-running-live-tail={liveUnit.isRunning ? "true" : undefined}
                  data-v4-turn-unit="true"
                  data-turn-id={liveUnit.turnId}
                  data-v4-timeline-content-column="true"
                  className={cn(
                    "relative mx-auto w-full shrink-0",
                    contentWidthClassName,
                    summaryPanelInlineOffsetClassName,
                    sessionStartAtTop &&
                      liveUnitIndex === 0 &&
                      CONVERSATION_STATUS_PANEL_TOP_CLEARANCE_CLASS_NAME,
                  )}
                >
                  <ConversationTurnGroup
                    unit={liveUnit}
                    nowMs={liveUnit.isRunning ? liveNowMs : undefined}
                    apiRetry={apiRetry}
                    context={rowContext}
                    onFork={onFork}
                    onRetry={onRetry}
                    onFeedbackChange={onFeedbackChange}
                    onEdit={onEdit}
                    topClearedByTimeline={sessionStartAtTop && liveUnitIndex === 0}
                  />
                </div>
              ) : null}
              {pendingGuides.length > 0 ? (
                <div
                  data-v4-timeline-content-column="true"
                  className={cn(
                    "relative mx-auto w-full shrink-0",
                    contentWidthClassName,
                    summaryPanelInlineOffsetClassName,
                  )}
                >
                  <ConversationPendingGuideList
                    context={rowContext}
                    items={pendingGuides}
                    turnId={
                      liveUnit?.turnId ??
                      rows.at(-1)?.productTurnId ??
                      rows.at(-1)?.turnId ??
                      "pending-guide"
                    }
                  />
                </div>
              ) : null}
            </div>
          )}
          {bottomDock ? (
            <div
              ref={composerDockRef}
              data-v4-composer-dock="true"
              className={cn(
                // sticky dock 是 z-20 的全宽透明层，过去会盖住 z-10 rail
                // 在 composer 左侧留白内的按钮。外壳不接事件，只让实际内容列恢复命中。
                "pointer-events-none z-20 flex w-full justify-center",
                // 浮窗形态：滚动容器与内容层都没有定位，absolute 的包含块是时间线根节点，
                // 输入区贴在时间线底部、不随消息滚动，也不被滚动容器裁剪。
                floatingComposerDock
                  ? "absolute inset-x-0 bottom-0"
                  : responsiveCenteredEmptyLayout
                    ? "mt-3 shrink-0"
                    : centeredEmptyLayout
                      ? "shrink-0"
                      : "sticky bottom-0",
              )}
            >
              <div
                data-v4-composer-dock-content="true"
                className={cn(
                  // 草稿内层会立即收窄，外层也必须直接定位，避免输入框从左侧滑向中间。
                  "pointer-events-auto relative z-10 w-full shrink-0",
                  contentWidthClassName,
                  // 浮窗形态下输入框外壳就是浮窗最外层，不留内边距。
                  !centeredEmptyLayout && !floatingComposerDock && "px-2",
                  !centeredEmptyLayout && summaryPanelInlineOffsetClassName,
                )}
              >
                <div data-v4-back-to-bottom-anchor="composer-dock" className="relative">
                  {backToBottomVisible ? (
                    <ConversationBackToBottomButton
                      // 分屏下 composer 属于滚动视口内的 sticky dock；按钮若挂在
                      // timeline 外层 absolute bottom，会相对整个 pane 落到 input 下方。
                      //
                      // 圆钮采用自己的居中定位；`pointer-events-auto` 保留：
                      // 它是"按钮点得动"唯一可断言的契约。
                      className="pointer-events-auto absolute bottom-full left-1/2 z-30 mb-2 -translate-x-1/2 shadow-sm"
                      label={intl.formatMessage({ id: "chat.scrollToBottom" })}
                      onClick={handleBackToBottom}
                    />
                  ) : null}
                  {bottomDock}
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
      {backToBottomVisible && !bottomDock ? (
        <ConversationBackToBottomButton
          className="absolute bottom-3 left-1/2 -translate-x-1/2 shadow-sm"
          label={intl.formatMessage({ id: "chat.scrollToBottom" })}
          onClick={handleBackToBottom}
        />
      ) : null}
    </div>
  );
}

export const ConversationTimeline = memo(ConversationTimelineImpl);
