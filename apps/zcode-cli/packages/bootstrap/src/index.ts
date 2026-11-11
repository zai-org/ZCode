// Bootstrap public API surface.

export * from "./app/create-app.js";
export type {
  ListZCodeSessionsOptions,
  PromptInput,
  ResolveLatestSessionOptions,
  ResumeOptions,
  RunZCodeProtocolAgentOptions,
  SendInputOptions,
  SendInputResult,
  SetLocaleResult,
  SteerTurnOptions,
  SubmitPromptOptions,
  UserPromptInput,
  ZCodeApp,
  ZCodeAppOptions,
  ZCodeModelOption,
} from "./app/types.js";
export * from "./auth-login.js";
export {
  inspectZCodeCustomCommand,
  listZCodeCustomCommands,
  loadZCodeCustomCommand,
} from "./custom-commands.js";
export type {
  InspectZCodeCustomCommandOptions,
  ListZCodeCustomCommandsOptions,
  ZCodeCustomCommandInspection,
} from "./custom-commands.js";
export { createModelAdapter } from "./model-factory.js";
export type { CreateModelAdapterOptions } from "./model-factory.js";
export {
  createDefaultProviderEndpointRoutingPort,
  resolveProcessProviderEndpointRoutingPort,
} from "./provider-endpoint-routing.js";
export type {
  CreateDefaultProviderEndpointRoutingPortOptions,
  ResolveProcessProviderEndpointRoutingPortOptions,
} from "./provider-endpoint-routing.js";
export { startProcessProviderRegistryRuntime } from "./app/process-provider-registry-runtime.js";
export type { ProcessProviderRegistryRuntimeOptions } from "./app/process-provider-registry-runtime.js";
export {
  addZCodePluginMarketplace,
  getZCodePluginsOverview,
  installZCodeMarketplacePlugin,
  listZCodePlugins,
  removeZCodePluginMarketplace,
  resolveZCodePlugins,
  setZCodePluginEnabled,
  uninstallZCodeMarketplacePlugin,
  updateZCodeMarketplacePlugin,
  updateZCodePluginMarketplace,
  validateZCodePluginPath,
} from "./plugins.js";
export type {
  AddZCodeMarketplaceOptions,
  InstallZCodeMarketplacePluginOptions,
  ListZCodePluginsOptions,
  RemoveZCodeMarketplaceOptions,
  ResolveZCodePluginsOptions,
  SetZCodePluginEnabledOptions,
  SetZCodePluginEnabledResult,
  UninstallZCodeMarketplacePluginOptions,
  UpdateZCodeMarketplaceOptions,
  UpdateZCodeMarketplacePluginOptions,
  ValidateZCodePluginPathOptions,
  ZCodeAvailablePluginData,
  ZCodeInstalledPluginData,
  ZCodeMarketplaceSummaryData,
  ZCodeMarketplaceUpdateData,
  ZCodePluginInstallData,
  ZCodePluginUpdateData,
  ZCodePluginsOverviewData,
} from "./plugins.js";
export { runZCodeProtocolAgent } from "./zcode-protocol-entrypoint.js";
// Exposed for the CLI's --output-format stream-json: it needs the same event
// shape the protocol server emits, rather than inventing a second one.
export { mapSessionEvent } from "./zcode-protocol/session-mapper.js";
export { prepareZCodeTelemetryEnv, shutdownZCodeTelemetry } from "./telemetry-bootstrap.js";
export type { SessionTranscriptMessage, SessionTranscriptPart } from "./session-transcript.js";
export { listZCodeSessions, resolveLatestSession } from "./sessions.js";
export { inspectZCodeSkill, listZCodeSkills } from "./skills.js";
export type {
  InspectZCodeSkillOptions,
  ListZCodeSkillsOptions,
  ZCodeSkillInspection,
} from "./skills.js";
// Exposed for the CLI's headless slash routing: it must decide "is this a real
// custom command?" with the *same* reserved-name gate the app facade's
// customCommandPromptResolver applies, or the two disagree and a reserved name
// reaches the model as literal prompt text. See prompt-command.ts.
export { isReservedZCodeSlashCommandName } from "./slash-command-surface.js";
export {
  grantWorkspaceHookTrust,
  inspectWorkspaceHookTrust,
  revokeWorkspaceHookTrustCli,
} from "./workspace-hook-trust-cli.js";
export type {
  WorkspaceHookTrustCliItem,
  WorkspaceHookTrustCliStatus,
  WorkspaceHookTrustCliTarget,
} from "./workspace-hook-trust-cli.js";

export {
  createOfficialPluginPreparation,
  type OfficialPluginPreparation,
} from "./app/bundled-plugins.js";
// 嵌入式调用复用产品请求装配，避免来源头与网络配置漂移。
export { createRuntimeAiSdkModelExecutionConfig } from "./model-config.js";
