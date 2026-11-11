import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  ChannelClient,
  ChannelServer,
  Emitter,
  MessagePortProtocol,
  ProxyChannel,
  type Event,
  type IDisposable,
  type MessagePortLike,
} from "@zcode/rpc";
import {
  EXTENSION_HOST_CHANNEL,
  EXTENSION_WINDOW_CHANNEL,
  applyContributionMessage,
  contributionMessageSchema,
  executeCommandInputSchema,
  decideExtensionActivationInputSchema,
  describeExtensionEnableInputSchema,
  extensionEnvSchema,
  getExtensionRecentActionsInputSchema,
  grantExtensionInputSchema,
  revokeExtensionInputSchema,
  notificationsShowResultSchema,
  setExtensionNotificationsInputSchema,
  extensionViewInputSchema,
  getExtensionLogsInputSchema,
  grantsCover,
  provideMentionItemsInputSchema,
  resolvePluginManifest,
  resolvedScopeSchema,
  viewRequestInputSchema,
  workbenchReportSchema,
  type ContributionSnapshot,
  type ExtensionDeclaration,
  type ExtensionDeclarations,
  type ExtensionGrantsSnapshot,
  type ExtensionHostStatus,
  type ExtensionLogEntry,
  type ExtensionLogsSnapshot,
  type ExtensionStaticTable,
  type ExtensionWindowToMainMessage,
  type IExtensionHostChannel,
  type MainToExtensionWindowMessage,
  type StaticPlugin,
} from "@zcode/shared/extension-host";
import type { PluginSandboxHandle, PluginSandboxRegisterInput } from "@zcode/shared/mcp-apps";
import type { IPluginManagementService } from "#src/plugins/pluginManagement.js";
import type { IModelSelectionService } from "#src/model-provider/providerFacadeServices.js";
import type { PluginMutationSucceededEvent } from "#src/plugins/pluginManagementService.js";
import type { PluginUserOptionsReader } from "#src/zcode-agent/pluginHostQueriesClient.js";
import type { IZCodeAgentService } from "#src/zcode-agent/zcodeAgent.js";
import type { AppControlServiceHandle } from "#src/app-control/contract.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import {
  createCapabilityGateway,
  createCapabilityHandlers,
  type CapabilityGrantFacts,
} from "#src/extensions/capabilityGateway.js";
import { createContextPump } from "#src/extensions/contextPump.js";
import { createExtensionDraftRelay } from "#src/extensions/draftRelay.js";
import { createEnvState } from "#src/extensions/envState.js";
import { createGenerationPump } from "#src/extensions/generationPump.js";
import { createModelsBackend } from "#src/extensions/modelsBackend.js";
import { readPluginManifest } from "#src/extensions/manifestReader.js";
import { createMentionItemsRouter } from "#src/extensions/mentionItems.js";
import { createAuditLog } from "#src/extensions/auditLog.js";
import { createGrantsStore } from "#src/extensions/grantsStore.js";
import { createGrantRequestRelay } from "#src/extensions/grantRequestRelay.js";
import { createNotificationRelay } from "#src/extensions/notificationRelay.js";
import { createPluginProjects } from "#src/extensions/pluginProjects.js";
import { createSessionsBackend } from "#src/extensions/sessionsBackend.js";
import { createSessionReads } from "#src/extensions/sessionReads.js";
import { createSessionControls } from "#src/extensions/sessionControls.js";
import type { ExtensionTaskRowsSource } from "#src/extensions/sessionListPump.js";
import { createSettingsBackend } from "#src/extensions/settingsBackend.js";
import { createExtensionViewRelay } from "#src/extensions/viewRelay.js";
import { createWorkbenchState } from "#src/extensions/workbenchState.js";
import type {
  ExtensionsContributionsMessage,
  IExtensionsService,
} from "#src/extensions/contract.js";
import type { IExtensionViewsService } from "#src/extensions/views/contract.js";
import type { IExtensionGrantsService } from "#src/extensions/grants/contract.js";
import type { IProjectService } from "#src/project/contract.js";

// Window Host 的扩展门面实现（docs/plugins/extension-host.md §3.4、§3.5、§13、§16.1）：
// - 静态表的唯一 owner：插件清单的 owner 是 CLI，读出用户级启用的插件后逐个读 plugin.json 校验，
//   整份推给 Renderer；只把合法、兼容的扩展声明推给扩展进程。启动、插件管理成功、重新加载时重读。
// - 按代际连接扩展进程（Main 牵线的 L1 端口），只持最近一份贡献表快照（运行状态与动态值）并转给 Renderer。
// - 扩展进程状态的 owner 是 Main：经 parentPort 收到后转给 Renderer。
// - 日志缓冲的 owner 也是 Main（§16.8）：追加的批次与快照回包都只转发，不留副本。
// - 能力网关：extension-window 频道的唯一服务端；后端是 Renderer 报告、两个数据泵与视图中转。

export interface WindowHostExtensionsDeps {
  /** 读插件清单（静态表、settings.*）；settings.update 经 configurePlugin 写 user 层（§18.1 H1）。 */
  pluginManagement: Pick<IPluginManagementService, "listPlugins" | "configurePlugin">;
  /**
   * 数据泵的来源：context 组成与生成速率都由 CLI 产生（§3.4）；会话读连接以它为底座建连接作用域（§17.5）。
   * 只在本进程内传递。
   */
  agent: IZCodeAgentService;
  /** Window Host 控制器的任务投影（会话列表泵，§17.5）：只在本进程内传递。缺省时列表订阅报 unavailable。 */
  taskRows?: ExtensionTaskRowsSource;
  /** 扩展视图的沙箱登记（Host → Main）。缺省时扩展视图不可用。 */
  registerSandbox?: (input: PluginSandboxRegisterInput) => Promise<PluginSandboxHandle>;
  /** 读用户级插件清单用的本地目录（与 Agent 的 fallback cwd 同源）。 */
  inventoryWorkspacePath: string;
  /**
   * 能力 settings.get 的读取器（§16.7）：Window Host 进程内，含敏感值，不在任何 RPC 频道上。
   * undefined 时按旧 CLI 处理（只有非敏感值）。
   */
  userOptionsReader: PluginUserOptionsReader | undefined;
  /**
   * 会话能力的后端（§17.2）：createLocalServices 经 onAppControlServiceCreated 交出的 facade。
   * 只在本进程内传递，不在任何 RPC 频道上。undefined 时会话能力报 unavailable。
   */
  appControl: AppControlServiceHandle | undefined;
  /** 插件项目（§17.4，P3c-2）：本机 Host 的项目服务，与侧栏「新建项目」同一条 saveProject 路径。 */
  projects: Pick<IProjectService, "readProjects" | "saveProject">;
  /** 能力 models.list 的来源（§18.1 H9）：输入框模型选择器同一份视图。缺省时报 unavailable。 */
  modelSelection?: Pick<IModelSelectionService, "getView">;
  /** 本服务的数据目录（`~/.zcode/v2/extensions`）：授权记录 grants.json 与审计目录 audit/（§17.7、§17.8）。 */
  dataDir: string;
  postToMain(message: ExtensionWindowToMainMessage): void;
}

export interface WindowHostExtensions {
  readonly service: IExtensionsService;
  /** 扩展视图门面：与 service 同一份状态（同一个视图中转），另一个频道。 */
  readonly viewsService: IExtensionViewsService;
  /** 授权门面（§17.7）：与 service 同一份状态，另一个频道；只在桌面本机 Host 注册。 */
  readonly grantsService: IExtensionGrantsService;
  /** Window Host 服务已就绪：读静态表，并请 Main 牵线。 */
  announceReady(): void;
  /** Main 的 L0 消息：pair 带一个已包装的端口。 */
  receiveControl(
    message: MainToExtensionWindowMessage,
    port?: { port: MessagePortLike; onClose(listener: () => void): void },
  ): void;
  /**
   * 插件管理操作成功（安装、卸载、启停、配置）：重读静态表并重推扩展声明；user 层的配置或重置
   * 另通知该插件的 settings.onDidChange（§16.7）。
   */
  refreshInventory(change?: PluginMutationSucceededEvent): void;
  dispose(): void;
}

interface Connection {
  gen: number;
  protocol: MessagePortProtocol;
  server: ChannelServer;
  client: ChannelClient;
  host: IExtensionHostChannel;
  subscription: IDisposable;
}

export function createWindowHostExtensions(deps: WindowHostExtensionsDeps): WindowHostExtensions {
  // 只在 Window Host（Node）里创建：Renderer 可达的模块顶层不能调用 createServiceLogger。
  const logger = createServiceLogger("extensions");
  const contributions = new Emitter<ExtensionsContributionsMessage>();
  const hostStatus = new Emitter<ExtensionHostStatus>();
  const logs = new Emitter<ExtensionLogEntry[]>();
  /** 在途的日志快照请求：Main 收到即回，按 requestId 配对；本服务销毁时一起失败，不设超时。 */
  const logRequests = new Map<
    string,
    { resolve(snapshot: ExtensionLogsSnapshot): void; reject(error: Error): void }
  >();
  let status: ExtensionHostStatus = { state: "starting", gen: 0 };
  let snapshot: ContributionSnapshot | null = null;
  let table: ExtensionStaticTable = { rev: 0, plugins: [] };
  /** 由同一次读取生成；还没读完清单时为 null，不向扩展进程推空声明。 */
  let declarations: ExtensionDeclarations | null = null;
  let connection: Connection | null = null;
  /** 重读与推送串行：牵线时的推送排在在途的重读之后，扩展进程总是收到最新一份声明。 */
  let staticChain: Promise<void> = Promise.resolve();
  let disposed = false;
  const workbench = createWorkbenchState();
  const env = createEnvState();
  const contextPump = createContextPump({ agent: deps.agent, workbench, logger });
  const generationPump = createGenerationPump({ agent: deps.agent, workbench, logger });
  const views = createExtensionViewRelay({
    connection: () => (connection ? { gen: connection.gen, host: connection.host } : null),
    staticTable: () => table,
    workbench,
    ...(deps.registerSandbox ? { registerSandbox: deps.registerSandbox } : {}),
    logger,
  });
  const settings = createSettingsBackend({
    reader: deps.userOptionsReader,
    pluginManagement: deps.pluginManagement,
    inventoryWorkspacePath: deps.inventoryWorkspacePath,
    logger,
  });
  const drafts = createExtensionDraftRelay({ logger });
  const provideMentionItems = createMentionItemsRouter({
    staticTable: () => table,
    connection: () => (connection ? { gen: connection.gen, host: connection.host } : null),
    agent: deps.agent,
    logger,
  });
  // 用户授权的唯一 owner（grants.json）与审计日志（§17.7、§17.8）。
  const grants = createGrantsStore({ filePath: join(deps.dataDir, "grants.json"), logger });
  const audit = createAuditLog({ dir: join(deps.dataDir, "audit"), logger });
  const sessions = createSessionsBackend({
    appControl: deps.appControl,
    currentGen: () => connection?.gen ?? null,
    covers: (pluginId, grant) => grants.covers(pluginId, grant),
    audit,
    logger,
  });
  // 会话读连接（§17.5）：列表泵、按会话共享的镜像与 readRows；连接作用域跟扩展进程代际走。
  const reads = createSessionReads({
    agent: deps.agent,
    sessions,
    taskRows: deps.taskRows,
    localSourceServerId: () => deps.appControl?.sourceServerId,
    currentGen: () => connection?.gen ?? null,
    // 交互订阅的范围检查（§17.12）：插件项目里的会话。controls 在下面创建，调用时已就绪。
    controlScope: (pluginId, session) => controls.assertScope(pluginId, session),
    logger,
  });
  /** 网关复查开着的需授权订阅的信号：授权状态变化、静态表重发。 */
  const grantFactsChanged = new Emitter<void>();
  const grantsSubscription = grants.onDidChange(() => grantFactsChanged.fire());
  const models = createModelsBackend({ modelSelection: deps.modelSelection, logger });
  const grantState = (pluginId: string) =>
    grants.snapshot().plugins.find((plugin) => plugin.pluginId === pluginId);
  const grantRequests = createGrantRequestRelay({ state: grantState, logger });
  const notifications = createNotificationRelay({
    staticTable: () => table,
    grantState,
    logger,
  });
  // 插件项目只经现有项目服务读写（§17.4）：名字取静态表，数据目录取扩展声明（H6），都是本服务读的同一份清单。
  const pluginProjects = createPluginProjects({
    projects: deps.projects,
    plugin(pluginId) {
      const entry = table.plugins.find((plugin) => plugin.pluginId === pluginId);
      if (!entry) return null;
      const dataPath = declarations?.plugins.find(
        (plugin) => plugin.pluginId === pluginId,
      )?.dataPath;
      return { name: entry.name, ...(dataPath ? { dataPath } : {}) };
    },
    sourceServerId: () => deps.appControl?.sourceServerId,
    logger,
  });
  // 回答审批、提问与切换权限模式（§17.12）：完全访问 = 清单声明了 sessions.fullAccess 且用户授予了。
  const controls = createSessionControls({
    agent: deps.agent,
    reads,
    sessions,
    pluginProjects,
    fullAccess(pluginId) {
      const declared = grantFacts.declared(pluginId);
      if (!declared || !grantsCover(declared.grants, "sessions.fullAccess")) return "not-declared";
      return grants.covers(pluginId, "sessions.fullAccess") ? "granted" : "not-granted";
    },
    logger,
  });
  const handlers = createCapabilityHandlers({
    workbench,
    env,
    context: contextPump,
    generation: generationPump,
    models,
    views,
    settings,
    sessions,
    pluginProjects,
    reads,
    controls,
    drafts,
    grantRequests,
    notifications,
  });
  // 网关查授权的两份事实：清单声明来自静态表（本服务是 owner），用户授权来自授权记录。
  const grantFacts: CapabilityGrantFacts = {
    declared(pluginId) {
      const extension = table.plugins.find((plugin) => plugin.pluginId === pluginId)?.extension;
      return extension?.state === "ok"
        ? { grants: extension.grants, protocols: extension.protocols }
        : null;
    },
    granted: (pluginId, grant) => grants.covers(pluginId, grant),
    onDidChange: grantFactsChanged.event,
  };

  const detach = (reason: string) => {
    const current = connection;
    if (!current) return;
    connection = null;
    // 视图实例属于这一代扩展进程：一并作废，标签页按新代际重建。
    views.detach();
    // 旧代际的会话调用（wait 最长 300 秒）一并中止：结果已经没有接收方。
    sessions.abortAll();
    // 读连接作用域与镜像属于这一代：一并释放（scope.dispose() 退订全部）。
    reads.detach();
    current.subscription.dispose();
    current.server.dispose();
    current.client.dispose();
    current.protocol.disconnect();
    logger.info(undefined, `extension host detached gen=${current.gen} (${reason})`);
    if (snapshot) {
      snapshot = null;
      contributions.fire({ kind: "detached" });
    }
  };

  /** 排进串行链；返回这一步的结果（失败照常记一条 warn，链不中断）。 */
  const enqueueStatic = (label: string, task: () => Promise<void>): Promise<void> => {
    const run = staticChain.then(task);
    staticChain = run.catch((error: unknown) => {
      logger.warn(undefined, `${label} failed`, {
        message: error instanceof Error ? error.message : String(error),
      });
    });
    return run;
  };

  /** 最近一次读到的清单：激活确认的决定改变后，不重读插件清单就能重新发布（§17.7）。 */
  let resolvedPlugins: Array<{ entry: StaticPlugin; declaration: ExtensionDeclaration | null }> =
    [];

  /**
   * 按最近一次读到的清单发布静态表与扩展声明。等待激活确认（pending）与选择不激活（declined）的插件
   * 不进扩展声明，静态表的这一项带 activation（§17.7，P3b）。
   */
  const publishStatic = (reason: string) => {
    table = {
      rev: table.rev + 1,
      plugins: resolvedPlugins.map(({ entry }) => {
        const activation = grants.activationHold(entry.pluginId);
        return activation ? { ...entry, activation } : entry;
      }),
    };
    declarations = {
      plugins: resolvedPlugins.flatMap(({ entry, declaration }) =>
        declaration && !grants.activationHold(entry.pluginId) ? [declaration] : [],
      ),
    };
    logger.info(
      undefined,
      `static table rev=${table.rev} plugins=${table.plugins.length} extensions=${declarations.plugins.length} held=${table.plugins.filter((plugin) => plugin.activation).length} items=${table.plugins.reduce((count, plugin) => count + plugin.slotItems.length, 0)} (${reason})`,
    );
    contributions.fire({ kind: "static", table });
    grantFactsChanged.fire();
  };

  /**
   * 从插件商店安装后、激活前的确认（§17.7，P3b）：安装的成功信号没有插件 id，所以按静态表判断。
   * 新出现、扩展合法且有 main 的插件，在已有别的插件持有生效会话权限时先不激活，记为 pending。
   */
  const holdNewlyInstalled = async (
    resolved: typeof resolvedPlugins,
    previousIds: ReadonlySet<string>,
  ) => {
    for (const { entry } of resolved) {
      const extension = entry.extension;
      if (previousIds.has(entry.pluginId) || extension?.state !== "ok" || !extension.main) continue;
      if (grants.activationHold(entry.pluginId)) continue;
      const holders = grants.holders(entry.pluginId);
      if (holders.length === 0) continue;
      try {
        await grants.holdActivation(entry.pluginId, entry.version);
        logger.info(
          undefined,
          `extension activation held plugin=${entry.pluginId} holders=${holders.length} (installed while other extensions hold session grants)`,
        );
      } catch (error) {
        logger.warn(undefined, `hold extension activation failed plugin=${entry.pluginId}`, {
          code: (error as { code?: unknown } | null)?.code,
        });
      }
    }
  };

  /** 读插件清单与每个插件的 plugin.json，整份替换静态表与扩展声明（§16.1）。 */
  const readStaticTable = async (reason: string, options: { installed?: boolean } = {}) => {
    // 授权记录读完再算静态表：之后推的扩展声明让扩展激活，激活时的会话调用要看到已有的授权。
    await grants.ready;
    const result = await deps.pluginManagement.listPlugins({
      workspacePath: deps.inventoryWorkspacePath,
      configScope: "user",
    });
    // 扩展只认用户级启用（§13）：工作区级启用不激活扩展代码；未物化的插件包没有可读的清单。
    const plugins = result.plugins.filter(
      (plugin) =>
        plugin.enabled &&
        plugin.enabledSource !== "workspace" &&
        plugin.packageStatus !== "missing",
    );
    const resolved = await Promise.all(
      plugins.map(async (plugin) =>
        resolvePluginManifest(
          {
            pluginId: plugin.id,
            name: plugin.name,
            ...(plugin.version ? { version: plugin.version } : {}),
            rootPath: plugin.rootPath,
            ...(plugin.dataPath ? { dataPath: plugin.dataPath } : {}),
          },
          await readPluginManifest(plugin.rootPath),
        ),
      ),
    );
    if (disposed) return;
    const previousIds = new Set(table.plugins.map((plugin) => plugin.pluginId));
    // 按新清单重算授权（插件更新：不变多不询问、变多待授权、变少收窄）；生效档位变少的插件中止在途调用。
    for (const pluginId of grants.reconcile({
      rev: table.rev,
      plugins: resolved.map(({ entry }) => entry),
    }))
      sessions.abortPlugin(pluginId);
    if (options.installed) await holdNewlyInstalled(resolved, previousIds);
    if (disposed) return;
    resolvedPlugins = resolved;
    // 清单问题按插件记一次（重读只在插件清单变化与重新加载时发生，频率低）。
    for (const { entry } of resolved) {
      const extension = entry.extension;
      if (extension && extension.state !== "ok") {
        logger.warn(
          undefined,
          `extension ${extension.state} ${entry.pluginId}: ${extension.reason}${extension.state === "invalid" ? ` (${extension.path})` : ""}`,
        );
      }
      for (const problem of entry.problems) {
        logger.warn(
          undefined,
          `manifest item unusable ${entry.pluginId} ${problem.path}: ${problem.reason}`,
        );
      }
      for (const ignored of entry.ignored) {
        logger.info(
          undefined,
          `manifest ignored ${entry.pluginId} ${ignored.path}: ${ignored.reason}`,
        );
      }
    }
    publishStatic(reason);
  };

  const pushDeclarations = async () => {
    const target = connection;
    const current = declarations;
    if (!target || !current) return;
    await target.host.setDeclarations(current);
    logger.info(
      undefined,
      `declarations pushed gen=${target.gen} extensions=${current.plugins.length}`,
    );
  };

  const refreshStatic = (reason: string, options: { installed?: boolean } = {}) =>
    enqueueStatic("refresh extension static table", async () => {
      await readStaticTable(reason, options);
      await pushDeclarations();
    });

  const attach = (gen: number, port: MessagePortLike, onClose: (listener: () => void) => void) => {
    detach(`replaced by gen=${gen}`);
    const protocol = new MessagePortProtocol(port);
    const server = new ChannelServer(protocol, "extension-window");
    server.registerChannel(
      EXTENSION_WINDOW_CHANNEL,
      ProxyChannel.fromService(createCapabilityGateway(handlers, grantFacts, logger, gen)),
    );
    const client = new ChannelClient(protocol);
    const host = ProxyChannel.toService<IExtensionHostChannel>(
      client.getChannel(EXTENSION_HOST_CHANNEL),
    );
    const subscription = host.onDynamicContributions(undefined)((raw) => {
      if (connection?.gen !== gen) return;
      const parsed = contributionMessageSchema.safeParse(raw);
      if (!parsed.success) {
        logger.warn(undefined, `dropped an invalid contribution message gen=${gen}`);
        return;
      }
      const next = applyContributionMessage(snapshot, parsed.data);
      if (!next) {
        logger.debug(undefined, `dropped a stale contribution message gen=${gen}`);
        return;
      }
      snapshot = next;
      if (parsed.data.kind === "snapshot") {
        logger.info(
          undefined,
          `contributions snapshot gen=${next.gen} rev=${next.rev} extensions=${next.extensions.length}`,
        );
      }
      contributions.fire(parsed.data);
    });
    connection = { gen, protocol, server, client, host, subscription };
    views.attach(gen, host);
    onClose(() => {
      if (connection?.protocol === protocol) detach(`port closed gen=${gen}`);
    });
    logger.info(undefined, `extension host paired gen=${gen}`);
    // 新代际收一份声明：排在在途的重读之后，推的总是最新一份；还没读完清单时由重读完成后推。
    void enqueueStatic("push extension declarations", pushDeclarations);
  };

  const service: IExtensionsService = {
    onDynamicContributions: () =>
      ((listener: (message: ExtensionsContributionsMessage) => void) => {
        listener({ kind: "static", table });
        listener(snapshot ?? { kind: "detached" });
        return contributions.event(listener);
      }) satisfies Event<ExtensionsContributionsMessage>,
    onDynamicHostStatus: () =>
      ((listener: (next: ExtensionHostStatus) => void) => {
        listener(status);
        return hostStatus.event(listener);
      }) satisfies Event<ExtensionHostStatus>,
    async executeCommand(input) {
      const parsed = executeCommandInputSchema.parse(input);
      const target = connection;
      if (!target) throw new Error("extension host is not connected");
      await target.host.executeCommand(parsed);
    },
    provideMentionItems: (input) =>
      provideMentionItems(provideMentionItemsInputSchema.parse(input)),
    async reload() {
      logger.info(undefined, "reload extensions requested");
      // 先请 Main 重启：不等清单读取，扩展进程卡死或已停止时也能马上生效。新代际牵线时的推送排在
      // 这次重读之后，拿到的是重读后的声明。
      deps.postToMain({ type: "extension-host/reload" });
      refreshStatic("reload");
    },
    async reportWorkbench(report) {
      const parsed = workbenchReportSchema.parse(report);
      workbench.report(parsed);
      // 窗格与焦点变化才报告，频率低。
      logger.info(
        undefined,
        `workbench report sessions=${parsed.sessions.length} drafts=${parsed.sessions.filter((session) => session.isDraft).length}`,
      );
    },
    async reportEnv(next) {
      const parsed = extensionEnvSchema.parse(next);
      // 只在语言变化时报告，频率低。
      logger.info(undefined, `env report locale=${parsed.locale}`);
      env.report(parsed);
    },
    getLogs(input) {
      const parsed = getExtensionLogsInputSchema.parse(input ?? {});
      if (disposed) return Promise.reject(new Error("extensions service disposed"));
      const requestId = randomUUID();
      return new Promise<ExtensionLogsSnapshot>((resolve, reject) => {
        logRequests.set(requestId, { resolve, reject });
        try {
          deps.postToMain({ type: "extension-host/logs-request", requestId, ...parsed });
        } catch (error) {
          logRequests.delete(requestId);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    onDynamicLogs: () => logs.event,
  };

  /** 授权与撤销各记一行审计（§17.8）。 */
  const auditGrantChange = (
    pluginId: string,
    capability: "grants.grant" | "grants.revoke",
    tiers: readonly string[],
  ) =>
    audit.append({
      gen: connection?.gen ?? null,
      pluginId,
      capability,
      ...(tiers.includes("sessions.fullAccess")
        ? { grant: "sessions.fullAccess" as const }
        : tiers.includes("sessions.write")
          ? { grant: "sessions.write" as const }
          : tiers.includes("sessions.read")
            ? { grant: "sessions.read" as const }
            : tiers.includes("notifications")
              ? { grant: "notifications" as const }
              : {}),
      outcome: "ok",
    });

  const revokeGrants = async (pluginId: string, reason: string) => {
    const revoked = await grants.revoke(pluginId, (tiers) =>
      auditGrantChange(pluginId, "grants.revoke", tiers),
    );
    sessions.abortPlugin(pluginId);
    if (revoked.length === 0) return;
    logger.info(
      undefined,
      `extension grants revoked plugin=${pluginId} tiers=${revoked.join(",")} (${reason})`,
    );
  };

  const grantsService: IExtensionGrantsService = {
    onDynamicGrants: () =>
      ((listener: (snapshot: ExtensionGrantsSnapshot) => void) => {
        listener(grants.snapshot());
        return grants.onDidChange(listener);
      }) satisfies Event<ExtensionGrantsSnapshot>,
    async grant(input) {
      const parsed = grantExtensionInputSchema.parse(input);
      const granted = await grants.grant(parsed.pluginId, parsed.grants, (tiers) =>
        auditGrantChange(parsed.pluginId, "grants.grant", tiers),
      );
      logger.info(
        undefined,
        `extension grants granted plugin=${parsed.pluginId} tiers=${granted.join(",")}`,
      );
    },
    async revoke(input) {
      await revokeGrants(revokeExtensionInputSchema.parse(input).pluginId, "user");
    },
    async describeEnable(input) {
      const { pluginId } = describeExtensionEnableInputSchema.parse(input);
      const holders = grants.holders(pluginId);
      if (holders.length === 0) return { confirm: false, holders: [] };
      // 只有带扩展代码（合法、兼容、有 main）的插件需要确认：别的插件启用后没有代码在扩展进程里运行。
      const result = await deps.pluginManagement.listPlugins({
        workspacePath: deps.inventoryWorkspacePath,
        configScope: "user",
      });
      const plugin = result.plugins.find((candidate) => candidate.id === pluginId);
      if (!plugin || plugin.packageStatus === "missing") return { confirm: false, holders };
      const { entry } = resolvePluginManifest(
        { pluginId, name: plugin.name, rootPath: plugin.rootPath },
        await readPluginManifest(plugin.rootPath),
      );
      const hasCode = entry.extension?.state === "ok" && Boolean(entry.extension.main);
      return { confirm: hasCode, holders };
    },
    async getRecentActions(input) {
      const parsed = getExtensionRecentActionsInputSchema.parse(input);
      return { entries: await audit.recent(parsed.pluginId, parsed.limit) };
    },
    async decideActivation(input) {
      const { pluginId, allow } = decideExtensionActivationInputSchema.parse(input);
      // 与静态表重读同一条串行链：决定写进 grants.json 后按最近一份清单重发静态表与声明。
      await enqueueStatic("decide extension activation", async () => {
        if (!(await grants.decideActivation(pluginId, allow)))
          throw new Error("the extension is not waiting for activation");
        logger.info(
          undefined,
          `extension activation ${allow ? "allowed" : "declined"} plugin=${pluginId}`,
        );
        publishStatic(allow ? "activation allowed" : "activation declined");
        await pushDeclarations();
      });
    },
    async setNotificationsEnabled(input) {
      const { pluginId, enabled } = setExtensionNotificationsInputSchema.parse(input);
      const changed = await grants.setNotificationsEnabled(pluginId, enabled, async () => {
        await audit.append({
          gen: connection?.gen ?? null,
          pluginId,
          capability: enabled ? "grants.notifications.on" : "grants.notifications.off",
          grant: "notifications",
          outcome: "ok",
        });
      });
      if (changed) {
        logger.info(
          undefined,
          `extension notifications ${enabled ? "on" : "off"} plugin=${pluginId}`,
        );
      }
    },
    onDynamicGrantRequests: () => grantRequests.onRequests,
    async ackGrantRequest(ack) {
      grantRequests.ack(ack);
    },
  };

  const viewsService: IExtensionViewsService = {
    prepareView: (input) =>
      views.prepareView({
        ...input,
        scope: resolvedScopeSchema.parse(input.scope),
        ...(input.input ? { input: extensionViewInputSchema.parse(input.input) } : {}),
      }),
    viewRequest: (input) => views.viewRequest(viewRequestInputSchema.parse(input)),
    closeView: (input) => views.closeView(input.instanceId),
    onDynamicViewNotifications: (input) => views.onViewNotifications(input.instanceId),
    onDynamicViewOpenRequests: () => views.onOpenRequests,
    async ackViewOpen(ack) {
      views.ackOpen(ack);
    },
    onDynamicDraftRequests: () => drafts.onRequests,
    async ackDraftRequest(ack) {
      drafts.ack(ack);
    },
    onDynamicNotificationRequests: () => notifications.onRequests,
    async ackNotificationRequest(ack) {
      notifications.ack({
        requestId: ack.requestId,
        result: notificationsShowResultSchema.parse(ack.result),
      });
    },
  };

  return {
    service,
    viewsService,
    grantsService,
    announceReady() {
      refreshStatic("startup");
      deps.postToMain({ type: "extension-host/window-ready" });
    },
    receiveControl(message, port) {
      if (disposed) return;
      if (message.type === "extension-host/logs") {
        logs.fire(message.entries);
        return;
      }
      if (message.type === "extension-host/logs-snapshot") {
        const request = logRequests.get(message.requestId);
        if (!request) return;
        logRequests.delete(message.requestId);
        request.resolve({ entries: message.entries, lastSeq: message.lastSeq });
        return;
      }
      if (message.type === "extension-host/status") {
        status = message.status;
        // 扩展进程不在运行：旧代际的连接与快照作废。
        if (message.status.state !== "running") detach(`status ${message.status.state}`);
        hostStatus.fire(status);
        return;
      }
      if (!port) {
        logger.warn(undefined, `extension host pair message without a port gen=${message.gen}`);
        return;
      }
      attach(message.gen, port.port, port.onClose);
    },
    refreshInventory(change) {
      // 卸载删除授权记录（§17.7）；禁用不删。先删记录再重读静态表。
      if (change?.action === "uninstall" && change.pluginId) {
        void revokeGrants(change.pluginId, "uninstall").catch((error: unknown) => {
          logger.warn(undefined, "remove extension grants on uninstall failed", {
            code: (error as { code?: unknown } | null)?.code,
          });
        });
      }
      // 激活确认的记录（§17.7，P3b）：卸载删除；user 层重新启用也删除（设置页启用前已经确认过）。
      // 排在重读之前（同一条串行链），重读后的声明里就有这个插件。
      const clearHold =
        change?.pluginId &&
        (change.action === "uninstall" ||
          (change.action === "enable" && change.scope !== "workspace"))
          ? change.pluginId
          : null;
      if (clearHold) {
        void enqueueStatic("clear extension activation hold", async () => {
          if (await grants.clearActivation(clearHold))
            logger.info(undefined, `extension activation hold cleared plugin=${clearHold}`);
        });
      }
      refreshStatic("plugins changed", { installed: change?.action === "install" });
      // 扩展只认 user 层（§13）：workspace scope 的配置不改变 settings.get 的值。
      if (
        change?.pluginId &&
        (change.action === "configure" || change.action === "reset_config") &&
        change.scope !== "workspace"
      ) {
        settings.notifyChanged(change.pluginId);
      }
    },
    dispose() {
      disposed = true;
      detach("window host disposed");
      views.dispose();
      contextPump.dispose();
      generationPump.dispose();
      workbench.dispose();
      env.dispose();
      settings.dispose();
      reads.dispose();
      grantsSubscription.dispose();
      grantFactsChanged.dispose();
      grants.dispose();
      drafts.dispose();
      grantRequests.dispose();
      notifications.dispose();
      contributions.dispose();
      hostStatus.dispose();
      for (const request of logRequests.values()) {
        request.reject(new Error("extensions service disposed"));
      }
      logRequests.clear();
      logs.dispose();
    },
  };
}
