/* eslint-disable max-lines -- IAB owner registry、ready/abort lifecycle 与 guest CDP 状态必须在同一状态机内原子维护，拆散会重新引入跨 scope 竞态。 */
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { webContents, type WebFrameMain } from "electron";
import {
  BROWSER_VIEW_DRAFT_SESSION_ID,
  BROWSER_VIEWPORT_LIMITS,
  DEFAULT_AGENT_BROWSER_VIEWPORT,
  type BrowserClientMode,
  type BrowserCommand,
  type BrowserCommandResult,
  type BrowserGuestAttachRejectReason,
  type BrowserGuestAttachResult,
  type BrowserDialog,
  type BrowserRecordingAction,
  type BrowserRecordingJob,
  type BrowserRecordingOptions,
  type BrowserResponseMeta,
  type BrowserTabSummary,
  type BrowserUserTabInfo,
  type BrowserViewCloseTabRequest,
  type BrowserViewPromoteDraftTabsRequest,
  type BrowserViewResidencyReportPayload,
  type BrowserViewResidencyTransitionPayload,
  type BrowserViewRestoredTabShell,
  type BrowserViewportSize,
} from "@zcode/shared";
import { executeBrowserCommandOnView, type ControlledView } from "./browserCommandExecutor.js";
import type { ControlledViewKeyInputEvent } from "./browserCommandTypes.js";
import { executeIabPlaywrightLocator } from "./browserPlaywrightLocatorExecutor.js";
import { recordBrowserVideo, type BrowserWebmRecorderFactory } from "./browserVideoRecorder.js";
import { normalizePlaywrightTimeout } from "./browserPlaywrightTimeout.js";
import type {
  BrowserScreenshotSurfaceCoordinator,
  BrowserScreenshotSurfaceLease,
} from "./browserScreenshotSurfaceCoordinator.js";
import {
  startBrowserScreenshotTransparentWindowBootstrap,
  TRANSPARENT_WINDOW_PRESENTATION_GRACE_MS,
  type BrowserWindowForTransparentBootstrap,
  type TransparentWindowBootstrap,
} from "./browserTransparentWindowBootstrap.js";
import {
  BrowserTabResidencyCoordinator,
  type BrowserTabResidencyRecord,
} from "./browserTabResidencyCoordinator.js";
import type {
  BrowserTabPageStateRecord,
  BrowserTabRecoveryStore,
  BrowserTabShellRecord,
} from "./browserTabRecoveryStore.js";

interface GuestWebContents {
  readonly id: number;
  readonly hostWebContents?: { getZoomFactor(): number } | null;
  readonly mainFrame: WebFrameMain;
  getType(): string;
  getZoomFactor(): number;
  setZoomFactor(factor: number): void;
  isDestroyed(): boolean;
  loadURL(url: string): Promise<void>;
  getURL(): string;
  getTitle(): string;
  reload(): void;
  stop(): void;
  capturePage(): Promise<{ toPNG(): Buffer }>;
  executeJavaScript(script: string, userGesture?: boolean): Promise<unknown>;
  sendInputEvent(event: ControlledViewKeyInputEvent): void;
  navigationHistory: {
    canGoBack(): boolean;
    canGoForward(): boolean;
    goBack(): void;
    goForward(): void;
    getAllEntries(): Array<{ url: string; title?: string; pageState?: string }>;
    getActiveIndex(): number;
    restore(options: {
      entries: Array<{ url: string; title?: string; pageState?: string }>;
      index: number;
    }): Promise<void>;
  };
  close(options?: { waitForBeforeUnload?: boolean }): void;
  isCurrentlyAudible?(): boolean;
  setAudioMuted?(muted: boolean): void;
  isBeingCaptured?(): boolean;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
  debugger: {
    isAttached(): boolean;
    attach(protocolVersion?: string): void;
    detach(): void;
    sendCommand(method: string, params?: unknown, sessionId?: string): Promise<unknown>;
    on(event: "message", listener: (event: unknown, method: string, params: unknown) => void): void;
    removeListener(
      event: "message",
      listener: (event: unknown, method: string, params: unknown) => void,
    ): void;
  };
  once(event: "destroyed", listener: () => void): void;
  session?: {
    on(
      event: "will-download",
      listener: (event: unknown, item: GuestDownloadItem, contents: GuestWebContents) => void,
    ): void;
    removeListener(
      event: "will-download",
      listener: (event: unknown, item: GuestDownloadItem, contents: GuestWebContents) => void,
    ): void;
  };
}

interface GuestDownloadItem {
  getSavePath(): string;
  once(event: "done", listener: (event: unknown, state: string) => void): void;
}

export interface BrowserGuestExecutionContext {
  controlScopeId?: string;
  requestId: string;
  browserId: string;
  browserGeneration: number;
  windowId: number;
  workspaceKey: string;
  sessionId: string;
  turnId?: string;
  remoteSessionId?: string;
  clientMode: BrowserClientMode;
}

interface InternalExecutionContext extends BrowserGuestExecutionContext {
  legacy?: boolean;
}

type TabLifecycle = "active" | "deliverable" | "handoff" | "closed";
type GuestBindingLifecycle = "detached" | "attached" | "detaching" | "destroyed";
type GuestRecoveryReason = BrowserGuestAttachRejectReason | "guest-destroyed" | "attach-timeout";

const TAB_CONTEXT_RECOVERY_HINT =
  "This is pre-action stale-binding recovery, not post-action popup observation. " +
  "Keep the existing browser binding; call browser.tabs.list(), then browser.tabs.get(info.id). " +
  "If the controlled list is empty, inspect browser.user.openTabs() and use browser.user.claimTab(info) " +
  "before creating a new tab.";

interface ManagedTab {
  tabId: string;
  owner: InternalExecutionContext;
  guest?: GuestWebContents;
  /** guest replacement generation；命令 dispatch 前用来拒绝 stale guest。 */
  guestGeneration: number;
  /** 曾经成功绑定过 guest；用于区分新建 tab 的首次等待与已有 tab 的自愈。 */
  hasAttachedGuest: boolean;
  attachFailure?: GuestRecoveryReason;
  rebindRequested: boolean;
  cdpAttached: boolean;
  /** guest 的 native CDP 生命周期；DOM 销毁前必须先经过 detaching。 */
  guestLifecycle: GuestBindingLifecycle;
  /** 尚未 settle 的 debugger.sendCommand 数量，teardown 会等待其归零或超时。 */
  pendingCdpCommands: number;
  /** 命令流空闲释放的计时器；每次 CDP 命令完成后重置，detachGuest 时清除。 */
  guestCdpIdleTimer?: ReturnType<typeof setTimeout>;
  /** re-attach 会话态恢复 flight；业务命令必须 await 它完成才能派发（串行屏障）。 */
  guestCdpRestoreFlight?: Promise<void>;
  /** 当前已持有 viewport 临界区；CDP 重连直接重放，不能再次入队等待自己。 */
  insideViewportMutation?: boolean;
  /** 同一 guest 的 replacement teardown 只允许一个 flight，重复 ACK 共享结果。 */
  guestTeardownFlight?: Promise<boolean>;
  lifecycle: TabLifecycle;
  origin: "agent" | "user";
  /** human IAB tab 在同 window/workspace 首次操作前可被任一 session 发现。 */
  claimable: boolean;
  /** claimed user tab finalize/closeSession 时恢复为用户 tab，不能像 agent tab 一样关闭。 */
  userOwner?: InternalExecutionContext;
  active: boolean;
  /** Agent/UI 设置的单 tab CSS viewport；undefined 表示跟随宿主自然尺寸。 */
  viewportOverride?: BrowserViewportSize;
  /** pane 隐藏为 0×0 时仅供后台执行使用；重新前台可见后必须清除。 */
  backgroundViewportFallback?: BrowserViewportSize;
  /** 串行化 transient clear 与显式 set/reset，保证最后一次用户/Agent 设置胜出。 */
  viewportMutation?: Promise<void>;
  downloadCleanup?: () => void;
  activityCleanup?: () => void;
  /**
   * 注销 debugger 的 "message" 监听。guest 换代后旧监听不该继续挂着：它每次事件都要查表
   * 再靠 current.guest !== guest 兜底丢弃，属于纯泄漏。注意这只是 JS 层清理，native 侧的
   * CDP 通路要靠 debugger.detach() 才真正断开。
   */
  cdpMessageCleanup?: () => void;
  /**
   * 注销 render-process-gone 监听。该监听负责在 guest renderer 被杀、WebContents 尚存的
   * 窗口里主动断开 CDP —— 这是唯一能避免 api::Debugger 走隐式析构的时机。
   */
  crashGuardCleanup?: () => void;
  loading: boolean;
  mediaActive: boolean;
  /** 最近一次 renderer 上报的「属于当前对话」；未上报前不静音。 */
  currentTask?: boolean;
  cachedUrl: string;
  cachedTitle: string;
  cachedFaviconUrl: string | null;
  openedAt: number;
  restoredFromStore?: boolean;
}

interface PendingWaiter {
  resolve: (guest: GuestWebContents | null) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface RunningRequest {
  context: InternalExecutionContext;
  controller: AbortController;
  dispatched: boolean;
  tabId?: string;
}

interface InFlightScreenshot {
  execution: Promise<BrowserCommandResult>;
  requestId: string;
  startedAt: number;
}

interface BrowserRecordingEntry {
  id: string;
  context: InternalExecutionContext;
  tabId: string;
  controller: AbortController;
  status: BrowserRecordingJob["status"];
  phase: BrowserRecordingJob["phase"];
  progress: number;
  startedAt: number;
  updatedAt: number;
  artifact?: BrowserRecordingJob["artifact"];
  error?: string;
  cleanupTimer?: ReturnType<typeof setTimeout>;
  completion?: Promise<void>;
}

interface DownloadRecord {
  tabId: string;
  path: string | null;
  state: "pending" | "completed" | "cancelled" | "interrupted";
}

interface DownloadWaiter {
  resolve: (downloadId: string | null) => void;
  timer: ReturnType<typeof setTimeout>;
  signal: AbortSignal;
  onAbort: () => void;
}

const DEFAULT_ATTACH_TIMEOUT_MS = 10_000;
// 透明 presentation 已就位时整幅 capture 的硬上限；正常应在数百 ms 内完成。
const HIDDEN_WINDOW_CAPTURE_DEADLINE_MS = 5_000;
// 单个 tab 上"已放弃等待但底层 CDP capture 仍未结算"的硬上限。CDP 截图没有单请求
// 取消 API，重试会在 Chromium 内遗留 pending command；compositor 持续不可用时
// 不设上限会无限叠加（帧恢复时它们会同时排空，但 pendingCdpCommands 不归零、
// detach 走超时路径）。达到上限后同 tab 截图快速失败并提示重开 tab，旧 capture
// 真实落定后名额自动回收。
const MAX_ABANDONED_SCREENSHOT_CAPTURES = 3;
/** teardown 等待 CDP 在途命令收敛的上限；超时后仍会尝试 native detach。 */
const DEFAULT_GUEST_CDP_TEARDOWN_TIMEOUT_MS = 1_000;
// CDP 命令流空闲释放阈值：覆盖实测崩溃窗口（turn 内命令间隙 0.4~9s）的同时，
// 不打断 agent 密集操作流（命令间隔通常远小于该值）。
const DEFAULT_GUEST_CDP_IDLE_RELEASE_MS = 1_500;
const RECORDING_RESULT_TTL_MS = 60 * 60 * 1_000;
const DEFAULT_BACKGROUND_BROWSER_VIEWPORT: BrowserViewportSize = {
  width: 800,
  height: 600,
};

type BrowserTabRecoveryStorePort = Pick<
  BrowserTabRecoveryStore,
  "upsert" | "upsertPageState" | "getPageState" | "removePageState" | "remove" | "listShells"
> &
  Partial<Pick<BrowserTabRecoveryStore, "whenIdle">>;

export interface BrowserGuestManagerResidencyOptions {
  tabLimit?: number;
  suspendAckTimeoutMs?: number;
  now?: () => number;
  recoveryStore?: BrowserTabRecoveryStorePort;
  onSuspendTabRequested?(payload: BrowserViewResidencyTransitionPayload): void;
  onRestoreTabRequested?(payload: BrowserViewResidencyTransitionPayload): void;
  onResidencyChanged?(payload: BrowserViewResidencyTransitionPayload): void;
  onRecoveryOrphanCloseRequested?(payload: { tabId: string; reason: "recovery-orphan" }): void;
  warn?(message: string): void;
  recording?: {
    tempRoot?: string;
    createRecorder?: BrowserWebmRecorderFactory;
    now?: () => number;
  };
}
// Desktop zoom 的布局补偿只在 renderer 完成；metrics 是 per-session 状态，命令空闲 detach
// 后会被清掉，若在这里带 scale，空闲时页面会退回另一套布局，操作期间变大、空闲变回。
function buildViewportMetricsOverride(viewport: BrowserViewportSize): Record<string, unknown> {
  return {
    width: viewport.width,
    height: viewport.height,
    // CDP 默认会让 DPR=1 的页面指标同时接管 visible size，Retina 上因此只分配
    // 1x native surface，虽然 DOM bounds 正确，网页却只覆盖 frame 左上角。visible surface
    // 应继续由 Electron <webview> 的实际 bounds 管理，CDP 只负责 CSS viewport 与截图 DPR。
    deviceScaleFactor: 1,
    mobile: false,
    dontSetVisibleSize: true,
  };
}

function sessionScopeKey(context: InternalExecutionContext): string {
  if (context.legacy) return "legacy";
  return [
    context.browserId,
    String(context.browserGeneration),
    String(context.windowId),
    context.workspaceKey,
    context.remoteSessionId ?? "",
    context.sessionId,
    context.clientMode,
  ].join("\u0000");
}

// 会话只读视图与实例控制权是两个边界；不能放宽 sameScope 来让 Host 读取 ambient。
function scopeKey(context: InternalExecutionContext): string {
  return context.legacy
    ? "legacy"
    : `${sessionScopeKey(context)}\u0000${context.controlScopeId ?? ""}`;
}

/** tab 归属的 session 身份：不含 browserId / generation，释放回 user-tab 集合的 tab 仍然匹配。 */
function ownedBySession(
  owner: InternalExecutionContext,
  context: InternalExecutionContext,
): boolean {
  return (
    owner.windowId === context.windowId &&
    owner.workspaceKey === context.workspaceKey &&
    (owner.remoteSessionId ?? "") === (context.remoteSessionId ?? "") &&
    owner.sessionId === context.sessionId
  );
}

function sameScope(left: InternalExecutionContext, right: InternalExecutionContext): boolean {
  return (left.legacy === true && right.legacy === true) || scopeKey(left) === scopeKey(right);
}

function normalizeLegacyContext(defaultKey: string): InternalExecutionContext {
  return {
    requestId: `legacy:${randomUUID()}`,
    browserId: "legacy-iab",
    browserGeneration: 0,
    windowId: 0,
    workspaceKey: defaultKey,
    sessionId: defaultKey,
    clientMode: "desktop-continuous",
    legacy: true,
  };
}

function suspendAckKey(tabId: string, generation: number): string {
  return `${tabId}\u0000${generation}`;
}

function toRestoredShell(
  record: BrowserTabShellRecord,
  owner: InternalExecutionContext,
): BrowserViewRestoredTabShell {
  return {
    tabId: record.tabId,
    workspaceKey: record.workspaceKey,
    ...(record.remoteSessionId ? { remoteSessionId: record.remoteSessionId } : {}),
    sessionId: record.sessionId,
    browserId: owner.browserId,
    browserGeneration: owner.browserGeneration,
    origin: record.origin,
    restoreUrl: record.restoreUrl,
    title: record.title,
    faviconUrl: record.faviconUrl,
    openedAt: record.openedAt,
    lastSelectedAt: record.lastSelectedAt,
  };
}

function isSideEffecting(command: BrowserCommand): boolean {
  if (command.method === "playwright" && command.action.name === "locator") {
    return [
      "click",
      "dblclick",
      "downloadMedia",
      "fill",
      "press",
      "selectOption",
      "setChecked",
    ].includes(command.action.operation);
  }
  if (command.method === "playwright" && command.action.name === "evaluate") return true;
  return [
    "navigate",
    "back",
    "forward",
    "reload",
    "click",
    "fill",
    "type",
    "press",
    "cuaKeypress",
    "scroll",
    "cuaScroll",
    "domCuaScroll",
    "hover",
    "select",
    "check",
    "drag",
    "cuaDrag",
    "recordingStart",
    "recordingCancel",
    "handleDialog",
    "close",
    "evaluate",
    "finalize",
    "finalizeTabs",
    "claimTab",
    "activateTab",
    "markDeliverable",
    "markHandoff",
    "newTab",
  ].includes(command.method);
}

/**
 * IAB guest registry。生产路径严格按 BrowserGuestExecutionContext 隔离；string 入参只保留给
 * 旧 renderer/单测兼容，不能由新调用方使用。
 */
function safeNumber(read: () => number | undefined): number | undefined {
  try {
    const value = read();
    return typeof value === "number" ? value : undefined;
  } catch {
    // guest 已销毁时访问 id 会抛错；资源管理器只需跳过该 tab。
    return undefined;
  }
}

export class BrowserGuestManager {
  // 资源身份属于窗口内的 Main owner，不能随 Host 的转发桥重建。
  private readonly backendIdentities = new Map<number, { id: string; generation: number }>();
  private readonly controlScopes = new Map<
    string,
    {
      context: InternalExecutionContext;
      closed: boolean;
      released: boolean;
      pending: Set<Promise<void>>;
      closing?: Promise<BrowserCommandResult>;
    }
  >();

  getBackendIdentity(windowId: number): { id: string; generation: number } {
    let identity = this.backendIdentities.get(windowId);
    if (!identity) {
      identity = { id: `iab:${randomUUID()}`, generation: 1 };
      this.backendIdentities.set(windowId, identity);
    }
    return { ...identity };
  }

  private async releaseControlScope(
    context: InternalExecutionContext,
    closeTabs: boolean,
  ): Promise<BrowserCommandResult> {
    const id = context.controlScopeId!;
    let scope = this.controlScopes.get(id);
    const result = (state: "released" | "absent"): BrowserCommandResult => ({
      ok: true,
      elapsedMs: 0,
      scope: { id, state },
    });
    if (!scope) {
      // 即使 open 的请求还在路上，也先留下关闭屏障，禁止迟到 open 复活资源。
      this.controlScopes.set(id, { context, closed: true, released: true, pending: new Set() });
      return result("absent");
    }
    if (!sameScope(scope.context, context))
      return {
        ok: false,
        elapsedMs: 0,
        error: {
          code: "execution_error",
          message: "Browser scope identity mismatch",
          sideEffect: "none",
        },
      };
    if (scope.released) return result("released");
    scope.closed = true;
    const current = scope;
    current.closing ??= (async () => {
      this.abortRecordings((entry) => sameScope(entry.context, context), "scope released");
      for (const request of this.runningRequests.values()) {
        if (sameScope(request.context, context))
          request.controller.abort(new DOMException("scope released", "AbortError"));
      }
      await Promise.all(current.pending);
      // recordingStart 返回的是后台 job；命令完成不能代表录制 surface 已释放。
      await Promise.all(
        [...this.recordings.values()]
          .filter((entry) => sameScope(entry.context, context))
          .map((entry) => entry.completion),
      );
      // 等已准入命令真正落地后再释放 tab，避免它们在关闭后创建或重新绑定资源。
      await Promise.all(
        [...this.tabs.values()]
          .filter((tab) => tab.owner.controlScopeId === id && ownedBySession(tab.owner, context))
          .map((tab) => this.releaseGuestCdpAfterIdle(tab, "scope released", true)),
      );
      this.closeSession(context);
      if (closeTabs) await this.closeSessionTabs(context);
      current.released = true;
      return result("released");
    })().catch((error) => {
      current.closing = undefined;
      throw error;
    });
    return current.closing;
  }

  private readonly tabs = new Map<string, ManagedTab>();

  /** 资源管理器：当前仍活着的浏览器 guest webContents id，用于把其 renderer 归到内置插件 browser-use */
  listGuestWebContentsIds(): number[] {
    const ids: number[] = [];
    for (const tab of this.tabs.values()) {
      if (tab.lifecycle === "closed" || !tab.guest) continue;
      const id = safeNumber(() => tab.guest?.id);
      if (id !== undefined) ids.push(id);
    }
    return ids;
  }
  /** close 后只保留 opaque id tombstone，拒绝迟到的 renderer attach，不保留 owner/guest。 */
  private readonly closedTabIds = new Set<string>();
  private readonly activeTabByScope = new Map<string, string>();
  private readonly defaultTabByScope = new Map<string, string>();
  private readonly waiters = new Map<string, PendingWaiter[]>();
  private readonly pendingDialogs = new Map<string, BrowserDialog>();
  private readonly runningRequests = new Map<string, RunningRequest>();
  /**
   * CDP Page.captureScreenshot 没有单请求取消 API。外层 timeout/cancel 后 promise 可能仍在
   * Chromium 内执行。请求 abort/deadline 即刻
   * settle 并释放屏障，允许同 tab 立即重试——重叠是瞬态且自排空的：下一次截图的透明
   * presentation 会恢复产帧，旧的挂起 capture 随之落定；结果按各自 promise 链归属，迟到
   * 结果不会误挂到新请求（clearTrackedScreenshot 以 entry identity 幂等）。旧的“保留屏障
   * 直到真实 settle”会把永不落定的挂起请求变成该 tab 的截图死锁（生产实测 pendingMs
   * 120s+），已被废弃。堆积风险由 abandonedScreenshotCaptures 的硬上限兜底。
   */
  private readonly inFlightScreenshots = new Map<string, InFlightScreenshot>();
  /** 见 MAX_ABANDONED_SCREENSHOT_CAPTURES；key 为 tabId。 */
  private readonly abandonedScreenshotCaptures = new Map<string, number>();
  private readonly recordings = new Map<string, BrowserRecordingEntry>();
  private readonly downloads = new Map<string, DownloadRecord>();
  private readonly queuedDownloads = new Map<string, string[]>();
  private readonly downloadWaiters = new Map<string, DownloadWaiter[]>();
  private readonly sessionNames = new Map<string, string>();
  private readonly visibilityByScope = new Map<string, boolean>();
  private readonly naturalViewportByWindow = new Map<number, BrowserViewportSize>();
  private readonly residencyCoordinator: BrowserTabResidencyCoordinator;
  private readonly suspendAckWaiters = new Map<string, () => void>();
  private readonly suspendFlights = new Map<string, Promise<void>>();
  private readonly restoreFlights = new Map<string, Promise<GuestWebContents | null>>();
  /** guest 被销毁后重绑时，替代 guest 必须先完成原页面恢复再接收新的 browser 命令。 */
  private readonly guestRecoveryFlights = new Map<string, Promise<GuestWebContents | null>>();
  /** 同一 tab 的 attach/rebind 只允许一个 flight，避免并发命令各自重建 webview。 */
  private readonly guestAttachFlights = new Map<string, Promise<GuestWebContents | null>>();
  private readonly restoredTabClaims = new Map<string, number>();

  constructor(
    private readonly log?: (msg: string) => void,
    private readonly attachTimeoutMs: number = DEFAULT_ATTACH_TIMEOUT_MS,
    private readonly onCloseTabRequested?: (
      tabId: string,
      owner?: BrowserGuestExecutionContext,
    ) => void,
    private readonly onOpenTabRequested?: (
      tabId: string,
      owner: BrowserGuestExecutionContext,
    ) => void,
    private readonly onVisibilityChanged?: (
      visible: boolean,
      owner: BrowserGuestExecutionContext,
      tabId?: string,
    ) => void,
    private readonly onViewportChanged?: (
      viewport: BrowserViewportSize | null,
      owner: BrowserGuestExecutionContext,
      tabId: string,
    ) => void,
    // 第七位已被 screenshot CSS 像素归一化使用；新门禁依赖只能追加，避免打破已有 main/test 调用。
    private readonly resizeScreenshotToCssPixels?: ControlledView["resizeScreenshotToCssPixels"],
    private readonly screenshotSurfaceCoordinator?: BrowserScreenshotSurfaceCoordinator,
    private readonly residencyOptions: BrowserGuestManagerResidencyOptions = {},
    // 隐藏窗口截图的透明 presentation 依赖 owner BrowserWindow；测试注入替身，生产由
    // index.ts 接 BrowserWindow.fromId。不注入时该能力整体禁用，行为与旧版一致。
    private readonly resolveOwnerWindow?: (
      windowId: number,
    ) => BrowserWindowForTransparentBootstrap | null,
    // CDP 命令流空闲多久后主动释放（detach）。guest renderer 被
    // Chromium 杀且 render-process-gone 未送达 main 时，destroyed 直达 + CDP attached 即
    // 主进程 UAF；turn 内命令间隙（0.4~9s）是实测崩溃窗口，命令级 idle 释放将其收窄。
    private readonly cdpIdleReleaseMs: number = DEFAULT_GUEST_CDP_IDLE_RELEASE_MS,
  ) {
    this.residencyCoordinator = new BrowserTabResidencyCoordinator({
      tabLimit: residencyOptions.tabLimit,
      now: residencyOptions.now,
      onEvict: (record) => this.closeTabForLimit(record),
    });
  }

  attachGuest(
    tabId: string,
    webContentsId: number,
    options?: {
      active?: boolean;
      windowId?: number;
      workspaceKey?: string;
      remoteSessionId?: string;
      sessionId?: string;
      residencyGeneration?: number;
    },
  ): BrowserGuestAttachResult {
    let tab = this.tabs.get(tabId);
    const guest = webContents.fromId(webContentsId) as GuestWebContents | undefined;
    if (!guest || guest.isDestroyed()) {
      const recoveryRequested =
        tab && tab.lifecycle !== "closed"
          ? this.requestGuestRebind(tab, guest ? "destroyed" : "not-found")
          : false;
      this.log?.(
        `[browser-use] attachGuest skip tabId=${tabId} id=${webContentsId} reason=${guest ? "destroyed" : "not-found"}`,
      );
      return {
        ok: false,
        reason: guest ? "destroyed" : "not-found",
        recoveryRequested,
      };
    }
    if (guest.getType() !== "webview") {
      // fromId 接受进程内任意 WebContents id；若 renderer 误传主窗口 id，后续
      // CDP/Runtime 输入会直接操作 ZCode composer。IAB 只允许真实 <webview> guest fail closed。
      this.log?.(
        `[browser-use] attachGuest rejected tabId=${tabId} id=${webContentsId} reason=not-webview type=${guest.getType()}`,
      );
      return { ok: false, reason: "not-webview", recoveryRequested: false };
    }

    if (this.closedTabIds.has(tabId)) {
      this.log?.(`[browser-use] attachGuest rejected tabId=${tabId} reason=closed`);
      return { ok: false, reason: "closed", recoveryRequested: false };
    }
    // 兼容旧 renderer：未经历 create request 的 key 只进入 legacy scope。
    if (!tab) {
      const owner = options?.workspaceKey
        ? {
            requestId: `unclaimed:${randomUUID()}`,
            browserId: "unclaimed-iab",
            browserGeneration: 0,
            windowId: options.windowId ?? 0,
            workspaceKey: options.workspaceKey,
            // human tab 原来只按 workspace 登记为全局 unclaimed，任意新对话都能
            // 从 user.openTabs() 枚举并接管。ownerTaskId 现在随 attach 冻结；旧 renderer
            // 未传 sessionId 时保留不可认领哨兵，宁可隐藏也不能跨对话泄漏。
            sessionId: options.sessionId?.trim() || BROWSER_VIEW_DRAFT_SESSION_ID,
            ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
            clientMode: "desktop-continuous" as const,
          }
        : normalizeLegacyContext(tabId);
      if (options?.windowId !== undefined) owner.windowId = options.windowId;
      tab = {
        tabId,
        owner,
        cdpAttached: false,
        guestLifecycle: "detached",
        pendingCdpCommands: 0,
        guestGeneration: 0,
        hasAttachedGuest: false,
        rebindRequested: false,
        lifecycle: "active",
        origin: options?.workspaceKey ? "user" : "agent",
        claimable: Boolean(options?.workspaceKey && options.sessionId?.trim()),
        ...(options?.workspaceKey ? { userOwner: { ...owner } } : {}),
        active: false,
        loading: false,
        mediaActive: false,
        cachedUrl: "",
        cachedTitle: "",
        cachedFaviconUrl: null,
        openedAt: this.now(),
      };
      this.tabs.set(tabId, tab);
      this.registerTabResidency(tab, options?.active === true);
    }
    if (tab.lifecycle === "closed") {
      this.log?.(`[browser-use] attachGuest rejected tabId=${tabId} reason=closed`);
      return { ok: false, reason: "closed", recoveryRequested: false };
    }
    if (options?.windowId !== undefined && tab.owner.windowId !== options.windowId) {
      this.log?.(
        `[browser-use] attachGuest rejected tabId=${tabId} reason=window-mismatch expected=${tab.owner.windowId} actual=${options.windowId}`,
      );
      return { ok: false, reason: "window-mismatch", recoveryRequested: false };
    }
    if (options?.workspaceKey && tab.owner.workspaceKey !== options.workspaceKey) {
      this.log?.(`[browser-use] attachGuest rejected tabId=${tabId} reason=workspace-mismatch`);
      return this.rejectGuestAttach(tab, guest, "workspace-mismatch");
    }
    if (options?.sessionId && tab.owner.sessionId !== options.sessionId) {
      // renderer 的迟到 dom-ready 不能用另一个对话的 ownership 复用既有 tabId。
      // window/workspace 相同也必须拒绝，避免 guest 被跨对话替换后绕过 openTabs 隔离。
      this.log?.(`[browser-use] attachGuest rejected tabId=${tabId} reason=session-mismatch`);
      return this.rejectGuestAttach(tab, guest, "session-mismatch");
    }
    if ((tab.owner.remoteSessionId ?? "") !== (options?.remoteSessionId ?? "")) {
      // remote owner 过去只在 renderer 主动提供 remoteSessionId 时校验，缺失值会
      // fail-open；远程重连后的旧 tab 因而可能被新 runtime attach。
      this.log?.(
        `[browser-use] attachGuest rejected tabId=${tabId} reason=remote-session-mismatch`,
      );
      return this.rejectGuestAttach(tab, guest, "remote-session-mismatch");
    }

    const residency = this.residencyCoordinator.get(tabId);
    const rejectsNewGuest =
      tab.guest !== guest &&
      (residency?.residency === "suspended" || residency?.residency === "suspend-pending");
    if (rejectsNewGuest) {
      // 恢复 timeout 已回滚后，旧 generation 的迟到 guest 原来仍会绕过 restoring
      // 校验并重新占用 tab。suspended/pending 只允许当前旧 guest 重复上报，不接受新 attach。
      this.log?.(
        `[browser-use] attachGuest rejected tabId=${tabId} reason=residency-${residency.residency}`,
      );
      this.closeGuestWebContents(tab, guest);
      return {
        ok: false,
        reason: "residency-suspended",
        recoveryRequested: false,
      };
    }
    if (
      residency?.residency === "restoring" &&
      !this.residencyCoordinator.markAttached(
        tabId,
        options?.active === true,
        options?.residencyGeneration,
      )
    ) {
      this.log?.(
        `[browser-use] attachGuest rejected tabId=${tabId} reason=residency-generation-mismatch expected=${residency.generation} actual=${options?.residencyGeneration ?? "missing"}`,
      );
      this.closeGuestWebContents(tab, guest);
      return {
        ok: false,
        reason: "residency-generation-mismatch",
        recoveryRequested: false,
      };
    }
    const isSameGuest = tab.guest === guest;
    if (residency?.residency === "restoring") {
      // 恢复态 src 使用不会提交 document 的延迟 protocol；scope/generation 校验通过后
      // 终止 provisional request，确保 restoreGuestState 创建唯一首次有效导航。
      try {
        guest.stop();
      } catch (error) {
        this.warn(`browser tab provisional navigation stop failed tabId=${tabId}`, error);
      }
    }
    if (tab.guest && !isSameGuest) this.detachGuest(tab);
    if (!isSameGuest) this.guestRecoveryFlights.delete(tab.tabId);

    // detachGuest 会从仍存活的旧 guest 读取最后 URL；恢复判定必须放在它之后，避免 renderer
    // 尚未来得及上报 residency 时，把刚刚发生过的导航误判成没有可恢复事实。
    const rebindReason = tab.attachFailure;
    const shouldRestoreAfterRebind =
      tab.hasAttachedGuest &&
      !isSameGuest &&
      rebindReason !== undefined &&
      rebindReason !== "residency-suspended" &&
      rebindReason !== "residency-generation-mismatch" &&
      tab.cachedUrl.trim() !== "" &&
      tab.cachedUrl !== "about:blank";

    let cdpAttached = false;
    try {
      if (!guest.debugger.isAttached()) guest.debugger.attach("1.3");
      cdpAttached = guest.debugger.isAttached();
    } catch {
      cdpAttached = safeBool(() => guest.debugger.isAttached(), false);
    }
    tab.guest = guest;
    this.applyGuestAudioMuted(tab);
    tab.cdpAttached = cdpAttached;
    tab.guestLifecycle = "attached";
    tab.guestTeardownFlight = undefined;
    if (!isSameGuest) tab.guestGeneration += 1;
    tab.hasAttachedGuest = true;
    tab.attachFailure = undefined;
    tab.rebindRequested = false;
    if (cdpAttached) this.scheduleGuestCdpIdleRelease(tab);
    // 恢复期新 guest 的初始 URL 是 about:blank。若在 pageState/restoreUrl 消费前
    // 覆盖 logical cache，损坏快照会错误降级到空白页，三类事实全缺失的 orphan 也无法识别。
    if (residency?.residency !== "restoring" && !shouldRestoreAfterRebind) {
      tab.cachedUrl = safeStr(() => guest.getURL(), tab.cachedUrl);
      tab.cachedTitle = safeStr(() => guest.getTitle(), tab.cachedTitle);
    }
    if (options?.active === true) {
      tab.active = true;
      if (!tab.claimable) this.selectTab(tab, false);
      this.restoreNaturalViewportAfterBackground(tab);
    } else if (options?.active === false) {
      tab.active = false;
      this.residencyCoordinator.report(tab.tabId, {
        selected: false,
        visible: false,
      });
      if (this.activeTabByScope.get(scopeKey(tab.owner)) === tabId) {
        this.activeTabByScope.delete(scopeKey(tab.owner));
      }
    }
    this.log?.(
      `[browser-use] attachGuest tabId=${tabId} windowId=${tab.owner.windowId} cdp=${cdpAttached}`,
    );

    guest.once("destroyed", () => {
      const current = this.tabs.get(tabId);
      if (current?.guest === guest) {
        this.detachGuest(current);
        this.requestGuestRebind(current, "guest-destroyed");
      }
    });
    // 放在其余接线之前：后面几个 setup 在 guest 已销毁时可能同步抛错并跳过剩余接线，
    // 而这是唯一能关闭 UAF 窗口的监听，不该被别的接线牵连。
    if (!isSameGuest) this.setupCdpCrashGuard(tab, guest);
    if (!isSameGuest) this.setupDialogTracking(tab, guest);
    if (!isSameGuest) this.setupDownloadTracking(tab, guest);
    if (!isSameGuest) this.setupActivityTracking(tab, guest);
    if (!isSameGuest) this.applyViewportOverride(tab);
    if (tab.viewportOverride) {
      // Agent 可能在 renderer 完成自动打开前就发出 viewport 事件；guest attach 后重放一次，
      // 保证刚挂载的自由尺寸 UI 不会漏掉 main → renderer 的一次性同步。
      this.onViewportChanged?.({ ...tab.viewportOverride }, tab.owner, tab.tabId);
    }
    if (options?.active !== false && this.visibilityByScope.get(scopeKey(tab.owner)) === true) {
      // visibilityByScope 表示整个 browser scope 可见，不表示本次 attach 的 tab
      // 被选中。把 inactive guest 也回放为 visible=true 会让 renderer 在用户切换后
      // 又激活旧 tab；关闭后迟到的同类事件还会复活 tab shell。只有非 inactive attach 才能
      // 沿用 scope 可见性，显式选中仍由 selectTab/browserVisibilitySet 通知。
      this.onVisibilityChanged?.(true, tab.owner, tab.tabId);
    }
    if (shouldRestoreAfterRebind) {
      // guest-destroyed 只重放 Ready 时，新 guest 的初始 URL 是 about:blank；若直接
      // 将它标记为可用，renderer 又不会重新消费已应用过的 initialUrl，右侧面板就永久停在空白页。
      // 这里沿用已有 pageState → restoreUrl 恢复逻辑，并以 tab 级 flight 串住后续命令。
      const recoveryFlight = this.restoreReboundGuest(tab, guest);
      this.guestRecoveryFlights.set(tab.tabId, recoveryFlight);
      const clearRecoveryFlight = () => {
        if (this.guestRecoveryFlights.get(tab.tabId) === recoveryFlight) {
          this.guestRecoveryFlights.delete(tab.tabId);
        }
      };
      void recoveryFlight.then(clearRecoveryFlight, clearRecoveryFlight);
    }
    this.resolveWaiters(tabId, guest);
    if (residency?.residency !== "restoring") {
      this.residencyCoordinator.markAttached(tabId, options?.active === true);
    }
    void this.persistShell(tab);
    return { ok: true, guestGeneration: tab.guestGeneration };
  }

  /** Renderer 自由尺寸交互回写；发送方窗口由 IPC 层绑定，不能跨窗口修改其它 tab。 */
  async updateViewportFromRenderer(
    tabId: string,
    viewport: BrowserViewportSize | null,
    windowId: number,
  ): Promise<void> {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.lifecycle === "closed" || tab.owner.windowId !== windowId) {
      throw new Error(`browser tab '${tabId}' is unavailable for viewport update`);
    }
    if (viewport) {
      assertViewportOverride(viewport);
      await this.setTabViewport(tab, viewport);
      return;
    }
    await this.resetTabViewport(tab);
  }

  getTabOwner(tabId: string): BrowserGuestExecutionContext | null {
    const owner = this.tabs.get(tabId)?.owner;
    return owner ? { ...owner } : null;
  }

  /** 根据 guest WebContents 反查受控 tab，供 webview popup 事件保留原始 session scope。 */
  getTabOwnerByWebContentsId(
    webContentsId: number,
  ): (BrowserGuestExecutionContext & { tabId: string }) | null {
    for (const tab of this.tabs.values()) {
      if (tab.guest?.id === webContentsId && tab.lifecycle !== "closed") {
        return { ...tab.owner, tabId: tab.tabId };
      }
    }
    return null;
  }

  async reportResidency(
    payload: BrowserViewResidencyReportPayload & { windowId: number },
  ): Promise<void> {
    const tab = this.requireRendererOwnedTab(payload);
    tab.cachedUrl = payload.restoreUrl?.trim() || tab.cachedUrl;
    if (payload.title !== undefined) tab.cachedTitle = payload.title ?? "";
    if (payload.faviconUrl !== undefined) tab.cachedFaviconUrl = payload.faviconUrl;
    tab.loading = payload.loading;
    tab.currentTask = payload.currentTask;
    this.applyGuestAudioMuted(tab);
    this.residencyCoordinator.report(tab.tabId, {
      selected: payload.selected,
      visible: payload.visible,
      currentTask: payload.currentTask,
      loading: payload.loading,
      audible: safeBool(() => tab.guest?.isCurrentlyAudible?.() ?? false, false),
      mediaActive: tab.mediaActive,
      operationActive: this.hasRunningRequestForTab(tab.tabId),
      captureActive: this.isTabCaptureActive(tab),
      downloadActive: this.hasPendingDownloadForTab(tab.tabId),
    });
    if (payload.selected) {
      tab.active = true;
      if (!tab.claimable) this.selectTab(tab, false);
      // renderer 前台上报是用户真实在看的信号（面板展开/切 tab），与 claimable 无关，
      // 必须独立于 selectTab 触发恢复。
      this.maybeRestoreBackgroundViewport(tab);
    } else {
      tab.active = false;
      const key = scopeKey(tab.owner);
      if (this.activeTabByScope.get(key) === tab.tabId) this.activeTabByScope.delete(key);
    }
    await this.persistShell(tab);
    await this.residencyCoordinator.whenIdle();
  }

  /** 只有当前对话的 tab 出声；后台保活的 guest 静音。新 guest（含 rebind）沿用最近上报值。 */
  private applyGuestAudioMuted(tab: ManagedTab): void {
    if (tab.currentTask === undefined) return;
    const muted = !tab.currentTask;
    try {
      tab.guest?.setAudioMuted?.(muted);
    } catch {
      // guest 已销毁时下一次 attach 会重新应用。
    }
  }

  /**
   * 草稿首发升级：草稿 human tab 的 owner 在 attach 时冻结为 unscoped，renderer 迁移归属后
   * 若不同步升级，后续 attach/residency/close 都会 session-mismatch，tab 关不掉、AI 也认领不到。
   * 只接受同窗口、同工作区、同远端连接、仍属草稿的用户 tab；改写同步完成，保证同一 frame
   * 随后的 IPC 看到新 owner。
   */
  promoteDraftTabs(payload: BrowserViewPromoteDraftTabsRequest & { windowId: number }): string[] {
    const promoted: string[] = [];
    for (const tabId of payload.tabIds) {
      const tab = this.tabs.get(tabId);
      if (
        !tab ||
        tab.lifecycle === "closed" ||
        !this.isUserOwnedTab(tab) ||
        tab.owner.sessionId !== BROWSER_VIEW_DRAFT_SESSION_ID ||
        tab.owner.windowId !== payload.windowId ||
        tab.owner.workspaceKey !== payload.workspaceKey ||
        (tab.owner.remoteSessionId ?? "") !== (payload.remoteSessionId ?? "")
      ) {
        continue;
      }
      const previousKey = scopeKey(tab.owner);
      const owner = { ...tab.owner, sessionId: payload.sessionId };
      tab.owner = owner;
      tab.userOwner = { ...owner };
      const nextKey = scopeKey(owner);
      if (this.activeTabByScope.get(previousKey) === tabId) {
        this.activeTabByScope.delete(previousKey);
        this.activeTabByScope.set(nextKey, tabId);
      }
      if (this.defaultTabByScope.get(previousKey) === tabId) {
        this.defaultTabByScope.delete(previousKey);
        this.defaultTabByScope.set(nextKey, tabId);
      }
      this.residencyCoordinator.rekeySession(tabId, payload.sessionId);
      void this.persistShell(tab);
      promoted.push(tabId);
      this.log?.(
        `[browser-use] promote draft tab tabId=${tabId} windowId=${payload.windowId} sessionId=${payload.sessionId}`,
      );
    }
    return promoted;
  }

  acknowledgeSuspend(payload: { tabId: string; generation: number; windowId: number }): void {
    const tab = this.tabs.get(payload.tabId);
    if (!tab || tab.owner.windowId !== payload.windowId) return;
    const key = suspendAckKey(payload.tabId, payload.generation);
    this.suspendAckWaiters.get(key)?.();
  }

  async closeTabFromRenderer(
    payload: BrowserViewCloseTabRequest & { windowId: number },
  ): Promise<void> {
    // Agent close 已把 logical tab 从 main 删除，而 BrowserViewCloseTab 通知可能落在
    // 非当前 workspace 被 renderer 丢弃，UI 侧仍留着壳。此时用户点 × 走到这里，直接抛
    // "unavailable for renderer scope"，renderer 拿不到授权就永不移除 UI —— tab 永远关不掉。
    // main 已经没有这个 logical tab，renderer 想收敛自己的壳是安全且必要的：幂等放行，
    // 同时补上 tombstone，阻止迟到 attach 把它复活。scope 校验只对仍存活的 tab 生效，
    // 跨 window/workspace 越权关闭他人 tab 仍然被拒绝。
    const existing = this.tabs.get(payload.tabId);
    if (!existing || existing.lifecycle === "closed") {
      this.closedTabIds.add(payload.tabId);
      return;
    }
    // close 是收敛意图：remoteSessionId 的防重连语义只属于 attach（见 attachGuest 的
    // remote-session-mismatch）。attach 侧 renderer 对该字段有 workspaceRemoteSessionId 兜底、
    // close 侧没有，严格比对会让远程 human tab 永远关不掉。renderer 关闭自己看得见的 tab 不构成
    // 越权，window/workspace/session 三项仍严格校验，跨作用域越权关闭照旧拒绝。
    const tab = this.requireRendererOwnedTab(payload, { skipRemoteSession: true });
    await this.closeTabDurably(tab, false);
  }

  async whenRecoveryIdle(): Promise<void> {
    await this.residencyOptions.recoveryStore?.whenIdle?.();
  }

  async ensureResidentFromRenderer(
    payload: BrowserViewCloseTabRequest & { windowId: number },
  ): Promise<void> {
    const tab = this.requireRendererOwnedTab(payload);
    const guest = await this.ensureGuest(tab, new AbortController().signal);
    if (!guest) throw new Error(`browser tab '${tab.tabId}' restore failed`);
  }

  async restoreTabs(payload: {
    windowId: number;
    workspaceKey: string;
    remoteSessionId?: string;
    sessionId?: string;
  }): Promise<BrowserViewRestoredTabShell[]> {
    const records =
      (await this.residencyOptions.recoveryStore?.listShells({
        workspaceKey: payload.workspaceKey,
        ...(payload.remoteSessionId ? { remoteSessionId: payload.remoteSessionId } : {}),
        ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
      })) ?? [];
    this.log?.(
      `[browser-use] restoreTabs windowId=${payload.windowId} workspaceKey=${payload.workspaceKey} remoteSessionId=${payload.remoteSessionId ?? "<local>"} sessionId=${payload.sessionId ?? "<all>"} records=${records.length}`,
    );
    const restored: BrowserViewRestoredTabShell[] = [];
    for (const record of records) {
      if (this.closedTabIds.has(record.tabId)) continue;
      const claimedWindowId = this.restoredTabClaims.get(record.tabId);
      if (claimedWindowId !== undefined && claimedWindowId !== payload.windowId) continue;
      this.restoredTabClaims.set(record.tabId, payload.windowId);

      let tab = this.tabs.get(record.tabId);
      if (!tab) {
        const owner: InternalExecutionContext = {
          requestId: `restore:${randomUUID()}`,
          browserId:
            record.browserId ?? (record.origin === "user" ? "unclaimed-iab" : "restored-iab"),
          browserGeneration: record.browserGeneration ?? 0,
          windowId: payload.windowId,
          workspaceKey: record.workspaceKey,
          ...(record.remoteSessionId ? { remoteSessionId: record.remoteSessionId } : {}),
          sessionId: record.sessionId,
          clientMode: "desktop-continuous",
        };
        tab = {
          tabId: record.tabId,
          owner,
          cdpAttached: false,
          guestLifecycle: "detached",
          pendingCdpCommands: 0,
          guestGeneration: 0,
          hasAttachedGuest: false,
          rebindRequested: false,
          lifecycle: record.lifecycle,
          origin: record.origin,
          claimable: record.origin === "user",
          ...(record.origin === "user" ? { userOwner: { ...owner } } : {}),
          active: false,
          ...(record.viewport ? { viewportOverride: { ...record.viewport } } : {}),
          loading: false,
          mediaActive: false,
          cachedUrl: record.restoreUrl ?? "",
          cachedTitle: record.title ?? "",
          cachedFaviconUrl: record.faviconUrl,
          openedAt: record.openedAt,
          restoredFromStore: true,
        };
        this.tabs.set(record.tabId, tab);
        this.registerTabResidency(tab, false, "suspended", record.lastSelectedAt);
      } else if (tab.owner.windowId !== payload.windowId) {
        continue;
      }
      restored.push(toRestoredShell(record, tab.owner));
    }
    return restored;
  }

  async execute(
    contextOrKey: BrowserGuestExecutionContext | string,
    command: BrowserCommand,
    signal?: AbortSignal,
  ): Promise<BrowserCommandResult> {
    const context: InternalExecutionContext =
      typeof contextOrKey === "string" ? normalizeLegacyContext(contextOrKey) : contextOrKey;
    this.log?.(
      `[browser-use] execute requestId=${context.requestId} browserId=${context.browserId} generation=${context.browserGeneration} windowId=${context.windowId} sessionId=${context.sessionId} method=${command.method}`,
    );

    if (
      command.method === "openScope" ||
      command.method === "releaseScope" ||
      context.controlScopeId
    ) {
      const id = context.controlScopeId;
      const reject = (message: string): BrowserCommandResult => ({
        ok: false,
        elapsedMs: 0,
        ...(command.method === "openScope" && id
          ? { scope: { id, state: "rejected" as const } }
          : {}),
        error: { code: "backend_unavailable", message, sideEffect: "none" },
      });
      if (!id) return reject("Browser control scope is required");
      if (command.method === "releaseScope")
        return this.releaseControlScope(context, command.closeTabs === true);
      const scope = this.controlScopes.get(id);
      if (scope && (!sameScope(scope.context, context) || scope.closed))
        return reject("Browser control scope is closed or belongs to another owner");
      if (command.method === "openScope") {
        const owner = this.getBackendIdentity(context.windowId);
        if (context.browserId !== owner.id || context.browserGeneration !== owner.generation)
          return reject("Browser resource owner is no longer available");
        this.controlScopes.set(
          id,
          scope ?? { context, closed: false, released: false, pending: new Set() },
        );
        return { ok: true, elapsedMs: 0, scope: { id, state: "open" } };
      }
      if (!scope) return reject("Browser control scope was not opened");
    }

    if (!context.controlScopeId && !context.legacy && context.browserId !== "legacy-iab") {
      // 身份校验从 Host 移到资源 owner，兼容请求也不能因桥重连而绕过代次校验。
      const owner = this.getBackendIdentity(context.windowId);
      if (context.browserId !== owner.id || context.browserGeneration !== owner.generation)
        return {
          ok: false,
          elapsedMs: 0,
          error: {
            code: "backend_unavailable",
            message: "Browser resource owner is no longer available",
            sideEffect: "none",
          },
        };
    }

    if (this.runningRequests.has(context.requestId)) {
      // requestId 是取消与 lifecycle cleanup 的 correlation key。同 key 覆盖会让
      // 取消命中错误 scope，且旧 finally 会删除仍在执行的新 entry。重复请求必须在下发前失败。
      return this.withMeta(
        {
          ok: false,
          error: {
            code: "duplicate_request_id",
            message: `browser requestId '${context.requestId}' is already running`,
            sideEffect: "none",
          },
          elapsedMs: 0,
        },
        context,
      );
    }

    if (command.method === "cancelRequest") {
      const cancelled = this.abortRequest(command.requestId, context);
      return this.withMeta({ ok: true, value: { cancelled }, elapsedMs: 0 }, context);
    }
    if (command.method === "turnEnded") {
      this.endTurn(context, command.turnId ?? context.turnId);
      return this.withMeta({ ok: true, elapsedMs: 0 }, context);
    }
    if (command.method === "closeSession") {
      this.closeSession(context);
      if (command.closeTabs === true) await this.closeSessionTabs(context);
      return this.withMeta({ ok: true, elapsedMs: 0 }, context);
    }

    const controller = new AbortController();
    const unlink = linkAbortSignal(signal, controller);
    const running: RunningRequest = { context, controller, dispatched: false };
    this.runningRequests.set(context.requestId, running);
    const scope = context.controlScopeId
      ? this.controlScopes.get(context.controlScopeId)
      : undefined;
    const settled = Promise.withResolvers<void>();
    scope?.pending.add(settled.promise);
    try {
      return await this.executeInScope(context, command, running);
    } finally {
      unlink();
      scope?.pending.delete(settled.promise);
      settled.resolve();
      // 清理必须绑定 entry identity；即使未来其它入口误写同 key，旧请求也不能删除新状态。
      if (this.runningRequests.get(context.requestId) === running) {
        this.runningRequests.delete(context.requestId);
      }
      if (running.tabId) this.refreshRuntimeProtection(running.tabId);
    }
  }

  private async executeInScope(
    context: InternalExecutionContext,
    command: BrowserCommand,
    running: RunningRequest,
  ): Promise<BrowserCommandResult> {
    const startedAt = Date.now();
    if (running.controller.signal.aborted) {
      return this.cancelledResult(context, false, startedAt);
    }

    if (command.method === "list") {
      // Host 的 ambient 查询没有实例 ID，只读汇总同一会话路由；业务操作仍使用严格实例匹配。
      const tabs = await Promise.all(
        this.ownedTabs(context, !context.controlScopeId).map((tab) => this.summary(tab)),
      );
      return this.withMeta({ ok: true, tabs, elapsedMs: Date.now() - startedAt }, context);
    }

    if (command.method === "listUserTabs") {
      const userTabs = this.openUserTabs(context).map((tab) => this.userTabInfo(tab));
      return this.withMeta({ ok: true, userTabs, elapsedMs: Date.now() - startedAt }, context);
    }

    if (command.method === "nameSession") {
      this.sessionNames.set(scopeKey(context), command.name);
      return this.withMeta({ ok: true, elapsedMs: Date.now() - startedAt }, context);
    }

    if (command.method === "browserVisibilityGet") {
      return this.withMeta(
        {
          ok: true,
          value: this.visibilityByScope.get(scopeKey(context)) === true,
          elapsedMs: Date.now() - startedAt,
        },
        context,
      );
    }

    if (command.method === "browserVisibilitySet") {
      const key = scopeKey(context);
      this.visibilityByScope.set(key, command.visible);
      const active = this.activeTabByScope.get(key);
      const selected = active ? this.tabs.get(active) : this.ownedTabs(context).at(-1);
      this.onVisibilityChanged?.(command.visible, context, selected?.tabId);
      return this.withMeta({ ok: true, elapsedMs: Date.now() - startedAt }, context, selected);
    }

    if (command.method === "browserViewportSet") {
      const tab = this.resolveTab(context, command.tabId);
      if (!tab) return this.unavailableTabResult(context, command.tabId, startedAt);
      const viewport = { width: command.width, height: command.height };
      await this.setTabViewport(tab, viewport);
      this.selectTab(tab, true);
      this.onViewportChanged?.(viewport, tab.owner, tab.tabId);
      return this.withMeta({ ok: true, elapsedMs: Date.now() - startedAt }, context, tab);
    }

    if (command.method === "browserViewportReset") {
      const tab = this.resolveTab(context, command.tabId);
      if (!tab) return this.unavailableTabResult(context, command.tabId, startedAt);
      await this.resetTabViewport(tab);
      this.onViewportChanged?.(null, tab.owner, tab.tabId);
      return this.withMeta({ ok: true, elapsedMs: Date.now() - startedAt }, context, tab);
    }

    if (command.method === "recordingStatus" || command.method === "recordingCancel") {
      const entry = this.recordings.get(command.recordingId);
      if (!entry || !sameScope(entry.context, context)) {
        return this.withMeta(
          {
            ok: false,
            error: {
              code: "backend_unavailable",
              message: `browser recording '${command.recordingId}' is unavailable in this context`,
              sideEffect: "none",
            },
            elapsedMs: Date.now() - startedAt,
          },
          context,
        );
      }
      if ("tabId" in command && command.tabId && command.tabId !== entry.tabId) {
        return this.withMeta(
          {
            ok: false,
            error: {
              code: "backend_unavailable",
              message: `browser recording '${command.recordingId}' does not belong to tab '${command.tabId}'`,
              sideEffect: "none",
            },
            elapsedMs: Date.now() - startedAt,
          },
          context,
        );
      }
      if (command.method === "recordingCancel" && entry.status === "running") {
        entry.controller.abort(new DOMException("recording cancelled", "AbortError"));
        this.setRecordingTerminal(entry, "cancelled");
      }
      return this.withMeta(
        {
          ok: true,
          recording: this.snapshotRecording(entry),
          elapsedMs: Date.now() - startedAt,
        },
        context,
        this.tabs.get(entry.tabId),
      );
    }

    if (command.method === "activateTab") {
      const tab = this.tabs.get(command.tabId);
      if (!tab || tab.lifecycle === "closed" || !sameScope(tab.owner, context)) {
        return this.withMeta(
          {
            ok: false,
            error: {
              code: "backend_unavailable",
              message: `browser tab '${command.tabId}' is unavailable for activation. ${TAB_CONTEXT_RECOVERY_HINT}`,
            },
            elapsedMs: Date.now() - startedAt,
          },
          context,
        );
      }
      running.tabId = tab.tabId;
      this.refreshRuntimeProtection(tab.tabId);
      const guest = await this.ensureGuest(tab, running.controller.signal);
      if (!guest || safeBool(() => guest.isDestroyed(), true)) {
        return this.withMeta(
          {
            ok: false,
            error: {
              code: "backend_unavailable",
              message: `browser tab '${command.tabId}' could not be restored for activation`,
            },
            elapsedMs: Date.now() - startedAt,
          },
          context,
          tab,
        );
      }
      // 旧 tabs.get 只在 agent 内创建 Tab binding，renderer 仍可能展示另一个页面。
      // 激活必须先原子更新 main selected 状态，再通知 origin renderer；renderer 仅在该 scope
      // 正处前台时展开对应 view，后台对话只能记录激活态，不能抢用户当前会话。
      this.selectTab(tab, true);
      return this.withMeta(
        {
          ok: true,
          tab: await this.summary(tab),
          elapsedMs: Date.now() - startedAt,
        },
        context,
        tab,
      );
    }

    if (command.method === "claimTab") {
      const candidate = this.tabs.get(command.tabId);
      if (!candidate || !this.canClaimUserTab(candidate, context)) {
        return this.withMeta(
          {
            ok: false,
            error: {
              code: "backend_unavailable",
              message: `user browser tab '${command.tabId}' is unavailable or already claimed`,
            },
            elapsedMs: Date.now() - startedAt,
          },
          context,
        );
      }
      const tab = this.claimTab(candidate, context);
      return this.withMeta(
        {
          ok: true,
          tab: await this.summary(tab),
          elapsedMs: Date.now() - startedAt,
        },
        context,
        tab,
      );
    }

    if (command.method === "finalizeTabs") {
      const keep = new Map(command.keep.map((item) => [item.tabId, item.status]));
      const unknown = [...keep.keys()].filter(
        (tabId) => !this.ownedTabs(context).some((tab) => tab.tabId === tabId),
      );
      if (unknown.length > 0) {
        return this.withMeta(
          {
            ok: false,
            error: {
              code: "backend_unavailable",
              message: `cannot finalize unknown tab(s): ${unknown.join(", ")}`,
            },
            elapsedMs: Date.now() - startedAt,
          },
          context,
        );
      }
      this.finalizeTabs(context, keep);
      return this.withMeta({ ok: true, elapsedMs: Date.now() - startedAt }, context);
    }

    if (command.method === "newTab") {
      const tab = this.createTab(context);
      running.tabId = tab.tabId;
      this.refreshRuntimeProtection(tab.tabId);
      const guest = await this.ensureGuest(tab, running.controller.signal);
      if (!guest) {
        const result = this.cancelledOrUnavailable(context, running, startedAt, tab);
        // newTab 在 ready ack 前失败时不能留下无 guest 的 provisional tab；否则后续 list/attach
        // 会把一次已取消的创建误当成仍存活的 tab。close 同时给 renderer 发卸载请求并留下 tombstone。
        await this.closeTabDurably(tab);
        return this.withMeta(result, context, tab, "closed");
      }
      return this.withMeta(
        {
          ok: true,
          tab: await this.summary(tab),
          elapsedMs: Date.now() - startedAt,
        },
        context,
        tab,
      );
    }

    const tab = this.resolveTab(context, "tabId" in command ? command.tabId : undefined);
    if (!tab) {
      return this.withMeta(
        {
          ok: false,
          error: {
            code: "backend_unavailable",
            message:
              "tabId" in command && command.tabId
                ? `browser tab '${command.tabId}' is not visible in the current context. ${TAB_CONTEXT_RECOVERY_HINT}`
                : "browser tab is unavailable",
          },
          elapsedMs: Date.now() - startedAt,
        },
        context,
      );
    }
    running.tabId = tab.tabId;
    this.refreshRuntimeProtection(tab.tabId);

    if (command.method === "recordingStart") {
      const active = [...this.recordings.values()].find(
        (entry) => entry.tabId === tab.tabId && entry.status === "running",
      );
      if (active) {
        return this.withMeta(
          {
            ok: false,
            error: {
              code: "execution_error",
              message: `browser tab '${tab.tabId}' already has active recording '${active.id}'`,
              sideEffect: "none",
            },
            elapsedMs: Date.now() - startedAt,
          },
          context,
          tab,
        );
      }
      const entry = this.createRecordingEntry(context, tab);
      this.recordings.set(entry.id, entry);
      this.refreshRuntimeProtection(tab.tabId);
      entry.completion = this.runRecording(entry, tab, command.options).catch((error: unknown) => {
        if (entry.status !== "running") return;
        if (
          entry.controller.signal.aborted &&
          entry.controller.signal.reason instanceof DOMException &&
          entry.controller.signal.reason.name === "TimeoutError"
        ) {
          this.setRecordingTerminal(entry, "failed", entry.controller.signal.reason.message);
        } else if (entry.controller.signal.aborted) {
          this.setRecordingTerminal(entry, "cancelled");
        } else {
          this.setRecordingTerminal(
            entry,
            "failed",
            error instanceof Error ? error.message : String(error),
          );
        }
      });
      return this.withMeta(
        {
          ok: true,
          recording: this.snapshotRecording(entry),
          elapsedMs: Date.now() - startedAt,
        },
        context,
        tab,
      );
    }

    if (command.method === "getDialog") {
      return this.withMeta(
        {
          ok: true,
          dialog: this.pendingDialogs.get(tab.tabId) ?? null,
          elapsedMs: Date.now() - startedAt,
        },
        context,
        tab,
      );
    }
    if (command.method === "close") {
      await this.closeTabDurably(tab);
      return this.withMeta({ ok: true, elapsedMs: Date.now() - startedAt }, context, tab, "closed");
    }
    if (command.method === "finalize") {
      tab.lifecycle = command.deliverable === false ? "active" : "deliverable";
      return this.withMeta({ ok: true, elapsedMs: Date.now() - startedAt }, context, tab);
    }
    if (command.method === "markDeliverable") {
      tab.lifecycle = "deliverable";
      return this.withMeta({ ok: true, elapsedMs: Date.now() - startedAt }, context, tab);
    }
    if (command.method === "markHandoff") {
      tab.lifecycle = "handoff";
      return this.withMeta({ ok: true, elapsedMs: Date.now() - startedAt }, context, tab);
    }
    if (command.method === "playwrightWaitForTimeout") {
      // 固定等待前先验证 tab；等待本身不触碰页面，也不要求 guest/CDP 已 attach。
      // turn/session/request abort 必须提前结束 timer，避免已取消的 sleep 继续占住生命周期。
      const completed = await waitForDelay(command.timeoutMs, running.controller.signal);
      if (!completed) {
        return this.withMeta(this.cancelledResult(context, false, startedAt), context, tab);
      }
      return this.withMeta({ ok: true, elapsedMs: Date.now() - startedAt }, context, tab);
    }
    if (
      command.method === "playwright" &&
      (command.action.name === "fileChooserSetFiles" ||
        (command.action.name === "waitForEvent" && command.action.event === "filechooser"))
    ) {
      // IAB backend 不支持 filechooser；不能伪造成功或把它误当普通 DOM fill。
      return this.withMeta(
        {
          ok: false,
          error: {
            code: "capability_unsupported",
            message: "File uploads are not supported by iab",
          },
          elapsedMs: Date.now() - startedAt,
        },
        context,
        tab,
      );
    }
    if (command.method === "playwright" && command.action.name === "downloadPath") {
      const record = this.downloads.get(command.action.downloadId);
      if (!record || record.tabId !== tab.tabId) {
        return this.withMeta(
          {
            ok: false,
            error: {
              code: "backend_unavailable",
              message: "download is unavailable for this tab",
            },
            elapsedMs: Date.now() - startedAt,
          },
          context,
          tab,
        );
      }
      const status = await waitForCondition(
        // Playwright 的 download.path() 等下载完成后再返回；will-download 阶段已有
        // savePath 不代表文件已经可安全读取，不能提前 resolve。
        () => record.state !== "pending",
        command.action.timeoutMs ?? 30_000,
        running.controller.signal,
      );
      if (status === "cancelled") {
        return this.withMeta(this.cancelledResult(context, false, startedAt), context, tab);
      }
      if (status === "timeout") {
        return this.withMeta(
          {
            ok: false,
            error: {
              code: "timeout",
              message: "Timeout waiting for download path",
            },
            elapsedMs: Date.now() - startedAt,
          },
          context,
          tab,
        );
      }
      if (record.state !== "completed") {
        return this.withMeta(
          {
            ok: false,
            error: {
              code: "execution_error",
              message: `download ${record.state}`,
              sideEffect: "uncertain",
            },
            elapsedMs: Date.now() - startedAt,
          },
          context,
          tab,
        );
      }
      return this.withMeta(
        { ok: true, value: record.path, elapsedMs: Date.now() - startedAt },
        context,
        tab,
      );
    }

    const guest = await this.ensureGuest(tab, running.controller.signal);
    if (!guest) return this.cancelledOrUnavailable(context, running, startedAt, tab);
    if (safeBool(() => guest.isDestroyed(), false)) {
      this.detachGuest(tab);
      return this.withMeta(
        {
          ok: false,
          error: {
            code: "backend_unavailable",
            message: "browser guest destroyed",
          },
          elapsedMs: Date.now() - startedAt,
        },
        context,
        tab,
      );
    }
    if ((tab.viewportOverride || tab.backgroundViewportFallback) && guest.getZoomFactor() !== 1)
      guest.setZoomFactor(1);
    const guestGeneration = tab.guestGeneration;
    const assertCurrentGuest = (): void => {
      if (tab.guestLifecycle === "detaching") {
        throw new Error("browser guest is detaching");
      }
      if (
        tab.guest !== guest ||
        tab.guestGeneration !== guestGeneration ||
        safeBool(() => guest.isDestroyed(), true)
      ) {
        throw new Error("browser guest changed before command dispatch");
      }
    };
    const sendCdpCommand = (method: string, params?: unknown, sessionId?: string) =>
      this.sendGuestCdpCommand(tab, guest, method, params, sessionId, assertCurrentGuest);

    if (
      command.method === "playwright" &&
      command.action.name === "waitForEvent" &&
      command.action.event === "download"
    ) {
      const downloadId = await this.waitForDownload(
        tab.tabId,
        // 下载事件默认等待 3s，但允许调用方为真实下载显式扩到最多 120s。
        normalizePlaywrightTimeout(command.action.timeoutMs, 120_000),
        running.controller.signal,
      );
      if (!downloadId) {
        const result = running.controller.signal.aborted
          ? this.cancelledResult(context, false, startedAt)
          : {
              ok: false as const,
              error: {
                code: "timeout" as const,
                message: "Timeout waiting for download",
              },
              elapsedMs: Date.now() - startedAt,
            };
        return this.withMeta(result, context, tab);
      }
      return this.withMeta(
        {
          ok: true,
          value: { id: downloadId },
          elapsedMs: Date.now() - startedAt,
        },
        context,
        tab,
      );
    }

    if (command.method === "handleDialog") {
      try {
        assertCurrentGuest();
      } catch {
        return this.withMeta(
          {
            ok: false,
            error: {
              code: "backend_unavailable",
              message: "browser guest changed before command dispatch",
              sideEffect: "none",
            },
            elapsedMs: Date.now() - startedAt,
          },
          context,
          tab,
        );
      }
      running.dispatched = true;
      const execution = sendCdpCommand("Page.handleJavaScriptDialog", {
        accept: command.accept,
        ...(command.promptText !== undefined ? { promptText: command.promptText } : {}),
      })
        .then<BrowserCommandResult>(() => ({
          ok: true,
          elapsedMs: Date.now() - startedAt,
        }))
        .catch<BrowserCommandResult>((error: unknown) => ({
          ok: false,
          error: {
            code: "execution_error",
            message: error instanceof Error ? error.message : String(error),
          },
          elapsedMs: Date.now() - startedAt,
        }));
      const result = await raceBackendExecution(
        execution,
        running.controller.signal,
        command,
        startedAt,
      );
      if (result.ok) {
        this.pendingDialogs.delete(tab.tabId);
      }
      return this.withMeta(result, context, tab);
    }

    const screenshotCommand = isScreenshotCommand(command);
    const previousScreenshot = screenshotCommand
      ? this.inFlightScreenshots.get(tab.tabId)
      : undefined;
    if (previousScreenshot && this.isInFlightScreenshotAlive(previousScreenshot)) {
      const elapsedMs = Date.now() - previousScreenshot.startedAt;
      this.log?.(
        `[browser-use] screenshot rejected tabId=${tab.tabId} requestId=${context.requestId} pendingRequestId=${previousScreenshot.requestId} pendingMs=${elapsedMs}`,
      );
      return this.withMeta(
        {
          ok: false,
          error: {
            code: "timeout",
            message:
              "A previous screenshot for this browser tab is still completing after timeout. " +
              "Wait before retrying, or reopen the tab if it does not recover.",
            sideEffect: "none",
          },
          elapsedMs: Date.now() - startedAt,
        },
        context,
        tab,
      );
    }
    const abandonedCaptures = screenshotCommand
      ? (this.abandonedScreenshotCaptures.get(tab.tabId) ?? 0)
      : 0;
    if (screenshotCommand && abandonedCaptures >= MAX_ABANDONED_SCREENSHOT_CAPTURES) {
      // 未结算的底层 capture 已达硬上限：不再叠加新的 pending CDP command，快速失败
      // 并提示重开 tab；旧 capture 落定后名额自动回收，无需人工干预即可恢复。
      this.log?.(
        `[browser-use] screenshot rejected tabId=${tab.tabId} requestId=${context.requestId} abandonedCaptures=${abandonedCaptures}`,
      );
      return this.withMeta(
        {
          ok: false,
          error: {
            code: "timeout",
            message:
              `${abandonedCaptures} previous screenshot captures for this browser tab are still ` +
              "stuck in the backend after timeout. Reopen the tab to recover.",
            sideEffect: "none",
          },
          elapsedMs: Date.now() - startedAt,
        },
        context,
        tab,
      );
    }
    if (previousScreenshot) {
      // 整幅 capture 在隐藏窗口等帧时，30s watchdog 判死但底层 execution 永不
      // settle，tracker 无法清理，该 tab 后续截图全部被 0ms 秒拒直至关 tab（生产日志
      // pendingMs 高达 120s）。命令已返回或已被 abort 的挂起截图视为死条目，
      // 由新请求直接取代；清理以 entry identity 幂等，迟到的 settle 不会误删新请求。
      this.log?.(
        `[browser-use] screenshot superseded stale pending tabId=${tab.tabId} requestId=${context.requestId} pendingRequestId=${previousScreenshot.requestId} pendingMs=${Date.now() - previousScreenshot.startedAt}`,
      );
    }

    const execution = screenshotCommand
      ? this.executeScreenshotWithPreparedSurface(
          context,
          tab,
          guest,
          command,
          running,
          startedAt,
          assertCurrentGuest,
          sendCdpCommand,
        )
      : executeBrowserCommandOnView(
          this.toControlledView(
            guest,
            Boolean(tab.viewportOverride || tab.backgroundViewportFallback),
            undefined,
            assertCurrentGuest,
            sendCdpCommand,
          ),
          command,
          { signal: running.controller.signal },
        );
    if (!screenshotCommand) running.dispatched = true;
    if (screenshotCommand) {
      const tracked: InFlightScreenshot = {
        execution,
        requestId: context.requestId,
        startedAt: Date.now(),
      };
      this.inFlightScreenshots.set(tab.tabId, tracked);
      this.refreshRuntimeProtection(tab.tabId);
      const clearTrackedScreenshot = () => {
        if (this.inFlightScreenshots.get(tab.tabId) !== tracked) return;
        this.inFlightScreenshots.delete(tab.tabId);
        this.refreshRuntimeProtection(tab.tabId);
        this.log?.(
          `[browser-use] screenshot backend settled tabId=${tab.tabId} requestId=${context.requestId} elapsedMs=${Date.now() - tracked.startedAt}`,
        );
      };
      // 同时提供 fulfilled/rejected handler，避免仅调用 finally 产生未处理的派生 rejection。
      void execution.then(clearTrackedScreenshot, clearTrackedScreenshot);
    }
    const result = await raceBackendExecution(
      execution,
      running.controller.signal,
      command,
      startedAt,
    );
    return this.withMeta(result, context, tab);
  }

  /**
   * renderer 的 logical viewport ready 只能证明 CSS 坐标系正确；Windows 负缩放
   * 下 Fit 预览仍可能只有 800×450 raster，CDP 会把它平铺为 1280×720。main 直接读取
   * 已合成的 guest surface，再归一化到逻辑 viewport；这不走曾触发 V8 FATAL 的 renderer
   * `<webview>.capturePage()` 调用，也不改变页面布局、DPR 或交互态 metrics。
   */
  private async executeScreenshotWithPreparedSurface(
    context: InternalExecutionContext,
    tab: ManagedTab,
    guest: GuestWebContents,
    command: BrowserCommand,
    running: RunningRequest,
    startedAt: number,
    assertCurrentGuest: () => void,
    sendCdpCommand: ControlledView["cdp"]["send"],
  ): Promise<BrowserCommandResult> {
    let lease: BrowserScreenshotSurfaceLease | undefined;
    try {
      const screenshotSurfaceCoordinator = this.screenshotSurfaceCoordinator;
      if (!screenshotSurfaceCoordinator) {
        throw new Error("browser screenshot surface coordinator is unavailable");
      }
      const viewport = await this.readTabViewport(tab);
      let result: BrowserCommandResult | undefined;

      // 不能先 acquire activity、再排队 viewport mutation：前序 resize/CDP 卡住时，
      // owner + guest 会在队列外背靠背 capture，最长烧满 35s。surface 准备必须在轮到本次
      // viewport 临界区之后才开始，确保 activity 只覆盖真实 prepare + raster 生命周期。
      await this.enqueueViewportMutation(tab, async () => {
        lease = await screenshotSurfaceCoordinator.prepare({
          requestId: context.requestId,
          windowId: context.windowId,
          workspaceKey: context.workspaceKey,
          sessionId: context.sessionId,
          browserId: context.browserId,
          browserGeneration: context.browserGeneration,
          tabId: tab.tabId,
          webContentsId: guest.id,
          viewport,
          // 自然 viewport 未安装 metrics；不能让 renderer 的临时 Fit 扩张 guest 布局并触发网页重排。
          viewportMode:
            tab.viewportOverride || tab.backgroundViewportFallback ? "emulated" : "natural",
          signal: running.controller.signal,
        });
        if (
          running.controller.signal.aborted ||
          tab.guest !== guest ||
          guest.isDestroyed() ||
          lease.webContentsId !== guest.id
        ) {
          throw new Error("browser guest changed while preparing screenshot surface");
        }
        const invalidationError = readScreenshotSurfaceInvalidation(lease.invalidated);
        if (invalidationError) throw invalidationError;
        // 普通 fallback 也使用临时 responsive surface；idle detach 后先在同一 mutation 内重装 metrics。
        if (
          tab.backgroundViewportFallback &&
          (!guest.debugger.isAttached() || tab.guestCdpRestoreFlight)
        ) {
          await this.sendGuestCdpCommand(
            tab,
            guest,
            "Emulation.setDeviceMetricsOverride",
            buildViewportMetricsOverride(tab.backgroundViewportFallback),
          );
        }
        const normalizedScreenshot = Boolean(
          tab.viewportOverride || tab.backgroundViewportFallback,
        );
        // Windows 125% 显示缩放 + Desktop 110% 时，renderer 即使上报
        // surfaceScale=1，CDP 仍会把较小的 native raster 周期平铺成目标尺寸。
        // Desktop 放大时的 viewport 截图也读取实际 surface，再统一归一为 CSS px。
        const captureViewportScreenshot =
          normalizedScreenshot &&
          (lease.surfaceScale < 0.999 || (guest.hostWebContents?.getZoomFactor() ?? 1) > 1)
            ? async (): Promise<string | undefined> => {
                if (!this.resizeScreenshotToCssPixels) {
                  throw new Error("browser screenshot CSS pixel normalizer is unavailable");
                }
                const surface = await guest.capturePage();
                const surfacePng = surface.toPNG();
                if (surfacePng.byteLength === 0) return undefined;
                return this.resizeScreenshotToCssPixels(surfacePng.toString("base64"), viewport);
              }
            : undefined;
        running.dispatched = true;
        // owner 窗口隐藏（关闭到托盘）后 Windows 合成器不再为 guest 合成任何
        // 帧；prepare 阶段的透明 bootstrap 又在 renderer ready 时提前释放，整幅 capture
        // 只能等用户重新打开窗口才拿得到帧（日志里仅在 tray-show 后约 140ms
        // 完成，其余全部 30s watchdog 判死）。capture 生命周期内临时持有透明 presentation
        // （showInactive + opacity 0，用户不可见）主动要帧；同时 capture 结算必须竞速
        // abort/有界 deadline——悬空的 execution 会把 viewport mutation 队列和 in-flight
        // 槽位一起拖死，mutation 绝不能比请求本身活得更久。
        const capturePresentation = this.startHiddenWindowCapturePresentation(context, guest);
        try {
          // 与 activity pump 同一约束：showInactive 后 Viz surface 建立前同 turn 读回会抛
          // UnknownVizError。先等统一的有界 presentation grace 再发起 capture——归一化
          // 路径（后台 tab）的 guest.capturePage() 对此同样敏感。
          if (
            capturePresentation &&
            !(await waitForDelay(
              TRANSPARENT_WINDOW_PRESENTATION_GRACE_MS,
              running.controller.signal,
            ))
          ) {
            throw new Error("browser screenshot capture cancelled during presentation grace");
          }
          // native capture 不经过 sendCdpCommand，也必须等待 idle detach 后的 metrics 恢复。
          if (!guest.debugger.isAttached() || tab.guestCdpRestoreFlight) {
            await this.ensureGuestCdpAttached(tab, guest);
          }
          const captureExecution = executeBrowserCommandOnView(
            this.toControlledView(
              guest,
              normalizedScreenshot,
              captureViewportScreenshot,
              assertCurrentGuest,
              sendCdpCommand,
            ),
            command,
            { signal: running.controller.signal },
          );
          result = await this.settleScreenshotCapture(
            captureExecution,
            running.controller.signal,
            context,
            startedAt,
            tab.tabId,
            capturePresentation ? HIDDEN_WINDOW_CAPTURE_DEADLINE_MS : undefined,
          );
        } finally {
          capturePresentation?.release();
        }
        const lateInvalidationError = readScreenshotSurfaceInvalidation(lease.invalidated);
        if (lateInvalidationError) throw lateInvalidationError;
      });
      if (!result) throw new Error("browser screenshot did not produce a result");
      return result;
    } catch (error) {
      const cancelled = running.controller.signal.aborted;
      return {
        ok: false,
        error: {
          code: cancelled ? "cancelled" : "backend_unavailable",
          message: cancelled
            ? "browser screenshot surface preparation cancelled"
            : error instanceof Error
              ? error.message
              : String(error),
          sideEffect: "none",
        },
        elapsedMs: Date.now() - startedAt,
      };
    } finally {
      lease?.release();
    }
  }

  /** 窗口隐藏时为整幅 capture 建立一次性透明 presentation；窗口可见或能力未注入时为 no-op。 */
  private startHiddenWindowCapturePresentation(
    context: InternalExecutionContext,
    guest: GuestWebContents,
  ): TransparentWindowBootstrap | undefined {
    if (!this.resolveOwnerWindow) return undefined;
    const win = this.resolveOwnerWindow(context.windowId);
    if (!win) return undefined;
    return (
      startBrowserScreenshotTransparentWindowBootstrap({
        win,
        enabled: true,
        windowId: context.windowId,
        webContentsId: guest.id,
        requestId: context.requestId,
        hideTaskbarDuringBootstrap: process.platform === "win32",
        log: this.log,
      }) || undefined
    );
  }

  /**
   * capture 结算的统一出口：execution、请求 abort、可选的有界 deadline 三者先到先结算。
   * 隐藏窗口等帧、上游 30s cancelRequest 等场景下 execution 可能永不落定；不等它，
   * 保证 viewport mutation 队列和 in-flight 槽位随请求一起释放。abort/deadline 先胜时
   * 底层 CDP command 仍在 Chromium 内 pending，计入 abandonedScreenshotCaptures 硬上限。
   */
  private async settleScreenshotCapture(
    execution: Promise<BrowserCommandResult>,
    signal: AbortSignal,
    context: InternalExecutionContext,
    startedAt: number,
    tabId: string,
    deadlineMs?: number,
  ): Promise<BrowserCommandResult> {
    return await new Promise<BrowserCommandResult>((resolve) => {
      let settled = false;
      const finish = (result: BrowserCommandResult): boolean => {
        if (settled) return false;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve(result);
        return true;
      };
      const onAbort = () => {
        if (
          finish({
            ok: false,
            error: {
              code: "cancelled",
              message: "browser screenshot capture cancelled",
              sideEffect: "none",
            },
            elapsedMs: Date.now() - startedAt,
          })
        ) {
          this.abandonBackendCapture(tabId, execution);
        }
      };
      const timer =
        deadlineMs !== undefined
          ? setTimeout(() => {
              this.log?.(
                `[browser-use] hidden window capture deadline exceeded requestId=${context.requestId} windowId=${context.windowId} deadlineMs=${deadlineMs}`,
              );
              if (
                finish({
                  ok: false,
                  error: {
                    code: "timeout",
                    message: `browser screenshot capture timed out after ${deadlineMs}ms while the window was hidden`,
                    sideEffect: "none",
                  },
                  elapsedMs: Date.now() - startedAt,
                })
              ) {
                this.abandonBackendCapture(tabId, execution);
              }
            }, deadlineMs)
          : undefined;
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
      execution.then(finish, (error: unknown) =>
        finish({
          ok: false,
          error: {
            code: "execution_error",
            message: error instanceof Error ? error.message : String(error),
          },
          elapsedMs: Date.now() - startedAt,
        }),
      );
    });
  }

  /** 记一笔“已放弃等待但底层仍在执行”的 capture；真实落定后名额自动回收。 */
  private abandonBackendCapture(tabId: string, execution: Promise<BrowserCommandResult>): void {
    this.abandonedScreenshotCaptures.set(
      tabId,
      (this.abandonedScreenshotCaptures.get(tabId) ?? 0) + 1,
    );
    execution.then(
      () => this.releaseAbandonedBackendCapture(tabId),
      () => this.releaseAbandonedBackendCapture(tabId),
    );
  }

  private releaseAbandonedBackendCapture(tabId: string): void {
    const count = this.abandonedScreenshotCaptures.get(tabId);
    if (count === undefined) return;
    if (count <= 1) this.abandonedScreenshotCaptures.delete(tabId);
    else this.abandonedScreenshotCaptures.set(tabId, count - 1);
  }

  private recordingNow(): number {
    return this.residencyOptions.recording?.now?.() ?? Date.now();
  }

  /**
   * 挂起截图是否仍存活：对应命令还在执行中（runningRequests 里有未 abort 的条目）。
   * 条目已消失说明命令早已返回（典型为 30s watchdog 判死）而 execution 悬空——死槽位。
   */
  private isInFlightScreenshotAlive(tracked: InFlightScreenshot): boolean {
    const running = this.runningRequests.get(tracked.requestId);
    return running !== undefined && !running.controller.signal.aborted;
  }

  private createRecordingEntry(
    context: InternalExecutionContext,
    tab: ManagedTab,
  ): BrowserRecordingEntry {
    const now = this.recordingNow();
    return {
      id: `iab-recording:${randomUUID()}`,
      context: { ...context },
      tabId: tab.tabId,
      controller: new AbortController(),
      status: "running",
      phase: "preparing",
      progress: 0,
      startedAt: now,
      updatedAt: now,
    };
  }

  private snapshotRecording(entry: BrowserRecordingEntry): BrowserRecordingJob {
    return {
      id: entry.id,
      status: entry.status,
      phase: entry.phase,
      progress: entry.progress,
      startedAt: entry.startedAt,
      updatedAt: entry.updatedAt,
      ...(entry.artifact ? { artifact: { ...entry.artifact } } : {}),
      ...(entry.error ? { error: entry.error } : {}),
    };
  }

  private setRecordingPhase(
    entry: BrowserRecordingEntry,
    phase: Extract<BrowserRecordingJob["phase"], "capturing" | "finalizing">,
  ): void {
    if (entry.status !== "running") return;
    entry.phase = phase;
    entry.progress = phase === "capturing" ? 0.1 : 0.9;
    entry.updatedAt = this.recordingNow();
    this.refreshRuntimeProtection(entry.tabId);
  }

  private setRecordingTerminal(
    entry: BrowserRecordingEntry,
    status: Extract<BrowserRecordingJob["status"], "completed" | "failed" | "cancelled">,
    error?: string,
  ): void {
    entry.status = status;
    entry.phase = status;
    entry.progress = status === "completed" ? 1 : entry.progress;
    entry.updatedAt = this.recordingNow();
    if (error) entry.error = error;
    else delete entry.error;
    if (!entry.cleanupTimer) {
      entry.cleanupTimer = setTimeout(() => {
        this.recordings.delete(entry.id);
        if (entry.artifact?.path) {
          void rm(entry.artifact.path, { force: true }).catch(() => undefined);
        }
      }, RECORDING_RESULT_TTL_MS);
      entry.cleanupTimer.unref?.();
    }
    this.refreshRuntimeProtection(entry.tabId);
  }

  private abortRecordings(
    predicate: (entry: BrowserRecordingEntry) => boolean,
    reason: string,
  ): void {
    for (const entry of this.recordings.values()) {
      if (entry.status !== "running" || !predicate(entry)) continue;
      entry.controller.abort(new DOMException(reason, "AbortError"));
      this.setRecordingTerminal(entry, "cancelled");
    }
  }

  private async runRecording(
    entry: BrowserRecordingEntry,
    tab: ManagedTab,
    rawOptions?: BrowserRecordingOptions,
  ): Promise<void> {
    const signal = entry.controller.signal;
    const options = rawOptions ?? {};
    const viewport = options.viewport ?? DEFAULT_AGENT_BROWSER_VIEWPORT;
    const fps = options.fps ?? 25;
    const maxDurationMs = options.maxDurationMs ?? 60_000;
    const settleMs = options.settleMs ?? 300;
    assertViewportOverride(viewport);

    const guest = await this.ensureGuest(tab, signal);
    if (!guest || guest.isDestroyed()) throw new Error("browser guest unavailable for recording");
    // 录制会临时改写 tab viewport override 去换取 100% surface；先记下录制前的值。
    const previousViewport = tab.viewportOverride ? { ...tab.viewportOverride } : undefined;
    let lease: BrowserScreenshotSurfaceLease | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await this.setTabViewport(tab, viewport);
      // 只改 CDP metrics 不会同步 renderer 中承载 WebView 的自由尺寸 frame；自定义录制
      // viewport 会继续使用旧 DOM bounds，最终要么 prepare 超时，要么从缩小表面放大而变模糊。
      this.onViewportChanged?.(viewport, tab.owner, tab.tabId);
      const coordinator = this.screenshotSurfaceCoordinator;
      if (!coordinator) throw new Error("browser recording surface coordinator is unavailable");
      lease = await coordinator.prepare({
        requestId: `recording:${entry.id}`,
        windowId: entry.context.windowId,
        workspaceKey: entry.context.workspaceKey,
        sessionId: entry.context.sessionId,
        browserId: entry.context.browserId,
        browserGeneration: entry.context.browserGeneration,
        tabId: tab.tabId,
        webContentsId: guest.id,
        viewport,
        surfaceScaleMode: "unscaled",
        signal,
        activityTimeoutMs: maxDurationMs + 30_000,
      });
      if (!lease || lease.webContentsId !== guest.id) {
        throw new Error("browser guest changed while preparing recording surface");
      }
      const invalidationError = readScreenshotSurfaceInvalidation(lease.invalidated);
      if (invalidationError) throw invalidationError;
      const invalidateRecording = () =>
        entry.controller.abort(
          lease?.invalidated?.reason instanceof Error
            ? lease.invalidated.reason
            : new Error("browser recording surface invalidated"),
        );
      lease.invalidated?.addEventListener("abort", invalidateRecording, { once: true });
      timeout = setTimeout(
        () =>
          entry.controller.abort(new DOMException("browser recording timed out", "TimeoutError")),
        maxDurationMs,
      );
      const guestGeneration = tab.guestGeneration;
      const assertCurrentGuest = (): void => {
        if (tab.guestLifecycle === "detaching") {
          throw new Error("browser guest is detaching");
        }
        if (
          tab.guest !== guest ||
          tab.guestGeneration !== guestGeneration ||
          safeBool(() => guest.isDestroyed(), true)
        ) {
          throw new Error("browser guest changed before recording dispatch");
        }
      };
      const view = this.toControlledView(
        guest,
        true,
        undefined,
        assertCurrentGuest,
        (method, params, sessionId) =>
          this.sendGuestCdpCommand(tab, guest, method, params, sessionId, assertCurrentGuest),
      );
      if (options.showCursor !== false) await this.installRecordingCursorOverlay(guest);
      const createRecorder = this.residencyOptions.recording?.createRecorder;
      if (!createRecorder) throw new Error("browser WebM recorder is unavailable");
      entry.artifact = await recordBrowserVideo({
        targetFrame: guest.mainFrame,
        tempRoot: this.residencyOptions.recording?.tempRoot ?? tmpdir(),
        recordingId: entry.id.replace(/[^A-Za-z0-9._-]/gu, "-"),
        viewport,
        fps,
        signal,
        onPhase: (phase) => this.setRecordingPhase(entry, phase),
        onCaptureComplete: () => {
          // maxDurationMs 只约束页面取景；编码是收尾阶段，不能把一段已完整拍下的视频误杀掉。
          if (timeout) {
            clearTimeout(timeout);
            timeout = undefined;
          }
          lease?.release();
        },
        executeScenario: async () => {
          if (settleMs > 0 && !(await waitForDelay(settleMs, signal))) throw abortError();
          await this.executeRecordingActions(view, options.actions ?? [], signal, viewport);
        },
        createRecorder,
      });
      this.setRecordingTerminal(entry, "completed");
    } finally {
      if (timeout) clearTimeout(timeout);
      if (options.showCursor !== false) await this.removeRecordingCursorOverlay(guest);
      // lease.release() 只收回瞬时 surface 比例，tab 自己的 viewport override 会
      // 留在录制尺寸上，之后的预览与截图都按录制 viewport 走。录制是临时借用，必须还原。
      await this.restoreRecordingViewport(tab, previousViewport).catch(() => undefined);
      lease?.release();
    }
  }

  /** 把录制期间临时改写的 tab viewport 交还给录制前的状态。 */
  private async restoreRecordingViewport(
    tab: ManagedTab,
    previous: BrowserViewportSize | undefined,
  ): Promise<void> {
    if (tab.lifecycle === "closed") return;
    if (previous) {
      await this.setTabViewport(tab, previous);
      this.onViewportChanged?.(previous, tab.owner, tab.tabId);
      return;
    }
    await this.resetTabViewport(tab);
    this.onViewportChanged?.(null, tab.owner, tab.tabId);
  }

  private async executeRecordingActions(
    view: ControlledView,
    actions: BrowserRecordingAction[],
    signal: AbortSignal,
    viewport: BrowserViewportSize,
  ): Promise<void> {
    const pointer = { x: viewport.width / 2, y: viewport.height / 2 };
    for (const action of actions) {
      if (signal.aborted) throw abortError();
      await this.executeRecordingAction(view, action, signal, pointer);
      const delayAfterMs = "delayAfterMs" in action ? action.delayAfterMs : undefined;
      if (delayAfterMs && !(await waitForDelay(delayAfterMs, signal))) throw abortError();
    }
  }

  private async executeRecordingAction(
    view: ControlledView,
    action: BrowserRecordingAction,
    signal: AbortSignal,
    pointer: { x: number; y: number },
  ): Promise<void> {
    if (action.type === "wait") {
      if (!(await waitForDelay(action.durationMs, signal))) throw abortError();
      return;
    }
    if (action.type === "click" || action.type === "type" || action.type === "waitFor") {
      const locatorAction =
        action.type === "click"
          ? action.selector
            ? {
                name: "locator" as const,
                selector: action.selector,
                operation: action.doubleClick ? ("dblclick" as const) : ("click" as const),
                ...(action.button ? { button: action.button } : {}),
              }
            : undefined
          : action.type === "type"
            ? {
                name: "locator" as const,
                selector: action.selector,
                operation: "fill" as const,
                value: action.text,
              }
            : {
                name: "locator" as const,
                selector: action.selector,
                operation: "waitFor" as const,
                state: action.state ?? "visible",
              };
      if (locatorAction) {
        const result = await executeIabPlaywrightLocator(
          view,
          locatorAction,
          action.type === "waitFor" ? (action.timeoutMs ?? 3_000) : 3_000,
          signal,
        );
        if (result.kind === "cancelled") throw abortError();
        if (result.kind === "timeout")
          throw new Error(`recording action timed out: ${result.reason}`);
        return;
      }
      if (action.type !== "click") {
        throw new Error(`recording ${action.type} requires a selector`);
      }
      if (typeof action.x !== "number" || typeof action.y !== "number") {
        throw new Error("recording click requires selector or (x,y)");
      }
      await this.executeRecordingBrowserCommand(view, {
        method: "click",
        x: action.x,
        y: action.y,
        ...(action.button ? { button: action.button } : {}),
        ...(action.doubleClick !== undefined ? { doubleClick: action.doubleClick } : {}),
      });
      pointer.x = action.x;
      pointer.y = action.y;
      return;
    }
    if (action.type === "hover") {
      if (action.selector) {
        const point = await this.resolveRecordingSelectorPoint(view, action.selector, signal);
        await this.moveRecordingPointer(
          view,
          point.x,
          point.y,
          action.durationMs ?? 0,
          signal,
          pointer,
        );
      } else if (typeof action.x === "number" && typeof action.y === "number") {
        await this.moveRecordingPointer(
          view,
          action.x,
          action.y,
          action.durationMs ?? 0,
          signal,
          pointer,
        );
      } else {
        throw new Error("recording hover requires selector or (x,y)");
      }
      return;
    }
    if (action.type === "move") {
      await this.moveRecordingPointer(
        view,
        action.x,
        action.y,
        action.durationMs ?? 0,
        signal,
        pointer,
      );
      return;
    }
    if (action.type === "scroll") {
      await this.animateRecordingScroll(
        view,
        action.deltaX ?? 0,
        action.deltaY,
        action.durationMs ?? 0,
        signal,
      );
      return;
    }
    if (action.type === "scrollTo") {
      const current = (await view.webContents.executeJavaScript(
        "({ x: window.scrollX, y: window.scrollY })",
      )) as { x?: unknown; y?: unknown };
      const target = action.selector
        ? await this.resolveRecordingSelectorScrollTarget(view, action.selector, signal)
        : { x: action.x ?? Number(current.x ?? 0), y: action.y ?? Number(current.y ?? 0) };
      await this.animateRecordingScroll(
        view,
        target.x - Number(current.x ?? 0),
        target.y - Number(current.y ?? 0),
        action.durationMs ?? 0,
        signal,
      );
      return;
    }
    if (action.type === "wheel") {
      const times = action.times ?? 1;
      for (let index = 0; index < times; index += 1) {
        await this.executeRecordingBrowserCommand(view, {
          method: "scroll",
          x: action.deltaX ?? 0,
          y: action.deltaY,
        });
        if (action.intervalMs && !(await waitForDelay(action.intervalMs, signal)))
          throw abortError();
      }
      return;
    }
    if (action.type === "drag") {
      const steps = Math.max(1, action.path.length - 1);
      const intervalMs = Math.floor((action.durationMs ?? 0) / steps);
      await view.cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: action.path[0]!.x,
        y: action.path[0]!.y,
      });
      await view.cdp.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: action.path[0]!.x,
        y: action.path[0]!.y,
        button: "left",
        clickCount: 1,
      });
      for (const point of action.path.slice(1)) {
        await view.cdp.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: point.x,
          y: point.y,
          button: "left",
          buttons: 1,
        });
        if (intervalMs > 0 && !(await waitForDelay(intervalMs, signal))) throw abortError();
      }
      const last = action.path.at(-1)!;
      await view.cdp.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: last.x,
        y: last.y,
        button: "left",
        clickCount: 1,
      });
      pointer.x = last.x;
      pointer.y = last.y;
    }
  }

  private async executeRecordingBrowserCommand(
    view: ControlledView,
    command: BrowserCommand,
  ): Promise<void> {
    const result = await executeBrowserCommandOnView(view, command);
    if (!result.ok)
      throw new Error(result.error?.message ?? `recording action ${command.method} failed`);
  }

  private async resolveRecordingSelectorPoint(
    view: ControlledView,
    selector: string,
    signal: AbortSignal,
  ): Promise<{ x: number; y: number }> {
    const result = await executeIabPlaywrightLocator(
      view,
      {
        name: "locator",
        selector,
        operation: "evaluate",
        expressionKind: "function",
        expression:
          "(element) => { const rect = element.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; }",
      },
      3_000,
      signal,
    );
    if (result.kind !== "done" || !isBrowserPointValue(result.value)) {
      throw new Error(`recording selector '${selector}' has no visible point`);
    }
    return result.value;
  }

  private async resolveRecordingSelectorScrollTarget(
    view: ControlledView,
    selector: string,
    signal: AbortSignal,
  ): Promise<{ x: number; y: number }> {
    const result = await executeIabPlaywrightLocator(
      view,
      {
        name: "locator",
        selector,
        operation: "evaluate",
        expressionKind: "function",
        expression:
          "(element) => { const rect = element.getBoundingClientRect(); return { x: window.scrollX + rect.left, y: window.scrollY + rect.top }; }",
      },
      3_000,
      signal,
    );
    if (result.kind !== "done" || !isBrowserPointValue(result.value)) {
      throw new Error(`recording selector '${selector}' has no scroll target`);
    }
    return result.value;
  }

  private async moveRecordingPointer(
    view: ControlledView,
    x: number,
    y: number,
    durationMs: number,
    signal: AbortSignal,
    pointer: { x: number; y: number },
  ): Promise<void> {
    const steps = Math.max(1, Math.min(60, Math.round(durationMs / 16)));
    const startX = pointer.x;
    const startY = pointer.y;
    for (let index = 1; index <= steps; index += 1) {
      if (signal.aborted) throw abortError();
      const progress = index / steps;
      await view.cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: startX + (x - startX) * progress,
        y: startY + (y - startY) * progress,
      });
      if (durationMs > 0 && index < steps && !(await waitForDelay(durationMs / steps, signal))) {
        throw abortError();
      }
    }
    pointer.x = x;
    pointer.y = y;
  }

  private async installRecordingCursorOverlay(guest: GuestWebContents): Promise<void> {
    await guest.executeJavaScript(`(() => {
      const id = "__zcode_browser_recording_cursor";
      document.getElementById(id)?.remove();
      const cursor = document.createElement("div");
      cursor.id = id;
      cursor.style.cssText = "position:fixed;left:0;top:0;width:18px;height:18px;border-radius:50%;background:#ff4d4f;border:2px solid #fff;box-shadow:0 1px 5px rgba(0,0,0,.45);pointer-events:none;z-index:2147483647;transform:translate(-50%,-50%);opacity:0;transition:opacity 80ms linear";
      document.documentElement.appendChild(cursor);
      const move = (event) => {
        cursor.style.left = event.clientX + "px";
        cursor.style.top = event.clientY + "px";
        cursor.style.opacity = "1";
      };
      const down = () => {
        cursor.style.transform = "translate(-50%,-50%) scale(.72)";
      };
      const up = () => {
        cursor.style.transform = "translate(-50%,-50%) scale(1)";
      };
      window["__zcodeBrowserRecordingCursorCleanup"]?.();
      window.addEventListener("mousemove", move, true);
      window.addEventListener("mousedown", down, true);
      window.addEventListener("mouseup", up, true);
      window["__zcodeBrowserRecordingCursorCleanup"] = () => {
        window.removeEventListener("mousemove", move, true);
        window.removeEventListener("mousedown", down, true);
        window.removeEventListener("mouseup", up, true);
        cursor.remove();
        delete window["__zcodeBrowserRecordingCursorCleanup"];
      };
    })()`);
  }

  private async removeRecordingCursorOverlay(guest: GuestWebContents): Promise<void> {
    if (guest.isDestroyed()) return;
    await guest
      .executeJavaScript('window["__zcodeBrowserRecordingCursorCleanup"]?.()')
      .catch(() => undefined);
  }

  private async animateRecordingScroll(
    view: ControlledView,
    deltaX: number,
    deltaY: number,
    durationMs: number,
    signal: AbortSignal,
  ): Promise<void> {
    const steps = Math.max(1, Math.min(60, Math.round(durationMs / 16)));
    for (let index = 0; index < steps; index += 1) {
      await this.executeRecordingBrowserCommand(view, {
        method: "scroll",
        x: deltaX / steps,
        y: deltaY / steps,
      });
      if (
        durationMs > 0 &&
        index + 1 < steps &&
        !(await waitForDelay(durationMs / steps, signal))
      ) {
        throw abortError();
      }
    }
  }

  private resolveTab(
    context: InternalExecutionContext,
    explicitTabId?: string,
  ): ManagedTab | undefined {
    if (explicitTabId) {
      const explicit = this.tabs.get(explicitTabId);
      if (!explicit || explicit.lifecycle === "closed" || !sameScope(explicit.owner, context)) {
        return undefined;
      }
      return explicit;
    }
    const key = scopeKey(context);
    const activeId = this.activeTabByScope.get(key);
    const active = activeId ? this.tabs.get(activeId) : undefined;
    if (active && active.lifecycle !== "closed" && sameScope(active.owner, context)) return active;
    const defaultId = this.defaultTabByScope.get(key);
    const existingDefault = defaultId ? this.tabs.get(defaultId) : undefined;
    if (
      existingDefault &&
      existingDefault.lifecycle !== "closed" &&
      sameScope(existingDefault.owner, context)
    ) {
      return existingDefault;
    }
    // 后台会话（renderer 只上报 active:false）且 tab 由显式 newTab 创建时，activeTabByScope 与
    // defaultTabByScope 都是空的。这里必须复用该 scope 最近存活的 tab，否则不带 tabId 的命令会
    // 凭空再开一个空 tab，也会让 tabs.list() 报的 active 与实际落点不一致。
    const recent = this.ownedTabs(context).at(-1);
    if (recent) return recent;
    return this.createTab(context, context.legacy ? context.sessionId : undefined, true);
  }

  private createTab(
    context: InternalExecutionContext,
    preferredTabId?: string,
    makeDefault = false,
  ): ManagedTab {
    const tabId = preferredTabId ?? `iab-tab:${randomUUID()}`;
    const existing = this.tabs.get(tabId);
    if (existing && existing.lifecycle !== "closed" && sameScope(existing.owner, context)) {
      return existing;
    }
    const tab: ManagedTab = {
      tabId,
      owner: { ...context },
      cdpAttached: false,
      guestLifecycle: "detached",
      pendingCdpCommands: 0,
      guestGeneration: 0,
      hasAttachedGuest: false,
      rebindRequested: false,
      lifecycle: "active",
      origin: "agent",
      claimable: false,
      active: false,
      loading: false,
      mediaActive: false,
      cachedUrl: "",
      cachedTitle: "",
      cachedFaviconUrl: null,
      openedAt: this.now(),
      // 模型创建路径（显式 newTab 与无 tab 时的隐式创建）默认使用桌面自由尺寸。
      // viewport 属于 tab 创建事实；claim、activate、navigate 只复用已有 tab，不能再次套默认值。
      viewportOverride: { ...DEFAULT_AGENT_BROWSER_VIEWPORT },
    };
    this.tabs.set(tabId, tab);
    this.registerTabResidency(tab, false);
    void this.persistShell(tab);
    if (makeDefault) this.defaultTabByScope.set(scopeKey(context), tabId);
    return tab;
  }

  private async ensureGuest(
    tab: ManagedTab,
    signal: AbortSignal,
  ): Promise<GuestWebContents | null> {
    if (signal.aborted) return null;
    const suspendFlight = this.suspendFlights.get(tab.tabId);
    if (suspendFlight) {
      // 保护状态只能取消 coordinator generation，不能立刻证明 renderer 未卸载。
      // Browser command 必须等待 snapshot/ack/必要恢复收敛，不能复用即将销毁的旧 guest。
      const settled = await waitForPromiseWithSignal(suspendFlight, signal);
      if (!settled.completed) return null;
    }
    const residency = this.residencyCoordinator.get(tab.tabId);
    if (residency?.residency === "suspended" || residency?.residency === "restoring") {
      return await this.restoreSuspendedGuest(tab, signal);
    }
    if (tab.guest && !safeBool(() => tab.guest!.isDestroyed(), true)) {
      return await this.waitForGuestRecovery(tab, tab.guest, signal);
    }
    if (tab.guest) {
      this.detachGuest(tab);
    }

    const existingFlight = this.guestAttachFlights.get(tab.tabId);
    let flight = existingFlight;
    if (!flight) {
      flight = this.runGuestAttachFlight(tab);
      this.guestAttachFlights.set(tab.tabId, flight);
      const clearFlight = () => {
        if (this.guestAttachFlights.get(tab.tabId) === flight) {
          this.guestAttachFlights.delete(tab.tabId);
        }
      };
      void flight.then(clearFlight, clearFlight);
    }
    const settled = await waitForPromiseWithSignal(flight, signal);
    if (!settled.completed || !settled.value) return null;
    return await this.waitForGuestRecovery(tab, settled.value, signal);
  }

  private async waitForGuestRecovery(
    tab: ManagedTab,
    guest: GuestWebContents,
    signal: AbortSignal,
  ): Promise<GuestWebContents | null> {
    const flight = this.guestRecoveryFlights.get(tab.tabId);
    if (!flight) return guest;
    const settled = await waitForPromiseWithSignal(flight, signal);
    return settled.completed && settled.value === guest ? guest : null;
  }

  private async runGuestAttachFlight(tab: ManagedTab): Promise<GuestWebContents | null> {
    // 新 tab 的首次 ready 仍只等待一次；已有 guest 或已明确收到拒绝时允许一次有界重放。
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (tab.lifecycle === "closed") return null;
      // create/ready 是可重放状态；事件丢失或 guest 崩溃后发起一次有界重放。
      // 如果 destroyed/mismatch 已经发起过重绑，沿用该请求，避免同一 tab 重复创建 webview。
      if (!tab.rebindRequested) this.onOpenTabRequested?.(tab.tabId, tab.owner);
      // 某些测试/旧 renderer 会在 Ready 回调内同步 attach；不能在 attach 已成功后再注册 waiter。
      // Bug 原因：guest 是可变字段，进入回调后 TypeScript 会撤销属性收窄；固定本轮引用，
      // 同时保证销毁检查与返回的是同一个 guest。
      const attachedGuest = tab.guest;
      if (attachedGuest && !safeBool(() => attachedGuest.isDestroyed(), true)) {
        return attachedGuest;
      }
      const guest = await this.waitForGuest(tab.tabId);
      if (guest && !safeBool(() => guest.isDestroyed(), true)) return guest;
      if (attempt === 0 && !tab.hasAttachedGuest && !tab.attachFailure) return null;
      if (attempt === 1) return null;
      this.requestGuestRebind(tab, tab.attachFailure ?? "attach-timeout");
    }
    return null;
  }

  private ownedTabs(context: InternalExecutionContext, sessionView = false): ManagedTab[] {
    return [...this.tabs.values()].filter(
      (tab) =>
        tab.lifecycle !== "closed" &&
        (sessionView
          ? sessionScopeKey(tab.owner) === sessionScopeKey(context)
          : sameScope(tab.owner, context)),
    );
  }

  private canClaimUserTab(tab: ManagedTab, context: InternalExecutionContext): boolean {
    return (
      tab.origin === "user" &&
      tab.claimable &&
      tab.lifecycle !== "closed" &&
      ownedBySession(tab.owner, context)
    );
  }

  private openUserTabs(context: InternalExecutionContext): ManagedTab[] {
    return [...this.tabs.values()]
      .filter((tab) => this.canClaimUserTab(tab, context) && this.hasDiscoverableUserPage(tab))
      .sort((left, right) => Number(right.active) - Number(left.active));
  }

  private hasDiscoverableUserPage(tab: ManagedTab): boolean {
    const url = tab.guest
      ? safeStr(() => tab.guest!.getURL(), tab.cachedUrl).trim()
      : tab.cachedUrl.trim();
    // 已 mount 的 human webview 在首次导航前会以 about:blank/空 URL ready。
    // 这只是 UI 占位态，不是可供 agent 认领的用户页面；受控 tabs.list() 不受此过滤影响。
    return url.length > 0 && url !== "about:blank";
  }

  private claimTab(tab: ManagedTab, context: InternalExecutionContext): ManagedTab {
    if (!this.canClaimUserTab(tab, context)) return tab;
    tab.owner = { ...context };
    tab.claimable = false;
    // claim 只接管所有权，不改激活态；未激活的
    // human tab webview 不产帧，被 claim 后截图的 prepare 握手 3s 超时（renderer ready
    // 永不到来）。claim 即激活：与 activateTab 相同的 selectTab(tab, true) 语义——前台
    // scope 展开对应 view，后台 scope 只记录激活态，不抢用户当前会话焦点。
    this.selectTab(tab, true);
    this.log?.(
      `[browser-use] claim human tab tabId=${tab.tabId} windowId=${context.windowId} sessionId=${context.sessionId}`,
    );
    return tab;
  }

  private selectTab(tab: ManagedTab, notifyRenderer: boolean): void {
    const key = scopeKey(tab.owner);
    // 同一 browser scope 最多只能有一个 active tab；旧 attach 路径只把新 tab 设为 active，
    // 没有清掉旧 tab.active，导致 tabs.list() 可能同时返回多个 active=true。
    for (const candidate of this.tabs.values()) {
      if (!sameScope(candidate.owner, tab.owner)) continue;
      candidate.active = candidate.tabId === tab.tabId;
      this.residencyCoordinator.report(candidate.tabId, {
        selected: candidate.tabId === tab.tabId,
      });
    }
    this.activeTabByScope.set(key, tab.tabId);
    if (!notifyRenderer) return;
    this.visibilityByScope.set(key, true);
    this.onVisibilityChanged?.(true, tab.owner, tab.tabId);
    // activateTab / claim 都以 selectTab(tab, true) 收口；attach 路径走 notifyRenderer=false
    // 且已自行调用恢复，不会重复。
    this.maybeRestoreBackgroundViewport(tab);
  }

  private releaseToUser(tab: ManagedTab): void {
    if (tab.claimable) return;
    if (!tab.userOwner) {
      tab.userOwner = {
        ...tab.owner,
        requestId: `unclaimed:${randomUUID()}`,
        // 释放后必须脱离原 controlled browser scope，否则同 session 的 tabs.list() 仍会把
        // user tab 当作受控 tab；sessionId/workspaceKey 保留，供 owner session 显式重新 claim。
        browserId: "unclaimed-iab",
        browserGeneration: 0,
        turnId: undefined,
      };
    }
    const claimedScope = scopeKey(tab.owner);
    if (this.activeTabByScope.get(claimedScope) === tab.tabId) {
      this.activeTabByScope.delete(claimedScope);
    }
    if (this.defaultTabByScope.get(claimedScope) === tab.tabId) {
      this.defaultTabByScope.delete(claimedScope);
    }
    // 同一用户 tab 可被后续 runtime 再认领；释放归属必须跟随当前使用者，不能回到首次 claim 的 scope。
    tab.owner = { ...tab.userOwner, controlScopeId: tab.owner.controlScopeId };
    tab.origin = "user";
    tab.claimable = true;
    tab.lifecycle = "active";
  }

  private finalizeTabs(
    context: InternalExecutionContext,
    keep: Map<string, "handoff" | "deliverable">,
  ): void {
    // 产品语义：IAB tab 在当前 ZCode 进程内默认持久。keep 是状态标记集合，不是清理白名单；
    // 遗漏的 tab 不能当成临时页关闭：模型未显式 close 时用户页面会在 turn end 消失。
    for (const tab of this.tabs.values()) {
      if (!sameScope(tab.owner, context)) continue;
      const status = keep.get(tab.tabId);
      if (status === "handoff") tab.lifecycle = status;
      else if (status === "deliverable") {
        tab.lifecycle = status;
        this.releaseToUser(tab);
      }
    }
  }

  /**
   * tabs.list() 里 active 的唯一判定。语义是「不带 tabId 的命令会落到哪个 tab」，与 resolveTab
   * 对齐，而不是「UI 当前是否可见」——可见性有独立的 browserVisibilitySet/Get 通道。
   *
   * 必须带回退：会话在后台跑时 renderer 的 isVisible 恒为 false，只会上报
   * attachGuest({active:false})，scope 内没有任何 tab 自报 active，activeTabByScope 也是空的。
   * CLI 的 turn-end 自动截图用 tabs.find(t => t.active === true) 寻址且没有回退，于是静默跳过，
   * 用户侧表现为后台会话结束时没有截图。回退到该 scope 最近存活的 tab（与 browserVisibilitySet
   * 和 CLI 侧 tabs.selected() 的 at(-1) 回退一致）后，list 报的 active 与命令落点重新一致。
   */
  private effectiveActiveTabId(owner: InternalExecutionContext): string | undefined {
    const key = scopeKey(owner);
    const activeId = this.activeTabByScope.get(key);
    const activeTab = activeId ? this.tabs.get(activeId) : undefined;
    if (activeTab && activeTab.lifecycle !== "closed") return activeId;
    // human tab 在 claim 前只置 tab.active、不进 activeTabByScope；这种自报 active 优先于回退，
    // 且一旦命中就不再往下走，保证同 scope 只有一个 active=true。
    for (const tab of this.tabs.values()) {
      if (tab.active && tab.lifecycle !== "closed" && sameScope(tab.owner, owner)) return tab.tabId;
    }
    return this.ownedTabs(owner).at(-1)?.tabId;
  }

  private async summary(tab: ManagedTab): Promise<BrowserTabSummary> {
    // guest 重绑恢复尚未完成时，替代 guest 仍可能报告 about:blank；各状态读取点
    // 都必须保留 logical cache，不能让临时 guest URL 覆盖后续恢复事实。
    if (tab.guest && !this.guestRecoveryFlights.has(tab.tabId)) {
      tab.cachedUrl = safeStr(() => tab.guest!.getURL(), tab.cachedUrl);
      tab.cachedTitle = safeStr(() => tab.guest!.getTitle(), tab.cachedTitle);
    }
    return {
      tabId: tab.tabId,
      url: tab.cachedUrl,
      title: tab.cachedTitle,
      viewport: await this.readTabViewport(tab),
      ...(this.effectiveActiveTabId(tab.owner) === tab.tabId ? { active: true } : {}),
      ...(tab.lifecycle === "deliverable" || tab.lifecycle === "handoff"
        ? { lifecycle: tab.lifecycle }
        : {}),
    };
  }

  private async readTabViewport(tab: ManagedTab): Promise<BrowserViewportSize> {
    if (tab.viewportOverride) return { ...tab.viewportOverride };
    if (tab.backgroundViewportFallback) {
      // 前台 tab 不应停留在外台 fallback 尺寸：readTabViewport 的「fallback 存在即短路」
      // 会让残留自我强化（页面钉死在后台尺寸，窗口 resize/全屏
      // 都不跟随）。即使两个前台信号（selectTab / reportResidency）都丢失，前台 tab 的
      // 下一次 viewport 读取也必须自愈；本次仍返回 fallback，恢复在 mutation 队列中随后完成。
      if (tab.active) {
        this.maybeRestoreBackgroundViewport(tab);
      }
      return { ...tab.backgroundViewportFallback };
    }
    if (!tab.guest || safeBool(() => tab.guest!.isDestroyed(), true)) {
      return { ...DEFAULT_BACKGROUND_BROWSER_VIEWPORT };
    }
    const value = await tab.guest.executeJavaScript(
      "({ width: window.innerWidth, height: window.innerHeight })",
    );
    if (isBrowserViewportSize(value)) {
      this.naturalViewportByWindow.set(tab.owner.windowId, { ...value });
      return value;
    }

    // 后台 session 的 Browser pane 会保留 guest 但通过 display:none 隐藏，首次
    // tabs.new() 仍能 dom-ready/attach，却只得到 0×0 viewport。隐藏是展示状态，不能阻断
    // 后台 Browser 执行；临时复用同窗口最近自然尺寸，重新前台后再清除 CDP override。
    const fallback = normalizeBackgroundViewport(
      this.naturalViewportByWindow.get(tab.owner.windowId) ?? DEFAULT_BACKGROUND_BROWSER_VIEWPORT,
    );
    await this.applyBackgroundViewportFallback(tab, fallback);
    this.log?.(
      `[browser-use] applied background viewport fallback tabId=${tab.tabId} width=${fallback.width} height=${fallback.height}`,
    );
    return { ...fallback };
  }

  private userTabInfo(tab: ManagedTab): BrowserUserTabInfo {
    if (tab.guest && !this.guestRecoveryFlights.has(tab.tabId)) {
      tab.cachedUrl = safeStr(() => tab.guest!.getURL(), tab.cachedUrl);
      tab.cachedTitle = safeStr(() => tab.guest!.getTitle(), tab.cachedTitle);
    }
    return {
      id: tab.tabId,
      ...(tab.cachedUrl ? { url: tab.cachedUrl } : {}),
      ...(tab.cachedTitle ? { title: tab.cachedTitle } : {}),
    };
  }

  private withMeta(
    result: BrowserCommandResult,
    context: InternalExecutionContext,
    tab?: ManagedTab,
    lifecycleOverride?: BrowserResponseMeta["lifecycle"],
  ): BrowserCommandResult {
    // list 的只读视图可能跨实例，meta 必须描述实际返回列表，不能再次按控制作用域缩小。
    const openTabs = result.tabs ?? this.ownedTabs(context);
    const currentUrl = tab
      ? sanitizeBrowserMetaUrl(
          tab.guest ? safeStr(() => tab.guest!.getURL(), tab.cachedUrl) : tab.cachedUrl,
        )
      : undefined;
    const meta: BrowserResponseMeta = {
      browserUse: true,
      backendType: "iab",
      browserId: context.browserId,
      browserGeneration: context.browserGeneration,
      openTabIds: openTabs.map((candidate) => candidate.tabId),
      ...(tab ? { tabId: tab.tabId } : {}),
      ...(currentUrl ? { currentUrl } : {}),
      ...(lifecycleOverride
        ? { lifecycle: lifecycleOverride }
        : tab
          ? { lifecycle: tab.lifecycle }
          : {}),
    };
    return { ...result, meta };
  }

  private cancelledOrUnavailable(
    context: InternalExecutionContext,
    running: RunningRequest,
    startedAt: number,
    tab: ManagedTab,
  ): BrowserCommandResult {
    if (running.controller.signal.aborted) {
      return this.withMeta(
        this.cancelledResult(context, running.dispatched, startedAt),
        context,
        tab,
      );
    }
    return this.withMeta(
      {
        ok: false,
        error: {
          code: "backend_unavailable",
          message: "browser guest not attached (webview not ready)",
        },
        elapsedMs: Date.now() - startedAt,
      },
      context,
      tab,
    );
  }

  private unavailableTabResult(
    context: InternalExecutionContext,
    tabId: string | undefined,
    startedAt: number,
  ): BrowserCommandResult {
    return this.withMeta(
      {
        ok: false,
        error: {
          code: "backend_unavailable",
          message: tabId
            ? `browser tab '${tabId}' is not visible in the current context. ${TAB_CONTEXT_RECOVERY_HINT}`
            : "browser tab is unavailable",
        },
        elapsedMs: Date.now() - startedAt,
      },
      context,
    );
  }

  private cancelledResult(
    _context: InternalExecutionContext,
    dispatched: boolean,
    startedAt: number,
  ): BrowserCommandResult {
    return {
      ok: false,
      error: {
        code: "cancelled",
        message: dispatched
          ? "browser request cancelled after backend dispatch; side effects may have occurred"
          : "browser request cancelled before backend dispatch",
        sideEffect: dispatched ? "uncertain" : "none",
      },
      elapsedMs: Date.now() - startedAt,
    };
  }

  private abortRequest(requestId: string, context: InternalExecutionContext): boolean {
    const request = this.runningRequests.get(requestId);
    // requestId 是 correlation id，不是授权凭证；取消也必须服从完整 IAB scope。
    if (!request || !sameScope(request.context, context)) return false;
    request.controller.abort(new DOMException("aborted", "AbortError"));
    return true;
  }

  endTurn(context: InternalExecutionContext, turnId?: string): void {
    this.abortRecordings(
      (entry) =>
        sameScope(entry.context, context) &&
        (turnId === undefined || entry.context.turnId === turnId),
      "turn ended",
    );
    for (const request of this.runningRequests.values()) {
      if (
        sameScope(request.context, context) &&
        (turnId === undefined || request.context.turnId === turnId)
      ) {
        request.controller.abort(new DOMException("turn ended", "AbortError"));
      }
    }
    // turn end 只结束请求，不结束 tab。旧的“只保留最终活动页”兜底会在已有 handoff 时
    // 自动关闭后续新 tab，使页面存活依赖模型记得写 finalize JS。active/handoff tab 现在原样保留；
    // deliverable 和 claimed user tab 仍按显式生命周期约定释放控制权，但 view 不关闭。
    for (const tab of this.tabs.values()) {
      if (!sameScope(tab.owner, context)) continue;
      if (tab.lifecycle === "handoff") continue;
      if (tab.lifecycle === "deliverable" || tab.origin === "user") this.releaseToUser(tab);
    }
    // guest WebContents 在 CDP 仍 attached 时被销毁（destroyed 直达，
    // 触发路径不可枚举：React 卸载 webview / 系统行为均可达）会让 DevToolsSession 隐式析构后在途
    // 通知 UAF 掉主进程。turn 结束即 agent 不再操作，此刻主动 detach 把 CDP 暴露窗口从「tab 整个
    // 生命周期」收窄到「turn 内命令在途」；下次命令经 sendGuestCdpCommand lazy re-attach。
    for (const tab of this.tabs.values()) {
      if (!sameScope(tab.owner, context)) continue;
      this.releaseGuestCdpAfterIdle(tab, "turn ended");
    }
  }

  private async releaseGuestCdpAfterIdle(
    tab: ManagedTab,
    reason: string,
    requireReleased = false,
  ): Promise<void> {
    const guest = tab.guest;
    if (!guest || tab.guestLifecycle !== "attached") return;
    await (async () => {
      // 在途 CDP 命令（playwright cdp.send / viewport override / dialog 处理）结束后再断开，
      // 避免中途拆掉正在使用的管线；超时兜底与 runGuestTeardown 共用同一预算。
      const settled = await this.waitForGuestCdpIdle(tab, DEFAULT_GUEST_CDP_TEARDOWN_TIMEOUT_MS);
      if (!settled) {
        this.warn(
          `browser guest cdp release pending timeout tabId=${tab.tabId} ` +
            `pending=${tab.pendingCdpCommands} reason=${reason}`,
        );
      }
      // 等待期间 tab 可能已换代/关闭/再次进入命令期，此时放弃本轮释放。
      if (this.tabs.get(tab.tabId) !== tab || tab.guest !== guest) return;
      if (tab.guestLifecycle !== "attached") return;
      if (tab.pendingCdpCommands > 0) {
        if (requireReleased) throw new Error("Browser CDP commands are still running");
        return;
      }
      if (safeBool(() => guest.isDestroyed(), true)) return;
      try {
        if (!guest.debugger.isAttached()) {
          tab.cdpAttached = false;
          return;
        }
        guest.debugger.detach();
        if (requireReleased && guest.debugger.isAttached())
          throw new Error("Browser CDP is still attached");
        tab.cdpAttached = false;
        this.log?.(`[browser-use] cdp released after ${reason} tabId=${tab.tabId}`);
      } catch (error) {
        this.warn(`browser guest cdp release failed tabId=${tab.tabId} reason=${reason}`, error);
        if (requireReleased) throw error;
      }
    })();
  }

  /**
   * 命令级空闲释放：每次 CDP 命令完成后重置计时，超过 cdpIdleReleaseMs 无新命令即主动
   * detach。guest renderer 被 Chromium 杀且 render-process-gone 丢失（Electron 已知缺口，
   * 实测 destroyed 直达 + CDP attached → 主进程 UAF）的崩溃窗口集中在 turn 内命令间隙，
   * turnEnded 级释放覆盖不到；密集命令流间隔远小于阈值，不会被误打断。
   */
  private scheduleGuestCdpIdleRelease(tab: ManagedTab): void {
    if (tab.guestCdpIdleTimer) clearTimeout(tab.guestCdpIdleTimer);
    tab.guestCdpIdleTimer = setTimeout(() => {
      tab.guestCdpIdleTimer = undefined;
      this.releaseGuestCdpAfterIdle(tab, "cdp idle");
    }, this.cdpIdleReleaseMs);
  }

  private clearGuestCdpIdleRelease(tab: ManagedTab): void {
    if (tab.guestCdpIdleTimer) {
      clearTimeout(tab.guestCdpIdleTimer);
      tab.guestCdpIdleTimer = undefined;
    }
  }

  closeSession(context: InternalExecutionContext): void {
    this.abortRecordings((entry) => sameScope(entry.context, context), "session closed");
    for (const request of this.runningRequests.values()) {
      if (sameScope(request.context, context)) {
        request.controller.abort(new DOMException("session closed", "AbortError"));
      }
    }
    for (const tab of this.tabs.values()) {
      if (!sameScope(tab.owner, context)) continue;
      // session 是控制权边界，不是可见 tab 的生命边界。view 继续保留，但释放后仍绑定
      // 原 session；不能再写成全局 unclaimed，否则其它对话会通过 user.openTabs() 看到并接管。
      this.releaseToUser(tab);
      // 同 endTurn：会话结束释放 CDP，消除 guest 后续任意销毁路径上的主进程 UAF 窗口。
      this.releaseGuestCdpAfterIdle(tab, "session closed");
    }
    this.activeTabByScope.delete(scopeKey(context));
    this.defaultTabByScope.delete(scopeKey(context));
    this.sessionNames.delete(scopeKey(context));
    this.visibilityByScope.delete(scopeKey(context));
  }

  /**
   * `closeSession({ closeTabs: true })`：真正关闭该 session 名下的全部 tab。按 session 归属而非完整
   * browser scope 匹配——finalize / deliverable 已释放回该 session 的 tab 换到了 `unclaimed-iab` scope，
   * 仍归它。只给永不回来认领的 session 用（dwf 子代理，
   * docs/browser-use/2026-07-14-browser-tab-conversation-isolation-spec.md §2.3）：它的 sessionId 不是任何
   * 对话，closeSession 保留的 view 无人可见、无人可认领，只会一直挂着 guest。
   */
  private async closeSessionTabs(context: InternalExecutionContext): Promise<void> {
    const owned = [...this.tabs.values()].filter(
      (tab) =>
        tab.lifecycle !== "closed" &&
        ownedBySession(tab.owner, context) &&
        (!context.controlScopeId || tab.owner.controlScopeId === context.controlScopeId),
    );
    for (const tab of owned) await this.closeTabDurably(tab);
  }

  closeWindow(windowId: number): void {
    this.backendIdentities.delete(windowId);
    for (const [id, scope] of this.controlScopes) {
      if (scope.context.windowId === windowId) {
        scope.closed = true;
        this.controlScopes.delete(id);
      }
    }
    this.abortRecordings((entry) => entry.context.windowId === windowId, "window closed");
    for (const request of this.runningRequests.values()) {
      if (request.context.windowId === windowId) {
        request.controller.abort(new DOMException("window closed", "AbortError"));
      }
    }
    for (const tab of this.tabs.values()) {
      if (tab.owner.windowId !== windowId) continue;
      this.detachAndCloseGuest(tab);
      this.residencyCoordinator.remove(tab.tabId);
      this.restoredTabClaims.delete(tab.tabId);
      // closeWindow 走快速路径不经过 closeTab；per-tab 截图状态若不在此清理，
      // 迟到 settle 的回调会按 tabId 污染恢复流程可能复用的新 tab 计数。decrement 对
      // 已删除的 key 是 no-op，前提是条目先在这里删干净。
      this.inFlightScreenshots.delete(tab.tabId);
      this.abandonedScreenshotCaptures.delete(tab.tabId);
      this.tabs.delete(tab.tabId);
    }
    this.naturalViewportByWindow.delete(windowId);
  }

  private async removeTabRecovery(tab: ManagedTab): Promise<void> {
    await this.residencyOptions.recoveryStore?.remove(tab.tabId);
  }

  private async closeTabDurably(tab: ManagedTab, notifyRenderer = true): Promise<void> {
    if (tab.lifecycle === "closed") return;
    // 旧 close 先回命令/通知 renderer，再 fire-and-forget 删除恢复仓库；紧接着退出时
    // 已关闭 tab 会从旧 shell 复活。先完成持久删除，失败时保留当前 logical tab 供调用方重试。
    await this.removeTabRecovery(tab);
    this.closeTab(tab, notifyRenderer);
  }

  private closeTab(tab: ManagedTab, notifyRenderer = true): void {
    if (tab.lifecycle === "closed") return;
    this.abortRecordings((entry) => entry.tabId === tab.tabId, "tab closed");
    tab.lifecycle = "closed";
    this.closedTabIds.add(tab.tabId);
    // tab 已不可再执行命令；不必为一个可能永久不回包的旧 CDP capture 保留 manager 引用。
    this.inFlightScreenshots.delete(tab.tabId);
    this.abandonedScreenshotCaptures.delete(tab.tabId);
    this.resolveWaiters(tab.tabId, null);
    this.detachAndCloseGuest(tab);
    for (const [downloadId, record] of this.downloads) {
      if (record.tabId === tab.tabId) this.downloads.delete(downloadId);
    }
    this.queuedDownloads.delete(tab.tabId);
    let waiter = this.downloadWaiters.get(tab.tabId)?.[0];
    while (waiter) {
      this.finishDownloadWaiter(tab.tabId, waiter, null);
      waiter = this.downloadWaiters.get(tab.tabId)?.[0];
    }
    const key = scopeKey(tab.owner);
    if (this.activeTabByScope.get(key) === tab.tabId) this.activeTabByScope.delete(key);
    if (this.defaultTabByScope.get(key) === tab.tabId) this.defaultTabByScope.delete(key);
    if (notifyRenderer) this.onCloseTabRequested?.(tab.tabId, tab.owner);
    this.residencyCoordinator.remove(tab.tabId);
    this.restoredTabClaims.delete(tab.tabId);
    this.tabs.delete(tab.tabId);
  }

  /**
   * guest renderer 崩溃/被杀时立即断开 CDP。
   *
   * 崩溃链条（主进程 UAF，minidump 落在 DevToolsSession::DispatchProtocolNotification，
   * client_ 的 vptr 为 0）：
   *   Chromium 在内存压力下杀掉 guest renderer
   *     → render-process-gone：WebContents 仍存活，CDP 仍 attached
   *     → renderer 侧递增 webviewGeneration，React 卸载旧 <webview>
   *     → 旧 WebContents 此刻才销毁，api::Debugger 走隐式析构
   *     → DevToolsSession 仍持 client_ 派发在途通知 → UAF → 主进程崩溃 → 整个 app 退出
   *
   * 实测（Electron 41.0.3 / forcefullyCrashRenderer，带毫秒时间戳的对照实验）：
   *   - render-process-gone 时 isDestroyed()=false、isCrashed()=true、isAttached()=true，
   *     detach() 成功且随后 isAttached()=false；
   *   - destroyed 时 isCrashed()/isAttached() 全抛 "Object has been destroyed"，
   *     那里已经不可能 detach —— 所以 destroyed 兜底修不了这个 UAF；
   *   - 崩溃后若不卸载 <webview>，WebContents 无限期停在 crashed 态（10s destroyed 未到）；
   *     一旦 renderer 卸载 <webview>，destroyed 在 ~5ms 内到达。即销毁时机由 renderer 决定，
   *     native detach 的安全窗口只存在于 WebContents 销毁之前。
   * main 的 render-process-gone 是第一道守卫；renderer 重建前的显式 detach ACK 是第二道屏障，
   * 用来覆盖 main 事件未到达的现场。两者都不改变销毁时机，只保证销毁时 CDP 已经断开。
   */
  private setupCdpCrashGuard(tab: ManagedTab, guest: GuestWebContents): void {
    tab.crashGuardCleanup?.();
    if (!guest.on || !guest.removeListener) return;
    const tabId = tab.tabId;
    const onRenderProcessGone = (...args: unknown[]): void => {
      const reason = safeStr(
        () => String((args[1] as { reason?: string } | undefined)?.reason ?? "unknown"),
        "unknown",
      );
      const guestId = safeStr(() => String(guest.id), "?");
      // 不校验 tab.guest === guest：断开一个已换代 guest 的 CDP 同样正确且必要，
      // 而漏掉它就等于把 UAF 窗口留着。
      try {
        if (this.tabs.get(tabId)?.guest === guest) tab.guestLifecycle = "detaching";
        if (!guest.debugger.isAttached()) return;
        guest.debugger.detach();
        this.log?.(
          `[browser-use] cdp detached on render-process-gone tabId=${tabId} ` +
            `guestId=${guestId} reason=${reason}`,
        );
      } catch (error) {
        // 这里失败意味着 UAF 窗口没能关上，必须留痕以便与后续崩溃关联。
        this.warn(
          `browser guest cdp detach on render-process-gone failed tabId=${tabId} ` +
            `guestId=${guestId} reason=${reason}`,
          error,
        );
      } finally {
        if (this.tabs.get(tabId)?.guest === guest) tab.cdpAttached = false;
      }
    };
    guest.on("render-process-gone", onRenderProcessGone);
    tab.crashGuardCleanup = () => {
      guest.removeListener?.("render-process-gone", onRenderProcessGone);
    };
  }

  private setupDialogTracking(tab: ManagedTab, guest: GuestWebContents): void {
    const tabId = tab.tabId;
    void this.sendGuestCdpCommand(tab, guest, "Page.enable").catch((error: unknown) => {
      this.log?.(`[browser-use] Page.enable failed tabId=${tabId}: ${String(error)}`);
    });
    const onMessage = (_event: unknown, method: string, params: unknown): void => {
      const current = this.tabs.get(tabId);
      if (!current || current.guest !== guest || current.lifecycle === "closed") return;
      if (method === "Page.javascriptDialogOpening") {
        // 打点：dialog 事件到达 main 的时刻，用于区分「事件黑洞」与「dialog 已被 detach
        // 清理」两种 getDialog=null 成因。
        this.log?.(`[browser-use] dialog opening event received tabId=${tabId}`);
        const data = (params ?? {}) as {
          type?: string;
          message?: string;
          defaultPrompt?: string;
        };
        const dialog: BrowserDialog = {
          type: normalizeDialogType(data.type),
          message: typeof data.message === "string" ? data.message : "",
          ...(typeof data.defaultPrompt === "string" ? { defaultPrompt: data.defaultPrompt } : {}),
        };
        this.pendingDialogs.set(tabId, dialog);
      } else if (method === "Page.javascriptDialogClosed") {
        this.pendingDialogs.delete(tabId);
      }
    };
    guest.debugger.on("message", onMessage);
    tab.cdpMessageCleanup = () => {
      guest.debugger.removeListener("message", onMessage);
    };
  }

  private applyViewportOverride(tab: ManagedTab): void {
    const viewport = tab.viewportOverride;
    if (!viewport) return;
    void this.setTabViewport(tab, viewport).catch((error: unknown) => {
      this.log?.(`[browser-use] viewport apply failed tabId=${tab.tabId}: ${String(error)}`);
    });
  }

  private async setTabViewport(tab: ManagedTab, viewport: BrowserViewportSize): Promise<void> {
    assertViewportOverride(viewport);
    if (tab.lifecycle === "closed") return;
    tab.backgroundViewportFallback = undefined;
    tab.viewportOverride = { ...viewport };
    if (!tab.guest) return;
    const guest = tab.guest;
    await this.enqueueViewportMutation(tab, async () => {
      if (tab.guest !== guest || tab.lifecycle === "closed") return;
      await this.sendGuestCdpCommand(
        tab,
        guest,
        "Emulation.setDeviceMetricsOverride",
        buildViewportMetricsOverride(viewport),
      );
    });
  }

  private async resetTabViewport(tab: ManagedTab): Promise<void> {
    if (tab.lifecycle === "closed") return;
    tab.viewportOverride = undefined;
    tab.backgroundViewportFallback = undefined;
    if (!tab.guest) return;
    const guest = tab.guest;
    await this.enqueueViewportMutation(tab, async () => {
      if (tab.guest !== guest || tab.lifecycle === "closed") return;
      await this.sendGuestCdpCommand(tab, guest, "Emulation.clearDeviceMetricsOverride");
    });
  }

  private async applyBackgroundViewportFallback(
    tab: ManagedTab,
    viewport: BrowserViewportSize,
  ): Promise<void> {
    const guest = tab.guest;
    if (!guest || tab.lifecycle === "closed") {
      throw new Error(`browser tab '${tab.tabId}' has no readable viewport`);
    }
    const fallback = { ...viewport };
    tab.backgroundViewportFallback = fallback;
    try {
      await this.enqueueViewportMutation(tab, async () => {
        if (
          tab.guest !== guest ||
          tab.lifecycle === "closed" ||
          tab.backgroundViewportFallback !== fallback ||
          tab.viewportOverride
        ) {
          return;
        }
        await this.sendGuestCdpCommand(
          tab,
          guest,
          "Emulation.setDeviceMetricsOverride",
          buildViewportMetricsOverride(fallback),
        );
      });
    } catch (error) {
      if (tab.backgroundViewportFallback === fallback) {
        tab.backgroundViewportFallback = undefined;
      }
      throw error;
    }
  }

  /**
   * 前台激活路径的统一收口：后台 fallback viewport 不能在 tab 回到前台后残留。
   * 仅在 attachGuest({active:true}) 时清除是不够的：guest 存活期间的前台切换
   * （activateTab / claim / renderer residency 上报）不会重新 attach，页面就永久钉死在
   * 后台尺寸。restoreNaturalViewportAfterBackground 自带幂等守卫与串行 mutation 队列，
   * 多个前台信号重复触发是安全的。
   */
  private maybeRestoreBackgroundViewport(tab: ManagedTab): void {
    if (tab.lifecycle === "closed" || !tab.backgroundViewportFallback) return;
    this.restoreNaturalViewportAfterBackground(tab);
  }

  private restoreNaturalViewportAfterBackground(tab: ManagedTab): void {
    const fallback = tab.backgroundViewportFallback;
    const guest = tab.guest;
    if (!fallback || tab.viewportOverride || !guest) return;
    void this.enqueueViewportMutation(tab, async () => {
      if (
        tab.guest !== guest ||
        tab.lifecycle === "closed" ||
        tab.backgroundViewportFallback !== fallback ||
        tab.viewportOverride
      ) {
        return;
      }
      await this.sendGuestCdpCommand(tab, guest, "Emulation.clearDeviceMetricsOverride");
      if (tab.backgroundViewportFallback !== fallback || tab.viewportOverride) return;
      const value = await guest.executeJavaScript(
        "({ width: window.innerWidth, height: window.innerHeight })",
      );
      if (tab.backgroundViewportFallback !== fallback || tab.viewportOverride) return;
      if (isBrowserViewportSize(value)) {
        this.naturalViewportByWindow.set(tab.owner.windowId, { ...value });
        tab.backgroundViewportFallback = undefined;
        return;
      }
      // active=true 已到达但 Chromium 尚未完成可见布局时，继续保留 transient；下一次
      // renderer 可见 attach 或 viewport 读取仍可恢复，不能短暂退回 0×0。
      await this.sendGuestCdpCommand(
        tab,
        guest,
        "Emulation.setDeviceMetricsOverride",
        buildViewportMetricsOverride(fallback),
      );
    }).catch((error: unknown) => {
      this.log?.(
        `[browser-use] background viewport restore failed tabId=${tab.tabId}: ${String(error)}`,
      );
    });
  }

  private enqueueViewportMutation(tab: ManagedTab, mutation: () => Promise<void>): Promise<void> {
    const previous = tab.viewportMutation ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        // CDP 恢复据此在当前临界区直接重放，避免二次入队后等待自己。
        tab.insideViewportMutation = true;
        try {
          await mutation();
        } finally {
          tab.insideViewportMutation = false;
        }
      });
    tab.viewportMutation = current;
    current.then(
      () => {
        if (tab.viewportMutation === current) tab.viewportMutation = undefined;
      },
      () => {
        if (tab.viewportMutation === current) tab.viewportMutation = undefined;
      },
    );
    return current;
  }

  private setupDownloadTracking(tab: ManagedTab, guest: GuestWebContents): void {
    tab.downloadCleanup?.();
    if (!guest.session) return;
    const listener = (_event: unknown, item: GuestDownloadItem, contents: GuestWebContents) => {
      if (contents !== guest || tab.guest !== guest || tab.lifecycle === "closed") return;
      const downloadId = `iab-download:${randomUUID()}`;
      const record: DownloadRecord = {
        tabId: tab.tabId,
        path: safeStr(() => item.getSavePath(), "") || null,
        state: "pending",
      };
      this.downloads.set(downloadId, record);
      this.refreshRuntimeProtection(tab.tabId);
      item.once("done", (_event, state) => {
        record.path = safeStr(() => item.getSavePath(), "") || record.path;
        record.state =
          state === "completed" ? "completed" : state === "cancelled" ? "cancelled" : "interrupted";
        this.refreshRuntimeProtection(tab.tabId);
      });
      const waiters = this.downloadWaiters.get(tab.tabId);
      const waiter = waiters?.shift();
      if (waiter) {
        this.finishDownloadWaiter(tab.tabId, waiter, downloadId);
      } else {
        const queued = this.queuedDownloads.get(tab.tabId) ?? [];
        queued.push(downloadId);
        this.queuedDownloads.set(tab.tabId, queued);
      }
    };
    guest.session.on("will-download", listener);
    tab.downloadCleanup = () => guest.session?.removeListener("will-download", listener);
  }

  private waitForDownload(
    tabId: string,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<string | null> {
    const queued = this.queuedDownloads.get(tabId);
    const existing = queued?.shift();
    if (existing) return Promise.resolve(existing);
    if (signal.aborted) return Promise.resolve(null);
    return new Promise((resolve) => {
      const waiter = {} as DownloadWaiter;
      waiter.resolve = resolve;
      waiter.signal = signal;
      waiter.timer = setTimeout(() => this.finishDownloadWaiter(tabId, waiter, null), timeoutMs);
      waiter.onAbort = () => this.finishDownloadWaiter(tabId, waiter, null);
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      const waiters = this.downloadWaiters.get(tabId) ?? [];
      waiters.push(waiter);
      this.downloadWaiters.set(tabId, waiters);
    });
  }

  private finishDownloadWaiter(
    tabId: string,
    waiter: DownloadWaiter,
    downloadId: string | null,
  ): void {
    clearTimeout(waiter.timer);
    waiter.signal.removeEventListener("abort", waiter.onAbort);
    const waiters = this.downloadWaiters.get(tabId);
    if (waiters) {
      const index = waiters.indexOf(waiter);
      if (index >= 0) waiters.splice(index, 1);
      if (waiters.length === 0) this.downloadWaiters.delete(tabId);
    }
    waiter.resolve(downloadId);
  }

  /**
   * CDP session 态恢复式 attach：idle/turn 结束释放后再次进入命令期时调用，
   * 返回可等待的 flight——Page.enable 与 viewport override 重放完成后业务命令才允许派发。
   *
   * Page 域 enable 与 Emulation.setDeviceMetricsOverride 都是 per-session 的，
   * detach 时已被 Chromium 清空；
   * 裸 attach("1.3") 得到的是干净 session——dialog 事件黑洞（getDialog 恒 null、evaluate
   * 遇 JS dialog 挂到超时实测 62s）、viewport 仿真与 manager 缓存分叉。且 fire-and-forget
   * 重放没有等待屏障：业务命令（截图/evaluate）可能在恢复完成前执行，重放在首命令场景
   * 失效。恢复命令经 raw 发送（不走 ensure，避免自等待）；viewport 重放走既有串行队列，
   * 队列内触发恢复时直接重放，避免二次入队与当前 flight 互相等待死锁。
   */
  private async ensureGuestCdpAttached(tab: ManagedTab, guest: GuestWebContents): Promise<void> {
    if (!tab.guestCdpRestoreFlight) {
      const flight = this.runGuestCdpSessionRestore(tab, guest).finally(() => {
        if (tab.guestCdpRestoreFlight === flight) tab.guestCdpRestoreFlight = undefined;
      });
      tab.guestCdpRestoreFlight = flight;
    }
    await tab.guestCdpRestoreFlight;
  }

  private async runGuestCdpSessionRestore(tab: ManagedTab, guest: GuestWebContents): Promise<void> {
    if (!safeBool(() => guest.debugger.isAttached(), false)) {
      guest.debugger.attach("1.3");
      tab.cdpAttached = safeBool(() => guest.debugger.isAttached(), false);
      if (!tab.cdpAttached) {
        throw new Error(`browser guest cdp restore attach failed tabId=${tab.tabId}`);
      }
    }
    // 恢复失败必须上抛：屏障契约是「Page.enable 与 viewport 状态就绪后才
    // 允许业务命令派发」。吞掉异常会让后续命令见 attached 即跳过恢复——Page.enable
    // 丢失把 dialog 事件黑洞延长到整个 attach 期，且 "replayed" 日志误导排障。异常上抛
    // 前先 rollback 到 detached：半途 session 不可用，还原释放态后下一次命令才会重建
    // 恢复 flight（否则 attached=true 会让 lazy attach 跳过恢复，失败被永久固化）。
    try {
      await this.sendGuestCdpCommandRaw(tab, guest, "Page.enable");
    } catch (error) {
      this.warn(`browser guest Page.enable replay failed tabId=${tab.tabId}`, error);
      this.rollbackGuestCdpRestore(tab, guest);
      throw error;
    }
    const viewport = tab.viewportOverride ?? tab.backgroundViewportFallback;
    if (viewport) {
      try {
        const replayViewport = async () => {
          if (tab.guest !== guest || tab.lifecycle === "closed") return;
          await this.sendGuestCdpCommandRaw(
            tab,
            guest,
            "Emulation.setDeviceMetricsOverride",
            buildViewportMetricsOverride(viewport),
          );
        };
        // 截图也占用 viewport 队列，但并不重设 metrics。若把队列内 re-attach
        // 一律当作等效恢复而跳过，首张图会读到宿主缩放后的自然尺寸。
        // 已在临界区时直接重放；再次入队并等待自己会死锁。
        if (tab.insideViewportMutation) await replayViewport();
        else await this.enqueueViewportMutation(tab, replayViewport);
      } catch (error) {
        this.warn(`browser guest viewport replay failed tabId=${tab.tabId}`, error);
        this.rollbackGuestCdpRestore(tab, guest);
        throw error;
      }
    }
    this.log?.(`[browser-use] cdp session state replayed tabId=${tab.tabId} pageEnable=1`);
  }

  /** 恢复失败时把半途 session 还原为释放态；rollback 自身的失败不得掩盖原始错误。 */
  private rollbackGuestCdpRestore(tab: ManagedTab, guest: GuestWebContents): void {
    try {
      if (guest.debugger.isAttached()) guest.debugger.detach();
    } catch {
      // session 可能已销毁；cdpAttached 复位仍需完成。
    }
    tab.cdpAttached = false;
  }

  /** 恢复命令专用发送：只做 pending 计数与下发，不触发 ensure（避免自等待死锁）。 */
  private async sendGuestCdpCommandRaw(
    tab: ManagedTab,
    guest: GuestWebContents,
    method: string,
    params?: unknown,
    sessionId?: string,
  ): Promise<unknown> {
    tab.pendingCdpCommands += 1;
    try {
      const result = await guest.debugger.sendCommand(method, params, sessionId);
      if (!sessionId && tab.guest === guest) {
        // renderer 的归一化回调可能被 Electron 后续 page zoom 传播覆盖。
        // 固定 viewport 的设置和 CDP 重连都必须在同一执行边界恢复 guest zoom。
        if (method === "Emulation.setDeviceMetricsOverride" && guest.getZoomFactor() !== 1) {
          guest.setZoomFactor(1);
        }
      }
      return result;
    } finally {
      tab.pendingCdpCommands = Math.max(0, tab.pendingCdpCommands - 1);
      this.scheduleGuestCdpIdleRelease(tab);
    }
  }

  private async sendGuestCdpCommand(
    tab: ManagedTab,
    guest: GuestWebContents,
    method: string,
    params?: unknown,
    sessionId?: string,
    assertCurrentGuest?: () => void,
  ): Promise<unknown> {
    assertCurrentGuest?.();
    if (tab.guest !== guest || tab.guestLifecycle !== "attached") {
      throw new Error("browser guest is detaching");
    }
    // turnEnded/closeSession/命令空闲后 CDP 已主动释放（防 guest
    // 销毁时的主进程 UAF），命令路径在此恢复式 re-attach 并 await 会话态重放完成（显式
    // 串行屏障：Page.enable / viewport override 先于本命令被 Chromium 处理）。
    if (!safeBool(() => guest.debugger.isAttached(), false) || tab.guestCdpRestoreFlight) {
      await this.ensureGuestCdpAttached(tab, guest);
    }
    return this.sendGuestCdpCommandRaw(tab, guest, method, params, sessionId);
  }

  private toControlledView(
    guest: GuestWebContents,
    normalizeScreenshotToCssPixels = false,
    captureViewportScreenshot: ControlledView["captureViewportScreenshot"] | undefined,
    assertCurrentGuest: () => void,
    sendCdpCommand: ControlledView["cdp"]["send"],
  ): ControlledView {
    const assertCurrent = () => assertCurrentGuest();
    return {
      webContents: {
        loadURL: (url) => {
          assertCurrent();
          return guest.loadURL(url);
        },
        getURL: () => {
          assertCurrent();
          return guest.getURL();
        },
        getTitle: () => {
          assertCurrent();
          return guest.getTitle();
        },
        canGoBack: () => {
          assertCurrent();
          return guest.navigationHistory.canGoBack();
        },
        canGoForward: () => {
          assertCurrent();
          return guest.navigationHistory.canGoForward();
        },
        goBack: () => {
          assertCurrent();
          return guest.navigationHistory.goBack();
        },
        goForward: () => {
          assertCurrent();
          return guest.navigationHistory.goForward();
        },
        reload: () => {
          assertCurrent();
          return guest.reload();
        },
        executeJavaScript: (script) => {
          assertCurrent();
          return guest.executeJavaScript(script, true);
        },
        sendInputEvent: (event) => {
          assertCurrent();
          guest.sendInputEvent(event);
        },
      },
      cdp: {
        send: (method, params, sessionId) => {
          try {
            assertCurrent();
            return sendCdpCommand(method, params, sessionId);
          } catch (error) {
            // CDP consumer 会在 abort/terminate 路径上直接调用 .catch；生命周期守卫必须
            // 返回 rejected Promise，不能同步 throw 破坏该清理链路。
            return Promise.reject(error);
          }
        },
      },
      captureViewportScreenshot,
      normalizeScreenshotToCssPixels,
      resizeScreenshotToCssPixels: this.resizeScreenshotToCssPixels,
    };
  }

  private registerTabResidency(
    tab: ManagedTab,
    visible: boolean,
    residency: BrowserTabResidencyRecord["residency"] = visible
      ? "live-visible"
      : "live-background",
    lastSelectedAt: number | null = null,
  ): void {
    this.residencyCoordinator.upsert({
      tabId: tab.tabId,
      windowId: tab.owner.windowId,
      sessionId: tab.owner.sessionId,
      residency,
      guestAttached: Boolean(tab.guest && !safeBool(() => tab.guest!.isDestroyed(), true)),
      openedAt: tab.openedAt,
      lastActivityAt: tab.openedAt,
      lastSelectedAt,
      preferred: visible,
      currentTask: false,
      selected: visible,
      visible,
      operationActive: false,
      captureActive: false,
      audible: false,
      mediaActive: false,
      loading: false,
      downloadActive: false,
    });
  }

  private async closeTabForLimit(record: BrowserTabResidencyRecord): Promise<boolean> {
    const tab = this.tabs.get(record.tabId);
    if (!tab || tab.lifecycle === "closed") return true;
    try {
      // 旧的数量门禁只销毁 WebContents 并保留 suspended logical tab，
      // 因此标签栏会突破 32。必须复用 durable close，按“恢复数据 → guest → renderer tab 壳”
      // 的顺序完整关闭，避免已关闭 tab 在当前 UI 或下次启动时复活。
      await this.closeTabDurably(tab);
      this.log?.(
        `[browser-use] closed tabId=${tab.tabId} reason=tab-limit windowId=${tab.owner.windowId}`,
      );
      return true;
    } catch (error) {
      this.warn(`browser tab limit close failed tabId=${tab.tabId}`, error);
      return false;
    }
  }

  private async restoreSuspendedGuest(
    tab: ManagedTab,
    signal: AbortSignal,
  ): Promise<GuestWebContents | null> {
    if (signal.aborted) return null;
    let flight = this.restoreFlights.get(tab.tabId);
    if (!flight) {
      // 旧 single-flight 直接采用首个 caller 的 AbortSignal；首个 command 取消会
      // 毒化所有并发 caller，并把 coordinator 留在 restoring。flight 改由 tab 生命周期拥有。
      flight = this.runRestoreSuspendedGuest(tab, new AbortController().signal).finally(() => {
        if (this.restoreFlights.get(tab.tabId) === flight) this.restoreFlights.delete(tab.tabId);
      });
      this.restoreFlights.set(tab.tabId, flight);
    }
    const result = await waitForPromiseWithSignal(flight, signal);
    return result.completed ? result.value : null;
  }

  private async runRestoreSuspendedGuest(
    tab: ManagedTab,
    signal: AbortSignal,
  ): Promise<GuestWebContents | null> {
    const before = this.residencyCoordinator.get(tab.tabId);
    const transition = this.residencyCoordinator.markRestoring(tab.tabId);
    if (!transition) return null;
    if (before?.residency === "suspended") {
      const payload: BrowserViewResidencyTransitionPayload = {
        tabId: tab.tabId,
        workspaceKey: tab.owner.workspaceKey,
        remoteSessionId: tab.owner.remoteSessionId,
        sessionId: tab.owner.sessionId,
        browserId: tab.owner.browserId,
        browserGeneration: tab.owner.browserGeneration,
        generation: transition.generation,
        residency: "restoring",
      };
      if (this.residencyOptions.onRestoreTabRequested) {
        this.residencyOptions.onRestoreTabRequested(payload);
      } else {
        this.onOpenTabRequested?.(tab.tabId, tab.owner);
      }
    }

    const guest = await this.waitForGuest(tab.tabId, signal);
    if (!guest) {
      const failed = this.residencyCoordinator.failRestore(tab.tabId, transition.generation);
      if (failed) {
        // 通知 renderer 回到轻量 shell；新 generation 同时让本轮迟到 attach fail closed。
        this.residencyOptions.onSuspendTabRequested?.({
          tabId: tab.tabId,
          workspaceKey: tab.owner.workspaceKey,
          remoteSessionId: tab.owner.remoteSessionId,
          sessionId: tab.owner.sessionId,
          browserId: tab.owner.browserId,
          browserGeneration: tab.owner.browserGeneration,
          generation: failed.generation,
          residency: "suspended",
        });
      }
      return null;
    }
    const restored = await this.restoreGuestState(tab, guest);
    if (!restored && tab.restoredFromStore && !tab.cachedUrl) {
      // 仅 forced restore mount 后三类恢复事实全部缺失才清理孤儿；普通 page-state 淘汰
      // 仍会保留 restoreUrl，不得进入这个分支形成 restore/close 循环。
      await this.removeTabRecovery(tab);
      this.residencyOptions.onRecoveryOrphanCloseRequested?.({
        tabId: tab.tabId,
        reason: "recovery-orphan",
      });
      this.closeTab(tab, false);
      return null;
    }
    if (!restored) {
      // 不能只处理“恢复事实全缺失”：history 与 URL 都失败时仍提交 live 的话，
      // bootstrap/about:blank 因而被永久当成成功页面。失败必须销毁本轮 guest 并回到可重试 shell。
      const failed = this.residencyCoordinator.failRestore(tab.tabId, transition.generation);
      this.detachAndCloseGuest(tab);
      if (failed) {
        this.residencyOptions.onSuspendTabRequested?.({
          tabId: tab.tabId,
          workspaceKey: tab.owner.workspaceKey,
          remoteSessionId: tab.owner.remoteSessionId,
          sessionId: tab.owner.sessionId,
          browserId: tab.owner.browserId,
          browserGeneration: tab.owner.browserGeneration,
          generation: failed.generation,
          residency: "suspended",
        });
      }
      return null;
    }
    if (!this.residencyCoordinator.completeRestore(tab.tabId, transition.generation)) return null;
    const completed = this.residencyCoordinator.get(tab.tabId);
    if (completed) {
      // renderer 原来只收到 restoring 起点，成功后没有终态，会永久保留 restoring shell。
      this.residencyOptions.onResidencyChanged?.({
        tabId: tab.tabId,
        workspaceKey: tab.owner.workspaceKey,
        remoteSessionId: tab.owner.remoteSessionId,
        sessionId: tab.owner.sessionId,
        browserId: tab.owner.browserId,
        browserGeneration: tab.owner.browserGeneration,
        generation: completed.generation,
        residency: completed.residency === "live-visible" ? "live-visible" : "live-background",
      });
    }
    tab.restoredFromStore = false;
    await this.persistShell(tab);
    return guest;
  }

  private async restoreGuestState(tab: ManagedTab, guest: GuestWebContents): Promise<boolean> {
    const pageState = await this.residencyOptions.recoveryStore?.getPageState(tab.tabId);
    if (pageState && pageState.entries.length > 0) {
      const activePageState = pageState.entries[pageState.activeIndex];
      if (tab.cachedUrl && activePageState?.url !== tab.cachedUrl) {
        // pageState 只在预算挂起时刷新；恢复后导航会更新 shell，却留下旧快照。
        // 冷启动必须以 logical shell 的当前 URL 为准，不能把 B 回滚成快照里的 A。
        this.warn(
          `browser tab stale page-state ignored tabId=${tab.tabId} shellUrl=${tab.cachedUrl} pageStateUrl=${activePageState?.url ?? "missing"}`,
        );
        await this.residencyOptions.recoveryStore?.removePageState(tab.tabId);
      } else {
        const acceptRestoredPageState = () => {
          const active = pageState.entries[pageState.activeIndex];
          tab.cachedUrl = active?.url ?? tab.cachedUrl;
          tab.cachedTitle = active?.title ?? tab.cachedTitle;
          return true;
        };
        try {
          this.log?.(
            `[browser-use] restore page-state start tabId=${tab.tabId} index=${pageState.activeIndex} entries=${JSON.stringify(pageState.entries.map((entry) => entry.url))}`,
          );
          await guest.navigationHistory.restore({
            entries: pageState.entries.map((entry) => ({ ...entry })),
            index: pageState.activeIndex,
          });
          this.log?.(
            `[browser-use] restore page-state complete tabId=${tab.tabId} url=${safeStr(() => guest.getURL(), "")} index=${safeStr(() => String(guest.navigationHistory.getActiveIndex()), "unknown")} entries=${safeStr(() => JSON.stringify(guest.navigationHistory.getAllEntries().map((entry) => entry.url)), "unknown")}`,
          );
          return acceptRestoredPageState();
        } catch (error) {
          const restoreAppliedDespiteAbort =
            String(error).includes("ERR_ABORTED") &&
            safeBool(() => {
              const actualEntries = guest.navigationHistory.getAllEntries();
              return (
                guest.navigationHistory.getActiveIndex() === pageState.activeIndex &&
                actualEntries.length === pageState.entries.length &&
                actualEntries.every((entry, index) => entry.url === pageState.entries[index]?.url)
              );
            }, false);
          if (restoreAppliedDespiteAbort) {
            // Electron 41 会在完整历史已写入后，仍以 ERR_ABORTED 报告默认 about:blank 被取消。
            // 以实际 navigationHistory 为准，避免误删有效 pageState 并发起第二次 URL 导航。
            return acceptRestoredPageState();
          }
          this.warn(`browser tab page-state restore failed tabId=${tab.tabId}`, error);
          await this.residencyOptions.recoveryStore?.removePageState(tab.tabId);
        }
      }
    }
    if (!tab.cachedUrl) return false;
    try {
      await guest.loadURL(tab.cachedUrl);
      return true;
    } catch (error) {
      this.warn(`browser tab URL restore failed tabId=${tab.tabId}`, error);
      return false;
    }
  }

  private async restoreReboundGuest(
    tab: ManagedTab,
    guest: GuestWebContents,
  ): Promise<GuestWebContents | null> {
    if (tab.lifecycle === "closed" || tab.guest !== guest) return null;
    const restored = await this.restoreGuestState(tab, guest);
    if (tab.guest === guest) {
      // 附件 URL 会开始下载但不提交页面（ERR_ABORTED/ERR_FAILED，或 loadURL 直接 resolve）。
      // cachedUrl 曾保留这个未提交的 URL，每次 rebind 都再下载一次；这里回落为已提交 URL。
      const committedUrl = safeStr(() => guest.getURL(), tab.cachedUrl).trim();
      tab.cachedUrl = committedUrl === "about:blank" ? "" : committedUrl;
    }
    // await 期间 tab 可能被关闭；lifecycle 是可变字段，重新读取以撤销上面的收窄。
    const lifecycleAfterRestore = tab.lifecycle as TabLifecycle;
    if (!restored || lifecycleAfterRestore === "closed" || tab.guest !== guest) {
      if (lifecycleAfterRestore !== "closed" && tab.guest === guest) {
        this.warn(`browser tab guest rebind restore failed tabId=${tab.tabId}`);
      }
      return null;
    }
    this.log?.(
      `[browser-use] guest rebind restore complete tabId=${tab.tabId} url=${tab.cachedUrl}`,
    );
    await this.persistShell(tab);
    return guest;
  }

  private async persistRecoverySnapshot(tab: ManagedTab, guest: GuestWebContents): Promise<void> {
    tab.cachedUrl = safeStr(() => guest.getURL(), tab.cachedUrl);
    tab.cachedTitle = safeStr(() => guest.getTitle(), tab.cachedTitle);
    await this.persistShell(tab);
    try {
      const entries = guest.navigationHistory.getAllEntries().map((entry) => ({ ...entry }));
      if (entries.length === 0) return;
      const pageState: BrowserTabPageStateRecord = {
        schemaVersion: 1,
        tabId: tab.tabId,
        entries,
        activeIndex: guest.navigationHistory.getActiveIndex(),
        updatedAt: this.now(),
      };
      await this.residencyOptions.recoveryStore?.upsertPageState(pageState);
    } catch (error) {
      // 快照失败不能让资源预算永久突破；shell 的 restoreUrl 已先保存。
      this.warn(`browser tab page-state snapshot failed tabId=${tab.tabId}`, error);
    }
  }

  private async persistShell(tab: ManagedTab): Promise<void> {
    const store = this.residencyOptions.recoveryStore;
    if (!store || tab.lifecycle === "closed") return;
    const residency = this.residencyCoordinator.get(tab.tabId);
    const record: BrowserTabShellRecord = {
      schemaVersion: 1,
      tabId: tab.tabId,
      windowBindingId: null,
      workspaceKey: tab.owner.workspaceKey,
      ...(tab.owner.remoteSessionId ? { remoteSessionId: tab.owner.remoteSessionId } : {}),
      sessionId: tab.owner.sessionId,
      browserId: tab.owner.browserId,
      browserGeneration: tab.owner.browserGeneration,
      origin: tab.origin,
      lifecycle: tab.lifecycle,
      restoreUrl: tab.cachedUrl || null,
      title: tab.cachedTitle || null,
      faviconUrl: tab.cachedFaviconUrl,
      viewport: tab.viewportOverride ? { ...tab.viewportOverride } : null,
      openedAt: tab.openedAt,
      lastSelectedAt: residency?.lastSelectedAt ?? null,
      updatedAt: this.now(),
    };
    try {
      await store.upsert(record);
    } catch (error) {
      this.warn(`browser tab shell persist failed tabId=${tab.tabId}`, error);
    }
  }

  private requireRendererOwnedTab(
    payload: BrowserViewCloseTabRequest & { windowId: number },
    options?: { skipRemoteSession?: boolean },
  ): ManagedTab;
  private requireRendererOwnedTab(
    payload: BrowserViewResidencyReportPayload & { windowId: number },
    options?: { skipRemoteSession?: boolean },
  ): ManagedTab;
  private requireRendererOwnedTab(
    payload:
      | (BrowserViewCloseTabRequest & { windowId: number })
      | (BrowserViewResidencyReportPayload & { windowId: number }),
    options?: { skipRemoteSession?: boolean },
  ): ManagedTab {
    const tab = this.tabs.get(payload.tabId);
    if (
      !tab ||
      tab.lifecycle === "closed" ||
      tab.owner.windowId !== payload.windowId ||
      tab.owner.workspaceKey !== payload.workspaceKey ||
      tab.owner.sessionId !== payload.sessionId ||
      (!options?.skipRemoteSession &&
        (tab.owner.remoteSessionId ?? "") !== (payload.remoteSessionId ?? ""))
    ) {
      throw new Error(`browser tab '${payload.tabId}' is unavailable for renderer scope`);
    }
    return tab;
  }

  private setupActivityTracking(tab: ManagedTab, guest: GuestWebContents): void {
    tab.activityCleanup?.();
    if (!guest.on || !guest.removeListener) return;
    const onLoadingStarted = () => {
      if (tab.guest !== guest) return;
      tab.loading = true;
      this.refreshRuntimeProtection(tab.tabId);
    };
    const onLoadingStopped = () => {
      if (tab.guest !== guest) return;
      tab.loading = false;
      if (!this.guestRecoveryFlights.has(tab.tabId)) {
        tab.cachedUrl = safeStr(() => guest.getURL(), tab.cachedUrl);
        tab.cachedTitle = safeStr(() => guest.getTitle(), tab.cachedTitle);
      }
      this.refreshRuntimeProtection(tab.tabId);
      void this.persistShell(tab);
    };
    const onAudioChanged = () => this.refreshRuntimeProtection(tab.tabId);
    const onMediaStarted = () => {
      if (tab.guest !== guest) return;
      tab.mediaActive = true;
      this.refreshRuntimeProtection(tab.tabId);
    };
    const onMediaPaused = () => {
      if (tab.guest !== guest) return;
      tab.mediaActive = false;
      this.refreshRuntimeProtection(tab.tabId);
    };
    guest.on("did-start-loading", onLoadingStarted);
    guest.on("did-stop-loading", onLoadingStopped);
    guest.on("audio-state-changed", onAudioChanged);
    guest.on("media-started-playing", onMediaStarted);
    guest.on("media-paused", onMediaPaused);
    tab.activityCleanup = () => {
      guest.removeListener?.("did-start-loading", onLoadingStarted);
      guest.removeListener?.("did-stop-loading", onLoadingStopped);
      guest.removeListener?.("audio-state-changed", onAudioChanged);
      guest.removeListener?.("media-started-playing", onMediaStarted);
      guest.removeListener?.("media-paused", onMediaPaused);
    };
  }

  private refreshRuntimeProtection(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    this.residencyCoordinator.report(tabId, {
      loading: tab.loading,
      operationActive: this.hasRunningRequestForTab(tabId),
      captureActive: this.isTabCaptureActive(tab),
      audible: safeBool(() => tab.guest?.isCurrentlyAudible?.() ?? false, false),
      mediaActive: tab.mediaActive,
      downloadActive: this.hasPendingDownloadForTab(tabId),
    });
  }

  private hasRunningRequestForTab(tabId: string): boolean {
    return [...this.runningRequests.values()].some((request) => request.tabId === tabId);
  }

  private isTabCaptureActive(tab: ManagedTab): boolean {
    return (
      this.inFlightScreenshots.has(tab.tabId) ||
      [...this.recordings.values()].some(
        (entry) => entry.tabId === tab.tabId && entry.status === "running",
      ) ||
      safeBool(() => tab.guest?.isBeingCaptured?.() ?? false, false)
    );
  }

  private hasPendingDownloadForTab(tabId: string): boolean {
    return [...this.downloads.values()].some(
      (record) => record.tabId === tabId && record.state === "pending",
    );
  }

  private detachAndCloseGuest(tab: ManagedTab): void {
    const guest = tab.guest;
    // 先 close 会让 destroyed 事件与后续 listener cleanup 都落在已销毁对象上，
    // Electron 会持续打印 "Object has been destroyed"。先拆 CDP/session/listener，再关闭保存的
    // WebContents 引用，既释放真实 renderer，也不会改变 logical tab 的生命周期。
    this.detachGuest(tab);
    this.closeGuestWebContents(tab, guest);
  }

  private rejectGuestAttach(
    tab: ManagedTab,
    guest: GuestWebContents,
    reason: BrowserGuestAttachRejectReason,
  ): BrowserGuestAttachResult {
    // scope/session 不匹配过去只 return，renderer 不知道拒绝原因，waitForGuest
    // 只能等满 timeout；同时被拒绝的 incoming guest 没有统一清理，可能留下 orphan WebContents。
    const recoveryRequested = this.requestGuestRebind(tab, reason);
    if (tab.guest !== guest) this.closeGuestWebContents(tab, guest);
    return { ok: false, reason, recoveryRequested };
  }

  private requestGuestRebind(tab: ManagedTab, reason: GuestRecoveryReason): boolean {
    tab.attachFailure = reason;
    // human tab 的 guest 只能由所属 workspace 里已有的 Browser shell 创建。Ready 是 Browser Use
    // 事件，renderer 会在当前 workspace 为同一 tabId 新建隐藏的 browser-use shell 并恢复页面，
    // 曾导致切走 workspace 后在后台反复请求附件 URL。shell 重新挂载 attach 时由 attachFailure 恢复。
    if (this.isUserOwnedTab(tab)) return false;
    if (tab.lifecycle === "closed" || tab.rebindRequested || !this.onOpenTabRequested) return false;
    tab.rebindRequested = true;
    this.log?.(`[browser-use] request guest rebind tabId=${tab.tabId} reason=${reason}`);
    this.onOpenTabRequested?.(tab.tabId, tab.owner);
    return true;
  }

  private isUserOwnedTab(tab: ManagedTab): boolean {
    return tab.userOwner !== undefined && tab.owner.requestId === tab.userOwner.requestId;
  }

  private closeGuestWebContents(tab: ManagedTab, guest = tab.guest): void {
    if (!guest || safeBool(() => guest.isDestroyed(), true)) return;
    try {
      guest.close({ waitForBeforeUnload: false });
    } catch (error) {
      this.warn(`browser guest close failed tabId=${tab.tabId}`, error);
    }
  }

  private now(): number {
    return this.residencyOptions.now?.() ?? Date.now();
  }

  private warn(message: string, error?: unknown): void {
    const suffix =
      error === undefined ? "" : ` error=${error instanceof Error ? error.message : String(error)}`;
    this.residencyOptions.warn?.(`${message}${suffix}`);
    this.log?.(`[browser-use] ${message}${suffix}`);
  }

  detach(key: string): void {
    const tab = this.tabs.get(key);
    if (tab) this.detachGuest(tab);
  }

  /**
   * renderer 即将用 React key 替换 `<webview>` 时，先关闭旧 guest 的 native CDP 通路。
   *
   * Electron 的 `render-process-gone` 并非每次都会先到达 main 的 WebContents
   * 监听；renderer 若直接卸载节点，`destroyed` 才到达时已无法调用 debugger.detach()，
   * DevToolsSession 仍可能向已析构 client 派发在途通知并触发主进程 UAF。这里把 DOM 销毁
   * 变成 main ACK 之后的第二阶段，并用 sender window + 当前 guest id 双重校验，避免迟到
   * 的旧代事件断开刚接管 tab 的新 guest。
   */
  async detachGuestBeforeReplacement(
    tabId: string,
    webContentsId: number,
    windowId: number,
  ): Promise<boolean> {
    const tab = this.tabs.get(tabId);
    if (!tab) return true;
    if (tab.owner.windowId !== windowId) {
      this.log?.(
        `[browser-use] detachGuestBeforeReplacement rejected tabId=${tabId} ` +
          `guestId=${webContentsId} reason=window-mismatch`,
      );
      return false;
    }

    const guest = tab.guest;
    if (!guest) return true;
    const guestIdMatches = safeBool(() => guest.id === webContentsId, false);
    if (!guestIdMatches) {
      this.log?.(
        `[browser-use] detachGuestBeforeReplacement rejected tabId=${tabId} ` +
          `guestId=${webContentsId} reason=guest-mismatch`,
      );
      return false;
    }
    if (safeBool(() => guest.isDestroyed(), true)) {
      // destroyed 后 native detach 已经没有安全窗口；只有先前确认过 CDP 已断开才允许换代。
      if (tab.cdpAttached) {
        this.log?.(
          `[browser-use] detachGuestBeforeReplacement rejected tabId=${tabId} ` +
            `guestId=${webContentsId} reason=destroyed-with-cdp`,
        );
        return false;
      }
      this.detachGuest(tab);
      return true;
    }

    return this.beginGuestTeardown(tab, guest, "renderer replacement");
  }

  private beginGuestTeardown(
    tab: ManagedTab,
    guest: GuestWebContents,
    reason: string,
  ): Promise<boolean> {
    const existing = tab.guestTeardownFlight;
    if (existing) return existing;
    const flight = this.runGuestTeardown(tab, guest, reason);
    tab.guestTeardownFlight = flight;
    const clearFlight = () => {
      if (tab.guestTeardownFlight === flight) tab.guestTeardownFlight = undefined;
    };
    void flight.then(clearFlight, clearFlight);
    return flight;
  }

  private async runGuestTeardown(
    tab: ManagedTab,
    guest: GuestWebContents,
    reason: string,
  ): Promise<boolean> {
    if (tab.guest !== guest) return !tab.cdpAttached;
    tab.guestLifecycle = "detaching";

    // 先停止新的 request/recording 进入 CDP；已经下发的请求仍由 pendingCdpCommands
    // 计数保护，直到真实 Promise settle。这样外层取消不会把 native command 误判成已结束。
    for (const request of this.runningRequests.values()) {
      if (request.tabId !== tab.tabId) continue;
      request.controller.abort(new DOMException(`browser guest ${reason}`, "AbortError"));
    }
    this.abortRecordings((entry) => entry.tabId === tab.tabId, `browser guest ${reason}`);

    const pendingAtStart = tab.pendingCdpCommands;
    const settled = await this.waitForGuestCdpIdle(tab, DEFAULT_GUEST_CDP_TEARDOWN_TIMEOUT_MS);
    if (!settled) {
      this.warn(
        `browser guest teardown cdp pending timeout tabId=${tab.tabId} ` +
          `pending=${tab.pendingCdpCommands} started=${pendingAtStart} reason=${reason}`,
      );
    }

    // destroyed 事件可能在等待期间先到达；此时 detachGuest 已经完成了 JS 侧收口，但 native
    // detach 只有在 cdpAttached=false 时才可认为安全。
    if (tab.guest !== guest) return !tab.cdpAttached;
    if (safeBool(() => guest.isDestroyed(), true)) {
      if (tab.cdpAttached) {
        this.log?.(
          `[browser-use] guest teardown rejected on destroyed guest tabId=${tab.tabId} ` +
            `guestId=${safeStr(() => String(guest.id), "?")}`,
        );
        return false;
      }
      this.detachGuest(tab);
      return true;
    }

    try {
      if (guest.debugger.isAttached()) guest.debugger.detach();
      if (guest.debugger.isAttached()) {
        this.warn(
          `browser guest replacement cdp detach not confirmed tabId=${tab.tabId} ` +
            `guestId=${safeStr(() => String(guest.id), "?")}`,
        );
        return false;
      }
    } catch (error) {
      // fail closed：detach 失败时保留旧节点，不能用“继续重建”重新打开已知的 native UAF 窗口。
      this.warn(
        `browser guest replacement cdp detach failed tabId=${tab.tabId} ` +
          `guestId=${safeStr(() => String(guest.id), "?")}`,
        error,
      );
      if (tab.guest === guest && !safeBool(() => guest.isDestroyed(), true)) {
        tab.guestLifecycle = "attached";
      }
      return false;
    }

    this.log?.(
      `[browser-use] cdp detached before guest replacement tabId=${tab.tabId} ` +
        `guestId=${safeStr(() => String(guest.id), "?")}`,
    );
    tab.cdpAttached = false;
    tab.guestLifecycle = "detached";
    this.detachGuest(tab);
    return true;
  }

  private async waitForGuestCdpIdle(tab: ManagedTab, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (tab.pendingCdpCommands > 0 && Date.now() < deadline) {
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(10, deadline - Date.now())),
      );
    }
    return tab.pendingCdpCommands === 0;
  }

  /** 内存诊断计数器；只读 size。 */
  collectMemoryDiagnostics(): Record<string, number> {
    return { tabs: this.tabs.size, closedTabIds: this.closedTabIds.size };
  }

  private detachGuest(tab: ManagedTab): void {
    const guest = tab.guest;
    const guestDestroyed = guest ? safeBool(() => guest.isDestroyed(), true) : true;
    if (guest && !this.guestRecoveryFlights.has(tab.tabId)) {
      tab.cachedUrl = safeStr(() => guest.getURL(), tab.cachedUrl);
      tab.cachedTitle = safeStr(() => guest.getTitle(), tab.cachedTitle);
    }
    this.pendingDialogs.delete(tab.tabId);
    try {
      // Electron 会在 renderer 卸载 <webview> 时先销毁 guest；此时 listener 已随对象释放，
      // 再调用 session.removeListener 只会产生无意义的 "Object has been destroyed" 日志。
      if (!guestDestroyed) tab.downloadCleanup?.();
    } catch (error) {
      // guest renderer 被 Chromium 杀死后，旧 session 的 removeListener 也会抛
      // "Object has been destroyed"；清理失败不能阻断替代 guest 的 CDP 重新绑定。
      this.log?.(
        `[browser-use] detachGuest download cleanup failed tabId=${tab.tabId} error=${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      tab.downloadCleanup = undefined;
    }
    try {
      if (!guestDestroyed) tab.activityCleanup?.();
    } catch {
      // guest 已销毁时 listener cleanup 可能失败；residency 状态仍需继续收口。
    } finally {
      tab.activityCleanup = undefined;
      tab.loading = false;
      tab.mediaActive = false;
    }
    // 崩溃守卫的注销不能受 guestDestroyed 约束：removeListener 是纯 JS 侧操作，
    // 而这里的 guest 引用在换代场景下往往还活着，漏掉就会让监听随代际累积。
    try {
      tab.crashGuardCleanup?.();
    } catch {
      // guest 已销毁时 removeListener 可能抛 "Object has been destroyed"，不影响收口。
    } finally {
      tab.crashGuardCleanup = undefined;
    }
    // JS 层监听清理：guest 换代/销毁后旧 "message" 监听不该继续挂着。这一步与 native 侧的
    // CDP 断开无关（DevToolsSession 派发不查 JS 监听），纯粹是防止监听随 guest 代际累积。
    const cdpWasAttached = tab.cdpAttached;
    try {
      tab.cdpMessageCleanup?.();
    } catch (error) {
      this.log?.(
        `[browser-use] detachGuest cdp message cleanup failed tabId=${tab.tabId} error=${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      tab.cdpMessageCleanup = undefined;
    }
    if (guest) {
      const guestId = safeStr(() => String(guest.id), "?");
      if (guestDestroyed) {
        // guest 先于 detach 被销毁（destroyed 回调 / renderer 卸载 webview）。此时 detach()
        // 必抛且无意义：native DevToolsAgentHost 已随 WebContents 一起收口，主进程只能被动
        // 接受这个结果。而崩溃现场（DevToolsSession::DispatchProtocolNotification 里 client_
        // vptr=0）正落在「CDP 未经主动 detach 就走隐式析构」之后，所以这条路径必须留痕 ——
        // 否则日志里完全看不到它发生过，无法把崩溃与具体 tab 生命周期对上。
        if (cdpWasAttached) {
          this.log?.(
            `[browser-use] detachGuest cdp still attached on destroyed guest ` +
              `tabId=${tab.tabId} guestId=${guestId}`,
          );
        }
      } else {
        try {
          if (guest.debugger.isAttached()) guest.debugger.detach();
        } catch (error) {
          // 这里不能静默吞掉：detach 失败与成功在日志上无法区分 —— 而「本该能主动 detach
          // 却失败了」正是需要与崩溃关联的信号。
          this.warn(`browser guest cdp detach failed tabId=${tab.tabId} guestId=${guestId}`, error);
        }
      }
    }
    this.clearGuestCdpIdleRelease(tab);
    tab.guest = undefined;
    tab.cdpAttached = false;
    tab.guestLifecycle = guestDestroyed ? "destroyed" : "detached";
    tab.backgroundViewportFallback = undefined;
    tab.viewportMutation = undefined;
    this.residencyCoordinator.markDetached(tab.tabId);
    this.refreshRuntimeProtection(tab.tabId);
  }

  hasGuest(key: string): boolean {
    const tab = this.tabs.get(key);
    return Boolean(tab?.guest && tab.lifecycle !== "closed");
  }

  disposeAll(): void {
    for (const scope of this.controlScopes.values()) scope.closed = true;
    this.controlScopes.clear();
    this.backendIdentities.clear();
    for (const request of this.runningRequests.values()) {
      request.controller.abort(new DOMException("browser manager disposed", "AbortError"));
    }
    for (const tab of this.tabs.values()) this.closeTab(tab, false);
    for (const key of this.waiters.keys()) this.resolveWaiters(key, null);
    this.tabs.clear();
    this.closedTabIds.clear();
    this.activeTabByScope.clear();
    this.defaultTabByScope.clear();
    this.sessionNames.clear();
    this.naturalViewportByWindow.clear();
    for (const [tabId, waiters] of this.downloadWaiters) {
      let waiter = waiters[0];
      while (waiter) {
        this.finishDownloadWaiter(tabId, waiter, null);
        waiter = waiters[0];
      }
    }
    this.downloads.clear();
    this.queuedDownloads.clear();
    this.inFlightScreenshots.clear();
    this.abandonedScreenshotCaptures.clear();
    for (const entry of this.recordings.values()) {
      entry.controller.abort(new DOMException("browser manager disposed", "AbortError"));
      if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer);
      if (entry.artifact?.path)
        void rm(entry.artifact.path, { force: true }).catch(() => undefined);
    }
    this.recordings.clear();
    this.residencyCoordinator.dispose();
    this.restoredTabClaims.clear();
    for (const resolve of this.suspendAckWaiters.values()) resolve();
    this.suspendAckWaiters.clear();
    this.suspendFlights.clear();
    this.restoreFlights.clear();
    this.guestRecoveryFlights.clear();
    this.guestAttachFlights.clear();
  }

  private waitForGuest(tabId: string, signal?: AbortSignal): Promise<GuestWebContents | null> {
    if (signal?.aborted) return Promise.resolve(null);
    return new Promise<GuestWebContents | null>((resolve) => {
      const waiter: PendingWaiter = {
        resolve,
        timer: setTimeout(() => {
          this.removeWaiter(tabId, waiter);
          this.log?.(`[browser-use] waitForGuest timeout tabId=${tabId}`);
          resolve(null);
        }, this.attachTimeoutMs),
        signal,
      };
      waiter.onAbort = () => {
        this.removeWaiter(tabId, waiter);
        resolve(null);
      };
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      const list = this.waiters.get(tabId) ?? [];
      list.push(waiter);
      this.waiters.set(tabId, list);
    });
  }

  private removeWaiter(tabId: string, waiter: PendingWaiter): void {
    clearTimeout(waiter.timer);
    if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort);
    const list = this.waiters.get(tabId);
    if (!list) return;
    const index = list.indexOf(waiter);
    if (index >= 0) list.splice(index, 1);
    if (list.length === 0) this.waiters.delete(tabId);
  }

  private resolveWaiters(tabId: string, guest: GuestWebContents | null): void {
    const list = this.waiters.get(tabId);
    if (!list) return;
    this.waiters.delete(tabId);
    for (const waiter of list) {
      clearTimeout(waiter.timer);
      if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort);
      waiter.resolve(guest);
    }
  }
}

function linkAbortSignal(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (!signal) return () => undefined;
  const abort = () => controller.abort(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

function waitForPromiseWithSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<{ completed: true; value: T } | { completed: false }> {
  if (signal.aborted) return Promise.resolve({ completed: false });
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ completed: false });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ completed: true, value });
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function waitForDelay(timeoutMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (completed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(completed);
    };
    const timer = setTimeout(() => finish(true), timeoutMs);
    const onAbort = () => finish(false);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<"matched" | "timeout" | "cancelled"> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal.aborted) return "cancelled";
    if (predicate()) return "matched";
    const remaining = deadline - Date.now();
    if (remaining <= 0) return "timeout";
    if (!(await waitForDelay(Math.min(50, remaining), signal))) return "cancelled";
  }
}

function readScreenshotSurfaceInvalidation(signal: AbortSignal | undefined): Error | undefined {
  if (!signal?.aborted) return undefined;
  if (signal.reason instanceof Error) return signal.reason;
  return new Error("browser screenshot activity was invalidated");
}

async function raceBackendExecution(
  execution: Promise<BrowserCommandResult>,
  signal: AbortSignal,
  command: BrowserCommand,
  startedAt: number,
): Promise<BrowserCommandResult> {
  if (signal.aborted) {
    return {
      ok: false,
      error: {
        code: "cancelled",
        message: "browser request cancelled after backend dispatch; side effects may have occurred",
        sideEffect: isSideEffecting(command) ? "uncertain" : "none",
      },
      elapsedMs: Date.now() - startedAt,
    };
  }
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (result: BrowserCommandResult) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = () =>
      finish({
        ok: false,
        error: {
          code: "cancelled",
          message: isSideEffecting(command)
            ? "browser request cancelled after backend dispatch; side effects may have occurred"
            : "browser request cancelled",
          sideEffect: isSideEffecting(command) ? "uncertain" : "none",
        },
        elapsedMs: Date.now() - startedAt,
      });
    signal.addEventListener("abort", onAbort, { once: true });
    execution.then(finish, (error: unknown) =>
      finish({
        ok: false,
        error: {
          code: "execution_error",
          message: error instanceof Error ? error.message : String(error),
        },
        elapsedMs: Date.now() - startedAt,
      }),
    );
  });
}

function isBrowserViewportSize(value: unknown): value is BrowserViewportSize {
  if (!value || typeof value !== "object") return false;
  const viewport = value as Record<string, unknown>;
  return (
    Number.isInteger(viewport.width) &&
    Number(viewport.width) > 0 &&
    Number.isInteger(viewport.height) &&
    Number(viewport.height) > 0
  );
}

function isBrowserPointValue(value: unknown): value is { x: number; y: number } {
  if (!value || typeof value !== "object") return false;
  const point = value as Record<string, unknown>;
  return typeof point.x === "number" && typeof point.y === "number";
}

function abortError(): DOMException {
  return new DOMException("Browser recording cancelled", "AbortError");
}

function normalizeBackgroundViewport(viewport: BrowserViewportSize): BrowserViewportSize {
  return {
    width: Math.min(
      BROWSER_VIEWPORT_LIMITS.maxWidth,
      Math.max(BROWSER_VIEWPORT_LIMITS.minWidth, viewport.width),
    ),
    height: Math.min(
      BROWSER_VIEWPORT_LIMITS.maxHeight,
      Math.max(BROWSER_VIEWPORT_LIMITS.minHeight, viewport.height),
    ),
  };
}

function isScreenshotCommand(command: BrowserCommand): boolean {
  return (
    command.method === "screenshot" ||
    (command.method === "playwright" && command.action.name === "elementScreenshot")
  );
}

function assertViewportOverride(viewport: BrowserViewportSize): void {
  if (
    !Number.isInteger(viewport.width) ||
    viewport.width < BROWSER_VIEWPORT_LIMITS.minWidth ||
    viewport.width > BROWSER_VIEWPORT_LIMITS.maxWidth ||
    !Number.isInteger(viewport.height) ||
    viewport.height < BROWSER_VIEWPORT_LIMITS.minHeight ||
    viewport.height > BROWSER_VIEWPORT_LIMITS.maxHeight
  ) {
    throw new Error("browser viewport is outside the supported free-size range");
  }
}

function safeStr(fn: () => string, fallback: string): string {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function safeBool(fn: () => boolean, fallback: boolean): boolean {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function normalizeDialogType(type: string | undefined): BrowserDialog["type"] {
  switch (type) {
    case "alert":
    case "confirm":
    case "prompt":
    case "beforeunload":
      return type;
    default:
      return "alert";
  }
}

/** Browser response meta 会进入模型轨迹和调试日志；只保留 origin/path，绝不携带 credential/query/hash。 */
export function sanitizeBrowserMetaUrl(value: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    const sanitized = url.toString();
    return url.pathname === "/" ? sanitized.slice(0, -1) : sanitized;
  } catch {
    // about:blank 等合法 opaque URL 也可由 URL 解析；无法解析的页面内部串不应进入 meta。
    return undefined;
  }
}
