import {
  getCapturedZCodeCuaBrokerCredentials,
  ZCODE_CUA_OFFICIAL_MCP_NAMESPACE_NAME,
  ZCODE_CUA_OFFICIAL_PLUGIN_ID,
  ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY,
  ZCODE_PLUGIN_ID_ENV_KEY,
} from "@zcode/shared";
import { createToolRegistry, registerMcpTools, traceContextToLogContext } from "../deps.js";
import type {
  McpConnectionSnapshot,
  McpPort,
  McpServerConfig,
  Model,
  TraceContext,
} from "../deps.js";
import type { AgentRuntimeInternal, McpServerStatusFacts } from "../internal.js";
import type { AgentRuntimeConfig } from "../types.js";
import {
  classifyServer,
  mcpUnavailableReason,
  type McpServerClass,
  type McpSession,
  type McpSessionView,
} from "../../mcp/runtime/session.js";
import { selectMcpTools, ZCODE_CUA_CANONICAL_MODEL_PREFIX } from "../../mcp/index.js";
import { isMcpToolName, MCP_TOOL_NAME_PREFIX, toModelVisibleMcpNamePart } from "../../mcp/name.js";
import type { McpServerWaitPort, ToolEntry } from "../../tool/types.js";
import { resolveToolSearchMode } from "../../tool/search/exposure.js";
import { collectToolSearchHistory } from "../../tool/search/history.js";
import { sanitizeMcpDiagnostic } from "../../tool/search/mcp-diagnostics.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import type { ToolSearchExecutionContext, WaitForMcpServersOutput } from "@zcode/contracts";
import {
  WAIT_FOR_MCP_SERVERS_TOOL_NAME,
  resolveMcpToolVisibility,
  type McpToolDefinition,
  type McpServerToolSnapshot,
  type PluginReferenceCatalog,
} from "@zcode/contracts";

/** WaitForMcpServers 等目标离开连接状态的上限。 */
const MCP_SERVER_WAIT_MS = 5_000;
/** 未注册 MCP 工具等所属 server 首次连接的预算；同一条 assistant 回复内的调用共用。 */
const MCP_PENDING_TOOL_WAIT_MS = 10_000;
/** 按回复记录已用预算的条数上限；超出时删除最早的记录。 */
const MCP_PENDING_TOOL_WAIT_RESPONSE_LIMIT = 50;

export async function refreshWorkspaceTrustAdmission(
  runtime: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<void> {
  try {
    await runtime.mcpPort?.refreshWorkspaceTrustAdmission?.();
  } catch (error) {
    // 提示发布失败不能阻断普通聊天；执行权限仍由 MCP gate 独立检查。
    runtime.logger?.warn("MCP trust admission publication failed", {
      ...traceContextToLogContext(traceContext),
      event: "mcp.trust.admission.failed",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * 只有同时携带 resolver 注入的官方 plugin id 和本进程私有 authority 的 server 才能共享
 * Computer Use 项目授权。server 名、tool 名和 manifest env 都可被第三方仿造，不能单独作为信任依据。
 */
export function computeOfficialCuaServerNames(
  servers: Record<string, McpServerConfig>,
  trustedServerNames: ReadonlySet<string>,
): Set<string> {
  const expectedAuthority = getCapturedZCodeCuaBrokerCredentials().pluginAuthority;
  const names = new Set<string>();
  if (!expectedAuthority) return names;

  for (const [name, config] of Object.entries(servers)) {
    if (!trustedServerNames.has(name)) continue;
    if (config.type !== "stdio") continue;
    if (
      config.env?.[ZCODE_PLUGIN_ID_ENV_KEY]?.trim().toLowerCase() !==
        ZCODE_CUA_OFFICIAL_PLUGIN_ID ||
      config.env?.[ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY]?.trim() !== expectedAuthority
    ) {
      continue;
    }
    names.add(name);
  }
  return names;
}

export function startMcpStartup(
  this: AgentRuntimeInternal,
  _traceContext: TraceContext,
): Promise<McpConnectionSnapshot> | undefined {
  return this.mcpSession?.start();
}

export async function initializeMcp(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
  options: { background?: boolean } = {},
): Promise<McpSessionView | undefined> {
  const session = this.mcpSession;
  const port = this.mcpPort;
  if (!session || !port) return;
  // 首输入的准入读取随首次初始化完成；修复前改为每步准备视图后漏掉了这次读取，
  // 工作区待审核提示要等第二条输入才出现。之后的读取由 turn / steering 的真实新输入触发。
  if (!this.mcpTrustAdmissionRead) {
    this.mcpTrustAdmissionRead = true;
    await refreshWorkspaceTrustAdmission(this, traceContext);
  }
  await session.prepare(options.background === true);
  if (this.shuttingDown) return;
  const view = session.read();
  this.mcpServerStatusFacts = computeMcpServerStatusFacts(view.configuration, view.servers);
  const officialCuaServerNames = computeOfficialCuaServerNames(
    view.configuration.servers ?? {},
    new Set(view.configuration.trustedOfficialCuaServerNames ?? []),
  );
  const admitted = new Set(
    [
      ...selectMcpTools(view.tools, {
        allowedTools: this.config.toolAllowlist,
        disallowedTools: this.config.toolDisallowlist,
        officialCuaServerNames,
      }),
    ].map((tool) => tool.name),
  );
  const deniedTools = [...selectMcpTools(view.tools, { officialCuaServerNames })]
    .map((tool) => tool.name)
    .filter((name) => !admitted.has(name));
  if (deniedTools.length) this.mcpServerStatusFacts.deniedTools = deniedTools;
  const signature = mcpToolsSignature(view.tools);
  if (signature === this.mcpToolsSignature) return view;
  for (const name of this.registeredMcpToolNames ?? []) this.registry.unregister(name);
  this.registeredMcpToolNames = registerMcpTools(
    this.registry,
    port,
    view.tools,
    mcpToolRegistration(this, session, officialCuaServerNames),
  );
  for (const name of this.registeredMcpToolNames) {
    const serverName = this.registry.get(name)?.metadata.mcpPresentation?.serverName;
    if (serverName) this.offeredMcpTools.set(name, serverName);
  }
  this.mcpToolsSignature = signature;
  this.invalidateToolCache();
  this.logger?.info("MCP tool snapshot applied", {
    ...traceContextToLogContext(traceContext),
    event: "mcp.tools.snapshot_applied",
    module: "core.runtime",
    registeredToolCount: this.registeredMcpToolNames.length,
    serverCount: Object.keys(view.servers).length,
    status: "completed",
  });
  return view;
}

/**
 * 按配置顺序给每个 server 分类。pool 在启动开始时同步登记 connecting 记录，
 * 所以没有记录表示租约已释放或尚未启动，不报告给模型。
 */
function computeMcpServerStatusFacts(
  mcp: AgentRuntimeConfig["mcp"],
  snapshot: Record<string, McpServerToolSnapshot>,
): McpServerStatusFacts {
  const facts: McpServerStatusFacts = { pending: [], needsAuth: [], failed: [], sources: {} };
  for (const name of new Set([...Object.keys(mcp?.servers ?? {}), ...Object.keys(snapshot)])) {
    const status = snapshot[name]?.status;
    const serverClass = classifyServer(mcp ?? {}, name, status);
    facts.sources[name] = serverClass;
    // 后台恢复仍是 pending；不能生成“下一条用户消息会重试”的失败承诺。
    if (serverClass === "pending") facts.pending.push(name);
    else if (serverClass === "needs_auth") facts.needsAuth.push(name);
    else if (serverClass === "failed" && status)
      // 比较与展示使用同一诊断事实，避免控制字符差异触发内容相同的重复公告。
      facts.failed.push({
        name: sanitizeMcpDiagnostic(name),
        ...(status.errorCode === undefined
          ? {}
          : { errorCode: sanitizeMcpDiagnostic(status.errorCode) }),
        ...(status.error === undefined ? {} : { error: sanitizeMcpDiagnostic(status.error) }),
      });
  }
  return facts;
}

/** step 注册与执行时晚到解析共用同一套准入：名称、allow/deny、官方 CUA 判定与执行时实时解析。 */
function mcpToolRegistration(
  runtime: AgentRuntimeInternal,
  session: McpSession,
  officialCuaServerNames: ReadonlySet<string>,
) {
  return {
    allowedTools: runtime.config.toolAllowlist,
    disallowedTools: runtime.config.toolDisallowlist,
    officialCuaServerNames,
    pluginIdByServerName: buildPluginIdByServerName(runtime.config.pluginReferenceCatalog),
    resolveLiveDescriptor: (descriptor: McpToolDefinition, signal?: AbortSignal) =>
      session.resolve(descriptor, signal),
  };
}

/**
 * 未注册工具报错的原因后缀。主 agent 本次请求提供了 WaitForMcpServers 且所属 server 仍在连接时，
 * 提示先等待；否则只对本会话提供过的 MCP 工具说明所属 server 的当前状态，其余名称保持原报错。
 * 修复前模型只看到 "No such tool available"，无法区分 server 断开与工具下线。
 */
export function describeUnavailableMcpTool(
  runtime: AgentRuntimeInternal,
  toolName: string,
  model?: Model,
): string {
  const view = runtime.mcpSession?.read();
  if (!view) return "";
  const connecting =
    runtime.config.taskType !== "subagent_child" && isMcpServerWaitOffered(runtime, model)
      ? findServersOfTool(view, toolName).find(
          (name) =>
            classifyServer(view.configuration, name, view.servers[name]?.status) === "pending",
        )
      : undefined;
  if (connecting)
    return `. The MCP server '${connecting}' is still connecting. Call ${WAIT_FOR_MCP_SERVERS_TOOL_NAME} to wait for it, then try again.`;
  const serverName = runtime.offeredMcpTools.get(toolName);
  if (!serverName) return "";
  return `. ${mcpUnavailableReason(
    classifyServer(view.configuration, serverName, view.servers[serverName]?.status),
    serverName,
  )}`;
}

/**
 * WaitForMcpServers 是否进入工具列表。ToolSearch 可用时由公告说明连接中的 server，不提供它；
 * 否则本 step 状态事实有 pending，或主 agent 请求已发送过它（锁存）时提供。
 * 状态事实只在普通 step 准备时刷新，所以重试、续写看到同一份列表。
 */
export function isMcpServerWaitOffered(runtime: AgentRuntimeInternal, model?: Model): boolean {
  // 工具名单（allowlist）可能没有注册它；没有注册时报错后缀也不能让模型去调用它。
  if (!runtime.registry.has(WAIT_FOR_MCP_SERVERS_TOOL_NAME)) return false;
  if (model && resolveToolSearchMode(model, runtime.config.toolSearch?.mode) !== "off")
    return false;
  return runtime.mcpServerWaitDeclared || (runtime.mcpServerStatusFacts?.pending.length ?? 0) > 0;
}

/**
 * 主 agent 的普通请求发送了 WaitForMcpServers 后锁存：server 连上后工具列表不变，缓存前缀不变。
 * 子 agent 不锁存，只按自己的 pending 判定。
 */
export function latchMcpServerWait(
  runtime: AgentRuntimeInternal,
  tools: readonly { name: string }[],
): void {
  if (runtime.config.taskType === "subagent_child") return;
  if (tools.some((tool) => tool.name === WAIT_FOR_MCP_SERVERS_TOOL_NAME))
    runtime.mcpServerWaitDeclared = true;
}

function mcpServerNames(view: McpSessionView): string[] {
  return [
    ...new Set([...Object.keys(view.configuration.servers ?? {}), ...Object.keys(view.servers)]),
  ];
}

/** 官方 CUA 工具的规范名前缀里的 server 段；连接记录名带插件命名空间。 */
const OFFICIAL_CUA_MODEL_SERVER_PART = ZCODE_CUA_CANONICAL_MODEL_PREFIX.slice(
  MCP_TOOL_NAME_PREFIX.length,
  -"__".length,
);

/** 按配置名或模型可见名匹配；官方 CUA 也认规范名里的 server 段。 */
function matchesMcpServerName(serverName: string, requested: string): boolean {
  const part = toModelVisibleMcpNamePart(requested);
  return (
    serverName === requested ||
    toModelVisibleMcpNamePart(serverName) === part ||
    (serverName === ZCODE_CUA_OFFICIAL_MCP_NAMESPACE_NAME &&
      part === OFFICIAL_CUA_MODEL_SERVER_PART)
  );
}

/** 工具名中的 server 段（模型可见名不含 "__"）对应的连接记录名。 */
function findServersOfTool(view: McpSessionView, toolName: string): string[] {
  if (!isMcpToolName(toolName)) return [];
  const part = toolName.slice(MCP_TOOL_NAME_PREFIX.length).split("__")[0];
  if (!part) return [];
  return Object.keys(view.servers).filter((name) => matchesMcpServerName(name, part));
}

/**
 * WaitForMcpServers 的端口。目标：传入名称时按名称匹配；否则取全部 pending，没有 pending 时取全部失败的
 * server。只等仍在连接的目标（≤5 s），不发起连接或授权；之后按当前分类分组。
 */
export function createMcpServerWaitPort(runtime: AgentRuntimeInternal): McpServerWaitPort {
  return {
    async waitForServers(servers, signal): Promise<WaitForMcpServersOutput> {
      const initial = runtime.mcpSession?.read();
      const classOf = (view: McpSessionView | undefined, name: string) =>
        view ? classifyServer(view.configuration, name, view.servers[name]?.status) : "absent";
      const names = initial ? mcpServerNames(initial) : [];
      const requested = servers?.length ? servers : undefined;
      const pending = names.filter((name) => classOf(initial, name) === "pending");
      const targets = requested
        ? names.filter((name) => requested.some((value) => matchesMcpServerName(name, value)))
        : pending.length
          ? pending
          : names.filter((name) => classOf(initial, name) === "failed");
      const startedAt = Date.now();
      await Promise.all(
        targets
          .filter((name) => pending.includes(name))
          .map((name) =>
            runtime.mcpPort?.waitForServer?.(name, { timeoutMs: MCP_SERVER_WAIT_MS, signal }),
          ),
      );
      const view = runtime.mcpSession?.read();
      const result: Omit<WaitForMcpServersOutput, "ready" | "isError"> = {
        connected: [],
        failed: [],
        stillPending: [],
        needsAuth: [],
        disabled: [],
        unknown: [],
      };
      const groupOf = {
        connected: result.connected,
        pending: result.stillPending,
        needs_auth: result.needsAuth,
        disabled: result.disabled,
        not_configured: result.unknown,
        // 没有连接记录的已配置 server 归入失败。
        absent: result.failed,
        failed: result.failed,
      } satisfies Record<McpServerClass, string[]>;
      for (const name of targets) groupOf[classOf(view, name)].push(name);
      for (const value of requested ?? [])
        if (!targets.some((name) => matchesMcpServerName(name, value))) result.unknown.push(value);
      const ready =
        result.stillPending.length +
          result.failed.length +
          result.needsAuth.length +
          result.disabled.length +
          result.unknown.length ===
        0;
      runtime.logger?.debug("WaitForMcpServers finished", {
        event: "mcp.server_wait.completed",
        module: "core.runtime",
        waitedMs: Date.now() - startedAt,
        ready,
        targetCount: targets.length,
        pendingCount: result.stillPending.length,
        failedCount: result.failed.length,
      });
      return { ready, ...result, isError: !ready };
    },
  };
}

/**
 * 本 step registry 没有的 MCP 工具：最新视图已提供时直接返回（server 在 step 之后连上）。所属 server 仍在
 * 首次连接（还没有目录）时等待它：同一回复内的调用共用 10 秒预算；某次等待用满完整预算仍没有工具，这次
 * 连接记为用尽，之后不再为它等待。恢复中的 server 保留目录，不等待。
 */
export async function resolveUnregisteredMcpTool(
  runtime: AgentRuntimeInternal,
  toolName: string,
  options: { signal?: AbortSignal; responseId?: string },
): Promise<ToolEntry | undefined> {
  const session = runtime.mcpSession;
  const port = runtime.mcpPort;
  if (!session || !port || !isMcpToolName(toolName)) return undefined;
  const found = createLiveMcpToolEntry(runtime, session, port, toolName);
  if (found || !port.waitForServer) return found;
  const waiting = firstConnectionServers(runtime, session.read(), toolName);
  const { responseId } = options;
  const used = responseId ? (runtime.mcpPendingToolWaitByResponse.get(responseId) ?? 0) : 0;
  const budget = MCP_PENDING_TOOL_WAIT_MS - used;
  if (!waiting.length || budget <= 0) return undefined;
  const startedAt = Date.now();
  try {
    const results = await Promise.all(
      waiting.map(([name]) =>
        port.waitForServer!(name, { timeoutMs: budget, signal: options.signal }),
      ),
    );
    const entry = createLiveMcpToolEntry(runtime, session, port, toolName);
    // 按等待结果判断是否等满：计时器按毫秒截断，墙钟可能少 1 ms。
    if (!entry && budget === MCP_PENDING_TOOL_WAIT_MS) {
      const servers = session.read().servers;
      waiting.forEach(([name, episode], index) => {
        if (results[index]?.timedOut && servers[name]?.status.updatedAt === episode)
          runtime.mcpPendingToolWaitExhausted.set(name, episode);
      });
    }
    return entry;
  } finally {
    if (responseId) recordPendingToolWait(runtime, responseId, used + Date.now() - startedAt);
  }
}

function createLiveMcpToolEntry(
  runtime: AgentRuntimeInternal,
  session: McpSession,
  port: McpPort,
  toolName: string,
): ToolEntry | undefined {
  // 临时 registry 只用于本次查找，不替换 step 的 registry，也不改变已提供工具的记录。
  const view = session.read();
  const registry = createToolRegistry();
  registerMcpTools(
    registry,
    port,
    view.tools,
    mcpToolRegistration(
      runtime,
      session,
      computeOfficialCuaServerNames(
        view.configuration.servers ?? {},
        new Set(view.configuration.trustedOfficialCuaServerNames ?? []),
      ),
    ),
  );
  return registry.get(toolName);
}

/**
 * 仍在首次连接、尚未用尽等待的 server，附带这次连接的标识（连接状态的 updatedAt：每次开始连接时新建，
 * 连接中只在发布授权链接时更新，而那时已归类为 needs_auth）。没有目录即首次连接：恢复中的连接保留目录。
 */
function firstConnectionServers(
  runtime: AgentRuntimeInternal,
  view: McpSessionView,
  toolName: string,
): Array<[name: string, episode: string]> {
  return findServersOfTool(view, toolName).flatMap((name): Array<[string, string]> => {
    const row = view.servers[name];
    return row &&
      row.tools === undefined &&
      classifyServer(view.configuration, name, row.status) === "pending" &&
      runtime.mcpPendingToolWaitExhausted.get(name) !== row.status.updatedAt
      ? [[name, row.status.updatedAt]]
      : [];
  });
}

function recordPendingToolWait(
  runtime: AgentRuntimeInternal,
  responseId: string,
  usedMs: number,
): void {
  const waits = runtime.mcpPendingToolWaitByResponse;
  // Map 按插入顺序迭代：重新插入使本回复成为最新，超出上限时删除最早的回复。
  waits.delete(responseId);
  waits.set(responseId, usedMs);
  for (const oldest of waits.keys()) {
    if (waits.size <= MCP_PENDING_TOOL_WAIT_RESPONSE_LIMIT) break;
    waits.delete(oldest);
  }
}

/** 实时搜索只创建临时投影，不替换正在执行的批次 registry。 */
export function createLiveToolSearchContext(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  context: ToolSearchExecutionContext,
): Pick<ToolSearchExecutionContext, "readLatest" | "waitForPending"> {
  const managed = new Set(runtime.registeredMcpToolNames);
  const resident = context.catalog.filter((tool) => !managed.has(tool.name));
  const { preCompactDiscoveredTools } = collectToolSearchHistory(state.turnRequestState.entries);
  return {
    readLatest: () => {
      const view = runtime.mcpSession?.read();
      const selected = selectMcpTools(view?.tools ?? [], {
        allowedTools: runtime.config.toolAllowlist,
        disallowedTools: [
          ...(runtime.config.toolDisallowlist ?? []),
          ...(state.toolDisallowlist ?? []),
        ],
        officialCuaServerNames: computeOfficialCuaServerNames(
          view?.configuration.servers ?? {},
          new Set(view?.configuration.trustedOfficialCuaServerNames ?? []),
        ),
      });
      const catalog = [...selected]
        .filter(({ descriptor }) => resolveMcpToolVisibility(descriptor).includes("model"))
        .map(({ name, aliases, descriptor }) => ({
          name,
          aliases,
          description: descriptor.description,
          searchHint: descriptor.searchHint,
          mcp: { serverName: descriptor.serverName, toolName: descriptor.toolName },
          deferred:
            descriptor.alwaysLoad !== true &&
            !(context.mode === "local" && preCompactDiscoveredTools.has(name)),
        }))
        .sort((left, right) => left.name.localeCompare(right.name));
      const facts = computeMcpServerStatusFacts(view?.configuration, view?.servers ?? {});
      return {
        catalog: state.automationCreateLimitReached ? [] : [...resident, ...catalog],
        pending: facts.pending,
        failed: facts.failed,
      };
    },
    waitForPending: async (servers, timeoutMs, signal) => {
      await Promise.all(
        servers.map((name) => runtime.mcpPort?.waitForServer?.(name, { timeoutMs, signal })),
      );
    },
  };
}

/**
 * server 名 → 插件稳定 id。catalog 里 disabled 插件的 mcpServerNames 为空，天然不参与；
 * 同名冲突插件的 server 名互不相同（带插件名前缀），不需要额外去重。
 */
function buildPluginIdByServerName(
  catalog: PluginReferenceCatalog | undefined,
): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const plugin of catalog?.plugins ?? []) {
    for (const serverName of plugin.mcpServerNames) map.set(serverName, plugin.pluginId);
  }
  return map;
}

function mcpToolsSignature(descriptors: readonly McpToolDefinition[]): string {
  return (
    descriptors
      // 名称不变的 schema、权限注解和暴露策略变化同样必须替换定义。
      .map((tool) => JSON.stringify(tool))
      .sort()
      .join("\n")
  );
}
