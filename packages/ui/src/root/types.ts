import type {
  IPlatformService,
  UserInfo,
  WebRemoteControlMobileNavigationIntent,
  WebRemoteControlMobileTaskView,
  WebRemoteControlTaskTarget,
  WebRemoteControlWorkspaceListResult,
  WebRemoteControlWorkspaceSwitchOptions,
} from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import type { ReactNode } from "react";
import type { CreateTaskOptions, CreateTaskRequest } from "@/app-shell/types.js";
import type { SettingsShareTaskTarget } from "@/conversation-share-interaction/SettingsShareManagement.js";

export type WebRemoteControlTerminalTransportState =
  | "idle"
  | "connecting"
  | "authenticating"
  | "waiting"
  | "paired"
  | "reconnecting"
  | "suspended"
  | "kicked"
  | "error";

export interface WebRemoteControlWorkspaceSwitcherApi {
  /** 账号级设备导航由 Web 入口注入，不通过 workspace bridge/RPC 访问。 */
  deviceNavigation?: {
    deviceName?: string;
    /** 目标电脑平台（darwin / win32 / linux），来自本机记住的设备记录，只用于展示图标。 */
    devicePlatform?: string;
    chooseOtherDevice(): void;
  };
  listWorkspaces(): Promise<WebRemoteControlWorkspaceListResult>;
  openProjectDraft?(request: CreateTaskOptions): Promise<void>;
  onWorkspaceListUpdated?(
    listener: (result: WebRemoteControlWorkspaceListResult) => void,
  ): () => void;
  switchWorkspace(
    workspaceKey: string,
    options?: WebRemoteControlWorkspaceSwitchOptions,
  ): Promise<void>;
  /** 手机端项目侧栏确认用户查看了当前 bridge 内的未读 task；桌面任务选择链路不使用。 */
  markTaskRead?(task: WebRemoteControlTaskTarget): Promise<void>;
  updateMobileViewState?(workspaceKey: string, taskId?: string): Promise<void>;
  /** 只上报前台实际显示的任务；连接代际与 bridge 校验由 Web/Main 负责。 */
  updateMobileTaskView?(view: WebRemoteControlMobileTaskView | null): Promise<void>;
  reconnectWorkspace?(workspaceKey: string): Promise<void>;
  startDraft?(
    workspaceKey: string,
    options?: { mobileNavigationIntent?: WebRemoteControlMobileNavigationIntent },
  ): Promise<void>;
}

export interface RootProps {
  services: IServiceAccessor;
  platform: IPlatformService;
  /** 如果从 main 进程传入则跳过项目选择页 */
  initialWorkspaceAbsPath?: string;
  /** app-owned workspace 展示分类；缺省为真实项目。 */
  initialWorkspacePurpose?: import("@zcode/shared").WorkspacePurpose;
  /** 桌面启动时精确 active 的本地 workspace 不可用；仅用于本次 renderer 生命周期。 */
  unavailableWorkspacePath?: string;
  /** 初始 workspace 的身份隔离键，远程工作区需要透传 */
  initialWorkspaceIdentity?: string;
  /** 初始要打开的 task，从全局 task 列表进入时透传 */
  initialTaskId?: string;
  /** 手机目录 admission 完成后，在 prewarm 前接收项目和输入草稿。 */
  initialTaskDraft?: CreateTaskOptions;
  /** 本客户端连接目标的稳定身份，手机跨设备切换必须隔离草稿和 Recent。 */
  composerClientNamespace?: string;
  terminalOwnerId?: string;
  /** Electron renderer 传 true，用于启用自绘标题栏 */
  isDesktop?: boolean;
  /** macOS 桌面端需要给红绿灯按钮预留安全区 */
  isMacDesktop?: boolean;
  /** Windows 桌面端需要展示更准确的资源管理器文案 */
  isWindowsDesktop?: boolean;
  /** 是否恢复上次关闭时的标签页，首个窗口 true，新窗口 false */
  restoreSession?: boolean;
  /** 是否允许访问本地设置服务，远程窗口 false */
  supportsSettings?: boolean;
  /** 是否允许在当前壳层里切换/新开工作区 */
  allowOpenWorkspace?: boolean;
  /** 是否优先使用服务端目录浏览器，Web 普通模式不能依赖系统目录选择框 */
  preferDirectoryBrowser?: boolean;
  /** 是否支持 Electron 内嵌浏览器 side pane，默认仅桌面端支持 */
  supportsEmbeddedBrowser?: boolean;
  /** 是否启用远程工作区能力，Web 普通模式先只支持本地 server 工作区 */
  allowRemoteWorkspace?: boolean;
  /** Web 远程控制模式下的已打开 workspace 切换入口 */
  webRemoteControlWorkspaceSwitcher?: WebRemoteControlWorkspaceSwitcherApi;
  /** Web 远控跨 workspace 点击任务后的单次移动端落点 */
  initialSidebarFileTreeOpen?: boolean;
  initialWebRemoteControlMobileNavigationIntent?: WebRemoteControlMobileNavigationIntent;
  /** Web 远控手机端 relay terminal transport 状态，用于已进入页面后的轻量恢复提示 */
  webRemoteControlTerminalTransportState?: WebRemoteControlTerminalTransportState;
  /** 手机 Web 远控初始 workspace 注入前继续展示的入口 loading，桌面端不使用 */
  initialWorkspaceLoadingFallback?: ReactNode;
  /** Web 远程控制入口能力开关；默认只在 development 启用 */
  webRemoteControlFeatureEnabled?: boolean;
  /** Assistant code-comment 卡片灰度；默认关闭，关闭时保留原始 directive。 */
  assistantCodeCommentCardsEnabled?: boolean;
}

export interface WorkspaceSettingsLayerProps {
  workspaceScopedServices?: IServiceAccessor;
  isDesktop?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  isWebRemoteControl?: boolean;
  windowsWindowControlsRightPaddingPx?: number;
  captionWorkspacePath?: string | null;
  onBack?: () => void;
  /** 设置页分享管理「跳转对话」；与 Root 层 SettingsPage 使用同一导航入口。 */
  onOpenTask?: (target: SettingsShareTaskTarget) => void;
  onCreateTask?: (request?: CreateTaskRequest) => void;
  onOpenWorkspace?: () => void;
  onOpenRemoteWorkspace?: () => void;
  allowOpenWorkspace?: RootProps["allowOpenWorkspace"];
  onLogin?: () => void;
  onLogout?: () => void;
  user?: UserInfo | null;
}
