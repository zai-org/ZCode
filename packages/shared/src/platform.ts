/* eslint-disable max-lines -- 跨端 platform contract 集中声明 renderer 能力；OAuth 与 browser lifecycle 必须保持 desktop/web 类型合同，本 MR 不拆分平台边界。 */
import type {
  DockerConnectOptions,
  RemoteTarget,
  SSHConnectOptions,
  WSLConnectOptions,
} from "./remoteTarget.js";
import type { PluginSandboxPlatformPort } from "./mcp-apps/contract.js";
import type {
  LoadCliMcpFromUserDirectoryRequest,
  LoadCliMcpFromUserDirectoryResult,
  MigrateLegacyCommonMcpRequest,
  MigrateLegacyCommonMcpResult,
  SaveCliMcpToUserDirectoryRequest,
} from "./mcp.js";
import type { OAuthStateRegistration } from "./oauth.js";
import type {
  WebRemoteControlAuthStateChange,
  WebRemoteControlContext,
  WebRemoteControlReconnectWorkspaceResult,
  WebRemoteControlStartOperationResult,
  WebRemoteControlStatus,
  WebRemoteControlReconnectWorkspaceRequest,
  WebRemoteControlWorkspaceTarget,
} from "./web-remote-control.js";
import type {
  WebRemoteControlRendererActionRequest,
  WebRemoteControlRendererActionResult,
} from "#src/web-remote-relay/index.js";
import type { AppSettings, Locale } from "./protocol.js";
import type {
  ExtensionNotificationClick,
  ExtensionNotificationPayload,
  NotificationsShowResult,
} from "#src/extension-host/notifications.js";
import type {
  ArmsCustomEventPayload,
  RendererTelemetryEventPayload,
  TelemetryRendererContext,
} from "./telemetry.js";
import type {
  RendererActionTraceBatchV1,
  RendererActionTraceConfigV1,
} from "./rendererActionTrace.js";
import type { RendererHeapSample } from "./validation.js";
import type {
  CuaAccessibilitySettingsResult,
  OpenCuaPermissionOnboardingOptions,
  PrepareCuaHelperPermissionDragResult,
} from "./cuaAccessibilitySettings.js";
import type { BrowserViewportSize } from "./browser-use/command-metadata.js";
import type {
  PostUpdateReleaseNotesPayload,
  UpdateCheckResultPayload,
  UpdateStatePayload,
} from "./update.js";
export type {
  PostUpdateReleaseNotesPayload,
  UpdateCheckResultPayload,
  UpdateStatePayload,
} from "./update.js";

export interface AppNavigationTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
}
export type AppNavigationResult =
  | { status: "opened"; uiTarget?: string }
  | { status: "unavailable"; reason?: string; uiTarget?: string };
export type AppNavigationHandler = (
  target: AppNavigationTarget,
  signal: AbortSignal,
) => Promise<AppNavigationResult>;

export interface TaskNotificationPayload {
  taskId: string;
  status: "completed" | "failed" | "permission_request" | "elicitation_request" | "feedback_update";
  requestId?: string;
  title: string;
  body: string;
}

/** Main 将一次能够定位真实 tab 的 browser-use 操作投递给其 origin renderer。 */
export interface BrowserViewOperationPayload {
  workspaceKey: string;
  remoteSessionId?: string;
  sessionId: string;
  tabId: string;
  browserId: string;
  browserGeneration: number;
  /** 当前模型命令会打开、激活或改变 Browser 布局，renderer 应重建 resize observation baseline。 */
  resetsResizeBaseline?: boolean;
}

export type BrowserTabResidencyState =
  | "live-visible"
  | "live-background"
  | "suspend-pending"
  | "suspended"
  | "restoring";

/** 仅用于创建尚未提交首个 navigation entry 的 residency restore guest。 */
export const BROWSER_VIEW_RESTORE_BOOTSTRAP_URL = "zcode-browser-restore://pending";

/** Renderer 上报 tab shell 的展示事实；windowId 必须由 main 绑定可信 IPC sender。 */
export interface BrowserViewResidencyReportPayload {
  tabId: string;
  workspaceKey: string;
  remoteSessionId?: string;
  sessionId: string;
  selected: boolean;
  visible: boolean;
  currentTask: boolean;
  loading: boolean;
  restoreUrl?: string | null;
  title?: string | null;
  faviconUrl?: string | null;
}

export interface BrowserViewResidencyTransitionPayload {
  tabId: string;
  workspaceKey: string;
  remoteSessionId: string | undefined;
  sessionId: string;
  browserId: string;
  browserGeneration: number;
  generation: number;
  residency: Extract<
    BrowserTabResidencyState,
    "live-visible" | "live-background" | "suspended" | "restoring"
  >;
}

export interface BrowserViewCloseTabRequest {
  tabId: string;
  workspaceKey: string;
  remoteSessionId?: string;
  sessionId: string;
}

export const BROWSER_VIEW_DRAFT_SESSION_ID = "unscoped";

export interface BrowserViewPromoteDraftTabsRequest {
  tabIds: string[];
  workspaceKey: string;
  remoteSessionId?: string;
  sessionId: string;
}

export const LOCAL_MEDIA_PREVIEW_SCHEME = "zcode-media";
export const BROWSER_LOCAL_PREVIEW_SCHEME = "zcode-html";

/** 仅还原展示/外部打开地址；目录授权和签名校验始终由 main 执行。 */
export function browserPreviewSourceUrl(input: string): string {
  try {
    const url = new URL(input);
    if (url.protocol !== `${BROWSER_LOCAL_PREVIEW_SCHEME}:`) return input;
    const [, directory, ...segments] = url.pathname.split("/");
    const root = new URL(decodeURIComponent(directory ?? ""));
    if (root.protocol !== "file:" || root.host || !root.pathname.endsWith("/")) return input;
    const source = new URL(segments.join("/"), root);
    if (!source.href.startsWith(root.href)) return input;
    source.search = url.search;
    source.hash = url.hash;
    return source.href;
  } catch {
    return input;
  }
}

export function buildLocalMediaPreviewUrl(path: string): string {
  const url = new URL(`${LOCAL_MEDIA_PREVIEW_SCHEME}://local/preview`);
  url.searchParams.set("path", path);
  return url.toString();
}

/**
 * main→renderer 的关闭通知。
 *
 * 旧 payload 只有 tabId，renderer 只能在“当前活跃 workspace”的 side pane 状态里查找；
 * 用户已切到别的 workspace 时通知会被静默丢弃，原 workspace 的持久化状态里留下关不掉的幽灵 tab。
 * 带上 owner scope 后，renderer 可以直接定位到对应 workspace 的 side pane 内存删除该 tab。
 * scope 字段可缺省：recovery-orphan 等内部路径只有 tabId，renderer 此时退回“仅当前 workspace”语义。
 */
export interface BrowserViewCloseTabNotification {
  tabId: string;
  workspaceKey?: string;
  remoteSessionId?: string;
  sessionId?: string;
  reason?: "recovery-orphan";
}

/** 跨重启先恢复 logical shell；renderer 初始不得一次 mount 全部 guest。 */
export interface BrowserViewRestoredTabShell {
  tabId: string;
  workspaceKey: string;
  remoteSessionId?: string;
  sessionId: string;
  browserId: string;
  browserGeneration: number;
  origin: "agent" | "user";
  restoreUrl: string | null;
  title: string | null;
  faviconUrl: string | null;
  openedAt: number;
  lastSelectedAt: number | null;
}

export interface BrowserViewRestoreTabsRequest {
  workspaceKey: string;
  remoteSessionId?: string;
  sessionId?: string;
}

/** Main 将 Agent viewport 变更定向投递给目标 tab 的 origin renderer。 */
export interface BrowserViewViewportChangedPayload extends BrowserViewOperationPayload {
  viewport: BrowserViewportSize | null;
}

// 旧默认预算 1500ms 在慢机器或后台窗口中不足以等待连续稳定帧；main 与 renderer
// 共用这个默认值，并由 prepare payload 传递实际覆盖值，避免两端 deadline 再次漂移。
export const BROWSER_SCREENSHOT_SURFACE_PREPARE_TIMEOUT_MS = 3_000;

/** 截图/录制握手对 renderer 预览比例的瞬时要求；缺失时沿用用户当前预览。 */
export type BrowserViewSurfaceScaleMode = "current" | "unscaled";

/** Main 请求 owner renderer 在截图前准备后台 guest 合成表面。 */
export interface BrowserViewScreenshotSurfacePreparePayload extends BrowserViewOperationPayload {
  requestId: string;
  webContentsId: number;
  viewport: BrowserViewportSize;
  /** 自然 viewport 不使用 metrics 的 guest 布局补偿；缺失时保持原仿真行为（含录制）。 */
  viewportMode?: "natural" | "emulated";
  /** `unscaled` 只在 lease 生命周期内强制真实 100% surface，不写回用户的 Fit/固定比例。 */
  surfaceScaleMode?: BrowserViewSurfaceScaleMode;
  /** Main 当前实际使用的 prepare 超时；旧 payload 缺失时 renderer 回退到共享默认值。 */
  timeoutMs?: number;
}

/** Owner renderer 确认目标 guest 的逻辑 viewport 与原生预览 surface 比例均已稳定。 */
export interface BrowserViewScreenshotSurfaceReadyPayload extends BrowserViewScreenshotSurfacePreparePayload {
  surfaceScale: number;
}

/** Main 通知 owner renderer 释放临时后台截图合成表面。 */
export type BrowserViewScreenshotSurfaceReleasePayload = Omit<
  BrowserViewScreenshotSurfacePreparePayload,
  "viewport" | "viewportMode" | "surfaceScaleMode" | "timeoutMs"
>;

export type BrowserGuestAttachRejectReason =
  | "not-found"
  | "destroyed"
  | "not-webview"
  | "closed"
  | "window-mismatch"
  | "workspace-mismatch"
  | "session-mismatch"
  | "remote-session-mismatch"
  | "residency-suspended"
  | "residency-generation-mismatch";

/** Renderer 上报 guest 后 main 返回的绑定结果；拒绝不能再被伪装成无返回的 ready timeout。 */
export type BrowserGuestAttachResult =
  | { ok: true; guestGeneration: number }
  | { ok: false; reason: BrowserGuestAttachRejectReason; recoveryRequested: boolean };

/** 已安装的编辑器/终端信息 */
export interface EditorInfo {
  /** 编辑器标识 (e.g. "vscode", "zed", "terminal") */
  id: string;
  /** 显示名 */
  name: string;
  /** 图标 base64 data URL */
  iconDataUrl: string;
}

/** 系统对当前文件类型注册的应用；id 仅由宿主解析，不能当作命令执行。 */
export interface FileApplicationInfo {
  id: string;
  name: string;
  iconDataUrl?: string;
  isDefault: boolean;
}

export interface FileApplicationTarget {
  path: string;
  pathKind: "file" | "directory";
  workspaceIdentity?: string;
  remoteTarget?: OpenInEditorRemoteTarget;
}

export interface ApplicationIconInfo {
  iconDataUrl: string;
}

export type ApplicationIconLocator =
  | { kind: "darwin-bundle-id"; value: string }
  | { kind: "windows-executable-path"; value: string }
  | { kind: "windows-aumid"; value: string };

export interface ApplicationIconRequest {
  locators: ApplicationIconLocator[];
}

export type OpenInEditorRemoteTarget =
  | Pick<SSHConnectOptions, "kind" | "host" | "port" | "username" | "sshConfigAlias">
  | Pick<WSLConnectOptions, "kind" | "distro" | "user">
  | Pick<DockerConnectOptions, "kind" | "container">;

export interface OpenInEditorOptions {
  remoteTarget?: OpenInEditorRemoteTarget;
  workspaceIdentity?: string;
  pathKind?: "file" | "directory";
}

export interface CreateTempTextAttachmentRequest {
  text: string;
  filename?: string;
}

export interface CreateTempTextAttachmentResult {
  filename: string;
  localPath: string;
  mimeType: "text/plain";
  sizeBytes: number;
}

/**
 * dwf 产物「作为文件打开」：把某一版产物的字节落成宿主本机上的一份副本
 * （docs/dynamic-workflow/authoring.md「How the user sees them」）。
 *
 * ⚠ 术语：artifact = 脚本经 `artifact.*` 发布给用户看的产出，不是引擎的 `RunSettlement.artifact`。
 */
export interface MaterializeWorkflowArtifactFileRequest {
  runId: string;
  artifactId: string;
  /** 这份字节属于哪一版；副本按版本分目录，一版一份。 */
  version: number;
  /** 期望的文件名（含扩展名，扩展名决定系统用哪个 App 打开）；宿主会再清洗一次。 */
  fileName: string;
  bytes: Uint8Array;
}

export interface MaterializeWorkflowArtifactFileResult {
  /** 副本在宿主本机上的绝对路径。 */
  localPath: string;
}

export type SaveFileRequest =
  | {
      data: ArrayBuffer;
      sourceUrl?: never;
      suggestedName: string;
    }
  | {
      data?: never;
      sourceUrl: string;
      suggestedName: string;
    };

export interface SaveFileResult {
  /** 桌面表示已写入文件；Web 仅表示已将下载交给浏览器，不确认最终落盘。 */
  canceled?: boolean;
  error?: string;
  path?: string;
  success: boolean;
}

export interface PrintPageToPdfResult {
  success: boolean;
  /** PDF 字节；success 时存在 */
  data?: ArrayBuffer;
  /** "print_in_progress" | "print_failed" */
  error?: string;
}

/**
 * 系统麦克风权限检查结果（docs/chat/composer-voice-input.md「麦克风权限」）。
 * - granted：可以调用 getUserMedia
 * - denied：系统拒绝，需要用户到系统设置开启
 * - unsupported：系统没有权限接口（Linux），由 getUserMedia 的错误决定
 */
export type MicrophoneAccessResult = "granted" | "denied" | "unsupported";

/**
 * macOS「重新授权」结果（docs/chat/composer-voice-input.md「权限引导浮层」）。
 * - granted：已获得权限
 * - denied：重置后系统弹框中用户仍选择拒绝
 * - restart-required：重置后当前进程仍读到 denied，重启 ZCode 后才会弹框
 * - failed：不能重置（非 macOS、MDM 限制、tccutil 失败），改由系统设置页开启
 */
export type MicrophoneAccessResetResult = "granted" | "denied" | "restart-required" | "failed";

/** privacy：系统麦克风隐私页；sound：系统声音输入设备页 */
export type MicrophoneSettingsTarget = "privacy" | "sound";

/** guest 视口内的裁剪区域，全部是 guest CSS px；视口宽高用于换算实际帧的像素比例。 */
export interface CaptureBrowserGuestPageClip {
  x: number;
  y: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
}

export interface CaptureBrowserGuestPageRequest {
  /** 内置浏览器 `<webview>` 的 guest webContents id（renderer 由 `getWebContentsId()` 取得） */
  webContentsId: number;
  /** 只要视口内某一块（选元素截图）；不传时返回整个可见视口 */
  clip?: CaptureBrowserGuestPageClip;
}

export interface CaptureBrowserGuestPageResult {
  success: boolean;
  /** PNG 字节；success 时存在 */
  data?: ArrayBuffer;
  /** "guest_not_found" | "guest_not_owned" | "capture_in_progress" | "capture_timeout" | "capture_failed" | "clip_out_of_view" */
  error?: string;
}

export function createOpenInEditorRemoteTarget(
  target: RemoteTarget,
): OpenInEditorRemoteTarget | undefined {
  switch (target.kind) {
    case "ssh":
      // openInEditor 只需要构造 VS Code Remote-SSH URI 的连接标识，
      // 不应该把 password/privateKeyPassphrase 等凭据字段继续穿过 renderer/preload/main IPC。
      return {
        kind: "ssh",
        host: target.host,
        port: target.port,
        username: target.username,
        ...(target.sshConfigAlias?.trim() ? { sshConfigAlias: target.sshConfigAlias.trim() } : {}),
      };
    case "wsl": {
      const user = target.user?.trim();
      return {
        kind: "wsl",
        distro: target.distro,
        ...(user ? { user } : {}),
      };
    }
    case "docker":
      return {
        kind: "docker",
        container: target.container,
      };
    case "server":
      return undefined;
  }
}

export interface WSLDistro {
  name: string;
  isDefault: boolean;
  state: string;
  version: 1 | 2 | null;
}

export interface DockerContainerInfo {
  id: string;
  image: string;
  name: string;
  state: string;
  status: string;
}

export interface SSHConfigAliasOption {
  alias: string;
  host?: string;
  port?: number;
  username?: string;
  privateKeyPath?: string;
  source?: string;
}

export interface ZCodeStdioTapDevState {
  enabled: boolean;
  visible: boolean;
  logDir: string;
  statePath: string;
}

export type DesktopTitleBarTheme = "light" | "dark" | "system";

export interface WindowScreenshotResult {
  dataBase64: string;
  filename: string;
  contentType: string;
  size: number;
}

export type ChromeBrowserDataImportError =
  | "chrome_profile_not_found"
  | "chrome_profile_ambiguous"
  | "chrome_executable_not_found"
  | "chrome_cookie_access_denied"
  | "chrome_cookie_elevation_required"
  | "chrome_cookie_elevation_cancelled"
  | "chrome_cookie_helper_verification_failed"
  | "chrome_cookie_app_bound_decryption_failed"
  | "chrome_cookie_protection_unsupported"
  | "chrome_profile_locked"
  | "chrome_local_storage_import_failed"
  | "chrome_import_not_supported"
  | "chrome_browser_data_import_unavailable"
  | "chrome_data_import_failed"
  | "chrome_default_profile_not_found";

export interface ChromeBrowserDataImportOptions {
  /** Windows App-Bound Cookie 只能在本次显式确认后触发 UAC；不得持久化为全局授权。 */
  allowElevatedChromeDecryption?: boolean;
}

/** Chrome 浏览器数据导入只返回数量和状态；Cookie/LocalStorage 值和解密材料不得跨进程。 */
export interface ChromeBrowserDataImportResult {
  success: boolean;
  cookies: {
    imported: number;
    skipped: number;
    failed: number;
  };
  localStorage: {
    originsImported: number;
    entriesImported: number;
    originsSkipped: number;
    originsFailed: number;
    error?: ChromeBrowserDataImportError;
  };
  /** 部分成功时保留可操作问题；不得包含 Profile 绝对路径或站点数据。 */
  issues?: ChromeBrowserDataImportError[];
  error?: ChromeBrowserDataImportError;
}

export interface EmbeddedBrowserDataClearResult {
  success: boolean;
  error?: string;
}

export interface WindowControlsOverlayMetrics {
  leftPaddingPx?: number;
  rightPaddingPx?: number;
  titleBarHeightPx?: number;
}

export interface WindowControlsOverlayReadyPayload {
  zoomLevel: number;
  metrics: WindowControlsOverlayMetrics;
}

export interface DesktopZoomState {
  zoomLevel: number;
}

/**
 * 桌面端"关闭驻留托盘"能力（spec：docs/desktop/linux-close-to-tray.md）。
 * Linux 上取决于 session DBus 是否有 StatusNotifierWatcher（KDE/XFCE 原生有，
 * GNOME 需 AppIndicator 扩展）；Windows 固定 supported=true；macOS/Web 不查询。
 */
export interface DesktopCloseToTrayCapability {
  /** 关闭驻留托盘是否可用 */
  supported: boolean;
  /** 是否为 GNOME 系桌面且无托盘；设置页据此追加"安装 AppIndicator 扩展"提示 */
  gnomeLikeWithoutTray: boolean;
}

export interface DesktopWindowChromeState {
  isMaximized: boolean;
  /** 本机 macOS 主版本；非 macOS 或无法解析时为 null。 */
  macOSMajorVersion?: number | null;
  supportsNativeRoundedCorners: boolean;
}

export interface RemoteServiceSession {
  sessionId: string;
}

export interface RemoteConnectionRuntimeLog {
  label: string;
  requestId?: string;
  sessionId?: string;
  level: "info" | "warn" | "error";
  source: string;
  message: string;
  timestamp: string;
}

export interface RemoteSessionClosedEvent {
  sessionId: string;
  reason: "host-exit";
  exitCode: number | null;
  signal: string | null;
  error?: string;
  /** true = Source transport 仍在自动恢复预算内，UI 不得做终态失败收口。 */
  recoverable?: boolean;
  recoveryAttempt?: number;
  recoveryLimit?: number;
  recoveryBudgetExhausted?: boolean;
  reasonCode?: string;
  retryable?: boolean;
}

export interface RemoteSessionReconnectedEvent {
  previousSessionId: string;
  sessionId: string;
  workspacePath: string;
  workspaceIdentity: string;
}

export interface EmbeddedBrowserOpenUrlRequest {
  url: string;
  disposition: "default" | "foreground-tab" | "background-tab" | "new-window" | "other";
  /** 触发 popup 的 browser-use tab 归属；旧版事件缺失时由 renderer 按当前 scope 兼容处理。 */
  workspaceKey?: string;
  remoteSessionId?: string;
  sessionId?: string;
  browserId?: string;
  browserGeneration?: number;
  sourceTabId?: string;
}

export interface EmbeddedBrowserPermissionDeviceOption {
  deviceId: string;
  name?: string;
  vendorId?: number;
  productId?: number;
  serialNumber?: string;
}

export interface EmbeddedBrowserPermissionScreenOption {
  sourceId: string;
  name: string;
  /** 源类型：整个屏幕 / 窗口，由 main 按 desktopCapturer source id 前缀判定。 */
  kind: "screen" | "window";
  thumbnailDataUrl?: string;
}

/** Main → Renderer 的内置浏览器权限弹窗请求；kind 决定 renderer 渲染哪类弹窗。 */
export type EmbeddedBrowserPermissionPromptEvent =
  | {
      requestId: string;
      kind: "permission";
      origin: string;
      permission: string;
      mediaTypes?: string[];
      /** 发起请求的 guest webContents id；renderer 据此只在归属 tab 渲染，
       *  避免后台 tab 的请求显示在当前 tab 造成误批准。 */
      guestWebContentsId?: number;
    }
  | {
      requestId: string;
      kind: "screen-share";
      origin: string;
      screens: EmbeddedBrowserPermissionScreenOption[];
      /** 屏幕共享无 tab 锚定语义，恒缺省（兜底渲染）。 */
      guestWebContentsId?: number;
    }
  | {
      requestId: string;
      kind: "device";
      origin: string;
      /** select-hid-device / select-usb-device / select-serial-port / select-bluetooth-device */
      permission: string;
      devices: EmbeddedBrowserPermissionDeviceOption[];
      /** 发起请求的 guest webContents id（serial/蓝牙可取到；hid/usb 受 frame 限制
       *  缺省，renderer 兜底渲染）。 */
      guestWebContentsId?: number;
    };

export type EmbeddedBrowserPermissionResolution =
  | { action: "allow-always" }
  | { action: "allow-session" }
  | { action: "block-always" }
  | { action: "dismiss" }
  | { action: "share-screen"; sourceId: string }
  | { action: "select-device"; deviceId: string }
  | { action: "cancel" };

export interface EmbeddedBrowserPermissionResolveRequest {
  requestId: string;
  resolution: EmbeddedBrowserPermissionResolution;
}

export type EmbeddedBrowserSitePermissionsSnapshot = Record<
  string,
  Record<string, "allow" | "deny">
>;

export interface EmbeddedBrowserSitePermissionUpdateRequest {
  origin: string;
  permission: string;
  /** "ask" 表示删除该条记录，回到每次询问。 */
  state: "allow" | "deny" | "ask";
}

export interface EmbeddedBrowserSitePermissionResetRequest {
  origin: string;
}

export interface ConnectRemoteRequest {
  target: RemoteTarget;
  requestId?: string;
  workspacePath?: string;
  workspaceIdentity?: string;
  connectTrigger?: import("./remoteUsageTelemetry.js").RemoteWorkspaceConnectTrigger;
  confirmSourceServerInstall?: boolean;
}

export interface CancelPendingRemoteConnectionRequest {
  requestId?: string;
}

export interface BindRemoteWorkspaceSessionContextRequest {
  remoteSessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  workspacePurpose?: import("./workspacePurpose.js").WorkspacePurpose;
}

export interface BindRemoteWorkspaceSessionContextResult {
  sourceServerId?: string;
  remoteSessionId: string;
  workspacePath: string;
  workspaceIdentity: string;
  workspacePurpose?: import("./workspacePurpose.js").WorkspacePurpose;
  /** Desktop 专用的 tab 原地换代提示；不是任务路由身份，手机 replayable 客户端忽略。 */
  previousWorkspaceIdentity?: string;
}

export type BindRemoteWorkspaceSessionContextIpcResult =
  | { success: true; result: BindRemoteWorkspaceSessionContextResult }
  | {
      success: false;
      error: string;
      reasonCode?: string;
      retryable?: boolean;
    };

/**
 * 把 bind IPC 的结构化结果还原成成功结果，或带 code/retryable 的 Error。
 * Bug 原因：preload 抛出的 Error 跨 contextBridge 会丢失自定义属性，renderer 只剩 message；
 * 必须由 preload 原样返回结构化结果，在 renderer 一侧调用本函数。
 */
export function unwrapRemoteWorkspaceBindResult(
  result: BindRemoteWorkspaceSessionContextIpcResult,
): BindRemoteWorkspaceSessionContextResult {
  if (result.success) return result.result;
  const error = new Error(result.error) as Error & { code?: string; retryable?: boolean };
  if (result.reasonCode) error.code = result.reasonCode;
  if (result.retryable !== undefined) error.retryable = result.retryable;
  throw error;
}

export const DesktopCommandIds = {
  NewTask: "newTask",
  OpenWorkspace: "openWorkspace",
  CloseActiveContext: "closeActiveContext",
  CloseWindow: "closeWindow",
  MinimizeWindow: "minimizeWindow",
  ToggleMaximizeWindow: "toggleMaximizeWindow",
  ToggleFullScreen: "toggleFullScreen",
  ResetWindowSize: "resetWindowSize",
  ResetZoom: "resetZoom",
  ZoomIn: "zoomIn",
  ZoomOut: "zoomOut",
  ShowAbout: "showAbout",
  OpenChangelog: "openChangelog",
  CheckForUpdates: "checkForUpdates",
  RelaunchApp: "relaunchApp",
  OpenFeedback: "openFeedback",
  OpenCommunity: "openCommunity",
  ExportLogs: "exportLogs",
  PullMobileLogs: "pullMobileLogs",
  ToggleDevTools: "toggleDevTools",
  OpenResourceManager: "openResourceManager",
  ToggleZCodeStdioTapDevProxy: "toggleZCodeStdioTapDevProxy",
  SetZCodeEndpointProduction: "setZCodeEndpointProduction",
  SetZCodeEndpointTest: "setZCodeEndpointTest",
  SetZCodeEndpointCustom: "setZCodeEndpointCustom",
  ResetZCodeEndpoint: "resetZCodeEndpoint",
  ClearAllData: "clearAllData",
  ClearCodingPlanWebviewStorage: "clearCodingPlanWebviewStorage",
  GetCuaOsSupport: "getCuaOsSupport",
} as const;

export type DesktopCommandId = (typeof DesktopCommandIds)[keyof typeof DesktopCommandIds];

/**
 * CUA Helper 的操作系统支持态（macOS 版本门槛判定结果，主进程经
 * GetCuaOsSupport 下发给 renderer）。
 * - supported：满足门槛（含非版本因素，如解析失败时按宽松处理）。
 * - macos-below-minimum：macOS 低于承诺地板（Helper LSMinimumSystemVersion 12.0），
 *   低版本上 Helper 会被 LaunchServices -10825 拒启，表象是授权反复无响应。
 * - not-applicable：非 darwin 平台，无 macOS 版本门槛概念。
 */
export type CuaOsSupport =
  | { kind: "supported" }
  | { kind: "macos-below-minimum"; minimumMacOs: string; currentMacOs: string }
  | { kind: "not-applicable" };

/**
 * 平台操作接口 —— 替代直接访问 window.zcode
 *
 * 定义需要宿主环境（Electron main / Web server）参与的操作。
 * Desktop 和 Web 各自提供不同的实现，UI 层通过此接口统一消费。
 *
 * 设计原则：只放"必须穿越进程边界且不适合做成 RPC service"的操作，
 * 比如 native dialog、窗口生命周期控制等。
 * 业务服务（文件、终端、凭据等）走 IServiceAccessor 的 RPC 通道。
 */
export interface IPlatformService {
  /** 是否支持当前客户端本机文件的默认应用与目录操作；Web 不具备此能力。 */
  canOpenLocalFiles?: boolean;

  /** 当前平台的文件选择框是否能返回 agent 可访问的本地绝对路径 */
  canSelectFilePath?: boolean;

  /**
   * 插件 UI 沙箱平台端口。只有桌面端实现；
   * web / 手机远控为 undefined，plugin-ui 据此回退到普通 MCP 工具卡片。
   */
  pluginSandbox?: PluginSandboxPlatformPort;

  /** 打开系统目录选择框，返回选中路径或 null */
  selectDirectory(): Promise<string | null>;

  /** 打开系统多目录选择框，返回 Host 可访问的本地路径；取消返回空数组，Web 不提供 */
  selectDirectories?(): Promise<string[]>;

  /** 打开系统文件选择框，返回选中文件路径或 null */
  selectFile(): Promise<string | null>;

  /** 打开系统多文件选择框，返回选中的文件路径；取消时返回空数组 */
  selectFiles?(): Promise<string[]>;

  /** 桌面通过原生另存为对话框写入；Web 在当前浏览器发起下载。 */
  saveFile?(payload: SaveFileRequest): Promise<SaveFileResult>;

  /**
   * 用 Chromium 打印引擎把当前 webContents 的 print 媒体版面输出为 PDF（矢量文本）。
   * 页面尺寸由 renderer 注入的 @page CSS 决定（preferCSSPageSize）；仅 Desktop 实现。
   */
  printPageToPdf?(): Promise<PrintPageToPdfResult>;

  /**
   * 麦克风系统权限（仅 Desktop 实现）。macOS 未询问过时弹出系统授权；
   * openSettings 只打开固定的系统设置地址，返回 false 表示当前系统没有可跳转的页面。
   */
  microphone?: {
    ensureAccess(): Promise<MicrophoneAccessResult>;
    /** macOS：重置 ZCode 自己的麦克风授权记录并重新请求；其他系统返回 failed */
    resetAccess(): Promise<MicrophoneAccessResetResult>;
    openSettings(target: MicrophoneSettingsTarget): Promise<boolean>;
  };

  /**
   * 在 main 进程截取内置浏览器 guest 当前可见视口为 PNG。renderer 侧 `<webview>.capturePage()`
   * 会让 renderer 原生崩溃（V8 FATAL），与 Agent 截图一样只能由 main 取帧；仅 Desktop 实现。
   */
  captureBrowserGuestPage?(
    payload: CaptureBrowserGuestPageRequest,
  ): Promise<CaptureBrowserGuestPageResult>;

  /**
   * 从浏览器 File 对象解析宿主本地路径；只有 Desktop preload 能安全实现。
   * Web/手机端返回 null，避免 UI 层依赖 Electron 的非标准 File.path。
   */
  getPathForFile?(file: unknown): string | null;

  /** 把 Agent 已授权的 Desktop 本地视频路径转换为可供媒体元素读取的宿主 URL。 */
  createLocalMediaPreviewUrl?(path: string): string;

  /**
   * 在宿主 ~/.zcode 临时目录创建文本附件文件。
   * 手机远控必须通过 shared-host/platform proxy 写到桌面宿主，避免大文本进入 prompt payload。
   */
  createTempTextAttachment?(
    payload: CreateTempTextAttachmentRequest,
  ): Promise<CreateTempTextAttachmentResult>;

  /**
   * 把 dwf 产物某一版的字节写成宿主本机上的一份副本（只在路径为空时写），返回其路径。
   * 仅 Desktop 实现：手机远控与普通 Web 端没有「用本机 App 打开文件」的能力，缺席即不出入口。
   */
  materializeWorkflowArtifactFile?(
    payload: MaterializeWorkflowArtifactFileRequest,
  ): Promise<MaterializeWorkflowArtifactFileResult>;

  /** 订阅当前窗口内远程连接过程日志，返回 disposer */
  onRemoteConnectionLog(handler: (entry: RemoteConnectionRuntimeLog) => void): () => void;

  /** 订阅远程 workspace session 关闭事件，返回 disposer */
  onRemoteSessionClosed(handler: (event: RemoteSessionClosedEvent) => void): () => void;

  /** 订阅 Source transport 自动重连后的 logical session 换代事件。 */
  onRemoteSessionReconnected?(handler: (event: RemoteSessionReconnectedEvent) => void): () => void;

  /** 检查目录是否已在其他窗口打开；如果是则激活该窗口并切到对应 tab */
  activateOrSetWorkspace(path: string): Promise<{ activated: boolean }>;

  /** 建立远程连接（Desktop: 在当前窗口创建远程 session；Web: HTTP API） */
  connectRemote(
    options: RemoteTarget,
    requestId?: string,
    context?: {
      workspacePath?: string;
      workspaceIdentity?: string;
      connectTrigger?: import("./remoteUsageTelemetry.js").RemoteWorkspaceConnectTrigger;
      confirmSourceServerInstall?: boolean;
    },
  ): Promise<{
    success: boolean;
    error?: string;
    reasonCode?: string;
    retryable?: boolean;
    sessionId?: string;
    /** 本次直接复用的在线连接目标，凭据不参与认证也不得持久化。 */
    reusedConnectionTarget?: RemoteTarget;
    /** 安装/升级等待时由 Host 确认的实际连接线路。 */
    profileId?: string;
    /** WSL 安装/升级等待使用本次已解析身份；预览失败也不能重新选择系统默认值。 */
    resolvedWslTarget?: Required<WSLConnectOptions>;
  }>;

  /** Desktop-only：请求在线 Source 的无 workspace 配置 attachment。 */
  requestSourceSettingsAttachment?(sourceServerId: string): Promise<{ attachmentId: string }>;

  /** 取消当前窗口尚未建立完成的远程连接（可选：Web 平台可忽略） */
  cancelPendingRemoteConnection?(requestId?: string): Promise<void>;

  /** 将 canonical workspace 身份绑定到已创建的远程 logical session。 */
  bindRemoteWorkspaceSessionContext?(
    context: BindRemoteWorkspaceSessionContextRequest,
  ): Promise<BindRemoteWorkspaceSessionContextResult>;

  /** 为当前 workspace 开启 Web 远程控制能力 */
  startWebRemoteControl(
    context: WebRemoteControlContext,
  ): Promise<WebRemoteControlStartOperationResult>;

  /** 关闭当前窗口已开启的 Web 远程控制能力 */
  stopWebRemoteControl(): Promise<void>;

  /** 查询当前窗口 Web 远程控制状态 */
  getWebRemoteControlStatus(): Promise<WebRemoteControlStatus>;

  /** 桌面 OAuth 会话通知；main 独立重读凭据后决定是否恢复远控。 */
  notifyWebRemoteControlAuthStateChanged?(change: WebRemoteControlAuthStateChange): void;

  /** 订阅当前窗口 Web 远程控制状态变化；旧平台可不实现，UI 会保留轮询兜底 */
  onWebRemoteControlStatusChanged?(handler: (status: WebRemoteControlStatus) => void): () => void;

  /** 释放当前窗口里已创建的远程 session */
  disposeRemoteSession(sessionId: string): Promise<void>;

  /** 检查本机 Docker daemon 是否可用 */
  isDockerAvailable(): Promise<boolean>;

  /** 列出本机可用的 WSL 发行版 */
  listWSLDistros(): Promise<WSLDistro[]>;

  /** 列出当前可连接的 Docker 容器 */
  listDockerContainers(): Promise<DockerContainerInfo[]>;

  /** 列出当前机器 SSH config 中可用于快速填表的 alias */
  listSSHConfigAliases(): Promise<SSHConfigAliasOption[]>;

  /** 读取宿主环境中的原生 MCP 用户目录配置；手机远控通过已连接桌面 host 转发。 */
  loadMcpFromUserDirectory?(
    payload?: LoadCliMcpFromUserDirectoryRequest,
  ): Promise<LoadCliMcpFromUserDirectoryResult>;

  /** 写入宿主环境中的原生 MCP 用户目录配置；普通 Web 没有宿主时返回 unsupported。 */
  saveMcpToUserDirectory?(
    payload: SaveCliMcpToUserDirectoryRequest,
  ): Promise<{ success: boolean; error?: string }>;

  /** 迁移旧版 Common MCP 配置；仅宿主环境可执行，手机远控通过 desktop attachment 转发。 */
  migrateLegacyCommonMcp?(
    payload?: MigrateLegacyCommonMcpRequest,
  ): Promise<MigrateLegacyCommonMcpResult>;

  /** 打开外部 URL（用于 OAuth 跳转浏览器） */
  openExternal(url: string): void;

  /** 按系统应用标识读取真实 App 图标；非 Desktop 平台可不实现。 */
  getApplicationIcon?(
    request: string | ApplicationIconRequest,
  ): Promise<ApplicationIconInfo | null>;

  /** 打开反馈入口，由平台自行解析最终地址 */
  openFeedback(): Promise<void>;

  /** 订阅 main 进程打开内置反馈对话框事件（Desktop） */
  onOpenFeedbackDialog?(handler: () => void): () => void;

  /** 订阅 main 进程打开我的工单面板事件（Desktop） */
  onOpenTicketsPanel?(handler: () => void): () => void;

  /** 打开用户社群入口，由平台自行解析当前语言对应渠道 */
  openCommunity(): Promise<void>;

  /** 查询当前语言下是否存在可用的用户社群入口 */
  canOpenCommunity(locale: Locale): Promise<boolean>;

  /** 在系统文件管理器中打开指定路径 */
  openInFileManager(path: string): Promise<{ success: boolean; error?: string }>;

  /** 使用系统默认应用打开本地文件；普通 Web 平台返回 unsupported。 */
  openExternalFile?(path: string): Promise<{ success: boolean; error?: string }>;

  /** 打开 ZCode Computer Use 的完整权限引导。Desktop only。 */
  openCuaPermissionOnboarding?(
    options?: OpenCuaPermissionOnboardingOptions,
  ): Promise<CuaAccessibilitySettingsResult>;
  /** 取消本 renderer 以 operationId 发起的 onboarding participant。Desktop only。 */
  cancelCuaPermissionOnboarding?(operationId: string): void;
  /**
   * 预热并缓存已验证的 Helper 路径 + 指纹，使随后的 dragstart 能同步 startDrag。
   * 必须在拖拽浮窗挂载时调用：Electron 原生拖拽要求在 dragstart 事件链路里同步调用
   * startDrag，等不了 install/verify 这类异步 I/O（否则错过 OS 拖拽手势窗口）。Desktop only。
   */
  prepareCuaHelperPermissionDrag?(): Promise<PrepareCuaHelperPermissionDragResult>;
  /** 从权限浮窗把 Helper.app 拖进 macOS 权限列表。Desktop only。 */
  startCuaHelperPermissionDrag?(): void;

  /** 上报 OAuth state 给 main process，用于 deep link 路由 */
  registerOAuthState(payload: OAuthStateRegistration): void;

  /**
   * 注册 OAuth deep link 回调监听
   * @returns disposer 函数，调用后只移除当前回调
   */
  onOAuthCallback(callback: (url: string) => void): () => void;

  /**
   * 注册支付 deep link 回调监听
   * @returns disposer 函数，调用后只移除当前回调
   */
  onPaymentCallback(callback: (url: string) => void): () => void;

  /** 注册 `zcode://share/import?code=...` 导入意图。 */
  onShareImport?(callback: (payload: { shareCode: string }) => void): () => void;

  /** 通知 main process renderer 已就绪，触发缓存的冷启动 deep link 转发 */
  notifyRendererReady(): void;

  /** 触发任务状态对应的系统通知，由宿主环境决定是否真正展示 */
  showTaskNotification(payload: TaskNotificationPayload): void;

  /**
   * 扩展的系统通知（docs/plugins/extension-host.md §18.1 H8）：Main 判断窗口焦点与平台支持后弹出，
   * 返回是否弹出与原因。Web 与手机远控不实现。
   */
  showExtensionNotification?(
    payload: ExtensionNotificationPayload,
  ): Promise<NotificationsShowResult>;

  /** 用户点了扩展通知：Main 恢复并聚焦窗口后回调，带要打开的视图。返回 disposer。 */
  onExtensionNotificationClick?(handler: (click: ExtensionNotificationClick) => void): () => void;

  /** 同步当前 UI 上下文，供宿主启动/日活事件使用；Web 可不实现。 */
  syncTelemetryContext?(context: TelemetryRendererContext): void;

  /** 通过宿主环境统一上报 UI 侧 telemetry 事件 */
  reportTelemetryEvent(payload: RendererTelemetryEventPayload): Promise<void>;

  /** 通过宿主环境上报 ARMS 自定义事件；Web 端当前为空实现 */
  reportArmsCustomEvent(payload: ArmsCustomEventPayload): Promise<void>;

  /** 读取 Desktop Renderer 用户操作 Trace 的当前灰度配置；Web/手机不实现。 */
  getRendererActionTraceConfig?(): Promise<RendererActionTraceConfigV1>;
  /** 订阅 Main 推送的 Renderer 用户操作 Trace 配置；Web/手机不实现。 */
  onRendererActionTraceConfigChanged?(
    callback: (config: RendererActionTraceConfigV1) => void,
  ): () => void;
  /** Renderer → Main：发送已结束的 ui_action batch；严格旁路、fire-and-forget。 */
  reportRendererActionTraceBatch?(batch: RendererActionTraceBatchV1): void;
  reportLocalTtftBatch?(batch: import("./local-ttft/contract.js").LocalTtftBatch): void;

  /**
   * Renderer → Main：主窗口 renderer 每 60 秒的 heap 读数，进 `renderer_main` 角色事件。单向 send、fire-and-forget；
   * Web 端与手机远控没有桥，不实现即 no-op。
   */
  reportRendererHeapSample?(sample: RendererHeapSample): void;

  /** 同步当前窗口所有 tab 的 workspace 路径到 main 进程（用于跨窗口去重） */
  syncWindowTabs(paths: string[]): void;

  /** 同步当前窗口里 Web 远程控制允许切换的 workspace；Web fallback 可忽略 */
  syncWebRemoteControlWorkspaces?(workspaces: WebRemoteControlWorkspaceTarget[]): void;

  /** 注册 Web 远程控制手机端请求重连 workspace 的回调，返回 disposer */
  onWebRemoteControlReconnectWorkspace?(
    handler: (
      request: WebRemoteControlReconnectWorkspaceRequest,
    ) => Promise<WebRemoteControlReconnectWorkspaceResult>,
  ): () => void;

  /** 注册手机远控动作（置顶/归档/新建本地项目）的回调，返回 disposer；Web fallback 不实现 */
  onWebRemoteControlRendererAction?(
    handler: (
      request: WebRemoteControlRendererActionRequest,
    ) => Promise<WebRemoteControlRendererActionResult>,
  ): () => void;

  /** 同步当前窗口的未读 task 数给宿主环境，用于 Dock / 任务栏徽标聚合 */
  syncWindowUnreadCount(count: number): void;
  /** 当前窗口 active task 变化；Main 只在该窗口前台时发布全局 PiP focus。 */
  syncActiveTaskSession(sessionId: string | null): void;

  /** 同步需要 main 进程即时感知的应用设置；Web fallback 可忽略 */
  syncAppSettings?(patch: Partial<AppSettings>): void;

  /**
   * 查询"关闭驻留托盘"能力；桌面端 main 进程探测后返回，Web/手机远控无桥不实现。
   * 设置页据此决定 Linux 上的开关是否置灰。
   */
  getCloseToTrayCapability?(): Promise<DesktopCloseToTrayCapability>;

  /** 快捷键设置页录制态开关；桌面端 main 据此暂时摘除可配置菜单 accelerator，Web 可忽略 */
  setShortcutRecordingActive?(active: boolean): void;

  /** 注册 main 进程要求聚焦某个 workspace tab 的回调，返回 disposer */
  onFocusTab(handler: (path: string) => void): () => void;

  /** 注册 main 进程触发新建 tab 的回调，返回 disposer */
  onNewTab(handler: () => void): () => void;

  /** 注册 main 进程请求关闭当前上下文的回调，返回 disposer */
  onCloseActiveContextRequest?(handler: () => void): () => void;

  /** 注册内置浏览器 webview 请求打开新页面的回调，返回 disposer */
  onOpenBrowserUrl?(handler: (request: EmbeddedBrowserOpenUrlRequest) => void): () => void;
  /** 注册内置浏览器网页权限弹窗请求（main → renderer），返回 disposer */
  onEmbeddedBrowserPermissionPrompt?(
    handler: (event: EmbeddedBrowserPermissionPromptEvent) => void,
  ): () => void;
  /** 回传用户对内置浏览器权限弹窗的决策（renderer → main） */
  resolveEmbeddedBrowserPermissionPrompt?(request: EmbeddedBrowserPermissionResolveRequest): void;
  /** 读取内置浏览器站点权限记录（设置页「网站权限」） */
  getEmbeddedBrowserSitePermissions?(): Promise<EmbeddedBrowserSitePermissionsSnapshot>;
  /** 修改/删除单条站点权限；返回更新后的快照 */
  setEmbeddedBrowserSitePermission?(
    request: EmbeddedBrowserSitePermissionUpdateRequest,
  ): Promise<EmbeddedBrowserSitePermissionsSnapshot>;
  /** 清空全部站点权限记录 */
  clearEmbeddedBrowserSitePermissions?(): Promise<EmbeddedBrowserSitePermissionsSnapshot>;
  /** 重置单个站点的全部权限记录（删除该 origin 下所有持久决定）；返回更新后的快照 */
  resetEmbeddedBrowserSitePermission?(
    request: EmbeddedBrowserSitePermissionResetRequest,
  ): Promise<EmbeddedBrowserSitePermissionsSnapshot>;
  /** 注册 agent 首次 browser 命令建好受控 view 的回调（自动开 browser-use tab），返回 disposer */
  onBrowserViewDownloadStarted?(
    handler: (payload: { webContentsId: number; urls: string[] }) => void,
  ): () => void;
  onBrowserViewReady?(
    handler: (payload: {
      workspaceKey: string;
      remoteSessionId?: string;
      sessionId: string;
      tabId: string;
      browserId: string;
      browserGeneration: number;
    }) => void,
  ): () => void;

  /** browser-use 命中真实 tab 时刷新标签页操作状态，返回 disposer。 */
  onBrowserViewOperation?(handler: (payload: BrowserViewOperationPayload) => void): () => void;

  /** browser visibility capability：显式显示/隐藏当前 IAB browser-use pane。 */
  onBrowserViewVisibility?(
    handler: (payload: {
      visible: boolean;
      workspaceKey: string;
      remoteSessionId: string | undefined;
      sessionId: string;
      tabId?: string;
      browserId: string;
      browserGeneration: number;
    }) => void,
  ): () => void;

  /** Agent setViewportSize 与 renderer 自由尺寸的单 tab 同步事件。 */
  onBrowserViewViewportChanged?(
    handler: (payload: BrowserViewViewportChangedPayload) => void,
  ): () => void;

  /** 注册 main 截图前准备后台 guest 合成表面的回调，返回 disposer。 */
  onBrowserViewScreenshotSurfacePrepare?(
    handler: (payload: BrowserViewScreenshotSurfacePreparePayload) => void,
  ): () => void;

  /** 注册 main 截图完成后释放后台 guest 合成表面的回调，返回 disposer。 */
  onBrowserViewScreenshotSurfaceRelease?(
    handler: (payload: BrowserViewScreenshotSurfaceReleasePayload) => void,
  ): () => void;

  /** 上报目标 guest 已在连续动画帧中稳定的截图合成表面。 */
  browserViewScreenshotSurfaceReady?(payload: BrowserViewScreenshotSurfaceReadyPayload): void;

  onBrowserViewCloseTab?(handler: (payload: BrowserViewCloseTabNotification) => void): () => void;

  /** main 请求 renderer 卸载 guest、保留 logical shell。 */
  onBrowserViewSuspend?(
    handler: (payload: BrowserViewResidencyTransitionPayload) => void,
  ): () => void;

  /** main 请求 renderer 为 suspended shell 重新挂载 guest。 */
  onBrowserViewRestore?(
    handler: (payload: BrowserViewResidencyTransitionPayload) => void,
  ): () => void;

  /** 注册 main 进程触发新建任务的回调，返回 disposer */
  onNewTask(handler: () => void): () => void;

  /** 注册 main 进程触发打开工作区的回调，返回 disposer */
  onOpenWorkspace(handler: () => void): () => void;

  /** 注册 main 进程通过 deep link 直接打开本地工作区目录的回调，返回 disposer */
  onOpenWorkspacePath?(handler: (path: string) => void): () => void;

  /** 注册窗口全屏状态变化回调，返回 disposer */
  onWindowFullscreenChanged(handler: (isFullscreen: boolean) => void): () => void;

  /** 读取当前桌面窗口最大化状态与系统原生圆角能力 */
  getDesktopWindowChromeState?(): Promise<DesktopWindowChromeState>;

  /** 注册桌面窗口最大化状态与系统原生圆角能力变化回调 */
  onDesktopWindowChromeStateChanged?(
    handler: (state: DesktopWindowChromeState) => void,
  ): () => void;

  /** 同步读取当前原生窗口控制区安全边距，用于首屏启动态初始化 */
  getWindowControlsOverlayMetrics?(): WindowControlsOverlayMetrics | null;

  /** 注册原生窗口控制区安全边距变化回调，返回 disposer */
  onWindowControlsOverlayChanged?(
    handler: (metrics: WindowControlsOverlayMetrics) => void,
  ): () => void;

  /** 同步读取当前桌面窗口页面缩放档位；Web fallback 可返回默认 0 */
  getDesktopZoomLevel?(): Promise<DesktopZoomState>;

  /** 注册当前桌面窗口页面缩放档位变化回调，返回 disposer */
  onDesktopZoomLevelChanged?(handler: (state: DesktopZoomState) => void): () => void;

  /** 注册用户点击系统通知后跳转到对应任务的回调，返回 disposer */
  onTaskNotificationClick(handler: (taskId: string) => void): () => void;

  /** 显式 App 导航能力：只在桌面导航 owner 挂载时注册，返回真实导航提交结果。 */
  onAppControlNavigation?(handler: AppNavigationHandler): () => void;

  /** 导出日志：打包 ~/.zcode/v2 及外部 agent 日志为 zip 并在系统文件浏览器中显示 */
  exportLogs(): Promise<{ success: boolean; path?: string; error?: string }>;

  /** 截取当前窗口，用于错误反馈携带现场画面；Web fallback 可返回 null */
  captureWindowScreenshot?(): Promise<WindowScreenshotResult | null>;

  /** 可信宿主导航自己承载的 guest；main 负责本地 HTML 的目录授权。 */
  browserViewLoadUrl?(payload: { webContentsId: number; url: string }): Promise<void>;

  /** `<webview>` guest 上报；active=true 表示 agent 无 tabId 命令优先读取当前可见页。 */
  browserViewAttachGuest?(payload: {
    key: string;
    webContentsId: number;
    active?: boolean;
    workspaceKey?: string;
    remoteSessionId?: string;
    /** human browser tab 的对话归属；缺失时 main 必须保持不可认领，避免跨对话泄漏。 */
    sessionId?: string;
    residencyGeneration?: number;
  }): Promise<BrowserGuestAttachResult>;

  /** 重建 `<webview>` 前让 main 精确断开旧 guest 的 CDP；false 时不得销毁旧节点。 */
  browserViewDetachGuest?(payload: { key: string; webContentsId: number }): Promise<boolean>;

  /** 用户显式关闭 Browser tab；与 budget suspend 使用不同 IPC authority。 */
  browserViewCloseTab?(payload: BrowserViewCloseTabRequest): Promise<void>;

  /** 上报 selected/visible/loading 与恢复元数据。 */
  browserViewReportResidency?(payload: BrowserViewResidencyReportPayload): Promise<void>;

  /** 草稿首发：把草稿 human tab 的 main owner 从 unscoped 升级为新会话；返回已升级的 tabId。 */
  browserViewPromoteDraftTabs?(payload: BrowserViewPromoteDraftTabsRequest): Promise<string[]>;

  /** renderer 已按指定 generation 卸载 guest。 */
  browserViewSuspendReady?(payload: { tabId: string; generation: number }): Promise<void>;

  /** 用户选中 suspended tab 时请求 main single-flight 恢复。 */
  browserViewEnsureResident?(payload: BrowserViewCloseTabRequest): Promise<void>;

  /** workspace/task 启动时读取持久化 logical shells。 */
  browserViewRestoreTabs?(
    payload: BrowserViewRestoreTabsRequest,
  ): Promise<BrowserViewRestoredTabShell[]>;

  /** Renderer 自由尺寸回写 main；null 表示恢复宿主自然 viewport。 */
  browserViewUpdateViewport?(payload: {
    tabId: string;
    viewport: BrowserViewportSize | null;
  }): Promise<void>;

  /** 从自动发现的本机 Chrome Profile 一次性导入 Cookie 与 LocalStorage。 */
  importChromeBrowserData?(
    options?: ChromeBrowserDataImportOptions,
  ): Promise<ChromeBrowserDataImportResult>;

  /** 清理内置浏览器持久化分区；cache 模式保留认证数据，all 模式清理全部站点数据。 */
  clearEmbeddedBrowserData?(mode: "cache" | "all"): Promise<EmbeddedBrowserDataClearResult>;

  /** 注册新版本已下载完毕的回调，参数为新版本号，返回 disposer */
  onUpdateReady(callback: (version: string) => void): () => void;

  /** 注册"手动检查更新"结果的回调（用于 toast 反馈），返回 disposer */
  onUpdateCheckResult(callback: (payload: UpdateCheckResultPayload) => void): () => void;

  /** 注册自动更新持续状态变化的回调，返回 disposer */
  onUpdateStateChanged?(callback: (payload: UpdateStatePayload) => void): () => void;

  /** 主动读取当前自动更新状态，用于菜单打开时补偿异步事件丢失 */
  getUpdateState?(): Promise<UpdateStatePayload>;

  /** 用户在更新弹窗中确认开始下载当前已发现版本 */
  downloadUpdate(): Promise<void>;

  /** 用户在更新弹窗中取消当前下载中的更新 */
  cancelUpdateDownload(): Promise<void>;

  /** 打开桌面端独立更新窗口；非桌面端可不实现并回退到内嵌弹窗 */
  openUpdateStatusWindow?(): Promise<void>;

  /** 读取桌面端自动更新偏好；非桌面端可返回默认值 */
  getAutoUpdatePreferences?(): Promise<{
    autoDownloadAndInstallUpdates: boolean;
  }>;

  /** 写入“以后自动下载并安装更新”偏好；非桌面端可 no-op */
  setAutoDownloadAndInstallUpdates?(enabled: boolean): Promise<void>;

  /** 用户跳过当前已发现版本；main 进程负责按当前通道持久化 */
  skipUpdateVersion(version: string): Promise<void>;

  /** 查询桌面端当前正在运行的会话数量；非桌面端可返回 0 */
  getDesktopSessionActivity?(): Promise<{
    runningAgentSessionCount: number;
  }>;

  /** 开发环境 stdio tap proxy 开关状态；非桌面平台可不实现 */
  getZCodeStdioTapDevState?(): Promise<ZCodeStdioTapDevState>;

  /** 是否为本地开发运行形态；桌面端用 !app.isPackaged 注入，Web 端可省略。 */
  isLocalDevelopmentRuntime?: boolean;

  /** 设置文件由桌面菜单命令更新后的通知，renderer 用于刷新 settings snapshot。 */
  onSettingsChanged?(callback: () => void): () => void;

  /** 桌面主进程解析后的应用语言变化；独立轻量窗口没有 settingService 时使用。 */
  onApplicationLocaleChanged?(callback: (locale: Locale) => void): () => void;

  /** 宿主系统语言；桌面端由 main 进程读取，Web 端可回退到 navigator.language。 */
  getSystemLocale?(): Promise<Locale>;

  /** 注册更新完成后的版本说明，返回 disposer */
  onPostUpdateReleaseNotes(callback: (payload: PostUpdateReleaseNotesPayload) => void): () => void;

  /** 标记当前版本说明已读，允许 main 进程清理持久化状态 */
  acknowledgePostUpdateReleaseNotes(version: string): Promise<void>;

  /** 用户确认重启安装更新 */
  quitAndInstallUpdate(): Promise<void>;

  /** 获取已安装编辑器/终端；传文件路径时追加匹配类型的本机应用（含图标）。 */
  getInstalledEditors(filePath?: string): Promise<EditorInfo[]>;

  /** 本机文件的系统关联应用；Web/远端/目录不提供本机应用。 */
  getFileApplications?(target: FileApplicationTarget): Promise<FileApplicationInfo[]>;

  /** 重新确认系统关联后，使用该应用打开本机文件。 */
  openFileWithApplication?(
    applicationId: string,
    target: FileApplicationTarget,
  ): Promise<{ success: boolean; error?: string }>;

  /** 用指定编辑器打开路径 */
  openInEditor(
    editorId: string,
    path: string,
    options?: OpenInEditorOptions,
  ): Promise<{ success: boolean; error?: string }>;

  /** 执行桌面窗口级命令（标题栏菜单、缩放、窗口控制等）。
   *  返回值直通 main 进程 handler 的 return（大多数命令无返回值；
   *  GetCuaOsSupport 返回 CuaOsSupport），因此放宽为 unknown。 */
  executeDesktopCommand(command: DesktopCommandId): Promise<unknown>;

  /** 同步应用菜单语言，驱动 main 进程重建原生菜单 */
  setApplicationLocale(locale: Locale): Promise<void>;

  /** 同步桌面标题栏亮/暗色，驱动原生窗口控制按钮配色 */
  setTitleBarTheme(theme: DesktopTitleBarTheme): Promise<void>;

  /** 获取当前设备的稳定标识符
   *
   * - 桌面端：基于 userData 路径的 SHA-256，始终稳定且唯一
   * - 手机端（Web 远程控制）：物理属性指纹（browserPlatform | screen.width | screen.height | colorDepth），
   *   抗浏览器/网络/语言/时区变化，换手机才会变
   */
  getDeviceId(): string;
}
