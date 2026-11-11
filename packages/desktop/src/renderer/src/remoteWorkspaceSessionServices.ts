import type { IHighspeedCardService, IServiceAccessor } from "@zcode/services";
import type { RemoteTarget } from "@zcode/shared";

/**
 * 高速卡与闲时任务只在本地生效（2026-10-21 产品决定），远程 workspace 一律不得路由到远端。
 *
 * Bug 原因：3.16 起已识别 Source 的远程 workspace 整套使用远端服务，远端合同没有
 * highspeed-card / off-peak-task 频道。发送前 await prepareTurn 要等满 Host ChannelServer
 * 的 1000ms 未知频道超时才继续；闲时通知轮询每 30s 同样超时一次。
 * 修复：高速卡注入不 draw 的实现，发送立即走普通模型；闲时任务只属于本地项目，固定取本地服务。
 */
const remoteUnsupportedHighspeedCardService: IHighspeedCardService = {
  prepareTurn: async () => ({ kind: "fallback", reason: "unavailable", nextDrawAt: null }),
  getSnapshot: async () => ({ card: null, nextDrawAt: null, drawing: false }),
  invalidateCard: async () => false,
  // 远程不支持高速卡，但共用 SessionPane 仍会查询归属；漏实现会在挂载时同步抛错。
  getCurrentOwnerKey: async () => null,
  healthy: async () => {
    throw new Error("highspeed.remote-unsupported");
  },
};

function withLocalOnlyAccountServices(
  baseServices: IServiceAccessor,
  services: IServiceAccessor,
): IServiceAccessor {
  return {
    ...services,
    highspeedCardService: remoteUnsupportedHighspeedCardService,
    offPeakTaskService: baseServices.offPeakTaskService,
  };
}

export function buildRemoteWorkspaceSessionServices(
  baseServices: IServiceAccessor,
  remoteServices: IServiceAccessor,
): IServiceAccessor {
  return withLocalOnlyAccountServices(baseServices, {
    ...baseServices,
    fileService: remoteServices.fileService,
    // 根因：遗漏此覆盖会用本机输出根目录校验远端 HTML，合法文件也被判越界。
    // 文件读取走执行端；useGenUi 的状态与沙箱仍取 desktop base services。
    genUiService: remoteServices.genUiService,
    mediaPreviewService: remoteServices.mediaPreviewService,
    gitService: remoteServices.gitService,
    gitCheckpointService: remoteServices.gitCheckpointService,
    systemService: remoteServices.systemService,
    terminalService: remoteServices.terminalService,
    // 远端附件必须由当前 workspace host 上传并改写路径；沿用本地服务会把
    // 桌面机的绝对路径原样传给 SSH/WSL/Docker 中的 CLI，导致附件无法读取。
    promptAttachmentTransferService: remoteServices.promptAttachmentTransferService,
    // MCP / 插件状态检查走 zcodeAgentService 的控制面 app-server。
    // SSH 远端如果沿用本机 base service，会把远端 MCP 配置拿到本机 app-server 里检查，
    // 其 PATH / cwd 都不是远端环境，导致同步后仍显示 `spawn npx ENOENT`。
    zcodeAgentService: remoteServices.zcodeAgentService,
    zcodeTaskService: remoteServices.zcodeTaskService,
    zcodeSessionService: remoteServices.zcodeSessionService,
    // 分享使用本地登录/API，但 Rows 与文件必须绑定当前远端 connection scope。
    conversationShareService: remoteServices.conversationShareService,
    fileWatcherService: remoteServices.fileWatcherService,
    // Provider/Model 事实属于目标 Environment；不能因 merge 先展开 baseServices 而回落到本地。
    modelSelectionService: remoteServices.modelSelectionService,
    providerSettingsService: remoteServices.providerSettingsService,
    // SSH/Docker remote 项目的 skills/plugins/commands 目录位于远端文件系统。
    // 之前这里沿用本机 base services，会拿远端 workspacePath 去本机扫描，导致项目级能力读不到。
    skillsService: remoteServices.skillsService,
    // 远端 skill 同步的 import 必须写入 SSH 主机的 ~/.zcode/skills。
    // 如果继续沿用 base service，UI 会显示同步成功但实际写到本机 ~/.zcode/skills。
    skillSyncService: remoteServices.skillSyncService,
    // 远端 MCP 同步的 import 必须写入 SSH 主机的 ~/.zcode/cli/config.json。
    // 这里与 skillSyncService 一样走 remote service，避免把远端配置写回本机用户目录。
    mcpSyncService: remoteServices.mcpSyncService,
    // 远端 plugin 同步会写入 SSH 主机的 ~/.zcode/plugins 和 plugins.dirs；
    // 必须像 skill/MCP 一样走 remote service，不能沿用本机 base service。
    pluginSyncService: remoteServices.pluginSyncService,
    // 子智能体 / 命令 / 钩子的同步写入远端用户目录，同样不能沿用本机 base service。
    userConfigSyncService: remoteServices.userConfigSyncService,
    pluginsService: remoteServices.pluginsService,
    // 设置页插件管理与 pluginsService 同理，必须打到远端（插件目录在远端文件系统）。
    pluginManagementService: remoteServices.pluginManagementService,
    commandsService: remoteServices.commandsService,
    // SSH/Docker 工作区的 hooks 声明、信任状态与待审项都位于远端文件系统。
    // hooksService 必须覆盖 baseServices 中的本机服务，否则会用远端路径扫描本机文件系统，
    // 无法读取远端待审 Hook。
    // hooks 读写（loadHooks/saveHooks）与 grantWorkspaceHookTrust 授权都必须打到远端 host。
    hooksService: remoteServices.hooksService,
  });
}

export function buildServerRemoteWorkspaceSessionServices(
  baseServices: IServiceAccessor,
  remoteServices: IServiceAccessor,
): IServiceAccessor {
  // Server remote 连接的是完整运行中的 ZCode server；workspace/runtime/model-provider
  // 等状态以 server 为准，本地 renderer 只保留窗口与 UI shell 状态。
  return withLocalOnlyAccountServices(baseServices, remoteServices);
}

export function buildRemoteWorkspaceSessionServicesForRegistration(params: {
  baseServices: IServiceAccessor;
  remoteServices: IServiceAccessor;
  targetKind: RemoteTarget["kind"];
  sourceServerId?: string;
}): IServiceAccessor {
  // Bug 根因：Source Server 可以通过 SSH/WSL/Docker transport 到达，target.kind 仍描述
  // 线路而不是服务权威。Host 注入 sourceServerId 后必须使用完整远端服务集合；只有尚未
  // 识别为 Source 的 legacy attachment 才保留 desktop-attached mixed services。
  return params.targetKind === "server" || params.sourceServerId?.trim()
    ? buildServerRemoteWorkspaceSessionServices(params.baseServices, params.remoteServices)
    : buildRemoteWorkspaceSessionServices(params.baseServices, params.remoteServices);
}
