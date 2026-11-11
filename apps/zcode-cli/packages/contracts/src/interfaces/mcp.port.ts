// MCP Port - Model Context Protocol adapter boundary

import type {
  McpServerFailureKind,
  OfficialMcpAuthPortFailureReason,
  WorkspaceMcpTrustReview,
} from "@zcode/shared";
import type { McpAppsToolVisibility, McpToolUiDescriptor } from "@zcode/shared/mcp-apps";
import type { JsonSchema } from "../model/index.js";
import type { TraceContext } from "../tracing/tracer.js";

export type McpServerTransportType = "stdio" | "http" | "sse";
export type McpProtocolVersion = "legacy" | "auto" | "2026-07-28";
export type McpServerIsolation = "session" | "workspace";

/** 公共 MCP 配置校验完成后由宿主附加的运行时来源。 */
export interface McpServerRuntimeSource {
  kind: "builtin" | "plugin" | "workspace" | "user";
}

export interface McpServerConfigBase {
  alwaysLoad?: boolean;
  enabled?: boolean;
  isolation?: McpServerIsolation;
  protocolVersion?: McpProtocolVersion;
  /** 仅限宿主生成，公共配置 schema 会拒绝该字段。 */
  source?: McpServerRuntimeSource;
  timeoutMs?: number;
}

export interface McpClientCredentialsOAuthConfig {
  type: "client_credentials";
  clientId: string;
  clientSecret: string;
  clientName?: string;
  scope?: string;
}

export interface McpAuthorizationCodeOAuthConfig {
  type: "authorization_code";
  clientId?: string;
  clientSecret?: string;
  clientName?: string;
  redirectPath?: string;
  scope?: string;
}

export type McpOAuthConfig = McpAuthorizationCodeOAuthConfig | McpClientCredentialsOAuthConfig;

/**
 * ZCode 官方 Server MCP 的鉴权声明。
 * 允许出现在 `type: "http"` 与 `type: "stdio"`；`sse` 仍拒。
 * `type`/`provider` 均为精确值，不接受别名或大小写变体。
 *
 * 注意：该字段本身**不构成**官方身份证明。官方身份由运行时解析的 ZCode API origin 判定
 * （host 侧还会二次校验）；第三方 Plugin 复制该字段只能让凭证流向真实 ZCode 后端。
 *
 * 两种形态的凭证投递通道不同：
 * - http：宿主在 fetch wrapper 里逐请求注入身份头，凭证从不进入插件进程；
 * - stdio：请求由插件进程自己发出，身份头随每条出站协议消息的 `_meta` 下发。
 */
export interface ZCodeOfficialMcpAuthConfig {
  type: "zcode_official";
  provider: "jwt_token";
}

/**
 * Plugin loader 生成的运行时归属信息，`.mcp.json` 不能覆盖。
 * 用于凭据解析和日志关联，不参与信任判定。
 * 目标 origin 必须通过 `isOfficialMcpOriginTrusted` 的校验；插件身份本身不构成
 * 授权过滤条件。目的地校验与服务端接口权限、套餐、配额校验分别承担不同边界。
 */
export interface McpOfficialProvenance {
  pluginId: string;
  /** Plugin 内的原始 MCP key（未加 `plugin:<name>:` 命名空间前缀）。 */
  mcpKey: string;
  source: "plugin";
}

export interface McpStdioServerConfig extends McpServerConfigBase {
  type: "stdio";
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  auth?: ZCodeOfficialMcpAuthConfig;
  /** 宿主生成，禁止来自文件配置。 */
  official?: McpOfficialProvenance;
}

export interface McpHttpServerConfig extends McpServerConfigBase {
  type: "http";
  url: string;
  headers?: Record<string, string>;
  oauth?: McpOAuthConfig;
  auth?: ZCodeOfficialMcpAuthConfig;
  /** 宿主生成，禁止来自文件配置。 */
  official?: McpOfficialProvenance;
}

export interface McpSseServerConfig extends McpServerConfigBase {
  type: "sse";
  url: string;
  headers?: Record<string, string>;
  oauth?: McpOAuthConfig;
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig | McpSseServerConfig;

export type McpServerStatusKind =
  | "connecting"
  | "connected"
  | "disabled"
  | "disconnected"
  | "failed"
  | "untrusted";

export interface McpServerStatus {
  workspaceTrust?: WorkspaceMcpTrustReview;
  status: McpServerStatusKind;
  transport: McpServerTransportType;
  toolCount: number;
  updatedAt: string;
  error?: string;
  failureKind?: McpServerFailureKind;
  serverRequestId?: string;
  protocolEra?: "legacy" | "modern";
  authorization?: {
    type: "oauth_authorization_code";
    authorizationUrl: string;
    startedAt: string;
  };
}

export interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export const ZCODE_MCP_ERROR_PRESENTATION_META_KEY = "zcode/errorPresentation";
export const ZCODE_MCP_ERROR_PRESENTATION_MESSAGE_ONLY = "message-only";
/** MCP content 中来自模型显式 tab.screenshot() 的 image block 索引。 */
export const ZCODE_MCP_BROWSER_SCREENSHOT_CONTENT_INDICES_META_KEY =
  "zcode/browserScreenshotContentIndices";
/**
 * 本次 node_repl cell 操作的目标应用身份，供工具卡显示 App 图标。
 *
 * **只能由 node-repl-host 写入**：宿主的 CUA bridge 从 broker 响应里读 producer 的
 * `zcode.cua/app-associations-v1`，投影成这里的最小形态。producer 那个键本身经
 * `nodeRepl.setResponseMeta` / `nodeRepl.emitStructuredResult` 也能到达 `_meta`，而这两个
 * API 挂在模型可见的 sandbox globals 上，因此不可信、必须在宿主侧丢弃（同
 * `ZCODE_MCP_BROWSER_SCREENSHOT_CONTENT_INDICES_META_KEY` 的处置）。
 */
export const ZCODE_MCP_NODE_REPL_CUA_APP_META_KEY = "zcode/nodeReplCuaApp";
/**
 * 本次 node_repl cell 调用过浏览器运行时（list/execute 请求到达主线程的浏览器代理 broker，不论成败），
 * 值为 `true`。会话能力标签 `browser_use` 据此派生（docs/design/v2/model/session-features-header.md）。
 *
 * **只能由 node-repl-host 写入**：只由主线程 broker 记进调用账本，`toMcpRunResult` 先删掉 cell 经
 * sandbox API 写入的同名键，再只按账本 facts 写回；Worker 的结果消息不采信（MR !3207 评审 CR-01）。
 * 已知缺口：cell 可经 `node:inspector` 影响主线程（docs/design/v2/tool/20-node-repl-call-ledger.md
 * 「可信边界」）。不复用 `zcode/browserUse`：那个键在命令失败时也会写，且属于 Browser Use meta 契约，
 * 含义不随统计口径变化。
 */
export const ZCODE_MCP_NODE_REPL_BROWSER_USE_META_KEY = "zcode/nodeReplBrowserUse";
/**
 * 本次 node_repl cell 调用过 Computer Use 运行时（任一 CUA 方法的请求到达主线程的 CUA broker，含失败和
 * broker 侧拒绝），值为 `true`。会话能力标签 `computer_use` 据此派生；写入规则同
 * `ZCODE_MCP_NODE_REPL_BROWSER_USE_META_KEY`。
 */
export const ZCODE_MCP_NODE_REPL_COMPUTER_USE_META_KEY = "zcode/nodeReplComputerUse";
/**
 * 官方 Server MCP 响应头里的 `x-request-id`，附在失败的 tool result 上（值为 string）。
 *
 * 用短前缀 `zcode/` 而不是 `com.zcode/`：这不是跨语言协议——服务端在 header 里给，客户端
 * 读到后自己搬进 `_meta`，产出与消费都在客户端（`com.zcode/` 留给 Go 侧直接产出的键，
 * 如 `com.zcode/mcp-unavailable`）。
 *
 * 只在 `isError` 时附加：这是给人看的排障线索（拿它去查服务端日志），成功路径上是纯噪声。
 */
export const ZCODE_MCP_SERVER_REQUEST_ID_META_KEY = "zcode/officialMcpServerRequestId";

export interface McpToolDescriptor {
  alwaysLoad?: boolean;
  searchHint?: string;
  serverName: string;
  toolName: string;
  name?: string;
  description?: string;
  timeoutMs?: number;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  annotations?: McpToolAnnotations;
  /**
   * 该 tool 的结果**可信到足以据此改变界面**：来自 `type: "http"` 且声明
   * `auth.type = zcode_official` 的 MCP server。
   *
   * 唯一用途是信任结果里的结构化标识（额度耗尽 / 无套餐的 `error_code`）。判据是"结果由谁产出"
   * 而不是"插件是谁"：
   * - http：响应来自 ZCode 后端。连接存活即意味着每个请求都过了 origin 校验且 fail closed，
   *   第三方插件即使声明官方鉴权，也只能把请求打到真实 ZCode，响应体不由它写；
   * - stdio：结果由插件进程自己产出、可任意伪造，因此**不置位**。
   *
   * 刻意**不**按"插件是否来自官方 marketplace"判定：那会让非官方安装源（含本地自测与
   * zcode-plugins-test）的官方插件失效，而它也不是真实屏障——详见 `@zcode/shared` 的
   * `isOfficialMcpOriginTrusted`。
   */
  official?: boolean;
  /**
   * 工具对谁开放（`_meta.ui.visibility`，缺省 `["model", "app"]`），与是否带 UI 资源无关。
   * 不含 "model" 的工具不进 provider contracts；不含 "app" 的工具拒绝 `mcp/uiCallTool`。
   * 由 adapter 归一化写入；缺省（旧 descriptor）时以 `ui.visibility` 兜底，再缺省视为两者都可见。
   */
  visibility?: McpAppsToolVisibility[];
  /**
   * 工具 `_meta` 归一化后的插件 UI 呈现描述。
   * 只有声明了合法 `ui://` resourceUri 的工具才有；其中的 visibility 与上面的字段同源。
   */
  ui?: McpToolUiDescriptor;
}

/** 可见性判定的唯一实现：descriptor.visibility → ui.visibility → 两者都可见。 */
export function resolveMcpToolVisibility(
  descriptor: Pick<McpToolDescriptor, "visibility" | "ui">,
): McpAppsToolVisibility[] {
  return descriptor.visibility ?? descriptor.ui?.visibility ?? ["model", "app"];
}

export type McpContentBlock = Record<string, unknown>;

export interface McpToolCallResult {
  content: McpContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

export interface McpReadResourceRequest {
  serverName: string;
  uri: string;
  trace?: TraceContext;
}

export interface McpResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
  _meta?: Record<string, unknown>;
}

export interface McpReadResourceResult {
  contents: McpResourceContent[];
}

/** `resources/list` / `resources/templates/list`（分页游标原样透传）。 */
export interface McpListResourcesRequest {
  serverName: string;
  cursor?: string;
  trace?: TraceContext;
}
export interface McpResourceDescriptor {
  uri: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
  _meta?: Record<string, unknown>;
}
export interface McpListResourcesResult {
  resources: McpResourceDescriptor[];
  nextCursor?: string;
}
export interface McpResourceTemplateDescriptor {
  uriTemplate: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
  _meta?: Record<string, unknown>;
}
export interface McpListResourceTemplatesResult {
  resourceTemplates: McpResourceTemplateDescriptor[];
  nextCursor?: string;
}
/**
 * 资源订阅。`subscriberKey` 由调用方给出（bootstrap 用 sessionId|scopeId|generation），
 * 登记表在连接层按 (serverName, uri) 计数：0→1 才真调 SDK subscribe，1→0 才 unsubscribe；断连重连后按登记表重放。
 */
export interface McpResourceSubscriptionRequest {
  serverName: string;
  uri: string;
  subscriberKey: string;
  trace?: TraceContext;
}
/** server 没有声明 `capabilities.resources.subscribe` 时抛出（协议层映射为 -32001 not_supported）。 */
export class McpResourceSubscribeUnsupportedError extends Error {
  readonly code = "not_supported" as const;
  constructor(readonly serverName: string) {
    super(`MCP server ${serverName} does not support resource subscriptions`);
    this.name = "McpResourceSubscribeUnsupportedError";
  }
}

/** server → client 通知，adapter 转成宿主可消费的形状；订阅类通知带当前登记的 subscriberKey。 */
export type McpServerNotification =
  | { kind: "resourceUpdated"; serverName: string; uri: string; subscribers: string[] }
  | { kind: "resourceListChanged"; serverName: string; subscribers: string[] }
  | { kind: "toolListChanged"; serverName: string }
  | { kind: "loggingMessage"; serverName: string; level: string; logger?: string; data: unknown };
export interface McpNotificationPort {
  onNotification(notification: McpServerNotification): void;
}

export interface McpConnectionSnapshot {
  statuses: Record<string, McpServerStatus>;
  tools: McpToolDescriptor[];
}

export interface McpConnectOptions {
  /**
   * authorization_code OAuth callback 的等待上限。
   * 普通 MCP timeoutMs 只约束协议请求，session 启动需要单独限制 OAuth 授权等待。
   */
  oauthAuthorizationTimeoutMs?: number;
  /**
   * 复用既有连接前先校验其存活性（见 McpPort.pingServer），已死则重连。
   * 设置页刷新这类"用户明确要求重新探测"的调用必须置位；session 启动不需要，
   * 复用池中刚建立的连接即可。
   */
  revalidate?: boolean;
  signal?: AbortSignal;
  trace?: TraceContext;
  workingDirectory?: string;
  /** 身份隔离使用 workspaceIdentity；本地缺省时才 fallback 到 workingDirectory。 */
  workspaceIdentity?: string;
  /**
   * 会话所属 workspace 的 key，只用于发往 Host 的请求（官方 MCP 授权头）。受管 worktree 会话 =
   * 项目；连接池分组仍按 workspaceIdentity || workingDirectory（stdio 进程的工作目录就是 cwd）。
   */
  workspaceKey?: string;
}

export interface McpCallToolRequest {
  serverName: string;
  toolName: string;
  arguments?: Record<string, unknown>;
  trace?: TraceContext;
  /** 调用来源；宿主 MCP 可据此限制不能安全继承到 subagent 的能力。 */
  runtimeScope?: "main" | "subagent";
  /** 请求上下文仅用于 shared-host 隔离，不改变 MCP tool 参数。 */
  workspacePath?: string;
  workspaceIdentity?: string;
  workspaceKey?: string;
  remoteSessionId?: string;
  clientMode?: string;
  deliveryKind?: string;
  turnId?: string;
}

/** MCP `notifications/progress`（A8）：progress 单调递增，total 可缺省；adapter 原样转发，不做节流。 */
export interface McpToolCallProgress {
  progress: number;
  total?: number;
  message?: string;
}

export interface McpCallToolOptions {
  /** 页面写操作固定此连接；禁止恢复或重新授权后自动重放。 */
  appConnection?: { identity: string; generation: number };
  signal?: AbortSignal;
  timeoutMs?: number;
  /** 收到服务端进度通知时回调；SDK 侧同时以 resetTimeoutOnProgress 让每次进度重置超时。 */
  onProgress?: (progress: McpToolCallProgress) => void;
}

/** 工具级 `_meta.timeoutMs` 的允许区间：低于下限视为非法丢弃，高于上限截到上限。 */
export const MCP_TOOL_META_TIMEOUT_MIN_MS = 1_000;
export const MCP_TOOL_META_TIMEOUT_MAX_MS = 30 * 60 * 1_000;

/**
 * 端口层失败分类（"不发任何请求"的几类）。
 * `official_mcp_origin_untrusted` 可能来自 adapter 本地校验，也可能来自 host 侧二次校验。
 */
export type OfficialMcpAuthFailureReason = OfficialMcpAuthPortFailureReason;

export type OfficialMcpAuthHeadersResult =
  | { ok: true; headers: Record<string, string> }
  | { ok: false; reason: OfficialMcpAuthFailureReason };

/**
 * MCP adapter 消费身份头的依赖注入端口。
 * adapter 不直接依赖 `packages/services`；Agent 进程经该端口向 host 索取本次请求的身份头。
 *
 * 失败必须走返回值而非抛异常，调用方禁止从错误文本解析原因。
 * `workspaceIdentity` / `workspacePath` / `pluginId` / `mcpKey` / `targetOrigin`
 * 仅用于路由、二次校验与审计，**不参与凭证选择**——凭证是 host 全局状态。
 */
export interface OfficialMcpAuthHeadersPort {
  resolveHeaders(input: {
    pluginId: string;
    mcpKey: string;
    targetOrigin: string;
    workspaceIdentity?: string;
    workspacePath?: string;
    /** 会话所属 workspace 的 key；Host 按它路由，缺省按 identity || workspacePath。 */
    workspaceKey?: string;
    signal?: AbortSignal;
  }): Promise<OfficialMcpAuthHeadersResult>;
}

/**
 * 官方 MCP 信任判定。
 *
 * 规则只有一条：**目标 origin 逐字符等于当前 ZCode API origin（https、无 username/password）**，
 * 另有仅放开 http loopback 的本地自测开关。`pluginId` / `mcpKey` 传进来只用于日志与凭证解析
 * 归属，**不影响判定结果**——曾经的"必须是官方 marketplace 插件"那道检查已于 2026-08 移除
 * （它让官方插件在发布前无法对真实端点自测，而第三方插件本可用 hook 读到同一份凭证，
 * 并非真实屏障）。
 *
 * 实现在 `@zcode/shared`：host 与 adapter 共用同一份，避免一侧放行一侧拒绝。
 * 异步是为了让 host 侧能按 settings 覆盖解析 origin。
 */
export interface OfficialMcpTrustedOriginRegistry {
  isTrusted(input: { pluginId: string; mcpKey: string; origin: string }): Promise<{
    detail?: string;
    trusted: boolean;
  }>;
}

/** MCP elicitation（server → client `elicitation/create`）交给宿主提问的端口。 */
export interface McpElicitationTrace {
  sessionId?: string;
  turnId?: string;
  toolCallId?: string;
  traceId?: string;
}
export interface McpElicitationRequest {
  serverName: string;
  message: string;
  requestedSchema: unknown;
  /** 发起 elicitation 时该 server 正在执行的工具调用；没有则无法归属会话，端口应拒绝。 */
  trace?: McpElicitationTrace;
}
export interface McpElicitationResult {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
}
export interface McpElicitationPort {
  requestElicitation(
    request: McpElicitationRequest,
    options?: { signal?: AbortSignal },
  ): Promise<McpElicitationResult>;
}

export interface McpPort {
  /** 只读重算工作区准入并通知会话投影，不连接、授权或重放工具。 */
  refreshWorkspaceTrustAdmission?(reannounce?: boolean): Promise<void>;
  /** 可信配置派生的稳定来源与现有连接代际。断线时不签发新页面凭证。 */
  onAppConnectionInvalidated?(serverName: string, listener: () => void): () => void;
  appConnectionSnapshot?(serverName: string): { identity: string; generation: number } | null;
  /** 等待目标 server 已有连接任务；不重连、不等待其它 server，owner 失效后返回 null。 */
  waitForAppConnection?(
    serverName: string,
  ): Promise<{ identity: string; generation: number } | null>;

  connectConfiguredServers(
    servers: Record<string, McpServerConfig>,
    options?: McpConnectOptions,
  ): Promise<McpConnectionSnapshot>;
  connectServer(
    name: string,
    config: McpServerConfig,
    options?: McpConnectOptions,
  ): Promise<McpServerStatus>;
  disconnectServer(name: string): Promise<McpServerStatus | undefined>;
  /**
   * 主动探测连接是否仍然存活，返回 false 表示 transport 已断。
   * HTTP/SSE MCP 被停掉时不会派发 onclose，status() 会长期停在 connected；
   * 只有显式 ping 才能把这种"无声死亡"暴露出来。实现可选：未实现时调用方按存活处理。
   */
  pingServer?(name: string, options?: { timeoutMs?: number }): Promise<boolean>;
  status(): Promise<Record<string, McpServerStatus>>;
  listTools(): Promise<McpToolDescriptor[]>;
  /**
   * 自端口创建以来收到 `notifications/tools/list_changed` 的累计次数。
   * runtime 在回合开始前比较该值，变了才重新 listTools 并重注册；未实现表示端口不会主动变化。
   */
  toolListRevision?(): number;
  callTool(request: McpCallToolRequest, options?: McpCallToolOptions): Promise<McpToolCallResult>;
  /**
   * 读取 MCP 资源（插件 UI 的 `ui://` HTML）。与 pingServer 同样可选：mock port 不必实现，
   * 调用方缺失时按"不支持资源"处理。实现必须与 callTool 共用同一连接与重连路径。
   */
  readResource?(
    request: McpReadResourceRequest,
    options?: McpCallToolOptions,
  ): Promise<McpReadResourceResult>;
  /** 资源列表与订阅；缺省表示该端口不支持（协议层回 -32001）。 */
  listResources?(
    request: McpListResourcesRequest,
    options?: McpCallToolOptions,
  ): Promise<McpListResourcesResult>;
  listResourceTemplates?(
    request: McpListResourcesRequest,
    options?: McpCallToolOptions,
  ): Promise<McpListResourceTemplatesResult>;
  subscribeResource?(
    request: McpResourceSubscriptionRequest,
    options?: McpCallToolOptions,
  ): Promise<void>;
  unsubscribeResource?(
    request: McpResourceSubscriptionRequest,
    options?: McpCallToolOptions,
  ): Promise<void>;
  /** 删除 subscriberKey 以 prefix 开头的全部登记（会话关闭）；返回真正向 server 退订的 uri 数。 */
  unsubscribeResourcesBySubscriber?(subscriberKeyPrefix: string): Promise<number>;
  /**
   * 关闭本端口的准入和所属资源。pool lease 只取消本会话等待/调用并归还引用；
   * 独占连接等待 adapter 释放，共享连接仍由 pool 与其余 lease 持有。
   * child 借用端口不得关闭父会话持有的 lease。
   */
  close(): Promise<void>;
}
