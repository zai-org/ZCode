import type { WebRemoteControlAuthStateChange } from "./web-remote-control.js";
/* eslint-disable max-lines -- 通信频道和请求响应映射必须集中定义，避免跨进程 channel 字符串散落。 */
import type {
  ResourceUsageSnapshot,
  LoadCliMcpFromUserDirectoryRequest,
  LoadCliMcpFromUserDirectoryResult,
  MigrateLegacyCommonMcpRequest,
  MigrateLegacyCommonMcpResult,
  SaveCliMcpToUserDirectoryRequest,
} from "./index.js";
import type { OAuthStateRegistration } from "./oauth.js";
import type {
  WebRemoteControlContext,
  WebRemoteControlReconnectWorkspaceRequest,
  WebRemoteControlReconnectWorkspaceResult,
  WebRemoteControlStartOperationResult,
  WebRemoteControlStatus,
  WebRemoteControlWorkspaceTarget,
} from "./web-remote-control.js";
import type {
  WebRemoteControlRendererActionRequest,
  WebRemoteControlRendererActionResult,
} from "#src/web-remote-relay/index.js";
import type { AppSettings, Locale } from "./protocol.js";
import type { StorageCleanRequest, StorageCleanResult, StorageUsageSnapshot } from "./storage.js";
import type {
  ArmsCustomEventPayload,
  ConfigureFinalArmsCustomEventE2ERequest,
  FinalArmsCustomEventE2EEntry,
  RendererTelemetryEventPayload,
  TelemetryRendererContext,
} from "./telemetry.js";
import type {
  RendererActionTraceBatchV1,
  RendererActionTraceConfigV1,
} from "./rendererActionTrace.js";
import type { RendererHeapSample } from "./validation.js";
import type {
  ExtensionNotificationClick,
  ExtensionNotificationPayload,
  NotificationsShowResult,
} from "#src/extension-host/notifications.js";
import type {
  CancelPendingRemoteConnectionRequest,
  BindRemoteWorkspaceSessionContextRequest,
  BrowserViewScreenshotSurfacePreparePayload,
  BrowserViewScreenshotSurfaceReadyPayload,
  BrowserViewScreenshotSurfaceReleasePayload,
  BrowserViewCloseTabNotification,
  BrowserViewCloseTabRequest,
  BrowserViewPromoteDraftTabsRequest,
  BrowserViewResidencyReportPayload,
  BrowserViewResidencyTransitionPayload,
  BrowserViewRestoredTabShell,
  BrowserViewRestoreTabsRequest,
  BrowserViewViewportChangedPayload,
  ConnectRemoteRequest,
  DesktopCommandId,
  DesktopTitleBarTheme,
  DockerContainerInfo,
  EmbeddedBrowserOpenUrlRequest,
  EmbeddedBrowserPermissionPromptEvent,
  EmbeddedBrowserPermissionResolveRequest,
  EmbeddedBrowserSitePermissionUpdateRequest,
  EmbeddedBrowserSitePermissionResetRequest,
  EmbeddedBrowserSitePermissionsSnapshot,
  EditorInfo,
  FileApplicationInfo,
  FileApplicationTarget,
  CreateTempTextAttachmentRequest,
  CreateTempTextAttachmentResult,
  MaterializeWorkflowArtifactFileRequest,
  MaterializeWorkflowArtifactFileResult,
  SaveFileRequest,
  SaveFileResult,
  PrintPageToPdfResult,
  MicrophoneAccessResetResult,
  MicrophoneAccessResult,
  MicrophoneSettingsTarget,
  CaptureBrowserGuestPageRequest,
  CaptureBrowserGuestPageResult,
  OpenInEditorOptions,
  PostUpdateReleaseNotesPayload,
  RemoteSessionClosedEvent,
  RemoteSessionReconnectedEvent,
  SSHConfigAliasOption,
  TaskNotificationPayload,
  WSLDistro,
  UpdateCheckResultPayload,
  UpdateStatePayload,
  DesktopZoomState,
  DesktopWindowChromeState,
  WindowControlsOverlayMetrics,
  WindowControlsOverlayReadyPayload,
} from "./platform.js";
import type { BrowserViewportSize } from "./browser-use/command-metadata.js";
import type {
  CuaAccessibilitySettingsResult,
  OpenCuaPermissionOnboardingOptions,
  PrepareCuaHelperPermissionDragResult,
} from "./cuaAccessibilitySettings.js";

// ============================================================================
// RPC 服务频道 —— 通过 ChannelServer/ChannelClient 传输
// ============================================================================

/** RPC 服务频道名。与 ServiceDescriptor.channelName 对应。 */
export const ServiceChannels = {
  File: "file",
  MediaPreview: "media-preview",
  System: "system",
  Terminal: "terminal",
  /** Git 服务 */
  Git: "git",
  /** Git checkpoint 服务 */
  GitCheckpoint: "git-checkpoint",
  Setting: "setting",
  /** 凭据管理（从 main IPC 迁移到 host RPC） */
  Credential: "credential",
  /** Computer Use Helper macOS 权限服务 */
  CuaPermission: "cua-permission",
  /** producer-owned PiP session presentation client */
  CuaPipSession: "cua-pip-session",
  /** 跨窗口广播 */
  Broadcast: "broadcast",
  /** ZCode task wrapper 服务 */
  ZCodeTask: "zcode-task",
  /** 窗口 Host 聚合 workspace/task 投影与列表写路由 */
  WindowController: "window-controller",
  /** ZCode Protocol agent 服务 */
  ZCodeAgent: "zcode-agent",
  /** ZCode session 应用服务 */
  ZCodeSession: "zcode-session",
  Project: "project",
  /** 受管 worktree 任务管理（列表、删除、起点、fork 到新 worktree），仅本地桌面 Host。 */
  ManagedWorktrees: "managed-worktrees",
  TaskGroups: "task-groups",
  RemoteProjects: "remote-projects",
  /** 手机远端 attachment 的窗口目录；原 project 继续属于工作区。 */
  WindowProject: "window-project",
  WindowRemoteProjects: "window-remote-projects",
  WindowProjectChanges: "window-project-changes",
  /** 会话分享发布、预览与 continuation API 编排 */
  ConversationShare: "conversation-share",
  /** 文件系统监视服务 */
  FileWatcher: "file-watcher",
  /** OAuth 认证服务 */
  OAuth: "oauth",
  /** 新 Provider Config 的设置读写 Facade */
  ProviderSettings: "provider-settings",
  /** 新 Provider Registry 的模型选择 Facade */
  ModelSelection: "model-selection",
  /** 远端 Environment 内部 Provider Provisioning target */
  ProviderProvisioningTarget: "provider-provisioning-target",
  /** Source Server 端 workspace 身份解析服务 */
  SourceServerWorkspace: "source-server-workspace",
  /** 桌面 Host 的 Source Server 目录与连接管理服务 */
  SourceServerManagement: "source-server-management",
  /** 桌面 Host 的数据同步设备状态（按 sourceServerId 记录上次同步结果，仅本机注册） */
  DeviceSyncState: "device-sync-state",
  /** 桌面 Host 的数据同步页模型提供商：读取 / 重试 Main 协调器的 Provisioning lane（仅本机注册） */
  ProviderProvisioningStatus: "provider-provisioning-status",
  /** 桌面 Host 的扩展门面（docs/plugins/extension-host.md）：贡献表、扩展进程状态、命令、重新加载（仅本机注册） */
  Extensions: "extensions",
  /** 桌面 Host 的扩展视图门面（docs/plugins/extension-host.md §8）：视图实例、页面请求与通知、views.open（仅本机注册） */
  ExtensionViews: "extension-views",
  /** 桌面 Host 的扩展授权门面（docs/plugins/extension-host.md §17.7）：授予、撤销、授权状态、启用确认、最近操作（仅本机注册） */
  ExtensionGrants: "extension-grants",
  /** 本地 usage 统计服务 */
  UsageStats: "usage-stats",
  /** Coding Plan 订阅购买服务 */
  CodingPlanSubscription: "coding-plan-subscription",
  ClientConfig: "client-config",
  /** ZCode 客户端场景配置服务 */
  ClientScenes: "client-scenes",
  CloudContent: "cloud-content",
  MarketingTouch: "marketing-touch",
  /** 桌面 Host 的语音输入：连接 zcode-server ASR（docs/chat/composer-voice-input.md，仅本机 base 连接） */
  VoiceInput: "voice-input",
  /** Skills 管理服务 */
  Skills: "skills",
  /** SSH 远程 skills 同步服务 */
  SkillSync: "skill-sync",
  /** SSH 远程 MCP 同步服务 */
  McpSync: "mcp-sync",
  /** SSH 远程 plugin 同步服务 */
  PluginSync: "plugin-sync",
  /** 数据同步：子智能体、命令、钩子共用的用户配置同步通道（按 category 区分，不进手机白名单） */
  UserConfigSync: "user-config-sync",
  /** 插件管理服务 */
  Plugins: "plugins",
  /** 设置页插件管理服务（UI 平台能力面收敛，不再直触 zcodeAgentService） */
  PluginManagement: "plugin-management",
  /** 插件 UI 沙箱桥：host 读取 ui:// 资源并向 main 登记、代理 UI 发起的工具调用 */
  PluginUiBridge: "plugin-ui-bridge",
  PluginUiSampling: "plugin-ui-sampling",
  PluginUiAppTools: "plugin-ui-app-tools",
  /** Subagents 管理服务 */
  Subagents: "subagents",
  /** Commands 管理服务 */
  Commands: "commands",
  /** Hooks 管理服务 */
  Hooks: "hooks",
  /** Memory 管理服务 */
  Memory: "memory",
  /** OutputStyle 管理服务 */
  OutputStyle: "output-style",
  /** 首次启动设置同步服务 */
  SettingsSync: "settings-sync",
  /** Bots 远程聊天控制服务 */
  Bots: "bots",
  /** 用户反馈工单服务 */
  Feedback: "feedback",
  /** Composer 附件在 host-local 与 remote runtime 之间的预传服务 */
  PromptAttachmentTransfer: "prompt-attachment-transfer",
  /** 闲时任务管理服务（与 automation 服务面独立） */
  OffPeakTask: "off-peak-task",
  /** Highspeed 加速卡抽取与分享服务 */
  HighspeedCard: "highspeed-card",
  /** Onboarding 完成记录服务（本地持久化，后续上传服务器） */
  OnboardingRecord: "onboarding-record",
} as const;

export type ServiceChannelName = (typeof ServiceChannels)[keyof typeof ServiceChannels];

// ============================================================================
// 平台频道 —— 仅 Desktop main 进程能处理的操作（Electron IPC）
// ============================================================================

/** Electron IPC 频道名。仅在 preload ↔ main 之间使用。 */
export const PlatformChannels = {
  /** renderer → main：释放插件 UI 沙箱（关闭 ports、撤 protocol handler、清 partition） */
  PluginSandboxDispose: "zcode:plugin-sandbox-dispose",
  PluginSandboxCopyImage: "zcode:plugin-sandbox-copy-image",
  PluginSandboxExecutionActive: "zcode:plugin-sandbox-execution-active",
  /** renderer → main：一次性消费插件 UI 沙箱 guest 的用户手势 token */
  PluginSandboxConsumeUserGesture: "zcode:plugin-sandbox-consume-user-gesture",
  /** renderer → main：查询自身 webContents id，作为沙箱登记的 owner */
  PluginSandboxOwnerWebContentsId: "zcode:plugin-sandbox-owner-web-contents-id",
  /** 打开系统目录选择框 */
  SelectDirectory: "zcode:select-directory",
  /** 打开系统多目录选择框 */
  SelectDirectories: "zcode:select-directories",
  /** 打开系统文件选择框 */
  SelectFile: "zcode:select-file",
  /** 打开系统多文件选择框 */
  SelectFiles: "zcode:select-files",
  /** Renderer → Main：写入宿主 ~/.zcode 临时文本附件 */
  CreateTempTextAttachment: "zcode:create-temp-text-attachment",
  /** Renderer → Main：把 dwf 产物某一版的字节落成本机副本（「作为文件打开」） */
  MaterializeWorkflowArtifactFile: "zcode:materialize-workflow-artifact-file",
  /** Renderer → Main：通过原生另存为对话框保存文件 */
  SaveFile: "zcode:save-file",
  /** Renderer → Main：用 Chromium 打印引擎把当前页面 print 媒体版面导出为 PDF */
  PrintToPdf: "zcode:print-to-pdf",
  /** Renderer → Main：检查并按需请求系统麦克风权限 */
  MicrophoneAccess: "zcode:microphone-access",
  /** Renderer → Main：macOS 重置本 App 的麦克风授权记录并重新请求 */
  ResetMicrophoneAccess: "zcode:reset-microphone-access",
  /** Renderer → Main：打开系统麦克风权限 / 声音输入设置页 */
  OpenMicrophoneSettings: "zcode:open-microphone-settings",
  /** Renderer → Main：在 main 截取内置浏览器 guest 当前视口为 PNG（renderer 侧 capturePage 会崩溃） */
  CaptureBrowserGuestPage: "zcode:capture-browser-guest-page",
  /** Main → Renderer：转发远程连接过程日志 */
  RemoteConnectionLog: "zcode:remote-connection-log",
  /** Main → Renderer：远程 workspace session 已关闭 */
  RemoteSessionClosed: "zcode:remote-session-closed",
  /** Main → Renderer：Source 自动重连后的 logical session 已换代并完成 port ready */
  RemoteSessionReconnected: "zcode:remote-session-reconnected",
  /** 检查目录是否已在其他窗口打开，如果是则激活该窗口 */
  ActivateOrSetWorkspace: "zcode:activate-or-set-workspace",
  /** 建立 SSH 远程连接 */
  ConnectRemote: "zcode:connect-remote",
  /** Desktop Renderer → Main：为在线 Source 创建配置专用 attachment */
  RequestSourceSettingsAttachment: "zcode:request-source-settings-attachment",
  /** 取消当前窗口正在进行中的远程连接 */
  CancelPendingRemoteConnection: "zcode:cancel-pending-remote-connection",
  /** Renderer → Main：绑定远程 logical session 的 canonical workspace context */
  BindRemoteWorkspaceSessionContext: "zcode:bind-remote-workspace-session-context",
  /** 为当前 workspace 开启 Web 远程控制 */
  StartWebRemoteControl: "zcode:start-web-remote-control",
  /** 关闭当前窗口的 Web 远程控制 */
  StopWebRemoteControl: "zcode:stop-web-remote-control",
  /** 查询当前窗口的 Web 远程控制状态 */
  GetWebRemoteControlStatus: "zcode:get-web-remote-control-status",
  /** Renderer → Main：OAuth 会话变化通知，不携带凭据 */
  WebRemoteControlAuthStateChanged: "zcode:web-remote-control-auth-state-changed",
  /** Main → Renderer：当前窗口 Web 远程控制状态变化 */
  WebRemoteControlStatusChanged: "zcode:web-remote-control-status-changed",
  /** 释放当前窗口里的远程 session */
  DisposeRemoteSession: "zcode:dispose-remote-session",
  /** Renderer → Main：检查本机 Docker daemon 是否可用 */
  IsDockerAvailable: "zcode:is-docker-available",
  /** Renderer → Main：列出本机可用的 WSL 发行版 */
  ListWSLDistros: "zcode:list-wsl-distros",
  /** Renderer → Main：列出当前可连接的 Docker 容器 */
  ListDockerContainers: "zcode:list-docker-containers",
  /** Renderer → Main：列出 SSH config 里可用于快速填表的 alias */
  ListSSHConfigAliases: "zcode:list-ssh-config-aliases",
  /** Renderer → Main：从用户目录加载 CLI MCP 配置 */
  LoadMcpFromUserDirectory: "zcode:load-mcp-from-user-directory",
  /** Renderer → Main：保存 CLI MCP 配置到用户目录 */
  SaveMcpToUserDirectory: "zcode:save-mcp-to-user-directory",
  /** Renderer → Main：查询"关闭驻留托盘"能力（Linux 置灰判断；spec：docs/desktop/linux-close-to-tray.md） */
  GetCloseToTrayCapability: "zcode:get-close-to-tray-capability",
  /** Renderer 日志转发到 main 进程统一存储 */
  Log: "zcode:log",
  /** Renderer → Main：同步当前窗口所有 tab 的 workspace 路径 */
  SyncWindowTabs: "zcode:sync-window-tabs",
  /** Renderer → Main：同步当前窗口可供 Web 远程控制切换的 workspace */
  SyncWebRemoteControlWorkspaces: "zcode:sync-web-remote-control-workspaces",
  /** Main → Renderer：手机端请求重连当前窗口里的远程 workspace */
  WebRemoteControlReconnectWorkspace: "zcode:web-remote-control-reconnect-workspace",
  /** Main → Renderer：手机请求置顶/归档任务或新建本地项目，Renderer 按侧栏同一路径执行 */
  WebRemoteControlRendererAction: "zcode:web-remote-control-renderer-action",
  /** Renderer → Main：同步当前窗口的未读 task 数 */
  SyncWindowUnreadCount: "zcode:sync-window-unread-count",
  /** Renderer → Main：当前窗口 active task，只更新 Main 的临时焦点映射。 */
  SyncActiveTaskSession: "zcode:sync-active-task-session",
  /** Renderer → Main：同步 main 进程需即时感知的应用设置 */
  SyncAppSettings: "zcode:sync-app-settings",
  /** Renderer → Main：快捷键设置页录制态开关；true = main 暂时摘除可配置菜单 accelerator */
  SetShortcutRecordingActive: "zcode:set-shortcut-recording-active",
  /** Main → Renderer：聚焦到指定 workspace 路径的 tab */
  FocusTab: "zcode:focus-tab",
  /** Main → Renderer：菜单触发新建 tab */
  NewTab: "zcode:new-tab",
  /** Main → Renderer：菜单或快捷键请求关闭当前上下文 */
  CloseActiveContextRequest: "zcode:close-active-context-request",
  /** Main → Renderer：内置 webview 请求打开新的浏览器 tab */
  OpenBrowserUrl: "zcode:open-browser-url",
  /** Main → Renderer：内置浏览器网页权限/屏幕共享源/设备选择弹窗请求 */
  EmbeddedBrowserPermissionPrompt: "zcode:embedded-browser-permission-prompt",
  /** Renderer → Main：用户对内置浏览器权限弹窗的决策回传 */
  EmbeddedBrowserPermissionResolve: "zcode:embedded-browser-permission-resolve",
  /** Main → Renderer：agent 首次 browser 命令建好受控 view，通知 renderer 自动开 browser-use tab */
  BrowserViewReady: "zcode:browser-view-ready",
  /** Main → Renderer：agent 正在操作某个 browser-use tab，renderer 临时显示状态图标 */
  BrowserViewOperation: "zcode:browser-view-operation",
  /** Main → Renderer：browser visibility capability 显示/隐藏 IAB 右侧面板 */
  BrowserViewVisibility: "zcode:browser-view-visibility",
  /** Main → Renderer：Agent 设置/重置目标 tab viewport */
  BrowserViewViewportChanged: "zcode:browser-view-viewport-changed",
  /** Main → Renderer：截图前请求 owner renderer 准备后台 guest 合成表面。 */
  BrowserViewScreenshotSurfacePrepare: "zcode:browser-view-screenshot-surface-prepare",
  /** Renderer → Main：目标 guest 连续两个 animation frame 的 viewport 已稳定。 */
  BrowserViewScreenshotSurfaceReady: "zcode:browser-view-screenshot-surface-ready",
  /** Main → Renderer：截图结束或准备失败，释放临时后台合成层。 */
  BrowserViewScreenshotSurfaceRelease: "zcode:browser-view-screenshot-surface-release",
  /** Main → Renderer：agent close 命令 detach 受控 guest 后，通知 renderer 卸载对应 tab */
  BrowserViewCloseTab: "zcode:browser-view-close-tab",
  /** Main → Renderer：预算淘汰时卸载 guest，但保留 logical tab shell。 */
  BrowserViewSuspend: "zcode:browser-view-suspend",
  /** Main → Renderer：为 suspended shell 重新挂载 guest。 */
  BrowserViewRestore: "zcode:browser-view-restore",
  /** Main → Renderer：菜单触发新建任务 */
  NewTask: "zcode:new-task",
  /** Main → Renderer：菜单触发打开工作区 */
  OpenWorkspace: "zcode:open-workspace",
  /** Main → Renderer：deep link 直接打开指定本地工作区目录 */
  OpenWorkspacePath: "zcode:open-workspace-path",
  /** Main → Renderer：打开内置反馈对话框 */
  OpenFeedbackDialog: "zcode:open-feedback-dialog",
  /** Main → Renderer：打开我的工单面板 */
  OpenTicketsPanel: "zcode:open-tickets-panel",
  /** Main → Renderer：窗口全屏状态变化 */
  WindowFullscreenChanged: "zcode:window-fullscreen-changed",
  /** Renderer → Main：读取窗口最大化状态与系统原生圆角能力 */
  GetDesktopWindowChromeState: "zcode:get-desktop-window-chrome-state",
  /** Main → Renderer：窗口最大化状态与系统原生圆角能力变化 */
  DesktopWindowChromeStateChanged: "zcode:desktop-window-chrome-state-changed",
  /** Main → Renderer：原生窗口控制区安全边距变化 */
  WindowControlsOverlayChanged: "zcode:window-controls-overlay-changed",
  /** Preload → Main：preload 已同步读到当前窗口控制区安全边距 */
  WindowControlsOverlayReady: "zcode:window-controls-overlay-ready",
  /** 获取资源管理器快照（CPU / 内存，按基础服务、内置插件、社区插件归类） */
  GetResourceUsageSnapshot: "zcode:get-resource-usage-snapshot",
  SetResourceUsageSamplingActive: "zcode:set-resource-usage-sampling-active",
  GetNetworkCaptureSnapshot: "zcode:get-network-capture-snapshot",
  ClearNetworkCapture: "zcode:clear-network-capture",
  /** 打开资源管理器窗口（其他窗口触发） */
  OpenResourceManager: "zcode:open-resource-manager",
  /** 资源管理器「存储」tab：开始扫描本机 .zcode 占用（main 持有 StorageService，Worker 线程遍历） */
  StorageStartScan: "zcode:storage-start-scan",
  /** 资源管理器「存储」tab：取消扫描 */
  StorageCancelScan: "zcode:storage-cancel-scan",
  /** 资源管理器「存储」tab：读取最近一次快照 */
  StorageGetSnapshot: "zcode:storage-get-snapshot",
  /** 资源管理器「存储」tab：按类别清理 */
  StorageClean: "zcode:storage-clean",
  /** 资源管理器「存储」tab：在系统文件管理器中定位数据根内的路径 */
  StorageRevealPath: "zcode:storage-reveal-path",
  /** Main → 资源管理器 renderer：扫描进度快照推送 */
  StorageScanProgress: "zcode:storage-scan-progress",
  /** Renderer → Main：打开外部 URL（用于 OAuth 跳转浏览器） */
  OpenExternal: "zcode:open-external",
  /** Renderer → Main：查询当前语言下是否存在可用的用户社群入口 */
  CanOpenCommunity: "zcode:can-open-community",
  /** Renderer → Main：在系统文件管理器中打开路径 */
  OpenInFileManager: "zcode:open-in-file-manager",
  /** Renderer → Main：使用系统默认应用打开本地文件 */
  OpenExternalFile: "zcode:open-external-file",
  /** Renderer → Main：打开 ZCode Computer Use 权限引导 */
  OpenCuaPermissionOnboarding: "zcode:open-cua-permission-onboarding",
  /** Renderer → Main：取消当前 renderer 发起的一次权限引导 participant */
  CancelCuaPermissionOnboarding: "zcode:cancel-cua-permission-onboarding",
  /**
   * Renderer → Main：预热并缓存已验证的 Helper 路径 + bundle 指纹。
   * 必须在拖拽浮窗挂载时调用 —— dragstart 链路里不允许任何异步 I/O。
   */
  PrepareCuaHelperPermissionDrag: "zcode:prepare-cua-helper-permission-drag",
  /** Renderer → Main：把已验证的 Helper.app 同步拖出到 macOS 权限列表 */
  StartCuaHelperPermissionDrag: "zcode:start-cua-helper-permission-drag",
  /**
   * Renderer → Main：拖拽手势结束。
   * 拖完授权即完成，浮窗该让位（用户此时要看设置页和系统的重启提示）。必须等 dragend 而不是
   * 在 dragstart 里就收窗：startDrag 只是把 drag session 交给 OS，非阻塞，drag source
   * 立刻消失可能打断正在进行的拖拽。
   */
  NotifyCuaHelperPermissionDragEnded: "zcode:notify-cua-helper-permission-drag-ended",
  /** Renderer → Main：上报 OAuth state 用于 deep link 路由 */
  OAuthRegisterState: "zcode:oauth-register-state",
  /** Main → Renderer：转发 deep link URL */
  OAuthCallback: "zcode:oauth-callback",
  /** Main → Renderer：转发支付 deep link URL */
  PaymentCallback: "zcode:payment-callback",
  /** Main → Renderer：外部分享页请求导入 share code。 */
  ShareImport: "zcode:share-import",
  /** Renderer → Main：OAuth 回调已处理完成，可继续后置启动流程 */
  OAuthCallbackHandled: "zcode:oauth-callback-handled",
  /** Renderer → Main：renderer 已就绪，可接收缓存的 deep link */
  RendererReady: "zcode:renderer-ready",
  /** Renderer → Main：同步当前 renderer 的 telemetry 上下文 */
  SyncTelemetryContext: "zcode:sync-telemetry-context",
  /** Renderer → Main：通过统一 telemetry 层上报业务事件 */
  ReportTelemetryEvent: "zcode:report-telemetry-event",
  /** Renderer → Main：上报 ARMS 自定义事件 */
  ReportArmsCustomEvent: "zcode:report-arms-custom-event",
  /** Renderer → Main：读取 Renderer 用户操作 Trace 灰度配置。 */
  GetRendererActionTraceConfig: "zcode:get-renderer-action-trace-config",
  /** Main → Renderer：Renderer 用户操作 Trace 灰度配置变化。 */
  RendererActionTraceConfigChanged: "zcode:renderer-action-trace-config-changed",
  /** Renderer → Main：发送已结束的 ui_action batch。 */
  ReportRendererActionTraceBatch: "zcode:report-renderer-action-trace-batch",
  /** Renderer → Main：主窗口 renderer 每 60 秒的 heap 读数，单向 send，不需要回执。 */
  ReportRendererHeapSample: "zcode:report-renderer-heap-sample",
  ReportLocalTtftBatch: "zcode:report-local-ttft-batch",
  /** E2E preload → Main：读取 sendCustom 最终参数的内存 ring。 */
  ReadFinalArmsCustomEventsE2E: "zcode:e2e:read-final-arms-custom-events",
  /** E2E preload → Main：清空 sendCustom 最终参数的内存 ring。 */
  ClearFinalArmsCustomEventsE2E: "zcode:e2e:clear-final-arms-custom-events",
  /** E2E preload → Main：配置只针对目标 event name 的真实网络抑制。 */
  ConfigureFinalArmsCustomEventsE2E: "zcode:e2e:configure-final-arms-custom-events",
  /** Renderer → Main：触发任务完成/失败的系统通知 */
  ShowTaskNotification: "zcode:show-task-notification",
  /** Main → Preload：通知 renderer 播放任务通知提示音 */
  TaskNotificationSound: "zcode:task-notification-sound",
  /** Main → Preload：用户点击了系统通知，携带 taskId 让 renderer 跳转到对应任务 */
  TaskNotificationClick: "zcode:task-notification-click",
  /** Renderer → Main：弹扩展的系统通知并返回结果（§18.1 H8） */
  ShowExtensionNotification: "zcode:show-extension-notification",
  /** Main → Preload：用户点了扩展通知，携带插件 id 与要打开的视图 */
  ExtensionNotificationClick: "zcode:extension-notification-click",
  /** Renderer → Main：导出日志（打包 ~/.zcode/v2 及外部 agent 日志为 zip 并在 Finder 中显示） */
  ExportLogs: "zcode:export-logs",
  /** Renderer → Main：截取当前窗口作为反馈附件 */
  CaptureWindowScreenshot: "zcode:capture-window-screenshot",
  /**
   * Renderer → Main：`<webview>` guest dom-ready 后上报 webContentsId，
   * main 用 BrowserGuestManager attach 该 guest（fire-and-forget）。CDP-on-guest pivot。
   */
  BrowserViewAttachGuest: "zcode:browser-view-attach-guest",
  /** 可信宿主发起导航；main 将本地 HTML 转成有目录边界的预览地址。 */
  BrowserViewLoadUrl: "zcode:browser-view-load-url",
  /** Renderer → Main：重建 `<webview>` 前主动断开旧 guest 的 CDP。 */
  BrowserViewDownloadStarted: "zcode:browser-view-download-started",
  BrowserViewDetachGuest: "zcode:browser-view-detach-guest",
  /** Renderer → Main：用户显式关闭 Browser tab。 */
  BrowserViewCloseTabFromRenderer: "zcode:browser-view-close-tab-from-renderer",
  /** Renderer → Main：上报 Browser tab residency/display facts。 */
  BrowserViewReportResidency: "zcode:browser-view-report-residency",
  /** Renderer → Main：草稿首发后把草稿 human tab 的 owner 升级为新会话。 */
  BrowserViewPromoteDraftTabs: "zcode:browser-view-promote-draft-tabs",
  /** Renderer → Main：指定 generation 的 guest 已卸载。 */
  BrowserViewSuspendReady: "zcode:browser-view-suspend-ready",
  /** Renderer → Main：用户访问 suspended tab，请求恢复。 */
  BrowserViewEnsureResident: "zcode:browser-view-ensure-resident",
  /** Renderer → Main：读取 workspace/task 的持久化 logical shells。 */
  BrowserViewRestoreTabs: "zcode:browser-view-restore-tabs",
  /** Renderer → Main：自由尺寸拖拽/开关回写目标 guest viewport */
  BrowserViewUpdateViewport: "zcode:browser-view-update-viewport",
  /** Embedded Browser preload → Main：在网页原生 Dialog 创建前同步请求可信系统框。 */
  EmbeddedBrowserJavaScriptDialog: "zcode:embedded-browser-javascript-dialog",
  /** Renderer → Main：把自动发现的本机 Chrome Profile 数据一次性导入内置浏览器分区。 */
  ImportChromeBrowserData: "zcode:import-chrome-browser-data",
  /** Renderer → Main：清理内置浏览器缓存或全部站点数据。 */
  ClearEmbeddedBrowserData: "zcode:clear-embedded-browser-data",
  /** Renderer → Main：读取内置浏览器站点权限记录（设置页「网站权限」） */
  GetEmbeddedBrowserSitePermissions: "zcode:get-embedded-browser-site-permissions",
  /** Renderer → Main：修改/删除单条站点权限（state="ask" 表示删除） */
  SetEmbeddedBrowserSitePermission: "zcode:set-embedded-browser-site-permission",
  /** Renderer → Main：清空全部站点权限记录 */
  ClearEmbeddedBrowserSitePermissions: "zcode:clear-embedded-browser-site-permissions",
  /** Renderer → Main：重置单个站点的全部权限记录（站点权限设置标签页「重置」） */
  ResetEmbeddedBrowserSitePermission: "zcode:reset-embedded-browser-site-permission",
  /** Main → Renderer：通知有新版本已下载完毕，可以重启安装 */
  UpdateReady: "zcode:update-ready",
  /** Main → Renderer：用户手动点击"检查更新"后的结果反馈（toast 用） */
  UpdateCheckResult: "zcode:update-check-result",
  /** Main → Renderer：自动更新持续状态变化（菜单 UI 用） */
  UpdateStateChanged: "zcode:update-state-changed",
  /** Renderer → Main：主动获取当前自动更新状态（菜单打开时补偿事件丢失） */
  GetUpdateState: "zcode:get-update-state",
  /** Renderer → Main：开始下载当前已发现的自动更新 */
  DownloadUpdate: "zcode:download-update",
  /** Renderer → Main：取消当前正在下载的自动更新 */
  CancelUpdateDownload: "zcode:cancel-update-download",
  /** Renderer → Main：打开独立自动更新窗口 */
  OpenUpdateStatusWindow: "zcode:open-update-status-window",
  /** Renderer → Main：读取自动更新偏好 */
  GetAutoUpdatePreferences: "zcode:get-auto-update-preferences",
  /** Renderer → Main：写入“自动下载并安装更新”偏好 */
  SetAutoDownloadAndInstallUpdates: "zcode:set-auto-download-and-install-updates",
  /** Renderer → Main：查询桌面端正在运行的会话数量 */
  GetDesktopSessionActivity: "zcode:get-desktop-session-activity",
  /** Renderer → Main：读取当前窗口页面缩放档位 */
  GetDesktopZoomLevel: "zcode:get-desktop-zoom-level",
  /** Main → Renderer：当前窗口页面缩放档位变化 */
  DesktopZoomLevelChanged: "zcode:desktop-zoom-level-changed",
  /** Renderer → Main：读取开发态 stdio tap proxy 开关状态 */
  GetZCodeStdioTapDevState: "zcode:get-zcode-stdio-tap-dev-state",
  /** Main → Renderer：本地 setting.json 已由 main 进程更新 */
  SettingsChanged: "zcode:settings-changed",
  /** Main → Renderer：应用语言已切换 */
  ApplicationLocaleChanged: "zcode:application-locale-changed",
  /** Renderer → Main：读取宿主系统语言 */
  GetSystemLocale: "zcode:get-system-locale",
  /** Main → Renderer：更新安装后的版本说明 */
  PostUpdateReleaseNotes: "zcode:post-update-release-notes",
  /** Renderer → Main：确认版本说明已读 */
  AcknowledgePostUpdateReleaseNotes: "zcode:ack-post-update-release-notes",
  /** Renderer → Main：跳过当前已发现的自动更新版本 */
  SkipUpdateVersion: "zcode:skip-update-version",
  /** Renderer → Main：用户确认重启安装更新 */
  QuitAndInstallUpdate: "zcode:quit-and-install-update",
  /** Renderer → Main：获取系统中已安装的编辑器/终端列表（含图标） */
  GetInstalledEditors: "zcode:get-installed-editors",
  GetFileApplications: "zcode:get-file-applications",
  OpenFileWithApplication: "zcode:open-file-with-application",
  /** Renderer → Main：按 bundle id 获取系统应用图标 */
  GetApplicationIcon: "zcode:get-application-icon",
  /** Renderer → Main：用指定编辑器打开路径 */
  OpenInEditor: "zcode:open-in-editor",
  /** Renderer → Main：执行桌面窗口级命令 */
  ExecuteDesktopCommand: "zcode:execute-desktop-command",
  /** Renderer → Main：同步应用菜单语言，用于重建原生菜单 */
  SetApplicationLocale: "zcode:set-application-locale",
  /** Renderer → Main：同步标题栏亮暗色，用于原生窗口控制按钮配色 */
  SetTitleBarTheme: "zcode:set-title-bar-theme",
  /** Renderer → Main：迁移旧版 Common MCP 配置 */
  MigrateLegacyCommonMcp: "zcode:migrate-legacy-common-mcp",
  /** Renderer → Main：获取当前设备的稳定标识符（deviceMid） */
  GetDeviceId: "zcode:get-device-id",
} as const;

export type PlatformChannelName = (typeof PlatformChannels)[keyof typeof PlatformChannels];

// ============================================================================
// 内置 WebView 频道 —— 固定 guest preload ↔ embedder renderer
// ============================================================================

/** Electron `<webview>` 的 `sendToHost` / `ipc-message` 频道，不经过 main process。 */
export const EmbeddedBrowserWebviewChannels = {
  /** Guest 无法继续消费某方向的滚动时，把二维 delta 转交自由尺寸画布。 */
  WheelBoundary: "zcode:embedded-browser-wheel-boundary",
  /**
   * 设计运行时的页面事件（docs/browser-use/2026-11-03-browser-design-mode-spec.md）：页面主世界
   * `window.postMessage` 带命名空间的信封，preload 校验后把 `events` 数组转给宿主。
   */
  DesignEvents: "zcode:embedded-browser-design-events",
  /**
   * 页面上按下 Cmd/Ctrl + Z（Shift 为重做），且按键当下的目标不是可编辑元素：preload 隔离世界只认 isTrusted 的按键，
   * 页面脚本发不出这条，设计工具据此撤销 / 重做源码写回。
   */
  DesignUndoShortcut: "zcode:embedded-browser-design-undo-shortcut",
} as const;

/** 设计运行时 postMessage 信封：`{ [messageKey]: 1, events: unknown[] }`；events 序列化后超过上限（UTF-8 字节）的消息 preload 直接丢弃。 */
export const EMBEDDED_BROWSER_DESIGN_BRIDGE = {
  messageKey: "__zcodeDesign",
  maxMessageBytes: 256 * 1024,
} as const;

export interface EmbeddedBrowserWheelBoundaryPayload {
  deltaX: number;
  deltaY: number;
}

// ============================================================================
// Coding Plan WebView 频道 —— 官网页 preload ↔ App renderer
// ============================================================================

/**
 * Electron `<webview>`（partition=persist:zcode-coding-plan）的 `sendToHost` / `ipc-message` 频道。
 * 官网页通过 preload 注入的 window.zcodeBridge 调用，不经过 main process。
 */
export const CodingPlanWebviewChannels = {
  /** 官网页购买成功后通知 App 刷新 entitlements 并关闭 webview。 */
  PurchaseComplete: "zcode:coding-plan-purchase-complete",
} as const;

/**
 * 插件 UI 沙箱 guest（partition=plugin-sandbox:<id>）的 main → guest preload 频道。
 * preload 只把 MessagePort 组经 window.postMessage 转交给受信 shell，不暴露任何 contextBridge API。
 */
export const PluginSandboxChannels = {
  /** main → guest：{ sandboxId, initId, names } + port1[]，shell 据此建立宿主端口 */
  Init: "zcode:plugin-sandbox-init",
} as const;

/** 购买完成回传 payload。provider 与官网 CodingPlanProvider / auth-ready 事件 detail.provider 同构。 */
export interface CodingPlanPurchaseCompletePayload {
  provider: "zai" | "bigmodel";
  /** 客户端时间戳，用于 App 侧去重/日志，不参与判等。 */
  timestamp: number;
}

/**
 * 官网页 window.__zcodeLang__ 的取值，与 App IntlProvider 的 Locale 一致。
 * App locale 变化时通过 executeJavaScript 重写此变量并派发 lang-change 事件。
 */
export type CodingPlanWebviewLocale = "zh-CN" | "en-US";

/**
 * 官网页 lang-change 事件 detail。App 用 executeJavaScript 在 main world 派发
 * `zcode-coding-plan-lang-change` CustomEvent，website 侧（zcodeBridge.onLangChange 或
 * 直接 window.addEventListener）订阅后切换 copy。
 */
export interface CodingPlanWebviewLangChangeDetail {
  locale: CodingPlanWebviewLocale;
}

// ============================================================================
// 内部传输频道 —— 框架级别的通信
// ============================================================================
/** 内部传输频道。用于 MessagePort 转发等框架级通信。 */
export const InternalChannels = {
  DatabaseStartupState: "zcode:database-startup-state",
  DatabaseStartupControl: "zcode:database-startup-control",
  /** main → renderer 转发 MessagePort（通过 webContents.postMessage） */
  ServicePort: "zcode:service-port",
  /** main → renderer 转发窗口 Host 的 scoped MessagePort */
  ScopedServicePort: "zcode:scoped-service-port",
  /** renderer → main：scoped MessagePort 已注册，可安全切换 attachment */
  ScopedServicePortReady: "zcode:scoped-service-port-ready",
  /** main → renderer：ready ACK 到达时 route 已不存在，窗口释放这次 attachment 的登记 */
  ScopedServicePortReleased: "zcode:scoped-service-port-released",
  /** main → renderer：在线 Source 的配置专用 MessagePort */
  SourceSettingsServicePort: "zcode:source-settings-service-port",
  /** preload → renderer：主进程已确认系统通知展示，renderer 可播放提示音 */
  TaskNotificationSound: "zcode:task-notification-sound",
  /** main → 宿主 renderer：插件 UI 沙箱的 MessagePort 组（port2[]），payload { sandboxId, initId, names } */
  PluginSandboxPorts: "zcode:plugin-sandbox-ports",
} as const;

/** @deprecated `/ws` 已忽略该头；保留常量仅供旧客户端兼容。 */
export const ZCODE_RPC_CLIENT_MODE_HEADER = "x-zcode-rpc-client-mode";
/** desktop 先经受保护 HTTP endpoint 申请，再在 `/ws/host` 握手时一次性消费。 */
export const ZCODE_RPC_HOST_CAPABILITY_HEADER = "x-zcode-rpc-host-capability";

// ============================================================================
// 进程间消息类型 —— main ↔ host process 之间的 postMessage
// ============================================================================

/** main → host process 的初始化消息类型 */
export const HostMessageTypes = {
  /** Main → Host：仅经已绑定私有通道返回加解密结果，不含系统主密钥。 */
  CredentialCipherResult: "credential-cipher-result",
  /** main → Host：准备手机项目目录，只复用已在线物理 Source。 */
  PrepareProjectWorkspace: "prepare-project-workspace",
  DatabaseStartupControl: "database-startup-control",
  /** 初始化本地服务 */
  InitLocal: "init-local",
  /** main → window Host：在当前窗口建立一个远程 logical session */
  ConnectRemoteWorkspace: "connect-remote-workspace",
  /** main → window Host：取消尚未完成的远程连接 */
  CancelRemoteWorkspaceConnect: "cancel-remote-workspace-connect",
  /** main → window Host：为 logical session 绑定 canonical workspace 身份 */
  BindRemoteWorkspaceContext: "bind-remote-workspace-context",
  /** main → window Host：取消已超时的 workspace bind */
  CancelRemoteWorkspaceBind: "cancel-remote-workspace-bind",
  /** main → window Host：释放一个远程 logical session */
  DisposeRemoteWorkspaceSession: "dispose-remote-workspace-session",
  /** main → host：复用现有服务，对新的 RPC MessagePort 暴露服务 */
  SetTerminalOwner: "set-terminal-owner",
  AttachServicePort: "attach-service-port",
  /** main → host：精确释放一个 RPC MessagePort attachment */
  DetachServicePort: "detach-service-port",
  /** 窗口关闭，清理资源 */
  Dispose: "dispose",
  /** 广播消息中转 */
  Broadcast: "broadcast",
  /** main → host：跨窗口原子 claim 结果 */
  BroadcastClaimResult: "broadcast-claim-result",
  /** main → host：task realtime invalidation delivery */
  TaskRealtimeDeliver: "task-realtime-deliver",
  /** main → host：task run lease acquire result */
  TaskRunLeaseResult: "task-run-lease-result",
  /** main → host：deliver owner-only task command */
  TaskOwnerCommandDeliver: "task-owner-command-deliver",
  /** main → host：deliver owner command result to requester */
  TaskOwnerCommandResult: "task-owner-command-result",
  /** main → host：把 session message 投递到该 host 管理的目标 session */
  SessionMessageDeliver: "session-message-deliver",
  /** main → host：把 session message 投递结果回写到源 session */
  SessionMessageDeliveryResult: "session-message-delivery-result",
  /** main → host：反馈日志归档创建结果 */
  FeedbackLogArchiveResult: "feedback-log-archive-result",
  /** main → host：定时任务到点派发；会话内 cron 复用 targetTaskId，历史未绑定任务才建 session */
  CronRun: "cron-run",
  /** main → host：闲时任务派发；首跑 createTask 新建 session，续跑带 conversationId/sessionId resume */
  OffPeakRun: "off-peak-run",
  /** main → host：browser-use 命令执行结果（CDP 执行完回传，按 requestId 关联） */
  BrowserExecuteResult: "browser-execute-result",
  /** main → host：本地视频 canonical path 授权结果 */
  LocalMediaPreviewPathAuthorizeResult: "local-media-preview-path-authorize-result",
  /** main → host：插件 UI 沙箱登记结果（PluginSandboxRegisterResultPayload） */
  PluginSandboxRegisterResult: "plugin-sandbox-register-result",
  /** Main → Host：全局前台 ZCode 窗口派生的 producer focus fact。 */
  CuaPipFocusChanged: "cua-pip-focus-changed",
  /** main → host：要求 Host 现读本地 Source，并同步指定 Remote Environment。 */
  ProviderProvisioningExecute: "provider-provisioning-execute",
  /** main → host：数据同步页读取 / 重试 Provisioning lane 的结果。 */
  ProviderProvisioningLaneResult: "provider-provisioning-lane-result",
  /** main → host：资源管理器请求 Host 采样其后代进程（Agent / MCP / 终端）的 CPU 与内存 */
  ResourceUsageSnapshotRequest: "resource-usage-snapshot-request",
  ResourceUsageSnapshotCancel: "resource-usage-snapshot-cancel",
  NetworkCapture: "network-capture",
  /** main → host：Main 的实时界面语言变化（Host 用于 ZCode endpoint 的 X-Client-Language） */
  ApplicationLocaleChanged: "application-locale-changed",
} as const;

/** host process → main process 的反馈消息类型 */
export const HostResponseTypes = {
  /** Host → Main：对本 Host 绑定的凭据目录执行加解密。 */
  CredentialCipherRequest: "credential-cipher-request",
  /** Host → main：已准入的目录与 scope，main 不解释项目业务。 */
  ProjectWorkspacePrepared: "project-workspace-prepared",
  DatabaseStartupState: "database-startup-state",
  /** window Host → main：按 requestId 上报远程连接过程日志 */
  RemoteWorkspaceConnectionLog: "remote-workspace-connection-log",
  /** window Host → main：远程 logical session 已建立 */
  RemoteWorkspaceConnected: "remote-workspace-connected",
  /** window Host → main：workspace canonical 准备完成，可安全建立新 attachment */
  RemoteWorkspaceContextBound: "remote-workspace-context-bound",
  /** window Host → main：workspace canonical 准备失败 */
  RemoteWorkspaceContextBindFailed: "remote-workspace-context-bind-failed",
  /** window Host → main：Source transport 重连后 logical session 已换代 */
  RemoteWorkspaceReconnected: "remote-workspace-reconnected",
  /** window Host → main：远程 logical session 建立失败 */
  RemoteWorkspaceConnectFailed: "remote-workspace-connect-failed",
  /** window Host → main：已连接的远程 logical session 关闭 */
  RemoteWorkspaceClosed: "remote-workspace-closed",
  /** host 进程日志上报 */
  Log: "log",
  /** host 内拉起新的 agent 子进程 */
  AgentProcessSpawned: "agent-process-spawned",
  /** host 内 agent runtime 首次通过模型执行门禁 */
  AgentProcessReady: "agent-process-ready",
  /** host 内的 agent 子进程退出 */
  AgentProcessExited: "agent-process-exited",
  /** host 内的 agent 子进程启动失败 */
  AgentProcessError: "agent-process-error",
  AgentProcessException: "agent-process-exception",
  /** host → main：CLI 进程内自采样的 CPU / RSS */
  AgentResourceSample: "agent-resource-sample",
  /** host → main：Host 进程自身每 60 秒自采的 CPU / RSS / heap（资源遥测 host 角色的 heap 来源） */
  HostResourceSample: "host-resource-sample",
  /** host → main：CLI 内 MCP 进程生命周期与内存遥测 */
  McpTelemetry: "mcp-telemetry",
  McpResourceSamples: "mcp-resource-samples",
  ToolExecResource: "tool-exec-resource",
  /** 自动化 Host 首次输入 accepted 后报告新建 Session。 */
  SessionCreateTelemetry: "session-create-telemetry",
  RemoteConversationTelemetry: "remote-conversation-telemetry",
  PluginTelemetry: "plugin-telemetry",
  /** host → main：资源管理器采样结果（按 requestId 关联） */
  ResourceUsageSnapshotResult: "resource-usage-snapshot-result",
  NetworkCaptureBatch: "network-capture-batch",
  /** host 内当前正在执行 prompt 的 agent session 数量变化 */
  AgentRunningTaskCountChanged: "agent-running-task-count-changed",
  /** host 内阻止退出的事项变化（例如正在创建的 worktree） */
  QuitBlockersChanged: "quit-blockers-changed",
  /** host 内指定 workspace 当前仍未 terminal 的 task 数量变化 */
  WorkspaceRunningTaskCountChanged: "workspace-running-task-count-changed",
  /** host → main：Windows desktop-local CUA turn 的操作提示状态 */
  CuaOperationState: "cua-operation-state",
  /** host → main：workspace generation 已可安全 attach */
  RemoteWorkspaceAcquired: "remote-workspace-acquired",
  /** 广播消息 */
  Broadcast: "broadcast",
  /** host → main：申请跨窗口原子 claim */
  BroadcastClaimRequest: "broadcast-claim-request",
  /** host → main：把临时 claim reservation 提交为永久 claim */
  BroadcastClaimCommit: "broadcast-claim-commit",
  /** host → main：按 token 释放尚未提交的 claim reservation */
  BroadcastClaimRelease: "broadcast-claim-release",
  /** host → main：发布 task realtime invalidation */
  TaskRealtimePublish: "task-realtime-publish",
  /** host → main：发布 task stream mirror op */
  TaskStreamOpPublish: "task-stream-op-publish",
  /** host → main：申请 task run lease */
  TaskRunLeaseAcquire: "task-run-lease-acquire",
  /** host → main：释放 task run lease */
  TaskRunLeaseRelease: "task-run-lease-release",
  /** host → main：observer 请求 owner 执行 task command */
  TaskOwnerCommandRequest: "task-owner-command-request",
  /** host → main：owner 返回 task command result */
  TaskOwnerCommandResult: "task-owner-command-result",
  /** host → main：Agent 请求向另一个 session 发送消息 */
  SessionMessageSendRequested: "session-message-send-requested",
  /** host → main：声明一个 ZCode Agent session 当前归属该 host */
  SessionRouteAnnounce: "session-route-announce",
  /** host → main：目标 host 完成本地 session message 投递 */
  SessionMessageDeliverResult: "session-message-deliver-result",
  /** host → main：请求 main 复用导出日志逻辑创建反馈日志归档 */
  FeedbackLogArchiveRequest: "feedback-log-archive-request",
  /** host → main：定时任务派发结果（成功回填 taskId/sessionId，失败带 transient/permanent） */
  CronRunResult: "cron-run-result",
  /** host → main：闲时任务派发结果（成功回填 conversationId/sessionId，失败带 transient/permanent） */
  OffPeakRunResult: "off-peak-run-result",
  /** host → main：manual run 已落库，请立即唤醒 scheduler 认领派发 */
  CronSchedulerWakeRequest: "cron-scheduler-wake-request",
  /** host → main：闲时任务翻 schedulable，请立即唤醒 scheduler 认领派发（与 cron 消息独立） */
  OffPeakSchedulerWakeRequest: "off-peak-scheduler-wake-request",
  /** host → main：执行一条 browser-use 命令（main 用 WebContentsView+CDP 执行，按 requestId 关联） */
  BrowserExecuteRequest: "browser-execute-request",
  /** host → main：请求授权 Agent 已精确校验的本地视频路径 */
  LocalMediaPreviewPathAuthorizeRequest: "local-media-preview-path-authorize-request",
  /** host → main：登记已校验的插件 UI HTML 与 CSP，换取 sandbox 句柄（PluginSandboxRegisterRequestPayload） */
  PluginSandboxRegisterRequest: "plugin-sandbox-register-request",
  /** host → main：RPC 网络遥测批次（channel.command 成功率/耗时） */
  NetworkTelemetryBatch: "network-telemetry-batch",
  /** host → main：本地 Provisioning Source 成功持久化。 */
  ProviderProvisioningSourceChanged: "provider-provisioning-source-changed",
  /** host → main：一次 Remote Environment 同步执行完毕。 */
  ProviderProvisioningExecutionResult: "provider-provisioning-execution-result",
  /** host → main：数据同步页按设备读取或重试 Provisioning lane。 */
  ProviderProvisioningLaneRequest: "provider-provisioning-lane-request",
} as const;

// ============================================================================
// 平台频道类型映射 —— request/response 类型安全
// ============================================================================

/** 平台频道的请求/响应类型映射 */
export interface PlatformChannelMap {
  [PlatformChannels.SelectDirectory]: {
    request: void;
    response: string | null;
  };
  [PlatformChannels.SelectDirectories]: {
    request: void;
    response: string[];
  };
  [PlatformChannels.SelectFile]: {
    request: void;
    response: string | null;
  };
  [PlatformChannels.SelectFiles]: {
    request: void;
    response: string[];
  };
  [PlatformChannels.CreateTempTextAttachment]: {
    request: CreateTempTextAttachmentRequest;
    response: CreateTempTextAttachmentResult;
  };
  [PlatformChannels.MaterializeWorkflowArtifactFile]: {
    request: MaterializeWorkflowArtifactFileRequest;
    response: MaterializeWorkflowArtifactFileResult;
  };
  [PlatformChannels.SaveFile]: {
    request: SaveFileRequest;
    response: SaveFileResult;
  };
  [PlatformChannels.PrintToPdf]: {
    request: void;
    response: PrintPageToPdfResult;
  };
  [PlatformChannels.MicrophoneAccess]: {
    request: void;
    response: MicrophoneAccessResult;
  };
  [PlatformChannels.ResetMicrophoneAccess]: {
    request: void;
    response: MicrophoneAccessResetResult;
  };
  [PlatformChannels.OpenMicrophoneSettings]: {
    request: MicrophoneSettingsTarget;
    response: boolean;
  };
  [PlatformChannels.CaptureBrowserGuestPage]: {
    request: CaptureBrowserGuestPageRequest;
    response: CaptureBrowserGuestPageResult;
  };
  [PlatformChannels.RemoteConnectionLog]: {
    request: {
      label: string;
      requestId?: string;
      sessionId?: string;
      level: "info" | "warn" | "error";
      source: string;
      message: string;
      timestamp: string;
    };
    response: void;
  };
  [PlatformChannels.RemoteSessionClosed]: {
    request: RemoteSessionClosedEvent;
    response: void;
  };
  [PlatformChannels.RemoteSessionReconnected]: {
    request: RemoteSessionReconnectedEvent;
    response: void;
  };
  [PlatformChannels.ActivateOrSetWorkspace]: {
    request: string;
    response: { activated: boolean };
  };
  [PlatformChannels.OpenWorkspacePath]: {
    request: string;
    response: void;
  };
  [PlatformChannels.ConnectRemote]: {
    request: ConnectRemoteRequest;
    response: {
      success: boolean;
      error?: string;
      reasonCode?: string;
      retryable?: boolean;
      sessionId?: string;
    };
  };
  [PlatformChannels.RequestSourceSettingsAttachment]: {
    request: { sourceServerId: string };
    response: { attachmentId: string };
  };
  [PlatformChannels.CancelPendingRemoteConnection]: {
    request: CancelPendingRemoteConnectionRequest;
    response: void;
  };
  [PlatformChannels.BindRemoteWorkspaceSessionContext]: {
    request: BindRemoteWorkspaceSessionContextRequest;
    response: import("./platform.js").BindRemoteWorkspaceSessionContextIpcResult;
  };
  [PlatformChannels.StartWebRemoteControl]: {
    request: WebRemoteControlContext;
    response: WebRemoteControlStartOperationResult;
  };
  [PlatformChannels.StopWebRemoteControl]: {
    request: void;
    response: void;
  };
  [PlatformChannels.WebRemoteControlAuthStateChanged]: {
    request: WebRemoteControlAuthStateChange;
    response: void;
  };
  [PlatformChannels.GetWebRemoteControlStatus]: {
    request: void;
    response: WebRemoteControlStatus;
  };
  [PlatformChannels.WebRemoteControlStatusChanged]: {
    request: WebRemoteControlStatus;
    response: void;
  };
  [PlatformChannels.DisposeRemoteSession]: {
    request: string;
    response: void;
  };
  [PlatformChannels.IsDockerAvailable]: {
    request: void;
    response: boolean;
  };
  [PlatformChannels.ListWSLDistros]: {
    request: void;
    response: WSLDistro[];
  };
  [PlatformChannels.ListDockerContainers]: {
    request: void;
    response: DockerContainerInfo[];
  };
  [PlatformChannels.ListSSHConfigAliases]: {
    request: void;
    response: SSHConfigAliasOption[];
  };
  [PlatformChannels.LoadMcpFromUserDirectory]: {
    request: LoadCliMcpFromUserDirectoryRequest;
    response: LoadCliMcpFromUserDirectoryResult;
  };
  [PlatformChannels.SaveMcpToUserDirectory]: {
    request: SaveCliMcpToUserDirectoryRequest;
    response: { success: boolean; error?: string };
  };
  [PlatformChannels.MigrateLegacyCommonMcp]: {
    request: MigrateLegacyCommonMcpRequest;
    response: MigrateLegacyCommonMcpResult;
  };
  [PlatformChannels.Log]: {
    request: { level: "info" | "warn" | "error"; args: unknown[] };
    response: void;
  };
  [PlatformChannels.SyncWebRemoteControlWorkspaces]: {
    request: WebRemoteControlWorkspaceTarget[];
    response: void;
  };
  [PlatformChannels.WebRemoteControlReconnectWorkspace]: {
    request: WebRemoteControlReconnectWorkspaceRequest;
    response: WebRemoteControlReconnectWorkspaceResult;
  };
  [PlatformChannels.WebRemoteControlRendererAction]: {
    request: WebRemoteControlRendererActionRequest;
    response: WebRemoteControlRendererActionResult;
  };
  [PlatformChannels.SyncWindowUnreadCount]: {
    request: number;
    response: void;
  };
  [PlatformChannels.SyncAppSettings]: {
    request: Partial<AppSettings>;
    response: void;
  };
  [PlatformChannels.GetResourceUsageSnapshot]: {
    request: void;
    response: ResourceUsageSnapshot;
  };
  [PlatformChannels.SetResourceUsageSamplingActive]: {
    request: boolean;
    response: void;
  };
  [PlatformChannels.StorageStartScan]: {
    request: void;
    response: { jobId: string };
  };
  [PlatformChannels.StorageCancelScan]: {
    request: string;
    response: void;
  };
  [PlatformChannels.StorageGetSnapshot]: {
    request: void;
    response: StorageUsageSnapshot | null;
  };
  [PlatformChannels.StorageClean]: {
    request: StorageCleanRequest;
    response: StorageCleanResult;
  };
  [PlatformChannels.StorageRevealPath]: {
    request: string;
    response: void;
  };
  [PlatformChannels.OpenExternal]: {
    request: string;
    response: void;
  };
  [PlatformChannels.OpenBrowserUrl]: {
    request: EmbeddedBrowserOpenUrlRequest;
    response: void;
  };
  [PlatformChannels.EmbeddedBrowserPermissionPrompt]: {
    request: EmbeddedBrowserPermissionPromptEvent;
    response: void;
  };
  [PlatformChannels.EmbeddedBrowserPermissionResolve]: {
    request: EmbeddedBrowserPermissionResolveRequest;
    response: void;
  };
  [PlatformChannels.GetEmbeddedBrowserSitePermissions]: {
    request: void;
    response: EmbeddedBrowserSitePermissionsSnapshot;
  };
  [PlatformChannels.SetEmbeddedBrowserSitePermission]: {
    request: EmbeddedBrowserSitePermissionUpdateRequest;
    response: EmbeddedBrowserSitePermissionsSnapshot;
  };
  [PlatformChannels.ClearEmbeddedBrowserSitePermissions]: {
    request: void;
    response: EmbeddedBrowserSitePermissionsSnapshot;
  };
  [PlatformChannels.ResetEmbeddedBrowserSitePermission]: {
    request: EmbeddedBrowserSitePermissionResetRequest;
    response: EmbeddedBrowserSitePermissionsSnapshot;
  };
  [PlatformChannels.BrowserViewDownloadStarted]: {
    request: { webContentsId: number; urls: string[] };
    response: void;
  };
  [PlatformChannels.BrowserViewReady]: {
    request: {
      workspaceKey: string;
      remoteSessionId?: string;
      sessionId: string;
      tabId: string;
      browserId: string;
      browserGeneration: number;
    };
    response: void;
  };
  [PlatformChannels.BrowserViewVisibility]: {
    request: {
      visible: boolean;
      workspaceKey: string;
      remoteSessionId: string | undefined;
      sessionId: string;
      tabId?: string;
      browserId: string;
      browserGeneration: number;
    };
    response: void;
  };
  [PlatformChannels.BrowserViewViewportChanged]: {
    request: BrowserViewViewportChangedPayload;
    response: void;
  };
  [PlatformChannels.BrowserViewScreenshotSurfacePrepare]: {
    request: BrowserViewScreenshotSurfacePreparePayload;
    response: void;
  };
  [PlatformChannels.BrowserViewScreenshotSurfaceReady]: {
    request: BrowserViewScreenshotSurfaceReadyPayload;
    response: void;
  };
  [PlatformChannels.BrowserViewScreenshotSurfaceRelease]: {
    request: BrowserViewScreenshotSurfaceReleasePayload;
    response: void;
  };
  [PlatformChannels.BrowserViewCloseTab]: {
    request: BrowserViewCloseTabNotification;
    response: void;
  };
  [PlatformChannels.BrowserViewSuspend]: {
    request: BrowserViewResidencyTransitionPayload;
    response: void;
  };
  [PlatformChannels.BrowserViewRestore]: {
    request: BrowserViewResidencyTransitionPayload;
    response: void;
  };
  [PlatformChannels.CanOpenCommunity]: {
    request: Locale;
    response: boolean;
  };
  [PlatformChannels.OpenInFileManager]: {
    request: string;
    response: { success: boolean; error?: string };
  };
  [PlatformChannels.OpenExternalFile]: {
    request: string;
    response: { success: boolean; error?: string };
  };
  [PlatformChannels.OpenCuaPermissionOnboarding]: {
    request: OpenCuaPermissionOnboardingOptions | undefined;
    response: CuaAccessibilitySettingsResult;
  };
  [PlatformChannels.PrepareCuaHelperPermissionDrag]: {
    request: undefined;
    response: PrepareCuaHelperPermissionDragResult;
  };
  // 单向 send（不是 invoke）：dragstart 必须同步发起，等不了 invoke 的往返。
  [PlatformChannels.StartCuaHelperPermissionDrag]: {
    request: undefined;
    response: void;
  };
  [PlatformChannels.NotifyCuaHelperPermissionDragEnded]: {
    request: undefined;
    response: void;
  };
  [PlatformChannels.CancelCuaPermissionOnboarding]: {
    request: { operationId: string };
    response: void;
  };
  [PlatformChannels.OAuthRegisterState]: {
    request: OAuthStateRegistration;
    response: void;
  };
  [PlatformChannels.OAuthCallback]: {
    request: string;
    response: void;
  };
  [PlatformChannels.PaymentCallback]: {
    request: string;
    response: void;
  };
  [PlatformChannels.ShareImport]: {
    request: { shareCode: string };
    response: void;
  };
  [PlatformChannels.OAuthCallbackHandled]: {
    request: void;
    response: void;
  };
  [PlatformChannels.RendererReady]: {
    request: void;
    response: void;
  };
  [PlatformChannels.SyncTelemetryContext]: {
    request: TelemetryRendererContext;
    response: void;
  };
  [PlatformChannels.ReportTelemetryEvent]: {
    request: RendererTelemetryEventPayload;
    response: void;
  };
  [PlatformChannels.ReportArmsCustomEvent]: {
    request: ArmsCustomEventPayload;
    response: void;
  };
  [PlatformChannels.GetRendererActionTraceConfig]: {
    request: void;
    response: RendererActionTraceConfigV1;
  };
  [PlatformChannels.RendererActionTraceConfigChanged]: {
    request: RendererActionTraceConfigV1;
    response: void;
  };
  [PlatformChannels.ReportRendererActionTraceBatch]: {
    request: RendererActionTraceBatchV1;
    response: void;
  };
  // 单向 send（不是 invoke）：60 秒一条的旁路遥测样本，renderer 不等 main 回执。
  [PlatformChannels.ReportRendererHeapSample]: {
    request: RendererHeapSample;
    response: void;
  };
  [PlatformChannels.ReadFinalArmsCustomEventsE2E]: {
    request: void;
    response: FinalArmsCustomEventE2EEntry[];
  };
  [PlatformChannels.ClearFinalArmsCustomEventsE2E]: {
    request: void;
    response: void;
  };
  [PlatformChannels.ConfigureFinalArmsCustomEventsE2E]: {
    request: ConfigureFinalArmsCustomEventE2ERequest;
    response: void;
  };
  [PlatformChannels.ShowTaskNotification]: {
    request: TaskNotificationPayload;
    response: void;
  };
  [PlatformChannels.TaskNotificationSound]: {
    request: void;
    response: void;
  };
  [PlatformChannels.TaskNotificationClick]: {
    request: string;
    response: void;
  };
  [PlatformChannels.ShowExtensionNotification]: {
    request: ExtensionNotificationPayload;
    response: NotificationsShowResult;
  };
  [PlatformChannels.ExtensionNotificationClick]: {
    request: ExtensionNotificationClick;
    response: void;
  };
  [PlatformChannels.WindowFullscreenChanged]: {
    request: boolean;
    response: void;
  };
  [PlatformChannels.GetDesktopWindowChromeState]: {
    request: void;
    response: DesktopWindowChromeState;
  };
  [PlatformChannels.DesktopWindowChromeStateChanged]: {
    request: DesktopWindowChromeState;
    response: void;
  };
  [PlatformChannels.WindowControlsOverlayChanged]: {
    request: WindowControlsOverlayMetrics;
    response: void;
  };
  [PlatformChannels.WindowControlsOverlayReady]: {
    request: WindowControlsOverlayReadyPayload;
    response: void;
  };
  [PlatformChannels.ExportLogs]: {
    request: void;
    response: { success: boolean; path?: string; error?: string };
  };
  [PlatformChannels.CaptureWindowScreenshot]: {
    request: void;
    response: {
      dataBase64: string;
      filename: string;
      contentType: string;
      size: number;
    } | null;
  };
  // CDP-on-guest pivot：renderer `<webview>` 上报 guest webContentsId → main attach。
  [PlatformChannels.BrowserViewAttachGuest]: {
    request: {
      key: string;
      webContentsId: number;
      active?: boolean;
      workspaceKey?: string;
      remoteSessionId?: string;
      sessionId?: string;
      residencyGeneration?: number;
    };
    response: void;
  };
  [PlatformChannels.BrowserViewDetachGuest]: {
    request: { key: string; webContentsId: number };
    response: boolean;
  };
  [PlatformChannels.BrowserViewCloseTabFromRenderer]: {
    request: BrowserViewCloseTabRequest;
    response: void;
  };
  [PlatformChannels.BrowserViewReportResidency]: {
    request: BrowserViewResidencyReportPayload;
    response: void;
  };
  [PlatformChannels.BrowserViewPromoteDraftTabs]: {
    request: BrowserViewPromoteDraftTabsRequest;
    response: string[];
  };
  [PlatformChannels.BrowserViewSuspendReady]: {
    request: { tabId: string; generation: number };
    response: void;
  };
  [PlatformChannels.BrowserViewEnsureResident]: {
    request: BrowserViewCloseTabRequest;
    response: void;
  };
  [PlatformChannels.BrowserViewRestoreTabs]: {
    request: BrowserViewRestoreTabsRequest;
    response: BrowserViewRestoredTabShell[];
  };
  [PlatformChannels.BrowserViewUpdateViewport]: {
    request: { tabId: string; viewport: BrowserViewportSize | null };
    response: void;
  };
  [PlatformChannels.EmbeddedBrowserJavaScriptDialog]: {
    request: {
      type: "alert" | "confirm";
      message: string;
    };
    response: {
      handled: boolean;
      value?: boolean;
    };
  };
  [PlatformChannels.UpdateReady]: {
    request: string;
    response: void;
  };
  [PlatformChannels.UpdateCheckResult]: {
    request: UpdateCheckResultPayload;
    response: void;
  };
  [PlatformChannels.UpdateStateChanged]: {
    request: UpdateStatePayload;
    response: void;
  };
  [PlatformChannels.GetUpdateState]: {
    request: void;
    response: UpdateStatePayload;
  };
  [PlatformChannels.DownloadUpdate]: {
    request: void;
    response: void;
  };
  [PlatformChannels.CancelUpdateDownload]: {
    request: void;
    response: void;
  };
  [PlatformChannels.OpenUpdateStatusWindow]: {
    request: void;
    response: void;
  };
  [PlatformChannels.GetAutoUpdatePreferences]: {
    request: void;
    response: {
      autoDownloadAndInstallUpdates: boolean;
    };
  };
  [PlatformChannels.SetAutoDownloadAndInstallUpdates]: {
    request: boolean;
    response: void;
  };
  [PlatformChannels.SettingsChanged]: {
    request: void;
    response: void;
  };
  [PlatformChannels.ApplicationLocaleChanged]: {
    request: Locale;
    response: void;
  };
  [PlatformChannels.GetSystemLocale]: {
    request: void;
    response: Locale;
  };
  [PlatformChannels.GetDesktopSessionActivity]: {
    request: void;
    response: {
      runningAgentSessionCount: number;
    };
  };
  [PlatformChannels.GetDesktopZoomLevel]: {
    request: void;
    response: DesktopZoomState;
  };
  [PlatformChannels.DesktopZoomLevelChanged]: {
    request: DesktopZoomState;
    response: void;
  };
  [PlatformChannels.PostUpdateReleaseNotes]: {
    request: PostUpdateReleaseNotesPayload;
    response: void;
  };
  [PlatformChannels.AcknowledgePostUpdateReleaseNotes]: {
    request: string;
    response: void;
  };
  [PlatformChannels.SkipUpdateVersion]: {
    request: string;
    response: void;
  };
  [PlatformChannels.QuitAndInstallUpdate]: {
    request: void;
    response: void;
  };
  [PlatformChannels.GetInstalledEditors]: {
    request: string | undefined;
    response: EditorInfo[];
  };
  [PlatformChannels.GetFileApplications]: {
    request: FileApplicationTarget;
    response: FileApplicationInfo[];
  };
  [PlatformChannels.OpenFileWithApplication]: {
    request: { applicationId: string; target: FileApplicationTarget };
    response: { success: boolean; error?: string };
  };
  [PlatformChannels.GetApplicationIcon]: {
    request: string | import("./platform.js").ApplicationIconRequest;
    response: import("./platform.js").ApplicationIconInfo | null;
  };
  [PlatformChannels.OpenInEditor]: {
    request: { editorId: string; path: string; options?: OpenInEditorOptions };
    response: { success: boolean; error?: string };
  };
  [PlatformChannels.CloseActiveContextRequest]: {
    request: void;
    response: void;
  };
  [PlatformChannels.ExecuteDesktopCommand]: {
    request: DesktopCommandId;
    // 返回值直通 main 进程 handler 的 return（GetCuaOsSupport 返回 CuaOsSupport），
    // 与 renderer 侧 IPlatformService.executeDesktopCommand 的 Promise<unknown> 对齐。
    response: unknown;
  };
  [PlatformChannels.SetApplicationLocale]: {
    request: Locale;
    response: void;
  };
  [PlatformChannels.SetTitleBarTheme]: {
    request: DesktopTitleBarTheme;
    response: void;
  };
}
