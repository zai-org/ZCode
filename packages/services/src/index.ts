// Descriptors & collection (browser-safe)
export { type ServiceDescriptor, createServiceDescriptor } from "./descriptors.js";
export { ServiceCollection, type ServiceExposurePolicy } from "./collection.js";
export {
  IModelSelectionService,
  IProviderSettingsService,
  type ModelSelectionView,
  type ModelSelectionViewInput,
  type ProviderSettingsProviderView,
  type ProviderSettingsView,
} from "./model-provider/providerFacadeServices.js";
export {
  createAccountRequestAuthService,
  type IAccountRequestAuthService,
  type AccountRequestAuthInput,
  type AccountRequestAuthMaterial,
  type AccountRequestAuthResolver,
} from "./model-provider/accountRequestAuthService.js";
export { IProviderProvisioningTargetService } from "./model-provider/providerProvisioning.js";
export {
  collectServiceMemoryDiagnostics,
  memoryDiagnosticsRegistry,
  registerMemoryDiagnosticsProvider,
} from "./memoryDiagnostics.js";

// Accessor
export type { IServiceAccessor } from "./accessor.js";
export {
  ConversationShareServiceError,
  createUnsupportedConversationShareService,
  IConversationShareService,
} from "./conversation-share/conversationShare.js";
export type {
  ConversationShareSelection,
  ConversationSharePublishProgress,
  ConversationShareImportProgress,
  ImportConversationShareInput,
  ImportConversationShareResult,
  ImportedConversationShare,
  ConversationShareServiceErrorKind,
  ConversationShareFailureIssue,
  ConversationShareFailureIssueCode,
  ConversationSharePreflightInput,
  ConversationSharePreflightResult,
  ConversationShareAllowedArtifact,
  ConversationShareTurnPreflightResult,
  PublishTextConversationInput,
} from "./conversation-share/conversationShare.js";
// Conversation share 的具体实现依赖 Node 文件系统，只能从 @zcode/services/node 引入；
// 根入口必须保持 browser-safe，避免 renderer 解析到 node:* 模块。
export {
  createConversationTelemetryService,
  type ConversationTelemetryWorkspaceTarget,
  type IConversationTelemetryService,
} from "./conversation-telemetry/conversationTelemetry.js";

// File service — IFileService is both a type (interface) and value (descriptor)
export { IFileService } from "./file/file.js";
export { IMediaPreviewService } from "./media-preview/mediaPreview.js";
export { ICloudContentService } from "#src/cloud-content/cloudContent.js";
export { IMarketingTouchService } from "#src/marketing-touch/marketingTouch.js";
export type { MediaPreviewPreparation } from "./media-preview/mediaPreview.js";

// Git service — IGitService is both a type (interface) and value (descriptor)
export { IGitService } from "./git/git.js";
export { IGitCheckpointService } from "./git/gitCheckpoint.js";

// System service — ISystemService is both a type (interface) and value (descriptor)
export { ISystemService } from "./system/system.js";

// Terminal service — ITerminalService is both a type (interface) and value (descriptor)
export { ITerminalService } from "./terminal/terminal.js";

// Setting service — ISettingService is both a type (interface) and value (descriptor)
export { ISettingService } from "./setting/setting.js";

// Credential service — ICredentialService is both a type (interface) and value (descriptor)
export { ICredentialService } from "./credential/credential.js";
export { ISourceServerWorkspaceService } from "./source-server-workspace/sourceServerWorkspace.js";
export {
  ISourceServerManagementService,
  type UpdateConnectionProfileInput,
} from "./source-server-management/sourceServerManagement.js";

// Broadcast service — IBroadcastService is both a type (interface) and value (descriptor)
export { IBroadcastService } from "./broadcast/broadcast.js";

// Onboarding 完成记录服务（本地持久化，后续上传服务器）
export { IOnboardingRecordService } from "./onboarding/onboardingRecord.js";
export type {
  CreateOnboardingRecordServiceOptions,
  OnboardingRecordServiceFactory,
} from "./onboarding/onboardingRecord.js";
// 这里只能导出 descriptor 和类型。根 index 会被 renderer 经 value import 拉进浏览器包，
// 若 value 导出 createOnboardingRecordService，会连带 fs/atomicFileUtils → @zcode/shared/node →
// node:timers/promises 整条 Node 链进浏览器，模块加载直接抛错导致整个应用黑屏。
// 工厂函数由 host 侧（node.ts）与测试从实现文件路径直接导入，与 createSettingService 同惯例。
export type {
  BroadcastClaimAcquireResult,
  BroadcastClaimLease,
  BroadcastMessage,
} from "./broadcast/broadcast.js";

// ZCode task wrapper service — task 列表/置顶/归档等 app 侧包装状态入口。
export { IZCodeTaskService } from "./session/zcodeTaskService.js";
export type {
  ZCodeArchivedTaskDeletionResult,
  ZCodeModelTrajectory,
  ZCodeModelTrajectoryCallSource,
  ZCodeModelTrajectoryCallSourceKind,
  ZCodeModelTrajectoryContentPart,
  ZCodeModelTrajectoryMessage,
  ZCodeModelTrajectoryRecord,
  ZCodeModelTrajectoryUsage,
  ZCodeTaskListKind,
  ZCodeTaskListQuery,
  ZCodeTaskListResult,
  ZCodeTaskListSortBy,
  ZCodeTaskListWorkspaceScope,
  ZCodeTaskReadyOutcome,
} from "./session/zcodeTaskService.js";
export type { ZCodeTaskListItem } from "./session/zcodeTaskListTypes.js";

export { IWindowControllerService } from "./window-controller/windowController.js";
export {
  IWindowProjectService,
  IWindowRemoteProjectService,
  IWindowProjectChangesService,
  type WindowProjectDirectoryServices,
} from "#src/window-project-directory/contract.js";
export {
  createWebRemoteProjectTreeActivityBridge,
  createWindowProjectChangesService,
  type WebRemoteProjectTask,
} from "#src/window-project-directory/index.js";
export type {
  WindowHostControllerFrame,
  WindowHostControllerMutation,
  WindowHostControllerTaskListItem,
  WindowHostControllerTaskListResult,
  WindowHostTaskUnreadSignal,
  WindowHostTasksRemovedSignal,
} from "./window-controller/windowController.js";

// ZCode agent service — IZCodeAgentService is both a type (interface) and value (descriptor)
export {
  IZCodeAgentService,
  type ZCodeAgentLocalRuntimeChildProcesses,
  ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE,
} from "./zcode-agent/zcodeAgent.js";
export {
  isZCodeAgentModelSelectionBasisUnsupportedError,
  ZCodeAgentModelSelectionBasisUnsupportedError,
  isZCodeAgentMcpStatusModeUnsupportedError,
  ZCODE_AGENT_MCP_STATUS_MODE_UNSUPPORTED_ERROR_CODE,
  ZCodeAgentMcpStatusModeUnsupportedError,
} from "./zcode-agent/zcodeAgentErrors.js";
export {
  createZCodeAgentConnectionScope,
  readTrustedZCodeAgentV4Connection,
} from "./zcode-agent/zcodeAgentConnectionScope.js";
export type {
  ZCodeAgentConnectionScope,
  ZCodeAgentV4ClientMode,
  ZCodeAgentV4ConnectionContext,
} from "./zcode-agent/zcodeAgentConnectionScope.js";
export type {
  ZCodeAgentAttachmentBeginParams,
  ZCodeAgentAttachmentChunkParams,
  ZCodeAgentAttachmentTerminalParams,
  ZCodeAgentCreateSessionParams,
  ZCodeAgentCuaPermissionObservation,
  ZCodeAgentInitializeResult,
  ZCodeAgentStorageStartupSnapshot,
  ZCodeAgentRuntimeExitedEvent,
  ZCodeAgentRuntimeLifecycleEvent,
  ZCodeAgentRuntimePolicy,
  ZCodeAgentReadSessionParams,
  ZCodeAgentRespondProviderRuntimeHeadersParams,
  ZCodeAgentProviderRuntimeHeadersRequest,
  ZCodeAgentResumeSessionParams,
  ZCodeAgentRunAutomationNowResult,
  ZCodeAgentSavedWorkflowTarget,
  ZCodeAgentSendPromptParams,
  ZCodeAgentServiceEvent,
  ZCodeAgentSessionSubscribeParams,
  ZCodeAgentSessionTarget,
  ZCodeAgentSetModeParams,
  ZCodeAgentSetModelParams,
  ZCodeAgentSetThoughtLevelParams,
  ZCodeAgentWorkspaceTarget,
} from "./zcode-agent/zcodeAgent.js";

// ZCode session service — app-facing session facade without ZCode Agent naming.
export { IZCodeSessionService } from "./zcode-session/zcodeSession.js";
export type {
  ZCodeSessionCreateParams,
  ZCodeSessionEventsParams,
  ZCodeSessionInitializeResult,
  ZCodeSessionListParams,
  ZCodeSessionMessagesParams,
  ZCodeSessionReadParams,
  ZCodeSessionResumeParams,
  ZCodeSessionServiceEvent,
  ZCodeSessionSetModeParams,
  ZCodeSessionSetModelParams,
  ZCodeSessionSetThoughtLevelParams,
  ZCodeSessionSubscribeParams,
  ZCodeTaskTarget,
  ZCodeSessionWorkspaceTarget,
} from "./zcode-session/zcodeSession.js";

// Bots service — IBotsService is both a type (interface) and value (descriptor).
export { IBotsService } from "./bots/bots.js";
export type {
  BotRemoteWorkspaceResolver,
  BotRemoteWorkspaceResolution,
  BotBindCodeResult,
  BotCreateBindCodeParams,
  BotListWorkspaceRefsParams,
  BotSaveBotParams,
  BotTestResult,
} from "./bots/bots.js";

// Hooks service — IHooksService is both a type (interface) and value (descriptor).
export { IHooksService } from "./hooks/hooks.js";

// Memory service — IMemoryService is both a type (interface) and value (descriptor).
export {
  IMemoryService,
  PROJECT_MEMORY_FILE_CHANGED_ERROR_CODE,
  PROJECT_MEMORY_PREVIEW_LIMIT_EXCEEDED_ERROR_CODE,
} from "./memory/memory.js";
export type { ProjectMemoryFileSummary, ProjectMemoryWorkspaceSummary } from "./memory/memory.js";

// OutputStyle service — IOutputStyleService is both a type (interface) and value (descriptor).
export { IOutputStyleService } from "./output-style/outputStyle.js";
export type { SessionRealtimePort } from "./session/sessionRealtimePort.js";

// FileWatcher service — IFileWatcherService is both a type (interface) and value (descriptor)
export { IFileWatcherService } from "./fileWatcher/fileWatcher.js";

// OAuth service — IOAuthService is both a type (interface) and value (descriptor)
export { IOAuthService } from "./oauth/oauth.js";

// UsageStats service — IUsageStatsService is both a type (interface) and value (descriptor)
export { IUsageStatsService } from "./usage-stats/usageStats.js";

// Storage（资源管理器「存储」tab）：数据类型在 @zcode/shared；这里只导出服务接口与卷分组纯函数
// StorageRootSpec 随契约再导出：desktop 的 Worker 协议按 contract.ts 的口径只从 services 入口取类型。
export type { IStorageService, StorageRootSpec } from "./storage/contract.js";

// CodingPlanSubscription service — ICodingPlanSubscriptionService is both a type (interface) and value (descriptor)
export {
  ICodingPlanSubscriptionService,
  type OffPeakClientConfig,
} from "./coding-plan-subscription/codingPlanSubscription.js";
export {
  IClientScenesService,
  type ClientSceneConfig,
  type ClientSceneItem,
  type ClientSceneOption,
  type ClientSceneResponseBody,
  type ClientScenesResponse,
} from "./client-scenes/clientScenes.js";
export { isValidCronExpr } from "./session/automationCronValidation.js";
// 闲时任务管理服务（与 automation 服务面独立）；接口/描述符 browser-safe。
export { IOffPeakTaskService } from "./session/offPeakTask.js";
export type { OffPeakUpdateTaskParams } from "./session/offPeakTask.js";

// Skills service — ISkillsService is both a type (interface) and value (descriptor)
export { ISkillsService } from "./skills/skills.js";
export { ISkillSyncService } from "./skill-sync/skillSync.js";
export { IDeviceSyncStateService, IUserConfigSyncService } from "./data-sync/index.js";
export type { IDataSyncCategoryService } from "./data-sync/index.js";
export { IProviderProvisioningStatusService } from "./provider-provisioning-status/index.js";
export {
  IExtensionGrantsService,
  IExtensionsService,
  IExtensionViewsService,
  type ExtensionsContributionsMessage,
} from "./extensions/index.js";
export { IVoiceInputService } from "./voice-input/index.js";
export type { VoiceInputErrorCode, VoiceInputEvent } from "./voice-input/index.js";
export { IMcpSyncService } from "./mcp-sync/mcpSync.js";
export { IPluginSyncService } from "./plugin-sync/pluginSync.js";
export {
  ICuaPermissionService,
  type CuaPermissionState,
  type CuaPermissionRestartOptions,
  type CuaPermissionStatus,
  type CuaPermissionStatusQueryOptions,
  type CuaPermissionStatusResult,
  type CuaPermissionStatusUnavailable,
  isCuaPermissionStatusAvailable,
} from "./cua-permission-broker/cuaPermissionService.js";
export {
  ICuaPipSessionService,
  type CuaPipSessionService,
} from "./cua-permission-broker/cuaPipSession.js";

// Plugins service — IPluginsService is both a type (interface) and value (descriptor)
export { IPluginsService } from "./plugins/plugins.js";
// 设置页插件管理薄服务（UI 平台能力面不再直触 zcodeAgentService）
export { IPluginManagementService, withPluginTelemetry } from "./plugins/pluginManagement.js";

// Subagents service — ISubagentsService is both a type (interface) and value (descriptor)
export { ISubagentsService } from "./subagents/subagents.js";

// Commands service — ICommandsService is both a type (interface) and value (descriptor)
export { ICommandsService } from "./commands/commands.js";

export { ISettingsSyncService } from "./settings-sync/settingsSync.js";

export { IFeedbackService } from "./feedback/feedback.js";
export type { FeedbackUploadProgress } from "./feedback/feedback.js";
export { IPromptAttachmentTransferService } from "./prompt-attachment-transfer/promptAttachmentTransfer.js";
export type {
  PromptAttachmentStageParams,
  PromptAttachmentStageResult,
  PromptAttachmentTransferPhase,
  PromptAttachmentTransferProgress,
} from "./prompt-attachment-transfer/promptAttachmentTransfer.js";
export type {
  CreateFeedbackTicketInput,
  FeedbackAttachment,
  FeedbackAttachmentKind,
  FeedbackComment,
  FeedbackDeviceInfo,
  FeedbackListQuery,
  FeedbackListResult,
  FeedbackReporter,
  FeedbackTicketDetail,
  FeedbackTicketFramework,
  FeedbackTicketModule,
  FeedbackTicketSeverity,
  FeedbackTicketStatus,
  FeedbackTicketSummary,
  FeedbackTicketType,
} from "@zcode/shared";

export { IProjectService, LEGACY_SINGLE_ROOT_PROJECT_PREFIX } from "#src/project/contract.js";
export {
  IManagedWorktreeService,
  type ManagedWorktreeGroup,
  type ManagedWorktreeWorkspace,
  type StartManagedWorktreeCreationResult,
} from "#src/managed-worktree-tasks/contract.js";
export type {
  ProjectTree,
  ProjectTask,
  ProjectTaskRef,
  VirtualProject,
  ProjectRoot,
  SaveProjectInput,
  ProjectDirectories,
} from "#src/project/contract.js";

export { IRemoteProjectService } from "#src/remote-projects/contract.js";
export type {
  RemoteProjectHost,
  RemoteProjectEntry,
  RemoteProjectCache,
  RemoteProjectDirectory,
} from "#src/remote-projects/contract.js";

export { readProjectCatalog, projectSelectionId } from "#src/project-catalog/index.js";
export type { ProjectCatalogPort, ProjectCatalogSnapshot } from "#src/project-catalog/contract.js";

// 插件 UI 桥：描述符、参数类型与工厂；App-Provided Tools 另有独立描述符。
export {
  createPluginUiBridgeService,
  createPluginUiAppToolsService,
  createPluginUiSamplingService,
  IPluginUiSamplingService,
  type PluginUiSamplingParams,
  type PluginUiCancelSamplingParams,
  PluginUiBridgeError,
  IPluginUiAppToolsService,
  type PluginUiAppToolInstanceParams,
  type PluginUiAppToolCallParams,
  type PluginUiAppToolAcceptedResult,
  type PluginUiRegisterAppToolsParams,
  type PluginUiRegisterAppToolsResult,
  type PluginUiResolveAppToolCallParams,
} from "./plugin-ui-bridge/index.js";
export {
  IPluginUiBridgeService,
  type PluginUiCallToolParams,
  type PluginUiCallToolResult,
  type PluginUiPrepareSandboxParams,
  type PluginUiReadResourceParams,
  type PluginUiReadResourceResult,
  type PluginUiPluginScope,
  type PluginUiListResourcesParams,
  type PluginUiListResourcesResult,
  type PluginUiListResourceTemplatesResult,
  type PluginUiResourceSubscriptionParams,
  type PluginUiSurfaceEntry,
  type PluginUiWorkspaceTarget,
} from "./plugin-ui-bridge/contract.js";
export { IClientConfigService } from "./client-config/clientConfig.js";

export { IHighspeedCardService } from "./highspeed/highspeedCard.js";
export {
  HighspeedCardService,
  createHighspeedHttpTransport,
  buildHighspeedTurnExecution,
} from "./highspeed/highspeedCardService.js";
export { createHighspeedMockTransport } from "./highspeed/highspeedMockTransport.js";

export { IGenUiService } from "./gen-ui/contract.js";
export type { GenUiPrepareParams } from "./gen-ui/contract.js";

export { ITaskGroupService } from "#src/task-groups/contract.js";
export type {
  TaskGroup,
  TaskGroupColor,
  TaskGroupStructure,
  GroupTaskRef,
  GroupNode,
  MoveGroupNode,
} from "#src/task-groups/contract.js";
