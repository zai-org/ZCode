// @zcode-dev/plugin-api 根入口（docs/plugins/extension-host.md §17.9）：扩展代码用的类型。
// 只转出 extension-host-protocol 的类型，不手写第二份；没有运行时代码。
export type {
  // ctx 与入口模块
  CommandCall,
  Disposable,
  ExtensionContext,
  ExtensionLocalContext,
  ExtensionModule,
  CapabilitySubscriptionErrorListener,
  // 能力的入参与返回（与 ctx 成员同一份推导）
  CapabilityId,
  ExtensionCapabilityInput,
  ExtensionCapabilityOutput,
  // 错误：按 code 区分；ExtensionError 只有类型
  ExtensionError,
  ExtensionErrorCode,
  // 作用域与插槽值
  ResolvedScope,
  ScopeInput,
  SlotBadge,
  SlotItemPatch,
  SlotValue,
  WorkspaceRef,
  // 扩展视图
  ExtensionViewInput,
  JsonSchemaObject,
  McpServerLike,
  ViewCall,
  ViewDefinition,
  ViewInstance,
  ViewResource,
  ViewServerFactory,
  ViewTool,
  // 各能力的值类型
  ExtensionEnv,
  ExtensionModel,
  ExtensionSettings,
  ExtensionSettingsUpdate,
  GenerationMetrics,
  MentionCommandArgs,
  MentionItemsResult,
  NotificationSkipReason,
  NotificationsShowInput,
  NotificationsShowResult,
  WorkbenchSession,
  WorkbenchStartDraftInput,
} from "@zcode/shared/extension-host";
