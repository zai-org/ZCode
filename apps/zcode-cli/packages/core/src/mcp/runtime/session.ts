import type {
  Logger,
  McpConfigurationSnapshot,
  McpConfigurationSource,
  McpConnectionSnapshot,
  McpConnectOptions,
  McpPort,
  McpServerToolSnapshot,
  McpServerStatus,
  McpToolCatalogPort,
  McpToolCatalogPublication,
  McpToolDefinition,
} from "@zcode/contracts";
import { mcpConfigKey } from "@zcode/contracts";
import { toMcpToolName } from "../name.js";
import type { McpToolResolution } from "../index.js";

type Configuration = Partial<McpConfigurationSnapshot>;
export interface McpSessionView {
  readonly configuration: Configuration;
  readonly servers: Readonly<Record<string, McpServerToolSnapshot>>;
  readonly tools: readonly McpToolDefinition[];
}

/** 执行准入等待连接的上限；server 自己声明的 timeoutMs 优先。 */
const MCP_EXECUTION_WAIT_MS = 30_000;

/**
 * 单个 server 对本会话的可用性。absent 表示没有连接记录（租约已释放或尚未启动），不报告给模型。
 * untrusted 与 official_origin_untrusted 作为连接失败报告，不撤销已交付的定义。
 */
export type McpServerClass =
  | "not_configured"
  | "disabled"
  | "absent"
  | "pending"
  | "needs_auth"
  | "failed"
  | "connected";

/**
 * 唯一的可用性判定：目录读取、状态事实、执行准入、报错文本与撤销原因都只读它。
 * 修复前来源状态、准入、原因文本和目录过滤各自判断，同一状态在不同出口的结论不一致。
 */
export function classifyServer(
  config: Configuration,
  name: string,
  status?: McpServerStatus,
): McpServerClass {
  if (
    config.enabled === false ||
    config.servers?.[name]?.enabled === false ||
    status?.status === "disabled"
  )
    return "disabled";
  if (config.servers && !Object.hasOwn(config.servers, name)) return "not_configured";
  if (!status) return "absent";
  if (status.authorization || status.failureKind === "oauth_authorization_failed")
    return "needs_auth";
  if (status.status === "connecting") return "pending";
  if (status.status === "connected") return "connected";
  return "failed";
}

/** 工具因所属 server 不可用而无法调用时给模型的原因；每种状态一条固定文本。 */
export function mcpUnavailableReason(serverClass: McpServerClass, name: string): string {
  switch (serverClass) {
    case "not_configured":
      return "No MCP server in this session provides it; continue without this tool.";
    case "disabled":
      return `Its MCP server '${name}' was disabled by the user. Continue without this tool.`;
    case "needs_auth":
      return `Its MCP server '${name}' needs the user to re-authorize it before its tools work again. Ask the user to authorize it in the ZCode MCP settings. Continue without this tool and tell the user if the task depends on it.`;
    case "pending":
      return `Its MCP server '${name}' is still connecting; try again shortly.`;
    case "connected":
      return `Its MCP server '${name}' is connected but does not offer this tool here. Continue without it.`;
    case "absent":
    case "failed":
      return `Its MCP server '${name}' has disconnected. Continue without this tool; it becomes callable again only if the server reconnects.`;
  }
}

/** 配置和 reconcile 只有一个所有者；视图按需投影，不保存第二份连接目录。 */
export function createMcpSession(options: {
  port: McpPort;
  borrowed?: boolean;
  configuration?: Configuration;
  source?: McpConfigurationSource;
  catalog?: McpToolCatalogPort;
  connectOptions: McpConnectOptions;
  logger?: Logger;
  trackStartup(promise: Promise<McpConnectionSnapshot>): Promise<McpConnectionSnapshot>;
}) {
  const { port } = options;
  const source = options.borrowed ? undefined : options.source;
  const catalog = options.borrowed ? undefined : options.catalog;
  let configuration = source?.getSnapshot() ?? options.configuration ?? {};
  let publication: McpToolCatalogPublication | undefined;
  let startup: Promise<McpConnectionSnapshot> | undefined;
  let closed = false;
  let generation = 0;
  const subscriptions: Array<() => void> = [];

  function publishCatalog(): void {
    if (!closed) publication?.publish(port.getToolSnapshot());
  }

  function read(): McpSessionView {
    const servers = port.getToolSnapshot();
    const tools = [
      ...new Set([...Object.keys(configuration.servers ?? {}), ...Object.keys(servers)]),
    ].flatMap((name): McpToolDefinition[] => {
      const row = servers[name];
      const serverClass = classifyServer(configuration, name, row?.status);
      // 连接中（含恢复与授权中）的记录，以及 adapter 保留了目录的不可用记录（授权未完成就结束、
      // 来源 builtin 的 server 超过重启上限后的意外断连）列出最后有效目录；其余不可用状态不提供工具。
      // 修复原因：这两种状态下工具离开视图会产生撤销，下一次执行也就没有入口触发重连。
      if (
        !row ||
        serverClass === "disabled" ||
        serverClass === "not_configured" ||
        (row.status.status !== "connected" &&
          row.status.status !== "connecting" &&
          serverClass !== "needs_auth" &&
          row.status.failureKind !== "unexpected_disconnect")
      )
        return [];
      return (
        row.tools ??
        // 缓存只补仍在连接的未知列表；租约释放或就绪空列表不能复活旧工具。
        (row.status.status === "connecting" ? (publication?.lookup.byServer[name] ?? []) : []).map(
          (tool) => ({ ...tool, catalogOnly: true }),
        )
      );
    });
    return { configuration, servers, tools };
  }

  function reconcile(): Promise<McpConnectionSnapshot> {
    const current = ++generation;
    const servers = configuration.enabled === false ? {} : (configuration.servers ?? {});
    publication = catalog?.prepare({ servers, ...options.connectOptions });
    const startedAt = Date.now();
    // 没有 server map 的借用端口只读已有连接；显式空 map 仍由 owner 收敛删除。
    const pending =
      options.borrowed || (configuration.servers === undefined && !source)
        ? Promise.resolve({
            statuses: Object.fromEntries(
              Object.entries(port.getToolSnapshot()).map(([name, row]) => [name, row.status]),
            ),
            tools: Object.values(port.getToolSnapshot()).flatMap((row) => row.tools ?? []),
          })
        : port.connectConfiguredServers(servers, options.connectOptions);
    // pool 在首次 await 前提交租约，通知尚未派发时也能读到 pending。
    publishCatalog();
    startup = options.trackStartup(
      pending
        .then((snapshot) => {
          if (!closed && current === generation) {
            publishCatalog();
            options.logger?.info("MCP startup completed", {
              event: "mcp.startup.completed",
              durationMs: Date.now() - startedAt,
              serverCount: Object.keys(servers).length,
              toolCount: snapshot.tools.length,
              traceId: options.connectOptions.trace?.traceId,
            });
          }
          return snapshot;
        })
        .catch((error) => {
          options.logger?.warn("MCP startup failed", {
            event: "mcp.startup.failed",
            error: String(error),
          });
          return { statuses: {}, tools: [] };
        }),
    );
    return startup;
  }

  return {
    get startup() {
      return startup;
    },
    read,
    start(): Promise<McpConnectionSnapshot> {
      if (startup) return startup;
      if (catalog && port.onSnapshotChanged)
        subscriptions.push(port.onSnapshotChanged(publishCatalog));
      if (source)
        subscriptions.push(
          source.subscribe(() => {
            if (closed) return;
            const next = source.getSnapshot();
            const previous = configuration.servers ?? {};
            const changed = Object.keys(previous).filter(
              (name) =>
                !next.enabled || mcpConfigKey(previous[name]) !== mcpConfigKey(next.servers[name]),
            );
            publication?.invalidate?.(changed);
            configuration = next;
            void reconcile();
          }),
        );
      return reconcile();
    },
    async prepare(background: boolean): Promise<void> {
      if (!background) await startup;
    },
    async resolve(descriptor: McpToolDefinition, signal?: AbortSignal): Promise<McpToolResolution> {
      const name = descriptor.serverName;
      const currentClass = () =>
        classifyServer(configuration, name, port.getToolSnapshot()[name]?.status);
      const unavailable = () => ({ unavailableReason: mcpUnavailableReason(currentClass(), name) });
      const admitted = currentClass();
      if (closed || admitted === "disabled" || admitted === "not_configured") return unavailable();
      const waited = await port.waitForServer?.(name, {
        signal,
        timeoutMs: configuration.servers?.[name]?.timeoutMs ?? MCP_EXECUTION_WAIT_MS,
        reconnect: true,
        reauthorize: true,
      });
      if (closed || waited?.timedOut) return unavailable();
      // 执行读取必须看到尚未分发通知的同步连接替换，不能用上一条事件的视图授权。
      const row = port.getToolSnapshot()[name];
      if (classifyServer(configuration, name, row?.status) !== "connected") return unavailable();
      const toolName = toMcpToolName(descriptor);
      const live = row?.tools?.find((tool) => toMcpToolName(tool) === toolName);
      if (!live) return unavailable();
      const configKey = mcpConfigKey(configuration.servers?.[name]);
      return {
        descriptor: live,
        // 模型调用晚绑定当前连接：权限或 hook 等待之后只要求配置未变、已连接且仍提供该工具；
        // 同配置重连后的新连接直接可用，不比较连接身份或完整定义。
        checkTarget: () => {
          if (closed) return mcpUnavailableReason("absent", name);
          const current = port.getToolSnapshot()[name];
          const serverClass = classifyServer(configuration, name, current?.status);
          if (serverClass !== "connected") return mcpUnavailableReason(serverClass, name);
          if (mcpConfigKey(configuration.servers?.[name]) !== configKey)
            return mcpUnavailableReason("failed", name);
          if (!current?.tools?.some((tool) => toMcpToolName(tool) === toolName))
            return mcpUnavailableReason("connected", name);
          return undefined;
        },
        authorizationReason: () =>
          !closed &&
          classifyServer(configuration, name, port.getToolSnapshot()[name]?.status) === "needs_auth"
            ? mcpUnavailableReason("needs_auth", name)
            : undefined,
      };
    },
    close(): void {
      closed = true;
      subscriptions.forEach((unsubscribe) => unsubscribe());
      source?.close();
    },
  };
}

export type McpSession = ReturnType<typeof createMcpSession>;
