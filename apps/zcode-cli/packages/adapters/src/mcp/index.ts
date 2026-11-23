import {
  Client,
  ClientCredentialsProvider,
  computeScopeUnion,
  ProtocolError,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  SseError,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  UnsupportedProtocolVersionError,
  type AuthProvider,
  type OAuthClientProvider,
  type VersionNegotiationMode,
  type VersionNegotiationOptions,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type {
  Logger,
  McpCallToolOptions,
  McpCallToolRequest,
  McpConnectionSnapshot,
  McpConnectOptions,
  McpContentBlock,
  McpElicitationPort,
  McpElicitationTrace,
  McpListResourcesRequest,
  McpListResourcesResult,
  McpListResourceTemplatesResult,
  McpNotificationPort,
  McpOAuthConfig,
  McpPort,
  McpReadResourceRequest,
  McpReadResourceResult,
  McpResourceSubscriptionRequest,
  McpServerConfig,
  McpServerStatus,
  McpServerToolSnapshot,
  McpToolCallResult,
  McpToolDescriptor,
  McpWaitForServerOptions,
  OfficialMcpAuthFailureReason,
  OfficialMcpAuthHeadersPort,
  OfficialMcpTrustedOriginRegistry,
} from "@zcode/contracts";
import {
  mcpConfigKey,
  McpResourceSubscribeUnsupportedError,
  ZCODE_MCP_SERVER_REQUEST_ID_META_KEY,
} from "@zcode/contracts";
import {
  OFFICIAL_MCP_AUTH_META_KEY,
  ZCODE_OFFICIAL_MCP_AUTH_TYPE,
  type McpServerFailureKind,
  type OfficialMcpAuthFailureKind,
} from "@zcode/shared";
import { buildMcpAppsClientCapabilities } from "@zcode/shared/mcp-apps";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
  createSharedZCodeCredentialStore,
  type SharedZCodeCredentialStore,
} from "../auth/shared-credentials.js";
import { normalizeMcpToolDescriptor } from "./descriptor.js";
import {
  buildMcpStdioEnv,
  createMcpTransportFetch,
  type NetworkEgressEnvPolicy,
} from "./network.js";
import {
  applyMcpNodeFallbackEnv,
  type McpNodeFallback,
  type McpNodeFallbackProvider,
} from "./node-fallback.js";
import { loadCredentialPair } from "./oauth-credentials.js";
import {
  classifyInteractiveAuthorizationTrigger,
  type InteractiveAuthorizationTrigger,
} from "./oauth-errors.js";
import {
  MCP_OAUTH_AUTHORIZATION_TRANSACTION_TTL_MS,
  runMcpInteractiveAuthorization,
  type McpInteractiveAuthorizationOutcome,
} from "./oauth-interactive.js";
import { createMcpOAuthTokenProvider } from "./oauth-provider.js";
import {
  createCredentialKeyPrefix,
  type McpOAuthAuthorizationContext,
  type McpOAuthRuntimeOptions,
} from "./oauth.js";
import {
  createOfficialMcpAuthFetch,
  OfficialMcpAuthError,
  type OfficialMcpServerResponseInfo,
} from "./official-auth.js";
import {
  createMcpConnectionPool,
  type McpConnectionContext,
  type McpConnectionPool,
} from "./pool.js";
import { terminateMcpStdioProcessTree } from "./process-tree.js";
import { McpResourceSubscriptionRegistry } from "./resource-subscriptions.js";
import { ProcessTreeStdioClientTransport } from "./stdio-transport.js";
import type { McpTelemetryTracker } from "./telemetry.js";
import {
  classifyTransportError,
  countNetworkFailures,
  isRetryableCallError,
} from "./transport-errors.js";
import {
  createMcpDeadline,
  McpTimeoutError,
  remainingMcpDeadlineMs,
  waitWithinMcpDeadline,
  withTimeout,
  type McpDeadline,
} from "./timeout.js";

const MCP_RECOVERY_ATTEMPTS = 5;
const MCP_RECOVERY_INITIAL_DELAY_MS = 1_000;
/** 内建 stdio server 在滚动窗口内最多自动重启的次数，防止"启动后很快又退出"形成循环。 */
const MCP_BUILTIN_RESTART_LIMIT = 5;
const MCP_BUILTIN_RESTART_WINDOW_MS = 10 * 60_000;
const DEFAULT_MCP_TIMEOUT_MS = 30_000;
/** 工具调用重试前等待重连的上限；实际等待还受调用剩余预算限制。 */
const MCP_RECONNECT_WAIT_MS = 30_000;
const MCP_TOOLS_REFRESH_ATTEMPTS = 3;
const MCP_TOOLS_REFRESH_INITIAL_DELAY_MS = 1_000;
// 存活探测只允许占用很短的时间：它挂在设置页刷新的同步路径上，超时即判死并触发重连。
const MCP_PING_TIMEOUT_MS = 5_000;
const MAX_MCP_VERSION_PROBE_TIMEOUT_MS = 5_000;
const MCP_STDIO_STDERR_LOG_MAX_CHARS = 4_000;
const MCP_STDIO_ERROR_MESSAGE_MAX_CHARS = 512;
/**
 * span → request id 的暂存条数上限。正常情况下每条都会在同一次 tool call 结束时被取走，
 * 留下的只有无人认领的（如连接期请求），几十条足够，纯为防止长会话下无界增长。
 */
const MAX_TRACKED_SERVER_REQUEST_IDS = 64;

export interface CreateMcpAdapterOptions {
  clientName?: string;
  clientVersion?: string;
  connectionContext?: McpConnectionContext;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  telemetry?: McpTelemetryTracker;
  mcpOAuth?: McpOAuthRuntimeOptions;
  network?: NetworkEgressEnvPolicy;
  /**
   * 桌面 Electron Node 回退：宿主注入时，stdio MCP 的 node/npm/npx 在用户 PATH 缺失时
   * 回退到 Electron 与随包 npm（docs/design/v2/mcp-node-fallback.md）。缺省时 env 不变。
   */
  nodeFallback?: McpNodeFallbackProvider;
  /**
   * 官方 Server MCP 鉴权依赖。trustedOrigins 缺失时仍 fail closed；authHeadersPort
   * 可缺省，此时各请求匿名降级并交给服务端做权威判定。
   */
  officialMcpAuth?: {
    authHeadersPort?: OfficialMcpAuthHeadersPort;
    trustedOrigins: OfficialMcpTrustedOriginRegistry;
    /**
     * 当前 ZCode API origin。stdio 形态没有 `url` 可供校验，targetOrigin 只能由宿主给出
     * ——插件因此无法把身份头导向别的 origin。
     * 与 trustedOrigins 的 `resolveZCodeApiOrigin` 必须同源，否则两侧判定会分叉。
     */
    resolveZCodeApiOrigin?: () => string;
    workspaceIdentity?: string;
  };
  workingDirectory?: string;
  /**
   * 会话所属 workspace 的 key，官方 MCP 授权头请求以它为身份发往 Host。受管 worktree 会话 =
   * 项目，不等于 workingDirectory（docs/git/worktree.md §9.3）。
   */
  workspaceKey?: string;
  /** 有此端口才向 server 宣告 elicitation 能力；缺省时 server 的 elicitation/create 收到 method not found。 */
  elicitation?: McpElicitationPort;
  /** server → client 通知（资源更新 / 列表变化 / 工具列表变化 / 日志）的出口；缺省只记 debug。 */
  notifications?: McpNotificationPort;
}

type McpClient = Client;
type McpTransport = StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport;
type AuthorizationCodeOAuthConfig = Extract<McpOAuthConfig, { type: "authorization_code" }>;

/**
 * stdio 官方 MCP 的身份头载荷，随每条出站协议消息的 `_meta` 下发。
 *
 * 失败也下发（`ok: false` + 枚举 reason）；stdio 插件拿不到头时不会去打官方端点。HTTP 路径则
 * 由 adapter 发起无身份的 tools/call，让 ZCode server 返回权威结构化错误。把 reason 交给 stdio
 * 插件才能让它把"未登录"与"无 Coding Plan
 * 套餐"如实呈现给用户，而不是静默降级成一句莫名其妙的失败。
 */
type OfficialMcpAuthMetaPayload =
  | { ok: true; headers: Record<string, string> }
  | { ok: false; reason: OfficialMcpAuthFailureReason };

/** 订阅的 server → client 通知方法名（MCP 规范）。 */
export const MCP_NOTIFICATION_TOOLS_LIST_CHANGED = "notifications/tools/list_changed";
export const MCP_NOTIFICATION_RESOURCES_UPDATED = "notifications/resources/updated";
export const MCP_NOTIFICATION_RESOURCES_LIST_CHANGED = "notifications/resources/list_changed";
export const MCP_NOTIFICATION_MESSAGE = "notifications/message";

interface McpServerRecord {
  client?: McpClient;
  abortController?: AbortController;
  connecting?: Promise<McpServerStatus>;
  config: McpServerConfig;
  status: McpServerStatus;
  tools: McpToolDescriptor[];
  /** 收到 tools/list_changed 后置位，后台刷新成功前保持；失败由本任务有限重试，耗尽后由后续通知再次触发。 */
  toolsStale?: boolean;
  /** 后台 tools/list 刷新的 single-flight；同一 record 同时只有一次。 */
  toolsRefresh?: Promise<void>;
  /** 只在拿到成功的 tools/list 后设置；未设置表示"从未拿到列表"，不能当成空列表。 */
  toolsVersion?: number;
  transport?: McpTransport;
  /** 当前 client 已确认的远端订阅及同 URI 串行任务；订阅意图只在登记表。 */
  resourceSubscriptions?: Map<string, { subscribed: boolean | undefined; task?: Promise<boolean> }>;
}

/**
 * 新连接的来由。默认是首次连接或显式重连，允许交互授权；
 * recovering：远程意外断连或内建 stdio 进程意外退出，保留目录，后台有限重试，不弹交互授权；
 * oauthTrigger：工具调用遇到授权错误，先交互授权（step-up 合并 scope），保留目录。
 */
interface StartConnectionMode {
  recovering?: boolean;
  oauthTrigger?: InteractiveAuthorizationTrigger;
  /**
   * 保留了目录的记录（授权未完成就结束、来源 builtin 的 server 超过重启上限）的执行准入重连：
   * 保留目录，工具不离开模型视图。
   */
  retainTools?: boolean;
}

/** resources/list 项：只透传标准字段（含 _meta），丢掉 SDK 附加的运行时字段。 */
function pickResourceDescriptor(
  resource: unknown,
  includeUri = true,
): {
  uri?: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
  _meta?: Record<string, unknown>;
} {
  const item = isRecord(resource) ? resource : {};
  return {
    ...(includeUri ? { uri: typeof item.uri === "string" ? item.uri : "" } : {}),
    ...(typeof item.name === "string" ? { name: item.name } : {}),
    ...(typeof item.title === "string" ? { title: item.title } : {}),
    ...(typeof item.description === "string" ? { description: item.description } : {}),
    ...(typeof item.mimeType === "string" ? { mimeType: item.mimeType } : {}),
    ...(isRecord(item._meta) ? { _meta: item._meta } : {}),
  };
}

export function createMcpAdapter(options: CreateMcpAdapterOptions = {}): McpPort {
  return new NodeMcpAdapter(options);
}

export function createMcpAdapterConnectionPool(
  options: CreateMcpAdapterOptions = {},
): McpConnectionPool {
  return createMcpConnectionPool({
    logger: options.logger,
    telemetry: options.telemetry,
    createAdapter: ({ connectionContext, workingDirectory, workspaceKey }) =>
      createMcpAdapter({
        ...options,
        connectionContext,
        workingDirectory: workingDirectory ?? options.workingDirectory,
        ...(workspaceKey ? { workspaceKey } : {}),
      }),
  });
}

export {
  createMcpConnectionPool,
  type McpConnectionPool,
  type McpConnectionPoolOptions,
} from "./pool.js";
export {
  createMcpNodeFallbackProvider,
  type CreateMcpNodeFallbackProviderOptions,
  type McpNodeFallback,
  type McpNodeFallbackProvider,
} from "./node-fallback.js";
export {
  createMcpTelemetryTracker,
  resolvePluginName,
  type McpTelemetryTracker,
  type McpTrackedProcess,
} from "./telemetry.js";
export {
  createInMemoryMcpToolCatalog,
  type InMemoryMcpToolCatalogOptions,
} from "./tool-catalog-cache.js";

/** elicitation 模式白名单（MCP form 与 兼容别名）。 */
const SUPPORTED_ELICITATION_MODES = new Set(["form", "openai/form", "openaiForm"]);
function isSupportedElicitationMode(mode: unknown): boolean {
  return mode === undefined || (typeof mode === "string" && SUPPORTED_ELICITATION_MODES.has(mode));
}

class NodeMcpAdapter implements McpPort {
  private readonly adapterInstanceId = randomUUID();
  private readonly clientName: string;
  private readonly clientVersion: string;
  private readonly connectionContext?: McpConnectionContext;
  private readonly env?: NodeJS.ProcessEnv;
  private readonly logger?: Logger;
  private readonly mcpOAuth?: McpOAuthRuntimeOptions;
  private readonly network?: NetworkEgressEnvPolicy;
  private readonly nodeFallback?: McpNodeFallbackProvider;
  private readonly officialMcpAuth?: CreateMcpAdapterOptions["officialMcpAuth"];
  private readonly telemetry?: McpTelemetryTracker;
  private readonly connectionGenerations = new Map<string, number>();
  private credentialStore?: SharedZCodeCredentialStore;
  /**
   * 官方鉴权失败分类的暂存槽。不能从 error 对象读——SDK 的 version
   * negotiation 会把 OfficialMcpAuthError 重新包装成普通 Error，instanceof 失效；
   * 也不允许按错误文本反解。因此在抛出点写入，failConnection 取用后立即清除。
   */
  private readonly lastOfficialAuthKind = new Map<string, OfficialMcpAuthFailureKind>();
  /**
   * span → 服务端 request id。只有官方 MCP 会写入（唯一能看到响应头的地方是 auth fetch
   * wrapper），供 in-band 失败（HTTP 200 + `isError`）把 id 带回 tool result。
   *
   * 用 span 而不是 traceId 作键：traceId 覆盖整个顶层 session，同一 session 的多次调用
   * 共用它，关联会串号；span 是一次 tool call 的粒度。
   *
   * 有界并即取即删：拿不到匹配的 span（如 initialize / tools/list，它们没有 `_meta`）
   * 就让条目自然被挤出，绝不"取最近一次"兜底——那会把上一次调用的 id 贴到这一次的失败上。
   */
  private readonly serverRequestIdBySpan = new Map<string, string>();
  private readonly connectionDiagnosticByServer = new Map<
    string,
    Pick<McpServerStatus, "failureKind" | "serverRequestId">
  >();
  private readonly records = new Map<string, McpServerRecord>();
  /** 内建 stdio server 最近的自动重启时刻；非恢复的连接清零。 */
  private readonly builtinRestarts = new Map<string, number[]>();
  /** waitForServer 的授权边界 waiter：启动转为 OAuth pending 时由 onAuthorizationRequired 唤醒。 */
  private readonly authorizationWaiters = new Map<string, Set<() => void>>();
  private readonly workingDirectory?: string;
  private readonly workspaceKey?: string;
  private readonly elicitation?: McpElicitationPort;
  private readonly notifications?: McpNotificationPort;
  /** 资源订阅登记表 serverName → uri → subscriberKey；唯一 owner，连接层计数。 */
  private readonly resourceSubscriptions = new McpResourceSubscriptionRegistry();
  /** tools/list_changed 累计次数，runtime 按此判断是否需要重注册。 */
  /** 每次成功替换某个 server 的工具列表就递增，作为 McpServerToolSnapshot.toolsVersion。 */
  private toolsVersionCounter = 0;
  private readonly snapshotListeners = new Set<() => void>();
  private snapshotNotificationPending = false;
  /** close() 之后迟到的调用错误不能再发起重连。 */
  private closed = false;

  onSnapshotChanged(listener: () => void): () => void {
    this.snapshotListeners.add(listener);
    return () => {
      this.snapshotListeners.delete(listener);
    };
  }

  private notifySnapshot(): void {
    if (this.snapshotNotificationPending) return;
    this.snapshotNotificationPending = true;
    queueMicrotask(() => {
      this.snapshotNotificationPending = false;
      for (const listener of this.snapshotListeners) {
        // 修复前一个 listener 抛错会在 microtask 里成为未捕获异常（CLI 按致命错误退出），
        // 后面的 listener 也收不到通知。分发边界隔离每个订阅者，错误记 error 日志。
        try {
          listener();
        } catch (error) {
          this.logger?.error(
            "MCP snapshot listener failed",
            error instanceof Error ? error : new Error(String(error)),
            { event: "mcp.snapshot.listener_failed" },
          );
        }
      }
    });
  }

  /** 每个 server 当前正在执行的工具调用 trace；elicitation 借此归属到会话 / 工具行。 */
  private readonly activeCallTraces = new Map<string, McpElicitationTrace>();

  constructor(options: CreateMcpAdapterOptions) {
    this.clientName = options.clientName ?? "zcode";
    this.clientVersion = options.clientVersion ?? "0.0.0";
    this.connectionContext = options.connectionContext;
    this.env = options.env;
    this.logger = options.logger?.child({
      ...this.connectionContext,
      module: "adapters.mcp",
    });
    this.mcpOAuth = options.mcpOAuth;
    this.network = options.network;
    this.nodeFallback = options.nodeFallback;
    this.officialMcpAuth = options.officialMcpAuth;
    this.telemetry = options.telemetry;
    this.workingDirectory = options.workingDirectory;
    this.workspaceKey = options.workspaceKey;
    this.elicitation = options.elicitation;
    this.notifications = options.notifications;
  }

  async connectConfiguredServers(
    servers: Record<string, McpServerConfig>,
    options: McpConnectOptions = {},
  ): Promise<McpConnectionSnapshot> {
    const startedAt = Date.now();
    const serverNames = Object.keys(servers);
    this.logger?.info("MCP configured servers connection started", {
      event: "mcp.configured_servers.connect.started",
      serverCount: serverNames.length,
      serverNames,
      status: "started",
    });
    const configuredNames = new Set(Object.keys(servers));
    // 先同步撤下旧记录并登记全部新记录，不能让新配置读取或缓存旧目录。
    const disconnecting = Array.from(this.records.keys())
      .filter((name) => !configuredNames.has(name))
      .map((name) => this.disconnectServer(name));
    const connecting = Object.entries(servers).map(([name, config]) =>
      this.connectServer(name, config, options),
    );
    await Promise.all([...disconnecting, ...connecting]);

    const statuses = await this.status();
    const tools = await this.listTools();
    const statusCounts = Object.values(statuses).reduce<Record<string, number>>(
      (counts, status) => {
        counts[status.status] = (counts[status.status] ?? 0) + 1;
        return counts;
      },
      {},
    );
    this.logger?.info("MCP configured servers connection completed", {
      durationMs: Date.now() - startedAt,
      event: "mcp.configured_servers.connect.completed",
      serverCount: serverNames.length,
      status: "completed",
      statusCounts,
      toolCount: tools.length,
    });
    return {
      statuses,
      tools,
    };
  }

  async connectServer(
    name: string,
    config: McpServerConfig,
    options: McpConnectOptions = {},
  ): Promise<McpServerStatus> {
    const existing = this.records.get(name);
    // 相同配置只复用当前记录；显式断开后的记录不再代表这份配置，需要重新连接。
    if (
      existing &&
      existing.status.status !== "disconnected" &&
      mcpConfigKey(existing.config) === mcpConfigKey(config)
    ) {
      return options.revalidate
        ? this.revalidateConnection(name, existing, options)
        : this.waitForSharedConnection(name, existing, options);
    }
    return this.startConnection(name, config, options);
  }

  private async startConnection(
    name: string,
    config: McpServerConfig,
    options: McpConnectOptions,
    mode: StartConnectionMode = {},
  ): Promise<McpServerStatus> {
    const { recovering = false, oauthTrigger, retainTools = false } = mode;
    // 修复原因：close() 等待旧连接关闭期间，修复前仍可登记新记录；close 随后清空记录，
    // 新连接完成时读不到记录而抛 TypeError。关闭后不再启动连接，也不登记记录。
    if (this.closed) return this.createStatus(config, "disconnected");
    // 恢复、调用期授权与授权失败后的重连都保留已公告的目录，避免 pending 期间工具被误判为消失。
    const keepTools = recovering || oauthTrigger !== undefined || retainTools;
    // 配置变化、显式重连等非恢复连接重新开始计数。
    if (!recovering) this.builtinRestarts.delete(name);
    const startedAt = Date.now();
    const timeoutMs = config.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
    const generation = this.nextConnectionGeneration(name);
    this.lastOfficialAuthKind.delete(name);
    this.connectionDiagnosticByServer.delete(name);
    this.logger?.info("MCP server connection started", {
      event: "mcp.server.connect.started",
      mcpServerName: name,
      status: "started",
      timeoutMs,
      transport: config.type,
    });
    const previous = this.records.get(name);

    if (config.enabled === false) {
      const status = this.createStatus(config, "disabled");
      this.records.set(name, { config, status, tools: [] });
      this.notifySnapshot();
      await this.closeRecord(name, previous);
      this.logger?.info("MCP server connection skipped", {
        durationMs: Date.now() - startedAt,
        event: "mcp.server.connect.skipped",
        mcpServerName: name,
        status: "completed",
        transport: config.type,
      });
      return status;
    }

    const abortController = new AbortController();
    const connectingStatus = this.createStatus(config, "connecting");
    const record: McpServerRecord = {
      abortController,
      config,
      status: keepTools
        ? this.createStatus(config, "connecting", { toolCount: previous?.tools.length })
        : connectingStatus,
      tools: keepTools ? (previous?.tools ?? []) : [],
      toolsVersion: keepTools ? previous?.toolsVersion : undefined,
    };
    // 修复原因：过去先 await 关闭旧连接再登记新记录，这段间隙里 waitForServer 只能看到旧的
    // connected/failed 记录，会立即报告"已结束"。现在同步登记新的 connecting 记录，再关闭旧记录对象。
    this.records.set(name, record);
    this.notifySnapshot();
    const connecting = (async () => {
      if (previous) await this.closeRecord(name, previous);
      let status = record.status;
      const attempts = recovering ? MCP_RECOVERY_ATTEMPTS : 1;
      for (let attempt = 0; attempt < attempts; attempt++) {
        if (attempt > 0)
          await waitForMcpRetry(
            MCP_RECOVERY_INITIAL_DELAY_MS * 2 ** (attempt - 1),
            abortController.signal,
          );
        if (abortController.signal.aborted || !this.isCurrentConnection(name, generation))
          return this.records.get(name)?.status ?? record.status;
        status = await this.openServerConnection({
          config,
          generation,
          name,
          interactive: !recovering,
          oauthAuthorizationTimeoutMs: options.oauthAuthorizationTimeoutMs,
          ...(attempt === 0 && oauthTrigger ? { oauthTrigger } : {}),
          abortController,
          timeoutMs,
          workingDirectory: options.workingDirectory ?? this.workingDirectory,
        });
        // 需要授权时结束恢复：恢复期不弹交互授权，重试也不会成功。
        if (
          status.status === "connected" ||
          status.status === "disabled" ||
          status.status === "untrusted" ||
          status.failureKind === "official_origin_untrusted" ||
          status.failureKind === "oauth_authorization_failed"
        )
          break;
      }
      return status;
    })()
      .catch((error) => {
        if (abortController.signal.aborted || !this.isCurrentConnection(name, generation))
          return this.records.get(name)?.status ?? record.status;
        return this.failConnection({ name, config, generation, startedAt, error });
      })
      .then((status) => {
        // 连接任务末尾是失败的唯一提交方；修复前 failConnection 也提交，订阅者会收到两次终态。
        if (this.isCurrentConnection(name, generation) && record.status.status !== "connected") {
          this.commitUnavailable(name, record, status);
        }
        return this.records.get(name)?.status ?? status;
      });
    record.connecting = connecting;
    // 过去 `oauthAuthorizationTimeoutMs`（session 的 15 秒）被当成 OAuth 事务寿命，
    // 15 秒后连同 callback listener 一起关掉，真人根本来不及在浏览器里完成授权（现场证据：
    // 一次成功授权耗时约 74 秒）。现在它只作为**本 caller 的等待预算**：到点返回当时的
    // snapshot（含授权 URL），后台连接与 300 秒授权事务继续存活。
    return await this.waitForSharedConnection(name, record, options);
  }

  private async revalidateConnection(
    name: string,
    record: McpServerRecord,
    options: McpConnectOptions,
  ): Promise<McpServerStatus> {
    const state = record.status.status;
    // 进行中的连接/恢复/授权只报告当前状态，重复刷新不能替换已有任务。
    if (state === "connecting" || state === "disabled" || state === "untrusted") {
      return record.status;
    }
    if (state === "connected") {
      // 探测无副作用；caller 取消只结束自己的等待，探测结果仍由失效入口处理。
      const alive = await withTimeout(
        this.pingServer(name),
        undefined,
        "MCP server revalidation cancelled",
        options.signal,
      ).catch(() => undefined);
      if (alive !== false) return this.records.get(name)?.status ?? record.status;
    }
    const current = this.records.get(name);
    // 远程探测失败已由失效入口换成恢复记录：报告当前状态，不替换恢复，也不等它结束。
    if (current !== record) return current?.status ?? record.status;
    return this.startConnection(name, record.config, { ...options, revalidate: false });
  }

  async disconnectServer(name: string): Promise<McpServerStatus | undefined> {
    const record = this.records.get(name);
    if (!record) return undefined;

    this.nextConnectionGeneration(name);
    const status = this.createStatus(record.config, "disconnected");
    this.records.set(name, {
      config: record.config,
      status,
      tools: [],
    });
    this.notifySnapshot();
    // 关闭只操作旧记录对象；迟到完成不能覆盖随后建立的新连接。
    await this.closeRecord(name, record);
    return status;
  }

  async status(): Promise<Record<string, McpServerStatus>> {
    return Object.fromEntries(
      Object.entries(this.getToolSnapshot()).map(([name, record]) => [name, record.status]),
    );
  }

  // HTTP/SSE MCP 服务被停掉时不会派发 onclose（没有常驻流可断），record 会长期停在
  // connected；设置页刷新读到的就是这份"无声死亡"的旧快照，看起来像刷新按钮没生效。
  // ping 是 MCP 基础协议方法，用它把 transport 存活性显式化。
  async pingServer(name: string, options: { timeoutMs?: number } = {}): Promise<boolean> {
    const record = this.records.get(name);
    if (!record?.client || record.status.status !== "connected") {
      return false;
    }
    const timeoutMs = Math.min(
      options.timeoutMs ?? MCP_PING_TIMEOUT_MS,
      record.config.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS,
    );
    const generation = this.connectionGenerations.get(name) ?? 0;
    try {
      await record.client.ping({ timeout: timeoutMs });
      return true;
    } catch (error) {
      // server 回了 JSON-RPC 错误（例如未实现 ping）说明连接本身是活的，不能据此拆连接。
      if (isPeerAnsweredError(error)) {
        return true;
      }
      // 探测失败与 transport 断连共用失效入口：远程保留 pending 目录进入恢复，stdio 进入 failed。
      // 修复前 stdio 只把状态改成 disconnected，既不关闭仍在运行的进程，也不发布终态。
      const { client, transport } = record;
      if (this.invalidateConnection(name, generation, client) && record.config.type === "stdio")
        void this.closeClientAndTransport(name, client, transport);
      this.logger?.warn("MCP server ping failed", {
        ...this.connectionContext,
        error: error instanceof Error ? error.message : String(error),
        event: "mcp.server.ping.failed",
        mcpServerName: name,
        status: "failed",
        transport: record.config.type,
      });
      return false;
    }
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    // 只读当前快照：标脏的 server 由后台刷新推进，调用方不能被刷新退避拖住。
    return Object.values(this.getToolSnapshot()).flatMap((record) => record.tools ?? []);
  }

  getToolSnapshot(): Record<string, McpServerToolSnapshot> {
    const snapshot: Record<string, McpServerToolSnapshot> = {};
    for (const [name, record] of this.records) {
      // 只读内存，不发起 I/O：标脏的 server 由 list_changed 通知触发刷新，本次仍返回旧列表。
      // 保留目录的不可用记录（见 retainsCatalog）快照照常输出。
      const retainsTools =
        ["connected", "connecting"].includes(record.status.status) ||
        retainsCatalog(record.config, record.status);
      snapshot[name] = {
        status: { ...record.status },
        ...(record.toolsVersion === undefined || !retainsTools
          ? {}
          : { tools: [...record.tools], toolsVersion: String(record.toolsVersion) }),
      };
    }
    return snapshot;
  }

  async waitForServer(
    name: string,
    options: McpWaitForServerOptions,
  ): Promise<{ timedOut: boolean }> {
    options.signal?.throwIfAborted();
    // 修复原因：MCP App 打开也传 reconnect，过去会走授权失败重连并发起交互授权；授权只挂在执行准入上。
    const connecting = options.reconnect
      ? (this.connectionTask(name) ??
        (options.reauthorize ? this.reconnectAfterAuthorizationFailure(name) : undefined))
      : this.records.get(name)?.connecting;
    const record = this.records.get(name);
    if (!connecting || record?.status.authorization) return { timedOut: false };
    const authorization = this.watchAuthorizationLink(name);
    try {
      // 复用同一个启动 Promise；成功、失败或转为授权 pending 都代表"本次等待结束"，结果由调用方读快照。
      await withTimeout(
        Promise.race([
          connecting.then(
            () => undefined,
            () => undefined,
          ),
          authorization.published,
        ]),
        options.timeoutMs,
        `MCP server ${name} startup wait timed out after ${options.timeoutMs}ms`,
        options.signal,
      );
      return { timedOut: false };
    } catch (error) {
      if (error instanceof McpTimeoutError) return { timedOut: true };
      throw error;
    } finally {
      authorization.dispose();
    }
  }

  /** 授权链接发布时结束等待；只登记 waiter，不取消授权或共享连接。 */
  private watchAuthorizationLink(name: string): { published: Promise<void>; dispose(): void } {
    const published = Promise.withResolvers<void>();
    const waiters = this.authorizationWaiters.get(name) ?? new Set<() => void>();
    this.authorizationWaiters.set(name, waiters);
    waiters.add(published.resolve);
    return {
      published: published.promise,
      dispose: () => {
        waiters.delete(published.resolve);
        if (waiters.size === 0 && this.authorizationWaiters.get(name) === waiters) {
          this.authorizationWaiters.delete(name);
        }
      },
    };
  }

  /**
   * 授权未完成就结束（到期、失败）的记录保留了目录；执行准入时按普通连接重连一次，单飞靠 record.connecting。
   * 修复前这种状态没有任何重连入口，server 永久停在 needs-auth。期间已在别处完成授权就用最新凭据直接连上；
   * 仍需授权则发起交互授权，链接发布后等待方立即结束。只在执行准入（reauthorize）时触发，MCP App 打开不触发。
   */
  private reconnectAfterAuthorizationFailure(name: string): Promise<McpServerStatus> | undefined {
    const record = this.records.get(name);
    if (
      !record ||
      record.connecting ||
      record.status.failureKind !== "oauth_authorization_failed" ||
      record.toolsVersion === undefined
    )
      return undefined;
    return this.startConnection(name, record.config, {}, { retainTools: true });
  }

  private refreshTools(name: string): Promise<void> {
    const record = this.records.get(name);
    if (!record) return Promise.resolve();
    if (!record.toolsStale || record.status.status !== "connected") return Promise.resolve();
    record.toolsRefresh ??= Promise.resolve().then(() => this.runToolsRefresh(name, record));
    return record.toolsRefresh;
  }

  private async runToolsRefresh(name: string, record: McpServerRecord): Promise<void> {
    // 刷新期间再收到 list_changed 会重新置脏，循环再拉一轮，保证最后一次通知不丢。
    // dirty 循环退出与清理任务槽必须同步，避免 Promise finally 前的新通知丢失。
    try {
      let failures = 0;
      while (record.toolsStale) {
        const client = record.client;
        if (!client || this.records.get(name) !== record || record.status.status !== "connected") {
          return;
        }
        record.toolsStale = false;
        const timeoutMs = record.config.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
        try {
          const listed = await withTimeout(
            client.listTools(),
            timeoutMs,
            `MCP server ${name} tool listing timed out after ${timeoutMs}ms`,
          );
          const tools = listed.tools.map((tool) =>
            normalizeMcpToolDescriptor(
              name,
              tool,
              record.config.timeoutMs,
              record.config.type === "http" &&
                record.config.auth?.type === ZCODE_OFFICIAL_MCP_AUTH_TYPE,
              record.config.alwaysLoad,
            ),
          );
          if (!this.commitConnected(name, record, client, tools, record.status)) return;
          failures = 0;
          this.logger?.info("MCP tool list refreshed after list_changed", {
            event: "mcp.tools.refreshed",
            mcpServerName: name,
            toolCount: record.tools.length,
          });
        } catch (error) {
          // 只留 dirty 会让一次性通知永久丢失；由连接所有者有限重试，读快照仍为纯读取。
          record.toolsStale = true;
          this.logger?.warn("MCP tool list refresh failed", {
            event: "mcp.tools.refresh_failed",
            mcpServerName: name,
            error: error instanceof Error ? error.message : String(error),
          });
          if (
            ++failures >= MCP_TOOLS_REFRESH_ATTEMPTS ||
            this.records.get(name) !== record ||
            record.abortController?.signal.aborted
          )
            return;
          try {
            await waitForMcpRetry(
              MCP_TOOLS_REFRESH_INITIAL_DELAY_MS * 2 ** (failures - 1),
              record.abortController?.signal,
            );
          } catch {
            return;
          } // 连接关闭或换代后，重试任务随 owner 取消。
        }
      }
    } finally {
      record.toolsRefresh = undefined;
    }
  }

  /** `resources/list`，分页游标透传。 */
  async listResources(
    request: McpListResourcesRequest,
    options: McpCallToolOptions = {},
  ): Promise<McpListResourcesResult> {
    const { record, deadline, timeoutMessage } = await this.resolveForResourceRequest(
      request.serverName,
      "resources/list",
      options,
    );
    const result = await record.client.listResources(
      request.cursor ? { cursor: request.cursor } : {},
      { signal: options.signal, timeout: remainingMcpDeadlineMs(deadline, timeoutMessage) },
    );
    return {
      resources: (result.resources ?? []).map((resource) => {
        const { uri, ...rest } = pickResourceDescriptor(resource);
        return { uri: uri ?? "", ...rest };
      }),
      ...(typeof result.nextCursor === "string" ? { nextCursor: result.nextCursor } : {}),
    };
  }

  async listResourceTemplates(
    request: McpListResourcesRequest,
    options: McpCallToolOptions = {},
  ): Promise<McpListResourceTemplatesResult> {
    const { record, deadline, timeoutMessage } = await this.resolveForResourceRequest(
      request.serverName,
      "resources/templates/list",
      options,
    );
    const result = await record.client.listResourceTemplates(
      request.cursor ? { cursor: request.cursor } : {},
      { signal: options.signal, timeout: remainingMcpDeadlineMs(deadline, timeoutMessage) },
    );
    return {
      resourceTemplates: (result.resourceTemplates ?? []).map((template) => {
        const item = template as Record<string, unknown>;
        return {
          uriTemplate: typeof item.uriTemplate === "string" ? item.uriTemplate : "",
          ...pickResourceDescriptor(item, false),
        };
      }),
      ...(typeof result.nextCursor === "string" ? { nextCursor: result.nextCursor } : {}),
    };
  }

  /**
   * 按 (serverName, uri) 计数的订阅。同一连接被多个 session 共享时只向 server 订阅一次；
   * server 没声明 resources.subscribe 能力 → McpResourceSubscribeUnsupportedError。
   */
  async subscribeResource(
    request: McpResourceSubscriptionRequest,
    options: McpCallToolOptions = {},
  ): Promise<void> {
    options.signal?.throwIfAborted();
    const registration = this.resourceSubscriptions.begin(
      request.serverName,
      request.uri,
      request.subscriberKey,
    );
    try {
      const { record, deadline, timeoutMessage } = await this.resolveForResourceRequest(
        request.serverName,
        "resources/subscribe",
        options,
      );
      if (!record.client.getServerCapabilities()?.resources?.subscribe) {
        throw new McpResourceSubscribeUnsupportedError(request.serverName);
      }
      await waitWithinMcpDeadline(
        this.syncResourceSubscription(request.serverName, record, request.uri),
        deadline,
        timeoutMessage,
        options.signal,
      );
      options.signal?.throwIfAborted();
      registration.commit();
    } catch (error) {
      // 单次取消不能删掉同 key 已成功或仍在等待的登记；仅归零时收敛远端副作用。
      if (registration.release()) {
        void this.unsubscribeOnServer(request.serverName, request.uri, {});
      }
      throw error;
    }
    this.logger?.info("MCP resource subscribed", {
      event: "mcp.resource.subscribe",
      mcpServerName: request.serverName,
      uri: request.uri,
      status: "completed",
    });
  }

  async unsubscribeResource(
    request: McpResourceSubscriptionRequest,
    options: McpCallToolOptions = {},
  ): Promise<void> {
    const removed = this.resourceSubscriptions.remove(
      request.serverName,
      request.uri,
      request.subscriberKey,
    );
    if (!removed?.last) return;
    await this.unsubscribeOnServer(request.serverName, request.uri, options);
  }

  async unsubscribeResourcesBySubscriber(subscriberKeyPrefix: string): Promise<number> {
    const released = this.resourceSubscriptions.removeByPrefix(subscriberKeyPrefix);
    for (const { serverName, uri } of released) {
      await this.unsubscribeOnServer(serverName, uri, {});
    }
    return released.length;
  }

  /** 登记表快照（测试 / 诊断）：serverName → uri → 订阅者数。 */
  resourceSubscriptionCounts(): Record<string, Record<string, number>> {
    return this.resourceSubscriptions.counts();
  }

  private async unsubscribeOnServer(
    serverName: string,
    uri: string,
    options: McpCallToolOptions,
  ): Promise<void> {
    const record = this.records.get(serverName);
    if (!record?.client || record.status.status !== "connected") return;
    try {
      const sent = await waitWithinMcpDeadline(
        this.syncResourceSubscription(serverName, record, uri),
        createMcpDeadline(options.timeoutMs ?? record.config.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS),
        `MCP resources/unsubscribe ${serverName} timed out`,
        options.signal,
      );
      // 远端本来就没有订阅时不发 RPC；修复前这种情况也记录"退订完成"，日志与实际请求不符。
      if (!sent) return;
      this.logger?.info("MCP resource unsubscribed", {
        event: "mcp.resource.unsubscribe",
        mcpServerName: serverName,
        uri,
        status: "completed",
      });
    } catch (error) {
      // 退订失败只记日志：登记表已清，server 多发的通知因没有订阅者会被丢弃。
      this.logger?.warn("MCP resource unsubscribe failed", {
        event: "mcp.resource.unsubscribe",
        mcpServerName: serverName,
        uri,
        error: error instanceof Error ? error.message : String(error),
        status: "failed",
      });
    }
  }

  /** 同 URI 的远端副作用按序完成；发送时读取登记表。返回本次是否真正发出了订阅/退订请求。 */
  private syncResourceSubscription(
    serverName: string,
    record: McpServerRecord,
    uri: string,
  ): Promise<boolean> {
    const client = record.client;
    const states = (record.resourceSubscriptions ??= new Map());
    const state: { subscribed: boolean | undefined; task?: Promise<boolean> } = states.get(uri) ?? {
      subscribed: false,
    };
    states.set(uri, state);
    // 前一请求的错误由其 caller 或恢复入口处理；后续意图仍需有机会收敛。
    const task = (state.task ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        if (
          this.records.get(serverName) !== record ||
          !client ||
          record.client !== client ||
          record.status.status !== "connected"
        )
          throw new SdkError(SdkErrorCode.ConnectionClosed, "Connection closed");
        record.abortController?.signal.throwIfAborted();
        const subscribed = this.resourceSubscriptions.subscribers(serverName, uri).length > 0;
        if (subscribed === state.subscribed) return false;
        const options = {
          signal: record.abortController?.signal,
          timeout: record.config.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS,
        };
        try {
          if (subscribed) await client.subscribeResource({ uri }, options);
          else await client.unsubscribeResource({ uri }, options);
          state.subscribed = subscribed;
          return true;
        } catch (error) {
          // 服务端明确拒绝时远端状态不变；其他失败不证明远端未执行，下一次申请必须重新确认。
          // 修复前拒绝也置为未知，随后会多发一次无意义的退订。
          if (!isPeerAnsweredError(error)) state.subscribed = undefined;
          throw error;
        }
      })
      .finally(() => {
        if (state.task !== task) return;
        state.task = undefined;
        if (state.subscribed === false) states.delete(uri);
      });
    state.task = task;
    return task;
  }

  private async resolveForResourceRequest(
    serverName: string,
    operation: string,
    options: McpCallToolOptions,
  ): Promise<{
    record: McpServerRecord & { client: McpClient };
    deadline: McpDeadline;
    timeoutMessage: string;
  }> {
    const timeoutMs =
      options.timeoutMs ?? this.records.get(serverName)?.config.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
    const deadline = createMcpDeadline(timeoutMs);
    const timeoutMessage = `MCP ${operation} ${serverName} timed out after ${timeoutMs}ms`;
    const record = await this.resolveConnectedRecord(
      serverName,
      deadline,
      timeoutMessage,
      options.signal,
    );
    return { record, deadline, timeoutMessage };
  }

  /**
   * server 主动通知。订阅类通知附上当前登记的 subscriberKey（宿主据此按会话拆分）；
   * tools/list_changed 标脏并在后台刷新该 server；没有端口时 SDK 默认丢弃。
   */
  private installNotificationHandlers(client: McpClient, serverName: string): void {
    const setNotificationHandler = (client as unknown as { setNotificationHandler?: unknown })
      .setNotificationHandler;
    if (typeof setNotificationHandler !== "function") return;
    // SDK 2.x：第一个参数是通知方法名（spec 方法直接用字符串），schema 是可选的第二个参数。
    const typed = client as unknown as {
      setNotificationHandler(method: string, handler: (notification: unknown) => void): void;
    };
    typed.setNotificationHandler(MCP_NOTIFICATION_TOOLS_LIST_CHANGED, () => {
      const record = this.records.get(serverName);
      // 按 client 身份核对来源：被替换的旧连接迟到的通知不能给同名新连接标脏。
      if (!record || record.client !== client) return;
      record.toolsStale = true;
      // 各 server 独立在后台刷新，下一次正常请求读快照时采用。
      void this.refreshTools(serverName);
      this.notifications?.onNotification({ kind: "toolListChanged", serverName });
    });
    typed.setNotificationHandler(MCP_NOTIFICATION_RESOURCES_UPDATED, (notification) => {
      const uri = (notification as { params?: { uri?: unknown } }).params?.uri;
      if (typeof uri !== "string") return;
      this.notifications?.onNotification({
        kind: "resourceUpdated",
        serverName,
        uri,
        subscribers: this.resourceSubscriptions.subscribers(serverName, uri),
      });
    });
    typed.setNotificationHandler(MCP_NOTIFICATION_RESOURCES_LIST_CHANGED, () => {
      this.notifications?.onNotification({
        kind: "resourceListChanged",
        serverName,
        subscribers: this.resourceSubscriptions.allSubscribers(serverName),
      });
    });
    typed.setNotificationHandler(MCP_NOTIFICATION_MESSAGE, (notification) => {
      const params = (notification as { params?: Record<string, unknown> }).params ?? {};
      this.notifications?.onNotification({
        kind: "loggingMessage",
        serverName,
        level: typeof params.level === "string" ? params.level : "info",
        ...(typeof params.logger === "string" ? { logger: params.logger } : {}),
        data: params.data,
      });
    });
  }

  async callTool(
    request: McpCallToolRequest,
    options: McpCallToolOptions = {},
  ): Promise<McpToolCallResult> {
    const timeoutMs =
      options.timeoutMs ??
      this.records.get(request.serverName)?.config.timeoutMs ??
      DEFAULT_MCP_TIMEOUT_MS;
    const deadline = createMcpDeadline(timeoutMs);
    const timeoutMessage = `MCP tool ${request.serverName}/${request.toolName} timed out after ${timeoutMs}ms`;
    if (options.appConnection) {
      // MCP App 只能在打开时的连接上执行：换代后拒绝，不重试，也不在调用中做授权恢复。
      const snapshot = this.appConnectionSnapshot(request.serverName);
      const current = this.records.get(request.serverName);
      if (
        !snapshot ||
        snapshot.identity !== options.appConnection.identity ||
        snapshot.generation !== options.appConnection.generation ||
        !current?.client
      )
        throw new Error("MCP App connection changed");
      options.signal?.throwIfAborted();
      return await this.callToolOnClient(
        current.client,
        request,
        remainingMcpDeadlineMs(deadline, timeoutMessage),
        options.signal,
        options.onProgress,
      );
    }

    // 模型调用晚绑定当前 client：同配置重连后的新连接直接可用，不固定连接身份。
    const record = await this.resolveConnectedRecord(
      request.serverName,
      deadline,
      timeoutMessage,
      options.signal,
    );
    // 只有调用开始时已分配 session 的 404 才表示会话过期；无状态 server 的 404 是普通错误。
    const hadSessionId =
      record.transport instanceof StreamableHTTPClientTransport &&
      record.transport.sessionId !== undefined;
    try {
      return await this.callToolOnClient(
        record.client,
        request,
        remainingMcpDeadlineMs(deadline, timeoutMessage),
        options.signal,
        options.onProgress,
      );
    } catch (error) {
      const trigger =
        record.config.type !== "stdio" && resolveAuthorizationCodeOAuthConfig(record.config)
          ? classifyInteractiveAuthorizationTrigger(error)
          : undefined;
      if (!trigger && !isRetryableCallError(error, { type: record.config.type, hadSessionId }))
        throw error;
      const revived = await this.reconnectForRetry({
        name: request.serverName,
        record,
        toolName: request.toolName,
        deadline,
        timeoutMessage,
        options,
        ...(trigger ? { trigger } : {}),
      });
      if (!revived) throw error;
      return await this.callToolOnClient(
        revived.client,
        request,
        remainingMcpDeadlineMs(deadline, timeoutMessage),
        options.signal,
        options.onProgress,
      );
    }
  }

  /**
   * 工具调用重试前的唯一入口：自己的记录仍是当前记录时先发起重连（授权错误走调用期授权），
   * 再在 `min(重连等待上限, 剩余预算)` 内等待当前连接任务。修复前会话过期、未发送和授权失效
   * 各有一条恢复路径和各自的目标校验；现在只检查连接是否仍属于这次调用：
   * adapter 未关闭、配置键相同、已连接、工具仍存在、租约持有方允许。
   */
  private async reconnectForRetry(input: {
    name: string;
    record: McpServerRecord & { client: McpClient };
    toolName: string;
    deadline: McpDeadline;
    timeoutMessage: string;
    options: McpCallToolOptions;
    trigger?: InteractiveAuthorizationTrigger;
  }): Promise<(McpServerRecord & { client: McpClient }) | undefined> {
    const { name, record, options } = input;
    if (this.closed) return undefined;
    if (this.records.get(name) === record && record.status.status === "connected") {
      if (input.trigger) {
        this.logger?.warn("MCP tool call requires OAuth authorization", {
          event: "mcp.oauth.tool_call.authorization_required",
          mcpServerName: name,
          oauthTriggerReason: input.trigger.reason,
          status: "started",
          toolName: input.toolName,
        });
        void this.startConnection(name, record.config, {}, { oauthTrigger: input.trigger });
      } else {
        // 服务端返回连接关闭时不会触发 onerror；由这里使当前连接失效。
        this.invalidateConnection(name, this.connectionGenerations.get(name) ?? 0, record.client);
      }
    }
    const pending = this.records.get(name);
    // 授权链接已发布时不再等待：这次调用以原始错误结束，由 core 按 needs-auth 状态改写结果，授权在后台继续。
    if (pending?.connecting && !pending.status.authorization) {
      const capAt = Date.now() + MCP_RECONNECT_WAIT_MS;
      const authorization = this.watchAuthorizationLink(name);
      try {
        await waitWithinMcpDeadline(
          // 修复原因：调用期授权要等用户在浏览器里操作，修复前这次调用等满 30 s 才以工具超时结束，
          // 模型不知道需要用户授权。链接发布即结束等待。
          Promise.race([pending.connecting.then(() => undefined), authorization.published]),
          { ...input.deadline, expiresAt: Math.min(input.deadline.expiresAt, capAt) },
          input.timeoutMessage,
          options.signal,
        );
      } catch (error) {
        // 修复原因：重连等待上限先到时修复前报"工具超时"，模型误以为工具本身超时；返回原始错误。
        // 调用自身的预算先到期仍是工具超时。
        if (!(error instanceof McpTimeoutError) || capAt >= input.deadline.expiresAt) throw error;
        return undefined;
      } finally {
        authorization.dispose();
      }
    }
    options.signal?.throwIfAborted();
    const current = this.records.get(name);
    if (
      this.closed ||
      !current?.client ||
      current.status.status !== "connected" ||
      mcpConfigKey(current.config) !== mcpConfigKey(record.config) ||
      !current.tools.some((tool) => tool.toolName === input.toolName) ||
      options.retryAllowed?.() === false
    )
      return undefined;
    return current as McpServerRecord & { client: McpClient };
  }

  /**
   * 插件 UI 的 `ui://` 资源读取。与 callTool 共用连接等待 / 断连重连骨架（resolveConnectedRecord），
   * 保证走同一条连接与 OAuth 恢复路径；不做 tool 级 OAuth 二次恢复——资源读取失败直接冒泡，
   * 由 UI 回退到普通卡片。
   */
  async readResource(
    request: McpReadResourceRequest,
    options: McpCallToolOptions = {},
  ): Promise<McpReadResourceResult> {
    const timeoutMs =
      options.timeoutMs ??
      this.records.get(request.serverName)?.config.timeoutMs ??
      DEFAULT_MCP_TIMEOUT_MS;
    const deadline = createMcpDeadline(timeoutMs);
    const timeoutMessage = `MCP resource ${request.serverName} ${request.uri} timed out after ${timeoutMs}ms`;
    const record = await this.resolveConnectedRecord(
      request.serverName,
      deadline,
      timeoutMessage,
      options.signal,
    );
    const result = await record.client.readResource(
      { uri: request.uri },
      { signal: options.signal, timeout: remainingMcpDeadlineMs(deadline, timeoutMessage) },
    );
    return {
      contents: (result.contents ?? []).map((content) => {
        const item = content as Record<string, unknown>;
        return {
          uri: typeof item.uri === "string" ? item.uri : request.uri,
          ...(typeof item.mimeType === "string" ? { mimeType: item.mimeType } : {}),
          ...(typeof item.text === "string" ? { text: item.text } : {}),
          ...(typeof item.blob === "string" ? { blob: item.blob } : {}),
          ...(isRecord(item._meta) ? { _meta: item._meta } : {}),
        };
      }),
    };
  }

  /**
   * callTool / readResource 共用：等待共享 connecting 任务、对已断连 record 重连一次、
   * 返回处于 connected 的 record。抽出来是为了让资源读取与工具调用走完全相同的恢复路径。
   */
  private async resolveConnectedRecord(
    serverName: string,
    deadline: McpDeadline,
    timeoutMessage: string,
    signal: AbortSignal | undefined,
  ): Promise<McpServerRecord & { client: McpClient }> {
    const pending = this.connectionTask(serverName);
    if (pending) {
      // 等待只限制本 caller 的预算，连接任务由记录持有，不能取消其他租约的连接。
      await waitWithinMcpDeadline(
        pending.then(() => undefined),
        deadline,
        timeoutMessage,
        signal,
      );
    }

    const record = this.records.get(serverName);
    if (!record?.client || record.status.status !== "connected") {
      throw new Error(`MCP server is not connected: ${serverName}`);
    }
    return record as McpServerRecord & { client: McpClient };
  }

  /** 连接期诊断按 server 保存；tool call request id 继续按 span 隔离。 */
  private rememberServerResponse(
    serverName: string,
    response: OfficialMcpServerResponseInfo,
  ): void {
    if (
      !response.spanId &&
      response.rpcMethod !== "tools/call" &&
      this.records.get(serverName)?.status.status === "connecting"
    ) {
      if (response.failureKind) {
        this.connectionDiagnosticByServer.set(serverName, {
          failureKind: response.failureKind,
          ...(response.serverRequestId ? { serverRequestId: response.serverRequestId } : {}),
        });
      }
      return;
    }
    if (!response.spanId) return;
    if (!response.serverRequestId) return;
    // 401 重试会对同一 span 产生两条响应，后写覆盖——留下的是最终那次，正是要报的那个。
    this.serverRequestIdBySpan.set(response.spanId, response.serverRequestId);
    while (this.serverRequestIdBySpan.size > MAX_TRACKED_SERVER_REQUEST_IDS) {
      const oldest = this.serverRequestIdBySpan.keys().next();
      if (oldest.done) break;
      this.serverRequestIdBySpan.delete(oldest.value);
    }
  }

  /** 取出并清除该 span 的 request id。取不到返回 undefined，不做任何兜底猜测。 */
  private takeServerRequestId(spanId: string | undefined): string | undefined {
    if (!spanId) return undefined;
    const requestId = this.serverRequestIdBySpan.get(spanId);
    if (requestId !== undefined) this.serverRequestIdBySpan.delete(spanId);
    return requestId;
  }

  /**
   * 解析 stdio 官方 MCP 本次出站协议消息的身份头。
   * 返回 undefined 表示"不是官方 stdio server"——此时 `_meta` 里绝不能出现该键，否则等于把
   * 身份头广播给任意第三方插件。
   */
  private async resolveOfficialStdioAuthMeta(
    serverName: string,
    config: McpServerConfig,
    signal: AbortSignal | undefined,
  ): Promise<OfficialMcpAuthMetaPayload | undefined> {
    if (config.type !== "stdio" || !isOfficialAuthConfig(config) || !config.official) {
      return undefined;
    }
    const official = config.official;
    const authHeadersPort = this.officialMcpAuth?.authHeadersPort;
    const trustedOrigins = this.officialMcpAuth?.trustedOrigins;
    const resolveZCodeApiOrigin = this.officialMcpAuth?.resolveZCodeApiOrigin;
    const logBase = {
      event: "mcp.official_auth.stdio_meta",
      mcpKey: official.mcpKey,
      mcpServerName: serverName,
      module: "adapters.mcp",
    };
    const fail = (reason: OfficialMcpAuthFailureReason): OfficialMcpAuthMetaPayload => {
      // 刻意不写 lastOfficialAuthKind：那个 map 只被 failConnection 读取，用来给**连接失败**
      // 打分类标签。stdio 的身份头缺失不会让连接失败，写进去会一直留着，等到该 server 之后
      // 因为别的原因（子进程死掉等）真正断连时被当成断连原因记进日志，属误导。
      // 本路径的可观测性由下面这条自己的 event + 下发给插件的 reason 承担。
      this.logger?.warn("Official MCP stdio auth headers unavailable", {
        ...logBase,
        reason,
        status: "failed",
      });
      return { ok: false, reason };
    };

    // standalone CLI 没有 host auth port。不静默省略该键：插件区分不了"宿主不支持"与
    // "宿主支持但我没登录"，只有显式 reason 才能给出正确的用户提示。
    if (!authHeadersPort || !trustedOrigins || !resolveZCodeApiOrigin) {
      return fail("official_auth_unavailable");
    }

    // stdio 没有 url，origin 由宿主给出而非插件声明。isTrusted 在此退化为恒真断言，但仍要调用：
    // 它同时校验 https、拒绝带 username/password 的 URL，并让 dev loopback 开关继续生效。
    //
    // 这两步原来裸调用。origin 解析依赖 settings / 运行时环境，isTrusted 是
    // 注入的实现，两者都可能抛。异常裸冒泡会绕过整个失败分类：插件收不到 `{ok:false, reason}`，
    // 而 reason 是跨 adapter / host / UI 的契约（决定提示文案与是否重试）。因此统一映射为
    // official_auth_unavailable——宿主侧解析不出可信 origin，对插件而言就是"官方鉴权不可用"。
    // 错误文本只进日志，绝不参与流程判断。
    let targetOrigin: string;
    let trust: Awaited<ReturnType<OfficialMcpTrustedOriginRegistry["isTrusted"]>>;
    try {
      targetOrigin = resolveZCodeApiOrigin();
      trust = await trustedOrigins.isTrusted({
        mcpKey: official.mcpKey,
        origin: targetOrigin,
        pluginId: official.pluginId,
      });
    } catch (error) {
      this.logger?.warn("Official MCP stdio origin resolution failed", {
        ...logBase,
        error: error instanceof Error ? error.message : String(error),
        errorName: error instanceof Error ? error.name : "unknown",
        pluginId: official.pluginId,
      });
      return fail("official_auth_unavailable");
    }
    if (!trust.trusted) {
      this.logger?.warn("Official MCP stdio origin is not trusted", {
        ...logBase,
        detail: trust.detail ?? "unknown",
        pluginId: official.pluginId,
        targetOrigin,
      });
      return fail("official_mcp_origin_untrusted");
    }

    const resolved = await authHeadersPort.resolveHeaders({
      mcpKey: official.mcpKey,
      pluginId: official.pluginId,
      targetOrigin,
      ...(this.officialMcpAuth?.workspaceIdentity
        ? { workspaceIdentity: this.officialMcpAuth.workspaceIdentity }
        : {}),
      ...(this.workingDirectory ? { workspacePath: this.workingDirectory } : {}),
      ...(this.workspaceKey ? { workspaceKey: this.workspaceKey } : {}),
      ...(signal ? { signal } : {}),
    });
    if (!resolved.ok) return fail(resolved.reason);

    // 只记 header 名与套餐维度，绝不记 header 值——日志留存周期不受控。
    this.logger?.debug("Official MCP stdio auth headers attached", {
      ...logBase,
      identityHeaderNames: Object.keys(resolved.headers)
        .map((name) => name.toLowerCase())
        .sort(),
      ...(resolved.headers["Bigmodel-Target-Type"]
        ? { identityTargetType: resolved.headers["Bigmodel-Target-Type"] }
        : {}),
      status: "completed",
    });
    return { ok: true, headers: resolved.headers };
  }

  /** server 主动 elicitation/create：归属到该 server 当前工具调用的会话，交给宿主提问端口。 */
  private installElicitationHandler(client: McpClient, serverName: string): void {
    const port = this.elicitation;
    const setRequestHandler = (client as unknown as { setRequestHandler?: unknown })
      .setRequestHandler;
    if (!port || typeof setRequestHandler !== "function") return;
    (
      client as unknown as {
        setRequestHandler(
          method: "elicitation/create",
          handler: (request: {
            params: { message: string; requestedSchema?: unknown };
          }) => Promise<unknown>,
        ): void;
      }
    ).setRequestHandler("elicitation/create", async (request) => {
      // 接受缺省 / "form" / 兼容接口的 "openai/form" / "openaiForm"；url 等其它模式 decline。
      const mode = (request.params as { mode?: unknown }).mode;
      if (!isSupportedElicitationMode(mode)) {
        this.logger?.warn("MCP elicitation mode not supported, declining", {
          event: "mcp.elicitation.unsupported_mode",
          mcpServerName: serverName,
          mode: String(mode),
        });
        return { action: "decline" };
      }
      const trace = this.activeCallTraces.get(serverName);
      const result = await port.requestElicitation({
        serverName,
        message: request.params.message,
        requestedSchema: request.params.requestedSchema,
        ...(trace ? { trace } : {}),
      });
      return result.action === "accept"
        ? { action: "accept", content: result.content ?? {} }
        : { action: result.action };
    });
  }

  /** 调用期间登记 trace，server 在这段时间发起的 elicitation 才能归属到会话 / 工具行。 */
  private async callToolOnClient(
    client: McpClient,
    request: McpCallToolRequest,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    onProgress?: McpCallToolOptions["onProgress"],
  ): Promise<McpToolCallResult> {
    this.activeCallTraces.set(request.serverName, {
      ...(request.trace?.sessionId ? { sessionId: String(request.trace.sessionId) } : {}),
      ...(request.trace?.turnId ? { turnId: String(request.trace.turnId) } : {}),
      ...(request.trace?.traceId ? { traceId: String(request.trace.traceId) } : {}),
    });
    try {
      return await this.callToolOnClientInner(client, request, timeoutMs, signal, onProgress);
    } finally {
      this.activeCallTraces.delete(request.serverName);
    }
  }

  private async callToolOnClientInner(
    client: McpClient,
    request: McpCallToolRequest,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    onProgress?: McpCallToolOptions["onProgress"],
  ): Promise<McpToolCallResult> {
    // 工具调用此前完全无日志：超时时既看不到预算是多少，也无法区分"服务端慢"与
    // "客户端预算太小"。这里记录预算与耗时，但只记参数的 key（值可能是用户输入）。
    const logBase = {
      event: "mcp.tool.call",
      mcpServerName: request.serverName,
      mcpToolName: request.toolName,
      module: "adapters.mcp",
      timeoutMs,
    };
    const argumentKeys = Object.keys(request.arguments ?? {}).sort();
    this.logger?.debug("MCP tool call started", {
      ...logBase,
      argumentKeys,
      status: "started",
    });

    const startedAt = Date.now();
    try {
      const result = await client.callTool(
        {
          name: request.toolName,
          arguments: request.arguments ?? {},
          ...(request.trace || request.runtimeScope || request.workspaceKey || request.workspacePath
            ? { _meta: mcpRequestMeta(request) }
            : {}),
        },
        {
          signal,
          timeout: timeoutMs,
          // 进度通知重置超时（A8）：长任务只要持续上报就不会被 timeoutMs 打断；总时长由工具级 _meta.timeoutMs 约束。
          resetTimeoutOnProgress: true,
          ...(onProgress
            ? {
                onprogress: (notification: {
                  progress: number;
                  total?: number;
                  message?: string;
                }) =>
                  onProgress({
                    progress: notification.progress,
                    ...(notification.total !== undefined ? { total: notification.total } : {}),
                    ...(notification.message !== undefined
                      ? { message: notification.message }
                      : {}),
                  }),
              }
            : {}),
        },
      );

      const durationMs = Date.now() - startedAt;
      const isError = typeof result.isError === "boolean" ? result.isError : false;
      // 官方 MCP 的 in-band 失败（配额耗尽、无套餐）是 HTTP 200 + isError，wrapper 那条
      // 非 2xx warn 覆盖不到；request id 也只有 wrapper 能看到，所以在这里按 span 取回。
      const serverRequestId = this.takeServerRequestId(request.trace?.spanId);
      const outcome = {
        ...logBase,
        contentBlocks: Array.isArray(result.content) ? result.content.length : 0,
        durationMs,
        hasStructuredContent: result.structuredContent !== undefined,
        // 业务级失败（isError）与传输级失败不同，必须能分开统计。
        isError,
        ...(serverRequestId ? { serverRequestId } : {}),
      };
      if (isError) {
        // 之前 in-band 失败只有这条 debug，而生产 logger 最低级别是 Info——等于配额耗尽
        // 这类失败在生产日志里完全不可见。
        this.logger?.warn("MCP tool returned an error", { ...outcome, status: "failed" });
      } else {
        this.logger?.debug("MCP tool call completed", { ...outcome, status: "completed" });
      }

      const meta = isRecord(result._meta) ? result._meta : undefined;
      return {
        content: Array.isArray(result.content)
          ? (result.content as McpContentBlock[])
          : [{ type: "text", text: "" }],
        structuredContent: result.structuredContent,
        isError: typeof result.isError === "boolean" ? result.isError : undefined,
        // 只在失败时附加：成功路径上它是纯噪声。服务端已给的键一律不覆盖。
        _meta:
          isError && serverRequestId
            ? { ...meta, [ZCODE_MCP_SERVER_REQUEST_ID_META_KEY]: serverRequestId }
            : meta,
      };
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const message = error instanceof Error ? error.message : String(error);
      // 判定是否为超时：SDK 超时会抛 MCP error code -32001 (RequestTimeout)，
      // 底层 fetch abort 抛 AbortError。两者都要能一眼认出，否则只能看到裸 message。
      const timedOut =
        /timed?\s*out|timeout/i.test(message) ||
        (error instanceof Error && error.name === "AbortError");
      // 传输级失败也带上：4xx/5xx 时 SDK 抛出的 message 里没有 request id。
      const serverRequestId = this.takeServerRequestId(request.trace?.spanId);
      this.logger?.warn("MCP tool call failed", {
        ...logBase,
        argumentKeys,
        durationMs,
        error: message,
        ...(serverRequestId ? { serverRequestId } : {}),
        errorName: error instanceof Error ? error.name : "unknown",
        status: "failed",
        timedOut,
        // 耗时贴着预算 ⇒ 是我们掐断的；远小于预算 ⇒ 是对端或网络断的。
        ...(timedOut ? { budgetExhausted: durationMs >= timeoutMs * 0.9 } : {}),
      });
      throw error;
    }
  }

  /** 执行准入与 MCP App 打开时调用：复用已有任务；显式断开或 stdio 意外断连的记录重新连接。 */
  private connectionTask(name: string): Promise<McpServerStatus> | undefined {
    const record = this.records.get(name);
    if (!record || record.connecting) return record?.connecting;
    if (
      record.status.status === "disconnected" ||
      record.status.failureKind === "unexpected_disconnect"
    )
      // 保留了目录的记录（内建 server 超过重启上限）重连期间目录不变；其余记录没有目录，行为不变。
      return this.startConnection(
        name,
        record.config,
        {},
        { retainTools: record.toolsVersion !== undefined },
      );
    return undefined;
  }

  /** 失效先撤销执行资格并登记恢复，所有事件与探测共用同一个转换。 */
  private invalidateConnection(name: string, generation: number, client: McpClient): boolean {
    const record = this.records.get(name);
    if (!this.isCurrentConnection(name, generation) || record?.client !== client) return false;
    if (record.status.status !== "connected") {
      // discovery 的响应与断连可能相邻到达；已关闭的候选不能随后提交为 ready。
      record.client = undefined;
      return false;
    }
    // 修复原因：内建 node_repl 进程被外部终止（例如 `pkill -f node`）后过去按普通 stdio 进入 failed。
    // 会话视图在下一步撤下它的工具，模型不再调用，执行准入重连到不了；同 workspace 的新会话
    // 也复用这条 failed 记录，整个 workspace 的 node_repl 一直不可用。内建 server 不在设置页列出，
    // 用户也无法手动重连，所以由 adapter 立即走后台恢复，并限制重启频率。
    if (
      record.config.type === "http" ||
      record.config.type === "sse" ||
      this.admitBuiltinRestart(name, record.config)
    ) {
      // 同步关闭旧 client：在途请求（包括触发失效的那次）一律以连接关闭结束，HTTP 调用据此重试一次；
      // 结果不取决于关闭任务与各请求错误传播的先后。
      client.onclose = undefined;
      void client.close().catch(() => undefined);
      // 同步登记 pending 并保留有效目录；关闭旧连接、有限重试由同一任务完成。
      void this.startConnection(name, record.config, {}, { recovering: true });
    } else {
      this.nextConnectionGeneration(name);
      record.abortController?.abort(new Error("MCP connection closed"));
      this.commitUnavailable(
        name,
        record,
        this.createStatus(record.config, "failed", {
          error: "MCP server connection closed unexpectedly",
          errorCode: "ConnectionClosed",
          failureKind: "unexpected_disconnect",
        }),
      );
    }
    return true;
  }

  /**
   * 来源 builtin 的 stdio server 意外退出后能否自动重启：窗口内未到上限就登记这一次。
   * builtin 包括宿主注入的 node_repl 和官方市场插件声明的 server。
   */
  private admitBuiltinRestart(name: string, config: McpServerConfig): boolean {
    if (config.type !== "stdio" || config.source?.kind !== "builtin") return false;
    const now = Date.now();
    const recent = (this.builtinRestarts.get(name) ?? []).filter(
      (restartedAt) => now - restartedAt < MCP_BUILTIN_RESTART_WINDOW_MS,
    );
    const admitted = recent.length < MCP_BUILTIN_RESTART_LIMIT;
    if (admitted) recent.push(now);
    else
      this.logger?.warn("MCP built-in server restart limit reached", {
        event: "mcp.server.restart.limit_reached",
        mcpServerName: name,
        restartCount: recent.length,
        windowMs: MCP_BUILTIN_RESTART_WINDOW_MS,
      });
    this.builtinRestarts.set(name, recent);
    return admitted;
  }

  async close(): Promise<void> {
    this.closed = true;
    const startedAt = Date.now();
    const serverCount = this.records.size;
    for (const name of this.records.keys()) {
      this.nextConnectionGeneration(name);
    }
    await Promise.all(Array.from(this.records.keys()).map((name) => this.closeRecord(name)));
    this.records.clear();
    this.snapshotListeners.clear();
    this.connectionDiagnosticByServer.clear();
    this.logger?.info("MCP adapter closed", {
      durationMs: Date.now() - startedAt,
      event: "mcp.adapter.closed",
      serverCount,
      status: "completed",
    });
  }

  private waitForSharedConnection(
    name: string,
    record: McpServerRecord,
    options: McpConnectOptions,
  ): Promise<McpServerStatus> {
    const connecting = record.connecting;
    if (!connecting) return Promise.resolve(record.status);
    if (options.oauthAuthorizationTimeoutMs === undefined && !options.signal) {
      return connecting;
    }

    // 共享任务的失败保留原样；只有本 caller 的等待取消/超时转换成状态返回。
    const outcome = connecting.then(
      (status) => ({ status }),
      (error: unknown) => ({ error }),
    );
    return withTimeout(
      outcome,
      options.oauthAuthorizationTimeoutMs,
      "MCP connection wait timed out",
      options.signal,
    )
      .catch(() => ({ status: this.records.get(name)?.status ?? record.status }))
      .then((result) => {
        if ("error" in result) throw result.error;
        return result.status;
      });
  }

  private async openServerConnection(input: {
    config: McpServerConfig;
    generation: number;
    name: string;
    /** false 表示恢复期：遇到需要交互授权的错误直接失败，不打开授权页面。 */
    interactive: boolean;
    oauthAuthorizationTimeoutMs?: number;
    /** 工具调用遇到授权错误：先完成交互授权再建立连接。 */
    oauthTrigger?: InteractiveAuthorizationTrigger;
    abortController: AbortController;
    timeoutMs: number;
    workingDirectory?: string;
    oauthAuthorizationAttempted?: boolean;
  }): Promise<McpServerStatus> {
    const {
      config,
      generation,
      name,
      interactive,
      oauthAuthorizationAttempted = false,
      oauthAuthorizationTimeoutMs,
      abortController,
      timeoutMs,
      workingDirectory,
    } = input;
    const signal = abortController.signal;
    const startedAt = Date.now();
    if (input.oauthTrigger && config.type !== "stdio") {
      const oauthConfig = resolveAuthorizationCodeOAuthConfig(config);
      if (oauthConfig)
        return this.authorizeThenConnect(input, config, oauthConfig, input.oauthTrigger, startedAt);
    }
    let client: McpClient | undefined;
    let connectDurationMs: number | undefined;
    let getRecentStderr: (() => string | undefined) | undefined;
    let listToolsDurationMs: number | undefined;
    let transport: McpTransport | undefined;
    let failureKind: McpServerFailureKind =
      config.type === "stdio" ? "process_start_failed" : "network_unreachable";

    try {
      // 根因（MR !3089 评审 CR-02）：首次 stdio 连接要先准备 node fallback（文件 IO），原先在
      // createTransport 里裸等，不受连接超时与取消约束；IO 卡住时连接会一直停在 connecting。
      const nodeFallback =
        config.type === "stdio" && this.nodeFallback
          ? await withTimeout(
              this.nodeFallback.resolve(),
              timeoutMs,
              `MCP server ${name} node fallback preparation timed out after ${timeoutMs}ms`,
              signal,
            )
          : undefined;
      const transportBundle = await this.createTransport(
        config,
        name,
        generation,
        oauthAuthorizationTimeoutMs,
        workingDirectory,
        signal,
        nodeFallback,
      );
      transport = transportBundle.transport;
      getRecentStderr = this.attachStdioLogging(name, transport);
      client = new Client(
        {
          name: this.clientName,
          version: this.clientVersion,
        },
        {
          versionNegotiation: resolveVersionNegotiation(config, timeoutMs),
          capabilities: {
            // MCP Apps 规范：宿主经 `extensions["io.modelcontextprotocol/ui"]` 宣告能渲染的 UI mimeType，
            // 官方 SDK 的 server 据此决定是否下发 ui 资源（getUiCapability）。
            ...buildMcpAppsClientCapabilities(),
            // 只宣告 form 模式（url 模式不做）；server 据此选择 elicitation 形态。
            ...(this.elicitation ? { elicitation: { form: {} } } : {}),
          },
        },
      );
      this.installElicitationHandler(client, name);
      this.installNotificationHandlers(client, name);
      this.updateCurrentRecord(name, generation, {
        client,
        transport,
      });

      let mcpTransportPid: number | undefined;
      let mcpProcessIdentity:
        | ReturnType<NonNullable<CreateMcpAdapterOptions["telemetry"]>["recordProcessStarted"]>
        | undefined;
      // stdio MCP 子进程死亡（如 node_repl 被 REPL cell 的异步错误击穿）不能完全
      // 静默——不记日志、状态停留在 connected，后续调用只会抛裸的 "Not connected"。
      // 挂 onclose 把意外断连显式化；主动关闭路径会先清掉 onclose（见 closeClientAndTransport）。
      client.onclose = () => {
        if (!this.invalidateConnection(name, generation, client!)) return;
        const recentStderr = getRecentStderr?.();
        const processExit = getStdioTransportExitInfo(transport);
        this.logger?.warn("MCP server connection lost", {
          ...this.connectionContext,
          event: "mcp.server.connection_lost",
          mcpServerName: name,
          ...(mcpTransportPid != null ? { mcpTransportPid } : {}),
          ...(mcpProcessIdentity ?? {}),
          ...(processExit
            ? { exitCode: processExit.exitCode, signal: processExit.signal ?? undefined }
            : {}),
          status: "failed",
          transport: config.type,
          ...(recentStderr ? { stderr: recentStderr } : {}),
        });
        if (
          config.type === "stdio" &&
          this.connectionContext &&
          (processExit || !isStdioTransportProcessAlive(transport))
        ) {
          this.telemetry?.recordProcessCrashed({
            connectionId: this.connectionContext.mcpConnectionId,
            exitCode: processExit?.exitCode ?? null,
            signal: processExit?.signal ?? null,
          });
        }
      };
      if (config.type === "sse" || config.type === "http") {
        // SDK 不为 SSE 断流或 HTTP 会话过期派发 onclose，统一交给连接恢复 owner。
        // 修复前任何带 session 的 404 都重建连接；只实现 POST 的有状态 server 对 GET 返回 404，
        // 连接会在 discovery 期间被反复判死。GET 打开事件流失败现在只记日志。
        client.onerror = (error) => {
          if (config.type === "sse") {
            if (error instanceof SseError) this.invalidateConnection(name, generation, client!);
            return;
          }
          if (!(transport instanceof StreamableHTTPClientTransport)) return;
          const kind = classifyTransportError(error, { sessionId: transport.sessionId });
          if (kind === "session_expired") this.invalidateConnection(name, generation, client!);
          else if (kind === "stream_open_failed")
            this.logger?.debug("MCP server event stream unavailable", {
              event: "mcp.server.event_stream_unavailable",
              mcpServerName: name,
              httpStatus: error instanceof SdkHttpError ? error.status : undefined,
            });
        };
      }

      const connectStartedAt = Date.now();
      await withTimeout(
        client.connect(transport),
        timeoutMs,
        `MCP server ${name} connection timed out after ${timeoutMs}ms`,
        signal,
      );
      connectDurationMs = Date.now() - connectStartedAt;

      failureKind = "tool_list_failed";
      const listToolsStartedAt = Date.now();
      const listed = await withTimeout(
        client.listTools(),
        timeoutMs,
        `MCP server ${name} tool listing timed out after ${timeoutMs}ms`,
        signal,
      );
      listToolsDurationMs = Date.now() - listToolsStartedAt;
      const tools = listed.tools.map((tool) =>
        normalizeMcpToolDescriptor(
          name,
          tool,
          config.timeoutMs,
          // 只有 http 形态置位。这个标记的用途是**信任结果里的结构化标识**
          // （额度耗尽 / 无套餐），因此判据必须是"结果由谁产出"：
          //   - http：结果来自 ZCode 后端。fetch wrapper 对每次请求校验 origin；登录态只在
          //     tools/call 解析，缺失时由同一可信后端返回结构化 coding_plan_required；
          //   - stdio：结果由插件进程自己产出，可以任意伪造 `{"error_code":"quota_exceeded"}`，
          //     从而在用户输入框上方弹出"额度用完 / 请开通 Coding Plan"的误导提示。
          // 原判据是 `type !== "sse"`，把 stdio 一起放了进来，等于这道门槛在 stdio 上为零。
          // 注意这不是在挡凭证外泄（那由 origin 校验负责），而是在挡**结果伪造**。
          config.type === "http" && config.auth?.type === ZCODE_OFFICIAL_MCP_AUTH_TYPE,
          config.alwaysLoad,
        ),
      );
      const negotiatedProtocolEra = client.getProtocolEra();
      const negotiatedProtocolVersion = client.getNegotiatedProtocolVersion();
      const status = this.createStatus(config, "connected", {
        protocolEra: negotiatedProtocolEra,
        toolCount: tools.length,
      });
      if (!this.isCurrentConnection(name, generation)) {
        await this.closeClientAndTransport(name, client, transport);
        return this.records.get(name)?.status ?? status;
      }
      const record = this.records.get(name)!;
      if (!this.commitConnected(name, record, client, tools, status))
        throw new SdkError(SdkErrorCode.ConnectionClosed, "Connection closed");
      this.connectionDiagnosticByServer.delete(name);
      // discovery 期间的通知只标脏；ready 后由生产侧续接，消费快照不负责补拉。
      void this.refreshTools(name);
      mcpTransportPid = getStdioTransportPid(transport);
      mcpProcessIdentity =
        mcpTransportPid != null && this.connectionContext
          ? this.telemetry?.recordProcessStarted({
              connectionId: this.connectionContext.mcpConnectionId,
              pid: mcpTransportPid,
            })
          : undefined;
      // 此前连接日志只记录 transport，auto 协商后无法判断实际走 modern 还是 legacy。
      // 同时记录配置策略和 SDK 握手结果，避免把 `auto` 误当成最终协议版本。
      // 连接池上下文和 stdio transport PID 过去未进入同一事件，无法关联 session、
      // workspace、协议版本和真实子进程；stdio PID 只代表最终会话 transport，不代表 probe child。
      this.logger?.info("MCP server connected", {
        ...this.connectionContext,
        connectDurationMs,
        durationMs: Date.now() - startedAt,
        event: "mcp.server.connected",
        listToolsDurationMs,
        mcpClientName: this.clientName,
        mcpClientVersion: this.clientVersion,
        mcpProtocolEra: negotiatedProtocolEra ?? "unknown",
        mcpProtocolVersion: negotiatedProtocolVersion ?? "unknown",
        mcpServerName: name,
        ...(mcpProcessIdentity ?? {}),
        ...(mcpTransportPid != null ? { mcpTransportPid } : {}),
        mcpVersionNegotiationMode: formatVersionNegotiationMode(config),
        status: "completed",
        toolCount: tools.length,
        transport: config.type,
      });
      return status;
    } catch (error) {
      // 过去这里等的是旧 provider 自己开的 listener，且用 session 的 15 秒预算做
      // 硬关闭——15 秒是 caller 的等待预算，不是授权事务的寿命。现在按错误类型判定是否需要
      // 交互授权，并把授权交给 Phase 2 独立事务（独立锁、fresh DCR、300 秒事务 TTL）。
      const trigger = oauthAuthorizationAttempted
        ? undefined
        : classifyInteractiveAuthorizationTrigger(error);
      const authorizationCodeOAuthConfig =
        trigger && config.type !== "stdio"
          ? resolveAuthorizationCodeOAuthConfig(config)
          : undefined;
      if (trigger && authorizationCodeOAuthConfig && !interactive) {
        // 恢复期不打开授权页面：修复前 5 次恢复各自发起一次交互授权。结果对模型表现为 needs-auth，
        // 由用户在设置页显式重连或下一次工具调用时授权。
        return this.failConnection({
          client,
          config,
          connectDurationMs,
          error,
          failureKind: "oauth_authorization_failed",
          generation,
          getRecentStderr,
          listToolsDurationMs,
          name,
          startedAt,
          transport,
        });
      }
      if (trigger && authorizationCodeOAuthConfig && config.type !== "stdio") {
        // negotiation 失败时 SDK 已关闭 transport，不可复用；Phase 2 也不需要 transport。
        await this.closeClientAndTransport(name, client, transport);
        const outcome = await this.runInteractiveOAuthAuthorization({
          config,
          generation,
          name,
          oauthConfig: authorizationCodeOAuthConfig,
          serverUrl: config.url,
          signal,
          trigger,
        });
        if (outcome.status === "authorized" || outcome.status === "already-authorized") {
          return await this.openServerConnection({
            ...input,
            oauthAuthorizationAttempted: true,
          });
        }
        // client/transport 已在进入 Phase 2 前关闭，这里不再传入；failureKind 沿用
        // 诊断分类，让设置页把"授权没完成"与网络/进程类失败区分开。
        return this.failConnection({
          config,
          connectDurationMs,
          error:
            outcome.status === "pending"
              ? new Error(
                  `MCP server ${name} OAuth authorization is still in progress; complete it in the browser and reconnect`,
                )
              : outcome.error,
          failureKind: "oauth_authorization_failed",
          generation,
          getRecentStderr,
          listToolsDurationMs,
          name,
          startedAt,
        });
      }
      // `protocol_negotiation_failed` 枚举与 UI 文案在 shared/i18n 里早已存在，但 adapter
      // 侧一直没有产出方——auto/pin 模式下 SDK 的 server/discover probe 硬失败（典型：飞书项目
      // MCP 对未知方法回 HTTP 200 + id:null 的非标 JSON-RPC error，body 过不了
      // JSONRPCMessageSchema）会一路落到默认 failureKind "network_unreachable"，设置页因此
      // 显示误导性的"网络不可达"。这里按结构化错误类型（SdkErrorCode / isInstance）识别 SDK
      // 协商失败并产出正确分类，不依赖错误文本；withTimeout 不包装错误（timeout.ts 只透传
      // reject），cause 链仅作防御性兜底。
      const negotiationFailureKind = isProtocolNegotiationFailure(error)
        ? ("protocol_negotiation_failed" as const)
        : undefined;
      return this.failConnection({
        client,
        config,
        connectDurationMs,
        error,
        generation,
        getRecentStderr,
        listToolsDurationMs,
        name,
        startedAt,
        transport,
        failureKind: negotiationFailureKind ?? failureKind,
      });
    }
  }

  /** 调用期授权：Phase 2 交互授权成功后再按普通连接建立，失败收敛为 oauth_authorization_failed。 */
  private async authorizeThenConnect(
    input: Parameters<NodeMcpAdapter["openServerConnection"]>[0],
    config: Extract<McpServerConfig, { type: "http" | "sse" }>,
    oauthConfig: AuthorizationCodeOAuthConfig,
    trigger: InteractiveAuthorizationTrigger,
    startedAt: number,
  ): Promise<McpServerStatus> {
    const outcome = await this.runInteractiveOAuthAuthorization({
      config,
      generation: input.generation,
      name: input.name,
      oauthConfig,
      serverUrl: config.url,
      signal: input.abortController.signal,
      trigger,
    });
    if (outcome.status === "authorized" || outcome.status === "already-authorized") {
      return this.openServerConnection({
        ...input,
        oauthTrigger: undefined,
        oauthAuthorizationAttempted: true,
      });
    }
    return this.failConnection({
      config,
      error:
        outcome.status === "pending"
          ? new Error(
              `MCP server ${input.name} OAuth authorization is still in progress; complete it in the browser and reconnect`,
            )
          : outcome.error,
      failureKind: "oauth_authorization_failed",
      generation: input.generation,
      name: input.name,
      startedAt,
    });
  }

  /**
   * Phase 2：交互授权。
   *
   * 授权事务的寿命是 300 秒，与 caller 的等待预算（session 15 秒）无关；caller 侧的收口发生在
   * `connectServer` / `waitForSharedConnection`，本方法不感知 caller 预算。
   */
  private async runInteractiveOAuthAuthorization(input: {
    config: Extract<McpServerConfig, { type: "http" | "sse" }>;
    generation: number;
    name: string;
    oauthConfig: AuthorizationCodeOAuthConfig;
    serverUrl: string;
    signal: AbortSignal;
    trigger: InteractiveAuthorizationTrigger;
  }): Promise<McpInteractiveAuthorizationOutcome> {
    try {
      const oauthOptions = this.createAuthorizationCodeOAuthOptions(
        input.config,
        input.name,
        input.generation,
      );
      const credentialStore = oauthOptions?.credentialStore ?? createSharedZCodeCredentialStore();
      const keyPrefix = createCredentialKeyPrefix(input.name, input.serverUrl, input.oauthConfig);
      // 403 step-up 的最终 scope 必须是 config ∪ token.scope ∪ challenge
      // 的并集。只带 challenge scope 重新授权时，授权服务器可能按新请求收回先前授予的 scope，
      // 下一个请求换个 challenge 又 403，形成重授权乒乓。token response 的 scope 允许缺失
      // （RFC 6749 §3.3），所以配置里声明过的 scope 必须显式并入，不能只看 token 回显。
      let requestedScope: string | undefined = input.oauthConfig.scope;
      if (input.trigger.requiredScope) {
        const currentPair = await loadCredentialPair(credentialStore, keyPrefix);
        requestedScope = computeScopeUnion(
          input.oauthConfig.scope,
          currentPair?.tokens?.scope,
          input.trigger.requiredScope,
        );
      }
      return await runMcpInteractiveAuthorization({
        adapterInstanceId: this.adapterInstanceId,
        config: input.oauthConfig,
        credentialStore,
        fetchFn: createMcpTransportFetch({ env: this.env, network: this.network }),
        // 403 step-up：requiredScope 是当前 token scope 的严格超集时 refresh 无法扩权
        // （RFC 6749 §6），必须强制重新授权，否则新 scope 会被静默丢弃并再次 403。
        ...(input.trigger.reason === "insufficient_scope" ? { forceReauthorization: true } : {}),
        keyPrefix,
        logger: this.logger,
        ...(oauthOptions?.onAuthorizationRequired
          ? { onAuthorizationRequired: oauthOptions.onAuthorizationRequired }
          : {}),
        ...(oauthOptions?.openAuthorizationUrl
          ? { openAuthorizationUrl: oauthOptions.openAuthorizationUrl }
          : {}),
        ...(requestedScope ? { requestedScope } : {}),
        ...(input.trigger.resourceMetadataUrl
          ? { resourceMetadataUrl: new URL(input.trigger.resourceMetadataUrl) }
          : {}),
        serverName: input.name,
        serverUrl: input.serverUrl,
        signal: input.signal,
        transactionTtlMs: MCP_OAUTH_AUTHORIZATION_TRANSACTION_TTL_MS,
      });
    } catch (error) {
      // 本方法的返回类型已经把编排失败建模为 outcome。过去 credential load、
      // authz lease 或 follower callback 的异常会裸 reject，绕过 failConnection，留下
      // status=connecting + rejected record.connecting，并让 connectConfiguredServers 整批失败。
      this.logger?.warn("MCP OAuth authorization orchestration failed", {
        error: error instanceof Error ? error.message : String(error),
        errorName: error instanceof Error ? error.name : "unknown",
        event: "mcp.oauth.authorization.orchestration_failed",
        mcpServerName: input.name,
        status: "failed",
      });
      return { status: "failed", error };
    }
  }

  private async failConnection(input: {
    client?: McpClient;
    config: McpServerConfig;
    connectDurationMs?: number;
    error: unknown;
    failureKind?: McpServerFailureKind;
    generation: number;
    getRecentStderr?: () => string | undefined;
    listToolsDurationMs?: number;
    name: string;
    startedAt: number;
    transport?: McpTransport;
  }): Promise<McpServerStatus> {
    const {
      client,
      config,
      connectDurationMs,
      error,
      failureKind: fallbackFailureKind,
      generation,
      getRecentStderr,
      listToolsDurationMs,
      name,
      startedAt,
      transport,
    } = input;
    const message = error instanceof Error ? error.message : String(error);
    // 官方 MCP 鉴权失败的稳定分类必须落进日志：failConnection 原先只记
    // error.message，而多数分类并不出现在 message 文本里（只有 auth-port 那条带上了），
    // 导致 official_mcp_origin_untrusted / official_auth_rejected 等在生产日志里 grep 不到。
    const officialAuthKind =
      (error instanceof OfficialMcpAuthError ? error.kind : undefined) ??
      this.lastOfficialAuthKind.get(name);
    this.lastOfficialAuthKind.delete(name);
    const responseDiagnostic = this.connectionDiagnosticByServer.get(name);
    this.connectionDiagnosticByServer.delete(name);
    const failureKind =
      (officialAuthKind === "official_mcp_origin_untrusted"
        ? "official_origin_untrusted"
        : undefined) ??
      responseDiagnostic?.failureKind ??
      // 修复原因：授权事务到期时 withTimeout 抛 McpTimeoutError，修复前这里先判为 connection_timeout，
      // 覆盖调用方传入的 oauth_authorization_failed：目录被清空，授权失败后的重连入口也不会触发。
      (error instanceof McpTimeoutError &&
      fallbackFailureKind !== "tool_list_failed" &&
      fallbackFailureKind !== "oauth_authorization_failed"
        ? "connection_timeout"
        : undefined) ??
      fallbackFailureKind ??
      "connection_failed";
    const displayMessage = responseDiagnostic?.serverRequestId
      ? `${message} - ${responseDiagnostic.serverRequestId}`
      : message;
    const recentStderr = getRecentStderr?.();
    // 子进程缺依赖等错误只写 stderr，SDK 通常只返回 Connection closed。
    // 把同一次连接的脱敏诊断带给设置页；只展示证据，不按错误文本改变失败分类或重试。
    const statusMessage =
      config.type === "stdio"
        ? [
            sanitizeMcpStdioStderr(displayMessage).slice(0, MCP_STDIO_ERROR_MESSAGE_MAX_CHARS),
            recentStderr,
          ]
            .filter(Boolean)
            .join("\n\n")
        : displayMessage;
    const status = this.createStatus(config, "failed", {
      error: statusMessage,
      errorCode: connectionErrorCode(error),
      failureKind,
      ...(responseDiagnostic?.serverRequestId
        ? { serverRequestId: responseDiagnostic.serverRequestId }
        : {}),
    });
    const mcpTransportPid = getStdioTransportPid(transport);
    await this.closeClientAndTransport(name, client, transport);
    if (!this.isCurrentConnection(name, generation)) {
      return this.records.get(name)?.status ?? status;
    }
    const record = this.records.get(name)!;
    record.client = undefined;
    record.transport = undefined;
    // 终态只由连接任务末尾提交一次；恢复的单次失败也不是 server 终态。
    this.logger?.warn("MCP server connection failed", {
      ...this.connectionContext,
      connectDurationMs,
      durationMs: Date.now() - startedAt,
      error: displayMessage,
      event: "mcp.server.failed",
      listToolsDurationMs,
      mcpServerName: name,
      ...(officialAuthKind ? { officialAuthKind } : {}),
      ...(mcpTransportPid != null ? { mcpTransportPid } : {}),
      status: "failed",
      ...(recentStderr ? { stderr: recentStderr } : {}),
      transport: config.type,
    });
    return status;
  }

  private async createTransport(
    config: McpServerConfig,
    serverName: string,
    generation: number,
    _oauthAuthorizationTimeoutMs?: number,
    workingDirectory?: string,
    signal?: AbortSignal,
    nodeFallback?: McpNodeFallback,
  ): Promise<{ transport: McpTransport }> {
    if (config.type === "stdio") {
      return {
        transport: new ProcessTreeStdioClientTransport({
          command: config.command,
          args: config.args ?? [],
          cwd: config.cwd
            ? resolve(workingDirectory ?? this.workingDirectory ?? process.cwd(), config.cwd)
            : (workingDirectory ?? this.workingDirectory),
          // fallback 在 server env 之后合并：插件自带 PATH 时 shim 目录仍追加在末尾。
          env: applyMcpNodeFallbackEnv(
            {
              ...buildMcpStdioEnv({ env: this.env, network: this.network }),
              ...config.env,
            },
            nodeFallback,
          ),
          stderr: "pipe",
          ...(isOfficialAuthConfig(config) && config.official
            ? {
                requestMetaProvider: async () => {
                  const authMeta = await this.resolveOfficialStdioAuthMeta(
                    serverName,
                    config,
                    signal,
                  );
                  return authMeta ? { [OFFICIAL_MCP_AUTH_META_KEY]: authMeta } : undefined;
                },
              }
            : {}),
        }),
      };
    }

    // 服务端停掉时 HTTP/SSE 不派发 onclose；连续网络失败由同一失效入口进入恢复。
    const onNetworkFailures = () => {
      const client = this.records.get(serverName)?.client;
      if (client) this.invalidateConnection(serverName, generation, client);
    };
    const fetch = countNetworkFailures(
      createMcpTransportFetch({
        env: this.env,
        network: this.network,
      }),
      onNetworkFailures,
    );
    if (config.type === "http") {
      const officialAuthFetch = this.createOfficialAuthFetch(config, serverName, generation);
      return {
        transport: new StreamableHTTPClientTransport(new URL(config.url), {
          // 官方鉴权路径下 authProvider 必为 undefined：不落 OAuth 凭据、
          // 不起 localhost 回调 server、401/403 不转授权流程。
          authProvider: this.createOAuthClientProvider(serverName, config),
          fetch: officialAuthFetch
            ? countNetworkFailures(officialAuthFetch, onNetworkFailures)
            : fetch,
          requestInit: config.headers ? { headers: config.headers } : undefined,
          // GET 事件流中断不代表 MCP session 失效；SDK 只恢复该流，保留并行 POST。
        }),
      };
    }

    return {
      transport: new SSEClientTransport(new URL(config.url), {
        authProvider: this.createOAuthClientProvider(serverName, config),
        fetch,
        requestInit: config.headers ? { headers: config.headers } : undefined,
      }),
    };
  }

  /**
   * 官方鉴权 MCP 的动态 fetch。返回 undefined 表示走普通 MCP 路径。
   *
   * trusted origin 依赖缺失时直接 fail closed。auth port 可以缺失：wrapper 仍校验 origin，
   * 各请求匿名降级并由服务端做权威判定。
   */
  private createOfficialAuthFetch(
    config: McpServerConfig,
    serverName: string,
    generation: number,
  ): typeof globalThis.fetch | undefined {
    if (!isOfficialAuthConfig(config) || config.type !== "http" || !config.official) {
      return undefined;
    }
    const official = config.official;
    const authHeadersPort = this.officialMcpAuth?.authHeadersPort;
    const trustedOrigins = this.officialMcpAuth?.trustedOrigins;
    if (!trustedOrigins) {
      return (() => {
        throw new OfficialMcpAuthError(
          "official_auth_unavailable",
          `official MCP trusted origin registry is not available in this runtime: ${serverName}`,
        );
      }) as unknown as typeof globalThis.fetch;
    }
    return createOfficialMcpAuthFetch({
      baseFetch: createMcpTransportFetch({ env: this.env, network: this.network }),
      official,
      onAuthFailure: (kind) => this.lastOfficialAuthKind.set(serverName, kind),
      onServerResponse: (response) => {
        if (this.isCurrentConnection(serverName, generation)) {
          this.rememberServerResponse(serverName, response);
        }
      },
      serverName,
      trustedOrigins,
      url: config.url,
      ...(authHeadersPort ? { authHeadersPort } : {}),
      ...(this.logger ? { logger: this.logger } : {}),
      ...(this.officialMcpAuth?.workspaceIdentity
        ? { workspaceIdentity: this.officialMcpAuth.workspaceIdentity }
        : {}),
      ...(this.workingDirectory ? { workspacePath: this.workingDirectory } : {}),
      ...(this.workspaceKey ? { workspaceKey: this.workspaceKey } : {}),
    });
  }

  /**
   * 运行期 auth provider。
   *
   * 过去这里对任何没有 Authorization header 的 HTTP/SSE MCP
   * 都创建一个完整 OAuth session——而 session 在返回前就 `listen(0)` 起了一个 callback server，
   * 即使凭据完全有效、根本不需要授权。同时完整 `OAuthClientProvider` 会让 401 走 SDK 的
   * `auth()`，绕过我们的 refresh 单飞锁。
   *
   * 现在 authorization_code 一律使用纯 AuthProvider：被动连接零 listener、零 discovery、零 DCR，
   * 交互授权只在 Phase 2 事务里发生。
   */
  private createOAuthClientProvider(
    serverName: string,
    config: McpServerConfig,
  ): AuthProvider | OAuthClientProvider | undefined {
    if (config.type === "stdio") return undefined;
    // 官方鉴权与 OAuth 互斥：官方 MCP 的失败只能由 ZCode 登录/套餐解决，
    // 交出任何 authProvider 都会让 401 误转成 MCP 授权流程。
    if (isOfficialAuthConfig(config)) return undefined;
    const authorizationCodeOAuthConfig = resolveAuthorizationCodeOAuthConfig(config);
    if (authorizationCodeOAuthConfig) {
      return createMcpOAuthTokenProvider({
        config: authorizationCodeOAuthConfig,
        credentialStore: this.resolveCredentialStore(),
        fetchFn: createMcpTransportFetch({ env: this.env, network: this.network }),
        keyPrefix: createCredentialKeyPrefix(serverName, config.url, authorizationCodeOAuthConfig),
        ...(this.logger ? { logger: this.logger } : {}),
        serverName,
        serverUrl: config.url,
      });
    }
    if (config.oauth?.type === "client_credentials") {
      return new ClientCredentialsProvider({
        clientId: config.oauth.clientId,
        clientName: config.oauth.clientName ?? `${this.clientName}-${serverName}`,
        clientSecret: config.oauth.clientSecret,
        scope: config.oauth.scope,
      });
    }
    return undefined;
  }

  private resolveCredentialStore(): SharedZCodeCredentialStore {
    this.credentialStore ??= this.mcpOAuth?.credentialStore ?? createSharedZCodeCredentialStore();
    return this.credentialStore;
  }

  private createAuthorizationCodeOAuthOptions(
    config: McpServerConfig,
    serverName: string,
    generation: number,
    oauthAuthorizationTimeoutMs?: number,
  ): McpOAuthRuntimeOptions | undefined {
    if (config.type === "stdio") return this.mcpOAuth;
    return {
      ...this.mcpOAuth,
      authorizationTimeoutMs: oauthAuthorizationTimeoutMs ?? this.mcpOAuth?.authorizationTimeoutMs,
      onAuthorizationRequired: async (context) => {
        this.updateCurrentRecordStatus(serverName, generation, {
          authorization: createOAuthAuthorizationStatus(context),
          status: "connecting",
        });
        // 授权 pending 是启动等待的结束边界：只结束 waiter，不取消授权或共享连接。
        if (this.isCurrentConnection(serverName, generation)) {
          for (const wake of this.authorizationWaiters.get(serverName) ?? []) wake();
        }
        await this.mcpOAuth?.onAuthorizationRequired?.(context);
      },
    };
  }

  private attachStdioLogging(name: string, transport: McpTransport): () => string | undefined {
    const stderrBuffer = createBoundedTextBuffer(MCP_STDIO_STDERR_LOG_MAX_CHARS);
    const stderr = (
      transport as {
        stderr?: { on(event: "data", handler: (chunk: Buffer) => void): void };
      }
    ).stderr;
    stderr?.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderrBuffer.append(text);
      this.logger?.debug("MCP stdio stderr", {
        event: "mcp.stdio.stderr",
        mcpServerName: name,
        stderr: sanitizeMcpStdioStderr(text).slice(0, MCP_STDIO_STDERR_LOG_MAX_CHARS),
      });
    });
    return () => {
      const text = stderrBuffer.read();
      if (!text) return undefined;
      // 生产日志里单独的 Connection closed 无法定位 stdio MCP 子进程退出原因。
      // 只在失败事件附带尾部 stderr，并先脱敏，避免把凭据或高频输出写入生产日志。
      return sanitizeMcpStdioStderr(text).slice(-MCP_STDIO_STDERR_LOG_MAX_CHARS);
    };
  }

  private async closeRecord(
    name: string,
    record: McpServerRecord | undefined = this.records.get(name),
  ): Promise<void> {
    if (!record) return;
    record.abortController?.abort(new Error(`MCP server ${name} connection closed`));
    if (!record.client && !record.transport) return;
    await this.closeClientAndTransport(name, record.client, record.transport);
  }

  private async closeClientAndTransport(
    name: string,
    client?: McpClient,
    transport?: McpTransport,
  ): Promise<void> {
    const startedAt = Date.now();
    const mcpTransportPid = getStdioTransportPid(transport);
    // 主动关闭前先摘掉 connection_lost 监听，避免正常回收被误报为意外断连。
    if (client) client.onclose = undefined;
    // MCP SDK close 只保证直接 stdio 子进程退出，npx/npm wrapper 拉起的 MCP server
    // 或 chrome-devtools-mcp watchdog 可能残留；这里先按进程树显式回收，再走 SDK close 清理协议状态。
    await this.terminateStdioProcessTree(name, transport);

    try {
      await client?.close();
    } catch (error) {
      this.logger?.debug("MCP client close failed", {
        error: error instanceof Error ? error.message : String(error),
        event: "mcp.client.close.failed",
        mcpServerName: name,
      });
    }

    try {
      await transport?.close();
    } catch (error) {
      this.logger?.debug("MCP transport close failed", {
        error: error instanceof Error ? error.message : String(error),
        event: "mcp.transport.close.failed",
        mcpServerName: name,
      });
    }
    if (
      this.connectionContext &&
      transport instanceof ProcessTreeStdioClientTransport &&
      !transport.processAlive
    ) {
      this.telemetry?.recordProcessClosed({
        connectionId: this.connectionContext.mcpConnectionId,
      });
    }
    this.logger?.info("MCP server closed", {
      ...this.connectionContext,
      durationMs: Date.now() - startedAt,
      event: "mcp.server.closed",
      mcpServerName: name,
      ...(mcpTransportPid != null ? { mcpTransportPid } : {}),
      status: "completed",
    });
  }

  private async terminateStdioProcessTree(name: string, transport?: McpTransport): Promise<void> {
    const pid = getStdioTransportPid(transport);
    if (pid == null) return;

    try {
      await terminateMcpStdioProcessTree(pid);
    } catch (error) {
      this.logger?.warn("MCP stdio process tree cleanup failed", {
        ...this.connectionContext,
        error: error instanceof Error ? error.message : String(error),
        event: "mcp.stdio.process_tree_cleanup.failed",
        mcpServerName: name,
        mcpTransportPid: pid,
        pid,
        status: "failed",
      });
    }
  }

  private readonly appConnectionListeners = new Map<string, Set<() => void>>();
  onAppConnectionInvalidated(name: string, listener: () => void): () => void {
    const listeners = this.appConnectionListeners.get(name) ?? new Set();
    listeners.add(listener);
    this.appConnectionListeners.set(name, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.appConnectionListeners.delete(name);
    };
  }
  async waitForAppConnection(
    name: string,
  ): Promise<{ identity: string; generation: number } | null> {
    const record = this.records.get(name);
    if (!record) return null;
    const generation = this.connectionGenerations.get(name) ?? 0;
    // 会话恢复先于 MCP 握手完成；复用已有连接任务，避免首次打开把 connecting 误判为失败。
    await record.connecting;
    return this.isCurrentConnection(name, generation) ? this.appConnectionSnapshot(name) : null;
  }

  appConnectionSnapshot(name: string): { identity: string; generation: number } | null {
    const record = this.records.get(name);
    if (!record?.client || record.status.status !== "connected") return null;
    // 只向宿主输出摘要；配置中的凭据不进入协议或日志。配置身份与连接复用使用同一个 key。
    return {
      identity: createHash("sha256")
        .update(
          JSON.stringify([
            process.platform,
            process.execPath,
            this.workingDirectory ?? "",
            name,
            mcpConfigKey(record.config),
          ]),
        )
        .digest("hex"),
      generation: this.connectionGenerations.get(name) ?? 0,
    };
  }

  private nextConnectionGeneration(name: string): number {
    const generation = (this.connectionGenerations.get(name) ?? 0) + 1;
    this.connectionGenerations.set(name, generation);
    // eslint-disable-next-line unicorn/no-useless-spread -- 回调可能增删监听器，本次通知必须固定接收者。
    for (const listener of [...(this.appConnectionListeners.get(name) ?? [])]) listener();
    return generation;
  }

  private isCurrentConnection(name: string, generation: number): boolean {
    return this.connectionGenerations.get(name) === generation;
  }

  /** discovery 与目录刷新共用提交：先验证来源，再一次写入状态、目录和任务槽，最后通知。 */
  private commitConnected(
    name: string,
    record: McpServerRecord,
    client: McpClient,
    tools: McpToolDescriptor[],
    status: McpServerStatus,
  ): boolean {
    if (
      this.records.get(name) !== record ||
      record.client !== client ||
      record.abortController?.signal.aborted ||
      status.status !== "connected"
    )
      return false;
    record.status = { ...status, toolCount: tools.length };
    record.tools = tools;
    record.toolsVersion = ++this.toolsVersionCounter;
    record.connecting = undefined;
    this.notifySnapshot();
    return true;
  }

  /** 终态与目录一次写入；迟到任务只能结束自己的记录。 */
  private commitUnavailable(name: string, record: McpServerRecord, status: McpServerStatus): void {
    if (this.records.get(name) !== record) return;
    record.status = status;
    // 修复原因：授权未完成就结束、内建 server 超过重启上限时，修复前清空目录，工具离开模型视图，
    // 执行准入的重连没有入口。这两种保留目录，下一次执行准入重连；其他失败仍清空。
    if (!retainsCatalog(record.config, status)) {
      record.tools = [];
      record.toolsVersion = undefined;
    }
    record.connecting = undefined;
    this.notifySnapshot();
  }

  private updateCurrentRecord(
    name: string,
    generation: number,
    patch: Partial<Pick<McpServerRecord, "client" | "transport">>,
  ): void {
    if (!this.isCurrentConnection(name, generation)) return;
    const record = this.records.get(name);
    if (!record) return;
    Object.assign(record, patch);
  }

  private updateCurrentRecordStatus(
    name: string,
    generation: number,
    patch: Partial<McpServerStatus>,
  ): void {
    if (!this.isCurrentConnection(name, generation)) return;
    const record = this.records.get(name);
    if (!record) return;
    record.status = {
      ...record.status,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.notifySnapshot();
  }

  private createStatus(
    config: McpServerConfig,
    status: McpServerStatus["status"],
    extra: {
      authorization?: McpServerStatus["authorization"];
      error?: string;
      errorCode?: string;
      failureKind?: McpServerStatus["failureKind"];
      protocolEra?: McpServerStatus["protocolEra"];
      serverRequestId?: string;
      toolCount?: number;
    } = {},
  ): McpServerStatus {
    return {
      status,
      transport: config.type,
      toolCount: extra.toolCount ?? 0,
      updatedAt: new Date().toISOString(),
      authorization: extra.authorization,
      error: extra.error,
      errorCode: extra.errorCode,
      failureKind: extra.failureKind,
      protocolEra: extra.protocolEra,
      serverRequestId: extra.serverRequestId,
    };
  }
}

/**
 * 不可用但保留目录的记录：授权未完成就结束，或来源 builtin 的 server 超过自动重启上限。
 * 工具留在会话视图里，下一次执行准入重连；其他失败清空目录。
 */
function retainsCatalog(config: McpServerConfig, status: McpServerStatus): boolean {
  return (
    status.failureKind === "oauth_authorization_failed" ||
    (status.failureKind === "unexpected_disconnect" && config.source?.kind === "builtin")
  );
}

function connectionErrorCode(error: unknown): string | undefined {
  if (error instanceof McpTimeoutError) return "CONNECT_TIMEOUT";
  if (!error || typeof error !== "object") return undefined;
  // 内部分组名不是端点错误码；只读取结构化诊断，不从错误文案猜测。
  const diagnostic = error as { status?: unknown; code?: unknown; cause?: { code?: unknown } };
  const code = diagnostic.status ?? diagnostic.code ?? diagnostic.cause?.code;
  return typeof code === "string" || typeof code === "number" ? String(code) : undefined;
}

function mcpRequestMeta(request: McpCallToolRequest): Record<string, unknown> {
  // nodeRepl.requestMeta 暴露。ZCode 所有 MCP server 都可忽略这些扩展键；node_repl browser
  // bridge 则以它们作为回到当前 BrowserControlPort session 的唯一关联依据。runtime_scope
  // 不能从 child session id 猜测，必须由实际执行工具的 runtime 显式透传。
  const requestContext = {
    ...(request.trace ? { trace_id: request.trace.traceId } : {}),
    ...(request.trace?.spanId ? { span_id: request.trace.spanId } : {}),
    ...(request.trace?.parentSpanId ? { parent_span_id: request.trace.parentSpanId } : {}),
    ...(request.trace?.sessionId ? { session_id: request.trace.sessionId } : {}),
    // subagent / 工作流子代理的调用带上派生它的顶层 session，工作区共享的 server 据此
    // 让子代理与父 session 共用状态（文档插件查看面板 spec §8.2）。
    ...(request.trace?.rootSessionId ? { root_session_id: request.trace.rootSessionId } : {}),
    ...(request.trace?.turnId ? { turn_id: request.trace.turnId } : {}),
    ...(request.runtimeScope ? { runtime_scope: request.runtimeScope } : {}),
    ...(request.workspacePath ? { workspace_path: request.workspacePath } : {}),
    ...(request.workspaceIdentity ? { workspace_identity: request.workspaceIdentity } : {}),
    ...(request.workspaceKey ? { workspace_key: request.workspaceKey } : {}),
    ...(request.remoteSessionId ? { remote_session_id: request.remoteSessionId } : {}),
    ...(request.clientMode ? { client_mode: request.clientMode } : {}),
    ...(request.deliveryKind ? { delivery_kind: request.deliveryKind } : {}),
    ...(request.turnId && !request.trace?.turnId ? { turn_id: request.turnId } : {}),
  };
  return {
    ...requestContext,
    "com.zcode/request-context": requestContext,
  };
}

function resolveVersionNegotiationMode(config: McpServerConfig): VersionNegotiationMode {
  if (config.protocolVersion === "2026-07-28") return { pin: "2026-07-28" };
  // deprecated SSE transport 本身只承载 legacy era；显式 modern pin 仍应失败而不能静默降级。
  if (config.type === "sse") return "legacy";
  if (config.protocolVersion === "legacy") return "legacy";
  return "auto";
}

/**
 * SDK 版本协商（auto/pin 的 server/discover probe）失败的稳定识别。
 *
 * 结构化判定，禁止匹配错误文本：
 * - `SdkError(SdkErrorCode.EraNegotiationFailed)`：probe 硬失败（含非标 legacy server 的
 *   malformed 200 响应，经 transport 层 Zod 校验失败 + normalizeReply 落入 network-error 分支）；
 * - `UnsupportedProtocolVersionError`：recognized modern error，pin 版本不被 server 接受。
 */
function isProtocolNegotiationFailure(error: unknown): boolean {
  if (SdkError.isInstance(error) && error.code === SdkErrorCode.EraNegotiationFailed) {
    return true;
  }
  if (UnsupportedProtocolVersionError.isInstance(error)) return true;
  const cause = (error as { cause?: unknown } | undefined)?.cause;
  if (cause !== undefined && cause !== error) {
    return isProtocolNegotiationFailure(cause);
  }
  return false;
}

function formatVersionNegotiationMode(config: McpServerConfig): string {
  const mode = resolveVersionNegotiationMode(config);
  return typeof mode === "object" ? mode.pin : mode;
}

function resolveVersionNegotiation(
  config: McpServerConfig,
  timeoutMs: number,
): VersionNegotiationOptions {
  const mode = resolveVersionNegotiationMode(config);
  if (mode === "legacy") return { mode };

  // pin 没有 legacy fallback，probe 就是唯一 initialize 路径；沿用 auto 的 5 秒
  // 保护上限会无视 server 的长连接预算，把冷启动正常但超过 5 秒的 node_repl 静默移出工具池。
  const probeTimeoutMs =
    typeof mode === "object"
      ? Math.max(1, Math.floor(timeoutMs))
      : Math.min(MAX_MCP_VERSION_PROBE_TIMEOUT_MS, Math.max(1, Math.floor(timeoutMs / 2)));

  return {
    mode,
    probe: {
      // 原因：SDK 的 stdio auto/pin 会先启动 disposable sibling；若沿用 SDK 60s 默认值，
      // ZCode 的总连接超时可能先结束并让 probe 残留，也不给 legacy initialize 留预算。
      timeoutMs: probeTimeoutMs,
    },
  };
}

function createOAuthAuthorizationStatus(
  context: McpOAuthAuthorizationContext,
): NonNullable<McpServerStatus["authorization"]> {
  return {
    type: "oauth_authorization_code",
    authorizationUrl: context.authorizationUrl,
    startedAt: new Date().toISOString(),
  };
}

function resolveAuthorizationCodeOAuthConfig(
  config: McpServerConfig,
): AuthorizationCodeOAuthConfig | undefined {
  if (config.type === "stdio") return undefined;
  // 官方鉴权与 MCP OAuth 互斥。必须位于所有既有分支之前：
  // 官方 MCP 既不写 oauth 字段、又禁止静态 authorization 头，若不在此短路就会落进
  // 下面的 authorization_code 兜底，导致 401 时弹出 MCP 授权 UI —— 而官方鉴权失败
  // 只能由 ZCode 自身的登录/套餐解决，不可能由目标 MCP 的 OAuth 授权解决。
  if (isOfficialAuthConfig(config)) return undefined;
  if (config.oauth?.type === "authorization_code") return config.oauth;
  if (config.oauth?.type === "client_credentials") return undefined;
  if (hasAuthorizationHeader(config.headers)) return undefined;

  // 新建 HTTP/SSE MCP 常只保存 URL；OAuth 支持应由服务端
  // WWW-Authenticate / discovery 触发，不能要求配置里预先写 oauth 字段。
  return {
    type: "authorization_code",
  };
}

/**
 * auth.type/provider 精确命中且 provenance 存在时为真；provenance 缺失说明不是 Plugin loader
 * 产出的配置。
 *
 * 覆盖 http 与 stdio 两种形态——两者的凭证投递通道不同，但"是否官方鉴权"
 * 的判定同源。调用方若只关心某一形态，需自行再判 `config.type`（如 createOfficialAuthFetch
 * 只处理 http、_meta 注入只处理 stdio）。
 */
function isOfficialAuthConfig(config: McpServerConfig): boolean {
  return (
    (config.type === "http" || config.type === "stdio") &&
    config.auth?.type === "zcode_official" &&
    config.auth.provider === "jwt_token" &&
    config.official !== undefined
  );
}

function hasAuthorizationHeader(headers: Record<string, string> | undefined): boolean {
  if (!headers) return false;
  return Object.keys(headers).some((name) => name.toLowerCase() === "authorization");
}

function createBoundedTextBuffer(maxChars: number): {
  append(text: string): void;
  read(): string;
} {
  let value = "";
  let truncated = false;
  return {
    append(text: string) {
      if (!text) return;
      value = `${value}${text}`;
      if (value.length > maxChars) {
        value = value.slice(-maxChars);
        truncated = true;
      }
    },
    read() {
      // 尾部截断可能把 VE_SPEECH_MCP_TOKEN=... 切成 KEN=...，键名正则匹配不到会泄露值。
      // 截断后丢弃第一行残片，保证脱敏看到的每一行都完整。
      // 行边界含 \r（进度条只用 \r 刷新）。尾部完全没有换行时（单个超长行），
      // 空白/分隔符可能位于带引号的凭证值内部（KEN="a b" 的 b），从那里恢复会丢失键名和引号上下文而泄露后缀，
      // 没有可靠的字段边界就不输出，只保留传输错误。
      if (!truncated) return value;
      const lineEnd = value.search(/[\r\n]/);
      return lineEnd < 0 ? "" : value.slice(lineEnd + 1);
    },
  };
}

function sanitizeMcpStdioStderr(text: string): string {
  text = stripVTControlCharacters(text);
  // 插件常给敏感环境变量加前缀，例如 API_TOKEN、VE_SPEECH_MCP_TOKEN，不能只匹配裸 token。
  const sensitiveKey = String.raw`(?:[a-z0-9_.-]*[_-])?(?:api[_-]?key|access[_-]?key|secret(?:[_-]?key)?|private[_-]?key|token|password|passwd|pass|mysql_pass|mysql_password)`;
  let result = text.replace(/(bearer\s+)[^\s"']+/gi, "$1[Redacted]");
  result = result.replace(
    /(\bauthorization\b\s*[:=]\s*)(bearer\s+)?[^\r\n]+/gi,
    (_match, prefix: string, bearer: string | undefined) =>
      `${prefix}${bearer ? "Bearer " : ""}[Redacted]`,
  );
  result = result.replace(new RegExp(`([?&]${sensitiveKey}=)[^&\\s]+`, "gi"), "$1[Redacted]");
  // 引号中的凭证可能包含空格或转义引号，必须整体替换，不能只遮住第一个词。
  const quotedValue = String.raw`(["'])(?:\\.|(?!\2)[^\\\r\n])*\2`;
  result = result.replace(
    new RegExp(String.raw`(["']${sensitiveKey}["']\s*:\s*)${quotedValue}`, "gi"),
    "$1$2[Redacted]$2",
  );
  result = result.replace(
    new RegExp(String.raw`(\b${sensitiveKey}\b\s*[:=]\s*)${quotedValue}`, "gi"),
    "$1$2[Redacted]$2",
  );
  result = result.replace(
    new RegExp(`(\\b${sensitiveKey}\\b\\s*[:=]\\s*)(["']?)[^\\s"',;)}]+`, "gi"),
    "$1$2[Redacted]",
  );
  return result.replace(/([a-z][a-z0-9+.-]*:\/\/)[^:\s/@]+:[^@\s/]+@/gi, "$1[Redacted]@");
}

function getStdioTransportPid(transport?: McpTransport): number | undefined {
  if (!(transport instanceof StdioClientTransport)) return undefined;
  const pid = transport.pid;
  return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function getStdioTransportExitInfo(transport?: McpTransport):
  | {
      exitCode: number | null;
      signal: NodeJS.Signals | null;
    }
  | undefined {
  return transport instanceof ProcessTreeStdioClientTransport ? transport.processExit : undefined;
}

function isStdioTransportProcessAlive(transport?: McpTransport): boolean {
  return transport instanceof ProcessTreeStdioClientTransport && transport.processAlive;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// server 回了 JSON-RPC 错误响应（数字 code）说明请求走通了、连接是活的；
// SDK 本地错误（SdkError，字符串 code：REQUEST_TIMEOUT / CONNECTION_CLOSED / NOT_CONNECTED
// / SEND_FAILED）才代表 transport 已断。code 类型判断兜底 instanceof 在多份 SDK 实例下失效的情况。
function isPeerAnsweredError(error: unknown): boolean {
  if (error instanceof ProtocolError) return true;
  return isRecord(error) && typeof error.code === "number";
}

export {
  createDynamicMcpConfigSource,
  createMcpConfigSourceRegistry,
  type McpConfigSourceRegistry,
  type McpConfigurationSourceOptions,
} from "./config-source.js";

/** 重连与目录刷新共用可取消退避；只控制重试频率，不承担状态同步。 */
function waitForMcpRetry(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
