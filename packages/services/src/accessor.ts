import type { IRemoteProjectService } from "#src/remote-projects/contract.js";
import type { ITaskGroupService } from "#src/task-groups/contract.js";
import type { WindowProjectDirectoryServices } from "#src/window-project-directory/contract.js";
import type { IProjectService } from "#src/project/contract.js";
import type { IManagedWorktreeService } from "#src/managed-worktree-tasks/contract.js";
import type { IGenUiService } from "./gen-ui/contract.js";
import { IOffPeakTaskService } from "./session/offPeakTask.js";
import type { IHighspeedCardService } from "./highspeed/highspeedCard.js";
import type { IPluginUiBridgeService } from "./plugin-ui-bridge/contract.js";
import type { IPluginUiSamplingService } from "./plugin-ui-bridge/samplingContract.js";
import type { IPluginUiAppToolsService } from "./plugin-ui-bridge/appToolsContract.js";
import type { IFileService } from "./file/file.js";
import type { IMediaPreviewService } from "./media-preview/mediaPreview.js";
import type { ICloudContentService } from "#src/cloud-content/cloudContent.js";
import type { IMarketingTouchService } from "#src/marketing-touch/marketingTouch.js";
import type { IGitService } from "./git/git.js";
import type { IGitCheckpointService } from "./git/gitCheckpoint.js";
import type { ISystemService } from "./system/system.js";
import type { ITerminalService } from "./terminal/terminal.js";
import type { ISettingService } from "./setting/setting.js";
import type { ICredentialService } from "./credential/credential.js";
import type { IBroadcastService } from "./broadcast/broadcast.js";
import type { IZCodeTaskService } from "./session/zcodeTaskService.js";
import type { IZCodeAgentService } from "./zcode-agent/zcodeAgent.js";
import type { IZCodeSessionService } from "./zcode-session/zcodeSession.js";
import type { ICuaPermissionService } from "./cua-permission-broker/cuaPermissionService.js";
import type { IBotsService } from "./bots/bots.js";
import type { IFileWatcherService } from "./fileWatcher/fileWatcher.js";
import type { IOAuthService } from "./oauth/oauth.js";
import type {
  IModelSelectionService,
  IProviderSettingsService,
} from "./model-provider/providerFacadeServices.js";
import type { IUsageStatsService } from "./usage-stats/usageStats.js";
import type { ICodingPlanSubscriptionService } from "./coding-plan-subscription/codingPlanSubscription.js";
import type { IClientConfigService } from "./client-config/clientConfig.js";
import type { IClientScenesService } from "./client-scenes/clientScenes.js";
import type { ISkillsService } from "./skills/skills.js";
import type { ISkillSyncService } from "./skill-sync/skillSync.js";
import type { IDeviceSyncStateService, IUserConfigSyncService } from "./data-sync/index.js";
import type { IProviderProvisioningStatusService } from "./provider-provisioning-status/index.js";
import type {
  IExtensionGrantsService,
  IExtensionsService,
  IExtensionViewsService,
} from "./extensions/index.js";
import type { IVoiceInputService } from "./voice-input/index.js";
import type { IMcpSyncService } from "./mcp-sync/mcpSync.js";
import type { IPluginSyncService } from "./plugin-sync/pluginSync.js";
import type { IPluginsService } from "./plugins/plugins.js";
import type { IPluginManagementService } from "./plugins/pluginManagement.js";
import type { ISubagentsService } from "./subagents/subagents.js";
import type { ICommandsService } from "./commands/commands.js";
import type { IHooksService } from "./hooks/hooks.js";
import type { IMemoryService } from "./memory/memory.js";
import type { IOutputStyleService } from "./output-style/outputStyle.js";
import type { ISettingsSyncService } from "./settings-sync/settingsSync.js";
import type { IFeedbackService } from "./feedback/feedback.js";
import type { IPromptAttachmentTransferService } from "./prompt-attachment-transfer/promptAttachmentTransfer.js";
import type { IWindowControllerService } from "./window-controller/windowController.js";
import type { ISourceServerWorkspaceService } from "./source-server-workspace/sourceServerWorkspace.js";
import type { ISourceServerManagementService } from "./source-server-management/sourceServerManagement.js";
import type { IOnboardingRecordService } from "./onboarding/onboardingRecord.js";
import type { IConversationShareService } from "./conversation-share/conversationShare.js";

/** UI 层消费的统一服务接口 */
export interface IServiceAccessor {
  readonly taskGroupService?: ITaskGroupService;
  readonly projectService?: IProjectService;
  /** 受管 worktree 管理；仅本地桌面 Host 提供，手机与旧 Host 缺省。 */
  readonly managedWorktreeService?: IManagedWorktreeService;
  readonly remoteProjectService?: IRemoteProjectService;
  readonly windowProjectDirectory?: WindowProjectDirectoryServices;
  readonly fileService: IFileService;
  readonly mediaPreviewService?: IMediaPreviewService;
  readonly cloudContentService?: ICloudContentService;
  readonly marketingTouchService?: IMarketingTouchService;
  readonly gitService: IGitService;
  readonly gitCheckpointService: IGitCheckpointService;
  readonly systemService: ISystemService;
  readonly terminalService: ITerminalService;
  readonly settingService: ISettingService;
  /** Onboarding 完成记录（本地持久化）；旧测试 double / 不支持的 host 可不提供。 */
  readonly onboardingRecordService?: IOnboardingRecordService;
  readonly credentialService: ICredentialService;
  readonly broadcastService: IBroadcastService;
  readonly zcodeTaskService: IZCodeTaskService;
  /** 窗口 Host 聚合面；旧 server wire 或测试 double 可暂不提供。 */
  readonly windowControllerService?: IWindowControllerService;
  readonly zcodeAgentService: IZCodeAgentService;
  readonly zcodeSessionService: IZCodeSessionService;
  // CUA 是 opt-in 内测特性：local macOS host 提供，远端 等 host 没有。可选避免连锁必填。
  readonly cuaPermissionService?: ICuaPermissionService;
  readonly conversationShareService: IConversationShareService;
  readonly botsService: IBotsService;
  readonly fileWatcherService: IFileWatcherService;
  readonly oauthService: IOAuthService;
  /** 当前 Environment 的 Provider 配置与设置视图。 */
  readonly providerSettingsService: IProviderSettingsService;
  /** 当前 Environment Registry 发布的唯一模型选择 View。 */
  readonly modelSelectionService: IModelSelectionService;
  /** Source Server 端 workspace 身份解析；本地 Host 也注册一份以保持合同一致。 */
  readonly sourceServerWorkspaceService: ISourceServerWorkspaceService;
  /** 仅桌面窗口 Host 的 base attachment 注册；远端 / Web 不提供。 */
  readonly sourceServerManagementService?: ISourceServerManagementService;
  /** 仅桌面本机 Host 注册：数据同步页的设备同步状态。 */
  readonly deviceSyncStateService?: IDeviceSyncStateService;
  /** 仅桌面本机 Host 注册：数据同步页模型提供商的 Provisioning lane 状态与重试。 */
  readonly providerProvisioningStatusService?: IProviderProvisioningStatusService;
  /** 仅桌面本机 Host 注册：扩展（docs/plugins/extension-host.md）。Web / 手机 / 远端不提供。 */
  readonly extensionsService?: IExtensionsService;
  /** 仅桌面本机 Host 注册：扩展视图（与 extensionsService 同一开关）。Web / 手机 / 远端不提供。 */
  readonly extensionViewsService?: IExtensionViewsService;
  /** 仅桌面本机 Host 注册：扩展授权（与 extensionsService 同一开关，§17.7）。Web / 手机 / 远端不提供。 */
  readonly extensionGrantsService?: IExtensionGrantsService;
  /** 语音输入；只在桌面 base 连接存在 */
  readonly voiceInputService?: IVoiceInputService;
  readonly usageStatsService: IUsageStatsService;
  readonly codingPlanSubscriptionService: ICodingPlanSubscriptionService;
  readonly clientConfigService: IClientConfigService;
  readonly clientScenesService: IClientScenesService;
  /** 闲时任务管理（独立服务面）。 */
  readonly offPeakTaskService: IOffPeakTaskService;
  readonly highspeedCardService: IHighspeedCardService;
  readonly skillsService: ISkillsService;
  readonly skillSyncService: ISkillSyncService;
  readonly mcpSyncService: IMcpSyncService;
  /** 插件 UI 桥；web 或旧 host 可不提供，UI 据此回退普通 MCP 卡片。 */
  readonly genUiService?: IGenUiService;
  readonly pluginUiBridgeService?: IPluginUiBridgeService;
  /** 页面 sampling；只有桌面本地任务开放。 */
  readonly pluginUiSamplingService?: IPluginUiSamplingService;
  /** App-Provided Tools；只有桌面本地 agent 时存在。 */
  readonly pluginUiAppToolsService?: IPluginUiAppToolsService;
  readonly pluginSyncService: IPluginSyncService;
  /** 数据同步：子智能体 / 命令 / 钩子共用的用户配置同步通道（按 category 区分）。 */
  readonly userConfigSyncService: IUserConfigSyncService;
  readonly pluginsService: IPluginsService;
  /** 设置页插件管理（UI 不再直触 zcodeAgentService 的 plugins/* 面） */
  readonly pluginManagementService: IPluginManagementService;
  readonly subagentsService: ISubagentsService;
  readonly commandsService: ICommandsService;
  readonly hooksService: IHooksService;
  readonly memoryService: IMemoryService;
  readonly outputStyleService: IOutputStyleService;
  readonly settingsSyncService: ISettingsSyncService;
  readonly feedbackService: IFeedbackService;
  readonly promptAttachmentTransferService: IPromptAttachmentTransferService;
}
