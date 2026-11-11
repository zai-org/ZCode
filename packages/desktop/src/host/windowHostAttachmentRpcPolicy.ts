import { ProxyChannel, type IDisposable, type IChannelServer } from "@zcode/rpc";
import {
  ServiceCollection,
  type ITerminalService,
  IProjectService,
  IRemoteProjectService,
  IBroadcastService,
  IWindowProjectService,
  IWindowRemoteProjectService,
  IWindowProjectChangesService,
  IMcpSyncService,
  IFeedbackService,
  IGenUiService,
  IHighspeedCardService,
  createWindowProjectChangesService,
  type ServiceExposurePolicy,
  type ZCodeAgentV4ClientMode,
} from "@zcode/services";
import { ServiceChannels } from "@zcode/shared";

const WEB_REMOTE_REPLAYABLE_ALLOWED_CHANNELS = new Set<string>([
  ServiceChannels.File,
  ServiceChannels.MediaPreview,
  ServiceChannels.System,
  // 手机终端此前被白名单挡在服务调用前并超时；已配对 attachment 复用原终端服务。
  ServiceChannels.Terminal,
  ServiceChannels.Git,
  ServiceChannels.GitCheckpoint,
  ServiceChannels.Setting,
  // 引导记录与 settings 同属该 attachment 的 owner；漏放行时手机调用超时，回退 settings 判定误弹引导。
  ServiceChannels.OnboardingRecord,
  ServiceChannels.Credential,
  ServiceChannels.CuaPermission,
  ServiceChannels.CuaPipSession,
  ServiceChannels.Broadcast,
  ServiceChannels.ZCodeTask,
  ServiceChannels.WindowController,
  ServiceChannels.ZCodeAgent,
  ServiceChannels.ZCodeSession,
  ServiceChannels.Project,
  ServiceChannels.TaskGroups,
  ServiceChannels.RemoteProjects,
  ServiceChannels.WindowProject,
  ServiceChannels.WindowRemoteProjects,
  ServiceChannels.WindowProjectChanges,
  // ConversationShare 由 scopeConversationShareServiceForAttachment 按 clientMode 包装：手机只保留
  // getCapabilities/getPreview 只读透传，publish/import/continuation 一律 feature_disabled。
  ServiceChannels.ConversationShare,
  ServiceChannels.FileWatcher,
  ServiceChannels.OAuth,
  ServiceChannels.ProviderSettings,
  ServiceChannels.ModelSelection,
  // ProviderProvisioningTarget 携带跨 Environment 凭据写入，只允许受信 Desktop Host 调用，绝不进手机 allowlist。
  ServiceChannels.SourceServerWorkspace,
  ServiceChannels.UsageStats,
  ServiceChannels.CodingPlanSubscription,
  ServiceChannels.ClientScenes,
  ServiceChannels.Skills,
  // 手机端没有同步 UI，只在 UI 层隐藏不足以阻止写入：导入方法在 RPC 层仍可调用。
  // 因此 SkillSync、PluginSync 及后续新增的同步通道一律不进手机 allowlist。
  // McpSync 例外：通道里混有手机 MCP 设置页在用的配置方法，按方法放行，见 scopeMcpSyncServiceForMobile。
  ServiceChannels.McpSync,
  ServiceChannels.Plugins,
  ServiceChannels.PluginManagement,
  ServiceChannels.Subagents,
  ServiceChannels.Commands,
  ServiceChannels.Hooks,
  ServiceChannels.Memory,
  ServiceChannels.OutputStyle,
  ServiceChannels.SettingsSync,
  ServiceChannels.Bots,
  ServiceChannels.Feedback,
  ServiceChannels.PromptAttachmentTransfer,
  ServiceChannels.OffPeakTask,
]);

const WEB_REMOTE_REPLAYABLE_EXPOSURE_POLICY: ServiceExposurePolicy = {
  allowedChannels: WEB_REMOTE_REPLAYABLE_ALLOWED_CHANNELS,
};

export function resolveWindowHostServiceExposurePolicy(
  clientMode: ZCodeAgentV4ClientMode,
): ServiceExposurePolicy | undefined {
  // Host 只向手机暴露明确允许的频道，避免新注册的高权限服务自动开放。
  // mobile 必须使用显式 allowlist，让未审阅 channel 默认 fail-closed；桌面继续保持完整服务面。
  return clientMode === "web-remote-replayable" ? WEB_REMOTE_REPLAYABLE_EXPOSURE_POLICY : undefined;
}

// 手机 MCP 设置页（状态列表、远端 workspace MCP 目录读写）在用的配置方法；其余都是同步方法。
const MOBILE_MCP_SYNC_ALLOWED_METHODS = new Set<string>([
  "loadMcpFromUserDirectory",
  "saveMcpToUserDirectory",
  "listWorkspaceMcpServerStatuses",
  // 信任是同一目标 Host 的设置命令；不放开桌面专属的批量同步方法。
  "setWorkspaceMcpTrust",
] satisfies ReadonlyArray<keyof IMcpSyncService>);

function scopeMcpSyncServiceForMobile(service: IMcpSyncService): IMcpSyncService {
  const rejectMobileSync = async (): Promise<never> => {
    throw Object.assign(new Error("Remote sync is only available from Desktop"), {
      kind: "feature_disabled" as const,
    });
  };
  // 用 allowlist 而不是逐个列出同步方法：McpSync 以后新增的方法默认在手机上拒绝。
  return new Proxy({} as IMcpSyncService, {
    get: (_target, key) => {
      // 非字符串键、thenable 探测和 on* 事件键不伪装成方法，避免被当作 Promise 或事件订阅。
      if (typeof key !== "string" || key === "then" || /^on[A-Z]/.test(key)) return undefined;
      if (!MOBILE_MCP_SYNC_ALLOWED_METHODS.has(key)) return rejectMobileSync;
      const method = service[key as keyof IMcpSyncService] as (...args: unknown[]) => unknown;
      return (...args: unknown[]) => method.apply(service, args);
    },
  });
}

function resolveAttachmentOverrides(
  services: ServiceCollection,
  clientMode: ZCodeAgentV4ClientMode,
  overrides: ReadonlyMap<string, unknown> | undefined,
): ReadonlyMap<string, unknown> | undefined {
  if (clientMode !== "web-remote-replayable") return overrides;
  const mcpSync =
    (overrides?.get(IMcpSyncService.channelName) as IMcpSyncService | undefined) ??
    services.getOptional(IMcpSyncService);
  if (!mcpSync) return overrides;
  const scoped = new Map(overrides);
  if (mcpSync) scoped.set(IMcpSyncService.channelName, scopeMcpSyncServiceForMobile(mcpSync));
  return scoped;
}

export function exposeWindowHostAttachmentServices(params: {
  server: IChannelServer;
  services: ServiceCollection;
  clientMode: ZCodeAgentV4ClientMode;
  overrides?: ReadonlyMap<string, unknown>;
  attachmentScope?: { kind: "local" | "remote" | "source-settings" };
  windowServices?: ServiceCollection;
  /** 手机窗口目录与 project 频道同样叠加实时交互，避免远端 scope 下列表缺「待处理」。 */
  decorateWindowProjectService?: (service: IProjectService) => IProjectService;
}): void {
  if (params.clientMode === "web-remote-replayable" && params.attachmentScope?.kind === "remote") {
    if (!params.windowServices) throw new Error("window-project-directory.unavailable");
    // 原 project 属于 Source，替换会破坏工作区内的 mentions 等调用；窗口目录另用完整频道组。
    // 先取得所有必需服务，缺失时不发布部分频道，也不修改共享远端 ServiceCollection。
    const directory = new ServiceCollection()
      .register(
        IWindowProjectService,
        (params.decorateWindowProjectService ?? ((service: IProjectService) => service))(
          params.windowServices.get(IProjectService),
        ),
      )
      .register(IWindowRemoteProjectService, params.windowServices.get(IRemoteProjectService))
      .register(
        IWindowProjectChangesService,
        createWindowProjectChangesService(params.windowServices.get(IBroadcastService)),
      );
    directory.exposeOnChannelServer(
      params.server,
      undefined,
      resolveWindowHostServiceExposurePolicy(params.clientMode),
    );
  }
  params.services.exposeOnChannelServer(
    params.server,
    resolveAttachmentOverrides(params.services, params.clientMode, params.overrides),
    {
      ...resolveWindowHostServiceExposurePolicy(params.clientMode),
      // 只有本机桌面 MessagePort 具备恢复权限；远端、手机和未知 scope 均默认拒绝。
      ...(params.clientMode === "desktop-continuous" && params.attachmentScope?.kind === "local"
        ? { credentialStoreRecovery: "local-desktop" as const }
        : {}),
    },
  );
  if (params.clientMode === "web-remote-replayable") {
    if (params.attachmentScope?.kind === "local") {
      const highspeed = params.services.getOptional(IHighspeedCardService);
      if (highspeed) {
        // Bug 原因：手机未发布 Highspeed 频道，读卡超时后无法显示独立调档入口。
        // 只给可信本地 attachment 发布现有方法；不扩大远端或未知 scope 的服务面。
        // getCurrentOwnerKey 只返回匿名归属哈希；缺少它时共用的 SessionPane 拿不到归属，
        // healthy 因缺少 ownerKey 永远不查询，手机端加速统计会消失。
        params.server.registerChannel(
          IHighspeedCardService.channelName,
          ProxyChannel.fromService({
            getSnapshot: highspeed.getSnapshot.bind(highspeed),
            prepareTurn: highspeed.prepareTurn.bind(highspeed),
            invalidateCard: highspeed.invalidateCard.bind(highspeed),
            getCurrentOwnerKey: highspeed.getCurrentOwnerKey.bind(highspeed),
            healthy: highspeed.healthy.bind(highspeed),
          } satisfies IHighspeedCardService),
        );
      }
    }
    const controllerServices =
      params.attachmentScope?.kind === "remote" ? params.windowServices! : params.services;
    if (params.attachmentScope?.kind === "remote") {
      // Source 集合不拥有反馈服务；手机切到远端后仍须复用控制端账号、设备和诊断日志。
      params.server.registerChannel(
        IFeedbackService.channelName,
        ProxyChannel.fromService(controllerServices.get(IFeedbackService)),
      );
    }
    const genUi = controllerServices.getOptional(IGenUiService);
    if (genUi) {
      // 发送前 listState 曾因整频道被拒而固定等待超时。只发布控制端的只读上下文接口，
      // 不把 sandbox、文件读取或状态写入连同完整 Gen UI 服务开放给手机。
      params.server.registerChannel(
        IGenUiService.channelName,
        ProxyChannel.fromService({ listState: genUi.listState.bind(genUi) }),
      );
    }
  }
}

/** 手机终端属于页面 owner，不属于可随导航换代的 RPC attachment。 */
export function createWindowHostTerminalOwners(onCleanupError: (error: unknown) => void) {
  let current:
    | { id: string; scopes: Map<string, ReturnType<typeof createTerminalScope>> }
    | undefined;
  return {
    setOwner(id: string | null): void {
      if (current?.id === id) return;
      const previous = current;
      current = id === null ? undefined : { id, scopes: new Map() };
      // 先撤销旧 owner，再异步回收；旧 attachment 和晚到 create 均不能复活它。
      for (const scope of previous?.scopes.values() ?? []) scope.dispose();
    },
    bind(ownerId: string, scopeKey: string, base: ITerminalService): ITerminalService {
      if (current?.id !== ownerId) throw new Error("Terminal owner has ended");
      let scope = current.scopes.get(scopeKey);
      if (!scope) {
        scope = createTerminalScope(base, onCleanupError);
        current.scopes.set(scopeKey, scope);
      }
      return scope.service;
    },
  };
}

/** 旧客户端没有页面 owner 时按 attachment 回收，避免继续产生无主 PTY。 */
export function createTerminalScope(
  base: ITerminalService,
  onCleanupError: (error: unknown) => void,
) {
  let active = true;
  const terminals = new Map<string, IDisposable>();
  function assertActive(id?: string): void {
    if (!active || (id !== undefined && !terminals.has(id))) {
      throw new Error("Terminal owner has ended or does not own this terminal");
    }
  }
  const release = async (id: string) => {
    await base.dispose({ id });
    terminals.get(id)?.dispose();
    terminals.delete(id);
  };
  const service: ITerminalService = {
    async create(params) {
      assertActive();
      const result = await base.create(params);
      // create 跨 RPC/加载 await；owner 已结束时必须回收返回的真实 PTY，不能只丢响应。
      if (!active) {
        await base.dispose({ id: result.id });
        throw new Error("Terminal owner has ended");
      }
      const subscription = base.onDynamicExit(result.id)(() => {
        terminals.get(result.id)?.dispose();
        terminals.delete(result.id);
      });
      terminals.set(result.id, subscription);
      return result;
    },
    async write(params) {
      assertActive(params.id);
      await base.write(params);
    },
    async resize(params) {
      assertActive(params.id);
      await base.resize(params);
    },
    async dispose({ id }) {
      if (!active || !terminals.has(id)) return;
      await release(id);
    },
    async listTerminalIdsUnderPath(params) {
      assertActive();
      // attachment 只能看到自己创建的终端，不能借查询枚举 Host 上其他 owner 的终端。
      return (await base.listTerminalIdsUnderPath(params)).filter((id) => terminals.has(id));
    },
    onDynamicData(id) {
      assertActive(id);
      return base.onDynamicData(id);
    },
    onDynamicExit(id) {
      assertActive(id);
      return base.onDynamicExit(id);
    },
  };
  return {
    service,
    dispose(): void {
      if (!active) return;
      active = false;
      for (const [id, subscription] of terminals) {
        subscription.dispose();
        void release(id).catch(onCleanupError);
      }
    },
  };
}
