import type { RemoteAssetInstallMode } from "./remoteAssetInstallMode.js";
import type { RemoteResourcePackageSelection } from "./remoteResourcePackages.js";
import type { ProviderFamilyDomain } from "./model-provider-family.js";
import type { ProviderFamilyConnectionSelectionSettings } from "./provider-family-connection-selection.js";
import type { ZCodeProvider } from "./zcode-task-types-core.js";
import type { WorkspacePurpose } from "./workspacePurpose.js";
import type { DynamicWorkflowMode } from "./dynamic-workflow-feature.js";
import type { EmbeddedBrowserViewportPreference } from "./browser-use/command-metadata.js";
import type { AppToolSearchMode } from "./app-runtime-preferences.js";

// ── Domain types ──

export interface FileEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  /** 旧远端服务端可能不返回；调用方应按 false 处理。 */
  isSymbolicLink?: boolean;
}

export interface FileStat {
  path: string;
  type: "file" | "directory";
  /** 文件字节数；旧远端服务端可能不返回，调用方需按 undefined 处理。 */
  size?: number;
  /** 文件最后修改时间；分享分块读取用它检测读取期间的并发改写。 */
  mtimeMs?: number;
}

/** 文件系统变更事件（目录级粒度） */
export interface FileWatchEvent {
  /** 发生变更的目录路径 */
  dirPath: string;
  /**
   * 能由底层 watcher 确认时返回发生变化的完整路径。
   * 旧 Host、平台未返回 filename 或同一防抖窗口包含多个路径时省略，调用方应保守刷新。
   */
  changedPath?: string;
}

export interface FileTextSlice {
  path: string;
  content: string;
  offset: number;
  bytesRead: number;
  totalBytes: number;
  truncated: boolean;
  isBinary: boolean;
}

export interface FileMediaPreview {
  path: string;
  mediaType: string;
  dataBase64: string;
  totalBytes: number;
}

export interface FileBinaryPreview {
  path: string;
  dataBase64: string;
  totalBytes: number;
}

export interface WorkspaceFileEntry {
  name: string;
  path: string;
  relativePath: string;
  type: "file" | "directory";
}

export interface SystemInfo {
  homedir: string;
  platform: string;
}

/**
 * 支持的界面语言（BCP-47）。顺序即设置页下拉的展示顺序。
 * 新增语言的步骤见 docs/i18n/ui-locales.md。
 */
export const SUPPORTED_LOCALES = ["zh-CN", "en-US", "ja-JP", "ru-RU", "ko-KR"] as const;

/** 支持的语言 */
export type Locale = (typeof SUPPORTED_LOCALES)[number];

/** 界面语言偏好；system 表示跟随当前运行端系统语言。 */
export type LocalePreference = "system" | Locale;

/** ZCode 运行中继续输入时的交互行为 */
export type ZCodeInteractionBehavior = "queue" | "guide";

/** 桌面端 Electron 自动更新发布通道。 */
export type ElectronReleaseChannel = "stable" | "preview";

/** Windows Bash 工具可使用的集成终端 shell 方言。 */
export type IntegratedTerminalShellDialect = "cmd" | "git-bash";

/** 设置页中 Windows Bash shell 的用户选择。 */
export type IntegratedTerminalShellSelection =
  | { mode: "auto" }
  | {
      mode: "shell";
      dialect: IntegratedTerminalShellDialect;
      id: string;
      label: string;
      path: string;
    };

/** 当前 host 可识别的 Windows shell 选项。 */
export interface IntegratedTerminalShellOption {
  dialect: IntegratedTerminalShellDialect;
  id: string;
  label: string;
  path: string;
  source: "system" | "path";
}

/** 默认语言 */
export const DEFAULT_LOCALE: Locale = "zh-CN";

// ── Workspace / Tab ──

/** 标签页唯一标识 */
export type TabId = string;

/** 单个标签页的状态 */
export interface TabState {
  id: TabId;
  /** workspace 绝对路径 */
  workspacePath: string;
  /** 显示名称，通常为路径最后一段 */
  label: string;
}

export interface SSHRemoteTargetSnapshot {
  kind: "ssh";
  host: string;
  port?: number;
  username: string;
  /** 用户建立连接时选择的 SSH config Host alias，仅用于 UI 展示。 */
  sshConfigAlias?: string;
  privateKeyPath?: string;
  assetInstallMode?: RemoteAssetInstallMode;
  resourcePackages?: RemoteResourcePackageSelection;
  /**
   * SSH 密码不会写入 setting.json。
   * 这里只保存 credentialService 的键名，恢复时再去安全存储读取真实密码。
   */
  passwordCredentialKey?: string;
  /**
   * 私钥口令不会写入 setting.json。
   * 这里只保存 credentialService 的键名，恢复时再去安全存储读取真实口令。
   */
  privateKeyPassphraseCredentialKey?: string;
}

export interface WSLRemoteTargetSnapshot {
  kind: "wsl";
  distro?: string;
  user?: string;
}

export interface DockerRemoteTargetSnapshot {
  kind: "docker";
  container: string;
}

export interface ServerRemoteTargetSnapshot {
  kind: "server";
  url: string;
  name?: string;
  workspacePath?: string;
  serverId?: string;
  /**
   * Server token 不写入 setting.json。
   * 这里只保存 credentialService 的键名，恢复时再读取真实 token。
   */
  tokenCredentialKey?: string;
}

export type RemoteTargetSnapshot =
  | SSHRemoteTargetSnapshot
  | WSLRemoteTargetSnapshot
  | DockerRemoteTargetSnapshot
  | ServerRemoteTargetSnapshot;

export interface RemoteWorkspaceSessionSnapshot {
  /** 远程 workspace 的真实绝对路径 */
  workspacePath: string;
  /** 用户可见的 workspace 分类；旧远端快照缺失时按 project 兼容读取。 */
  workspacePurpose?: WorkspacePurpose;
  /** 发起远程连接时的本机 workspace 路径，仅用于 MCP filesystem 路径改写。 */
  localWorkspacePath?: string;
  /** 远程 workspace 的稳定身份键（authority + canonicalPath）。 */
  workspaceIdentity?: string;
  /** 远程连接目标的可恢复快照 */
  target: RemoteTargetSnapshot;
  /** 最近一次成功打开该 workspace 的时间戳 */
  lastOpenedAt: number;
  /** 最近一次恢复/重连结果 */
  lastConnectionStatus: "connected" | "failed";
  /** 最近一次失败原因；成功后清空 */
  lastConnectionError?: string;
  /** 最近一次失败的错误码，与 lastConnectionError 同写同清；等待点也写成失败，只看文案分不清两类 */
  lastConnectionErrorCode?: string;
}

export interface LocalWorkspaceSessionEntry {
  kind: "local";
  workspacePath: string;
  /** 项目展示分类；旧数据缺省为 project，conversation 仍使用真实 workspacePath 作为 cwd/key。 */
  workspacePurpose?: WorkspacePurpose;
}

export interface RemoteWorkspaceSessionEntry extends RemoteWorkspaceSessionSnapshot {
  kind: "remote";
}

export type PersistedWorkspaceSessionEntry =
  | LocalWorkspaceSessionEntry
  | RemoteWorkspaceSessionEntry;

// ── Process Monitor ──

/** 资源管理器分类：基础服务 / 任务进程 / 内置插件 / 社区插件 */
export type ResourceUsageCategory = "base" | "task" | "builtin-plugin" | "community-plugin";

/** 基础服务分组键；插件分组键为插件名或 MCP server name */
export type ResourceUsageBaseGroupKey = "main" | "gpu" | "renderer" | "host" | "cli" | "utility";

/** 资源管理器中的一个进程行（CPU 为整机归一化百分比，内存为字节） */
export interface ResourceUsageProcess {
  pid: number;
  /** 进程显示名，如 zcode-main / zcode-agent-zcode-demo / node_repl */
  name: string;
  category: ResourceUsageCategory;
  groupKey: string;
  groupLabel: string;
  cpuPercent: number;
  memoryBytes: number;
  /** false 表示只知道拓扑，指标尚未采到（显示为 —） */
  sampled: boolean;
}

/** Host 侧采样得到的外部进程行（Agent / MCP / 终端等），由 main 合并进快照 */
export type HostResourceUsageProcess = Omit<ResourceUsageProcess, "sampled">;

/** 资源管理器一次完整快照，由 main 进程合并 Electron 指标、系统总量与 Host 采样后返回 */
export interface ResourceUsageSnapshot {
  sampledAt: number;
  logicalCpuCount: number;
  system: {
    cpuPercent: number;
    memoryTotalBytes: number;
    memoryUsedBytes: number;
  };
  app: {
    cpuPercent: number;
    memoryBytes: number;
  };
  processes: ResourceUsageProcess[];
}

export interface AppSettings {
  /** 当前 App/Host 不再显示提交前体验套餐推荐；不改变任何入口的模型选择。 */
  startPlanRecommendationDismissed?: boolean;
  recentProjects: string[]; // 最近项目列表，最多保留 10 个
  locale: Locale; // 界面语言
  /**
   * 用户覆盖的快捷键绑定（命令 ID → 绑定串数组，格式见 shortcutCommands.ts）。
   * 只存用户覆盖：未覆盖的命令不落盘，读取时与 SHORTCUT_COMMANDS 默认绑定合并；
   * 覆盖语义为整组替换（如 openCommandCenter 的双默认绑定被覆盖时同时失效）。
   */
  shortcutBindings?: Record<string, string[]>;
  /** 界面语言偏好；locale 保存偏好解析后的实际语言，供 main/menu/远控等非浏览器上下文使用。 */
  localePreference?: LocalePreference;
  /** 是否尽量继承系统终端 profile、shell 环境和字体 */
  terminalInheritSystemProfile?: boolean;
  /** 用户显式覆盖的终端字体；为空时从系统终端配置自动探测 */
  terminalFontFamily?: string;
  /** Windows 下 Bash 工具使用的本机 shell；未配置时自动选择。 */
  integratedTerminalShell?: IntegratedTerminalShellSelection;
  /** HTTP/HTTPS 出口代理，例如 http://127.0.0.1:7890；为空时直连。下次启动 app/agent 生效。 */
  httpProxy?: string;
  /** 代理绕过规则，例如 localhost,127.0.0.1,.example.com；只在 httpProxy 存在时影响 renderer，agent/tool 仍按显式环境使用。 */
  httpProxyNoProxy?: string;
  /** 自定义 PEM 根证书路径；下次启动 app/agent 时用于 renderer 校验与 agent NODE_EXTRA_CA_CERTS。 */
  httpProxyCaCertPath?: string;
  /**
   * 内置浏览器忽略 HTTPS 证书校验错误（自签名、过期、域名不匹配等），用于访问内网测试站点。
   * 只影响内置浏览器出口，不影响 ZCode 自身对后端与模型 API 的请求。默认关闭，重启后生效。
   */
  embeddedBrowserAllowInsecureCertificates?: boolean;
  /** 文件树单击本地 .html 文件时在内置浏览器打开（默认 false：沿用源码预览）。右键「打开」始终是源码预览。 */
  fileTreeHtmlClickOpensBrowser?: boolean;
  /** 人类用户主动打开 Browser tab 时的一次性显示偏好；Agent Browser Use 不读写。 */
  embeddedBrowserViewportPreference?: EmbeddedBrowserViewportPreference;
  /**
   * 用户已在设置页关闭输入框的「电脑操作」按钮（内部 hidden 态）。
   * 取 hidden 语义而非 visible：undefined 即默认显示，老用户无需数据迁移。
   * 关闭后按钮不再渲染，且不因重启或版本更新自愈，仅能在设置页重新开启。
   */
  computerUseComposerEntryHidden?: boolean;
  /** 自动归档旧会话的总开关 */
  taskAutoArchiveEnabled?: boolean;
  /** 自动归档修复后的一次性关闭标记；只用于设置迁移，不参与归档判断。 */
  taskAutoArchiveResetVersion?: 1;
  /** 自动归档阈值；当任务最后更新时间早于该天数时允许被归档 */
  taskAutoArchiveOlderThanDays?: number;
  /** 桌面端关闭窗口时隐藏到托盘驻留（Windows/Linux；spec：docs/desktop/linux-close-to-tray.md） */
  closeToTrayOnWindows?: boolean;
  /** 存在执行中的闲时任务时阻止系统闲置休眠（手动开关，防不了合盖）。 */
  keepAwakeWhileRunning?: boolean;
  /** 本机 offline push 上报开关，缺省视为开启（spec：docs/web-remote-control/mobile-event-push.md 6.4）。 */
  mobilePushEnabled?: boolean;
  /** Windows 关闭到托盘默认值是否已执行过一次性迁移；只用于设置迁移，不参与业务判断。 */
  closeToTrayOnWindowsMigrationInitialized?: boolean;
  /**
   * Linux 关闭到托盘默认值（关）是否已执行过一次性归位迁移。
   * shared 迁移无平台概念、曾把存量 Linux 用户归为 true，而 Linux 此前无设置入口，
   * main 进程 bootstrap 借此标记把首次启动的 Linux 用户一次性归位为默认关。
   */
  closeToTrayLinuxMigrationInitialized?: boolean;
  /** 桌面端全局页面缩放档位；用于重启后恢复界面缩放，Web/手机端忽略。 */
  desktopZoomLevel?: number;
  /** 桌面主窗口最近一次非最大化宽高及最大化状态；Web/手机端忽略。 */
  desktopWindowSize?: {
    width: number;
    height: number;
    maximized: boolean;
  };
  /** 桌面端 Chromium 硬件加速开关；只在下次启动 main 进程早期生效，Web/手机端忽略。 */
  desktopChromiumHardwareAccelerationEnabled?: boolean;
  /** 是否在消息流中展示模型思考过程 */
  messageStreamShowReasoning?: boolean;
  // TODO(settings-schema-version): 能证明所有受支持升级路径都已执行本次迁移后，改用统一 settings schema version，并一起删除此 marker、迁移函数和持久化判断。
  /** 显示模型思考过程的默认值是否已执行过一次性迁移；只用于设置迁移，不参与消息渲染判断。 */
  messageStreamShowReasoningMigrationInitialized?: boolean;
  /** 是否在消息流中展示 todo 工具渲染；不影响摘要面板的 todo */
  messageStreamShowTodos?: boolean;
  /** ZCode 运行中继续输入时，是排队到下一轮，还是引导到下一次工具调用后运行 */
  zcodeInteractionBehavior?: ZCodeInteractionBehavior;
  /** Agent 提问五分钟无人回答时是否允许自动继续；缺失按开启兼容旧配置。 */
  askUserQuestionAutoResolutionEnabled?: boolean;
  /** 默认关闭，控制对话中的插件发现和推荐；设置页手动安装保持可用。 */
  pluginAutoRecommendationEnabled?: boolean;
  /** 是否完整保留 Model I/O；开启后不轮转、不限额重置、不压缩或裁剪，鉴权信息仍会脱敏。 */
  modelIoFullRetentionEnabled?: boolean;
  /**
   * 用户选的动态工作流模式（docs/dynamic-workflow/launch.md「The user's choice」）。缺席 = 跟随服务端
   * 提供的模式；只在功能已提供时生效。选回提供的模式时删除该字段，未改动的安装继续跟随服务端翻转。
   */
  dynamicWorkflowMode?: DynamicWorkflowMode;
  /** 已启用的内置 Agent CLI；UI 对外仍展示为“Install”，底层语义保持为启用内置能力。 */
  enabledBuiltinAgentCliProviders?: ZCodeProvider[];
  /** 设置页中每个 Provider Family 当前唯一的结构化连接选择。 */
  providerFamilyConnectionSelections?: ProviderFamilyConnectionSelectionSettings;
  /** 用户通过 WelcomeScreen 成功连接后确认的 ZAI / BigModel provider family 运行域。 */
  providerFamilyDomain?: ProviderFamilyDomain;
  /** 最近一次设置或清空 providerFamilyDomain 的时间。 */
  providerFamilyDomainUpdatedAt?: number;
  /** 旧 oauth/provider 状态是否已经尝试迁移到 providerFamilyDomain。 */
  providerFamilyDomainMigrated?: boolean;
  /** 新建或冷恢复 Session 是否为 Bash 注入 bfs/ugrep 增强；默认启用。 */
  nativeSearchEnhancementsEnabled?: boolean;
  /** 新建或冷恢复时读取；已有 Runtime 保持原策略。 */
  toolSearchMode?: AppToolSearchMode;
  /** 新建或冷恢复 Session 是否启用 Memory；默认关闭。 */
  memoryEnabled?: boolean;
  onboardingOccupation?:
    | "office"
    | "developer"
    | "independent"
    | "infrastructure"
    | "product"
    | "design"
    | "student"
    | "creator"
    | "operations"
    | "marketing"
    | "finance"
    | "accounting"
    | "legal"
    | "other"
    | null;
  proactiveSuggestionsEnabled?: boolean;
  /** 新版只保存活动执行目录；不表达项目/连接成员，null 表示明确清空。 */
  lastActiveWorkspace?: PersistedWorkspaceSessionEntry | null;
  /** Host 从项目/本机入口派生，供旧版降级读取；新版不作为入口真相。 */
  lastWorkspaceSession?: PersistedWorkspaceSessionEntry[];
  /** 每个 Source Server 已解析的 canonical conversation backing workspace。 */
  remoteConversationWorkspaceBySourceServerId?: Record<
    string,
    {
      workspacePath: string;
      lastResolvedAt: number;
    }
  >;
  /** R3 控制端已识别的 Source Server；运行态仍由远端 Server 权威提供。 */
  sourceServers?: import("./source-server/contracts.js").SourceServerRecord[];
  /** R3 到达 Source Server 的线路；只保存 credential key，不保存 secret。 */
  connectionProfiles?: import("./source-server/contracts.js").ConnectionProfile[];
  /** R3 workspace 打开历史；连接线路与 workspace 实体分离。 */
  sourceServerWorkspaceHistory?: import("./source-server/contracts.js").SourceServerWorkspaceHistoryEntry[];
  /** 桌面端启动时是否执行 Source Server 静默重连；缺失按 true 兼容旧设置。 */
  remoteStartupAutoReconnectEnabled?: boolean;
  sourceServerDirectoryMigrationVersion?: 1;
  /** 旧客户端只接受 2；保留回滚兼容，新介绍不使用该字段判断已读。 */
  remoteBoundaryOnboardingVersion?: 2;
  /** 仅表示用户明确确认持续运行介绍。 */
  remoteBoundaryIntroAcknowledgedVersion?: 1;
  /** 上次关闭时激活的 tab 索引 */
  lastActiveTabIndex?: number;
  /** 每个 workspace 的最后活跃 taskId，下次打开自动恢复 */
  lastActiveTaskByWorkspace?: Record<string, string>;
  /** 数据目录的根路径（替代 homedir），默认为 os.homedir()；.zcode/v2 后缀不变 */
  dataBaseDir?: string;
  /** 自动更新安装完成后，等待首次启动展示的版本说明 */
  pendingPostUpdateReleaseNotes?: {
    version: string;
    title: string;
    markdown: string;
    releaseDate?: string;
    releaseNotesByLocale?: Partial<Record<Locale, { title: string; markdown: string }>>;
  };
  /** 设置页“接收 preview 自动更新”偏好；仅桌面端自动更新读取。 */
  receivePreviewUpdates?: boolean;
  /** 设置页/更新弹窗“以后自动下载并安装更新”偏好；仅桌面端自动更新读取。 */
  autoDownloadAndInstallUpdates?: boolean;
  /** 用户跳过的 Electron 自动更新版本；按通道隔离，避免 stable / preview 互相遮挡。 */
  skippedElectronUpdateVersions?: Partial<Record<ElectronReleaseChannel, string>>;
  /** 首次启动设置同步提示是否已消费；只表示弹窗不再出现，不代表导入成功。 */
  settingsSyncFirstRunPromptHandled?: boolean;
  /** 外部 Web 远控 relay 的非敏感设备身份；passHash 必须存 credentialService。 */
  /** V2 非敏感注册身份；JWT 和一次性 token 不持久化于 AppSettings。 */
  webRemoteControlRelayV2Device?: {
    deviceSid: string;
    userId: string;
    endpointOrigin: string;
  };
  webRemoteControlExternalRelayDevice?: {
    deviceSid: string;
  };
  /** 上次成功开启 Web 远控时的目标；缺失表示用户已明确关闭，不自动恢复。 */
  webRemoteControlLastEnabledContext?: {
    workspacePath: string;
    workspaceIdentity?: string;
    initialTaskId?: string;
  };
  /** 设置页里的临时 endpoint override；正式/测试默认 base url 由 ZCODE_BASE_URL env 管理。 */
  zcodeEndpointOrigin?: string;
}
