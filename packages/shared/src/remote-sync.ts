import type { ModelSelection } from "./model-selection.js";
import type { BuiltInSubagentName } from "./subagents-types.js";
import type { WorkspaceHookDefinition, WorkspaceHookEventName } from "./workspace-hook-config.js";

export interface RemoteSyncWriteAccessResult {
  ok: boolean;
  path: string;
  error?: string;
}

/**
 * 数据同步（docs/remote/data-sync.md）各分类共用的服务形状。
 * 两端实现同一组方法，Renderer 按分类分派；比较逻辑在 Renderer 纯函数中完成。
 */

/** 条目不能参与同步的原因。exportBlockedReason 由来源端判定，overwriteBlockedReason 由目标端判定。 */
export type DataSyncBlockedReason =
  | "size-limit"
  | "contains-symlink"
  | "target-symlink"
  | "compat-directory"
  /** 目标端同名 inline 插件不在 `~/.zcode/plugins` 下（例如开发中的 checkout）。 */
  | "external-directory"
  /** 目标端整类不能导入：远端实际生效的是 `~/.agents` 兼容配置（MCP），推送会使其失效。 */
  | "target-compat-config"
  /** marketplace 插件：本机来源已删除（Orphaned Installed Plugin）。 */
  | "source-removed"
  /** marketplace 插件：远端来源的最新版本与本机版本不一致，不能更新。 */
  | "remote-latest-mismatch"
  /** marketplace 插件：本地目录类来源镜像不支持跨 marketplace 的依赖。 */
  | "cross-marketplace-dependency"
  /** marketplace 插件：来源类型（如 npm）不支持同步。 */
  | "unsupported-source";

/** 轻量签名：文件数 + 总字节。不同即判为内容不同，相同时才计算全量哈希。 */
export interface DataSyncItemSignature {
  fileCount: number;
  totalBytes: number;
}

/**
 * 子智能体分类：frontmatter 中按名称引用的依赖（只含运行时支持的字符串形式；对象形式的 MCP 是内联配置，不依赖目标端）。
 * 弹窗用同一弹窗中 MCP / 技能分类的目标端列表判断缺失，名称按各分类对齐规则（trim + 小写）匹配。
 */
export interface DataSyncItemDependencies {
  mcpServers?: string[];
  skills?: string[];
}

/** 子智能体分类：内置智能体模型覆盖的展示信息。对齐与比较仍按 key 与 contentHash。 */
export interface DataSyncModelOverrideSummary {
  modelId: string;
  reasoningLevel?: string;
}

export interface DataSyncListItem {
  /** 对齐 key，两端相同即视为同一项。 */
  key: string;
  name: string;
  description?: string;
  /** 插件分类：Plugin id（`name@marketplace`，保留大小写）。 */
  pluginId?: string;
  /** 只有带可靠版本来源的条目才有（例如商店安装元数据）。 */
  version?: string;
  /** 只按版本比较（marketplace 插件）：版本相同即已同步，不计算内容哈希。 */
  versionOnly?: boolean;
  /** 作为目标时：该条目来源当前能安装的最新版本（marketplace 插件取该端 catalog 中的版本）。 */
  latestVersion?: string;
  signature?: DataSyncItemSignature;
  /** JSON 类条目哈希很便宜，可以直接在 list 中返回；目录类留空，按需调用 contentHashes。 */
  contentHash?: string;
  enabled: boolean;
  /** 作为来源时不能导出的原因。 */
  exportBlockedReason?: DataSyncBlockedReason;
  /** 作为目标时不能被覆盖的原因。 */
  overwriteBlockedReason?: DataSyncBlockedReason;
  /** 子智能体分类：引用的 MCP 服务器与技能（只用于行内提示，不影响行状态与勾选）。 */
  dependencies?: DataSyncItemDependencies;
  /** 子智能体分类：内置智能体的模型覆盖行，弹窗据此显示说明行（docs/remote/data-sync.md「子智能体」）。 */
  builtInModelOverride?: DataSyncModelOverrideSummary;
  /**
   * 技能分类：同一端内、目录包含本条目目录的最近一个技能的 key。
   * 父子技能同时推送时，弹窗据此把子技能与最上层的已选上级放进同一批（子技能随父目录一起写入）。
   */
  parentKey?: string;
}

export interface DataSyncListResult {
  items: DataSyncListItem[];
  homeDir: string;
  /** 作为目标时整类不能导入的原因；有值时该分类所有行都不可选。 */
  importBlockedReason?: DataSyncBlockedReason;
}

/**
 * 带项目上下文的入口（连接向导、Header、侧栏项目菜单）传入的 workspace 映射：本机项目路径 → 远端项目路径。
 * 需要路径改写的分类（MCP）比较与推送时先做 workspace 改写再做 home 改写；其他分类忽略。设置页入口不传。
 */
export interface DataSyncWorkspaceMapping {
  sourceWorkspacePath: string;
  targetWorkspacePath: string;
}

export interface DataSyncContentHashesResult {
  /** 只包含仍然存在且能计算的 key。 */
  hashes: Record<string, string>;
}

export type DataSyncImportMode = "createOnly" | "overwrite";

export interface DataSyncImportItem {
  key: string;
  mode: DataSyncImportMode;
  /** overwrite 时必填：列表加载时目标项的内容哈希，导入前重新计算，不一致返回 conflict。 */
  expectedTargetHash?: string;
}

export type DataSyncImportStatus = "created" | "updated" | "skipped" | "conflict" | "failed";

export interface DataSyncImportResultItem {
  key: string;
  status: DataSyncImportStatus;
  error?: string;
}

export interface DataSyncImportResult {
  results: DataSyncImportResultItem[];
}

/** 每次推送结束后写入本机的设备同步状态。 */
export type DeviceSyncResult = "success" | "partial" | "failed";

export interface DeviceSyncState {
  lastSyncAt: number;
  lastResult: DeviceSyncResult;
}

/**
 * 用户配置同步通道（`user-config-sync`）按 category 区分的分类：子智能体、命令、钩子共用这一个通道。
 * 新分类在这里追加 id，并在 UserConfigSyncPayloadMap 登记 payload 类型。
 */
export type UserConfigSyncCategory = "subagents" | "commands" | "hooks";

/** 子智能体 export 的结果，也是 import 的输入。按原文件字节传输，不经过表单序列化。 */
export interface SubagentDataSyncPayload {
  sourceHomeDir: string;
  items: Array<{
    /** name 转小写。 */
    key: string;
    name: string;
    /** 来源端用户 agents 根目录下的文件名；目标端新建时沿用。 */
    fileName: string;
    /** 来源端完成 markdown 迁移之后的文件字节。 */
    content: Uint8Array;
    enabled: boolean;
  }>;
  /** 选中的内置智能体模型覆盖；key 为内置智能体的状态 ID（`built-in:built-in:<name 小写>`）。 */
  builtInModelOverrides: Array<{
    key: string;
    name: BuiltInSubagentName;
    modelSelection: ModelSelection;
  }>;
}

/** 命令 export 的结果，也是 import 的输入。按原文件字节传输，不经过表单保存接口。 */
export interface CommandDataSyncPayload {
  sourceHomeDir: string;
  items: Array<{
    /** 去掉 `.md` 的相对路径，转小写，例如 `/git/commit`。 */
    key: string;
    /** 保留大小写的命令名，例如 `/Git/commit`。 */
    name: string;
    /** 相对命令根目录的路径，统一用 `/` 分隔（例如 `git/commit.md`）；目标端新建时沿用。 */
    relativePath: string;
    content: Uint8Array;
    enabled: boolean;
  }>;
}

/** 钩子 export 的结果，也是 import 的输入。每条钩子定义算一项，按原定义对象传输（含透传字段）。 */
export interface HookDataSyncPayload {
  sourceHomeDir: string;
  /** 来源端 `config.json` 的 `hooks.enabled === true`；目标端只据此打开根级开关，从不关闭。 */
  rootEnabled: boolean;
  items: Array<{
    /** 「事件 + matcher + 类型 + 命令」（process 加 args，command 加 shell）的规范化哈希。 */
    key: string;
    event: WorkspaceHookEventName;
    /** 所在分组的 matcher；没有 matcher 的分组不带此字段。 */
    matcher?: string;
    definition: WorkspaceHookDefinition;
  }>;
}

export interface UserConfigSyncPayloadMap {
  subagents: SubagentDataSyncPayload;
  commands: CommandDataSyncPayload;
  hooks: HookDataSyncPayload;
}
