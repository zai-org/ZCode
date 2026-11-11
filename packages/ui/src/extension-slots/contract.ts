import type {
  ContributionSnapshot,
  ExtensionHostStatus,
  ExtensionLogEntry,
  ExtensionStaticTable,
  ExtensionViewInput,
  LocalizedText,
  SlotBadge,
  SlotValue,
  StaticSlotItem,
  StaticView,
  WorkspaceRef,
} from "@zcode/shared/extension-host";
import type { ModelSelection, ZCodePluginMentionItem } from "@zcode/shared";
import type { DraftPluginUiOpenRequest } from "@/plugin-ui/contract.js";

// extension-slots 的公开契约（docs/plugins/extension-host.md §4、§6、§16.1）。
// Renderer 只持三份数据的最近一份：静态表（Window Host）、贡献表快照（扩展进程：运行状态与动态值）、
// 扩展进程状态（Main）。插槽条目由三者合并得到；插槽组件只渲染数据，样式由壳层决定。

/** Renderer 持有的三份最近数据；合并函数（domain/slotSelectors.ts）只读它们。 */
export interface ExtensionSlotsSources {
  table: ExtensionStaticTable | null;
  snapshot: ContributionSnapshot | null;
  status: ExtensionHostStatus | null;
}

/** 插件详情页的「权限」区块（§17.7）：按插件 id 读授权状态，没有时不渲染。 */
export interface ExtensionPermissionsSectionProps {
  pluginId: string;
}

/** composer.mention（§16.6）的输入：输入框当前的作用域与 `@` 后的查询。 */
export interface ComposerMentionSlotProps {
  workspacePath: string;
  workspaceIdentity?: string;
  /** 有效会话：正式会话，或草稿的预热会话。tool 条目要会话，没有时不显示。 */
  sessionId: string | null;
  query: string;
  /** `@` 面板打开时为 true。关闭时不发查询，也不清掉已有结果（审批会让面板关闭，见 §16.6）。 */
  enabled: boolean;
}

/** `@` 面板里的一个插件分组：一个 composer.mention 条目。不显示的组（旧 CLI、空结果）不返回。 */
export interface ComposerMentionGroup {
  /** 条目全局 id。 */
  itemId: string;
  pluginId: string;
  pluginName: string;
  /** 组名：条目标题 → 命令标题（command target）→ 插件名。 */
  title: LocalizedText;
  /**
   * loading：还没有任何结果；ready：最近采用的候选项（新查询在途时仍显示它）；
   * error：组内一行错误（errorCode）；stopped：扩展进程已停止，command 条目不可用。
   */
  state: "loading" | "ready" | "error" | "stopped";
  items: ZCodePluginMentionItem[];
  errorCode?: string;
}

export interface ComposerStatusSlotProps {
  workspacePath: string | null | undefined;
  workspaceIdentity?: string | null;
  /** 草稿为预热会话 id；没有会话时只显示 App 与工作区作用域的值。 */
  sessionId: string | null | undefined;
}

/** 一个要渲染的插槽条目：静态声明 ⊕ 运行状态 ⊕ 按作用域合并后的动态值。 */
export interface ExtensionSlotEntry {
  item: StaticSlotItem;
  pluginName: string;
  value: SlotValue;
  /**
   * target 在扩展进程里（view、command）且扩展进程已停止：条目不可用，显示「扩展已停止」，
   * 点击改为重新加载。MCP App 等不经扩展进程的条目始终为 false。
   */
  hostStopped: boolean;
}

/** 启动页问题行：每个插件最多一行。invalid 带字段路径。 */
export interface ExtensionProblem {
  pluginId: string;
  name: string;
  version?: string;
  state: "failed" | "invalid" | "incompatible";
  reason: string;
  path?: string;
}

export interface ComposerStatusSlotModel {
  items: ExtensionSlotEntry[];
  /** 执行命令（命令全局 id），作用域为当前会话；失败只记日志。 */
  runCommand(commandId: string): void;
}

export interface ExtensionLauncherModel {
  /** sidePane.launcher 的视图条目（已按作用域合并动态值并过滤 visible=false）。 */
  views: ExtensionLauncherViewItem[];
  /** 打开视图标签；不在提供方内时为 null。 */
  openView: OpenExtensionView | null;
  /** 清单问题（extension 非法、不兼容、条目不可用）与激活失败。 */
  problems: ExtensionProblem[];
  /** 扩展进程已停止（崩溃预算耗尽）。 */
  stopped: boolean;
  /** 重新加载扩展；没有扩展门面时为 null。 */
  reload: (() => void) | null;
  /**
   * 「扩展日志」一行的打开入口（§16.8）：静态表里有带 extension 的插件（任何清单状态）或扩展进程已停止时
   * 才有；否则为 null（没有扩展时缓冲里只有监管器的行）。
   */
  openLogs: OpenExtensionLogs | null;
  /** 从插件商店安装后等待激活确认的插件（§17.7）：每个一行「需要确认」。 */
  pendingActivations: Array<{ pluginId: string; name: string }>;
}

export interface ExtensionLauncherViewItem {
  /** 条目全局 id。 */
  itemId: string;
  /** 视图全局 id。 */
  viewId: string;
  title: LocalizedText;
  icon?: string;
  /** 所属扩展的插件名，作启动页行的说明。 */
  pluginName: string;
  /** 动态值的悬停说明。 */
  tooltip?: string;
  /** 扩展进程已停止：行显示「扩展已停止」，操作改为重新加载。 */
  hostStopped: boolean;
}

export interface ExtensionLauncherSectionProps {
  /** 当前工作区：sidePane.launcher 的动态值按工作区作用域合并。 */
  workspacePath?: string | null;
  workspaceIdentity?: string | null;
}

/**
 * 扩展视图标签页（docs/plugins/extension-host.md §8）：工作区级，可见规则同 developer-tools，
 * 草稿发送首条消息、切换会话后保留。id 由视图全局 id 派生，同一视图在一个侧栏只开一个；
 * file.viewer 打开的文件另带相对路径（`extension-view:<viewId>:file:<path>`），每个文件一个（§16.5）。
 * 只在内存里（与其他侧栏标签相同），标题与图标在打开时从静态表取（文件标签的标题是文件名）。
 */
export interface ExtensionViewSidePaneTab {
  id: `extension-view:${string}`;
  type: "extension-view";
  viewId: string;
  title: LocalizedText;
  icon?: string;
  /** 打开对象：file.viewer 打开文件时带，交给视图实例的 view.input。 */
  input?: ExtensionViewInput;
  /**
   * 视图声明了 scope: "app"（§18.1 H5）：打开时按静态表记下。这样的标签跟着当前工作区移动，
   * 切换工作区不卸载、不重建实例。file.viewer 的文件标签不带它。
   */
  appScoped?: true;
  ownerTaskId?: string | null;
  workspaceKey?: string | null;
  openedAt?: number;
}

/** 侧栏当前目标：焦点窗格的会话（草稿为预热会话），视图实例的作用域由它决定。 */
export interface ExtensionViewTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string | null;
}

/** 一个对话窗格报告给 Window Host 的屏幕会话（③ Renderer 报告）。 */
export interface WorkbenchPaneReport {
  paneId: string;
  /** 有效会话：正式会话 id，或草稿的预热会话 id；还没有时不报告。 */
  sessionId: string | null;
  workspacePath: string;
  workspaceIdentity?: string;
  isDraft: boolean;
  focused: boolean;
  /** 草稿的所选模型（只在 Renderer），正式会话不带。 */
  draftModel?: ModelSelection;
}

export interface ExtensionViewPaneProps {
  tab: ExtensionViewSidePaneTab;
  /** 标签页可见（侧栏展开且是当前标签）。 */
  visible: boolean;
  target: ExtensionViewTarget;
  /** 页面的 ui/open-link（只放行 http(s)）。 */
  onOpenExternal?: (url: string) => void;
}

/** 打开扩展视图标签：启动页条目与能力 views.open 共用。没有该视图时返回 false。 */
export type OpenExtensionView = (viewId: string) => boolean;

/**
 * 能力 workbench.startDraft（docs/plugins/extension-host.md §18.1 H2）由 App 层执行：开一个预填文字的新草稿，
 * 走 Root 的新建任务（插件市场「试用」同一条路径），不自动发送。返回 false 表示这个窗口不能新建草稿
 * （例如当前工作区只读且没有指定工作区）；草稿准备失败由 Root 提示用户，不经这里返回。
 */
export type StartExtensionDraft = (request: { text: string; workspace?: WorkspaceRef }) => boolean;

/** nav.primary 插槽（§16.4）由 Shell 提供的部分：经侧栏 props 传给 NavPrimarySlot。 */
export interface NavPrimarySlotHost {
  /** Shell 的当前任务 id（草稿为 null）：焦点窗格没有登记会话时按它找会话（同 usePluginUiPaneTarget）。 */
  sessionId: string | null;
  /** 没有会话时先进根草稿再打开 MCP App 页面（Shell 的 handleOpenDraftPluginUi）。 */
  onOpenDraftUi?: (request: DraftPluginUiOpenRequest) => void;
  /** 主视图不是对话时先回到对话：右侧面板只在对话主视图显示。 */
  onShowChat?: () => void;
}

export interface NavPrimarySlotProps extends NavPrimarySlotHost {
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
}

/** 一个导航条目：静态声明 ⊕ App 作用域的动态值。 */
export interface NavPrimaryItem {
  /** 条目全局 id。 */
  itemId: string;
  pluginId: string;
  pluginName: string;
  /** 条目标题；缺省时取视图标题（view target），再缺省取插件名。 */
  title: LocalizedText;
  icon?: string;
  tooltip?: string;
  /** 扩展设置的未读标记（§18.1 H11）：未读数或 "dot"。 */
  badge?: SlotBadge;
  /** view 是视图全局 id，surface 是 `ui.surfaces[].id`。 */
  target: { kind: "view" | "surface"; id: string };
  /** view target 且扩展进程已停止：显示「扩展已停止」，点击改为重新加载。 */
  hostStopped: boolean;
}

export interface NavPrimarySlotModel {
  /** 按当前语言的标题排序（相同时按插件 id）；label 是解析后的标题。 */
  items: Array<NavPrimaryItem & { label: string }>;
  open(item: NavPrimaryItem): void;
}

/** 打开 MCP App 页面（surface target，§16.3）。 */
export interface SlotSurfaceTarget {
  /** 发起打开的条目全局 id（日志用）。 */
  itemId: string;
  pluginId: string;
  surfaceId: string;
}

/** file.viewer 为某个文件选中的查看器（§16.5）。 */
export interface FileViewerRoute {
  itemId: string;
  pluginId: string;
  /** view 是视图全局 id，surface 是 `ui.surfaces[].id`。 */
  target: { kind: "view" | "surface"; id: string };
  /** view target 的视图声明（标签的图标）。 */
  view?: StaticView;
}

/** 按文件路径找插件查看器；没有可用的查看器时返回 null（走内置预览）。 */
export type FileViewerRouter = (path: string) => FileViewerRoute | null;

/**
 * 扩展日志标签页（docs/plugins/extension-host.md §16.8）：工作区级，可见规则同 developer-tools，
 * 每个侧栏一个（固定 id）。日志缓冲的 owner 是 Main，标签只显示 Renderer 日志 store 的投影。
 */
export interface ExtensionLogsSidePaneTab {
  id: "extension-logs";
  type: "extension-logs";
  ownerTaskId?: string | null;
  workspaceKey?: string | null;
  openedAt?: number;
}

/** 打开（或聚焦）扩展日志标签：启动页「扩展日志」一行与命令中心共用。 */
export type OpenExtensionLogs = () => void;

/** 来源过滤：全部、扩展进程（没有插件 id 的行）或某个插件。 */
export type ExtensionLogSourceFilter = "all" | "host" | `plugin:${string}`;
/** 级别过滤：全部、警告及以上、仅错误。 */
export type ExtensionLogLevelFilter = "all" | "warn" | "error";

/** 日志标签的渲染模型：Renderer 日志 store 的最近一份（最多 2000 条，不含已清空的部分）。 */
export interface ExtensionLogsModel {
  entries: ExtensionLogEntry[];
  /** 首次快照已到。 */
  loaded: boolean;
  /** 只清视图：之后只显示更新的条目。不影响 Main 的缓冲与日志文件。 */
  clear(): void;
}

export interface ExtensionLogsPaneProps {
  /** 标签页可见（侧栏展开且是当前标签）：可见时才按需滚到底。 */
  visible: boolean;
}
